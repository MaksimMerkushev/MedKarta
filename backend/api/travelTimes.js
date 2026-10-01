/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Время в пути от одной точки до многих — для фильтра «не дольше N минут».
 *
 * Расстояние по прямой здесь врёт: клиника за Казанкой в двух километрах
 * может быть в двадцати минутах езды. Поэтому интерфейс присылает точку
 * отправления и координаты кандидатов, а сервер за ОДИН обход графа
 * считает реальное время до каждого и останавливается на потолке.
 *
 * Как и /api/route, эндпоинт видит координаты пользователя и НЕ пишет их
 * никуда: в журнал идут только число точек, профиль, потолок и время расчёта.
 */

import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { createRateLimiter, getClientIp, routeCpuLimiter } from '../http/rateLimit.js';
import { getDefaultRoutingEngine, ROUTING_ERROR } from '../routing/engine.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';

export const TRAVEL_LIMITS = Object.freeze({
  MAX_POINTS: 600,
  MIN_MINUTES: 5,
  MAX_MINUTES: 120,
});

const PROFILES = new Set(['driving', 'foot', 'bike']);

/** Та же рамка региона, что у /api/route. */
const REGION = { south: 54.0, west: 47.0, north: 57.5, east: 51.5 };

const inRegion = (lat, lng) =>
  lat >= REGION.south && lat <= REGION.north && lng >= REGION.west && lng <= REGION.east;

const isCoordinate = (lat, lng) =>
  typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng);

/**
 * Фильтр пересчитывается при смене точки, режима и потолка — это десятки
 * запросов за сеанс, а не сотни. Нагрузку на процессор держит routeCpuLimiter.
 */
const checkTravelRateLimit = createRateLimiter({ maxPerIp: 90, maxPerInstance: Number.POSITIVE_INFINITY });

/**
 * Разбирает тело. Точка вне региона не ломает весь запрос — для неё просто
 * нет времени (null), как для недоступной.
 */
export const parseTravelRequest = (body) => {
  const origin = body?.origin;
  if (!origin || !isCoordinate(origin.lat, origin.lng)) return { error: 'bad_origin' };
  if (!inRegion(origin.lat, origin.lng)) return { error: 'outside_region' };

  const mode = body.mode === undefined ? 'driving' : body.mode;
  if (!PROFILES.has(mode)) return { error: 'bad_mode' };

  const minutes = body.maxMinutes;
  if (!Number.isInteger(minutes) || minutes < TRAVEL_LIMITS.MIN_MINUTES || minutes > TRAVEL_LIMITS.MAX_MINUTES) {
    return { error: 'bad_limit' };
  }

  const points = body.points;
  if (!Array.isArray(points) || points.length === 0 || points.length > TRAVEL_LIMITS.MAX_POINTS) {
    return { error: 'bad_points' };
  }

  const destinations = [];
  for (const item of points) {
    if (!Array.isArray(item) || item.length !== 2 || !isCoordinate(item[0], item[1])) return { error: 'bad_points' };
    destinations.push(inRegion(item[0], item[1]) ? { lat: item[0], lng: item[1] } : null);
  }

  return { origin: { lat: origin.lat, lng: origin.lng }, mode, maxMinutes: minutes, destinations };
};

export const createTravelTimesHandler = ({
  getEngine = getDefaultRoutingEngine,
  rateLimit = checkTravelRateLimit,
  cpuLimiter = routeCpuLimiter,
} = {}) =>
  async function travelTimesHandler(req, res) {
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
    const limit = rateLimit(clientIp);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов.', code: 'rate_limited' });
      return;
    }

    let parsed;
    try {
      parsed = parseTravelRequest(await readBody(req));
    } catch (error) {
      respondJson(res, error.status || 400, { error: 'Некорректный запрос.' });
      return;
    }

    if (parsed.error) {
      respondJson(res, 400, { error: 'Некорректный запрос.', code: parsed.error });
      return;
    }

    const engine = await getEngine();
    if (!engine) {
      metrics.increment('travel_times.unavailable');
      respondJson(res, 503, { error: 'Маршрутизация недоступна.', code: ROUTING_ERROR.NO_GRAPH });
      return;
    }

    const cpu = cpuLimiter.check(clientIp);
    if (!cpu.allowed) {
      res.setHeader('Retry-After', String(cpu.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов.', code: 'rate_limited' });
      return;
    }

    const started = Date.now();
    const valid = parsed.destinations.map((point, index) => ({ point, index })).filter(({ point }) => point);
    const estimates = valid.length > 0
      ? await engine.travelTimes(parsed.origin, valid.map(({ point }) => point), parsed.mode, {
        maxSeconds: parsed.maxMinutes * 60,
      })
      : [];
    const latency = Date.now() - started;
    cpuLimiter.charge(clientIp, latency);

    const durations = new Array(parsed.destinations.length).fill(null);
    valid.forEach(({ index }, position) => {
      const seconds = estimates[position]?.durationSeconds;
      durations[index] = Number.isFinite(seconds) ? seconds : null;
    });

    metrics.observe('travel_times.latency_ms', latency);
    logger.event('travel_times.request', {
      // Ни координат, ни их числа после фильтра — только форма запроса.
      count: parsed.destinations.length,
      profile: parsed.mode,
      max_minutes: parsed.maxMinutes,
      latency_ms: latency,
    });

    respondJson(res, 200, { mode: parsed.mode, maxMinutes: parsed.maxMinutes, durations });
  };

export default createTravelTimesHandler();
