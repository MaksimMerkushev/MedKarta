/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Модель админ-панели без компонентов: кто вошёл и что ему можно,
 * какие роли он назначает, расшифровка записей журнала.
 */
import { createContext, useContext } from 'react';

import { formatDateTime, ROLE_LABELS } from '../ui/format';

export const AdminContext = createContext({ me: null, can: () => false });
export const useAdmin = () => useContext(AdminContext);

export const RANKS = { user: 0, moderator: 1, admin: 2, superadmin: 3 };

/** Роли, которые этот администратор может назначить (сервер проверит то же самое). */
export const assignableRoles = (me) => {
  if (!me?.permissions?.includes('roles.assign')) return ['user'];
  return Object.keys(RANKS).filter((role) => me.user.role === 'superadmin' || RANKS[role] < RANKS[me.user.role]);
};

const FIELD_LABELS = { firstName: 'имя', lastName: 'фамилия', email: 'email' };
const CODE_LABELS = {
  forbidden: 'недостаточно прав',
  self_action: 'действие над своим аккаунтом',
  last_superadmin: 'последний суперадминистратор',
};

/** Короткое человеческое описание деталей записи журнала. */
export const describeAudit = (item) => {
  const details = item.details || {};
  if (item.result !== 'ok') return `Отклонено: ${CODE_LABELS[details.code] || details.code || 'ошибка'}`;
  switch (item.action) {
    case 'user.create':
      return `Роль: ${ROLE_LABELS[details.role] || details.role || '—'}${details.test ? ' (тестовый)' : ''}`;
    case 'user.update':
      return `Изменено: ${(details.changed || []).map((key) => FIELD_LABELS[key] || key).join(', ')}${details.email ? ` (${details.email.from} → ${details.email.to})` : ''}`;
    case 'user.role':
      return `${ROLE_LABELS[details.from] || details.from} → ${ROLE_LABELS[details.to] || details.to}${details.via === 'cli' ? ' (CLI)' : ''}`;
    case 'user.block':
      return `${details.until ? `до ${formatDateTime(details.until)}` : 'бессрочно'}${details.reason ? ` · ${details.reason}` : ''}`;
    case 'user.unblock':
      return details.reason || 'Разблокирован';
    case 'user.sessions_revoke':
      return `Завершено сессий: ${details.count ?? 0}`;
    case 'session.revoke':
      return details.own ? 'Своя сессия' : 'Сессия пользователя';
    case 'users.export':
      return `Записей: ${details.count ?? 0}`;
    case 'roles.update':
      return [details.added?.length ? `+ ${details.added.join(', ')}` : '', details.removed?.length ? `− ${details.removed.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Без изменений';
    case 'settings.update':
      return Object.entries(details.changes || {}).map(([key, change]) => `${key}: ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`).join('; ');
    case 'user.password_reset':
      return details.via === 'cli' ? 'Через CLI, сессии завершены' : 'Сессии завершены';
    case 'user.delete':
      return details.self ? 'Удалил сам' : `Роль: ${ROLE_LABELS[details.role] || details.role || '—'}`;
    default:
      return '';
  }
};
