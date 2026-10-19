/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Приглашения вместо временных паролей: активация, ссылки для смены пароля,
 * защита от повторного использования, отзыв, блокировки, перебор, CSRF,
 * разглашение существования аккаунтов, несколько вкладок, совместимость со
 * старой базой и настоящая отправка письма по SMTP (на учебный сервер).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { bootstrapSuperadmin } from '../backend/accounts/bootstrap.js';
import { accessLink, accessLinkMessage, appUrlFromEnv, createDelivery } from '../backend/accounts/delivery.js';
import { INVITATION_LIMITS } from '../backend/accounts/invitations.js';
import { PERMISSION_KEYS } from '../backend/accounts/rbac.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountHandler, createFailureCounter } from '../backend/api/account.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { SESSION_COOKIE } from '../backend/api/accountHttp.js';
import { ACTIVATION_COOKIE, createActivationHandler, createEmailWindow } from '../backend/api/activation.js';
import { createAdminHandler } from '../backend/api/admin.js';
import { createMeHandler } from '../backend/api/me.js';
import { buildMessage, MailError, sendMail, smtpConfigFromEnv } from '../backend/mail/smtp.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';
import { passwordChecks, passwordProblem } from '../shared/passwordPolicy.js';
import { startSmtpServer } from './fixtures/smtpServer.js';

const DatabaseSync = await loadSqlite();
const ROOT_PASSWORD = 'Корневой-пароль-2026';
const unlimited = () => ({ allowed: true });
const HOUR = 60 * 60 * 1000;

const tokenOfLink = (link) => new URL(link).hash.replace(/^#token=/, '');
const linkIn = (message) => message.content.text.match(/https?:\/\/\S+/)[0];

/** Учебная почта: письма складываются в массив (транспорт подменён — сам SMTP проверяется отдельно ниже). */
const capturingDelivery = (outbox, env = {}) => createDelivery({
  env: { MAIL_FROM: 'МедКарта <noreply@medkarta.test>', APP_URL: 'https://medkarta.test', ...env },
  send: async (message) => {
    outbox.push(message);
  },
});

const startServer = async (context, { activationLimit = unlimited, requestLimit = unlimited, emailWindow = () => true } = {}) => {
  const getService = async () => context.accounts;
  const accountHandler = createAccountHandler({
    getService, onAccountDeleted: async () => {}, authLimit: unlimited, apiLimit: unlimited, demoLimit: unlimited,
    failures: createFailureCounter(), features: () => ({ registration: false, demo: false, chatRequiresAccount: true }),
    emailLinks: async () => context.invitations.emailEnabled,
  });
  const meHandler = createMeHandler({ getService, apiLimit: unlimited, passwordLimit: unlimited });
  const adminHandler = createAdminHandler({ getContext: async () => context, limit: unlimited, systemInfo: async () => ({}) });
  const activationHandler = createActivationHandler({ getContext: async () => context, activationLimit, requestLimit, emailWindow });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/admin')) return adminHandler(req, res);
    if (req.url === '/api/me' || req.url.startsWith('/api/me/')) return meHandler(req, res);
    if (req.url.startsWith('/api/auth/activation') || req.url === '/api/auth/access-link') return activationHandler(req, res);
    return accountHandler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

const browserFor = (base) => {
  const jar = new Map();
  const cookies = [];
  const call = async (urlPath, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        origin: base,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const line of response.headers.getSetCookie()) {
      cookies.push(line);
      const [pair] = line.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (/Max-Age=0/i.test(line) || !value) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  return {
    jar,
    cookies,
    call,
    login: (email, password) => call('/api/auth/login', { method: 'POST', body: { email, password } }),
    peek: (token) => call('/api/auth/activation/peek', { method: 'POST', body: { token } }),
    start: (token) => call('/api/auth/activation/start', { method: 'POST', body: { token } }),
    complete: (password) => call('/api/auth/activation/complete', { method: 'POST', body: { password } }),
  };
};

describe('Приглашения: правила пароля', () => {
  it('длина, частые пароли и email — одинаково для сервера и подсказок', () => {
    assert.equal(passwordProblem('Kazan Kremlin 1552'), '');
    assert.match(passwordProblem('1234567'), /не короче 8/);
    assert.match(passwordProblem('qwerty123'), /распространён/);
    assert.match(passwordProblem('12345678901'), /только из цифр/);
    assert.match(passwordProblem('olga.petrova-2026', { email: 'olga.petrova@medkarta.test' }), /email/);
    const checks = passwordChecks('qwerty123', { email: 'a@b.ru' });
    assert.deepEqual(checks.map((check) => [check.key, check.ok]), [['length', true], ['common', false], ['email', true]]);
    assert.deepEqual(passwordChecks('', {}).map((check) => check.ok), [false, false, false]);
  });
});

describe('Приглашения: почта', () => {
  it('APP_URL — только https (или http для localhost); ссылка — с токеном во фрагменте', () => {
    assert.equal(appUrlFromEnv({ APP_URL: 'https://medkarta.example/path' }), 'https://medkarta.example');
    assert.equal(appUrlFromEnv({ APP_URL: 'http://medkarta.example' }), null);
    assert.equal(appUrlFromEnv({ APP_URL: 'http://localhost:3001' }), 'http://localhost:3001');
    assert.equal(accessLink('https://m.example', 'abc'), 'https://m.example/activate#token=abc');
  });

  it('без SMTP — ручной режим, письма не «отправляются» понарошку', async () => {
    const delivery = createDelivery({ env: {} });
    assert.equal(delivery.mode, 'manual');
    assert.equal(delivery.emailEnabled, false);
    await assert.rejects(delivery.sendAccessLink({ to: 'a@b.ru', purpose: 'invite', link: 'https://x/activate#token=1', expiresAt: Date.now() }), (error) => error.code === 'mail_disabled');
    const half = createDelivery({ env: { SMTP_URL: 'smtps://u:p@smtp.example.ru:465' } });
    assert.equal(half.mode, 'manual', 'без MAIL_FROM и APP_URL почта не включается');
    assert.ok(half.problems.length >= 2);
  });

  it('настройки SMTP из окружения; без TLS — только localhost', () => {
    assert.deepEqual(smtpConfigFromEnv({ SMTP_URL: 'smtps://box%40ya.ru:p%40ss@smtp.yandex.ru' }), { host: 'smtp.yandex.ru', port: 465, secure: 'tls', user: 'box@ya.ru', password: 'p@ss', allowInsecure: false });
    assert.equal(smtpConfigFromEnv({ SMTP_URL: 'smtp://smtp.example.ru' }).secure, 'starttls');
    assert.ok(smtpConfigFromEnv({ SMTP_HOST: 'smtp.example.ru', SMTP_SECURE: 'none' }).error);
    assert.equal(smtpConfigFromEnv({}), null);
  });

  it('письмо: заголовки без подстановки строк, UTF-8, ссылка в тексте и HTML', () => {
    const content = accessLinkMessage({ purpose: 'invite', name: 'Ольга <script>', link: 'https://m.example/activate#token=abc', expiresAt: Date.now() + HOUR, inviter: 'Максим' });
    assert.match(content.subject, /Приглашение в МедКарту/);
    assert.match(content.text, /https:\/\/m\.example\/activate#token=abc/);
    assert.match(content.html, /Ольга &lt;script&gt;/);
    const message = buildMessage({ from: 'noreply@medkarta.test', fromName: 'МедКарта', to: 'olga@medkarta.test', ...content });
    assert.match(message, /^Subject: =\?UTF-8\?B\?/m);
    assert.match(message, /^To: <olga@medkarta\.test>$/m);
    assert.throws(() => buildMessage({ from: 'a@b.ru', to: 'x@y.ru\r\nBcc: evil@z.ru', subject: 's', text: 't' }), MailError);
  });

  it('SMTP: настоящий диалог с сервером — STARTTLS, AUTH, письмо доставлено; без TLS пароль не уходит', async (t) => {
    let tlsOptions = null;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-smtp-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
      tlsOptions = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    } catch {
      t.skip('нет openssl для тестового сертификата');
      return;
    }
    const smtp = await startSmtpServer({ tlsOptions });
    try {
      const message = buildMessage({ from: 'noreply@medkarta.test', to: 'olga@medkarta.test', subject: 'Проверка', text: '.строка с точкой\nвторая' });
      await sendMail({ host: '127.0.0.1', port: smtp.port, secure: 'starttls', user: 'mailer', password: 'mail-secret', from: 'noreply@medkarta.test', to: 'olga@medkarta.test', message, tls: { ca: tlsOptions.cert, servername: 'localhost', checkServerIdentity: () => undefined } });
      assert.equal(smtp.messages.length, 1);
      assert.equal(smtp.messages[0].tls, true);
      assert.equal(smtp.messages[0].auth.user, 'mailer');
      assert.deepEqual(smtp.messages[0].to, ['olga@medkarta.test']);
      const body = smtp.messages[0].data.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\s/g, '');
      assert.equal(Buffer.from(body, 'base64').toString('utf8'), '.строка с точкой\r\nвторая', 'тело дошло целиком');
      await assert.rejects(
        sendMail({ host: '127.0.0.1', port: smtp.port, secure: 'none', user: 'mailer', password: 'mail-secret', from: 'noreply@medkarta.test', to: 'olga@medkarta.test', message }),
        (error) => error.code === 'smtp_insecure',
      );
      await assert.rejects(
        sendMail({ host: '127.0.0.1', port: smtp.port, secure: 'starttls', user: 'mailer', password: 'wrong', from: 'noreply@medkarta.test', to: 'olga@medkarta.test', message, tls: { ca: tlsOptions.cert, checkServerIdentity: () => undefined } }),
        (error) => error.code === 'smtp_auth',
      );
      assert.equal(smtp.messages.length, 1);
    } finally {
      await smtp.close();
    }
  });

  it('SMTP-транспорт по умолчанию отправляет приглашение (локальный сервер без TLS только для отладки)', async () => {
    const smtp = await startSmtpServer();
    try {
      const delivery = createDelivery({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'none', SMTP_ALLOW_INSECURE: 'on', MAIL_FROM: 'МедКарта <noreply@medkarta.test>', APP_URL: 'http://localhost:3001' } });
      assert.equal(delivery.mode, 'smtp');
      await delivery.sendAccessLink({ to: 'olga@medkarta.test', purpose: 'invite', name: 'Ольга', link: 'http://localhost:3001/activate#token=abc', expiresAt: Date.now() + HOUR });
      assert.equal(smtp.messages.length, 1);
      assert.match(smtp.messages[0].data, /^Subject: =\?UTF-8\?B\?/m);
    } finally {
      await smtp.close();
    }
  });
});

describe('Приглашения: сценарии через HTTP', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let context;
  let server;
  let base;
  let root;
  let clock = Date.now();
  const outbox = [];

  before(async () => {
    context = createAccountContext({
      store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }), onAccountDeleted: async () => {}, systemInfo: async () => null,
      delivery: capturingDelivery(outbox), now: () => clock,
    });
    await bootstrapSuperadmin({ store: context.store, email: 'root@medkarta.test', firstName: 'Максим', password: ROOT_PASSWORD, now: () => clock });
    ({ server, base } = await startServer(context));
    root = browserFor(base);
    assert.equal((await root.login('root@medkarta.test', ROOT_PASSWORD)).status, 200);
  });

  after(() => server?.close());

  const invite = async (email, extra = {}) => {
    const before = outbox.length;
    const created = await root.call('/api/admin/users', { method: 'POST', body: { email, firstName: 'Ольга', lastName: 'Петрова', ...extra } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const letter = outbox.slice(before).find((item) => item.to === email);
    return { id: created.body.user.id, created, letter, token: letter ? tokenOfLink(linkIn(letter)) : tokenOfLink(created.body.link) };
  };

  it('создание: письмо с приглашением, ссылки администратору не показывается, аккаунт ждёт активации', async () => {
    const { created, letter, token } = await invite('olga@medkarta.test');
    assert.equal(created.body.invitation.delivery, 'email');
    assert.equal(created.body.invitation.deliveryStatus, 'sent');
    assert.equal(created.body.link, null, 'при отправке письмом ссылка администратору не нужна');
    assert.equal(created.body.user.pending, true);
    assert.equal(letter.content.subject, 'Приглашение в МедКарту');
    assert.match(linkIn(letter), /^https:\/\/medkarta\.test\/activate#token=[A-Za-z0-9_-]{43}$/);
    assert.equal(context.store.getAccessTokenByHash(token), null, 'в базе только хэш токена');
  });

  it('первичная активация: подтверждение, пароль, вход; повторный вход — по email и паролю', async () => {
    const { id, token } = await invite('anna@medkarta.test');
    const tab = browserFor(base);
    const peek = await tab.peek(token);
    assert.equal(peek.status, 200);
    assert.deepEqual(Object.keys(peek.body.link).sort(), ['email', 'expiresAt', 'firstName', 'invitedBy', 'purpose']);
    assert.equal(peek.body.link.email, 'a***@medkarta.test', 'до подтверждения email — маской');
    assert.equal(peek.body.link.invitedBy, 'Максим');
    const started = await tab.start(token);
    assert.equal(started.status, 200);
    assert.equal(started.body.context.email, 'anna@medkarta.test');
    const contextCookie = tab.cookies.find((line) => line.startsWith(`${ACTIVATION_COOKIE}=`));
    assert.match(contextCookie, /HttpOnly/);
    assert.match(contextCookie, /SameSite=Strict/);
    assert.match(contextCookie, /Path=\/api\/auth\/activation/);
    const weak = await tab.complete('anna1234');
    assert.equal(weak.status, 400);
    assert.equal(weak.body.code, 'weak_password');
    const done = await tab.complete('Анна-и-тополиный-пух');
    assert.equal(done.status, 200);
    assert.equal(done.body.purpose, 'invite');
    assert.ok(tab.jar.get(SESSION_COOKIE), 'после активации — обычная сессия');
    assert.equal(tab.jar.has(ACTIVATION_COOKIE), false, 'контекст активации стёрт');
    assert.equal((await tab.call('/api/me')).body.user.email, 'anna@medkarta.test');
    assert.equal((await browserFor(base).login('anna@medkarta.test', 'Анна-и-тополиный-пух')).status, 200);
    const card = await root.call(`/api/admin/users/${id}`);
    assert.equal(card.body.user.pending, false);
    assert.ok(card.body.user.activatedAt);
    const notifications = await root.call(`/api/admin/notifications?since=${new Date(clock - HOUR).toISOString()}`);
    assert.ok(notifications.body.items.some((item) => item.userId === id), 'администратор узнаёт об активации');
  });

  it('неправильный токен: несуществующий, обрезанный, чужого формата — «ссылка недействительна»', async () => {
    const tab = browserFor(base);
    for (const token of ['A'.repeat(43), 'короткий', '../../etc/passwd', '', null]) {
      const response = await tab.start(token);
      assert.equal(response.status, 404, String(token));
      assert.equal(response.body.code, 'invalid_link');
    }
  });

  it('истёкшее приглашение не открывается; новое — работает', async () => {
    const { id, token } = await invite('late@medkarta.test');
    clock += 25 * HOUR;
    try {
      const expired = await browserFor(base).start(token);
      assert.equal(expired.status, 410);
      assert.equal(expired.body.code, 'link_expired');
      const list = await root.call(`/api/admin/users/${id}/invitations`);
      assert.equal(list.body.items[0].state, 'expired');
      const before = outbox.length;
      const again = await root.call(`/api/admin/users/${id}/invitations`, { method: 'POST', body: {} });
      assert.equal(again.status, 200);
      assert.equal(again.body.invitation.purpose, 'invite');
      const fresh = tokenOfLink(linkIn(outbox[before]));
      const tab = browserFor(base);
      assert.equal((await tab.start(fresh)).status, 200);
      assert.equal((await tab.complete('Опоздавший-но-успел')).status, 200);
    } finally {
      clock -= 25 * HOUR;
    }
  });

  it('повторное использование: второй переход и второй пароль — отказ; после активации ссылка мертва', async () => {
    const { token } = await invite('twice@medkarta.test');
    const first = browserFor(base);
    const second = browserFor(base);
    assert.equal((await first.start(token)).status, 200);
    const reused = await second.start(token);
    assert.equal(reused.status, 410);
    assert.equal(reused.body.code, 'link_used');
    assert.equal((await second.complete('Чужой-пароль-12345')).body.code, 'activation_expired', 'без контекста пароль не задать');
    assert.equal((await first.complete('Первый-и-единственный')).status, 200);
    assert.equal((await first.start(token)).body.code, 'link_used');
    assert.equal((await first.complete('Ещё-один-пароль-1')).status, 410);
    assert.equal((await browserFor(base).login('twice@medkarta.test', 'Чужой-пароль-12345')).status, 401);
  });

  it('несколько вкладок: перезагрузка той же вкладки продолжает активацию, другая вкладка завершает её первой', async () => {
    const { token } = await invite('tabs@medkarta.test');
    const tab = browserFor(base);
    assert.equal((await tab.start(token)).status, 200);
    // Перезагрузка: токена в адресе уже нет, контекст — по cookie.
    const context1 = await tab.call('/api/auth/activation');
    assert.equal(context1.status, 200);
    assert.equal(context1.body.context.email, 'tabs@medkarta.test');
    // Вторая вкладка того же браузера (cookie общие) снова открыла ссылку из письма — продолжает тот же контекст.
    const sameBrowser = browserFor(base);
    sameBrowser.jar.set(ACTIVATION_COOKIE, tab.jar.get(ACTIVATION_COOKIE));
    assert.equal((await sameBrowser.start(token)).status, 200);
    assert.equal((await sameBrowser.complete('Вкладка-номер-два')).status, 200);
    const late = await tab.complete('Вкладка-номер-один');
    assert.equal(late.status, 410, 'первая вкладка не перезапишет пароль');
    assert.equal(late.body.code, 'activation_expired');
    assert.equal((await tab.call('/api/auth/activation')).status, 404);
    assert.equal((await browserFor(base).login('tabs@medkarta.test', 'Вкладка-номер-два')).status, 200);
  });

  it('отзыв и замена: отозванная и заменённая ссылки не работают', async () => {
    const { id, token } = await invite('revoke@medkarta.test');
    const list = await root.call(`/api/admin/users/${id}/invitations`);
    const revoked = await root.call(`/api/admin/users/${id}/invitations/${list.body.items[0].id}`, { method: 'DELETE', body: {} });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.invitation.state, 'revoked');
    assert.equal((await browserFor(base).start(token)).body.code, 'link_revoked');
    const before = outbox.length;
    await root.call(`/api/admin/users/${id}/invitations`, { method: 'POST', body: {} });
    const second = tokenOfLink(linkIn(outbox[before]));
    await root.call(`/api/admin/users/${id}/invitations`, { method: 'POST', body: {} });
    const third = tokenOfLink(linkIn(outbox[before + 1]));
    assert.equal((await browserFor(base).start(second)).body.code, 'link_revoked', 'повторная отправка заменяет прежнюю ссылку');
    assert.equal((await browserFor(base).start(third)).status, 200);
    const audit = await root.call(`/api/admin/audit?targetId=${id}`);
    assert.ok(audit.body.items.some((item) => item.action === 'user.invite_revoke'));
    assert.equal(audit.text.includes(token) || audit.text.includes(second) || audit.text.includes(third), false, 'токенов в журнале нет');
  });

  it('заблокированный аккаунт: ссылки отозваны, выдать новую нельзя, начатая активация не завершится', async () => {
    const { id, token } = await invite('blocked-invite@medkarta.test');
    const tab = browserFor(base);
    assert.equal((await tab.start(token)).status, 200);
    assert.equal((await root.call(`/api/admin/users/${id}/block`, { method: 'POST', body: { reason: 'Проверка' } })).status, 200);
    const finish = await tab.complete('Заблокирован-но-пытаюсь');
    assert.equal(finish.status, 410);
    assert.equal((await browserFor(base).login('blocked-invite@medkarta.test', 'Заблокирован-но-пытаюсь')).status, 401);
    const denied = await root.call(`/api/admin/users/${id}/invitations`, { method: 'POST', body: {} });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, 'account_blocked');
    // Разблокировка не оживляет старые ссылки — нужна новая.
    await root.call(`/api/admin/users/${id}/unblock`, { method: 'POST', body: {} });
    assert.equal((await browserFor(base).start(token)).body.code, 'link_revoked');
  });

  it('блокировка после подтверждения ссылки (в обход отзыва) — активация отклоняется статусом', async () => {
    const { id, token } = await invite('blocked-race@medkarta.test');
    const tab = browserFor(base);
    assert.equal((await tab.start(token)).status, 200);
    // Статус меняется напрямую в базе — как если бы блокировка пришла между проверками.
    context.store.updateUser(id, { status: 'blocked', blockReason: 'гонка' }, { now: clock });
    const finish = await tab.complete('Гонка-с-блокировкой');
    assert.equal(finish.status, 403);
    assert.equal(finish.body.code, 'account_blocked');
    context.store.updateUser(id, { status: 'active', blockReason: null }, { now: clock });
  });

  it('смена email отзывает ссылки, выданные на прежний адрес', async () => {
    const { id, token } = await invite('old-address@medkarta.test');
    const card = await root.call(`/api/admin/users/${id}`);
    await root.call(`/api/admin/users/${id}`, { method: 'PATCH', body: { email: 'new-address@medkarta.test', version: card.body.user.version } });
    assert.equal((await browserFor(base).start(token)).body.code, 'link_revoked');
  });

  it('смена роли отзывает ссылки: администратор не получит аккаунт, повышенный до суперадминистратора', async () => {
    const adminUser = await invite('issuer-admin@medkarta.test', { role: 'admin' });
    const admin = browserFor(base);
    await admin.start(adminUser.token);
    assert.equal((await admin.complete('Администратор-пароль-2026')).status, 200);
    const created = await admin.call('/api/admin/users', { method: 'POST', body: { email: 'promoted@medkarta.test', firstName: 'Пётр', lastName: 'Повышенный', delivery: 'manual' } });
    assert.equal(created.status, 201);
    const card = await root.call(`/api/admin/users/${created.body.user.id}`);
    assert.equal((await root.call(`/api/admin/users/${created.body.user.id}/role`, { method: 'POST', body: { role: 'superadmin', version: card.body.user.version } })).status, 200);
    const attempt = browserFor(base);
    assert.equal((await attempt.start(tokenOfLink(created.body.link))).body.code, 'link_revoked');
  });

  it('ссылка администратора гаснет, если он сам заблокирован, — и не оживает после разблокировки', async () => {
    const adminUser = await invite('blocked-issuer@medkarta.test', { role: 'admin' });
    const admin = browserFor(base);
    await admin.start(adminUser.token);
    assert.equal((await admin.complete('Администратор-пароль-2027')).status, 200);
    const created = await admin.call('/api/admin/users', { method: 'POST', body: { email: 'issued-by-blocked@medkarta.test', firstName: 'Нина', lastName: 'Ждущая', delivery: 'manual' } });
    const token = tokenOfLink(created.body.link);
    assert.equal((await browserFor(base).peek(token)).status, 200);
    await root.call(`/api/admin/users/${adminUser.id}/block`, { method: 'POST', body: {} });
    assert.equal((await browserFor(base).start(token)).body.code, 'link_revoked');
    await root.call(`/api/admin/users/${adminUser.id}/unblock`, { method: 'POST', body: {} });
    assert.equal((await browserFor(base).start(token)).body.code, 'link_revoked');
  });

  it('email меняет только тот, кто вправе выдавать ссылки (иначе — перехват через «нет пароля»)', async () => {
    const target = await invite('email-target@medkarta.test');
    const editor = await invite('editor-moderator@medkarta.test', { role: 'moderator' });
    const roles = await root.call('/api/admin/roles');
    const current = roles.body.roles.find((item) => item.key === 'moderator')?.permissions || ['admin.access', 'users.view', 'users.block'];
    assert.equal((await root.call('/api/admin/roles/moderator', { method: 'PUT', body: { permissions: [...new Set([...current, 'users.edit'])] } })).status, 200);
    try {
      const tab = browserFor(base);
      await tab.start(editor.token);
      assert.equal((await tab.complete('Модератор-редактор-2026')).status, 200);
      const card = await tab.call(`/api/admin/users/${target.id}`);
      assert.equal(card.body.can.edit, true);
      assert.equal(card.body.can.editEmail, false);
      const changed = await tab.call(`/api/admin/users/${target.id}`, { method: 'PATCH', body: { email: 'attacker@evil.test', version: card.body.user.version } });
      assert.equal(changed.status, 403);
      const renamed = await tab.call(`/api/admin/users/${target.id}`, { method: 'PATCH', body: { firstName: 'Ольга-Мария', version: card.body.user.version } });
      assert.equal(renamed.status, 200, 'имя по-прежнему можно менять');
    } finally {
      await root.call('/api/admin/roles/moderator/reset', { method: 'POST', body: {} });
    }
  });

  it('«Завершить все сессии» отзывает и ссылки для смены пароля', async () => {
    const user = await invite('sessions-reset@medkarta.test');
    const tab = browserFor(base);
    await tab.start(user.token);
    assert.equal((await tab.complete('Сессии-и-ссылки-2026')).status, 200);
    const before = outbox.length;
    assert.equal((await root.call(`/api/admin/users/${user.id}/invitations`, { method: 'POST', body: {} })).status, 200);
    const letter = outbox.slice(before).find((item) => item.to === 'sessions-reset@medkarta.test');
    assert.equal((await root.call(`/api/admin/users/${user.id}/sessions/revoke`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await browserFor(base).start(tokenOfLink(linkIn(letter)))).body.code, 'link_revoked');
  });

  it('подброшенная вторая cookie контекста: активация не завершается', async () => {
    const user = await invite('cookie-planted@medkarta.test');
    const tab = browserFor(base);
    assert.equal((await tab.start(user.token)).status, 200);
    const genuine = tab.jar.get(ACTIVATION_COOKIE);
    const planted = await tab.call('/api/auth/activation/complete', {
      method: 'POST',
      body: { password: 'Подброшенная-cookie-1' },
      headers: { cookie: `${ACTIVATION_COOKIE}=${'A'.repeat(43)}; ${ACTIVATION_COOKIE}=${genuine}` },
    });
    assert.equal(planted.status, 410);
    assert.equal(planted.body.code, 'activation_expired');
  });

  it('запрос ссылки: одинаковый ответ для любого адреса; письмо — только владельцу действующего аккаунта', async () => {
    const pendingUser = await invite('ask-pending@medkarta.test');
    const active = await invite('ask-active@medkarta.test');
    const tab = browserFor(base);
    assert.equal((await tab.start(active.token)).status, 200);
    assert.equal((await tab.complete('Помню-пароль-2026')).status, 200);
    const blocked = await invite('ask-blocked@medkarta.test');
    await root.call(`/api/admin/users/${blocked.id}/block`, { method: 'POST', body: {} });

    const before = outbox.length;
    const responses = [];
    for (const email of ['ask-pending@medkarta.test', 'ask-active@medkarta.test', 'ask-blocked@medkarta.test', 'nobody@medkarta.test']) {
      const response = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email } });
      responses.push({ status: response.status, body: response.body, cookies: response.headers.getSetCookie() });
    }
    assert.ok(responses.every((response) => JSON.stringify(response) === JSON.stringify(responses[0])), 'ответы неотличимы');
    assert.equal(responses[0].status, 202);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const letters = outbox.slice(before);
    assert.deepEqual(letters.map((item) => item.to).sort(), ['ask-active@medkarta.test', 'ask-pending@medkarta.test']);
    const toPending = letters.find((item) => item.to === 'ask-pending@medkarta.test');
    const toActive = letters.find((item) => item.to === 'ask-active@medkarta.test');
    assert.match(toPending.content.subject, /Приглашение/);
    assert.match(toActive.content.subject, /Смена пароля/);
    // Самостоятельный запрос не гасит приглашение администратора.
    assert.equal((await browserFor(base).peek(pendingUser.token)).status, 200);
    // Ссылка для смены пароля работает: старые сессии завершаются, старый пароль — нет.
    const reset = browserFor(base);
    assert.equal((await reset.start(tokenOfLink(linkIn(toActive)))).body.context.purpose, 'reset');
    assert.equal((await reset.complete('Новый-пароль-по-почте')).status, 200);
    assert.equal((await tab.call('/api/me')).status, 401);
    assert.equal((await browserFor(base).login('ask-active@medkarta.test', 'Помню-пароль-2026')).status, 401);
    assert.equal((await browserFor(base).login('ask-active@medkarta.test', 'Новый-пароль-по-почте')).status, 200);
  });

  it('запросы ссылки ограничены: 3 письма в час на аккаунт, лимит по адресу и по email', async () => {
    const { token } = await invite('flood@medkarta.test');
    const before = outbox.length;
    for (let index = 0; index < 6; index += 1) {
      await context.invitations.requestLink('flood@medkarta.test');
    }
    assert.equal(outbox.length - before, INVITATION_LIMITS.SELF_REQUESTS_PER_HOUR);
    assert.equal((await browserFor(base).peek(token)).status, 200, 'приглашение администратора живо');
    const window = createEmailWindow({ max: 2 });
    assert.deepEqual([window('a@b.ru'), window('a@b.ru'), window('a@b.ru'), window('c@d.ru')], [true, true, false, true]);
    const limited = await startServer(context, { requestLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 2, maxPerInstance: Number.POSITIVE_INFINITY }) });
    try {
      const statuses = [];
      for (let index = 0; index < 4; index += 1) statuses.push((await browserFor(limited.base).call('/api/auth/access-link', { method: 'POST', body: { email: `x${index}@medkarta.test` } })).status);
      assert.deepEqual(statuses, [202, 202, 429, 429]);
    } finally {
      limited.server.close();
    }
  });

  it('перебор токенов упирается в лимит адреса', async () => {
    const limited = await startServer(context, { activationLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 5, maxPerInstance: Number.POSITIVE_INFINITY }) });
    try {
      const tab = browserFor(limited.base);
      const statuses = [];
      for (let index = 0; index < 7; index += 1) statuses.push((await tab.start(`${'A'.repeat(42)}${index}`)).status);
      assert.deepEqual(statuses, [404, 404, 404, 404, 404, 429, 429]);
    } finally {
      limited.server.close();
    }
  });

  it('CSRF: чужой сайт не может подтвердить ссылку, задать пароль или запросить письмо', async () => {
    const { token } = await invite('csrf@medkarta.test');
    const tab = browserFor(base);
    const foreign = { origin: 'https://evil.example' };
    assert.equal((await tab.call('/api/auth/activation/start', { method: 'POST', body: { token }, headers: foreign })).status, 403);
    assert.equal((await tab.call('/api/auth/activation/start', { method: 'POST', body: { token }, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await tab.call('/api/auth/access-link', { method: 'POST', body: { email: 'csrf@medkarta.test' }, headers: foreign })).status, 403);
    const form = await fetch(`${base}/api/auth/activation/start`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${token}` });
    assert.equal(form.status, 403);
    assert.equal((await tab.peek(token)).status, 200, 'ссылка после всех попыток цела');
  });

  it('без прав нельзя выдавать и отзывать ссылки; модератор не видит токенов', async () => {
    const { id } = await invite('target@medkarta.test');
    const moderator = await invite('moderator@medkarta.test', { role: 'moderator' });
    const tab = browserFor(base);
    await tab.start(moderator.token);
    await tab.complete('Модератор-с-паролем');
    assert.equal((await tab.call(`/api/admin/users/${id}/invitations`, { method: 'POST', body: {} })).status, 403);
    const list = await tab.call(`/api/admin/users/${id}/invitations`);
    assert.equal(list.status, 200);
    assert.ok(list.body.items.every((item) => !('tokenHash' in item) && !('link' in item)));
    assert.equal((await tab.call(`/api/admin/users/${id}/invitations/${list.body.items[0].id}`, { method: 'DELETE', body: {} })).status, 403);
    assert.equal((await tab.call(`/api/admin/users/${moderator.id}/invitations`, { method: 'POST', body: {} })).body.code, 'forbidden');
  });

  it('сессия после активации переживает «перезапуск», а данные прежних аккаунтов на месте', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-invite-')), 'accounts.sqlite');
    const letters = [];
    let store = createSqliteAccountStore({ DatabaseSync, file });
    let local = createAccountContext({ store, onAccountDeleted: async () => {}, systemInfo: async () => null, delivery: capturingDelivery(letters) });
    await bootstrapSuperadmin({ store, email: 'root@medkarta.test', password: ROOT_PASSWORD });
    const actor = { ...store.getUserByEmail('root@medkarta.test'), permissions: PERMISSION_KEYS };
    await local.admin.createUser(actor, { email: 'keep@medkarta.test', firstName: 'Ольга', lastName: 'Сохранова' });
    const opened = local.invitations.start(tokenOfLink(linkIn(letters[0])));
    const done = await local.invitations.complete(opened.contextToken, 'Пароль-до-перезапуска');
    store.close();
    store = createSqliteAccountStore({ DatabaseSync, file });
    local = createAccountContext({ store, onAccountDeleted: async () => {}, systemInfo: async () => null, delivery: capturingDelivery([]) });
    assert.equal(local.accounts.authenticate(done.session.token)?.user.email, 'keep@medkarta.test');
    assert.ok((await local.accounts.login({ email: 'keep@medkarta.test', password: 'Пароль-до-перезапуска' })).session.token);
    store.close();
  });

  it('совместимость: база схемы 3 обновляется, прежние пользователи входят как раньше', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-v3-')), 'accounts.sqlite');
    let store = createSqliteAccountStore({ DatabaseSync, file });
    await bootstrapSuperadmin({ store, email: 'root@medkarta.test', password: ROOT_PASSWORD });
    const { hashPassword } = await import('../backend/accounts/passwords.js');
    store.createUser({ id: 'e'.repeat(32), email: 'old@medkarta.test', firstName: 'Старый', lastName: 'Пользователь', passwordHash: await hashPassword('Старый-пароль-2025'), mustChangePassword: true, now: Date.now() - 100 * HOUR });
    store.close();
    // Возвращаем файл к схеме 3: без таблицы ссылок и без activated_at.
    const raw = new DatabaseSync(file);
    raw.exec('DROP TABLE access_tokens; DROP INDEX users_pending; ALTER TABLE users DROP COLUMN activated_at; PRAGMA user_version = 3;');
    raw.close();
    store = createSqliteAccountStore({ DatabaseSync, file });
    assert.equal(store.health().schemaVersion, 4);
    const old = store.getUserByEmail('old@medkarta.test');
    assert.ok(old.activatedAt, 'аккаунт с паролем считается активированным');
    const local = createAccountContext({ store, onAccountDeleted: async () => {}, systemInfo: async () => null, delivery: capturingDelivery([]) });
    const login = await local.accounts.login({ email: 'old@medkarta.test', password: 'Старый-пароль-2025' });
    assert.equal(login.user.mustChangePassword, true, 'старое требование сменить временный пароль сохранилось');
    assert.ok((await local.accounts.login({ email: 'root@medkarta.test', password: ROOT_PASSWORD })).session.token);
    assert.equal(store.countActiveSuperadmins(), 1);
    store.close();
  });
});

describe('Приглашения: без почты', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  it('ссылку получает только создавший администратор, запрос ссылки выключен для всех одинаково', async () => {
    const context = createAccountContext({ store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }), onAccountDeleted: async () => {}, systemInfo: async () => null, delivery: createDelivery({ env: {} }) });
    await bootstrapSuperadmin({ store: context.store, email: 'root@medkarta.test', password: ROOT_PASSWORD });
    const { server, base } = await startServer(context);
    try {
      const root = browserFor(base);
      await root.login('root@medkarta.test', ROOT_PASSWORD);
      const created = await root.call('/api/admin/users', { method: 'POST', body: { email: 'manual@medkarta.test', firstName: 'Ручной', lastName: 'Режим' } });
      assert.equal(created.body.invitation.delivery, 'manual');
      assert.ok(created.body.link.startsWith(`${base}/activate#token=`), 'адрес — сайт, с которого работает администратор');
      const account = await browserFor(base).call('/api/account');
      assert.equal(account.body.features.emailLinks, false);
      const known = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email: 'manual@medkarta.test' } });
      const unknown = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email: 'nobody@medkarta.test' } });
      assert.equal(known.status, 409);
      assert.deepEqual(known.body, unknown.body);
      const tab = browserFor(base);
      assert.equal((await tab.start(tokenOfLink(created.body.link))).status, 200);
      assert.equal((await tab.complete('Ручная-передача-ссылки')).status, 200);
      assert.equal((await root.call(`/api/admin/users/${created.body.user.id}`)).body.user.pending, false);
    } finally {
      server.close();
    }
  });
});
