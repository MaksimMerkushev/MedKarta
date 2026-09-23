/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Построение маршрута — внутри доверенного контура.
 *
 * ЧТО ЭТОТ ЭНДПОИНТ ЗАКРЫВАЕТ. Раньше геометрию строил публичный демо-сервер
 * OSRM, и браузер отправлял ему точные координаты пользователя и всех точек
 * маршрута. Получался разрыв в логике: внешней языковой модели мы отдаём
 * @HOME вместо адреса, а координаты тем временем уходят третьей стороне,
 * с которой нет договора и которая не связана обязательствами.
 *
 * Теперь координаты доходят только до нашего сервера. Наружу не уходит ничего.
 *
 * КООРДИНАТЫ НЕ ЛОГИРУЮТСЯ. Ни в каком виде, ни на каком уровне: это ровно
 * те данные, ради которых эндпоинт и появился. В журнал идут только число
 * точек, профиль и исход.
 */

import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { checkRouteRateLimit } from '../http/rateLimit.js';
import { getClientIp } from '../http/rateLimit.js';
import { getDefaultRoutingEngine } from '../routing/engine.js';
import { ROUTING_ERROR } from '../routing/engine.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';

/** Больше шести точек интерфейс не строит, и считать их на слабом сервере незачем. */
const MAX_WAYPOINTS = 6;

/** Профили, которые понимает движок. */
const PROFILES = new Set(['driving', 'foot', 'bike']);

/**
 * Рамка допустимых координат.
 *
 * Запрос за пределами региона означает либо ошибку клиента, либо попытку
 * использовать сервис как бесплатный роутер по всему миру. И то и другое
 * отсекается до запуска поиска.
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
    const lat = Number(item?.lat);
    const lng = Number(item?.lng ?? item?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const point = { lat, lng };
    if (!inRegion(point)) return null;
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

  const limit = checkRouteRateLimit(getClientIp(req));
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
    profile = PROFILES.has(body?.profile) ? body.profile : 'driving';
  } catch (error) {
    respondJson(res, error.status || 400, { error: 'Некорректный запрос.' });
    return;
  }

  if (!waypoints) {
    respondJson(res, 400, { error: 'Некорректный список точек.' });
    return;
  }

  const engine = await getDefaultRoutingEngine();
  if (!engine) {
    /*
     * Граф не собран или не читается (причина — в журнале при загрузке).
     * Интерфейс НЕ рисует прямую вместо маршрута, а показывает, что карта
     * дорог недоступна. Код позволяет отличить «нет данных» от «не вышло».
     */
    metrics.increment('routing.unavailable');
    respondJson(res, 503, { error: 'Маршрутизация недоступна.', code: ROUTING_ERROR.NO_GRAPH });
    return;
  }

  const started = Date.now();
  const result = engine.route({ waypoints, profile });
  const latency = Date.now() - started;

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
    respondJson(res, 422, { error: 'Не удалось построить маршрут.', code: result.error });
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
