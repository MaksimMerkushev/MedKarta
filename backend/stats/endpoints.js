/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Адрес запроса → обезличенная строка статистики: «POST /api/chat»,
 * «GET /api/admin/users/:id». В базу статистики идёт только она: ни параметров
 * запроса, ни id пользователей, токенов и имён файлов.
 *
 * Набор строк ограничен: сегмент, похожий на идентификатор, заменяется на :id,
 * несуществующий адрес (404) считается как «unknown», неизвестный метод — как
 * OTHER, статика — одной строкой. Скрипт, перебирающий случайные адреса, не
 * раздует таблицу и не попадёт в отчёт своими адресами.
 */

import { groupOf } from '../observability/requestStats.js';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const WORD = /^[a-z][a-z-]{0,31}$/;
const MAX_SEGMENTS = 6;

export const STATIC_ENDPOINT = 'static';
export const UNKNOWN_ENDPOINT = 'unknown';

export const endpointOf = (method, path, status) => {
  const clean = String(path || '');
  if (!clean.startsWith('/api/')) return STATIC_ENDPOINT;
  if (status === 404) return UNKNOWN_ENDPOINT;
  const segments = clean.slice(1).split('/').filter(Boolean);
  if (segments.length > MAX_SEGMENTS) return UNKNOWN_ENDPOINT;
  const verb = METHODS.has(method) ? method : 'OTHER';
  return `${verb} /${segments.map((segment) => (WORD.test(segment) ? segment : ':id')).join('/')}`;
};

/** Группа маршрутов для строки статистики — та же, что в разделе «Система». */
export const groupOfEndpoint = (endpoint) => {
  if (endpoint === STATIC_ENDPOINT) return groupOf('/');
  if (endpoint === UNKNOWN_ENDPOINT) return 'Несуществующие адреса';
  return groupOf(endpoint.slice(endpoint.indexOf(' ') + 1));
};
