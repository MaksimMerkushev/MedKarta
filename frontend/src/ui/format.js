/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Форматирование дат и чисел (московское время) и подписи ролей и статусов —
 * общие для профиля и админ-панели.
 */

const TZ = 'Europe/Moscow';

export const formatDateTime = (iso, { seconds = false } = {}) => {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
};

export const formatDate = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
};

const RELATIVE = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
export const formatRelative = (iso, now = Date.now()) => {
  if (!iso) return 'никогда';
  const diff = (new Date(iso).getTime() - now) / 1000;
  if (!Number.isFinite(diff)) return '—';
  const abs = Math.abs(diff);
  if (abs < 45) return 'только что';
  if (abs < 3600) return RELATIVE.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return RELATIVE.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return RELATIVE.format(Math.round(diff / 86400), 'day');
  return formatDate(iso);
};

export const formatNumber = (value) => (Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—');

export const plural = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

export const ROLE_LABELS = { superadmin: 'Суперадминистратор', admin: 'Администратор', moderator: 'Модератор', user: 'Пользователь' };
export const STATUS_LABELS = { active: 'Активен', blocked: 'Заблокирован', archived: 'В архиве' };

export const initialsOf = (name) =>
  String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '·';
