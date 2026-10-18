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

import { randomBytes } from 'node:crypto';

import { generateTemporaryPassword, hashPassword, needsRehash, PasswordBusyError, passwordProblem, verifyPassword } from '../backend/accounts/passwords.js';
import { ACCOUNT_LIMITS, AccountError, createAccountService, decodeItemId, DEMO_ACCOUNTS, encodeItemId } from '../backend/accounts/service.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountHandler, createFailureCounter, parseCookies, SESSION_COOKIE } from '../backend/api/account.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';

const DatabaseSync = await loadSqlite();
const DAY_MS = 24 * 60 * 60 * 1000;
// PNG 16×16 с текстовым фрагментом «SECRET-COMMENT»: он должен быть вырезан.
const PNG_WITH_TEXT = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFnRFWHRDb21tZW50AFNFQ1JFVC1DT01NRU5UsD4XwwAAABZJREFUeNpjOGFkRBJiGNUwqmH4agAAFAQsEONjdYwAAAAASUVORK5CYII=';
const PLANS = new Set(['demo-basic', 'demo-standard', 'demo-premium']);

const makeService = ({ now = () => Date.now() } = {}) => {
  const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
  return { store, service: createAccountService({ store, isKnownPlan: (id) => PLANS.has(id), now }) };
};

// Хэш одного пароля считается один раз (~0,3 с): пользователи в тестах создаются десятками.
const hashCache = new Map();
const cachedHash = async (password) => {
  if (!hashCache.has(password)) hashCache.set(password, await hashPassword(password));
  return hashCache.get(password);
};

/** Пользователь, как его создал бы администратор (без временного пароля). */
const addUser = async (store, { email, password = 'пароль-пароль', role = 'user', firstName = 'Тест', lastName = 'Тестов', mustChangePassword = false } = {}) =>
  store.createUser({ id: randomBytes(16).toString('hex'), email, firstName, lastName, role, mustChangePassword, passwordHash: await cachedHash(password), now: Date.now() });

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
    assert.match(first, /^scrypt\$32768\$8\$3\$[\w-]+\$[\w-]+$/);
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

  it('старые параметры пересчитываются при входе; временный пароль читаемый и стойкий', async () => {
    assert.equal(needsRehash('scrypt$16384$8$1$c2FsdA$aGFzaA'), true);
    assert.equal(needsRehash(await cachedHash('пароль-пароль')), false);
    const temporary = generateTemporaryPassword();
    assert.match(temporary, /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){4}$/);
    assert.notEqual(temporary, generateTemporaryPassword());
    assert.equal(passwordProblem(temporary), '');
  });

  it('правила пароля', () => {
    assert.match(passwordProblem('Password'), /распространён/);
    assert.match(passwordProblem('ffffffffff'), /повторяющегося/);
    assert.match(passwordProblem('short'), /не короче 8/);
    assert.match(passwordProblem('12345678'), /только из цифр/);
    assert.equal(passwordProblem('нормальный-пароль'), '');
    assert.match(passwordProblem(undefined), /Введите/);
    assert.match(passwordProblem('maksim-2026-pass', { email: 'maksim@bk.ru' }), /email/);
  });
});

describe('Кабинет: аккаунт и сессии', () => {
  it('вход, выход; в браузер не уходит хэш пароля', async () => {
    const { service, store } = makeService();
    await addUser(store, { email: 'maksim@example.ru', firstName: 'Максим', lastName: '' });
    const loggedIn = await service.login({ email: '  MAKSIM@example.RU ', password: 'пароль-пароль' }, { client: 'Chrome 129 · macOS', ipPrefix: '203.0.113.0/24' });
    assert.equal(loggedIn.user.email, 'maksim@example.ru');
    assert.equal(loggedIn.user.displayName, 'Максим');
    assert.equal(loggedIn.user.role, 'user');
    assert.equal('passwordHash' in loggedIn.user, false, 'хэш пароля ушёл бы в браузер');
    assert.ok(loggedIn.user.lastLoginAt);
    const second = await service.login({ email: 'maksim@example.ru', password: 'пароль-пароль' });
    assert.notEqual(second.session.token, loggedIn.session.token, 'каждый вход — новый токен');
    assert.ok(service.sessionUser(loggedIn.session.token));
    service.logout(loggedIn.session.token);
    assert.equal(service.sessionUser(loggedIn.session.token), null);
    assert.ok(service.sessionUser(second.session.token), 'выход из одного браузера не выкидывает из другого');
    const events = store.listAuthEvents({ userId: loggedIn.user.id }).rows.map((event) => event.type);
    assert.deepEqual(events.sort(), ['login_ok', 'login_ok', 'logout']);
  });

  it('неверный пароль и несуществующий email — один и тот же ответ; ошибки учитываются', async () => {
    const { service, store } = makeService();
    const user = await addUser(store, { email: 'a@b.ru' });
    await rejects(service.login({ email: 'a@b.ru', password: 'не тот пароль' }), 'bad_credentials');
    await rejects(service.login({ email: 'nobody@b.ru', password: 'пароль-пароль' }), 'bad_credentials');
    await rejects(service.login({ email: 42, password: null }), 'bad_credentials');
    await rejects(service.login({ email: "a@b.ru' OR '1'='1", password: "' OR '1'='1" }), 'bad_credentials');
    assert.equal(store.getUserById(user.id).failedLogins, 1);
    const failed = store.listAuthEvents({ types: ['login_failed'] }).rows;
    assert.equal(failed.length, 4);
    assert.equal(failed.filter((event) => event.userId === user.id).length, 1);
    assert.ok(failed.every((event) => !JSON.stringify(event).includes('nobody')), 'чужой email в журнал не пишется');
    await service.login({ email: 'a@b.ru', password: 'пароль-пароль' });
    assert.equal(store.getUserById(user.id).failedLogins, 0);
  });

  it('публичной регистрации нет', () => {
    const { service } = makeService();
    assert.equal(typeof service.register, 'undefined');
  });

  it('сессия продлевается активностью, но живёт не дольше предельного срока', async () => {
    let clock = Date.parse('2026-10-08T10:00:00Z');
    const { service, store } = makeService({ now: () => clock });
    await addUser(store, { email: 'c@d.ru' });
    const { session } = await service.login({ email: 'c@d.ru', password: 'пароль-пароль' });
    // Без активности 14 дней — сессия истекла.
    clock += 14 * DAY_MS + 1000;
    assert.equal(service.sessionUser(session.token), null);
    // С активностью раз в 10 дней — живёт до предела в 30 дней.
    const active = (await service.login({ email: 'c@d.ru', password: 'пароль-пароль' })).session;
    for (let day = 10; day < 30; day += 10) {
      clock += 10 * DAY_MS;
      assert.ok(service.sessionUser(active.token), `день ${day}`);
    }
    clock += 10 * DAY_MS;
    assert.equal(service.sessionUser(active.token), null, 'предельный срок 30 дней');
  });

  it('не больше 10 одновременных входов — старые вытесняются', async () => {
    const { service, store } = makeService();
    await addUser(store, { email: 'e@f.ru' });
    const tokens = [];
    for (let index = 0; index <= 10; index += 1) {
      tokens.push((await service.login({ email: 'e@f.ru', password: 'пароль-пароль' })).session.token);
    }
    assert.equal(service.sessionUser(tokens[0]), null);
    assert.ok(service.sessionUser(tokens.at(-1)));
  });

  it('мусорный токен не падает', () => {
    const { service } = makeService();
    for (const token of [undefined, '', 'x', 'a'.repeat(500), '../../etc', "' OR 1=1 --".padEnd(40, 'x')]) assert.equal(service.sessionUser(token), null);
  });

  it('смена пароля: нужен текущий, все прежние сессии завершаются, выдаётся новая', async () => {
    const { service, store } = makeService();
    await addUser(store, { email: 'p@q.ru', mustChangePassword: true });
    const first = await service.login({ email: 'p@q.ru', password: 'пароль-пароль' });
    assert.equal(first.user.mustChangePassword, true);
    const other = await service.login({ email: 'p@q.ru', password: 'пароль-пароль' });
    const user = service.sessionUser(first.session.token);
    await rejects(service.changePassword(user, { currentPassword: 'неверный-пароль', newPassword: 'новый-пароль-2026' }), 'bad_password');
    await rejects(service.changePassword(user, { currentPassword: 'пароль-пароль', newPassword: '123' }), 'weak_password');
    await rejects(service.changePassword(user, { currentPassword: 'пароль-пароль', newPassword: 'пароль-пароль' }), 'weak_password');
    const changed = await service.changePassword(user, { currentPassword: 'пароль-пароль', newPassword: 'новый-пароль-2026' });
    assert.equal(changed.user.mustChangePassword, false);
    assert.equal(service.sessionUser(first.session.token), null, 'текущая сессия заменена новой');
    assert.equal(service.sessionUser(other.session.token), null, 'другие сессии завершены');
    assert.ok(service.sessionUser(changed.session.token));
    await rejects(service.login({ email: 'p@q.ru', password: 'пароль-пароль' }), 'bad_credentials');
    assert.ok(await service.login({ email: 'p@q.ru', password: 'новый-пароль-2026' }));
  });

  it('свои сессии: список, завершение одной и всех остальных', async () => {
    const { service, store } = makeService();
    await addUser(store, { email: 's@t.ru' });
    const a = await service.login({ email: 's@t.ru', password: 'пароль-пароль' }, { client: 'Chrome 129 · macOS', ipPrefix: '198.51.100.0/24' });
    const b = await service.login({ email: 's@t.ru', password: 'пароль-пароль' }, { client: 'Safari · iOS (мобильный)' });
    const c = await service.login({ email: 's@t.ru', password: 'пароль-пароль' });
    const auth = service.authenticate(a.session.token);
    const list = service.listOwnSessions(auth.user, auth.session.tokenHash);
    assert.equal(list.length, 3);
    assert.equal(list.filter((item) => item.current).length, 1);
    assert.ok(list.every((item) => /^[a-f0-9]{24}$/.test(item.id) && !('tokenHash' in item)));
    service.revokeOwnSession(auth.user, b.session.publicId);
    assert.equal(service.sessionUser(b.session.token), null);
    assert.throws(() => service.revokeOwnSession(auth.user, 'f'.repeat(24)), (error) => error.code === 'not_found');
    assert.equal(service.revokeOtherSessions(auth.user, auth.session.tokenHash).revoked, 1);
    assert.equal(service.sessionUser(c.session.token), null);
    assert.ok(service.sessionUser(a.session.token));
  });

  it('аватар: только очищенная картинка; SVG и мусор отклоняются', async () => {
    const { service, store } = makeService();
    await addUser(store, { email: 'v@w.ru' });
    const { session } = await service.login({ email: 'v@w.ru', password: 'пароль-пароль' });
    const user = service.sessionUser(session.token);
    const result = service.setAvatar(user, `data:image/png;base64,${PNG_WITH_TEXT}`);
    assert.match(result.user.avatarUrl, /^\/api\/me\/avatar\?v=[a-f0-9]{16}$/);
    const stored = service.getAvatar(user.id);
    assert.equal(stored.mime, 'image/png');
    assert.equal(stored.data.includes('SECRET-COMMENT'), false, 'метаданные PNG вырезаны');
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', 'data:image/png;base64,AAAA', 'не картинка', `data:image/png;base64,${'A'.repeat(400_000)}`]) {
      assert.throws(() => service.setAvatar(user, bad), (error) => error.code === 'bad_image', bad.slice(0, 30));
    }
    assert.equal(service.deleteAvatar(user).user.avatarUrl, null);
  });
});

describe('Кабинет: программа ДМС и избранное', () => {
  const signedIn = async (email) => {
    const { service, store } = makeService();
    await addUser(store, { email });
    const { session } = await service.login({ email, password: 'пароль-пароль' });
    return { service, store, user: service.sessionUser(session.token) };
  };

  it('программа — только из справочника', async () => {
    const { service, user } = await signedIn('g@h.ru');
    assert.equal(service.updateProfile(user, { dmsPlanId: 'demo-standard' }).user.dmsPlanId, 'demo-standard');
    assert.equal(service.updateProfile(user, { dmsPlanId: null }).user.dmsPlanId, null);
    assert.throws(() => service.updateProfile(user, { dmsPlanId: 'no-such-plan' }), (error) => error.code === 'unknown_plan');
    assert.throws(() => service.updateProfile(user, { dmsPlanId: "x'; DROP TABLE users;--" }), (error) => error.code === 'unknown_plan');
  });

  it('имя и фамилия: буквы, пробел, дефис — без разметки', async () => {
    const { service, user } = await signedIn('name@h.ru');
    const updated = service.updateProfile(user, { firstName: ' Анна-Мария ', lastName: "Д'Артаньян" }).user;
    assert.equal(updated.firstName, 'Анна-Мария');
    assert.equal(updated.lastName, "Д'Артаньян");
    assert.equal(updated.displayName, "Анна-Мария Д'Артаньян");
    for (const bad of ['<script>', '', '\u200b', '1234']) {
      assert.throws(() => service.updateProfile(user, { firstName: bad }), (error) => error.code === 'bad_name', bad);
    }
  });

  it('избранное: строки и числа возвращаются как были, повторы не дублируются', async () => {
    const { service, user } = await signedIn('i@j.ru');
    service.updateFavorites(user, { action: 'add', ids: ['doc-1', 42] });
    const merged = service.updateFavorites(user, { action: 'merge', ids: ['doc-1', 'doc-2'] }).favorites;
    assert.deepEqual([...merged].sort((a, b) => String(a).localeCompare(String(b))), [42, 'doc-1', 'doc-2']);
    assert.ok(merged.includes(42), 'число превратилось в строку');
    assert.deepEqual(service.updateFavorites(user, { action: 'remove', ids: [42] }).favorites.includes(42), false);
    assert.throws(() => service.updateFavorites(user, { action: 'add', ids: [{ evil: true }] }), (error) => error.code === 'bad_item');
    assert.throws(() => service.updateFavorites(user, { action: 'nuke', ids: [] }), (error) => error.code === 'bad_request');
  });

  it('потолок избранного', async () => {
    const { service, user } = await signedIn('k@l.ru');
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

  it('удаление своего аккаунта удаляет сессии, избранное и историю входов', async () => {
    const { service, store, user } = await signedIn('m@n.ru');
    service.updateFavorites(user, { action: 'add', ids: ['doc-1'] });
    service.deleteAccount(user);
    assert.equal(store.countFavorites(user.id), 0);
    assert.equal(store.countUsers(), 0);
    assert.equal(store.listAuthEvents({ userId: user.id }).total, 0);
  });

  it('сотрудник не удаляет свой аккаунт сам', async () => {
    const { service, store } = makeService();
    await addUser(store, { email: 'boss@n.ru', role: 'superadmin' });
    const { session } = await service.login({ email: 'boss@n.ru', password: 'пароль-пароль' });
    assert.throws(() => service.deleteAccount(service.sessionUser(session.token)), (error) => error.code === 'staff_account');
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
  let store;

  before(async () => {
    ({ service, store } = makeService());
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

  it('регистрации нет; вход по email и паролю ставит cookie, ошибка — нет', async () => {
    const body = { email: 'new@user.ru', password: 'пароль-пароль', displayName: 'Новый', consent: true };
    assert.equal((await call('/api/auth/register', { method: 'POST', body })).status, 404);
    await addUser(store, { email: 'new@user.ru' });
    const login = await call('/api/auth/login', { method: 'POST', body: { email: 'NEW@user.ru', password: 'пароль-пароль' } });
    assert.equal(login.status, 200);
    assert.ok(cookieFrom(login).value);
    assert.equal((await login.json()).user.role, 'user');
    const wrong = await call('/api/auth/login', { method: 'POST', body: { email: 'new@user.ru', password: 'неверный-пароль' } });
    assert.equal(wrong.status, 401);
    assert.equal(cookieFrom(wrong).value, undefined);
    const nobody = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@user.ru', password: 'неверный-пароль' } });
    assert.equal(nobody.status, 401);
    assert.deepEqual(await nobody.json(), await wrong.json(), 'ответ не выдаёт, есть ли такой email');
  });

  it('выход стирает cookie и сессию', async () => {
    const { value } = cookieFrom(await call('/api/auth/demo', { method: 'POST', body: { account: 'kids' } }));
    const cookie = `${SESSION_COOKIE}=${value}`;
    const out = await call('/api/auth/logout', { method: 'POST', body: {}, cookie });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await (await call('/api/account', { cookie })).json()).user, null);
  });

  it('удаление аккаунта требует подтверждения; демо-аккаунт не удаляется', async () => {
    await addUser(store, { email: 'bye@user.ru' });
    const created = await call('/api/auth/login', { method: 'POST', body: { email: 'bye@user.ru', password: 'пароль-пароль' } });
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
    await addUser(store, { email: 'target@user.ru', password: 'верный-пароль-1' });
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
