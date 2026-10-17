/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Построение маршрута внутри доверенного контура: координаты пользователя и
 * точек маршрута доходят только до нашего сервера и третьим сторонам не
 * уходят — даже внешняя модель видит адрес только как @HOME.
 *
 * Координаты не логируются ни в каком виде: в журнал идут только число точек,
 * исход и время расчёта.
 */

import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { checkRouteRateLimit, heavyWork, ROUTING_LOAD_SHARE, routeCpuLimiter } from '../http/rateLimit.js';
import { getClientIp } from '../http/rateLimit.js';
import { getDefaultRoutingEngine } from '../routing/engine.js';
import { ROUTING_ERROR } from '../routing/engine.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';

/** Больше шести точек интерфейс не строит, и считать их на слабом сервере незачем. */
const MAX_WAYPOINTS = 6;

const PROFILES = new Set(['driving', 'foot', 'bike']);

/*
 * Рамка допустимых координат. Точка вне региона — ошибка клиента или попытка
 * использовать сервис как бесплатный роутер; отсекается до запуска поиска.
 */
const REGION = { south: 54.0, west: 47.0, north: 57.5, east: 51.5 };

const inRegion = (point) =>
  point.lat >= REGION.south && point.lat <= REGION.north &&
  point.lng >= REGION.west && point.lng <= REGION.east;

const parseWaypoints = (raw) => {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_WAYPOINTS) {
    return null;
  }

  const points = [];
  for (const item of raw) {
    // Только числа: Number() принял бы и «"55.79"», «[[55.79]]», «"0x37"».
    const lat = item?.lat;
    const lng = item?.lng ?? item?.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const point = { lat, lng };
    // Отдельный код: иначе пользователь с геолокацией в другом городе видит
    // «маршрут для этого транспорта не найден» вместо настоящей причины.
    if (!inRegion(point)) return { outside: true };
    points.push(point);
  }
  return points;
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    respondJson(res, 405, { error: 'Метод не поддерживается.' });
    return;
  }

  if (!verifyOrigin(req)) {
    respondJson(res, 403, { error: 'Запрос отклонён.' });
    return;
  }

  const clientIp = getClientIp(req);
  const limit = checkRouteRateLimit(clientIp);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    respondJson(res, 429, { error: 'Слишком много запросов маршрута.' });
    return;
  }

  let waypoints;
  let profile;
  try {
    const body = await readBody(req);
    waypoints = parseWaypoints(body?.waypoints);
    // Неизвестный профиль — ошибка клиента, а не молчаливая машина.
    profile = body?.profile === undefined ? 'driving' : PROFILES.has(body.profile) ? body.profile : null;
  } catch (error) {
    respondJson(res, error.status || 400, { error: 'Некорректный запрос.' });
    return;
  }

  if (waypoints?.outside) {
    respondJson(res, 400, { error: 'Точка вне зоны обслуживания.', code: 'outside_region' });
    return;
  }
  if (!waypoints || !profile) {
    respondJson(res, 400, { error: 'Некорректный список точек.' });
    return;
  }

  const engine = await getDefaultRoutingEngine();
  if (!engine) {
    /*
     * Граф не собран или не читается (причина — в журнале при загрузке).
     * Интерфейс не рисует прямую вместо маршрута, а сообщает, что карта дорог
     * недоступна; код отличает «нет данных» от «не вышло».
     */
    metrics.increment('routing.unavailable');
    respondJson(res, 503, { error: 'Маршрутизация недоступна.', code: ROUTING_ERROR.NO_GRAPH });
    return;
  }

  // Бюджет процессора — перед самым расчётом, а не при входе: иначе
  // одновременные запросы одного адреса проходят проверку, пока первый считается.
  const cpu = routeCpuLimiter.check(clientIp);
  if (!cpu.allowed) {
    res.setHeader('Retry-After', String(cpu.retryAfterSeconds));
    respondJson(res, 429, { error: 'Слишком много запросов маршрута.', code: 'rate_limited' });
    return;
  }

  if (!heavyWork.allows(Date.now(), ROUTING_LOAD_SHARE)) {
    res.setHeader('Retry-After', String(heavyWork.retryAfterSeconds));
    respondJson(res, 503, { error: 'Сервер перегружен. Попробуйте через несколько секунд.', code: 'busy' });
    return;
  }

  const started = Date.now();
  const result = engine.route({ waypoints, profile });
  const latency = Date.now() - started;
  routeCpuLimiter.charge(clientIp, latency);
  heavyWork.record(latency);

  metrics.observe('routing.latency_ms', latency, { provider: 'local' });
  logger.event('routing.request', {
    // Координат здесь нет и быть не должно — только форма запроса.
    count: waypoints.length,
    provider: 'local',
    status: result.ok ? 'success' : 'rejected',
    reason: result.ok ? null : result.error,
    latency_ms: latency,
  });

  if (!result.ok) {
    metrics.increment('routing.failed', { code: result.error });
    respondJson(res, 422, {
      error: 'Не удалось построить маршрут.',
      code: result.error,
      // Номер точки, которую не удалось поставить на дорогу (0 — старт).
      ...(Number.isInteger(result.index) ? { point: result.index } : {}),
    });
    return;
  }

  respondJson(res, 200, {
    geometry: result.geometry,
    distance: result.distanceM,
    time: result.durationS,
    profile: result.profile,
    // Точки выхода на дорогу — для пунктирной подводки от здания до улицы.
    // Это проекции тех же координат, что прислал клиент: нового о нём не сообщают.
    snaps: result.snaps,
  });
}
