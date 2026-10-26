/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Регрессионные тесты по итогам независимого аудита ветки feature/secure-auth:
 *   1. Восстановление пароля не обходит второй фактор: ссылка из письма
 *      (или выданная администратором) без второго фактора не меняет пароль
 *      и не даёт сессии; с ним — сессия уровня 2. Утрата всех факторов —
 *      отдельная явная процедура (администратор, свежее подтверждение
 *      личности, email, причина, журнал, письмо владельцу).
 *   2. Критические действия администратора с подчинёнными аккаунтами
 *      (ссылка для смены пароля, смена email, сброс второго фактора, снятие
 *      ограничений входа, создание сотрудника, восстановление из архива,
 *      разблокировка) — только со свежим явным подтверждением личности:
 *      украденная сессия, даже прошедшая второй фактор при входе, их не даёт.
 *   3. Почтовая очередь: письма со ссылками зашифрованы ключом, выведенным
 *      из главного ключа сервера, и уходят после перезапуска; письмо со
 *      сменённым ключом, истёкшей или погашенной ссылкой — не уходит, с
 *      понятной причиной. Отдельно — настоящий перезапуск сервера
 *      (backend/server.js) с неотправленным письмом.
 *   4. Ключи доступа сотрудников обязаны проверять человека (userVerification:
 *      'required'); ключи, добавленные до схемы 6, продолжают работать.
 *
 * Почта — учебная (массив или SMTP-сервер на 127.0.0.1), адреса *.test,
 * медицинских данных нет.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootstrapSuperadmin } from '../backend/accounts/bootstrap.js';
import { createDelivery } from '../backend/accounts/delivery.js';
import { hashPassword } from '../backend/accounts/passwords.js';
import { deriveKey, keyIdOf } from '../backend/accounts/secrets.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { base32Decode, totpAt } from '../backend/accounts/totp.js';
import { verifyRegistration } from '../backend/accounts/webauthn.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { isCriticalAdminOperation } from '../backend/api/admin.js';
import { createMailer } from '../backend/mail/outbox.js';
import { startSmtpServer } from './fixtures/smtpServer.js';
import { acceptLink, browserFor, capture, linkIn, softAuthenticator, startAuthServer, TEST_ORIGIN, tokenOfLink } from './helpers/authKit.js';

const DatabaseSync = await loadSqlite();
const skip = !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MINUTE = 60 * 1000;
const MAIL_ENV = { SMTP_FROM: 'МедКарта <noreply@medkarta.test>', PUBLIC_BASE_URL: TEST_ORIGIN };

const ROOT_EMAIL = 'root@medkarta.test';
const ROOT_PASSWORD = 'Корневой пароль для аудита 2026';
const ANNA_EMAIL = 'anna.admin@medkarta.test';
const ANNA_PASSWORD = 'Администратор Анна пьёт кофе';
const USER_PASSWORD = 'Зелёный чай без сахара по утрам';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeContext = ({ clock, outbox = [], throttleRules = {} }) => {
  const delivery = createDelivery({ env: MAIL_ENV, send: capture(outbox) });
  const context = createAccountContext({
    store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }),
    delivery,
    env: MAIL_ENV,
    mfaKey: randomBytes(32),
    registrationMode: 'invite_only',
    breachCheck: async () => ({ breached: false }),
    throttleRules,
    onAccountDeleted: async () => {},
    systemInfo: async () => ({}),
    now: () => clock.t,
  });
  return { context, outbox };
};

const settle = async (context) => {
  await wait(30);
  await context.mailer.drain();
};

const newId = () => randomBytes(16).toString('hex');

/** Код TOTP, которого точно нет в окне проверки. */
const wrongCode = (secret, at) => String((Number(totpAt(secret, at)) + 500_000) % 1_000_000).padStart(6, '0');

/* ------------------------------------------------------------------------ */

describe('Аудит 1: восстановление пароля при включённой MFA', { skip }, () => {
  const clock = { t: Date.now() };
  const rootKey = softAuthenticator();
  const annaKey = softAuthenticator();
  let context;
  let outbox;
  let server;
  let base;
  let olga;
  let olgaSecret;
  let olgaCodes;
  let anna;

  const OLGA_EMAIL = 'olga@medkarta.test';
  const OLGA_NEW = 'Ольга задала новый длинный пароль';

  /** Письмо со ссылкой для смены пароля (форма «забыли пароль»). */
  const requestReset = async (email) => {
    const before = outbox.length;
    const response = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email } });
    assert.equal(response.status, 202);
    await settle(context);
    const mail = outbox.slice(before).find((item) => item.to === email && linkIn(item.text));
    assert.ok(mail, 'письмо со ссылкой пришло');
    return tokenOfLink(linkIn(mail.text));
  };

  const openLink = async (token) => {
    const tab = browserFor(base);
    const started = await tab.call('/api/auth/activation/start', { method: 'POST', body: { token } });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    return { tab, context: started.body.context };
  };

  /** Свежая сессия суперадминистратора с подтверждённой личностью. */
  const rootFresh = async () => {
    const tab = browserFor(base);
    assert.equal((await tab.signIn(ROOT_EMAIL, ROOT_PASSWORD, rootKey)).status, 200);
    await tab.reauth(rootKey);
    return tab;
  };

  before(async () => {
    ({ context, outbox } = makeContext({ clock, throttleRules: { mfa: { threshold: 100 } } }));
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startAuthServer(context));
    const root = browserFor(base);
    await root.login(ROOT_EMAIL, ROOT_PASSWORD);
    await root.enrollPasskey(rootKey, 'MacBook');
    olga = context.store.createUser({ id: newId(), email: OLGA_EMAIL, firstName: 'Ольга', lastName: 'Иванова', passwordHash: await hashPassword(USER_PASSWORD), now: clock.t });
    // Администратор (сотрудник) — по приглашению, со своим ключом доступа.
    await root.reauth(rootKey);
    const invite = await root.call('/api/admin/users', {
      method: 'POST', body: { email: ANNA_EMAIL, firstName: 'Анна', lastName: 'Петрова', role: 'admin', delivery: 'manual' },
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const { tab } = await acceptLink(base, invite.body.link, ANNA_PASSWORD);
    tab.password = ANNA_PASSWORD;
    await tab.enrollPasskey(annaKey, 'Ключ Анны');
    anna = context.store.getUserByEmail(ANNA_EMAIL);
  });
  after(() => server?.close());

  it('первый фактор — только после явного подтверждения личности; при его включении остальные сессии завершаются', async () => {
    const tab = browserFor(base);
    assert.equal((await tab.login(OLGA_EMAIL, USER_PASSWORD)).status, 200);
    const other = browserFor(base);
    assert.equal((await other.login(OLGA_EMAIL, USER_PASSWORD)).status, 200);
    // Сам вход подтверждением личности не считается: украденная сессия не привяжет свой телефон.
    const early = await tab.call('/api/me/mfa/totp', { method: 'POST', body: {} });
    assert.equal(early.status, 403);
    assert.equal(early.body.code, 'reauth_required');
    assert.equal((await tab.call('/api/me/mfa/passkey', { method: 'POST', body: {} })).body.code, 'reauth_required');
    assert.equal((await tab.call('/api/me/security')).body.fresh, false);

    await tab.reauth();
    const begin = await tab.call('/api/me/mfa/totp', { method: 'POST', body: {} });
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    olgaSecret = base32Decode(begin.body.secret);
    const confirm = await tab.call('/api/me/mfa/totp/confirm', { method: 'POST', body: { factorId: begin.body.factorId, code: totpAt(olgaSecret, clock.t), label: 'Телефон' } });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    olgaCodes = confirm.body.recoveryCodes;
    assert.equal(olgaCodes.length, 10);
    assert.equal((await tab.call('/api/me/security')).body.sessionLevel, 2, 'своя сессия — уровня 2');
    assert.equal((await other.call('/api/me')).status, 401, 'другие сессии завершены');
  });

  it('ссылка из письма без второго фактора: пароль не меняется, cookie сессии нет, профиль закрыт', async () => {
    const token = await requestReset(OLGA_EMAIL);
    const { tab, context: view } = await openLink(token);
    assert.equal(view.mfa.required, true);
    assert.deepEqual([...view.mfa.methods].sort(), ['recovery', 'totp']);

    const bare = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: OLGA_NEW } });
    assert.equal(bare.status, 403);
    assert.equal(bare.body.code, 'mfa_required');
    assert.deepEqual([...bare.body.methods].sort(), ['recovery', 'totp']);
    assert.equal([...tab.jar.keys()].some((name) => /mk_sid$/.test(name)), false, 'cookie сессии не выдана');
    for (const pathname of ['/api/me', '/api/me/security', '/api/me/sessions']) {
      assert.equal((await tab.call(pathname)).status, 401, pathname);
    }
    assert.equal((await browserFor(base).login(OLGA_EMAIL, OLGA_NEW)).status, 401, 'новый пароль не действует');
    const old = await browserFor(base).login(OLGA_EMAIL, USER_PASSWORD);
    assert.equal(old.status, 200);
    assert.equal(old.body.mfaRequired, true, 'прежний пароль верен, и вход — по-прежнему со вторым шагом');
    assert.equal(context.store.getAccessTokenById(context.store.listUserAccessTokens(olga.id, 1)[0].id).usedAt, null, 'ссылка не израсходована');

    // Неверный код из приложения — то же самое; сообщается, сколько попыток осталось.
    const wrong = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: OLGA_NEW, method: 'totp', code: wrongCode(olgaSecret, clock.t) } });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, 'bad_mfa_code');
    assert.equal(wrong.body.attemptsLeft, 4);
    // Ключа доступа у Ольги нет: подпись чужим ключом не проходит.
    const options = await tab.call('/api/auth/activation/mfa-options', { method: 'POST', body: {} });
    assert.equal(options.status, 200);
    assert.equal(options.body.passkey, null);
    const foreign = await tab.call('/api/auth/activation/complete', {
      method: 'POST', body: { password: OLGA_NEW, method: 'webauthn', credential: rootKey.assert({ challenge: randomBytes(32).toString('base64url') }) },
    });
    assert.equal(foreign.status, 400);
    assert.equal((await browserFor(base).login(OLGA_EMAIL, OLGA_NEW)).status, 401);

    // Верный код — пароль сменён, сессия уровня 2, MFA на месте.
    clock.t += 31 * 1000;
    const code = totpAt(olgaSecret, clock.t);
    const done = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: OLGA_NEW, method: 'totp', code } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const security = await tab.call('/api/me/security');
    assert.equal(security.status, 200);
    assert.equal(security.body.sessionLevel, 2);
    assert.equal(security.body.enabled, true);
    assert.equal(security.body.fresh, false, 'для критичных действий всё равно нужно подтверждение личности');
    // Тот же код второй раз (при входе) — нет.
    const login = browserFor(base);
    await login.login(OLGA_EMAIL, OLGA_NEW);
    assert.equal((await login.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'totp', code } })).status, 400);
    await settle(context);
    assert.ok(outbox.some((item) => item.to === OLGA_EMAIL && /Пароль изменён/.test(item.subject)));
  });

  it('резервный код тоже подходит для смены пароля по ссылке и после этого сгорает', async () => {
    const token = await requestReset(OLGA_EMAIL);
    const { tab } = await openLink(token);
    const [code] = olgaCodes;
    const done = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: USER_PASSWORD, method: 'recovery', code } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const security = await tab.call('/api/me/security');
    assert.equal(security.body.sessionLevel, 2);
    assert.equal(security.body.recoveryCodes.unused, 9);
    const login = browserFor(base);
    await login.login(OLGA_EMAIL, USER_PASSWORD);
    assert.equal((await login.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code } })).status, 400, 'код одноразовый');
    await settle(context);
    assert.ok(outbox.some((item) => item.to === OLGA_EMAIL && /резервному коду/.test(item.subject)));
  });

  it('ссылка, выданная администратором вручную, тоже требует второй фактор владельца; владельцу — письмо о ссылке', async () => {
    const root = await rootFresh();
    const before = outbox.length;
    const issued = await root.call(`/api/admin/users/${olga.id}/invitations`, { method: 'POST', body: { delivery: 'manual' } });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.ok(issued.body.link);
    await settle(context);
    assert.ok(outbox.slice(before).some((item) => item.to === OLGA_EMAIL && /выдал ссылку для смены пароля/.test(item.subject)));
    // Ссылку у администратора «перехватили»: без второго фактора Ольги она бесполезна.
    const { tab } = await openLink(tokenOfLink(issued.body.link));
    const attempt = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: 'Пароль того, кто перехватил ссылку' } });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.body.code, 'mfa_required');
    assert.equal((await browserFor(base).login(OLGA_EMAIL, 'Пароль того, кто перехватил ссылку')).status, 401);
  });

  it('утрата всех факторов: явная процедура администратора — подтверждение личности, email, причина, журнал, письмо; сессии завершены', async () => {
    // У Ольги открыта сессия (пароль + код).
    clock.t += 31 * 1000;
    const olgaTab = browserFor(base);
    await olgaTab.login(OLGA_EMAIL, USER_PASSWORD);
    assert.equal((await olgaTab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'totp', code: totpAt(olgaSecret, clock.t) } })).status, 200);
    const body = { confirmEmail: OLGA_EMAIL, reason: 'Личность подтверждена по паспорту в регистратуре' };

    // Только что вошедший администратор (вторым фактором, но без подтверждения личности) — нет.
    const stolen = browserFor(base);
    await stolen.signIn(ROOT_EMAIL, ROOT_PASSWORD, rootKey);
    const denied = await stolen.call(`/api/admin/users/${olga.id}/mfa-reset`, { method: 'POST', body });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'reauth_required');
    assert.ok(context.mfa.hasMfa(olga.id));

    const root = await rootFresh();
    const card = await root.call(`/api/admin/users/${olga.id}`);
    assert.equal(card.body.can.mfaReset, true);
    assert.equal(card.body.user.mfa.enabled, true);
    const mismatch = await root.call(`/api/admin/users/${olga.id}/mfa-reset`, { method: 'POST', body: { ...body, confirmEmail: 'other@medkarta.test' } });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, 'confirm_mismatch');
    const noReason = await root.call(`/api/admin/users/${olga.id}/mfa-reset`, { method: 'POST', body: { ...body, reason: 'да' } });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.code, 'bad_reason');
    assert.equal((await root.call(`/api/admin/users/${olga.id}/mfa-reset`, { method: 'POST', body: { ...body, password: 'x' } })).status, 400, 'лишние поля');
    assert.ok(context.mfa.hasMfa(olga.id), 'после отказов — без изменений');

    const before = outbox.length;
    const reset = await root.call(`/api/admin/users/${olga.id}/mfa-reset`, { method: 'POST', body });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.ok(reset.body.removed > 0);
    assert.equal(context.mfa.hasMfa(olga.id), false);
    assert.equal(context.store.listFactors(olga.id).filter((factor) => factor.status === 'active').length, 0);
    assert.equal((await olgaTab.call('/api/me')).status, 401, 'сессии владельца завершены');
    const [entry] = context.store.listAudit({ filters: { action: 'user.mfa_reset' }, limit: 1 }).rows;
    assert.equal(entry.targetId, olga.id);
    assert.equal(entry.result, 'ok');
    assert.match(JSON.stringify(entry.details), /паспорту/);
    await settle(context);
    assert.ok(outbox.slice(before).some((item) => item.to === OLGA_EMAIL && /Двухфакторная защита сброшена/.test(item.subject)));
    // Повторно — нечего сбрасывать.
    assert.equal((await root.call(`/api/admin/users/${olga.id}/mfa-reset`, { method: 'POST', body })).body.code, 'mfa_not_enabled');
    // Пароль не менялся: Ольга входит им, теперь без второго шага, и включает защиту снова.
    const back = await browserFor(base).login(OLGA_EMAIL, USER_PASSWORD);
    assert.equal(back.status, 200);
    assert.equal(back.body.mfaRequired, undefined);
  });

  it('второй фактор сотрудника из админ-панели не сбрасывается — только командой mfa-reset на сервере', async () => {
    const root = await rootFresh();
    const card = await root.call(`/api/admin/users/${anna.id}`);
    assert.equal(card.body.can.mfaReset, false);
    const denied = await root.call(`/api/admin/users/${anna.id}/mfa-reset`, { method: 'POST', body: { confirmEmail: ANNA_EMAIL, reason: 'Потеряла телефон и ключ' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'staff_mfa_reset');
    assert.ok(context.mfa.hasMfa(anna.id));
    // Администратор не сбрасывает второй фактор равного или старшего.
    const annaTab = browserFor(base);
    await annaTab.signIn(ANNA_EMAIL, ANNA_PASSWORD, annaKey);
    await annaTab.reauth(annaKey);
    const rootId = context.store.getUserByEmail(ROOT_EMAIL).id;
    assert.equal((await annaTab.call(`/api/admin/users/${rootId}/mfa-reset`, { method: 'POST', body: { confirmEmail: ROOT_EMAIL, reason: 'Попытка захвата владельца' } })).status, 403);
    assert.ok(context.mfa.hasMfa(rootId));
  });
});

/* ------------------------------------------------------------------------ */

describe('Аудит 2: критические действия администратора и украденная сессия', { skip }, () => {
  const clock = { t: Date.now() };
  const rootKey = softAuthenticator();
  const annaKey = softAuthenticator();
  let context;
  let outbox;
  let server;
  let base;
  let petr;
  let archived;
  let blocked;

  before(async () => {
    ({ context, outbox } = makeContext({ clock }));
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startAuthServer(context));
    const root = browserFor(base);
    await root.login(ROOT_EMAIL, ROOT_PASSWORD);
    await root.enrollPasskey(rootKey, 'MacBook');
    await root.reauth(rootKey);
    const invite = await root.call('/api/admin/users', {
      method: 'POST', body: { email: ANNA_EMAIL, firstName: 'Анна', lastName: 'Петрова', role: 'admin', delivery: 'manual' },
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    const { tab } = await acceptLink(base, invite.body.link, ANNA_PASSWORD);
    tab.password = ANNA_PASSWORD;
    await tab.enrollPasskey(annaKey, 'Ключ Анны');
    const hash = await hashPassword(USER_PASSWORD);
    petr = context.store.createUser({ id: newId(), email: 'petr@medkarta.test', firstName: 'Пётр', lastName: 'Сидоров', passwordHash: hash, now: clock.t });
    archived = context.store.createUser({ id: newId(), email: 'irina@medkarta.test', firstName: 'Ирина', lastName: 'Орлова', passwordHash: hash, status: 'archived', now: clock.t });
    blocked = context.store.createUser({ id: newId(), email: 'boris@medkarta.test', firstName: 'Борис', lastName: 'Ким', passwordHash: hash, status: 'blocked', now: clock.t });
  });
  after(() => server?.close());

  it('сессия администратора сразу после входа (пароль + ключ доступа) не захватывает подчинённые аккаунты', async () => {
    // Злоумышленник унёс cookie этой сессии: второй фактор при входе пройден, личность — не подтверждалась.
    const stolen = browserFor(base);
    assert.equal((await stolen.signIn(ANNA_EMAIL, ANNA_PASSWORD, annaKey)).status, 200);
    assert.equal((await stolen.call('/api/admin/me')).status, 200);
    const card = (await stolen.call(`/api/admin/users/${petr.id}`)).body.user;
    const tokensBefore = context.store.listUserAccessTokens(petr.id).length;
    const usersBefore = context.store.countUsers();
    const mailsBefore = outbox.length;

    const attempts = [
      ['ссылка для смены пароля (вручную)', `/api/admin/users/${petr.id}/invitations`, 'POST', { delivery: 'manual' }],
      ['ссылка для смены пароля (письмом)', `/api/admin/users/${petr.id}/invitations`, 'POST', {}],
      ['смена email', `/api/admin/users/${petr.id}`, 'PATCH', { email: 'attacker@medkarta.test', version: card.version }],
      ['смена email вместе с именем', `/api/admin/users/${petr.id}`, 'PATCH', { firstName: 'Петя', email: 'attacker@medkarta.test' }],
      ['сброс второго фактора', `/api/admin/users/${petr.id}/mfa-reset`, 'POST', { confirmEmail: 'petr@medkarta.test', reason: 'Злоумышленник просит сбросить' }],
      ['снятие ограничений входа', `/api/admin/users/${petr.id}/unlock-login`, 'POST', {}],
      ['назначение роли', `/api/admin/users/${petr.id}/role`, 'POST', { role: 'moderator' }],
      ['создание сотрудника', '/api/admin/users', 'POST', { email: 'new.mod@medkarta.test', firstName: 'Новый', lastName: 'Модератор', role: 'moderator', delivery: 'manual' }],
      ['восстановление из архива', `/api/admin/users/${archived.id}/restore`, 'POST', {}],
      ['разблокировка', `/api/admin/users/${blocked.id}/unblock`, 'POST', {}],
      ['выгрузка базы', '/api/admin/users/export', 'GET', undefined],
      // Права на удаление у администратора нет: отказ сразу (и запись в журнал), без вопроса о пароле.
      ['удаление', `/api/admin/users/${petr.id}`, 'DELETE', { confirmEmail: 'petr@medkarta.test' }, 'forbidden'],
    ];
    for (const [label, pathname, method, body, code = 'reauth_required'] of attempts) {
      const response = await stolen.call(pathname, { method, body });
      assert.equal(response.status, 403, `${label}: ${response.status} ${response.text.slice(0, 200)}`);
      assert.equal(response.body.code, code, label);
      assert.equal(response.body.link, undefined, label);
    }
    const [denied] = context.store.listAudit({ filters: { action: 'user.delete' }, limit: 1 }).rows;
    assert.equal(denied.result, 'denied');
    // Ничего не изменилось.
    const now = context.store.getUserById(petr.id);
    assert.equal(now.email, 'petr@medkarta.test');
    assert.equal(now.role, 'user');
    assert.equal(now.firstName, 'Пётр');
    assert.equal(context.store.listUserAccessTokens(petr.id).length, tokensBefore, 'ссылок не выдано');
    assert.equal(context.store.countUsers(), usersBefore, 'сотрудник не создан');
    assert.equal(context.store.getUserById(archived.id).status, 'archived');
    assert.equal(context.store.getUserById(blocked.id).status, 'blocked');
    await settle(context);
    assert.equal(outbox.slice(mailsBefore).filter((item) => item.to === 'petr@medkarta.test' || item.to === 'attacker@medkarta.test').length, 0);

    // Некритичное по-прежнему доступно: имя, обычный пользователь, просмотр.
    const rename = await stolen.call(`/api/admin/users/${petr.id}`, { method: 'PATCH', body: { firstName: 'Петя', email: 'PETR@medkarta.test' } });
    assert.equal(rename.status, 200, JSON.stringify(rename.body));
    assert.equal(context.store.getUserById(petr.id).email, 'petr@medkarta.test');
    const plain = await stolen.call('/api/admin/users', { method: 'POST', body: { email: 'plain@medkarta.test', firstName: 'Обычный', lastName: 'Пользователь', delivery: 'manual' } });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
  });

  it('после подтверждения личности (пароль + ключ доступа) — можно; через auth.reauthMinutes — снова нужно', async () => {
    const tab = browserFor(base);
    await tab.signIn(ANNA_EMAIL, ANNA_PASSWORD, annaKey);
    // Одного пароля для сотрудника мало.
    assert.equal((await tab.call('/api/me/reauth', { method: 'POST', body: { password: ANNA_PASSWORD } })).status, 400);
    await tab.reauth(annaKey);
    const issued = await tab.call(`/api/admin/users/${petr.id}/invitations`, { method: 'POST', body: { delivery: 'manual' } });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.ok(issued.body.link);
    assert.equal((await tab.call(`/api/admin/users/${petr.id}/unlock-login`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await tab.call(`/api/admin/users/${archived.id}/restore`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await tab.call(`/api/admin/users/${blocked.id}/unblock`, { method: 'POST', body: {} })).status, 200);
    const card = (await tab.call(`/api/admin/users/${petr.id}`)).body.user;
    const changed = await tab.call(`/api/admin/users/${petr.id}`, { method: 'PATCH', body: { email: 'petr.new@medkarta.test', version: card.version } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(context.store.getUserById(petr.id).email, 'petr.new@medkarta.test');
    assert.equal(context.store.getAccessTokenById(issued.body.invitation.id).revokedReason, 'email_changed', 'ссылка на прежний адрес погашена');
    await settle(context);
    assert.ok(outbox.some((item) => item.to === 'petr@medkarta.test' && /Email изменён/i.test(item.subject)), 'прежний адрес предупреждён');
    const staff = await tab.call('/api/admin/users', { method: 'POST', body: { email: 'new.mod@medkarta.test', firstName: 'Новый', lastName: 'Модератор', role: 'moderator', delivery: 'manual' } });
    assert.equal(staff.status, 201, JSON.stringify(staff.body));

    clock.t += 11 * MINUTE;
    const later = await tab.call(`/api/admin/users/${petr.id}/invitations`, { method: 'POST', body: { delivery: 'manual' } });
    assert.equal(later.status, 403);
    assert.equal(later.body.code, 'reauth_required');
  });

  it('пользователь: вход тоже не заменяет подтверждения личности для смены email', async () => {
    const tab = browserFor(base);
    context.store.createUser({ id: newId(), email: 'plain.user@medkarta.test', firstName: 'Вера', passwordHash: await hashPassword(USER_PASSWORD), now: clock.t });
    await tab.login('plain.user@medkarta.test', USER_PASSWORD);
    const early = await tab.call('/api/me/email', { method: 'POST', body: { newEmail: 'vera.new@medkarta.test' } });
    assert.equal(early.status, 403);
    assert.equal(early.body.code, 'reauth_required');
    await tab.reauth();
    assert.equal((await tab.call('/api/me/email', { method: 'POST', body: { newEmail: 'vera.new@medkarta.test' } })).status, 202);
  });

  it('isCriticalAdminOperation: таблица решений', () => {
    for (const operation of ['issueAccessLink', 'unlockLogin', 'mfaReset', 'restore', 'unblock', 'setRole', 'deleteUser', 'archive', 'bulk', 'exportUsers', 'updateRole', 'resetRole', 'updateSettings']) {
      assert.equal(isCriticalAdminOperation(operation), true, operation);
    }
    for (const operation of ['me', 'listUsers', 'getUser', 'block', 'revokeUserSessions', 'requirePasswordChange', 'revokeInvitation', 'userInvitations']) {
      assert.equal(isCriticalAdminOperation(operation), false, operation);
    }
    const current = { currentEmail: 'a@medkarta.test' };
    assert.equal(isCriticalAdminOperation('updateUser', { firstName: 'А' }, current), false);
    assert.equal(isCriticalAdminOperation('updateUser', { email: 'A@medkarta.test ' }, current), false, 'тот же адрес');
    assert.equal(isCriticalAdminOperation('updateUser', { email: 'b@medkarta.test' }, current), true);
    assert.equal(isCriticalAdminOperation('updateUser', { email: null }, current), true, 'мусор — тоже через подтверждение');
    assert.equal(isCriticalAdminOperation('createUser', { role: 'user' }), false);
    assert.equal(isCriticalAdminOperation('createUser', {}), false);
    assert.equal(isCriticalAdminOperation('createUser', { role: 'moderator' }), true);
    assert.equal(isCriticalAdminOperation('createUser', { role: 'superadmin' }), true);
  });
});

/* ------------------------------------------------------------------------ */

describe('Аудит 3: почтовая очередь и перезапуск (в одном процессе)', { skip }, () => {
  const LINK = `${TEST_ORIGIN}/activate#token=${'T'.repeat(43)}`;
  const failingDelivery = () => createDelivery({ env: MAIL_ENV, send: async () => { throw Object.assign(new Error('down'), { code: 'smtp_connect' }); } });

  it('ключ писем выводится из главного ключа: другой экземпляр очереди с тем же ключом отправляет письмо после «перезапуска»', async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const masterKey = randomBytes(32);
    const clock = { t: Date.now() };
    const first = createMailer({ store, delivery: failingDelivery(), masterKey, now: () => clock.t });
    const id = first.enqueue({ kind: 'reset', to: 'a.b@medkarta.test', params: { link: LINK, expiresAt: clock.t + 30 * MINUTE }, ref: { type: 'access_token', id: 'tok1' } });
    const row = store.getMail(id);
    assert.ok(!row.payload.includes('TTTT'), 'токена в базе нет');
    assert.equal(row.keyId, keyIdOf(deriveKey(masterKey, 'mail')));
    assert.notEqual(row.keyId, keyIdOf(masterKey), 'ключ писем — не сам главный ключ');
    assert.equal(row.expiresAt, clock.t + 30 * MINUTE);
    await first.drain();
    assert.equal(store.getMail(id).status, 'pending', 'сбой SMTP — повтор позже');

    // «Перезапуск»: новый экземпляр с тем же главным ключом.
    clock.t += MINUTE;
    const sent = [];
    const statuses = [];
    const second = createMailer({ store, delivery: createDelivery({ env: MAIL_ENV, send: capture(sent) }), masterKey, onStatus: (ref, status) => statuses.push([ref.id, status]), now: () => clock.t });
    await second.drain();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(LINK), 'ссылка в письме цела');
    assert.deepEqual(statuses, [['tok1', 'sent']]);
    const done = store.getMail(id);
    assert.equal(done.status, 'sent');
    assert.equal(done.payload, null);
    assert.equal(done.toAddress, null);
  });

  it('сменили главный ключ — письмо не расшифровать: failed key_changed, статус переносится в ссылку, ничего не уходит', async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const first = createMailer({ store, delivery: failingDelivery(), masterKey: randomBytes(32) });
    const id = first.enqueue({ kind: 'invite', to: 'c.d@medkarta.test', params: { link: LINK, expiresAt: Date.now() + 30 * MINUTE }, ref: { type: 'access_token', id: 'tok2' } });
    const sent = [];
    const statuses = [];
    const other = createMailer({ store, delivery: createDelivery({ env: MAIL_ENV, send: capture(sent) }), masterKey: randomBytes(32), onStatus: (ref, status) => statuses.push([ref.id, status]) });
    await other.drain();
    assert.equal(sent.length, 0);
    assert.equal(store.getMail(id).status, 'failed');
    assert.equal(store.getMail(id).lastError, 'key_changed');
    assert.equal(store.getMail(id).payload, null, 'зашифрованный текст стёрт');
    assert.deepEqual(statuses, [['tok2', 'failed']]);
  });

  it('ссылка истекла, пока письмо ждало, — failed expired; ссылку погасили — link_inactive; уведомления без ссылок уходят', async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const masterKey = randomBytes(32);
    const clock = { t: Date.now() };
    const inactive = new Set(['tok4']);
    const sent = [];
    const mailer = createMailer({
      store, delivery: createDelivery({ env: MAIL_ENV, send: capture(sent) }), masterKey,
      refActive: (ref) => !inactive.has(ref.id), now: () => clock.t,
    });
    const expired = mailer.enqueue({ kind: 'reset', to: 'e.f@medkarta.test', params: { link: LINK, expiresAt: clock.t + MINUTE }, ref: { type: 'access_token', id: 'tok3' } });
    const revoked = mailer.enqueue({ kind: 'reset', to: 'g.h@medkarta.test', params: { link: LINK, expiresAt: clock.t + 30 * MINUTE }, ref: { type: 'access_token', id: 'tok4' } });
    const notice = mailer.enqueue({ kind: 'password_changed', to: 'e.f@medkarta.test', params: { at: clock.t } });
    clock.t += 2 * MINUTE;
    await mailer.drain();
    assert.equal(store.getMail(expired).lastError, 'expired');
    assert.equal(store.getMail(revoked).lastError, 'link_inactive');
    assert.equal(store.getMail(notice).status, 'sent');
    assert.deepEqual(sent.map((item) => item.to), ['e.f@medkarta.test']);
    assert.ok(!sent.some((item) => item.text.includes(LINK)));
  });

  it('письмо, «застрявшее» в отправке при падении процесса, после запуска возвращается в очередь и уходит', async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const masterKey = randomBytes(32);
    const crashed = createMailer({ store, delivery: failingDelivery(), masterKey });
    const id = crashed.enqueue({ kind: 'reset', to: 'i.j@medkarta.test', params: { link: LINK, expiresAt: Date.now() + 30 * MINUTE } });
    assert.equal(store.claimDueMail(Date.now() + 1, 5).length, 1, 'процесс взял письмо и «упал»');
    assert.equal(store.getMail(id).status, 'sending');
    const sent = [];
    const restarted = createMailer({ store, delivery: createDelivery({ env: MAIL_ENV, send: capture(sent) }), masterKey });
    restarted.start();
    try {
      for (let index = 0; index < 50 && sent.length === 0; index += 1) await wait(20);
    } finally {
      restarted.stop();
    }
    assert.equal(sent.length, 1);
    assert.equal(store.getMail(id).status, 'sent');
  });
});

/* ------------------------------------------------------------------------ */

/** SMTP-сервер, который принимает соединение и молчит: письмо «зависает» в отправке. */
const startSilentSmtp = async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const freePort = async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

/** Текст письма из учебного SMTP-сервера (text/plain в base64). */
const plainTextOf = (message) => {
  const parts = message.data.split(/\r\n--mk_[0-9a-f]+/);
  const part = parts.find((item) => /Content-Type: text\/plain/i.test(item)) || message.data;
  const body = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/--\s*$/u, '').replace(/\s/g, '');
  return Buffer.from(body, 'base64').toString('utf8');
};

const until = async (check, { timeout = 10_000, what = 'условие' } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await wait(100);
  }
  throw new Error(`не дождались: ${what}`);
};

describe('Аудит 3: настоящий перезапуск сервера с неотправленным письмом', { skip }, () => {
  let work;
  let file;
  let port;
  let base;
  let child = null;
  let output = '';
  let silent;
  let smtp;
  const MASTER = randomBytes(32).toString('base64');
  const EMAIL = 'restart.user@medkarta.test';

  const envFor = ({ smtpPort, key }) => ({
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    NODE_ENV: 'development',
    DEMO_DATA: 'off',
    ANALYTICS: 'off',
    COOKIE_SECURE: 'off',
    ACCOUNTS_DB_PATH: file,
    DEMO_BOOKING_DB_PATH: path.join(work, 'booking.sqlite'),
    ADMIN_BOOTSTRAP_PASSWORD: '',
    TRUST_PROXY: '',
    TRUSTED_PROXIES: '',
    SMTP_URL: '',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: 'none',
    SMTP_ALLOW_INSECURE: 'on',
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    SMTP_FROM: 'МедКарта <noreply@medkarta.test>',
    APP_URL: '',
    PUBLIC_BASE_URL: base,
    REGISTRATION_MODE: 'invite_only',
    MFA_SECRET_KEY: key,
    LOG_LEVEL: 'info',
  });

  // Все запущенные процессы: если проверка упала до stopApp, after() всё равно их остановит (иначе прогон зависает).
  const children = new Set();
  const startApp = async (env) => {
    child = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.once('exit', function forget() { children.delete(this); });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    await until(async () => {
      try {
        return (await fetch(`${base}/api/config`)).ok;
      } catch {
        return false;
      }
    }, { what: `запуск сервера\n${output.slice(-1500)}` });
  };
  /** SIGKILL — «падение» процесса; SIGTERM — обычная остановка. */
  const stopApp = async (signal = 'SIGTERM') => {
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill(signal);
    await exited;
    child = null;
  };
  const db = (work_) => {
    const connection = new DatabaseSync(file);
    try {
      return work_(connection);
    } finally {
      connection.close();
    }
  };
  const mailRow = () => db((connection) => connection.prepare("SELECT * FROM mail_outbox WHERE kind = 'reset' ORDER BY created_at DESC LIMIT 1").get());
  const tokenRow = (id) => db((connection) => connection.prepare('SELECT * FROM access_tokens WHERE id = ?').get(id));
  const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-mail-restart-'));
    file = path.join(work, 'accounts.sqlite');
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const store = createSqliteAccountStore({ DatabaseSync, file });
    store.createUser({ id: newId(), email: EMAIL, firstName: 'Рустам', lastName: 'Гарипов', passwordHash: await hashPassword(USER_PASSWORD), now: Date.now() });
    store.close();
    silent = await startSilentSmtp();
    smtp = await startSmtpServer();
  });
  after(async () => {
    await stopApp('SIGKILL');
    for (const running of children) running.kill('SIGKILL');
    await silent?.close();
    await smtp?.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('процесс упал во время отправки письма со ссылкой — после перезапуска с тем же ключом письмо уходит, и ссылка работает', async () => {
    await startApp(envFor({ smtpPort: silent.port, key: MASTER }));
    assert.equal((await post('/api/auth/access-link', { email: EMAIL })).status, 202);
    const stuck = await until(() => {
      const row = mailRow();
      return row && row.status === 'sending' && silent.connections() > 0 ? row : null;
    }, { what: 'письмо в отправке' });
    await stopApp('SIGKILL');

    // В базе — только шифртекст, ключ — не из базы; ссылка ждёт доставки.
    const row = mailRow();
    assert.equal(row.id, stuck.id);
    assert.equal(row.status, 'sending');
    assert.ok(row.key_id && row.payload && !/#token=/.test(row.payload), 'ссылки в базе нет');
    assert.ok(row.expires_at > Date.now());
    assert.equal(tokenRow(row.ref_id).delivery_status, 'pending');

    const before = smtp.messages.length;
    await startApp(envFor({ smtpPort: smtp.port, key: MASTER }));
    const message = await until(() => smtp.messages.slice(before).find((item) => item.to.includes(EMAIL)), { what: 'письмо после перезапуска' });
    const link = linkIn(plainTextOf(message));
    assert.ok(link && link.startsWith(`${base}/activate#token=`), 'в письме — ссылка этого сервера');
    const token = tokenOfLink(link);
    await until(() => mailRow().status === 'sent', { what: 'статус sent' });
    const sent = mailRow();
    assert.equal(sent.payload, null);
    assert.equal(sent.to_address, null);
    assert.equal(tokenRow(sent.ref_id).delivery_status, 'sent');

    // Ссылка из письма работает в «браузере».
    const tab = browserFor(base);
    assert.equal((await tab.call('/api/auth/activation/start', { method: 'POST', body: { token } })).status, 200);
    const done = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: 'Пароль после перезапуска сервера' } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await browserFor(base).login(EMAIL, 'Пароль после перезапуска сервера')).status, 200);
    await stopApp();
    assert.ok(!output.includes(token), 'токена нет в журнале сервера');
  });

  it('перезапуск с другим главным ключом: письмо не отправляется (key_changed), ссылка помечена недоставленной', async () => {
    await startApp(envFor({ smtpPort: silent.port, key: MASTER }));
    assert.equal((await post('/api/auth/access-link', { email: EMAIL })).status, 202);
    const stuck = await until(() => {
      const row = mailRow();
      return row && row.status === 'sending' && row.attempts >= 1 ? row : null;
    }, { what: 'письмо в отправке' });
    await stopApp('SIGKILL');

    const before = smtp.messages.length;
    await startApp(envFor({ smtpPort: smtp.port, key: randomBytes(32).toString('base64') }));
    const failed = await until(() => {
      const row = mailRow();
      return row.id === stuck.id && row.status === 'failed' ? row : null;
    }, { what: 'статус failed' });
    assert.equal(failed.last_error, 'key_changed');
    assert.equal(failed.payload, null);
    assert.equal(tokenRow(failed.ref_id).delivery_status, 'failed');
    await wait(300);
    assert.equal(smtp.messages.length, before, 'ничего не отправлено');
    await stopApp();
  });
});

/* ------------------------------------------------------------------------ */

describe('Аудит 4: ключи доступа сотрудников проверяют человека', { skip }, () => {
  const clock = { t: Date.now() };
  let context;
  let server;
  let base;

  before(async () => {
    ({ context } = makeContext({ clock }));
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startAuthServer(context));
  });
  after(() => server?.close());

  it('сотрудник: при регистрации ключа userVerification required; ключ без проверки человека не добавляется', async () => {
    const tab = browserFor(base);
    await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
    await tab.reauth();
    const started = await tab.call('/api/me/mfa/passkey', { method: 'POST', body: {} });
    assert.equal(started.status, 200);
    assert.equal(started.body.publicKey.authenticatorSelection.userVerification, 'required');
    const weak = softAuthenticator({ uv: false });
    const refused = await tab.call('/api/me/mfa/passkey/finish', { method: 'POST', body: { credential: weak.register(started.body.publicKey), label: 'U2F без PIN' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'uv_required');
    assert.equal(context.mfa.hasMfa(context.store.getUserByEmail(ROOT_EMAIL).id), false);
    // Ключ с PIN / биометрией — добавляется и помечается.
    const strong = softAuthenticator();
    const enrolled = await tab.enrollPasskey(strong, 'Touch ID');
    assert.equal(enrolled.security.sessionLevel, 2);
    const [factor] = context.store.listFactors(context.store.getUserByEmail(ROOT_EMAIL).id).filter((item) => item.type === 'webauthn');
    assert.equal(factor.userVerified, true);
    assert.equal((await tab.call('/api/me/security')).body.factors.find((item) => item.type === 'webauthn').userVerified, true);

    // Вход: required; ответ без флага UV от ключа, который умеет проверять человека, — отказ.
    const login = browserFor(base);
    await login.login(ROOT_EMAIL, ROOT_PASSWORD);
    const options = await login.call('/api/auth/mfa/options', { method: 'POST', body: {} });
    assert.equal(options.body.passkey.userVerification, 'required');
    const downgraded = await login.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'webauthn', credential: strong.assert(options.body.passkey, { skipUv: true }) } });
    assert.equal(downgraded.status, 400);
    assert.equal((await login.passkeyStep(strong)).status, 200);
    // Подтверждение личности — то же правило.
    const reauthOptions = await login.call('/api/me/reauth/options', { method: 'POST', body: {} });
    assert.equal(reauthOptions.body.passkey.userVerification, 'required');
    const weakReauth = await login.call('/api/me/reauth', { method: 'POST', body: { password: ROOT_PASSWORD, method: 'webauthn', credential: strong.assert(reauthOptions.body.passkey, { skipUv: true }) } });
    assert.equal(weakReauth.status, 400);
  });

  it('пользователь: preferred — подходит и ключ без проверки человека', async () => {
    context.store.createUser({ id: newId(), email: 'uv.user@medkarta.test', firstName: 'Лиля', passwordHash: await hashPassword(USER_PASSWORD), now: clock.t });
    const tab = browserFor(base);
    await tab.login('uv.user@medkarta.test', USER_PASSWORD);
    await tab.reauth();
    const started = await tab.call('/api/me/mfa/passkey', { method: 'POST', body: {} });
    assert.equal(started.body.publicKey.authenticatorSelection.userVerification, 'preferred');
    const weak = softAuthenticator({ uv: false });
    const finished = await tab.call('/api/me/mfa/passkey/finish', { method: 'POST', body: { credential: weak.register(started.body.publicKey), label: 'Простой ключ' } });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    const login = browserFor(base);
    await login.login('uv.user@medkarta.test', USER_PASSWORD);
    assert.equal((await login.passkeyStep(weak)).status, 200);
  });

  it('совместимость: ключ сотрудника, добавленный до схемы 6 (user_verified неизвестен), продолжает работать; первая проверка человека запоминается', async () => {
    const userId = context.store.getUserByEmail(ROOT_EMAIL).id;
    // Ключ «из прошлого»: в базе отметка проверки человека — NULL.
    const legacy = softAuthenticator();
    const challenge = randomBytes(32).toString('base64url');
    const verified = verifyRegistration(legacy.register({ challenge }), { challenge, rpId: new URL(TEST_ORIGIN).hostname, origins: [TEST_ORIGIN] });
    context.store.insertFactor({
      id: newId(), userId, type: 'webauthn', label: 'Старый ключ', status: 'active', credentialId: verified.credentialId, publicKey: verified.publicKey,
      algorithm: verified.algorithm, signCount: verified.signCount, transports: '', backedUp: null, userVerified: null, now: clock.t, confirmedAt: clock.t,
    });
    const legacyFactor = () => context.store.getFactorByCredentialId(verified.credentialId);
    assert.equal(context.mfa.status(userId).factors.find((item) => item.label === 'Старый ключ').userVerified, null);

    const loginWith = async (overrides) => {
      const tab = browserFor(base);
      await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
      const options = await tab.call('/api/auth/mfa/options', { method: 'POST', body: {} });
      const result = await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'webauthn', credential: legacy.assert(options.body.passkey, overrides) } });
      return { options: options.body.passkey, status: result.status };
    };
    // Есть ключ с неизвестной проверкой — preferred, и он входит даже без PIN: владельца не заперло.
    const first = await loginWith({ skipUv: true });
    assert.equal(first.options.userVerification, 'preferred');
    assert.equal(first.status, 200);
    assert.equal(legacyFactor().userVerified, null, 'без проверки — отметка не меняется');
    // Первый вход с проверкой человека запоминается…
    assert.equal((await loginWith({})).status, 200);
    assert.equal(legacyFactor().userVerified, true);
    // …и «понизить» ключ, просто не введя PIN, больше нельзя; запрос снова required.
    const downgraded = await loginWith({ skipUv: true });
    assert.equal(downgraded.options.userVerification, 'required');
    assert.equal(downgraded.status, 400);
  });
});
