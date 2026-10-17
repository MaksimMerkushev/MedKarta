/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Заголовки безопасности задаются в коде, а не в конфигурации хостинга: так
 * они не теряются при смене хостинга и проверяются тестом.
 *
 * Если HTML отдаёт nginx, а не этот сервер, те же заголовки для страницы
 * должен выставлять nginx (фрагмент — в docs/deployment.md): заголовки на
 * ответах API страницу не защищают.
 */

/**
 * Content-Security-Policy.
 *
 * connect-src — только собственный origin: маршрут считает backend/routing,
 * и браузер не отправляет координаты пользователя третьим сторонам.
 * img-src допускает тайлы OpenStreetMap: по запросу тайла виден лишь
 * открытый участок карты.
 * 'unsafe-inline' в style-src нужен инлайновым стилям Leaflet и React;
 * убрать можно только вместе с переходом на nonce-стили.
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
  "connect-src 'self'",
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

export const API_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  'X-Robots-Tag': 'noindex',
});

/**
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
