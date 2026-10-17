/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Личный кабинет: пароли, сессии, программа ДМС, избранное, HTTP-слой.
 * База — настоящий SQLite в памяти (node:sqlite), сервер — настоящий http.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { hashPassword, PasswordBusyError, passwordProblem, verifyPassword } from '../backend/accounts/passwords.js';
import { ACCOUNT_LIMITS, AccountError, createAccountService, decodeItemId, DEMO_ACCOUNTS, encodeItemId } from '../backend/accounts/service.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountHandler, createFailureCounter, parseCookies, SESSION_COOKIE } from '../backend/api/account.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';

const DatabaseSync = await loadSqlite();
const PLANS = new Set(['demo-basic', 'demo-standard', 'demo-premium']);

const makeService = ({ now = () => Date.now() } = {}) => {
  const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
  return { store, service: createAccountService({ store, isKnownPlan: (id) => PLANS.has(id), now }) };
};

const rejects = async (promiseOrFn, code) => {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (error) {
    assert.ok(error instanceof AccountError, `ожидалась AccountError, получено ${error}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`ожидалась ошибка ${code}`);
};

describe('Кабинет: окружение', () => {
  it('node:sqlite доступен (Node 22.13+)', () => {
    assert.equal(typeof DatabaseSync, 'function');
  });
});

describe('Кабинет: пароли', () => {
  it('хэш scrypt с солью: тот же пароль — разные хэши, проверка проходит', async () => {
    const first = await hashPassword('correct horse battery');
    const second = await hashPassword('correct horse battery');
    assert.match(first, /^scrypt\$16384\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('correct horse battery', first), true);
    assert.equal(await verifyPassword('correct horse batterY', first), false);
  });

  it('битый или чужой хэш — просто «нет», а не исключение', async () => {
    for (const stored of [null, '', 'plain', 'scrypt$1$1$1$a$b', 'scrypt$1048576$8$1$c2FsdA$aGFzaGhhc2hoYXNoaGFzaA']) {
      assert.equal(await verifyPassword('anything-long', stored), false, String(stored));
    }
  });

  it('не больше двух расчётов scrypt сразу, лишнее — «занято», а не «неверный пароль»', async () => {
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => hashPassword(`пароль-${index}-xx`)));
    const busy = results.filter((item) => item.status === 'rejected');
    assert.ok(busy.length >= 1 && busy.length <= 6, `отказов: ${busy.length}`);
    assert.ok(busy.every((item) => item.reason instanceof PasswordBusyError));
    // После волны очередь свободна.
    assert.match(await hashPassword('после-волны-1'), /^scrypt\$/);
  });

  it('правила пароля', () => {
    assert.match(passwordProblem('Password'), /распространён/);
    assert.match(passwordProblem('ffffffffff'), /повторяющегося/);
    assert.match(passwordProblem('short'), /не короче 8/);
    assert.match(passwordProblem('12345678'), /только из цифр/);
    assert.equal(passwordProblem('нормальный-пароль'), '');
    assert.match(passwordProblem(undefined), /Введите/);
  });
});

describe('Кабинет: аккаунт и сессии', () => {
  it('регистрация, вход, выход', async () => {
    const { service } = makeService();
    const registered = await service.register({ email: '  Maksim@Example.RU ', password: 'длинный пароль', displayName: ' Максим ', consent: true });
    assert.equal(registered.user.email, 'maksim@example.ru');
    assert.equal(registered.user.displayName, 'Максим');
    assert.equal('passwordHash' in registered.user, false, 'хэш пароля ушёл бы в браузер');
    assert.ok(service.sessionUser(registered.session.token));

    const loggedIn = await service.login({ email: 'MAKSIM@example.ru', password: 'длинный пароль' });
    assert.ok(service.sessionUser(loggedIn.session.token));
    service.logout(loggedIn.session.token);
    assert.equal(service.sessionUser(loggedIn.session.token), null);
    assert.ok(service.sessionUser(registered.session.token), 'выход из одного браузера не выкидывает из другого');
  });

  it('неверный пароль и несуществующий email — один и тот же ответ', async () => {
    const { service } = makeService();
    await service.register({ email: 'a@b.ru', password: 'пароль-пароль', displayName: 'А', consent: true });
    await rejects(service.login({ email: 'a@b.ru', password: 'не тот пароль' }), 'bad_credentials');
    await rejects(service.login({ email: 'nobody@b.ru', password: 'пароль-пароль' }), 'bad_credentials');
    await rejects(service.login({ email: 42, password: null }), 'bad_credentials');
  });

  it('проверки регистрации', async () => {
    const { service } = makeService();
    const base = { email: 'x@y.ru', password: 'пароль-пароль', displayName: 'Икс', consent: true };
    await rejects(service.register({ ...base, consent: false }), 'consent_required');
    await rejects(service.register({ ...base, email: 'не почта' }), 'bad_email');
    await rejects(service.register({ ...base, email: 'anna@medkarta.example' }), 'bad_email');
    await rejects(service.register({ ...base, displayName: '\u200b \u0007' }), 'bad_name');
    await rejects(service.register({ ...base, password: '123' }), 'weak_password');
    await service.register(base);
    await rejects(service.register({ ...base, email: 'X@Y.RU' }), 'email_taken');
  });

  it('сессия истекает через 30 дней', async () => {
    let clock = Date.parse('2026-10-08T10:00:00Z');
    const { service } = makeService({ now: () => clock });
    const { session } = await service.register({ email: 'c@d.ru', password: 'пароль-пароль', displayName: 'Ц', consent: true });
    clock += ACCOUNT_LIMITS.SESSION_TTL_MS - 1000;
    assert.ok(service.sessionUser(session.token));
    clock += 2000;
    assert.equal(service.sessionUser(session.token), null);
  });

  it('не больше 10 одновременных входов — старые вытесняются', async () => {
    const { service } = makeService();
    const first = await service.register({ email: 'e@f.ru', password: 'пароль-пароль', displayName: 'Е', consent: true });
    const tokens = [first.session.token];
    for (let index = 0; index < ACCOUNT_LIMITS.MAX_SESSIONS_PER_USER; index += 1) {
      tokens.push((await service.login({ email: 'e@f.ru', password: 'пароль-пароль' })).session.token);
    }
    assert.equal(service.sessionUser(tokens[0]), null);
    assert.ok(service.sessionUser(tokens.at(-1)));
  });

  it('мусорный токен не падает', () => {
    const { service } = makeService();
    for (const token of [undefined, '', 'x', 'a'.repeat(500), '../../etc']) assert.equal(service.sessionUser(token), null);
  });
});

describe('Кабинет: программа ДМС и избранное', () => {
  it('программа — только из справочника', async () => {
    const { service } = makeService();
    const { session } = await service.register({ email: 'g@h.ru', password: 'пароль-пароль', displayName: 'Г', consent: true });
    const user = service.sessionUser(session.token);
    assert.equal(service.updateProfile(user, { dmsPlanId: 'demo-standard' }).user.dmsPlanId, 'demo-standard');
    assert.equal(service.updateProfile(user, { dmsPlanId: null }).user.dmsPlanId, null);
    assert.throws(() => service.updateProfile(user, { dmsPlanId: 'no-such-plan' }), (error) => error.code === 'unknown_plan');
    assert.throws(() => service.updateProfile(user, { dmsPlanId: "x'; DROP TABLE users;--" }), (error) => error.code === 'unknown_plan');
  });

  it('избранное: строки и числа возвращаются как были, повторы не дублируются', async () => {
    const { service } = makeService();
    const { session } = await service.register({ email: 'i@j.ru', password: 'пароль-пароль', displayName: 'И', consent: true });
    const user = service.sessionUser(session.token);
    service.updateFavorites(user, { action: 'add', ids: ['doc-1', 42] });
    const merged = service.updateFavorites(user, { action: 'merge', ids: ['doc-1', 'doc-2'] }).favorites;
    assert.deepEqual([...merged].sort((a, b) => String(a).localeCompare(String(b))), [42, 'doc-1', 'doc-2']);
    assert.ok(merged.includes(42), 'число превратилось в строку');
    assert.deepEqual(service.updateFavorites(user, { action: 'remove', ids: [42] }).favorites.includes(42), false);
    assert.throws(() => service.updateFavorites(user, { action: 'add', ids: [{ evil: true }] }), (error) => error.code === 'bad_item');
    assert.throws(() => service.updateFavorites(user, { action: 'nuke', ids: [] }), (error) => error.code === 'bad_request');
  });

  it('потолок избранного', async () => {
    const { service } = makeService();
    const { session } = await service.register({ email: 'k@l.ru', password: 'пароль-пароль', displayName: 'К', consent: true });
    const user = service.sessionUser(session.token);
    service.updateFavorites(user, { action: 'add', ids: Array.from({ length: ACCOUNT_LIMITS.MAX_FAVORITES }, (_, index) => `d${index}`) });
    assert.throws(() => service.updateFavorites(user, { action: 'add', ids: ['one-more'] }), (error) => error.code === 'too_many');
  });

  it('id избранного кодируется без потерь и без управляющих символов', () => {
    assert.equal(decodeItemId(encodeItemId('demo-doc-x')), 'demo-doc-x');
    assert.equal(decodeItemId(encodeItemId(7)), 7);
    assert.equal(encodeItemId('a\u0000b'), null);
    assert.equal(encodeItemId('x'.repeat(161)), null);
    assert.equal(encodeItemId(-1), null);
    assert.equal(decodeItemId('{"a":1}'), null);
  });

  it('удаление аккаунта удаляет сессии и избранное', async () => {
    const { service, store } = makeService();
    const { session } = await service.register({ email: 'm@n.ru', password: 'пароль-пароль', displayName: 'М', consent: true });
    const user = service.sessionUser(session.token);
    service.updateFavorites(user, { action: 'add', ids: ['doc-1'] });
    service.deleteAccount(user);
    assert.equal(service.sessionUser(session.token), null);
    assert.equal(store.countFavorites(user.id), 0);
    assert.equal(store.countUsers(), 0);
  });
});

describe('Кабинет: демо-аккаунты', () => {
  it('у каждого браузера своя копия: с программой ДМС и избранным, без пароля', async () => {
    const { service, store } = makeService();
    const anna = service.demoLogin('anna');
    assert.equal(anna.user.dmsPlanId, 'demo-standard');
    assert.equal(anna.user.isDemo, true);
    assert.equal(anna.user.email, 'anna@medkarta.example');
    assert.ok(anna.favorites.length > 0);
    assert.match(anna.owner, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(DEMO_ACCOUNTS.every((account) => account.email.endsWith('@medkarta.example')));
    await rejects(service.login({ email: 'anna@medkarta.example', password: '' }), 'bad_credentials');
    await rejects(service.login({ email: 'anna@medkarta.example', password: 'любой-пароль' }), 'bad_credentials');
    assert.throws(() => service.demoLogin('root'), (error) => error.code === 'unknown_demo');
    assert.throws(() => service.demoLogin('__proto__'), (error) => error.code === 'unknown_demo');

    // Тот же браузер возвращается в ту же копию — с её изменениями.
    const annaUser = service.sessionUser(anna.session.token);
    service.updateProfile(annaUser, { dmsPlanId: 'demo-basic' });
    service.updateFavorites(annaUser, { action: 'remove', ids: anna.favorites });
    const again = service.demoLogin('anna', { owner: anna.owner });
    assert.equal(again.owner, anna.owner);
    assert.equal(again.user.dmsPlanId, 'demo-basic');
    assert.deepEqual(again.favorites, []);
    assert.equal(service.sessionUser(again.session.token).id, annaUser.id);

    // Другой браузер получает свою копию в исходном виде.
    const other = service.demoLogin('anna');
    assert.notEqual(other.owner, anna.owner);
    assert.equal(other.user.dmsPlanId, 'demo-standard');
    assert.notEqual(service.sessionUser(other.session.token).id, annaUser.id);

    // Другой демо-аккаунт того же браузера — отдельный кабинет.
    const family = service.demoLogin('family', { owner: anna.owner });
    assert.equal(family.user.dmsPlanId, 'demo-premium');
    assert.notEqual(service.sessionUser(family.session.token).id, annaUser.id);

    assert.throws(() => service.deleteAccount(annaUser), (error) => error.code === 'demo_account');
    assert.equal(store.countDemoCopies(), 3);
  });

  it('испорченный токен браузера заменяется новым; имя демо-аккаунта не меняется', () => {
    const { service } = makeService();
    const login = service.demoLogin('anna', { owner: 'x' });
    assert.match(login.owner, /^[A-Za-z0-9_-]{43}$/);
    const user = service.sessionUser(login.session.token);
    assert.throws(() => service.updateProfile(user, { displayName: 'Звоните +7 900 000-00-00' }), (error) => error.code === 'demo_account');
  });

  it('обновление базы удаляет прежние общие демо-аккаунты с их сессиями, остальных не трогает', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-accounts-')), 'medkarta.sqlite');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
        password_hash TEXT, dms_plan_id TEXT, demo_key TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE favorites (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (user_id, item_id));
      INSERT INTO users VALUES ('${'a'.repeat(32)}', 'anna@medkarta.example', 'Анна Демо', NULL, 'demo-standard', 'anna', 1, 1);
      INSERT INTO users VALUES ('${'b'.repeat(32)}', 'real@user.ru', 'Настоящий', 'scrypt$x', NULL, NULL, 1, 1);
      INSERT INTO sessions VALUES ('shared-session', '${'a'.repeat(32)}', 1, 9999999999999);
      INSERT INTO favorites VALUES ('${'a'.repeat(32)}', '"demo-doc-x"', 1);
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const store = createSqliteAccountStore({ DatabaseSync, file });
    assert.equal(store.getUserById('a'.repeat(32)), null);
    assert.equal(store.getSession('shared-session'), null);
    assert.deepEqual(store.listFavorites('a'.repeat(32)), []);
    assert.equal(store.getUserById('b'.repeat(32)).email, 'real@user.ru');
    store.close();
  });

  it('демо-сессия — 12 часов; копия, к которой не возвращались 30 дней, удаляется', () => {
    let clock = Date.parse('2026-10-08T10:00:00Z');
    const { service, store } = makeService({ now: () => clock });
    const first = service.demoLogin('family');
    clock += 12 * 60 * 60 * 1000 + 1;
    assert.equal(service.sessionUser(first.session.token), null);
    assert.equal(store.countDemoCopies(), 1);
    clock += ACCOUNT_LIMITS.DEMO_COPY_TTL_MS;
    service.purgeExpiredSessions();
    assert.equal(store.countDemoCopies(), 0);
    assert.equal(service.demoLogin('family', { owner: first.owner }).user.dmsPlanId, 'demo-premium');
  });
});

describe('Кабинет: HTTP', () => {
  let server;
  let base;
  let flags = { registration: false, demo: true };
  let service;

  before(async () => {
    ({ service } = makeService());
    const handler = createAccountHandler({
      getService: async () => service,
      onAccountDeleted: async () => {},
      authLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 1000, maxPerInstance: Number.POSITIVE_INFINITY }),
      apiLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 1000, maxPerInstance: Number.POSITIVE_INFINITY }),
      features: () => flags,
    });
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const call = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: base,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const cookieFrom = (response) => {
    const header = response.headers.get('set-cookie') || '';
    return { header, value: parseCookies(header.split(';')[0])[SESSION_COOKIE] };
  };

  it('гость: user = null и список возможностей', async () => {
    const response = await call('/api/account');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.user, null);
    assert.equal(payload.features.available, true);
    assert.equal(payload.features.registration, false);
    assert.equal(payload.features.demo, true);
    assert.deepEqual(payload.features.demoAccounts.map((item) => item.key), DEMO_ACCOUNTS.map((item) => item.key));
    assert.ok(payload.features.demoAccounts.every((item) => !('email' in item)), 'email демо-аккаунтов не нужен интерфейсу');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('демо-вход ставит cookie HttpOnly; SameSite=Lax; Path=/api, и кабинет её узнаёт', async () => {
    const response = await call('/api/auth/demo', { method: 'POST', body: { account: 'family' } });
    assert.equal(response.status, 200);
    const { header, value } = cookieFrom(response);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\/api/);
    assert.ok(value && value.length >= 40);
    const me = await (await call('/api/account', { cookie: `${SESSION_COOKIE}=${value}` })).json();
    assert.equal(me.user.displayName, 'Семья Демо');
    assert.equal(me.user.dmsPlanId, 'demo-premium');
    assert.equal(JSON.stringify(me).includes('passwordHash'), false);
  });

  it('смена программы ДМС и избранное', async () => {
    const { value } = cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'basic' } }));
    const cookie = `${SESSION_COOKIE}=${value}`;
    const patched = await (await call('/api/account', { method: 'PATCH', body: { dmsPlanId: 'demo-standard' }, cookie })).json();
    assert.equal(patched.user.dmsPlanId, 'demo-standard');
    const favorites = await (await call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['demo-doc-x'] }, cookie })).json();
    assert.deepEqual(favorites.favorites, ['demo-doc-x']);
    const bad = await call('/api/account', { method: 'PATCH', body: { dmsPlanId: 'evil' }, cookie });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'unknown_plan');
  });

  it('без входа изменения запрещены', async () => {
    assert.equal((await call('/api/account', { method: 'PATCH', body: { dmsPlanId: null } })).status, 401);
    assert.equal((await call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] } })).status, 401);
    assert.equal((await call('/api/account', { method: 'PATCH', body: {}, cookie: `${SESSION_COOKIE}=${'x'.repeat(43)}` })).status, 401);
  });

  it('подделка запроса с чужого сайта не проходит', async () => {
    const { value } = cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'anna' } }));
    const cookie = `${SESSION_COOKIE}=${value}`;
    const evilOrigin = await call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] }, cookie, headers: { origin: 'https://evil.example' } });
    assert.equal(evilOrigin.status, 403);
    const crossSite = await call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] }, cookie, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const formPost = await fetch(`${base}/api/account/favorites`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: base, cookie },
      body: JSON.stringify({ action: 'add', ids: ['x'] }),
    });
    assert.equal(formPost.status, 403, 'простой запрос без JSON (форма с чужого сайта) принят');
  });

  it('регистрация закрыта по умолчанию и открывается флагом', async () => {
    const body = { email: 'new@user.ru', password: 'пароль-пароль', displayName: 'Новый', consent: true };
    assert.equal((await call('/api/auth/register', { method: 'POST', body })).status, 403);
    flags = { registration: true, demo: true };
    const created = await call('/api/auth/register', { method: 'POST', body });
    assert.equal(created.status, 201);
    assert.ok(cookieFrom(created).value);
    const login = await call('/api/auth/login', { method: 'POST', body: { email: 'NEW@user.ru', password: 'пароль-пароль' } });
    assert.equal(login.status, 200);
    const wrong = await call('/api/auth/login', { method: 'POST', body: { email: 'new@user.ru', password: 'неверный-пароль' } });
    assert.equal(wrong.status, 401);
    assert.equal(cookieFrom(wrong).value, undefined);
    flags = { registration: false, demo: true };
  });

  it('выход стирает cookie и сессию', async () => {
    const { value } = cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'kids' } }));
    const cookie = `${SESSION_COOKIE}=${value}`;
    const out = await call('/api/auth/logout', { method: 'POST', body: {}, cookie });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await (await call('/api/account', { cookie })).json()).user, null);
  });

  it('удаление аккаунта требует подтверждения; демо-аккаунт не удаляется', async () => {
    flags = { registration: true, demo: true };
    const created = await call('/api/auth/register', { method: 'POST', body: { email: 'bye@user.ru', password: 'пароль-пароль', displayName: 'Пока', consent: true } });
    const cookie = `${SESSION_COOKIE}=${cookieFrom(created).value}`;
    assert.equal((await call('/api/account', { method: 'DELETE', body: {}, cookie })).status, 400);
    assert.equal((await call('/api/account', { method: 'DELETE', body: { confirm: true }, cookie })).status, 200);
    assert.equal((await (await call('/api/account', { cookie })).json()).user, null);
    const demo = `${SESSION_COOKIE}=${cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'anna' } })).value}`;
    assert.equal((await call('/api/account', { method: 'DELETE', body: { confirm: true }, cookie: demo })).status, 403);
    flags = { registration: false, demo: true };
  });

  it('демо выключено — демо-вход закрыт', async () => {
    flags = { registration: false, demo: false };
    assert.equal((await call('/api/auth/demo', { method: 'POST', body: { account: 'anna' } })).status, 403);
    flags = { registration: false, demo: true };
  });

  it('слияние 500 записей избранного укладывается в лимит тела', async () => {
    const { value } = cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'basic' } }));
    const ids = Array.from({ length: 500 }, (_, index) => `verified-doctor-kazan-polyclinic-${String(index).padStart(5, '0')}`);
    const response = await call('/api/account/favorites', { method: 'POST', body: { action: 'merge', ids }, cookie: `${SESSION_COOKIE}=${value}` });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).favorites.length, 500);
  });

  it('неверный метод, большое тело, не объект', async () => {
    assert.equal((await call('/api/auth/login')).status, 405);
    const big = await call('/api/auth/login', { method: 'POST', body: { email: 'x'.repeat(70_000) } });
    assert.equal(big.status, 413);
    assert.equal((await call('/api/auth/login', { method: 'POST', body: [1, 2] })).status, 400);
  });

  it('подбор пароля упирается в лимит', async () => {
    const handler = createAccountHandler({
      getService: async () => service,
      authLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 3, maxPerInstance: Number.POSITIVE_INFINITY }),
      features: () => flags,
    });
    const limited = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${limited.address().port}/api/auth/login`;
    const statuses = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.ru', password: `guess-${index}-xx` }) });
      statuses.push(response.status);
    }
    limited.close();
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });

  it('в dev-режиме Vite путь берётся из originalUrl', async () => {
    const handler = createAccountHandler({ getService: async () => service, features: () => flags });
    const mounted = http.createServer((req, res) => {
      // Как connect: подключение на /api/account отрезает префикс.
      req.originalUrl = req.url;
      req.url = req.url.replace(/^\/api\/account/, '') || '/';
      return handler(req, res);
    });
    await new Promise((resolve) => mounted.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${mounted.address().port}/api/account`);
    mounted.close();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user, null);
  });

  it('перебор пароля одного аккаунта упирается в счётчик ошибок по email', async () => {
    flags = { registration: true, demo: true };
    await call('/api/auth/register', { method: 'POST', body: { email: 'target@user.ru', password: 'верный-пароль-1', displayName: 'Цель', consent: true } });
    flags = { registration: false, demo: true };
    const handler = createAccountHandler({
      getService: async () => service,
      authLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 1000, maxPerInstance: Number.POSITIVE_INFINITY }),
      failures: createFailureCounter({ max: 3 }),
      features: () => flags,
    });
    const guarded = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => guarded.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${guarded.address().port}/api/auth/login`;
    const attempt = (password) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'TARGET@user.ru', password }) });
    const statuses = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await attempt(`guess-${index}-xx`)).status);
    statuses.push((await attempt('верный-пароль-1')).status);
    guarded.close();
    assert.deepEqual(statuses, [401, 401, 401, 429, 429], 'после трёх ошибок даже верный пароль ждёт паузы');
  });

  it('cookie Secure: в продакшене всегда, по X-Forwarded-Proto — только от своего прокси', async () => {
    const saved = { NODE_ENV: process.env.NODE_ENV, TRUST_PROXY: process.env.TRUST_PROXY, TRUSTED_PROXIES: process.env.TRUSTED_PROXIES };
    const secureFlag = async () => /;\s*Secure/.test(cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'anna' }, headers: { 'x-forwarded-proto': 'https' } })).header);
    try {
      delete process.env.NODE_ENV;
      process.env.TRUST_PROXY = '1';
      process.env.TRUSTED_PROXIES = '10.0.0.1';
      assert.equal(await secureFlag(), false, 'заголовок от чужого адреса принят');
      delete process.env.TRUSTED_PROXIES;
      assert.equal(await secureFlag(), true, 'запрос от локального nginx с HTTPS — Secure');
      process.env.TRUST_PROXY = '0';
      process.env.NODE_ENV = 'production';
      assert.equal(await secureFlag(), true, 'в продакшене Secure всегда');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('кабинет недоступен — сайт работает, кабинет честно говорит об этом', async () => {
    const handler = createAccountHandler({ getService: async () => null, features: () => flags });
    const off = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => off.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${off.address().port}`;
    const me = await (await fetch(`${url}/api/account`)).json();
    assert.equal(me.features.available, false);
    const login = await fetch(`${url}/api/auth/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"account":"anna"}' });
    off.close();
    assert.equal(login.status, 503);
  });
});
