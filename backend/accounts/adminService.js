/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Административные операции над аккаунтами. Каждая операция сама проверяет
 * разрешение и ранг (rbac.js) — HTTP-слой проверяет то же, но решение здесь:
 * так права не обойти, вызвав сервис из другого места.
 *
 * Каждое изменение пишется в журнал (audit_log): кто, что, над кем, с каким
 * результатом. Пароли, токены и содержимое запросов к ассистенту в журнал не
 * попадают; email — только маской.
 *
 * Инвариант: в системе всегда есть хотя бы один активный superadmin. Любая
 * операция, которая его убирает (блокировка, архив, удаление, смена роли),
 * отклоняется в той же транзакции, где проверяется.
 */

import { generateTemporaryPassword, hashPassword, PasswordBusyError } from './passwords.js';
import {
  canAssign, canManage, checkRolePermissions, DEFAULT_ROLE_PERMISSIONS, isRole, PERMISSIONS, permissionsOf, rankOf, ROLE_INFO, ROLES,
} from './rbac.js';
import {
  AccountError, AUTH_EVENT_LABELS, authEventView, checkEmail, cleanPersonName, fail, maskEmail, moscowDay, sessionView, userLabel,
} from './service.js';
import { searchTextOf } from './sqliteStore.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const MAX_REASON = 300;
const MAX_BULK = 100;
const MAX_EXPORT = 10_000;
const PAGE_SIZES = [10, 25, 50, 100];
const USER_ID = /^[a-f0-9]{32}$/;
const SESSION_ID = /^[a-f0-9]{24}$/;

export const PERIODS = Object.freeze({
  '24h': { bucketMs: HOUR_MS, buckets: 24, label: '24 часа' },
  '7d': { bucketMs: DAY_MS, buckets: 7, label: '7 дней' },
  '30d': { bucketMs: DAY_MS, buckets: 30, label: '30 дней' },
  '90d': { bucketMs: DAY_MS, buckets: 90, label: '90 дней' },
});

export const AUDIT_ACTIONS = Object.freeze({
  'user.create': 'Создание пользователя',
  'user.update': 'Изменение профиля',
  'user.role': 'Изменение роли',
  'user.block': 'Блокировка',
  'user.unblock': 'Разблокировка',
  'user.archive': 'Архивирование',
  'user.restore': 'Восстановление из архива',
  'user.delete': 'Удаление аккаунта',
  'user.password_reset': 'Сброс пароля',
  'user.password_require': 'Требование сменить пароль',
  'user.sessions_revoke': 'Завершение всех сессий',
  'session.revoke': 'Отзыв сессии',
  'users.export': 'Экспорт пользователей',
  'roles.update': 'Изменение разрешений роли',
  'roles.reset': 'Сброс разрешений роли',
  'settings.update': 'Изменение настроек',
  'account.bootstrap': 'Создание главного администратора',
});

/** Московская полночь, с которой начинается день метки ms. */
const moscowMidnight = (ms) => Math.floor((ms + 3 * HOUR_MS) / DAY_MS) * DAY_MS - 3 * HOUR_MS;

const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  // Формула в ячейке выполнится в Excel: =HYPERLINK(...) и т. п. — экранируем.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {object} deps.accounts сервис кабинета (service.js)
 * @param {(userId: string) => Promise<void>} [deps.onAccountDeleted] отвязать демо-записи
 * @param {() => Promise<object>} [deps.systemInfo] состояние компонентов для дашборда
 */
export const createAdminService = ({ store, accounts, onAccountDeleted = async () => {}, systemInfo = async () => null, now = () => Date.now() }) => {
  const settings = accounts.settings;

  const has = (actor, permission) => Boolean(actor?.permissions?.includes(permission));

  const audit = (actor, action, { target = null, targetId = null, targetLabel = null, result = 'ok', details = null } = {}) =>
    store.addAudit({
      at: now(),
      action,
      actorId: actor?.id || null,
      actorLabel: actor ? userLabel(actor) : 'Система',
      targetId: target?.id || targetId,
      targetLabel: target ? userLabel(target) : targetLabel,
      result,
      details,
    });

  /** Нет разрешения на изменение — отказ, и попытка остаётся в журнале. */
  const denyChange = (actor, action, target, message, code = 'forbidden') => {
    audit(actor, action, { target, result: 'denied', details: { code } });
    fail(code, 403, message);
  };

  const requirePermission = (actor, permission, { action = null, target = null } = {}) => {
    if (has(actor, permission)) return;
    if (action) denyChange(actor, action, target, 'Недостаточно прав для этого действия.');
    fail('forbidden', 403, 'Недостаточно прав.');
  };

  const findUser = (id) => {
    const user = typeof id === 'string' && USER_ID.test(id) ? store.getUserById(id) : null;
    if (!user) fail('not_found', 404, 'Пользователь не найден.');
    return user;
  };

  /** Цель — существующий аккаунт ниже рангом (не сам actor и не демо-копия). */
  const manageable = (actor, id, action) => {
    const target = findUser(id);
    if (target.demoTemplate) fail('demo_account', 409, 'Демо-копии управляются автоматически.');
    if (target.id === actor.id) denyChange(actor, action, target, 'Это действие нельзя выполнить над своим аккаунтом.', 'self_action');
    if (!canManage(actor, target)) denyChange(actor, action, target, 'Нельзя менять аккаунт с такой же или более высокой ролью.');
    return target;
  };

  /** Останется ли хотя бы один активный superadmin, если target перестанет им быть. */
  const keepsSuperadmin = (target) => target.role !== 'superadmin' || target.status !== 'active' || store.countActiveSuperadmins({ excludeId: target.id }) > 0;

  /*
   * Изменение, которое может убрать последнего superadmin: проверка и запись —
   * в одной транзакции (BEGIN IMMEDIATE), а отказ пишется в журнал уже после
   * отката, иначе он откатился бы вместе с изменением.
   */
  const guarded = (actor, action, target, work) => {
    try {
      return store.transaction(() => {
        const fresh = store.getUserById(target.id) || target;
        if (!keepsSuperadmin(fresh)) fail('last_superadmin', 403, 'Это последний активный суперадминистратор — действие отменено.');
        return work();
      });
    } catch (error) {
      if (error instanceof AccountError && error.code === 'last_superadmin') {
        audit(actor, action, { target, result: 'denied', details: { code: 'last_superadmin' } });
      }
      throw error;
    }
  };

  const checkVersion = (target, version) => {
    if (version === undefined || version === null) return null;
    if (!Number.isInteger(version) || version !== target.version) {
      fail('conflict', 409, 'Данные пользователя изменились — обновите страницу и повторите.');
    }
    return version;
  };

  const adminUserView = (user, actor = null) => ({
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: `${user.firstName} ${user.lastName}`.trim() || user.displayName,
    role: user.role,
    roleLabel: ROLE_INFO[user.role]?.label || user.role,
    status: user.status,
    blockedUntil: iso(user.blockedUntil),
    blockReason: user.blockReason || null,
    mustChangePassword: user.mustChangePassword,
    createdAt: iso(user.createdAt),
    updatedAt: iso(user.updatedAt),
    lastLoginAt: iso(user.lastLoginAt),
    lastSeenAt: iso(user.lastSeenAt),
    passwordChangedAt: iso(user.passwordChangedAt),
    failedLogins: user.failedLogins,
    lastFailedLoginAt: iso(user.lastFailedLoginAt),
    activeSessions: user.activeSessions ?? null,
    avatarUrl: user.avatarEtag ? `/api/admin/users/${user.id}/avatar?v=${user.avatarEtag}` : null,
    isDemo: Boolean(user.demoTemplate),
    version: user.version,
    isSelf: actor ? actor.id === user.id : false,
  });

  /** Что actor может сделать с target — для кнопок интерфейса (сервер всё равно проверит). */
  const capabilities = (actor, target) => {
    const manage = !target.demoTemplate && canManage(actor, target);
    return {
      edit: manage && has(actor, 'users.edit'),
      changeRole: manage && has(actor, 'roles.assign'),
      assignableRoles: manage && has(actor, 'roles.assign') ? ROLES.filter((role) => canAssign(actor, role)) : [],
      block: manage && has(actor, 'users.block'),
      password: manage && has(actor, 'users.password'),
      sessions: (manage || actor.id === target.id) && has(actor, 'users.sessions'),
      archive: manage && has(actor, 'users.archive'),
      delete: manage && has(actor, 'users.delete'),
    };
  };

  const parsePage = (query) => {
    const page = Math.min(Math.max(Number.parseInt(query.page, 10) || 1, 1), 100_000);
    const size = Number.parseInt(query.pageSize, 10);
    const pageSize = PAGE_SIZES.includes(size) ? size : 25;
    return { page, pageSize, offset: (page - 1) * pageSize };
  };

  const parseUserFilters = (query = {}) => {
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
    const roles = String(query.role || '').split(',').map((value) => value.trim()).filter(isRole);
    const status = ['active', 'blocked', 'archived'].includes(query.status) ? query.status : null;
    const kind = ['real', 'demo', 'all'].includes(query.kind) ? query.kind : 'real';
    return { q, roles, status, kind };
  };

  const parseUntil = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ms)) fail('bad_request', 400, 'Неверная дата окончания блокировки.');
    if (ms <= now() + 60_000) fail('bad_request', 400, 'Дата окончания блокировки должна быть в будущем.');
    if (ms > now() + 10 * 365 * DAY_MS) fail('bad_request', 400, 'Слишком далёкая дата — используйте постоянную блокировку.');
    return ms;
  };

  const cleanReason = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail('bad_request', 400, 'Причина — строка.');
    // eslint-disable-next-line no-control-regex
    const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length > MAX_REASON) fail('bad_request', 400, `Причина — до ${MAX_REASON} символов.`);
    return clean || null;
  };

  const busy = (error) => {
    if (error instanceof PasswordBusyError) fail('busy', 503, 'Сервер сейчас занят — повторите через минуту.');
    throw error;
  };

  const onlyFields = (body, allowed) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('bad_request', 400, 'Ожидается объект.');
    const extra = Object.keys(body).filter((key) => !allowed.includes(key));
    // Лишние поля (role, status, passwordHash в теле правки профиля) — отказ, а не молчаливый пропуск.
    if (extra.length > 0) fail('unexpected_field', 400, `Недопустимые поля: ${extra.slice(0, 5).join(', ')}.`);
    return body;
  };

  const blockOne = (actor, target, { reason, until }) => {
    const stamp = now();
    guarded(actor, 'user.block', target, () => {
      store.updateUser(target.id, { status: 'blocked', blockedUntil: until, blockReason: reason }, { now: stamp });
      store.deleteUserSessions(target.id);
      store.addBlockEvent({ userId: target.id, at: stamp, action: 'block', until, reason, actorId: actor.id, actorLabel: userLabel(actor) });
      audit(actor, 'user.block', { target, details: { reason, until: iso(until), from: target.status } });
    });
  };

  const unblockOne = (actor, target) => {
    const stamp = now();
    store.transaction(() => {
      store.updateUser(target.id, { status: 'active', blockedUntil: null, blockReason: null }, { now: stamp });
      store.addBlockEvent({ userId: target.id, at: stamp, action: 'unblock', actorId: actor.id, actorLabel: userLabel(actor) });
      audit(actor, 'user.unblock', { target });
    });
  };

  const temporaryPasswordFor = async (actor, target, action) => {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword).catch(busy);
    const stamp = now();
    store.transaction(() => {
      store.setPassword(target.id, passwordHash, { mustChange: true, now: stamp });
      store.deleteUserSessions(target.id);
      audit(actor, action, { target, details: { sessionsRevoked: true } });
    });
    return temporaryPassword;
  };

  return Object.freeze({
    PERIODS,

    /** Кто вошёл в панель и что ему можно. */
    me(actor) {
      requirePermission(actor, 'admin.access');
      return {
        user: { ...adminUserView(actor, actor), avatarUrl: actor.avatarEtag ? `/api/me/avatar?v=${actor.avatarEtag}` : null },
        permissions: actor.permissions,
        roles: ROLES.map((role) => ({ key: role, ...ROLE_INFO[role] })),
      };
    },

    /* --------------------------- пользователи ---------------------------- */

    listUsers(actor, query = {}) {
      requirePermission(actor, 'users.view');
      const filters = parseUserFilters(query);
      const { page, pageSize, offset } = parsePage(query);
      const sort = typeof query.sort === 'string' ? query.sort : 'createdAt';
      const dir = query.dir === 'asc' ? 'asc' : 'desc';
      const { rows, total } = store.listUsers({ filters, sort, dir, limit: pageSize, offset, now: now() });
      return { items: rows.map((user) => adminUserView(user, actor)), total, page, pageSize, sort, dir };
    },

    exportUsers(actor, query = {}) {
      requirePermission(actor, 'users.export');
      const filters = parseUserFilters(query);
      if (typeof query.ids === 'string' && query.ids) {
        filters.ids = query.ids.split(',').filter((id) => USER_ID.test(id)).slice(0, MAX_EXPORT);
      }
      const { rows, total } = store.listUsers({ filters, sort: 'createdAt', dir: 'desc', limit: MAX_EXPORT, offset: 0, now: now() });
      const header = ['ID', 'Email', 'Имя', 'Фамилия', 'Роль', 'Статус', 'Заблокирован до', 'Создан', 'Последний вход', 'Последняя активность', 'Активных сессий', 'Нужно сменить пароль'];
      const statusLabel = { active: 'активен', blocked: 'заблокирован', archived: 'в архиве' };
      const lines = rows.map((user) => [
        user.id, user.email, user.firstName, user.lastName, ROLE_INFO[user.role]?.label || user.role, statusLabel[user.status] || user.status,
        iso(user.blockedUntil) || '', iso(user.createdAt), iso(user.lastLoginAt) || '', iso(user.lastSeenAt) || '', user.activeSessions ?? 0,
        user.mustChangePassword ? 'да' : 'нет',
      ].map(csvCell).join(';'));
      audit(actor, 'users.export', { details: { count: rows.length, total, filters: { q: Boolean(filters.q), roles: filters.roles, status: filters.status, kind: filters.kind } } });
      // BOM — чтобы Excel открыл кириллицу как UTF-8.
      return { csv: `\ufeff${[header.map(csvCell).join(';'), ...lines].join('\r\n')}\r\n`, count: rows.length, truncated: total > rows.length };
    },

    getUser(actor, id) {
      requirePermission(actor, 'users.view');
      const user = findUser(id);
      const sessions = store.listUserSessions(user.id, now());
      return {
        user: { ...adminUserView({ ...user, activeSessions: sessions.length }, actor), createdBy: user.createdBy ? userLabel(store.getUserById(user.createdBy)) || 'удалённый пользователь' : null },
        can: capabilities(actor, user),
        permissions: permissionsOf(user.role, Object.fromEntries(Object.entries(store.listRoleOverrides()).map(([role, row]) => [role, row.permissions]))),
      };
    },

    async createUser(actor, body = {}) {
      requirePermission(actor, 'users.create', { action: 'user.create' });
      const { email, firstName, lastName, role = 'user' } = onlyFields(body, ['email', 'firstName', 'lastName', 'role']);
      const address = checkEmail(email);
      const first = cleanPersonName(firstName);
      const last = cleanPersonName(lastName);
      if (!first) fail('bad_name', 400, 'Укажите имя: буквы, пробел, дефис.');
      if (!last) fail('bad_name', 400, 'Укажите фамилию: буквы, пробел, дефис.');
      if (!isRole(role)) fail('bad_role', 400, 'Неизвестная роль.');
      if (role !== 'user') {
        requirePermission(actor, 'roles.assign', { action: 'user.create' });
        if (!canAssign(actor, role)) denyChange(actor, 'user.create', null, 'Нельзя создать пользователя с ролью не ниже своей.');
      }
      const temporaryPassword = generateTemporaryPassword();
      const passwordHash = await hashPassword(temporaryPassword).catch(busy);
      const id = accounts.__internal.newId();
      const stamp = now();
      const user = store.transaction(() => {
        if (store.getUserByEmail(address)) fail('email_taken', 409, 'Пользователь с таким email уже есть.');
        const created = store.createUser({
          id, email: address, firstName: first, lastName: last, passwordHash, role, mustChangePassword: true, createdBy: actor.id, now: stamp,
        });
        audit(actor, 'user.create', { target: created, details: { role } });
        return created;
      });
      // Пароль возвращается один раз и нигде не сохраняется в открытом виде.
      return { user: adminUserView(user, actor), temporaryPassword };
    },

    updateUser(actor, id, body = {}) {
      requirePermission(actor, 'users.edit', { action: 'user.update' });
      const { firstName, lastName, email, version } = onlyFields(body, ['firstName', 'lastName', 'email', 'version']);
      const target = manageable(actor, id, 'user.update');
      const expected = checkVersion(target, version);
      const fields = {};
      if (firstName !== undefined) {
        const first = cleanPersonName(firstName);
        if (!first) fail('bad_name', 400, 'Имя: буквы, пробел, дефис.');
        if (first !== target.firstName) fields.firstName = first;
      }
      if (lastName !== undefined) {
        const last = cleanPersonName(lastName);
        if (!last) fail('bad_name', 400, 'Фамилия: буквы, пробел, дефис.');
        if (last !== target.lastName) fields.lastName = last;
      }
      if (email !== undefined) {
        const address = checkEmail(email);
        if (address !== target.email) fields.email = address;
      }
      if (Object.keys(fields).length === 0) return this.getUser(actor, id);
      const first = fields.firstName ?? target.firstName;
      const last = fields.lastName ?? target.lastName;
      const address = fields.email ?? target.email;
      store.transaction(() => {
        if (fields.email && store.getUserByEmail(address)) fail('email_taken', 409, 'Пользователь с таким email уже есть.');
        const updated = store.updateUser(target.id, {
          ...fields,
          displayName: `${first} ${last}`.trim(),
          searchText: searchTextOf({ firstName: first, lastName: last, email: address, id: target.id }),
        }, { now: now(), expectedVersion: expected });
        if (!updated) fail('conflict', 409, 'Данные пользователя изменились — обновите страницу и повторите.');
        const details = { changed: Object.keys(fields) };
        if (fields.email) details.email = { from: maskEmail(target.email), to: maskEmail(address) };
        audit(actor, 'user.update', { target: { ...target, firstName: first, lastName: last, email: address }, details });
      });
      return this.getUser(actor, id);
    },

    setRole(actor, id, body = {}) {
      requirePermission(actor, 'roles.assign', { action: 'user.role' });
      const { role, version } = onlyFields(body, ['role', 'version']);
      if (!isRole(role)) fail('bad_role', 400, 'Неизвестная роль.');
      const target = manageable(actor, id, 'user.role');
      const expected = checkVersion(target, version);
      if (role === target.role) return this.getUser(actor, id);
      if (!canAssign(actor, role)) denyChange(actor, 'user.role', target, 'Нельзя назначить роль не ниже своей.');
      const change = role === 'superadmin' ? (work) => store.transaction(work) : (work) => guarded(actor, 'user.role', target, work);
      change(() => {
        const updated = store.updateUser(target.id, { role }, { now: now(), expectedVersion: expected });
        if (!updated) fail('conflict', 409, 'Данные пользователя изменились — обновите страницу и повторите.');
        audit(actor, 'user.role', { target, details: { from: target.role, to: role } });
      });
      return this.getUser(actor, id);
    },

    block(actor, id, body = {}) {
      requirePermission(actor, 'users.block', { action: 'user.block' });
      const { reason, until } = onlyFields(body, ['reason', 'until']);
      const target = manageable(actor, id, 'user.block');
      if (target.status === 'archived') fail('bad_state', 409, 'Аккаунт в архиве — сначала восстановите его.');
      blockOne(actor, target, { reason: cleanReason(reason), until: parseUntil(until) });
      return this.getUser(actor, id);
    },

    unblock(actor, id) {
      requirePermission(actor, 'users.block', { action: 'user.unblock' });
      const target = manageable(actor, id, 'user.unblock');
      if (target.status !== 'blocked') fail('bad_state', 409, 'Аккаунт не заблокирован.');
      unblockOne(actor, target);
      return this.getUser(actor, id);
    },

    /** Массовая блокировка и разблокировка: результат по каждому id, без «всё или ничего». */
    bulk(actor, body = {}) {
      const { action, ids, reason, until } = onlyFields(body, ['action', 'ids', 'reason', 'until']);
      if (!['block', 'unblock'].includes(action)) fail('bad_request', 400, 'Неизвестное действие.');
      requirePermission(actor, 'users.block', { action: `user.${action}` });
      if (!Array.isArray(ids) || ids.length === 0) fail('bad_request', 400, 'Выберите пользователей.');
      if (ids.length > MAX_BULK) fail('bad_request', 400, `Не больше ${MAX_BULK} пользователей за раз.`);
      const cleanedReason = action === 'block' ? cleanReason(reason) : null;
      const blockedUntil = action === 'block' ? parseUntil(until) : null;
      const results = [...new Set(ids)].map((id) => {
        try {
          const target = manageable(actor, id, `user.${action}`);
          if (action === 'block') {
            if (target.status === 'archived') fail('bad_state', 409, 'Аккаунт в архиве.');
            blockOne(actor, target, { reason: cleanedReason, until: blockedUntil });
          } else {
            if (target.status !== 'blocked') fail('bad_state', 409, 'Аккаунт не заблокирован.');
            unblockOne(actor, target);
          }
          return { id, ok: true };
        } catch (error) {
          if (error instanceof AccountError) return { id, ok: false, code: error.code, error: error.message };
          throw error;
        }
      });
      return { results, succeeded: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length };
    },

    archive(actor, id) {
      requirePermission(actor, 'users.archive', { action: 'user.archive' });
      const target = manageable(actor, id, 'user.archive');
      if (target.status === 'archived') fail('bad_state', 409, 'Аккаунт уже в архиве.');
      guarded(actor, 'user.archive', target, () => {
        store.updateUser(target.id, { status: 'archived', blockedUntil: null }, { now: now() });
        store.deleteUserSessions(target.id);
        audit(actor, 'user.archive', { target, details: { from: target.status } });
      });
      return this.getUser(actor, id);
    },

    restore(actor, id) {
      requirePermission(actor, 'users.archive', { action: 'user.restore' });
      const target = manageable(actor, id, 'user.restore');
      if (target.status !== 'archived') fail('bad_state', 409, 'Аккаунт не в архиве.');
      store.transaction(() => {
        store.updateUser(target.id, { status: 'active', blockReason: null, blockedUntil: null }, { now: now() });
        audit(actor, 'user.restore', { target });
      });
      return this.getUser(actor, id);
    },

    async resetPassword(actor, id) {
      requirePermission(actor, 'users.password', { action: 'user.password_reset' });
      const target = manageable(actor, id, 'user.password_reset');
      const temporaryPassword = await temporaryPasswordFor(actor, target, 'user.password_reset');
      return { ...this.getUser(actor, id), temporaryPassword };
    },

    requirePasswordChange(actor, id) {
      requirePermission(actor, 'users.password', { action: 'user.password_require' });
      const target = manageable(actor, id, 'user.password_require');
      store.transaction(() => {
        store.updateUser(target.id, { mustChangePassword: true }, { now: now() });
        audit(actor, 'user.password_require', { target });
      });
      return this.getUser(actor, id);
    },

    revokeUserSessions(actor, id) {
      requirePermission(actor, 'users.sessions', { action: 'user.sessions_revoke' });
      const target = manageable(actor, id, 'user.sessions_revoke');
      const revoked = store.transaction(() => {
        const count = store.deleteUserSessions(target.id);
        audit(actor, 'user.sessions_revoke', { target, details: { count } });
        store.addAuthEvent({ at: now(), type: 'sessions_revoked', userId: target.id, reason: 'admin' });
        return count;
      });
      return { revoked };
    },

    /** Отозвать одну сессию: свою — всегда, чужую — если можно управлять её владельцем. */
    revokeSession(actor, publicId) {
      requirePermission(actor, 'users.sessions', { action: 'session.revoke' });
      const session = typeof publicId === 'string' && SESSION_ID.test(publicId) ? store.getSessionByPublicId(publicId) : null;
      if (!session) fail('not_found', 404, 'Сессия не найдена или уже завершена.');
      const owner = store.getUserById(session.userId);
      if (owner && owner.id !== actor.id && !canManage(actor, owner)) {
        denyChange(actor, 'session.revoke', owner, 'Нельзя завершать сессии аккаунта с такой же или более высокой ролью.');
      }
      store.transaction(() => {
        store.deleteSession(session.tokenHash);
        audit(actor, 'session.revoke', { target: owner, details: { session: session.publicId, own: owner?.id === actor.id } });
        store.addAuthEvent({ at: now(), type: 'session_revoked', userId: session.userId, sessionId: session.publicId, reason: owner?.id === actor.id ? 'self' : 'admin' });
      });
      return { revoked: 1 };
    },

    async deleteUser(actor, id, body = {}) {
      requirePermission(actor, 'users.delete', { action: 'user.delete' });
      const { confirmEmail } = onlyFields(body, ['confirmEmail']);
      const target = manageable(actor, id, 'user.delete');
      if (typeof confirmEmail !== 'string' || confirmEmail.trim().toLowerCase() !== target.email) {
        fail('confirm_required', 400, 'Для удаления введите email пользователя.');
      }
      guarded(actor, 'user.delete', target, () => {
        store.deleteUserAuthEvents(target.id);
        store.deleteUser(target.id);
        audit(actor, 'user.delete', { target, details: { role: target.role } });
      });
      await onAccountDeleted(target.id);
      return { deleted: true };
    },

    userSessions(actor, id) {
      requirePermission(actor, 'users.sessions');
      const user = findUser(id);
      return { items: store.listUserSessions(user.id, now()).map((session) => sessionView(session)) };
    },

    userLogins(actor, id, query = {}) {
      requirePermission(actor, 'users.view');
      const user = findUser(id);
      const { page, pageSize, offset } = parsePage(query);
      const types = query.type === 'failed' ? ['login_failed', 'login_denied'] : null;
      const { rows, total } = store.listAuthEvents({ userId: user.id, types, limit: pageSize, offset });
      return { items: rows.map(authEventView), total, page, pageSize };
    },

    userBlocks(actor, id) {
      requirePermission(actor, 'users.view');
      const user = findUser(id);
      return {
        items: store.listBlockEvents(user.id).map((event) => ({
          id: event.id, at: iso(event.at), action: event.action, until: iso(event.until), reason: event.reason, actor: event.actorLabel,
        })),
      };
    },

    userAudit(actor, id, query = {}) {
      requirePermission(actor, 'audit.view');
      findUser(id);
      return this.listAudit(actor, { ...query, targetId: id });
    },

    /* ------------------------------- сессии -------------------------------- */

    listSessions(actor, query = {}) {
      requirePermission(actor, 'users.sessions');
      const { page, pageSize, offset } = parsePage(query);
      const userId = typeof query.userId === 'string' && USER_ID.test(query.userId) ? query.userId : null;
      const kind = query.kind === 'all' ? 'all' : 'real';
      const { rows, total } = store.listSessions({ userId, kind, limit: pageSize, offset, now: now() });
      return {
        items: rows.map((session) => ({
          ...sessionView(session),
          user: {
            id: session.user.id,
            email: session.user.email,
            displayName: `${session.user.firstName} ${session.user.lastName}`.trim(),
            role: session.user.role,
            roleLabel: ROLE_INFO[session.user.role]?.label,
          },
          own: session.user.id === actor.id,
          canRevoke: session.user.id === actor.id || canManage(actor, { id: session.user.id, role: session.user.role }),
        })),
        total,
        page,
        pageSize,
      };
    },

    /* ------------------------------- аудит --------------------------------- */

    listAudit(actor, query = {}) {
      requirePermission(actor, 'audit.view');
      const { page, pageSize, offset } = parsePage(query);
      const parseDate = (value, endOfDay = false) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const ms = Date.parse(`${value}T00:00:00+03:00`);
        return Number.isFinite(ms) ? ms + (endOfDay ? DAY_MS : 0) : null;
      };
      const filters = {
        action: Object.hasOwn(AUDIT_ACTIONS, query.action) ? query.action : null,
        actorId: typeof query.actorId === 'string' && USER_ID.test(query.actorId) ? query.actorId : null,
        targetId: typeof query.targetId === 'string' && USER_ID.test(query.targetId) ? query.targetId : null,
        result: ['ok', 'denied', 'failed'].includes(query.result) ? query.result : null,
        q: typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '',
        from: parseDate(query.from),
        to: parseDate(query.to, true),
      };
      const sort = typeof query.sort === 'string' ? query.sort : 'at';
      const dir = query.dir === 'asc' ? 'asc' : 'desc';
      const { rows, total } = store.listAudit({ filters, sort, dir, limit: pageSize, offset });
      return {
        items: rows.map((row) => ({
          id: row.id,
          at: iso(row.at),
          action: row.action,
          actionLabel: AUDIT_ACTIONS[row.action] || row.action,
          actor: row.actorLabel,
          actorId: row.actorId,
          target: row.targetLabel,
          targetId: row.targetId,
          result: row.result,
          details: row.details,
        })),
        total,
        page,
        pageSize,
        actions: Object.entries(AUDIT_ACTIONS).map(([key, label]) => ({ key, label })),
      };
    },

    /* ---------------------------- роли и права ----------------------------- */

    roles(actor) {
      if (!has(actor, 'roles.manage') && !has(actor, 'roles.assign')) fail('forbidden', 403, 'Недостаточно прав.');
      const overrides = store.listRoleOverrides();
      const current = Object.fromEntries(Object.entries(overrides).map(([role, row]) => [role, row.permissions]));
      const counts = Object.fromEntries(ROLES.map((role) => [role, { active: 0, total: 0 }]));
      for (const row of store.userCounts()) {
        if (!counts[row.role]) continue;
        counts[row.role].total += row.count;
        if (row.status === 'active') counts[row.role].active += row.count;
      }
      const matrix = Object.fromEntries(ROLES.map((role) => [role, permissionsOf(role, current)]));
      return {
        roles: ROLES.map((role) => {
          const others = Object.fromEntries(ROLES.filter((other) => other !== role).map((other) => [other, matrix[other]]));
          const check = checkRolePermissions(role, matrix[role], { otherRoles: others });
          return {
            key: role,
            ...ROLE_INFO[role],
            permissions: matrix[role],
            defaults: [...DEFAULT_ROLE_PERMISSIONS[role]],
            customized: Boolean(overrides[role]),
            updatedAt: iso(overrides[role]?.updatedAt),
            users: counts[role],
            conflicts: check.errors,
            warnings: check.warnings,
          };
        }),
        permissions: PERMISSIONS.map((permission) => ({ ...permission })),
        canEdit: has(actor, 'roles.manage'),
        superadmins: store.countActiveSuperadmins(),
      };
    },

    updateRolePermissions(actor, role, body = {}) {
      requirePermission(actor, 'roles.manage', { action: 'roles.update' });
      const { permissions } = onlyFields(body, ['permissions']);
      if (!isRole(role) || !ROLE_INFO[role].editable) fail('bad_role', 400, 'Разрешения этой роли не настраиваются.');
      const current = Object.fromEntries(ROLES.map((other) => [other, permissionsOf(other, Object.fromEntries(Object.entries(store.listRoleOverrides()).map(([key, row]) => [key, row.permissions])))]));
      const others = Object.fromEntries(ROLES.filter((other) => other !== role).map((other) => [other, current[other]]));
      const unique = Array.isArray(permissions) ? [...new Set(permissions)] : permissions;
      const check = checkRolePermissions(role, unique, { otherRoles: others });
      if (check.errors.length > 0) fail('permission_conflict', 400, check.errors[0], { errors: check.errors });
      const before = current[role];
      store.transaction(() => {
        store.putRoleOverride(role, unique, actor.id, now());
        audit(actor, 'roles.update', {
          targetLabel: ROLE_INFO[role].label,
          details: { role, added: unique.filter((key) => !before.includes(key)), removed: before.filter((key) => !unique.includes(key)) },
        });
      });
      accounts.reloadRoleOverrides();
      return { ...this.roles(actor), warnings: check.warnings };
    },

    resetRolePermissions(actor, role) {
      requirePermission(actor, 'roles.manage', { action: 'roles.reset' });
      if (!isRole(role) || !ROLE_INFO[role].editable) fail('bad_role', 400, 'Разрешения этой роли не настраиваются.');
      store.transaction(() => {
        store.deleteRoleOverride(role);
        audit(actor, 'roles.reset', { targetLabel: ROLE_INFO[role].label, details: { role } });
      });
      accounts.reloadRoleOverrides();
      return this.roles(actor);
    },

    /* ------------------------------ настройки ------------------------------ */

    settings(actor) {
      requirePermission(actor, 'settings.view');
      return { items: settings.list(), canEdit: has(actor, 'settings.edit') };
    },

    updateSettings(actor, body = {}) {
      requirePermission(actor, 'settings.edit', { action: 'settings.update' });
      const { values } = onlyFields(body, ['values']);
      const result = settings.update(values, actor.id);
      if (result.errors) fail('bad_setting', 400, Object.values(result.errors)[0], { errors: result.errors });
      if (Object.keys(result.changes).length > 0) audit(actor, 'settings.update', { targetLabel: 'Настройки', details: { changes: result.changes } });
      return { ...this.settings(actor), changed: Object.keys(result.changes) };
    },

    /* ------------------------------ дашборд -------------------------------- */

    async dashboard(actor, period = '7d') {
      requirePermission(actor, 'dashboard.view');
      const config = PERIODS[period] || PERIODS['7d'];
      const key = PERIODS[period] ? period : '7d';
      const stamp = now();
      const since = config.bucketMs === HOUR_MS
        ? Math.floor(stamp / HOUR_MS) * HOUR_MS - (config.buckets - 1) * HOUR_MS
        : moscowMidnight(stamp) - (config.buckets - 1) * DAY_MS;

      const counts = store.userCounts();
      const sum = (filter) => counts.filter(filter).reduce((total, row) => total + row.count, 0);
      const byRole = Object.fromEntries(ROLES.map((role) => [role, sum((row) => row.role === role)]));
      const today = moscowDay(stamp);
      const dayBefore = (days) => moscowDay(stamp - days * DAY_MS);

      const createdSeries = store.userCreationSeries({ since, bucketMs: config.bucketMs, buckets: config.buckets });
      let running = store.countUsersCreated({ since: 0, until: since });
      const totalSeries = createdSeries.map((count) => {
        running += count;
        return running;
      });
      const authSeries = store.authEventSeries({ since, bucketMs: config.bucketMs, buckets: config.buckets, types: ['login_ok', 'login_failed', 'login_denied'] });
      let activitySeries = null;
      if (config.bucketMs === DAY_MS) {
        const daily = store.dailyActiveUsers(moscowDay(since), today);
        activitySeries = Array.from({ length: config.buckets }, (_, index) => daily[moscowDay(since + index * DAY_MS)] || 0);
      }

      const health = await systemInfo().catch(() => null);
      return {
        period: key,
        periodLabel: config.label,
        generatedAt: iso(stamp),
        timezone: 'Europe/Moscow',
        users: {
          total: sum(() => true),
          active: sum((row) => row.status === 'active'),
          blocked: sum((row) => row.status === 'blocked'),
          archived: sum((row) => row.status === 'archived'),
          mustChangePassword: counts.reduce((total, row) => total + row.mustChange, 0),
          byRole,
          demoCopies: store.countDemoCopies(),
        },
        newAccounts: {
          day: store.countUsersCreated({ since: stamp - DAY_MS }),
          week: store.countUsersCreated({ since: stamp - 7 * DAY_MS }),
          month: store.countUsersCreated({ since: stamp - 30 * DAY_MS }),
        },
        activity: {
          dau: store.countActiveUsers(today, today),
          wau: store.countActiveUsers(dayBefore(6), today),
          mau: store.countActiveUsers(dayBefore(29), today),
          definition: 'Уникальные пользователи (без демо-копий), выполнившие хотя бы один запрос с действующей сессией за московские сутки.',
        },
        auth: {
          logins: store.countAuthEvents({ type: 'login_ok', since }),
          failed: store.countAuthEvents({ type: 'login_failed', since }),
          denied: store.countAuthEvents({ type: 'login_denied', since }),
          retentionDays: settings.get('retention.authEventsDays'),
        },
        sessions: {
          active: store.countActiveSessions(stamp, { kind: 'real' }),
          demo: store.countActiveSessions(stamp, { kind: 'demo' }),
          note: 'Число действующих сессий, а не людей онлайн: сессия живёт до выхода или истечения срока.',
        },
        series: {
          start: iso(since),
          bucketMs: config.bucketMs,
          buckets: Array.from({ length: config.buckets }, (_, index) => iso(since + index * config.bucketMs)),
          newAccounts: createdSeries,
          totalAccounts: totalSeries,
          logins: authSeries.login_ok,
          failedLogins: authSeries.login_failed,
          deniedLogins: authSeries.login_denied,
          activeUsers: activitySeries,
          activeUsersNote: activitySeries ? null : 'Активность считается по суткам — для периода 24 часа график недоступен.',
        },
        recentAudit: has(actor, 'audit.view') ? this.listAudit(actor, { pageSize: 10 }).items : null,
        recentUsers: store.recentUsers(5).map((user) => adminUserView(user, actor)),
        health,
        authEventLabels: AUTH_EVENT_LABELS,
      };
    },

    /** Для мониторинга: состояние базы аккаунтов. */
    storageHealth() {
      try {
        return { ...store.health(), users: store.countUsers() };
      } catch {
        return { ok: false };
      }
    },

    rankOf,
  });
};
