/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Регистрация, вход и защита аккаунтов через настоящий HTTP: регистрация
 * по ссылке из письма, одноразовые токены, защита от перебора (с
 * перезапуском), второй фактор (ключ доступа, TOTP, резервные коды),
 * обязательная MFA для админ-панели, подтверждение личности, сессии,
 * восстановление пароля, смена email, почтовая очередь и миграция базы.
 * Почта — учебная (письма складываются в массив), база — SQLite в памяти или
 * во временном файле.
 */

import assert from 'node:assert/strict';
import { createHash, scryptSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { bootstrapSuperadmin } from '../backend/accounts/bootstrap.js';
import { createBreachChecker } from '../backend/accounts/breachedPasswords.js';
import { createDelivery } from '../backend/accounts/delivery.js';
import { cleanRecoveryCode } from '../backend/accounts/mfa.js';
import { hashPassword, needsRehash, verifyPassword } from '../backend/accounts/passwords.js';
import { registrationModeFromEnv } from '../backend/accounts/registration.js';
import { createSecretBox, loadMfaKey, parseKey } from '../backend/accounts/secrets.js';
import { ACCOUNT_MIGRATIONS, createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createLoginThrottle, emailKey, ipKeyOf } from '../backend/accounts/throttle.js';
import { base32Decode, hotp, matchTotp, totpAt } from '../backend/accounts/totp.js';
import { decodeCbor, verifyAssertion, verifyRegistration } from '../backend/accounts/webauthn.js';
import { createAccountContext, startupBootstrap } from '../backend/api/accountContext.js';
import { cookie, isSecureRequest, sessionCookie } from '../backend/api/accountHttp.js';
import { createMailer, MAIL_LIMITS } from '../backend/mail/outbox.js';
import { renderMail } from '../backend/mail/templates.js';
import { passwordChecks, passwordProblem, passwordStrength } from '../shared/passwordPolicy.js';
import { browserFor, capture, encodeCbor, linkIn, softAuthenticator, startAuthServer, TEST_ORIGIN, tokenOfLink } from './helpers/authKit.js';

const DatabaseSync = await loadSqlite();
const skip = !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)';
const ROOT_EMAIL = 'root@medkarta.test';
const ROOT_PASSWORD = 'Корневой пароль для тестов 2026';
const USER_PASSWORD = 'Зелёный чай без сахара по утрам';
const MAIL_ENV = { SMTP_FROM: 'МедКарта <noreply@medkarta.test>', PUBLIC_BASE_URL: TEST_ORIGIN };
const MINUTE = 60 * 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Контекст с учебной почтой и управляемыми часами. */
const makeContext = ({ file = ':memory:', mode = 'open', send = null, outbox = [], clock = null, mfaKey = randomBytes(32), env = {}, throttleRules = {} } = {}) => {
  const delivery = createDelivery({ env: { ...MAIL_ENV, ...env }, send: send || capture(outbox) });
  const context = createAccountContext({
    store: createSqliteAccountStore({ DatabaseSync, file }),
    delivery,
    env: { ...MAIL_ENV, ...env },
    mfaKey,
    registrationMode: mode,
    breachCheck: async () => ({ breached: false }),
    throttleRules,
    onAccountDeleted: async () => {},
    systemInfo: async () => ({}),
    ...(clock ? { now: () => clock.t } : {}),
  });
  return { context, outbox };
};

/** Подождать фоновую работу (ответ уходит раньше) и разобрать очередь писем. */
const settle = async (context) => {
  await wait(30);
  await context.mailer.drain();
};

const lastMailTo = (outbox, to) => [...outbox].reverse().find((mail) => mail.to === to) || null;

/* ------------------------------------------------------------------------ */

describe('Пароли: политика NIST/OWASP', () => {
  it('не короче 15 символов, фраза из слов подходит, пробелы и Unicode разрешены', () => {
    assert.equal(passwordProblem(USER_PASSWORD), '');
    assert.equal(passwordProblem('Казань — моя любимая столица'), '');
    assert.equal(passwordProblem('🍵 чай с мятой и мёдом 🍯'), '');
    assert.match(passwordProblem('Kazan Kremlin1'), /не короче 15/);
    assert.match(passwordProblem('x'.repeat(257)), /не длиннее 256/);
  });

  it('длина считается в символах Unicode (NFKC), а не в единицах UTF-16', () => {
    // 15 эмодзи — 30 единиц UTF-16, но 15 символов: проходит по длине, не по повторам.
    assert.equal(passwordProblem('😀🍎🚗🌲🎈📚🎸🧩🛶🏔️🌋🦊🐝🍉🧭'.slice(0)), '');
    assert.match(passwordProblem('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'), /повторяющ/);
  });

  it('отсекаются частые, повторы, ряды клавиатуры, цифры и название сервиса с цифрами', () => {
    assert.match(passwordProblem('qwertyuiopasdfghjkl'), /ряда клавиатуры|распространён/);
    assert.match(passwordProblem('1234567890123456'), /только из цифр/);
    assert.match(passwordProblem('abcabcabcabcabcabc'), /повторяющ/);
    assert.match(passwordProblem('пароль-пароль-пароль'), /повторяющ|распространён/);
    assert.match(passwordProblem('medkarta2026!!!!!'), /Название сервиса/);
    assert.match(passwordProblem('йцукенгшщзхъфывап'), /ряда клавиатуры|распространён/);
    assert.match(passwordProblem('olga.petrova long phrase', { email: 'olga.petrova@medkarta.test' }), /email/);
  });

  it('проверки для подсказок совпадают с сервером; индикатор — только подсказка', () => {
    const checks = passwordChecks('qwertyuiopasdfghjkl');
    assert.deepEqual(checks.map((check) => [check.key, check.ok]), [['length', true], ['common', false], ['email', true]]);
    assert.equal(passwordStrength('short').score, 0);
    assert.ok(passwordStrength(USER_PASSWORD).score >= 3);
    assert.ok(passwordStrength('Длинная фраза из четырёх слов и цифр 2026').score === 4);
  });

  it('scrypt2 с нормализацией NFKC; старый формат scrypt проверяется и требует пересчёта', async () => {
    const decomposed = 'Café au lait at noon please';
    const composed = 'Café au lait at noon please';
    const hash = await hashPassword(decomposed);
    assert.match(hash, /^scrypt2\$32768\$8\$3\$/);
    assert.equal(await verifyPassword(composed, hash), true, 'NFKC: одна и та же строка');
    assert.equal(needsRehash(hash), false);
    // Старый формат: scrypt без нормализации.
    const salt = randomBytes(16);
    const legacy = ['scrypt', 32768, 8, 3, salt.toString('base64url'), scryptSync('Старый пароль 2025 года', salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('base64url')].join('$');
    assert.equal(await verifyPassword('Старый пароль 2025 года', legacy), true);
    assert.equal(await verifyPassword('Старый пароль 2025 годa', legacy), false);
    assert.equal(needsRehash(legacy), true);
    // Слишком длинный ввод — «неверно», без обрезки.
    assert.equal(await verifyPassword('a'.repeat(5000), hash), false);
  });

  it('проверка по базе утечек: k-анонимность (наружу — только 5 знаков SHA-1), сбой сервиса не блокирует', async () => {
    const digest = createHash('sha1').update('Пароль из утечки 2024 года').digest('hex').toUpperCase();
    const requests = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      return { ok: true, text: async () => `0000000000000000000000000000000000A:0\r\n${digest.slice(5)}:42\r\n` };
    };
    const check = createBreachChecker({ env: { PASSWORD_BREACH_CHECK: 'hibp' }, fetchImpl });
    assert.deepEqual(await check('Пароль из утечки 2024 года'), { breached: true, count: 42, checked: true });
    assert.equal(requests[0], `https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`);
    assert.ok(!requests[0].includes(digest.slice(5)), 'полный хэш наружу не уходит');
    const down = createBreachChecker({ env: { PASSWORD_BREACH_CHECK: 'hibp' }, fetchImpl: async () => { throw new Error('offline'); } });
    assert.deepEqual(await down('что угодно длинное'), { breached: false, count: 0, checked: false });
    const off = createBreachChecker({ env: {}, fetchImpl });
    assert.equal((await off('что угодно длинное')).checked, false);
  });
});

describe('TOTP и WebAuthn: низкоуровневые проверки', () => {
  it('TOTP соответствует RFC 6238 (SHA-1) и не принимает повтор шага', () => {
    const secret = Buffer.from('12345678901234567890');
    // RFC 6238, T = 59 c: 94287082 → последние 6 цифр.
    assert.equal(hotp(secret, 1), '287082');
    assert.equal(totpAt(secret, 59 * 1000), '287082');
    const now = 1_800_000_000_000;
    const code = totpAt(secret, now);
    const step = matchTotp(secret, code, { now });
    assert.ok(Number.isInteger(step));
    assert.equal(matchTotp(secret, code, { now, lastStep: step }), null, 'тот же шаг второй раз не принимается');
    assert.equal(matchTotp(secret, '000000', { now }), null);
    assert.equal(matchTotp(secret, 'abcdef', { now }), null);
    assert.deepEqual(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), secret);
  });

  it('CBOR: границы и мусор отвергаются', () => {
    assert.deepEqual(decodeCbor(encodeCbor(new Map([[1, 2], [-1, Buffer.from('ab')]]))).value, new Map([[1, 2], [-1, Buffer.from('ab')]]));
    assert.throws(() => decodeCbor(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff])), /cbor_truncated/);
    assert.throws(() => decodeCbor(Buffer.from([0xf9, 0x3c, 0x00])), /cbor_unsupported/);
  });

  it('ключ доступа: подпись, origin, rpId, challenge и счётчик проверяются', () => {
    const key = softAuthenticator();
    const challenge = randomBytes(32).toString('base64url');
    const registered = verifyRegistration(key.register({ challenge }), { challenge, rpId: 'medkarta.test', origins: [TEST_ORIGIN] });
    assert.equal(registered.algorithm, -7);
    const expect = { rpId: 'medkarta.test', origins: [TEST_ORIGIN], publicKey: registered.publicKey, algorithm: registered.algorithm };
    const login = randomBytes(32).toString('base64url');
    assert.equal(verifyAssertion(key.assert({ challenge: login }), { ...expect, challenge: login, signCount: 0 }).signCount, 1);
    assert.throws(() => verifyAssertion(key.assert({ challenge: login }, { tamper: true }), { ...expect, challenge: login, signCount: 1 }), /bad_signature/);
    assert.throws(() => verifyAssertion(key.assert({ challenge: login }, { overrideOrigin: 'https://medkarta-login.example' }), { ...expect, challenge: login, signCount: 3 }), /bad_origin/);
    assert.throws(() => verifyAssertion(key.assert({ challenge: login }, { overrideRpId: 'evil.example' }), { ...expect, challenge: login, signCount: 4 }), /bad_rp_id/);
    assert.throws(() => verifyAssertion(key.assert({ challenge: 'другой' }), { ...expect, challenge: login, signCount: 5 }), /bad_challenge/);
    assert.throws(() => verifyAssertion(key.assert({ challenge: login }, { replayCounter: true }), { ...expect, challenge: login, signCount: 6 }), /counter_replay/);
    assert.throws(() => verifyRegistration(key.register({ challenge }, { overrideOrigin: 'http://localhost:1' }), { challenge, rpId: 'medkarta.test', origins: [TEST_ORIGIN] }), /bad_origin/);
  });

  it('секреты: ключ из окружения, файл 0600, AES-GCM с привязкой к назначению', () => {
    assert.equal(parseKey(randomBytes(32).toString('base64'))?.length, 32);
    assert.equal(parseKey('короткий'), null);
    assert.throws(() => loadMfaKey({ env: { MFA_SECRET_KEY: 'abc' } }), /32 байт/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-key-'));
    const file = path.join(dir, 'secrets', 'mfa.key');
    const first = loadMfaKey({ env: {}, keyFile: file });
    assert.equal(first.source, 'file');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadMfaKey({ env: {}, keyFile: file }).key, first.key, 'ключ из файла переиспользуется');
    const box = createSecretBox(first.key);
    const sealed = box.seal('секрет', 'totp:1');
    assert.equal(box.open(sealed, 'totp:1').toString(), 'секрет');
    assert.equal(box.open(sealed, 'totp:2'), null, 'другая привязка — не расшифровать');
    assert.equal(createSecretBox(randomBytes(32)).open(sealed, 'totp:1'), null, 'другой ключ — не расшифровать');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------------ */

describe('Регистрация по email', { skip }, () => {
  let context;
  let outbox;
  let server;
  let base;

  before(async () => {
    ({ context, outbox } = makeContext());
    ({ server, base } = await startAuthServer(context));
  });
  after(() => server?.close());

  const register = async (browser, email) => {
    const response = await browser.call('/api/auth/register', { method: 'POST', body: { email } });
    await settle(context);
    return response;
  };

  it('успешная регистрация: письмо → ссылка → «Продолжить» → пароль → вход с ролью user', async () => {
    const tab = browserFor(base);
    const response = await register(tab, 'Olga.Ivanova@MedKarta.test ');
    assert.equal(response.status, 202);
    const mail = lastMailTo(outbox, 'olga.ivanova@medkarta.test');
    assert.equal(mail.subject, 'Подтверждение электронной почты — МедКарта');
    assert.match(mail.text, /Ссылка действительна в течение 30 минут/);
    assert.match(mail.html, /Подтвердить email/);
    const link = linkIn(mail.text);
    assert.match(link, /^https:\/\/medkarta\.test\/register\/confirm#token=/);
    const token = tokenOfLink(link);
    // Открытие ссылки (peek) ничего не меняет — сканер почты её не «сожжёт».
    for (let index = 0; index < 3; index += 1) {
      const peek = await browserFor(base).call('/api/auth/register/peek', { method: 'POST', body: { token } });
      assert.equal(peek.status, 200);
      assert.equal(peek.body.link.email, 'o***@medkarta.test');
    }
    const start = await tab.call('/api/auth/register/start', { method: 'POST', body: { token } });
    assert.equal(start.status, 200);
    assert.equal(start.body.context.email, 'olga.ivanova@medkarta.test');
    const regCookie = tab.cookies.find((line) => line.startsWith('mk_register='));
    assert.match(regCookie, /HttpOnly/);
    assert.match(regCookie, /SameSite=Strict/);
    assert.match(regCookie, /Path=\/api\/auth\/register/);
    const weak = await tab.call('/api/auth/register/complete', { method: 'POST', body: { password: 'Короткий1' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.code, 'weak_password');
    const done = await tab.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD, firstName: 'Ольга' } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.user.role, 'user');
    assert.equal(done.body.user.emailVerified, true);
    assert.equal(done.body.user.firstName, 'Ольга');
    const me = await tab.call('/api/account');
    assert.equal(me.body.user.email, 'olga.ivanova@medkarta.test');
    // Ссылка одноразовая: второй раз — «использована».
    const again = await browserFor(base).call('/api/auth/register/peek', { method: 'POST', body: { token } });
    assert.equal(again.status, 410);
    assert.equal(again.body.code, 'link_used');
    const audit = context.store.listAudit({ filters: { action: 'user.register' } });
    assert.equal(audit.rows.at(-1).details.role, 'user');
  });

  it('роль, права и прочие поля в запросе регистрации не принимаются', async () => {
    const tab = browserFor(base);
    for (const extra of [{ role: 'superadmin' }, { role: 'admin' }, { permissions: ['admin.access'] }, { userId: 'x' }]) {
      const response = await tab.call('/api/auth/register', { method: 'POST', body: { email: 'hacker@medkarta.test', ...extra } });
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.equal(response.body.code, 'unexpected_field');
    }
    // Даже если бы роль проскочила в complete — там тоже только password и firstName.
    const complete = await tab.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD, role: 'admin' } });
    assert.equal(complete.status, 400);
  });

  it('поддельный, обрезанный и чужого вида токены отвергаются; регистрационный токен не годится для смены пароля', async () => {
    const tab = browserFor(base);
    for (const token of ['x', 'A'.repeat(43), `${'A'.repeat(42)}!`, '']) {
      const response = await tab.call('/api/auth/register/peek', { method: 'POST', body: { token } });
      assert.equal(response.status, 404, token);
      assert.equal(response.body.code, 'invalid_link');
    }
    await register(tab, 'cross.purpose@medkarta.test');
    const token = tokenOfLink(linkIn(lastMailTo(outbox, 'cross.purpose@medkarta.test').text));
    const asReset = await tab.call('/api/auth/activation/peek', { method: 'POST', body: { token } });
    assert.equal(asReset.status, 404);
    const asEmail = await tab.call('/api/auth/email-change/peek', { method: 'POST', body: { token } });
    assert.equal(asEmail.status, 404);
  });

  it('повторная регистрация: новая ссылка заменяет прежнюю; существующий аккаунт — письмо «вы уже зарегистрированы», без ключа', async () => {
    const tab = browserFor(base);
    await register(tab, 'twice@medkarta.test');
    const first = tokenOfLink(linkIn(lastMailTo(outbox, 'twice@medkarta.test').text));
    await register(tab, 'twice@medkarta.test');
    const second = tokenOfLink(linkIn(lastMailTo(outbox, 'twice@medkarta.test').text));
    assert.notEqual(first, second);
    assert.equal((await tab.call('/api/auth/register/peek', { method: 'POST', body: { token: first } })).body.code, 'link_revoked');
    assert.equal((await tab.call('/api/auth/register/peek', { method: 'POST', body: { token: second } })).status, 200);
    // Существующий аккаунт: ответ тот же (202), письмо — без ссылки-ключа.
    const before = outbox.length;
    const response = await register(tab, 'olga.ivanova@medkarta.test');
    assert.equal(response.status, 202);
    assert.equal(response.body.message, (await tab.call('/api/auth/register', { method: 'POST', body: { email: 'nobody.new@medkarta.test' } })).body.message);
    await settle(context);
    const notice = outbox.slice(before).find((mail) => mail.to === 'olga.ivanova@medkarta.test');
    assert.equal(notice.subject, 'Вы уже зарегистрированы — МедКарта');
    assert.equal(linkIn(notice.text), null, 'в письме нет ссылки с токеном');
  });

  it('две вкладки: «Продолжить» и пароль срабатывают один раз, второй аккаунт не создаётся', async () => {
    const one = browserFor(base);
    const two = browserFor(base);
    await register(one, 'two.tabs@medkarta.test');
    const token = tokenOfLink(linkIn(lastMailTo(outbox, 'two.tabs@medkarta.test').text));
    const [a, b] = await Promise.all([
      one.call('/api/auth/register/start', { method: 'POST', body: { token } }),
      two.call('/api/auth/register/start', { method: 'POST', body: { token } }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 410]);
    const winner = a.status === 200 ? one : two;
    // Вторая вкладка с той же cookie (тот же браузер) — завершить могут обе одновременно, аккаунт один.
    const twin = browserFor(base);
    for (const [name, value] of winner.jar) twin.jar.set(name, value);
    const results = await Promise.all([
      winner.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD } }),
      twin.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD } }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 410]);
    assert.equal(context.store.listUsers({ filters: { q: 'two.tabs' }, now: Date.now() }).total, 1);
  });

  it('пока заявка не подтверждена, аккаунта нет: вход невозможен, администратор может создать пользователя с этим email', async () => {
    const tab = browserFor(base);
    await register(tab, 'pending.only@medkarta.test');
    assert.equal(context.store.getUserByEmail('pending.only@medkarta.test'), null);
    const login = await tab.login('pending.only@medkarta.test', USER_PASSWORD);
    assert.equal(login.status, 401);
    assert.equal(login.body.code, 'bad_credentials');
  });

  it('если пока шла регистрация адрес заняли — аккаунт не создаётся (email_taken), дубликатов нет', async () => {
    const tab = browserFor(base);
    await register(tab, 'race.email@medkarta.test');
    const token = tokenOfLink(linkIn(lastMailTo(outbox, 'race.email@medkarta.test').text));
    await tab.call('/api/auth/register/start', { method: 'POST', body: { token } });
    context.store.createUser({ id: randomBytes(16).toString('hex'), email: 'race.email@medkarta.test', firstName: 'Другой', now: Date.now() });
    const done = await tab.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD } });
    assert.equal(done.status, 409);
    assert.equal(done.body.code, 'email_taken');
  });

  it('лимиты: не больше трёх писем-ссылок на адрес в час — дальше ответ тот же, писем нет', async () => {
    const tab = browserFor(base);
    const before = outbox.filter((mail) => mail.to === 'flood@medkarta.test').length;
    for (let index = 0; index < 6; index += 1) {
      const response = await register(tab, 'flood@medkarta.test');
      assert.equal(response.status, 202);
    }
    const sent = outbox.filter((mail) => mail.to === 'flood@medkarta.test').length - before;
    assert.ok(sent <= MAIL_LIMITS.LINKS_PER_ADDRESS_HOUR, `ушло ${sent}`);
  });

  it('некорректный email — 400; демо-адреса .example не регистрируются', async () => {
    const tab = browserFor(base);
    assert.equal((await tab.call('/api/auth/register', { method: 'POST', body: { email: 'not-an-email' } })).status, 400);
    const demo = await register(tab, 'someone@demo.example');
    assert.equal(demo.status, 202);
    assert.equal(lastMailTo(outbox, 'someone@demo.example'), null);
  });
});

describe('Регистрация: режимы и недоступная почта', { skip }, () => {
  it('invite_only (по умолчанию) — 403; без REGISTRATION_MODE публичная регистрация закрыта', async () => {
    assert.equal(registrationModeFromEnv({}), 'invite_only');
    assert.equal(registrationModeFromEnv({ REGISTRATION_MODE: 'OPEN' }), 'open');
    assert.equal(registrationModeFromEnv({ REGISTRATION_MODE: 'yes' }), 'invite_only');
    const { context } = makeContext({ mode: 'invite_only' });
    const { server, base } = await startAuthServer(context);
    try {
      const response = await browserFor(base).call('/api/auth/register', { method: 'POST', body: { email: 'a.b@medkarta.test' } });
      assert.equal(response.status, 403);
      assert.equal(response.body.code, 'registration_closed');
      const account = await browserFor(base).call('/api/account');
      assert.equal(account.body.features.registration, false);
    } finally {
      server.close();
    }
  });

  it('почта не настроена — регистрация выключена даже в режиме open, имитации отправки нет', async () => {
    const context = createAccountContext({
      store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }),
      delivery: createDelivery({ env: {} }), env: {}, mfaKey: randomBytes(32), registrationMode: 'open',
      onAccountDeleted: async () => {}, systemInfo: async () => ({}),
    });
    const { server, base } = await startAuthServer(context);
    try {
      const response = await browserFor(base).call('/api/auth/register', { method: 'POST', body: { email: 'a.b@medkarta.test' } });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /не настроена отправка писем/);
      const link = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email: 'a.b@medkarta.test' } });
      assert.equal(link.status, 409);
    } finally {
      server.close();
    }
  });

  it('сбой SMTP: повторы с паузами, после пяти неудач — failed, ссылка помечена как недоставленная', async () => {
    const clock = { t: Date.now() };
    let attempts = 0;
    const { context } = makeContext({ clock, send: async () => { attempts += 1; throw Object.assign(new Error('down'), { code: 'smtp_connect' }); } });
    const result = await context.registration.request('smtp.down@medkarta.test', { sourceKey: 'k' });
    assert.equal(result.status, 'sent');
    const [queued] = context.store.listPendingMail();
    assert.equal(queued.refType, 'registration');
    for (let index = 0; index < 8; index += 1) {
      await context.mailer.drain();
      assert.equal(context.store.getRegistrationById(queued.refId).deliveryStatus, attempts < MAIL_LIMITS.MAX_ATTEMPTS ? 'pending' : 'failed', 'пока есть попытки — не «отправлено» и не «ошибка»');
      clock.t += 31 * MINUTE;
    }
    assert.equal(attempts, MAIL_LIMITS.MAX_ATTEMPTS);
    assert.equal(context.store.listPendingMail().length, 0, 'в очереди ничего не осталось');
    assert.equal(context.store.getMail(queued.id).status, 'failed');
    assert.equal(context.store.getRegistrationById(queued.refId).deliveryStatus, 'failed');
  });
});

/* ------------------------------------------------------------------------ */

describe('Вход: перебор, блокировки и устройства', { skip }, () => {
  it('неверный пароль и несуществующий email неотличимы; после серии ошибок — пауза для незнакомых устройств, но владелец с «своего» устройства входит', async () => {
    const clock = { t: Date.now() };
    const { context, outbox } = makeContext({ clock });
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, password: ROOT_PASSWORD });
    const { server, base } = await startAuthServer(context);
    // Адрес клиента — из X-Forwarded-For от «нашего» прокси (127.0.0.1): так у атакующего и владельца разные адреса.
    const saved = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
    const loginFrom = (browser, ip, email, password) => browser.call('/api/auth/login', { method: 'POST', body: { email, password }, ...from(ip) });
    try {
      const owner = browserFor(base);
      assert.equal((await loginFrom(owner, '198.51.100.7', ROOT_EMAIL, ROOT_PASSWORD)).status, 200, 'владелец вошёл — устройство запомнено');
      await owner.logout();
      const attacker = browserFor(base);
      const unknown = await loginFrom(attacker, '203.0.113.1', 'nobody@medkarta.test', 'Неверный пароль номер один');
      const wrong = await loginFrom(attacker, '203.0.113.1', ROOT_EMAIL, 'Неверный пароль номер один');
      assert.deepEqual([unknown.status, unknown.body.error], [wrong.status, wrong.body.error]);
      // Разные адреса и устройства атакующего: каждое — новое (без cookie), счётчик аккаунта общий.
      let last;
      for (let index = 0; index < 12; index += 1) last = await loginFrom(browserFor(base), `203.0.113.${10 + index}`, ROOT_EMAIL, `Неверный пароль ${index} длинный`);
      assert.equal(last.status, 429);
      assert.equal(last.body.code, 'too_many_attempts');
      assert.ok(Number(last.headers.get('retry-after')) > 0);
      // С правильным паролем, но с незнакомого устройства — тоже пауза: перебор не помогает.
      assert.equal((await loginFrom(browserFor(base), '203.0.113.200', ROOT_EMAIL, ROOT_PASSWORD)).status, 429);
      // Владелец со своего устройства входит: чужие ошибки его не блокируют.
      const ownerAgain = await loginFrom(owner, '198.51.100.7', ROOT_EMAIL, ROOT_PASSWORD);
      assert.equal(ownerAgain.status, 200, JSON.stringify(ownerAgain.body));
      await settle(context);
      assert.ok(outbox.some((mail) => mail.to === ROOT_EMAIL && /Подозрительные попытки входа/.test(mail.subject)), 'владельцу — письмо о попытках');
      // Пять ошибок с одного адреса по одному аккаунту — пауза этой пары, даже со «своего» устройства.
      for (let index = 0; index < 5; index += 1) await loginFrom(owner, '192.0.2.50', ROOT_EMAIL, `Опечатка в пароле ${index} длинная`);
      assert.equal((await loginFrom(owner, '192.0.2.50', ROOT_EMAIL, ROOT_PASSWORD)).status, 429);
      // После паузы — снова можно.
      clock.t += 61 * MINUTE;
      assert.equal((await loginFrom(browserFor(base), '203.0.113.201', ROOT_EMAIL, ROOT_PASSWORD)).status, 200);
    } finally {
      if (saved === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = saved;
      server.close();
    }
  });

  it('пары «адрес + аккаунт» и адрес целиком (credential stuffing по многим аккаунтам) ограничиваются отдельно; смена адреса не обходит аккаунтный лимит', () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const clock = { t: Date.now() };
    const throttle = createLoginThrottle({ store, now: () => clock.t });
    const victim = emailKey('victim@medkarta.test');
    const ipA = ipKeyOf('203.0.113.10');
    for (let index = 0; index < 5; index += 1) throttle.recordFailure({ ipKey: ipA, accountKey: victim, deviceKey: null });
    assert.equal(throttle.check({ ipKey: ipA, accountKey: victim, deviceKey: null }).scope, 'ipacct');
    // Другой адрес — пара свободна, но аккаунтный счётчик продолжает расти.
    for (let index = 0; index < 5; index += 1) throttle.recordFailure({ ipKey: ipKeyOf(`198.51.100.${index}`), accountKey: victim, deviceKey: null });
    assert.equal(throttle.check({ ipKey: ipKeyOf('192.0.2.77'), accountKey: victim, deviceKey: null }).scope, 'account');
    // Один адрес по многим аккаунтам — блок адреса.
    const stuffer = ipKeyOf('2001:db8::1');
    for (let index = 0; index < 20; index += 1) throttle.recordFailure({ ipKey: stuffer, accountKey: emailKey(`user${index}@medkarta.test`), deviceKey: null });
    assert.equal(throttle.check({ ipKey: ipKeyOf('2001:db8::ffff'), accountKey: emailKey('fresh@medkarta.test'), deviceKey: null }).scope, 'ip', 'та же сеть /64');
    // Доверенное устройство: аккаунтная блокировка не действует.
    assert.equal(throttle.check({ ipKey: ipKeyOf('192.0.2.77'), accountKey: victim, deviceKey: 'device-1' }).allowed, true);
    assert.ok(throttle.accountStatus(victim).accountLockedUntil > clock.t);
    assert.ok(throttle.clearAccount(victim) > 0);
    assert.equal(throttle.check({ ipKey: ipKeyOf('192.0.2.77'), accountKey: victim, deviceKey: null }).allowed, true);
  });

  it('ограничения переживают перезапуск сервера', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-throttle-'));
    const file = path.join(dir, 'accounts.sqlite');
    try {
      const first = makeContext({ file });
      await bootstrapSuperadmin({ store: first.context.store, email: ROOT_EMAIL, password: ROOT_PASSWORD });
      for (let index = 0; index < 11; index += 1) {
        await first.context.accounts.login({ email: ROOT_EMAIL, password: `Неверный пароль ${index} длинный` }, { ipKey: `ip${index}` }).catch(() => null);
      }
      first.context.store.close();
      const second = makeContext({ file });
      await assert.rejects(
        second.context.accounts.login({ email: ROOT_EMAIL, password: ROOT_PASSWORD }, { ipKey: 'new-ip' }),
        (error) => error.code === 'too_many_attempts',
      );
      second.context.store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('Второй фактор: лимит неверных кодов на аккаунт', { skip }, () => {
  it('десять неверных кодов за 15 минут — второй шаг закрыт на 15 минут даже в новых вызовах', async () => {
    const clock = { t: Date.now() };
    const { context } = makeContext({ clock });
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, password: ROOT_PASSWORD });
    const { server, base } = await startAuthServer(context);
    try {
      const owner = browserFor(base);
      await owner.login(ROOT_EMAIL, ROOT_PASSWORD);
      const key = softAuthenticator();
      await owner.enrollPasskey(key);
      for (let round = 0; round < 2; round += 1) {
        const tab = browserFor(base);
        await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
        for (let index = 0; index < 5; index += 1) await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code: 'ccccc-ccccc' } });
      }
      const tab = browserFor(base);
      await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
      const locked = await tab.passkeyStep(key);
      assert.equal(locked.status, 429);
      clock.t += 16 * MINUTE;
      const later = browserFor(base);
      await later.login(ROOT_EMAIL, ROOT_PASSWORD);
      assert.equal((await later.passkeyStep(key)).status, 200);
    } finally {
      server.close();
    }
  });
});

describe('Второй фактор, админ-панель и суперадминистратор', { skip }, () => {
  let context;
  let outbox;
  let server;
  let base;
  const clock = { t: Date.now() };
  const rootKey = softAuthenticator();
  let root;

  before(async () => {
    // Порог неверных кодов поднят: здесь их много в разных сценариях; сам порог проверяется отдельно.
    ({ context, outbox } = makeContext({ clock, throttleRules: { mfa: { threshold: 100 } } }));
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startAuthServer(context));
    root = browserFor(base);
  });
  after(() => server?.close());

  it('сотрудник без второго фактора не попадает в админ-панель, пока не настроит его', async () => {
    const login = await root.login(ROOT_EMAIL, ROOT_PASSWORD);
    assert.equal(login.status, 200);
    assert.equal(login.body.security.mfaRequired, true);
    for (const pathname of ['/api/admin/me', '/api/admin/users', '/api/admin/audit', '/api/admin/settings']) {
      const response = await root.call(pathname);
      assert.equal(response.status, 403, pathname);
      assert.equal(response.body.code, 'mfa_setup_required');
    }
    const enrolled = await root.enrollPasskey(rootKey, 'MacBook');
    assert.equal(enrolled.recoveryCodes.length, 10);
    assert.equal(enrolled.security.sessionLevel, 2);
    assert.equal((await root.call('/api/admin/me')).status, 200);
    await settle(context);
    assert.ok(outbox.some((mail) => mail.to === ROOT_EMAIL && /двухфакторная защита/.test(mail.subject)));
  });

  it('вход сотрудника: после пароля — только вызов второго шага, без сессии; обойти прямыми запросами нельзя', async () => {
    const tab = browserFor(base);
    const first = await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
    assert.equal(first.status, 200);
    assert.equal(first.body.mfaRequired, true);
    assert.deepEqual(first.body.methods.sort(), ['recovery', 'webauthn']);
    assert.equal(first.body.user, undefined, 'пользователя и сессии ещё нет');
    assert.ok(![...tab.jar.keys()].includes('mk_sid'));
    assert.equal((await tab.call('/api/admin/me')).status, 401);
    assert.equal((await tab.call('/api/me')).status, 401);
    // Неверный способ, мусор, чужой ключ.
    assert.equal((await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'totp', code: '123456' } })).status, 400);
    assert.equal((await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'sms', code: '1' } })).status, 400);
    const stranger = softAuthenticator();
    const options = await tab.call('/api/auth/mfa/options', { method: 'POST', body: {} });
    const foreign = await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'webauthn', credential: stranger.assert(options.body.passkey) } });
    assert.equal(foreign.status, 400);
    const challengeCookie = tab.jar.get('mk_mfa');
    const ok = await tab.passkeyStep(rootKey);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await tab.call('/api/admin/me')).status, 200);
    // Вызов одноразовый: повтор с тем же cookie второго шага — «войдите заново».
    const replay = browserFor(base);
    replay.jar.set('mk_mfa', challengeCookie);
    const again = await replay.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code: 'aaaaa-aaaaa' } });
    assert.equal(again.status, 401);
    assert.equal(again.body.code, 'mfa_expired');
  });

  it('пять неверных кодов — вызов сгорает; резервный код срабатывает один раз и присылает уведомление', async () => {
    const tab = browserFor(base);
    await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
    for (let index = 0; index < 5; index += 1) {
      const response = await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code: 'bbbbb-bbbbb' } });
      assert.equal(response.status, 400);
    }
    const dead = await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code: 'bbbbb-bbbbb' } });
    assert.equal(dead.status, 401);
    assert.equal(dead.body.code, 'mfa_expired');

    // Новый набор кодов — только со свежим подтверждением личности.
    const codes = await root.call('/api/me/mfa/recovery-codes', { method: 'POST', body: {} });
    assert.equal(codes.status, 200, JSON.stringify(codes.body));
    const [code] = codes.body.recoveryCodes;
    assert.ok(cleanRecoveryCode(code));
    const tab2 = browserFor(base);
    await tab2.login(ROOT_EMAIL, ROOT_PASSWORD);
    const used = await tab2.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code: code.toUpperCase() } });
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.equal(used.body.recoveryCodesLeft, 9);
    const tab3 = browserFor(base);
    await tab3.login(ROOT_EMAIL, ROOT_PASSWORD);
    assert.equal((await tab3.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'recovery', code } })).status, 400, 'второй раз — нет');
    await settle(context);
    assert.ok(outbox.some((mail) => mail.to === ROOT_EMAIL && /резервному коду/.test(mail.subject)));
  });

  it('TOTP: настройка с проверкой кода, вход по коду, повтор того же кода отклоняется', async () => {
    const begin = await root.call('/api/me/mfa/totp', { method: 'POST', body: {} });
    assert.equal(begin.status, 200, JSON.stringify(begin.body));
    assert.match(begin.body.uri, /^otpauth:\/\/totp\//);
    const secret = base32Decode(begin.body.secret);
    const wrong = await root.call('/api/me/mfa/totp/confirm', { method: 'POST', body: { factorId: begin.body.factorId, code: '000000' } });
    assert.equal(wrong.status, 400);
    const confirm = await root.call('/api/me/mfa/totp/confirm', { method: 'POST', body: { factorId: begin.body.factorId, code: totpAt(secret, clock.t), label: 'Яндекс Ключ' } });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal(confirm.body.recoveryCodes, null, 'коды уже есть — не перевыпускаются');
    clock.t += 31 * 1000;
    const tab = browserFor(base);
    await tab.login(ROOT_EMAIL, ROOT_PASSWORD);
    const code = totpAt(secret, clock.t);
    assert.equal((await tab.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'totp', code } })).status, 200);
    const replay = browserFor(base);
    await replay.login(ROOT_EMAIL, ROOT_PASSWORD);
    assert.equal((await replay.call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'totp', code } })).status, 400, 'тот же код — второй раз нет');
    // В базе секрет TOTP только зашифрован.
    const [factor] = context.store.listFactors(context.store.getUserByEmail(ROOT_EMAIL).id).filter((item) => item.type === 'totp');
    assert.match(factor.secretEnc, /^v1\./);
    assert.ok(!factor.secretEnc.includes(begin.body.secret));
  });

  it('критическое действие без свежего подтверждения — reauth_required; после пароля и второго фактора — можно', async () => {
    clock.t += 11 * MINUTE;
    // Сессия ещё жива (активность), но подтверждение личности устарело.
    const users = await root.call('/api/admin/users');
    assert.equal(users.status, 200);
    const exported = await root.call('/api/admin/users/export');
    assert.equal(exported.status, 403);
    assert.equal(exported.body.code, 'reauth_required');
    const badPassword = await root.call('/api/me/reauth', { method: 'POST', body: { password: 'Не тот пароль для проверки', method: 'webauthn' } });
    assert.equal(badPassword.status, 400);
    const noFactor = await root.call('/api/me/reauth', { method: 'POST', body: { password: ROOT_PASSWORD } });
    assert.equal(noFactor.status, 400, 'со включённой MFA одного пароля мало');
    const options = await root.call('/api/me/reauth/options', { method: 'POST', body: {} });
    const reauth = await root.call('/api/me/reauth', { method: 'POST', body: { password: ROOT_PASSWORD, method: 'webauthn', credential: rootKey.assert(options.body.passkey) } });
    assert.equal(reauth.status, 200, JSON.stringify(reauth.body));
    assert.equal((await root.call('/api/admin/users/export')).status, 200);
  });

  it('последний активный суперадминистратор: не удалить последний фактор, не понизить, не заблокировать', async () => {
    const security = await root.call('/api/me/security');
    for (const factor of security.body.factors.filter((item) => item.type !== 'webauthn')) {
      assert.equal((await root.call(`/api/me/mfa/factors/${factor.id}`, { method: 'DELETE', body: {} })).status, 200);
    }
    const [last] = (await root.call('/api/me/security')).body.factors;
    const denied = await root.call(`/api/me/mfa/factors/${last.id}`, { method: 'DELETE', body: {} });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.code, 'last_factor');
  });

  it('эскалация прав: пользователь, модератор и администратор не получают больше, чем им положено', async () => {
    // Администратор и модератор — по приглашению, со своими ключами.
    const created = {};
    const passwords = { admin: 'Тёплый вечер на набережной Казанки', moderator: 'Старый трамвай идёт по кругу', user: 'Белые ночи и долгие прогулки' };
    for (const [role, email] of [['admin', 'admin@medkarta.test'], ['moderator', 'mod@medkarta.test'], ['user', 'plain@medkarta.test']]) {
      const response = await root.call('/api/admin/users', { method: 'POST', body: { email, firstName: 'Тест', lastName: 'Роль', role, delivery: 'manual' } });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const tab = browserFor(base);
      const token = tokenOfLink(response.body.link);
      await tab.call('/api/auth/activation/start', { method: 'POST', body: { token } });
      const done = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: passwords[role] } });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const key = softAuthenticator();
      if (role !== 'user') await tab.enrollPasskey(key);
      created[role] = { tab, key, id: response.body.user.id };
    }
    // Пользователь: никакого admin API.
    assert.equal((await created.user.tab.call('/api/admin/me')).status, 403);
    assert.equal((await created.user.tab.call('/api/admin/users')).status, 403);
    // Модератор не меняет свою роль и роль других.
    const modSelf = await created.moderator.tab.call(`/api/admin/users/${created.moderator.id}/role`, { method: 'POST', body: { role: 'admin' } });
    assert.equal(modSelf.status, 403);
    // Администратор не может сделать себя или другого суперадминистратором — даже подделав запрос.
    for (const target of [created.admin.id, created.user.id]) {
      const response = await created.admin.tab.call(`/api/admin/users/${target}/role`, { method: 'POST', body: { role: 'superadmin' } });
      assert.equal(response.status, 403, target);
      assert.ok(['forbidden', 'self_action'].includes(response.body.code), JSON.stringify(response.body));
    }
    const sneaky = await created.admin.tab.call('/api/admin/users', { method: 'POST', body: { email: 'sneaky@medkarta.test', firstName: 'А', lastName: 'Б', role: 'superadmin', delivery: 'manual' } });
    assert.equal(sneaky.status, 403);
    // Лишние поля (permissions, role) в профиле — 400, а не молчаливое игнорирование.
    const patch = await created.user.tab.call('/api/me', { method: 'PATCH', body: { firstName: 'Новое', role: 'superadmin' } });
    assert.equal(patch.status, 400);
    // Нельзя удалить последнего суперадминистратора.
    const rootId = context.store.getUserByEmail(ROOT_EMAIL).id;
    const kill = await created.admin.tab.call(`/api/admin/users/${rootId}`, { method: 'DELETE', body: { confirmEmail: ROOT_EMAIL } });
    assert.equal(kill.status, 403);
    // Смена роли записывается в аудит.
    const promote = await root.call(`/api/admin/users/${created.user.id}/role`, { method: 'POST', body: { role: 'moderator' } });
    assert.equal(promote.status, 200, JSON.stringify(promote.body));
    const entry = context.store.listAudit({ filters: { action: 'user.role', targetId: created.user.id } }).rows[0];
    assert.deepEqual(entry.details, { from: 'user', to: 'moderator' });
    // Новый модератор без MFA в админ-панель не попадает.
    const fresh = await created.user.tab.call('/api/admin/me');
    assert.ok([401, 403].includes(fresh.status));
    if (fresh.status === 403) assert.equal(fresh.body.code, 'mfa_setup_required');
  });

  it('сессии сотрудника короче: 30 минут без активности — вход заново', async () => {
    const tab = browserFor(base);
    await tab.signIn(ROOT_EMAIL, ROOT_PASSWORD, rootKey);
    assert.equal((await tab.call('/api/admin/me')).status, 200);
    clock.t += 31 * MINUTE;
    assert.equal((await tab.call('/api/admin/me')).status, 401);
  });

  it('сброс пароля по почте не отключает второй фактор и завершает все сессии; сотруднику без MFA ссылка почтой не уходит', async () => {
    const tab = browserFor(base);
    await tab.signIn(ROOT_EMAIL, ROOT_PASSWORD, rootKey);
    const before = outbox.length;
    const request = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email: ROOT_EMAIL } });
    assert.equal(request.status, 202);
    await settle(context);
    const mail = outbox.slice(before).find((item) => item.to === ROOT_EMAIL && /Восстановление пароля/.test(item.subject));
    assert.ok(mail, 'у суперадминистратора с MFA — ссылка уходит');
    const token = tokenOfLink(linkIn(mail.text));
    const newcomer = browserFor(base);
    await newcomer.call('/api/auth/activation/start', { method: 'POST', body: { token } });
    const NEW_PASSWORD = 'Новый корневой пароль после сброса';
    const done = await newcomer.call('/api/auth/activation/complete', { method: 'POST', body: { password: NEW_PASSWORD } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    // Старая сессия завершена; новая — без второго фактора, админ-панель просит его.
    assert.equal((await tab.call('/api/admin/me')).status, 401);
    const gate = await newcomer.call('/api/admin/me');
    assert.equal(gate.status, 403);
    assert.equal(gate.body.code, 'mfa_required');
    assert.ok(context.mfa.hasMfa(context.store.getUserByEmail(ROOT_EMAIL).id), 'MFA на месте');
    // Повторное использование ссылки.
    assert.equal((await browserFor(base).call('/api/auth/activation/start', { method: 'POST', body: { token } })).status, 410);
    await settle(context);
    assert.ok(outbox.some((item) => item.to === ROOT_EMAIL && /Пароль изменён/.test(item.subject)));
    // Сотрудник без MFA: ссылка почтой не уходит (ответ тот же).
    const mod = context.store.getUserByEmail('plain@medkarta.test');
    assert.equal(mod.role, 'moderator');
    const count = outbox.length;
    const response = await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email: 'plain@medkarta.test' } });
    assert.equal(response.status, 202);
    await settle(context);
    assert.equal(outbox.slice(count).filter((item) => item.to === 'plain@medkarta.test' && /пароля/.test(item.subject)).length, 0);
    await root.signIn(ROOT_EMAIL, NEW_PASSWORD, rootKey);
  });
});

/* ------------------------------------------------------------------------ */

describe('Сессии, восстановление и смена email для обычного пользователя', { skip }, () => {
  let context;
  let outbox;
  let server;
  let base;
  const clock = { t: Date.now() };

  before(async () => {
    ({ context, outbox } = makeContext({ clock }));
    ({ server, base } = await startAuthServer(context));
    const tab = browserFor(base);
    await tab.call('/api/auth/register', { method: 'POST', body: { email: 'anna@medkarta.test' } });
    await settle(context);
    const token = tokenOfLink(linkIn(lastMailTo(outbox, 'anna@medkarta.test').text));
    await tab.call('/api/auth/register/start', { method: 'POST', body: { token } });
    await tab.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD } });
  });
  after(() => server?.close());

  it('cookie сессии: HttpOnly, SameSite=Lax, Path=/; по HTTPS — __Host- и Secure', async () => {
    const tab = browserFor(base);
    await tab.login('anna@medkarta.test', USER_PASSWORD);
    const line = tab.cookies.find((item) => item.startsWith('mk_sid='));
    assert.match(line, /HttpOnly/);
    assert.match(line, /SameSite=Lax/);
    assert.match(line, /Path=\//);
    assert.doesNotMatch(line, /Domain=/);
    const secureReq = { headers: { cookie: '' }, socket: { encrypted: true } };
    assert.equal(isSecureRequest(secureReq), true);
    assert.match(sessionCookie(secureReq, 'token', Date.now() + 60_000), /^__Host-mk_sid=token; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    assert.match(cookie(secureReq, 'x', 'y', 1), /Secure/);
  });

  it('выход, отзыв сессии и повторное использование отозванного токена', async () => {
    const one = browserFor(base);
    const two = browserFor(base);
    await one.login('anna@medkarta.test', USER_PASSWORD);
    await two.login('anna@medkarta.test', USER_PASSWORD);
    const stolen = one.jar.get('mk_sid');
    const target = (await one.call('/api/me')).body.session.id;
    // Чужую сессию по публичному id не завершить: id из другого аккаунта не находится.
    assert.equal((await two.call(`/api/me/sessions/${'0'.repeat(24)}`, { method: 'DELETE', body: {} })).status, 404);
    assert.equal((await two.call(`/api/me/sessions/${target}`, { method: 'DELETE', body: {} })).status, 200);
    const replay = browserFor(base);
    replay.jar.set('mk_sid', stolen);
    assert.equal((await replay.call('/api/me')).status, 401);
    await two.logout();
    assert.equal((await two.call('/api/me')).status, 401);
    // Две cookie сессии сразу (подброшенная) — не угадываем, сессии нет.
    const doubled = await fetch(`${base}/api/me`, { headers: { cookie: `mk_sid=${stolen}; mk_sid=${stolen}` } });
    assert.equal(doubled.status, 401);
  });

  it('истечение сессии без активности (14 дней) и предельный срок — на сервере', async () => {
    const tab = browserFor(base);
    await tab.login('anna@medkarta.test', USER_PASSWORD);
    clock.t += 15 * 24 * 60 * MINUTE;
    assert.equal((await tab.call('/api/me')).status, 401);
  });

  it('восстановление пароля: одноразовая короткая ссылка, старый пароль не работает, сессии завершены, нет перечисления адресов', async () => {
    const active = browserFor(base);
    await active.login('anna@medkarta.test', USER_PASSWORD);
    const responses = [];
    for (const email of ['anna@medkarta.test', 'ghost@medkarta.test']) {
      responses.push(await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email } }));
    }
    assert.deepEqual(responses.map((item) => [item.status, item.body.message]), [[202, responses[0].body.message], [202, responses[0].body.message]]);
    await settle(context);
    assert.equal(lastMailTo(outbox, 'ghost@medkarta.test'), null);
    const mail = lastMailTo(outbox, 'anna@medkarta.test');
    assert.match(mail.subject, /Восстановление пароля/);
    const token = tokenOfLink(linkIn(mail.text));
    // Ссылка короткая: 30 минут по умолчанию.
    const peek = await browserFor(base).call('/api/auth/activation/peek', { method: 'POST', body: { token } });
    assert.ok(Date.parse(peek.body.link.expiresAt) - clock.t <= 30 * MINUTE + 1000);
    const tab = browserFor(base);
    await tab.call('/api/auth/activation/start', { method: 'POST', body: { token } });
    const NEW = 'Синее небо над Волгой летом';
    assert.equal((await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password: NEW } })).status, 200);
    assert.equal((await active.call('/api/me')).status, 401, 'прежние сессии завершены');
    assert.equal((await browserFor(base).login('anna@medkarta.test', USER_PASSWORD)).status, 401, 'старый пароль не работает');
    assert.equal((await browserFor(base).login('anna@medkarta.test', NEW)).status, 200);
    assert.equal((await browserFor(base).call('/api/auth/activation/start', { method: 'POST', body: { token } })).status, 410, 'ссылка одноразовая');
    // Истёкшая ссылка.
    await browserFor(base).call('/api/auth/access-link', { method: 'POST', body: { email: 'anna@medkarta.test' } });
    await settle(context);
    const expiring = tokenOfLink(linkIn(lastMailTo(outbox, 'anna@medkarta.test').text));
    clock.t += 31 * MINUTE;
    const expired = await browserFor(base).call('/api/auth/activation/peek', { method: 'POST', body: { token: expiring } });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'link_expired');
  });

  it('смена email: нужна свежая проверка личности, ссылка — на новый адрес, уведомления — на прежний, затем вход по новому', async () => {
    const tab = browserFor(base);
    await tab.login('anna@medkarta.test', 'Синее небо над Волгой летом');
    clock.t += 11 * MINUTE;
    await tab.call('/api/me');
    const stale = await tab.call('/api/me/email', { method: 'POST', body: { newEmail: 'anna.new@medkarta.test' } });
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, 'reauth_required');
    const reauth = await tab.call('/api/me/reauth', { method: 'POST', body: { password: 'Синее небо над Волгой летом' } });
    assert.equal(reauth.status, 200);
    const request = await tab.call('/api/me/email', { method: 'POST', body: { newEmail: 'anna.new@medkarta.test', role: 'admin' } });
    assert.equal(request.status, 400, 'лишние поля не принимаются');
    const ok = await tab.call('/api/me/email', { method: 'POST', body: { newEmail: 'anna.new@medkarta.test' } });
    assert.equal(ok.status, 202);
    await settle(context);
    assert.equal(context.store.getUserByEmail('anna@medkarta.test').email, 'anna@medkarta.test', 'до подтверждения email прежний');
    assert.match(lastMailTo(outbox, 'anna@medkarta.test').subject, /Запрошена смена email/);
    const link = linkIn(lastMailTo(outbox, 'anna.new@medkarta.test').text);
    assert.match(link, /\/email\/confirm#token=/);
    const other = browserFor(base);
    await other.login('anna@medkarta.test', 'Синее небо над Волгой летом');
    const token = tokenOfLink(link);
    const peek = await browserFor(base).call('/api/auth/email-change/peek', { method: 'POST', body: { token } });
    assert.equal(peek.body.change.newEmail, 'anna.new@medkarta.test');
    const confirm = await tab.call('/api/auth/email-change/confirm', { method: 'POST', body: { token } });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal(confirm.body.signedIn, true);
    assert.equal((await other.call('/api/me')).status, 401, 'остальные сессии завершены');
    assert.equal((await tab.call('/api/me')).body.user.email, 'anna.new@medkarta.test');
    await settle(context);
    assert.match(lastMailTo(outbox, 'anna@medkarta.test').subject, /Email изменён/);
    assert.equal((await browserFor(base).call('/api/auth/email-change/confirm', { method: 'POST', body: { token } })).status, 410);
  });

  it('занятый адрес при смене email: ответ тот же, письмо на новый адрес — «уже используется»', async () => {
    context.store.createUser({ id: randomBytes(16).toString('hex'), email: 'taken@medkarta.test', firstName: 'Занят', passwordHash: await hashPassword(USER_PASSWORD), now: clock.t });
    const tab = browserFor(base);
    await tab.login('anna.new@medkarta.test', 'Синее небо над Волгой летом');
    const response = await tab.call('/api/me/email', { method: 'POST', body: { newEmail: 'taken@medkarta.test' } });
    assert.equal(response.status, 202);
    await settle(context);
    const mail = lastMailTo(outbox, 'taken@medkarta.test');
    assert.match(mail.subject, /уже используется/);
    assert.equal(linkIn(mail.text), null);
  });
});

/* ------------------------------------------------------------------------ */

describe('Почтовая очередь и шаблоны', { skip }, () => {
  it('письма со ссылками в очереди только зашифрованы; после «перезапуска» — failed, а не отправка мусора', async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const sent = [];
    const delivery = createDelivery({ env: MAIL_ENV, send: capture(sent) });
    const statuses = [];
    const first = createMailer({ store, delivery, onStatus: (ref, status) => statuses.push([ref.id, status]) });
    const id = first.enqueue({ kind: 'reset', to: 'a.b@medkarta.test', params: { link: `${TEST_ORIGIN}/activate#token=${'T'.repeat(43)}`, expiresAt: Date.now() + MINUTE }, ref: { type: 'access_token', id: 'tok1' } });
    const row = store.getMail(id);
    assert.ok(!row.payload.includes('TTTT'), 'токена в базе нет');
    assert.equal(row.keyId !== null, true);
    // Новый процесс — другой ключ: письмо не расшифровать, оно помечается неудачным.
    const second = createMailer({ store, delivery, onStatus: (ref, status) => statuses.push([ref.id, status]) });
    await second.drain();
    assert.equal(sent.length, 0);
    assert.deepEqual(statuses, [['tok1', 'failed']]);
    // Уведомление без ключа переживает перезапуск и уходит.
    first.enqueue({ kind: 'password_changed', to: 'a.b@medkarta.test', params: { at: Date.now() } });
    await second.drain();
    assert.equal(sent.length, 1);
    assert.equal(store.listPendingMail().length, 0);
    const done = store.getMail(id);
    assert.equal(done.toAddress, null, 'адрес стёрт после обработки');
  });

  it('шаблон подтверждения: тема, кнопка, срок, текстовая версия, экранирование и никакой медицины', () => {
    const mail = renderMail('register_confirm', { link: `${TEST_ORIGIN}/register/confirm#token=abc`, expiresAt: Date.now() + 30 * MINUTE, ttlMinutes: 30 });
    assert.equal(mail.subject, 'Подтверждение электронной почты — МедКарта');
    assert.match(mail.text, /Если вы не запрашивали регистрацию, просто проигнорируйте письмо/);
    assert.match(mail.html, /<a href="https:\/\/medkarta\.test\/register\/confirm#token=abc"/);
    const hostile = renderMail('invite', { name: '<script>alert(1)</script>', link: `${TEST_ORIGIN}/activate#token=x`, expiresAt: Date.now() });
    assert.ok(!hostile.html.includes('<script>'));
    for (const kind of ['register_confirm', 'reset', 'password_changed', 'new_login']) {
      const text = renderMail(kind, { link: 'https://x', expiresAt: Date.now(), at: Date.now(), ttlMinutes: 30 }).text;
      assert.doesNotMatch(text, /симптом|диагноз|запис[ьи] к врачу|ассистент/i, kind);
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('Миграция базы: схема 4 → 5', { skip }, () => {
  it('копия перед миграцией, пользователи и пароли сохранены, старые сессии отозваны, пароль пересчитан при входе', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-migrate-'));
    const file = path.join(dir, 'accounts.sqlite');
    try {
      const legacyDb = new DatabaseSync(file);
      for (let version = 0; version < 4; version += 1) {
        const migration = ACCOUNT_MIGRATIONS[version];
        legacyDb.exec('BEGIN');
        if (typeof migration === 'function') migration(legacyDb);
        else legacyDb.exec(migration);
        legacyDb.exec(`PRAGMA user_version = ${version + 1}`);
        legacyDb.exec('COMMIT');
      }
      const salt = randomBytes(16);
      const legacyHash = ['scrypt', 32768, 8, 3, salt.toString('base64url'), scryptSync('Старый пароль владельца 2025', salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('base64url')].join('$');
      const now = Date.now();
      legacyDb.prepare(`INSERT INTO users (id, email, display_name, first_name, password_hash, role, status, activated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'superadmin', 'active', ?, ?, ?)`).run('a'.repeat(32), 'owner@medkarta.test', 'Максим', 'Максим', legacyHash, now, now, now);
      legacyDb.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, public_id, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('b'.repeat(64), 'a'.repeat(32), now, now + MINUTE * 60, 'c'.repeat(24), now);
      legacyDb.prepare(`INSERT INTO access_tokens (id, token_hash, user_id, purpose, email, source, delivery, delivery_status, created_at, expires_at)
        VALUES (?, ?, ?, 'reset', ?, 'admin', 'manual', 'manual', ?, ?)`).run('d'.repeat(24), 'e'.repeat(64), 'a'.repeat(32), 'owner@medkarta.test', now, now + MINUTE);
      legacyDb.close();

      const { context } = makeContext({ file });
      const { store } = context;
      assert.equal(store.health().schemaVersion, 5);
      assert.ok(store.migrationBackup && fs.existsSync(store.migrationBackup), 'копия базы перед миграцией');
      assert.equal(fs.statSync(store.migrationBackup).mode & 0o777, 0o600);
      const owner = store.getUserByEmail('owner@medkarta.test');
      assert.equal(owner.role, 'superadmin');
      assert.ok(owner.emailVerifiedAt, 'активированный аккаунт считается подтверждённым');
      assert.equal(store.getSession('b'.repeat(64)), null, 'старые сессии отозваны');
      assert.equal(store.getAccessTokenById('d'.repeat(24)).purpose, 'reset', 'ссылки сохранены');
      const result = await context.accounts.login({ email: 'owner@medkarta.test', password: 'Старый пароль владельца 2025' }, { ipKey: 'k' });
      assert.ok(result.session, 'старый пароль работает (пароль владельца не менялся)');
      assert.match(store.getUserByEmail('owner@medkarta.test').passwordHash, /^scrypt2\$/, 'хэш пересчитан в новый формат');
      store.close();
      // Повторный запуск: схема уже 5 — новой копии не делается.
      const again = makeContext({ file });
      assert.equal(again.context.store.migrationBackup, null);
      again.context.store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('суперадминистратор при запуске создаётся только вне production и никогда не перезаписывается', async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    assert.equal(await startupBootstrap({ store, env: { NODE_ENV: 'production', ADMIN_BOOTSTRAP_PASSWORD: ROOT_PASSWORD } }), 'ignored');
    assert.equal(store.countUsers(), 0);
    assert.equal(await startupBootstrap({ store, env: {} }), 'skipped');
    assert.equal(await startupBootstrap({ store, env: { ADMIN_BOOTSTRAP_PASSWORD: ROOT_PASSWORD, ADMIN_BOOTSTRAP_EMAIL: ROOT_EMAIL } }), 'created');
    const hash = store.getUserByEmail(ROOT_EMAIL).passwordHash;
    assert.equal(await startupBootstrap({ store, env: { ADMIN_BOOTSTRAP_PASSWORD: 'Совсем другой пароль 2027 года', ADMIN_BOOTSTRAP_EMAIL: ROOT_EMAIL } }), 'exists');
    assert.equal(store.getUserByEmail(ROOT_EMAIL).passwordHash, hash);
  });
});
