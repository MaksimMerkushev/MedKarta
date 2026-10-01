/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Приём событий продуктовой аналитики.
 *
 * Эндпоинт принимает пачку событий из закрытого словаря (shared/analytics.js)
 * и пишет в журнал только то, что прошло проверку. Ответ всегда 204, если
 * запрос в целом корректен: браузеру незачем знать, какие события
 * отброшены, а отправка через sendBeacon ответ всё равно не читает.
 *
 * IP-адрес используется только для лимита запросов в памяти и никуда не
 * записывается.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANALYTICS_LIMITS, sanitizeEvent } from '../../shared/analytics.js';
import { createEventStore } from '../analytics/eventStore.js';
import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Обычная сессия — десятки событий за несколько минут; пачками по 20 это
 * единицы запросов. 120 запросов за 5 минут с адреса — с большим запасом
 * для офиса за одним NAT и без простора для заливки журнала мусором.
 */
const checkEventsRateLimit = createRateLimiter({ maxPerIp: 120, maxPerInstance: Number.POSITIVE_INFINITY });

let defaultStore = null;

const getDefaultStore = () => {
  if (process.env.ANALYTICS === 'off') return null;
  defaultStore ||= createEventStore({
    dir: process.env.ANALYTICS_DIR || path.join(ROOT, 'var', 'analytics'),
    maxEventsPerDay: Number(process.env.ANALYTICS_MAX_EVENTS_PER_DAY) || undefined,
    retentionDays: Number(process.env.ANALYTICS_RETENTION_DAYS) || undefined,
    logger,
  });
  return defaultStore;
};

/** Принимает и одно событие, и {events: [...]}. */
const unpack = (body) => {
  if (Array.isArray(body?.events)) return body.events;
  if (body && typeof body === 'object' && typeof body.type === 'string') return [body];
  return null;
};

/**
 * @param {object} [deps] для тестов: свой журнал вместо файлового
 */
export const createEventsHandler = ({ store = undefined, rateLimit = checkEventsRateLimit } = {}) =>
  async function eventsHandler(req, res) {
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

    const limit = rateLimit(getClientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов.' });
      return;
    }

    let raw;
    try {
      raw = unpack(await readBody(req, ANALYTICS_LIMITS.MAX_BODY_BYTES));
    } catch (error) {
      respondJson(res, error.status || 400, { error: 'Некорректный запрос.' });
      return;
    }

    if (!raw || raw.length === 0 || raw.length > ANALYTICS_LIMITS.MAX_BATCH) {
      respondJson(res, 400, { error: 'Некорректный запрос.' });
      return;
    }

    const events = raw.map(sanitizeEvent).filter(Boolean);
    const rejected = raw.length - events.length;
    if (rejected > 0) metrics.increment('analytics.rejected', {}, rejected);

    const target = store === undefined ? getDefaultStore() : store;
    if (target && events.length > 0) {
      try {
        const { accepted } = await target.append(events);
        metrics.increment('analytics.accepted', {}, accepted);
      } catch (error) {
        // Аналитика не должна ломать продукт: ошибка записи — только в журнал.
        logger.error('analytics.write_failed', error);
      }
    }

    res.statusCode = 204;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  };

export default createEventsHandler();
