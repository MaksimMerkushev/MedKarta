/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Заголовки безопасности — В КОДЕ, а не в конфигурации хостинга.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ПОЯВИЛСЯ. Весь набор (CSP, HSTS, X-Frame-Options,
 * Referrer-Policy, Permissions-Policy) жил только в `vercel.json`. После
 * переезда на собственный сервер этот файл перестал применяться, а
 * `backend/server.js` не выставлял ни одного заголовка — то есть в проде
 * не было ни защиты от кликджекинга, ни CSP, ни HSTS, и заметить это по
 * коду было невозможно.
 *
 * Держать такие настройки в конфигурации платформы — значит терять их при
 * первом же переезде. Здесь они переживают смену хостинга и проверяются
 * тестом.
 *
 * ВАЖНО ПРО СТАТИКУ: если HTML отдаёт nginx, а не этот сервер, заголовки
 * для страницы обязан выставлять nginx. Готовый фрагмент — в
 * docs/deployment.md. Заголовки на ответах API страницу не защищают.
 */

/**
 * Content-Security-Policy.
 *
 * connect-src перечисляет ровно то, к чему браузеру разрешено обращаться:
 * собственный origin и публичный сервер маршрутизации OSRM. Последний —
 * осознанная уступка: именно туда уходят координаты пользователя при
 * построении маршрута (см. docs/privacy-architecture.md, остаточный риск 6).
 *
 * 'unsafe-inline' в style-src требуется инлайновыми стилями Leaflet и React.
 * Убрать можно только вместе с переходом на nonce-стили.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org",
  "font-src 'self' data:",
  "connect-src 'self' https://routing.openstreetmap.de",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=(), browsing-topics=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-DNS-Prefetch-Control': 'off',
});

/** Заголовки, специфичные для ответов API: их нельзя кэшировать и индексировать. */
export const API_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex',
});

/**
 * Проставляет заголовки на ответ.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{api?: boolean}} [options] true — добавить заголовки для /api/*
 */
export const applySecurityHeaders = (res, { api = false } = {}) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  if (api) {
    for (const [name, value] of Object.entries(API_HEADERS)) {
      res.setHeader(name, value);
    }
  }
};
