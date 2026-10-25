/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Аккаунты, роли и админ-панель через настоящий HTTP: вход, блокировки,
 * роли, приглашения вместо временных паролей, сессии, аудит, настройки, CSRF, лимиты,
 * инъекции и сохранность данных после перезапуска. База — SQLite в памяти
 * (и в файле — для перезапуска).
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createAdminService } from '../backend/accounts/adminService.js';
import { bootstrapSuperadmin, createTestUsers, TEST_USERS } from '../backend/accounts/bootstrap.js';
import { createDelivery } from '../backend/accounts/delivery.js';
import { checkRolePermissions, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from '../backend/accounts/rbac.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { SESSION_COOKIE } from '../backend/api/accountHttp.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';
import { acceptLink as acceptLinkBase, browserFor, softAuthenticator, startAuthServer, tokenOfLink } from './helpers/authKit.js';

const DatabaseSync = await loadSqlite();
const ROOT_PASSWORD = 'Корневой-пароль-2026';
const PLANS = new Set(['demo-basic', 'demo-standard', 'demo-premium']);
// Почта не настроена (ссылки передаются вручную); ключи доступа — для https://medkarta.test.
const ENV = { PUBLIC_BASE_URL: 'https://medkarta.test' };

/** Контекст кабинета для тестов: без почты, свой ключ MFA, без проверки по базе утечек. */
const makeContext = ({ store, mfaKey = randomBytes(32), now }) => createAccountContext({
  store, delivery: createDelivery({ env: {} }), env: ENV, mfaKey, breachCheck: async () => ({ breached: false }),
  isKnownPlan: (id) => PLANS.has(id), onAccountDeleted: async () => {}, systemInfo: async () => null, ...(now ? { now } : {}),
});

const startServer = (context, options = {}) => startAuthServer(context, options);
const acceptLink = acceptLinkBase;

describe('Права: матрица и правила', () => {
  it('superadmin — все разрешения; у user — ни одного; зависимости проверяются', () => {
    assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.superadmin, PERMISSION_KEYS);
    assert.deepEqual(DEFAULT_ROLE_PERMISSIONS.user, []);
    for (const role of ['admin', 'moderator']) {
      assert.deepEqual(checkRolePermissions(role, DEFAULT_ROLE_PERMISSIONS[role]).errors, [], role);
    }
    assert.match(checkRolePermissions('admin', ['admin.access', 'users.delete']).errors.join(' '), /требует/);
    assert.match(checkRolePermissions('admin', ['admin.access', 'settings.edit', 'settings.view']).errors.join(' '), /только суперадминистратору/);
    assert.match(checkRolePermissions('moderator', ['users.view']).errors.join(' '), /без/);
    assert.match(checkRolePermissions('user', ['admin.access']).errors.join(' '), /Пользователь/);
    assert.match(checkRolePermissions('moderator', ['admin.access', 'audit.view'], { otherRoles: { admin: ['admin.access'] } }).warnings.join(' '), /нет у/);
  });
});

describe('Админ-панель: сценарии', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let context;
  let server;
  let base;
  let root;
  const links = {};
  // Ключи доступа сотрудников: без второго фактора админ-панель не открывается.
  const keys = new Map();

  before(async () => {
    context = makeContext({ store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }) });
    await bootstrapSuperadmin({ store: context.store, email: 'root@medkarta.test', firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startServer(context));
    for (const item of await createTestUsers({ store: context.store, invitations: context.invitations, base })) links[item.email] = item.link;
    root = browserFor(base);
    assert.equal((await root.login('root@medkarta.test', ROOT_PASSWORD)).status, 200);
    keys.set('root@medkarta.test', softAuthenticator());
    await root.enrollPasskey(keys.get('root@medkarta.test'));
  });

  after(() => server?.close());

  const findId = async (email) => (await root.call(`/api/admin/users?q=${encodeURIComponent(email)}`)).body.items[0].id;

  /** Создать пользователя от имени root и активировать его по приглашению. */
  const createActive = async ({ email, role = 'user', firstName = 'Тест', lastName = 'Тестов', password = 'Постоянный-пароль-1' }) => {
    const created = await root.call('/api/admin/users', { method: 'POST', body: { email, firstName, lastName, role } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { tab } = await acceptLink(base, created.body.link, password);
    if (role !== 'user') {
      // Сотрудник сразу добавляет ключ доступа (первые 15 минут после входа — без повторного пароля).
      keys.set(email, softAuthenticator());
      await tab.enrollPasskey(keys.get(email));
    }
    return { tab, id: created.body.user.id, password };
  };

  /** Вход сотрудника в новом браузере: пароль и ключ доступа. */
  const staffSignIn = async (email, password) => {
    const tab = browserFor(base);
    const result = await tab.signIn(email, password, keys.get(email));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return tab;
  };

  it('bootstrap идемпотентен: повтор не меняет пароль и не создаёт дубль', async () => {
    const again = await bootstrapSuperadmin({ store: context.store, email: 'root@medkarta.test', password: 'совсем-другой-пароль-1' });
    assert.equal(again.status, 'exists');
    const list = await root.call('/api/admin/users?q=root@medkarta.test');
    assert.equal(list.body.total, 1);
    assert.equal((await browserFor(base).login('root@medkarta.test', 'совсем-другой-пароль-1')).status, 401);
    const me = await root.call('/api/admin/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'superadmin');
    assert.equal(me.body.user.displayName, 'Максим');
    assert.deepEqual(me.body.permissions, PERMISSION_KEYS);
  });

  it('три тестовых пользователя: без паролей, «ожидают активации», у каждого своё приглашение', async () => {
    const list = await root.call('/api/admin/users?q=medkarta.test&role=user&sort=email&dir=asc');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((user) => user.email), [...TEST_USERS.map((user) => user.email)].sort());
    assert.ok(list.body.items.every((user) => user.role === 'user' && user.status === 'active' && user.pending && !user.mustChangePassword && /^[a-f0-9]{32}$/.test(user.id)));
    assert.equal(new Set(list.body.items.map((user) => user.lastName)).size, 3);
    const tokens = Object.values(links).map(tokenOfLink);
    assert.ok(tokens.every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)));
    assert.equal(new Set(tokens).size, 3);
    assert.equal((await root.call('/api/admin/users?status=pending&q=medkarta.test')).body.total >= 3, true);
  });

  it('вход: успех, неверный пароль, несуществующий email, неактивированный — без раскрытия, есть ли аккаунт', async () => {
    const tab = browserFor(base);
    const pending = await tab.login('anna.smirnova@medkarta.test', 'неверный-пароль-1');
    const missing = await tab.login('nobody@medkarta.test', 'неверный-пароль-1');
    assert.equal(pending.status, 401);
    assert.equal(missing.status, 401);
    assert.deepEqual(pending.body, missing.body, 'аккаунт без пароля отвечает так же, как несуществующий');
    await acceptLink(base, links['anna.smirnova@medkarta.test'], 'Анна-свой-пароль-1');
    const wrong = await tab.login('anna.smirnova@medkarta.test', 'неверный-пароль-1');
    assert.deepEqual(wrong.body, missing.body);
    const ok = await tab.login('Anna.Smirnova@medkarta.test', 'Анна-свой-пароль-1');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.mustChangePassword, false);
    assert.equal(ok.body.user.firstName, 'Анна');
    assert.ok(tab.jar.get(SESSION_COOKIE));
    assert.equal(JSON.stringify(ok.body).includes('passwordHash'), false);
  });

  it('аккаунт со старым временным паролем (до схемы 4): вход работает, до смены — только профиль и смена пароля', async () => {
    const tab = browserFor(base);
    const temporary = 'Abcd-Efgh-Jkmn-Pqrs-Tuvw';
    const { hashPassword } = await import('../backend/accounts/passwords.js');
    context.store.createUser({ id: 'f'.repeat(32), email: 'legacy@medkarta.test', firstName: 'Тимур', lastName: 'Старый', passwordHash: await hashPassword(temporary), mustChangePassword: true, now: Date.now() });
    assert.equal((await tab.login('legacy@medkarta.test', temporary)).body.user.mustChangePassword, true);
    assert.equal((await tab.call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] } })).body.code, 'password_change_required');
    assert.equal((await tab.call('/api/chat', { method: 'POST', body: { messages: [] } })).body.code, 'password_change_required');
    assert.equal((await tab.call('/api/me/sessions')).body.code, 'password_change_required');
    assert.equal((await tab.call('/api/me')).status, 200);
    const changed = await tab.call('/api/me/password', { method: 'POST', body: { currentPassword: temporary, newPassword: 'Тимур-новый-пароль-1' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.user.mustChangePassword, false);
    assert.equal((await tab.call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] } })).status, 200);
    assert.equal((await tab.call('/api/chat', { method: 'POST', body: { messages: [] } })).status, 200);
  });

  it('создание пользователя: без пароля, ссылка — один раз и только создателю, дубль email — 409', async () => {
    const created = await root.call('/api/admin/users', { method: 'POST', body: { email: 'New.User@Medkarta.test', firstName: 'Новый', lastName: 'Пользователь', role: 'user' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, 'new.user@medkarta.test');
    assert.equal(created.body.user.pending, true);
    assert.equal(created.body.temporaryPassword, undefined, 'временных паролей нет');
    assert.equal(created.body.invitation.delivery, 'manual', 'почта не настроена — ссылку передают вручную');
    assert.equal(created.body.invitation.state, 'active');
    const token = tokenOfLink(created.body.link);
    assert.match(created.body.link, /\/activate#token=[A-Za-z0-9_-]{43}$/);
    const card = await root.call(`/api/admin/users/${created.body.user.id}`);
    const invitations = await root.call(`/api/admin/users/${created.body.user.id}/invitations`);
    const audit = await root.call(`/api/admin/audit?targetId=${created.body.user.id}`);
    for (const response of [card, invitations, audit]) assert.equal(response.text.includes(token), false, 'токен больше нигде не показывается');
    assert.equal(invitations.body.items.length, 1);
    assert.deepEqual(audit.body.items.map((item) => item.action).sort(), ['user.create', 'user.invite']);
    const duplicate = await root.call('/api/admin/users', { method: 'POST', body: { email: 'new.user@medkarta.test', firstName: 'Дубль', lastName: 'Дублев' } });
    assert.equal(duplicate.status, 409);
    const { tab } = await acceptLink(base, created.body.link, 'Новый-пароль-навсегда');
    assert.equal((await tab.call('/api/me')).body.user.email, 'new.user@medkarta.test');
    assert.equal((await root.call(`/api/admin/users/${created.body.user.id}`)).body.user.pending, false);
  });

  it('без прав нельзя ни создать пользователя, ни открыть админ-панель', async () => {
    const { tab } = await createActive({ email: 'plain@medkarta.test' });
    assert.equal((await tab.call('/api/admin/me')).status, 403);
    assert.equal((await tab.call('/api/admin/users', { method: 'POST', body: { email: 'x@medkarta.test', firstName: 'Икс', lastName: 'Иксов' } })).status, 403);
    assert.equal((await tab.call('/api/admin/users')).status, 403);
    const guest = browserFor(base);
    assert.equal((await guest.call('/api/admin/users')).status, 401);
    const moderator = await createActive({ email: 'moder@medkarta.test', role: 'moderator' });
    assert.equal((await moderator.tab.call('/api/admin/users')).status, 200, 'модератор видит пользователей');
    const denied = await moderator.tab.call('/api/admin/users', { method: 'POST', body: { email: 'y@medkarta.test', firstName: 'Игрек', lastName: 'Игреков' } });
    assert.equal(denied.status, 403);
    assert.equal((await moderator.tab.call('/api/admin/settings')).status, 403);
    assert.equal((await moderator.tab.call('/api/admin/audit')).status, 403);
    const audit = await root.call('/api/admin/audit?result=denied&action=user.create');
    assert.ok(audit.body.items.some((item) => item.actor.startsWith('Тест') && item.result === 'denied'), 'отказ записан в журнал');
  });

  it('изменение роли и запрет повышать себя', async () => {
    const admin = await createActive({ email: 'admin@medkarta.test', role: 'admin' });
    const userId = await findId('elena.kovaleva@medkarta.test');
    // Супер — может назначить модератора; админ — модератора тоже (ниже себя), но не админа и не супера.
    const toModerator = await admin.tab.call(`/api/admin/users/${userId}/role`, { method: 'POST', body: { role: 'moderator' } });
    assert.equal(toModerator.status, 200, JSON.stringify(toModerator.body));
    assert.equal(toModerator.body.user.role, 'moderator');
    assert.equal((await admin.tab.call(`/api/admin/users/${userId}/role`, { method: 'POST', body: { role: 'admin' } })).status, 403);
    assert.equal((await admin.tab.call(`/api/admin/users/${userId}/role`, { method: 'POST', body: { role: 'superadmin' } })).status, 403);
    // Себе — ни роль, ни через лишние поля.
    assert.equal((await admin.tab.call(`/api/admin/users/${admin.id}/role`, { method: 'POST', body: { role: 'superadmin' } })).body.code, 'self_action');
    assert.equal((await admin.tab.call('/api/me', { method: 'PATCH', body: { firstName: 'Админ', role: 'superadmin' } })).body.code, 'unexpected_field');
    assert.equal((await admin.tab.call('/api/account', { method: 'PATCH', body: { role: 'superadmin', permissions: ['roles.manage'] } })).body.code, 'unexpected_field');
    assert.equal((await admin.tab.call(`/api/admin/users/${userId}`, { method: 'PATCH', body: { firstName: 'Елена', role: 'superadmin' } })).body.code, 'unexpected_field');
    assert.equal((await admin.tab.call('/api/admin/me')).body.user.role, 'admin');
    // Аккаунт с той же ролью админ не трогает.
    const peer = await createActive({ email: 'peer@medkarta.test', role: 'admin' });
    assert.equal((await admin.tab.call(`/api/admin/users/${peer.id}/block`, { method: 'POST', body: { reason: 'тест' } })).status, 403);
    // Супер меняет роль обратно; аудит знает, кто и что.
    const back = await root.call(`/api/admin/users/${userId}/role`, { method: 'POST', body: { role: 'user' } });
    assert.equal(back.body.user.role, 'user');
    const audit = await root.call(`/api/admin/users/${userId}/audit`);
    const roles = audit.body.items.filter((item) => item.action === 'user.role' && item.result === 'ok');
    assert.deepEqual(roles.map((item) => item.details), [{ from: 'moderator', to: 'user' }, { from: 'user', to: 'moderator' }]);
  });

  it('блокировка сразу отзывает сессии и закрывает вход; разблокировка возвращает', async () => {
    const victim = await createActive({ email: 'blocked@medkarta.test' });
    const second = browserFor(base);
    await second.login('blocked@medkarta.test', victim.password);
    assert.equal((await victim.tab.call('/api/me')).status, 200);
    const blocked = await root.call(`/api/admin/users/${victim.id}/block`, { method: 'POST', body: { reason: 'Нарушение правил' } });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.user.status, 'blocked');
    assert.equal(blocked.body.user.activeSessions, 0);
    assert.equal((await victim.tab.call('/api/me')).status, 401, 'старая сессия больше не работает');
    assert.equal((await second.call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] } })).status, 401);
    const wrong = await browserFor(base).login('blocked@medkarta.test', 'неверный-пароль-1');
    assert.equal(wrong.status, 401, 'с неверным паролем о блокировке не сообщается');
    const right = await browserFor(base).login('blocked@medkarta.test', victim.password);
    assert.equal(right.status, 403);
    assert.equal(right.body.code, 'account_blocked');
    assert.equal(right.body.reason, 'Нарушение правил');
    const unblocked = await root.call(`/api/admin/users/${victim.id}/unblock`, { method: 'POST', body: {} });
    assert.equal(unblocked.body.user.status, 'active');
    assert.equal((await browserFor(base).login('blocked@medkarta.test', victim.password)).status, 200);
    const history = await root.call(`/api/admin/users/${victim.id}/blocks`);
    assert.deepEqual(history.body.items.map((item) => item.action), ['unblock', 'block']);
    const logins = await root.call(`/api/admin/users/${victim.id}/logins?type=failed`);
    assert.ok(logins.body.items.some((item) => item.type === 'login_denied'));
    assert.ok(logins.body.items.some((item) => item.type === 'login_failed'));
  });

  it('временная блокировка снимается сама по истечении срока', async () => {
    let clock = Date.now();
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const local = makeContext({ store, now: () => clock });
    await bootstrapSuperadmin({ store, email: 'boss@medkarta.test', password: ROOT_PASSWORD, now: () => clock });
    const boss = (await local.accounts.login({ email: 'boss@medkarta.test', password: ROOT_PASSWORD })).user;
    const actor = { ...store.getUserById(boss.id), permissions: PERMISSION_KEYS };
    const { user, link } = await local.admin.createUser(actor, { email: 'temp@medkarta.test', firstName: 'Врем', lastName: 'Блок' }, { base: 'http://localhost' });
    const opened = local.invitations.start(tokenOfLink(link));
    await local.invitations.complete(opened.contextToken, 'Временно-закрытый-1');
    local.admin.block(actor, user.id, { reason: 'Остыть', until: new Date(clock + 60 * 60 * 1000).toISOString() });
    await assert.rejects(local.accounts.login({ email: 'temp@medkarta.test', password: 'Временно-закрытый-1' }), (error) => error.code === 'account_blocked' && Boolean(error.extra.blockedUntil));
    clock += 61 * 60 * 1000;
    assert.ok((await local.accounts.login({ email: 'temp@medkarta.test', password: 'Временно-закрытый-1' })).session.token);
    assert.equal(store.getUserById(user.id).status, 'active');
    assert.deepEqual(store.listBlockEvents(user.id).map((event) => event.action), ['expired', 'block']);
  });

  it('смена пароля по ссылке от администратора: старый пароль и сессии перестают работать', async () => {
    const target = await createActive({ email: 'reset@medkarta.test' });
    const issued = await root.call(`/api/admin/users/${target.id}/invitations`, { method: 'POST', body: {} });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    assert.equal(issued.body.invitation.purpose, 'reset');
    assert.equal(issued.body.user.mustChangePassword, false, 'временного пароля нет');
    assert.equal((await target.tab.call('/api/me')).status, 200, 'до смены пароля человек работает как раньше');
    const { tab } = await acceptLink(base, issued.body.link, 'Новый-пароль-по-ссылке');
    assert.equal((await target.tab.call('/api/me')).status, 401, 'прежние сессии завершены');
    assert.equal((await browserFor(base).login('reset@medkarta.test', target.password)).status, 401, 'старый пароль больше не подходит');
    assert.equal((await browserFor(base).login('reset@medkarta.test', 'Новый-пароль-по-ссылке')).status, 200);
    assert.equal((await tab.call('/api/me')).status, 200);
    const audit = await root.call(`/api/admin/audit?targetId=${target.id}`);
    assert.ok(audit.body.items.some((item) => item.action === 'user.reset_link'));
    assert.ok(audit.body.items.some((item) => item.action === 'user.password_set' && item.actorId === target.id));
    assert.equal(audit.text.includes(tokenOfLink(issued.body.link)), false, 'токен не попал в журнал');
    assert.equal((await root.call(`/api/admin/users/${target.id}/password-reset`, { method: 'POST', body: {} })).status, 404, 'временных паролей больше нет');
  });

  it('смена своего пароля: текущий обязателен, другие сессии закрываются, новая cookie', async () => {
    const owner = await createActive({ email: 'owner@medkarta.test' });
    const other = browserFor(base);
    await other.login('owner@medkarta.test', owner.password);
    const oldCookie = owner.tab.jar.get(SESSION_COOKIE);
    const bad = await owner.tab.call('/api/me/password', { method: 'POST', body: { currentPassword: 'неверный-пароль', newPassword: 'Новый-пароль-2026' } });
    assert.equal(bad.status, 400);
    const ok = await owner.tab.call('/api/me/password', { method: 'POST', body: { currentPassword: owner.password, newPassword: 'Новый-пароль-2026' } });
    assert.equal(ok.status, 200);
    assert.notEqual(owner.tab.jar.get(SESSION_COOKIE), oldCookie, 'сессия заменена (защита от фиксации)');
    assert.equal((await owner.tab.call('/api/me')).status, 200);
    assert.equal((await other.call('/api/me')).status, 401);
  });

  it('сессии: список, отзыв одной, завершение всех, выход', async () => {
    const person = await createActive({ email: 'sessions@medkarta.test' });
    const phone = browserFor(base);
    await phone.login('sessions@medkarta.test', person.password);
    const mine = await person.tab.call('/api/me/sessions');
    assert.equal(mine.body.items.length, 2);
    assert.equal(mine.body.items.filter((item) => item.current).length, 1);
    const phoneSession = mine.body.items.find((item) => !item.current);
    assert.equal((await person.tab.call(`/api/me/sessions/${phoneSession.id}`, { method: 'DELETE' })).status, 403, 'изменение — только JSON');
    assert.equal((await person.tab.call(`/api/me/sessions/${phoneSession.id}`, { method: 'DELETE', body: {} })).status, 200);
    assert.equal((await phone.call('/api/me')).status, 401);
    // Админ видит и отзывает сессии пользователя.
    await phone.login('sessions@medkarta.test', person.password);
    const list = await root.call(`/api/admin/sessions?userId=${person.id}`);
    assert.equal(list.body.total, 2);
    assert.ok(list.body.items.every((item) => item.canRevoke && !('tokenHash' in item)));
    assert.equal((await root.call(`/api/admin/sessions/${list.body.items[0].id}`, { method: 'DELETE', body: {} })).status, 200);
    const all = await root.call(`/api/admin/users/${person.id}/sessions/revoke`, { method: 'POST', body: {} });
    assert.equal(all.body.revoked, 1);
    assert.equal((await person.tab.call('/api/me')).status, 401);
    // Выход стирает cookie и сессию.
    const tab = browserFor(base);
    await tab.login('sessions@medkarta.test', person.password);
    const cookieBefore = tab.jar.get(SESSION_COOKIE);
    const out = await tab.logout();
    assert.equal(out.status, 200);
    assert.equal(tab.jar.has(SESSION_COOKIE), false);
    tab.jar.set(SESSION_COOKIE, cookieBefore);
    assert.equal((await tab.call('/api/me')).status, 401, 'токен после выхода не работает');
  });

  it('CSRF: чужой Origin, Sec-Fetch-Site cross-site и не-JSON отклоняются', async () => {
    const userId = await findId('anna.smirnova@medkarta.test');
    const evil = await root.call(`/api/admin/users/${userId}/block`, { method: 'POST', body: {}, headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const crossSite = await root.call(`/api/admin/users/${userId}/block`, { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.status, 403);
    const form = await root.call(`/api/admin/users/${userId}/block`, { method: 'POST', body: {}, headers: { 'content-type': 'text/plain' } });
    assert.equal(form.status, 403);
    const login = await browserFor(base).call('/api/auth/login', { method: 'POST', body: { email: 'root@medkarta.test', password: ROOT_PASSWORD }, headers: { origin: 'https://evil.example' } });
    assert.equal(login.status, 403);
    assert.equal((await root.call(`/api/admin/users/${userId}`)).body.user.status, 'active');
  });

  it('инъекции: поиск, сортировка и id не ломают SQL; лишние поля — отказ', async () => {
    for (const q of ["' OR 1=1 --", '%', '_', '"; DROP TABLE users; --', '\\']) {
      const response = await root.call(`/api/admin/users?q=${encodeURIComponent(q)}`);
      assert.equal(response.status, 200, q);
      assert.equal(response.body.total, 0, q);
    }
    const sorted = await root.call(`/api/admin/users?sort=${encodeURIComponent('email; DROP TABLE users')}&dir=${encodeURIComponent('desc; --')}`);
    assert.equal(sorted.status, 200);
    assert.ok(sorted.body.total > 3);
    assert.equal((await root.call('/api/admin/users/..%2F..%2Fetc')).status, 404);
    assert.equal((await root.call(`/api/admin/users/${'a'.repeat(32)}`)).status, 404);
    const extra = await root.call('/api/admin/users', { method: 'POST', body: { email: 'mass@medkarta.test', firstName: 'Масс', lastName: 'Ассайн', passwordHash: 'x', status: 'active', mustChangePassword: false } });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.code, 'unexpected_field');
    const badName = await root.call('/api/admin/users', { method: 'POST', body: { email: 'xss@medkarta.test', firstName: '<img src=x onerror=alert(1)>', lastName: 'Тест' } });
    assert.equal(badName.body.code, 'bad_name');
    assert.equal((await root.call('/api/admin/users?q=alert')).body.total, 0);
  });

  it('пагинация, сортировка и фильтры — на сервере', async () => {
    for (let index = 0; index < 12; index += 1) {
      await root.call('/api/admin/users', { method: 'POST', body: { email: `page${String(index).padStart(2, '0')}@paging.test`, firstName: 'Страница', lastName: `Номер${'а'.repeat(index + 1)}` } });
    }
    const first = await root.call('/api/admin/users?q=paging.test&pageSize=10&sort=email&dir=asc&page=1');
    const second = await root.call('/api/admin/users?q=paging.test&pageSize=10&sort=email&dir=asc&page=2');
    assert.equal(first.body.total, 12);
    assert.equal(first.body.items.length, 10);
    assert.equal(second.body.items.length, 2);
    assert.equal(first.body.items[0].email, 'page00@paging.test');
    assert.equal(second.body.items.at(-1).email, 'page11@paging.test');
    assert.equal(new Set([...first.body.items, ...second.body.items].map((item) => item.id)).size, 12);
    assert.equal((await root.call('/api/admin/users?q=paging.test&pageSize=7')).body.pageSize, 25, 'размер страницы — только из списка');
    const byStatus = await root.call('/api/admin/users?status=blocked');
    assert.ok(byStatus.body.items.every((item) => item.status === 'blocked'));
    const byRole = await root.call('/api/admin/users?role=superadmin');
    assert.deepEqual(byRole.body.items.map((item) => item.email), ['root@medkarta.test']);
    const cyrillic = await root.call(`/api/admin/users?q=${encodeURIComponent('СМИРНОВА')}`);
    assert.deepEqual(cyrillic.body.items.map((item) => item.email), ['anna.smirnova@medkarta.test'], 'поиск по кириллице без учёта регистра');
    const byId = await root.call(`/api/admin/users?q=${first.body.items[0].id.slice(0, 10)}`);
    assert.equal(byId.body.items[0].id, first.body.items[0].id);
  });

  it('массовая блокировка и разблокировка — с результатом по каждому', async () => {
    const list = await root.call('/api/admin/users?q=paging.test&pageSize=10&sort=email&dir=asc');
    const ids = list.body.items.slice(0, 3).map((item) => item.id);
    const rootId = (await root.call('/api/admin/me')).body.user.id;
    const blocked = await root.call('/api/admin/users/bulk', { method: 'POST', body: { action: 'block', ids: [...ids, rootId], reason: 'Проверка' } });
    assert.equal(blocked.body.succeeded, 3);
    assert.equal(blocked.body.failed, 1, 'себя заблокировать нельзя');
    assert.equal(blocked.body.results.find((item) => item.id === rootId).code, 'self_action');
    const unblocked = await root.call('/api/admin/users/bulk', { method: 'POST', body: { action: 'unblock', ids } });
    assert.equal(unblocked.body.succeeded, 3);
    assert.equal((await root.call('/api/admin/users/bulk', { method: 'POST', body: { action: 'delete', ids } })).status, 400);
  });

  it('экспорт CSV: без хэшей и с защитой от формул', async () => {
    const formula = await root.call('/api/admin/users', { method: 'POST', body: { email: '=1+2@formula.test', firstName: 'Формула', lastName: 'Тест' } });
    assert.equal(formula.status, 201);
    // Переход с чужого сайта (cookie SameSite=Lax уходит при навигации) — отказ, экспорт не пишется.
    const before = (await root.call('/api/admin/audit?action=users.export')).body.total;
    const crossSite = await root.call('/api/admin/users/export?kind=real', { raw: true, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
    assert.equal(crossSite.status, 403);
    assert.equal((await root.call('/api/admin/users', { raw: true, headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await root.call('/api/admin/audit?action=users.export')).body.total, before);
    assert.equal((await root.call('/api/admin/users/export?kind=real', { raw: true, headers: { 'sec-fetch-site': 'none' } })).status, 200, 'набранный адрес');
    const response = await root.call('/api/admin/users/export?kind=real', { raw: true, headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM для Excel');
    const csv = bytes.toString('utf8');
    assert.ok(csv.includes("'=1+2@formula.test"), 'формула экранирована');
    assert.equal(/;=1\+2/.test(csv), false);
    assert.equal(/scrypt|password_hash|token/i.test(csv), false);
    const audit = await root.call('/api/admin/audit?action=users.export');
    assert.ok(audit.body.total >= 1);
  });

  it('профиль: изменение имени и email администратором с защитой от гонки', async () => {
    const userId = await findId('anna.smirnova@medkarta.test');
    const card = await root.call(`/api/admin/users/${userId}`);
    const version = card.body.user.version;
    const updated = await root.call(`/api/admin/users/${userId}`, { method: 'PATCH', body: { firstName: 'Анна-Мария', lastName: 'Смирнова', version } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.user.displayName, 'Анна-Мария Смирнова');
    const stale = await root.call(`/api/admin/users/${userId}`, { method: 'PATCH', body: { firstName: 'Устаревшая', version } });
    assert.equal(stale.status, 409, 'правка по старой версии отклонена');
    const audit = await root.call(`/api/admin/audit?targetId=${userId}&action=user.update`);
    assert.deepEqual(audit.body.items[0].details.changed, ['firstName']);
    assert.ok(audit.body.items[0].actor.startsWith('Максим'));
  });

  it('пользователь меняет свой профиль и аватар; видит только себя', async () => {
    const person = await createActive({ email: 'profile@medkarta.test' });
    const updated = await person.tab.call('/api/me', { method: 'PATCH', body: { firstName: 'Профиль', lastName: 'Обновлённый' } });
    assert.equal(updated.body.user.displayName, 'Профиль Обновлённый');
    for (const body of [{ firstName: null }, { lastName: 42 }, { firstName: { a: 1 } }]) {
      const wrong = await person.tab.call('/api/me', { method: 'PATCH', body });
      assert.equal(wrong.status, 400, JSON.stringify(body));
      assert.equal(wrong.body.code, 'bad_name');
    }
    const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFnRFWHRDb21tZW50AFNFQ1JFVC1DT01NRU5UsD4XwwAAABZJREFUeNpjOGFkRBJiGNUwqmH4agAAFAQsEONjdYwAAAAASUVORK5CYII=';
    const avatar = await person.tab.call('/api/me/avatar', { method: 'PUT', body: { image: `data:image/png;base64,${png}` } });
    assert.equal(avatar.status, 200);
    const image = await person.tab.call(avatar.body.user.avatarUrl, { raw: true });
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('content-security-policy'), /sandbox/);
    assert.equal(Buffer.from(await image.arrayBuffer()).includes('SECRET-COMMENT'), false);
    const svg = await person.tab.call('/api/me/avatar', { method: 'PUT', body: { image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } });
    assert.equal(svg.status, 400);
    const logins = await person.tab.call('/api/me/logins');
    assert.ok(logins.body.items.length >= 1);
    assert.ok(logins.body.items.every((item) => !('userId' in item)));
  });

  it('последний суперадминистратор: себя не заблокировать, не удалить, не понизить', async () => {
    const rootId = (await root.call('/api/admin/me')).body.user.id;
    assert.equal((await root.call(`/api/admin/users/${rootId}/block`, { method: 'POST', body: {} })).body.code, 'self_action');
    assert.equal((await root.call(`/api/admin/users/${rootId}/role`, { method: 'POST', body: { role: 'admin' } })).body.code, 'self_action');
    assert.equal((await root.call(`/api/admin/users/${rootId}/archive`, { method: 'POST', body: {} })).body.code, 'self_action');
    assert.equal((await root.call(`/api/admin/users/${rootId}`, { method: 'DELETE', body: { confirmEmail: 'root@medkarta.test' } })).body.code, 'self_action');
    assert.equal((await root.call('/api/account', { method: 'DELETE', body: { confirm: true } })).body.code, 'staff_account');
    // Даже если бы действие выполнял кто-то другой с полными правами — инвариант держит база.
    const ghost = { id: 'f'.repeat(32), role: 'superadmin', status: 'active', firstName: 'Призрак', lastName: '', email: 'ghost@medkarta.test', permissions: PERMISSION_KEYS };
    const admin = createAdminService({ store: context.store, accounts: context.accounts, invitations: context.invitations, throttle: context.throttle });
    assert.throws(() => admin.block(ghost, rootId, {}), (error) => error.code === 'last_superadmin');
    await assert.rejects(admin.deleteUser(ghost, rootId, { confirmEmail: 'root@medkarta.test' }), (error) => error.code === 'last_superadmin');
    assert.throws(() => admin.setRole(ghost, rootId, { role: 'user' }), (error) => error.code === 'last_superadmin');
    assert.equal(context.store.getUserById(rootId).status, 'active');
    assert.equal(context.store.getUserById(rootId).role, 'superadmin');
    const denied = await root.call('/api/admin/audit?result=denied&q=призрак');
    assert.ok(denied.body.total >= 3, 'попытки остались в журнале');
    // Суперадминистратора не назначает никто, даже суперадминистратор: роль только у владельца.
    const second = await createActive({ email: 'second@medkarta.test', role: 'user' });
    const promote = await root.call(`/api/admin/users/${second.id}/role`, { method: 'POST', body: { role: 'superadmin' } });
    assert.equal(promote.status, 403);
    assert.equal(context.store.getUserById(second.id).role, 'user');
    const invited = await root.call('/api/admin/users', { method: 'POST', body: { email: 'boss2@medkarta.test', firstName: 'Второй', lastName: 'Владелец', role: 'superadmin', delivery: 'manual' } });
    assert.equal(invited.status, 403);
    assert.equal(context.store.getUserByEmail('boss2@medkarta.test'), null);
    const card = await root.call(`/api/admin/users/${second.id}`);
    assert.equal(card.body.can.assignableRoles.includes('superadmin'), false);
    // Второй суперадминистратор из старой базы (до запрета) понижается — но не себя.
    context.store.updateUser(second.id, { role: 'superadmin' }, { now: Date.now() });
    assert.equal((await root.call(`/api/admin/users/${second.id}/role`, { method: 'POST', body: { role: 'user' } })).status, 200);
  });

  it('архив и удаление: подтверждение email, демо-записи отвязываются', async () => {
    const target = await createActive({ email: 'archive@medkarta.test' });
    const archived = await root.call(`/api/admin/users/${target.id}/archive`, { method: 'POST', body: {} });
    assert.equal(archived.body.user.status, 'archived');
    assert.equal((await target.tab.call('/api/me')).status, 401);
    assert.equal((await browserFor(base).login('archive@medkarta.test', target.password)).body.code, 'account_inactive');
    assert.equal((await root.call(`/api/admin/users/${target.id}/restore`, { method: 'POST', body: {} })).body.user.status, 'active');
    assert.equal((await root.call(`/api/admin/users/${target.id}`, { method: 'DELETE', body: { confirmEmail: 'wrong@medkarta.test' } })).status, 400);
    assert.equal((await root.call(`/api/admin/users/${target.id}`, { method: 'DELETE', body: { confirmEmail: 'ARCHIVE@medkarta.test' } })).status, 200);
    assert.equal((await root.call(`/api/admin/users/${target.id}`)).status, 404);
    const audit = await root.call('/api/admin/audit?action=user.delete');
    assert.equal(audit.body.items[0].target.includes('archive@'), false, 'email в журнале — маской');
    assert.match(audit.body.items[0].target, /a\*\*\*@medkarta\.test/);
  });

  it('роли: матрица, конфликты, журнал изменений', async () => {
    const roles = await root.call('/api/admin/roles');
    assert.equal(roles.status, 200);
    assert.equal(roles.body.canEdit, true);
    const moderator = roles.body.roles.find((role) => role.key === 'moderator');
    assert.deepEqual(moderator.permissions, DEFAULT_ROLE_PERMISSIONS.moderator);
    const conflict = await root.call('/api/admin/roles/moderator', { method: 'PUT', body: { permissions: ['admin.access', 'users.delete'] } });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.code, 'permission_conflict');
    const forbidden = await root.call('/api/admin/roles/admin', { method: 'PUT', body: { permissions: [...DEFAULT_ROLE_PERMISSIONS.admin, 'roles.manage'] } });
    assert.equal(forbidden.status, 400);
    assert.equal((await root.call('/api/admin/roles/superadmin', { method: 'PUT', body: { permissions: [] } })).status, 400);
    const updated = await root.call('/api/admin/roles/moderator', { method: 'PUT', body: { permissions: ['admin.access', 'users.view', 'users.block', 'audit.view'] } });
    assert.equal(updated.status, 200);
    const moder = await staffSignIn('moder@medkarta.test', 'Постоянный-пароль-1');
    assert.equal((await moder.call('/api/admin/audit')).status, 200, 'новое разрешение действует сразу');
    await root.call('/api/admin/roles/moderator/reset', { method: 'POST', body: {} });
    assert.equal((await moder.call('/api/admin/audit')).status, 403);
    const audit = await root.call('/api/admin/audit?action=roles.update');
    assert.deepEqual(audit.body.items[0].details.added, ['audit.view']);
  });

  it('настройки: проверка значений, журнал, применение без перезапуска', async () => {
    const list = await root.call('/api/admin/settings');
    assert.ok(list.body.items.some((item) => item.key === 'app.name'));
    assert.equal(list.body.items.some((item) => /key|secret|token|password/i.test(item.key)), false, 'секретов в настройках нет');
    const bad = await root.call('/api/admin/settings', { method: 'PATCH', body: { values: { 'sessions.maxDays': 9999 } } });
    assert.equal(bad.status, 400);
    const unknown = await root.call('/api/admin/settings', { method: 'PATCH', body: { values: { OPENROUTER_API_KEY: 'x' } } });
    assert.equal(unknown.status, 400);
    const inverted = await root.call('/api/admin/settings', { method: 'PATCH', body: { values: { 'sessions.idleDays': 30, 'sessions.maxDays': 10 } } });
    assert.equal(inverted.status, 400);
    const off = await root.call('/api/admin/settings', { method: 'PATCH', body: { values: { 'assistant.enabled': false, 'app.name': 'МедКарта Тест' } } });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.changed.sort(), ['app.name', 'assistant.enabled']);
    assert.equal((await root.call('/api/chat', { method: 'POST', body: { messages: [] } })).body.code, 'assistant_disabled');
    await root.call('/api/admin/settings', { method: 'PATCH', body: { values: { 'assistant.enabled': true } } });
    assert.equal((await root.call('/api/chat', { method: 'POST', body: { messages: [] } })).status, 200);
    const admin = await staffSignIn('admin@medkarta.test', 'Постоянный-пароль-1');
    assert.equal((await admin.call('/api/admin/settings')).status, 200, 'админ видит настройки');
    assert.equal((await admin.call('/api/admin/settings', { method: 'PATCH', body: { values: { 'app.name': 'Взлом' } } })).status, 403);
    const audit = await root.call('/api/admin/audit?action=settings.update');
    assert.ok(audit.body.items.some((item) => item.details?.changes?.['app.name']?.to === 'МедКарта Тест'));
    assert.ok(audit.body.items.some((item) => item.result === 'denied'), 'попытка админа записана');
  });

  it('дашборд: реальные числа из базы, периоды, без выдумок', async () => {
    for (const period of ['24h', '7d', '30d', '90d']) {
      const response = await root.call(`/api/admin/dashboard?period=${period}`);
      assert.equal(response.status, 200, period);
      const { body } = response;
      assert.equal(body.period, period);
      assert.equal(body.series.buckets.length, { '24h': 24, '7d': 7, '30d': 30, '90d': 90 }[period]);
      assert.equal(body.series.totalAccounts.at(-1), body.users.total, 'кривая аккаунтов сходится с итогом');
      assert.equal(body.series.activeUsers === null, period === '24h');
    }
    const { body } = await root.call('/api/admin/dashboard?period=7d');
    const list = await root.call('/api/admin/users?kind=real&pageSize=10');
    assert.equal(body.users.total, list.body.total);
    assert.ok(body.auth.logins >= 10);
    assert.ok(body.auth.failed >= 2);
    assert.ok(body.activity.dau >= 1 && body.activity.dau <= body.activity.mau);
    assert.ok(body.sessions.active >= 1);
    assert.equal(body.users.byRole.superadmin, 1 + 0);
    assert.ok(Array.isArray(body.recentAudit) && body.recentAudit.length > 0);
    assert.equal((await root.call('/api/admin/dashboard?period=1y')).body.period, '7d');
    // Ключи прототипа — не периоды (раньше — 500).
    for (const period of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const response = await root.call(`/api/admin/dashboard?period=${period}`);
      assert.equal(response.status, 200, period);
      assert.equal(response.body.period, '7d');
    }
  });
});

describe('Админ-панель: лимит входов и сохранность после перезапуска', { skip: !DatabaseSync && 'нужен Node 22.13+' }, () => {
  it('частые попытки входа упираются в лимит', async () => {
    const context = makeContext({ store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }) });
    const { server, base } = await startServer(context, { authLimit: createRateLimiter({ windowMs: 60_000, maxPerIp: 3, maxPerInstance: Number.POSITIVE_INFINITY }) });
    const tab = browserFor(base);
    const statuses = [];
    for (let index = 0; index < 5; index += 1) statuses.push((await tab.login('x@medkarta.test', `попытка-${index}-xx`)).status);
    server.close();
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });

  it('аккаунты, сессии и журнал переживают перезапуск', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-admin-')), 'accounts.sqlite');
    const mfaKey = randomBytes(32);
    let store = createSqliteAccountStore({ DatabaseSync, file });
    let context = makeContext({ store, mfaKey });
    await bootstrapSuperadmin({ store, email: 'root@medkarta.test', password: ROOT_PASSWORD });
    let { server, base } = await startServer(context);
    const tab = browserFor(base);
    await tab.login('root@medkarta.test', ROOT_PASSWORD);
    await tab.enrollPasskey(softAuthenticator());
    const created = await tab.call('/api/admin/users', { method: 'POST', body: { email: 'persist@medkarta.test', firstName: 'Сохранённый', lastName: 'Пользователь' } });
    await tab.call(`/api/admin/users/${created.body.user.id}/block`, { method: 'POST', body: { reason: 'Проверка перезапуска' } });
    server.close();
    store.close();

    // «Перезапуск»: новый процесс открывает тот же файл.
    store = createSqliteAccountStore({ DatabaseSync, file });
    context = makeContext({ store, mfaKey });
    ({ server, base } = await startServer(context));
    const rebooted = browserFor(base);
    rebooted.jar.set(SESSION_COOKIE, tab.jar.get(SESSION_COOKIE));
    const me = await rebooted.call('/api/admin/me');
    assert.equal(me.status, 200, 'сессия жива после перезапуска');
    const card = await rebooted.call(`/api/admin/users/${created.body.user.id}`);
    assert.equal(card.body.user.status, 'blocked');
    assert.equal(card.body.user.blockReason, 'Проверка перезапуска');
    const audit = await rebooted.call('/api/admin/audit?sort=at&dir=asc');
    assert.deepEqual(audit.body.items.map((item) => item.action), ['account.bootstrap', 'mfa.enable', 'user.create', 'user.invite', 'user.block']);
    assert.equal((await bootstrapSuperadmin({ store, email: 'root@medkarta.test', password: 'другой-пароль-2026' })).status, 'exists');
    server.close();
    store.close();
  });
});
