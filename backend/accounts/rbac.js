/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Роли и разрешения — единственный источник правды о правах. Интерфейс
 * получает отсюда список и матрицу, но решает всегда сервер: скрытая кнопка
 * не защищает API.
 *
 * Четыре системные роли с рангами. Разрешения admin и moderator superadmin
 * может настроить (role_overrides в базе); superadmin всегда имеет все, user —
 * ни одного административного. Над рангом действуют два правила:
 *   - менять можно только аккаунт с рангом ниже своего (superadmin — любой,
 *     кроме себя);
 *   - назначить можно только роль ниже своей (superadmin — любую).
 */

export const ROLES = Object.freeze(['user', 'moderator', 'admin', 'superadmin']);

export const ROLE_INFO = Object.freeze({
  superadmin: Object.freeze({ label: 'Суперадминистратор', rank: 3, editable: false, description: 'Полный доступ: администраторы, роли, настройки, аудит.' }),
  admin: Object.freeze({ label: 'Администратор', rank: 2, editable: true, description: 'Пользователи, блокировки, статистика, журнал действий.' }),
  moderator: Object.freeze({ label: 'Модератор', rank: 1, editable: true, description: 'Просмотр пользователей и ограниченная модерация.' }),
  user: Object.freeze({ label: 'Пользователь', rank: 0, editable: false, description: 'Сервис МедКарта и свой профиль.' }),
});

/*
 * requires — без чего разрешение не имеет смысла (конфликт прав, если нет);
 * danger — действие необратимо или открывает персональные данные;
 * superadminOnly — нельзя выдать никому, кроме superadmin.
 */
export const PERMISSIONS = Object.freeze([
  { key: 'admin.access', group: 'Панель', label: 'Вход в админ-панель' },
  { key: 'dashboard.view', group: 'Панель', label: 'Дашборд и статистика' },
  { key: 'users.view', group: 'Пользователи', label: 'Просмотр пользователей' },
  { key: 'users.create', group: 'Пользователи', label: 'Создание пользователей', requires: ['users.view'] },
  { key: 'users.edit', group: 'Пользователи', label: 'Изменение имени и email', requires: ['users.view'] },
  { key: 'users.block', group: 'Пользователи', label: 'Блокировка и разблокировка', requires: ['users.view'], danger: true },
  { key: 'users.password', group: 'Пользователи', label: 'Временный пароль, требование смены', requires: ['users.view'], danger: true },
  { key: 'users.sessions', group: 'Пользователи', label: 'Просмотр и отзыв сессий', requires: ['users.view'], danger: true },
  { key: 'users.archive', group: 'Пользователи', label: 'Архивирование и восстановление', requires: ['users.view'], danger: true },
  { key: 'users.delete', group: 'Пользователи', label: 'Безвозвратное удаление', requires: ['users.view', 'users.archive'], danger: true },
  { key: 'users.export', group: 'Пользователи', label: 'Экспорт в CSV', requires: ['users.view'], danger: true },
  { key: 'roles.assign', group: 'Роли', label: 'Назначение ролей', requires: ['users.view', 'users.edit'], danger: true },
  { key: 'roles.manage', group: 'Роли', label: 'Изменение матрицы разрешений', danger: true, superadminOnly: true },
  { key: 'audit.view', group: 'Журналы', label: 'Журнал административных действий' },
  { key: 'system.view', group: 'Система', label: 'Мониторинг и состояние' },
  { key: 'settings.view', group: 'Система', label: 'Просмотр настроек' },
  { key: 'settings.edit', group: 'Система', label: 'Изменение настроек', requires: ['settings.view'], danger: true, superadminOnly: true },
].map((item) => Object.freeze({ requires: [], danger: false, superadminOnly: false, ...item })));

export const PERMISSION_KEYS = Object.freeze(PERMISSIONS.map((item) => item.key));
const BY_KEY = new Map(PERMISSIONS.map((item) => [item.key, item]));

export const DEFAULT_ROLE_PERMISSIONS = Object.freeze({
  superadmin: Object.freeze([...PERMISSION_KEYS]),
  admin: Object.freeze([
    'admin.access', 'dashboard.view', 'users.view', 'users.create', 'users.edit', 'users.block', 'users.password',
    'users.sessions', 'users.archive', 'users.export', 'roles.assign', 'audit.view', 'system.view', 'settings.view',
  ]),
  moderator: Object.freeze(['admin.access', 'users.view', 'users.block']),
  user: Object.freeze([]),
});

export const isRole = (value) => typeof value === 'string' && Object.hasOwn(ROLE_INFO, value);
export const rankOf = (role) => (isRole(role) ? ROLE_INFO[role].rank : -1);

/**
 * Проблемы набора разрешений роли: ошибки (сохранить нельзя) и
 * предупреждения (можно, но выглядит как ошибка настройки).
 */
export const checkRolePermissions = (role, permissions, { otherRoles = {} } = {}) => {
  const errors = [];
  const warnings = [];
  if (!isRole(role)) return { errors: ['Неизвестная роль.'], warnings };
  if (!Array.isArray(permissions)) return { errors: ['Ожидается список разрешений.'], warnings };
  const set = new Set(permissions);
  for (const key of set) {
    const meta = BY_KEY.get(key);
    if (!meta) {
      errors.push(`Неизвестное разрешение «${String(key).slice(0, 40)}».`);
      continue;
    }
    if (meta.superadminOnly && role !== 'superadmin') errors.push(`«${meta.label}» доступно только суперадминистратору.`);
    for (const required of meta.requires) {
      if (!set.has(required)) errors.push(`«${meta.label}» требует «${BY_KEY.get(required).label}».`);
    }
    if (key !== 'admin.access' && !set.has('admin.access')) {
      errors.push(`«${meta.label}» бесполезно без «${BY_KEY.get('admin.access').label}».`);
    }
  }
  if (role === 'user' && set.size > 0) errors.push('У роли «Пользователь» не может быть административных разрешений.');
  if (role === 'superadmin' && set.size !== PERMISSION_KEYS.length) errors.push('У суперадминистратора всегда все разрешения.');
  // Иерархия: роль ниже не должна уметь то, чего не умеет роль выше.
  for (const [other, otherPermissions] of Object.entries(otherRoles)) {
    if (rankOf(other) > rankOf(role)) {
      const missing = [...set].filter((key) => BY_KEY.has(key) && !otherPermissions.includes(key));
      if (missing.length > 0) {
        warnings.push(`У роли «${ROLE_INFO[role].label}» есть то, чего нет у «${ROLE_INFO[other].label}»: ${missing.map((key) => BY_KEY.get(key).label).join(', ')}.`);
      }
    }
  }
  return { errors: [...new Set(errors)], warnings };
};

/** Разрешения роли с учётом настроек superadmin (overrides: {admin: [...], moderator: [...]}). */
export const permissionsOf = (role, overrides = {}) => {
  if (!isRole(role)) return [];
  if (role === 'superadmin') return [...PERMISSION_KEYS];
  if (role === 'user') return [];
  const custom = overrides[role];
  return Array.isArray(custom) ? PERMISSION_KEYS.filter((key) => custom.includes(key)) : [...DEFAULT_ROLE_PERMISSIONS[role]];
};

/** Может ли actor менять аккаунт target (не себя и только ниже рангом; superadmin — любой). */
export const canManage = (actor, target) => {
  if (!actor || !target || actor.id === target.id) return false;
  if (actor.role === 'superadmin') return true;
  return rankOf(actor.role) > rankOf(target.role);
};

/** Может ли actor назначить роль role. */
export const canAssign = (actor, role) => {
  if (!actor || !isRole(role)) return false;
  if (actor.role === 'superadmin') return true;
  return rankOf(role) < rankOf(actor.role);
};

export const permissionMeta = (key) => BY_KEY.get(key) || null;
