/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сборщик статистики: считает запросы в памяти и раз в минуту дописывает их
 * в базу одной транзакцией. Запрос пользователя базу не трогает, поэтому
 * счётчик не замедляет ответ и не может его сломать: сбой записи — строка в
 * журнале, а данные дождутся следующей попытки (в пределах потолка памяти).
 * При падении процесса теряется не больше минуты.
 *
 * Счётчики процесса (metrics.js) уходят разницей с прошлой записью и только
 * по суткам — почему, сказано в store.js.
 */

import { logger } from '../observability/safeLogger.js';
import { endpointOf } from './endpoints.js';
import { moscowDayKey } from './period.js';
import { LATENCY_BOUNDS, latencyBucket } from './store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Сколько лежит статистика: как активность пользователей (400 дней). */
export const STATS_RETENTION_DAYS = 400;
const MAX_PENDING = 5000;
const OVERFLOW_ENDPOINT = 'unknown';

const emptyRow = (hour, endpoint) => ({
  hour, endpoint, count: 0, s2xx: 0, s3xx: 0, s4xx: 0, s429: 0, s5xx: 0, totalMs: 0, latency: Array(LATENCY_BOUNDS.length + 1).fill(0),
});

/**
 * @param {object} deps
 * @param {() => object|null} deps.getStore база статистики или null (ещё не открыта или недоступна)
 * @param {object} [deps.metrics] счётчики процесса: snapshot().counters
 * @param {() => number} [deps.now]
 */
export const createStatsCollector = ({ getStore, metrics = null, now = () => Date.now(), flushMs = 60_000, maxEndpoints = 300 }) => {
  let pending = new Map();
  const seenEndpoints = new Set();
  let seenHour = null;
  let lastCounters = new Map();
  let timer = null;
  let lastPurgeDay = null;

  const recordRequest = (method, path, status, milliseconds) => {
    const stamp = now();
    const hour = Math.floor(stamp / HOUR) * HOUR;
    if (hour !== seenHour) {
      seenHour = hour;
      seenEndpoints.clear();
    }
    let endpoint = endpointOf(method, path, status);
    if (!seenEndpoints.has(endpoint)) {
      // Потолок строк на час — на случай адресов, которых не предусмотрели.
      if (seenEndpoints.size >= maxEndpoints) endpoint = OVERFLOW_ENDPOINT;
      seenEndpoints.add(endpoint);
    }
    const key = `${hour}|${endpoint}`;
    const row = pending.get(key) || emptyRow(hour, endpoint);
    row.count += 1;
    if (status >= 500) row.s5xx += 1;
    else if (status >= 400) row.s4xx += 1;
    else if (status >= 300) row.s3xx += 1;
    else row.s2xx += 1;
    if (status === 429) row.s429 += 1;
    const duration = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
    row.totalMs += duration;
    row.latency[latencyBucket(duration)] += 1;
    pending.set(key, row);
  };

  /** Разница счётчиков процесса с прошлой записью. Перезапуск обнуляет их — это не отрицательная разница. */
  const metricDeltas = (day) => {
    const counters = metrics?.snapshot().counters || {};
    const rows = [];
    const next = new Map();
    for (const [key, value] of Object.entries(counters)) {
      next.set(key, value);
      const delta = value - (lastCounters.get(key) || 0);
      if (delta > 0) rows.push({ day, key, value: delta });
    }
    return { rows, next };
  };

  const flush = () => {
    const store = getStore();
    if (!store) {
      // База ещё не открыта: копим, но не бесконечно.
      if (pending.size > MAX_PENDING) pending = new Map();
      return false;
    }
    const stamp = now();
    const requests = [...pending.values()];
    const { rows, next } = metricDeltas(moscowDayKey(stamp));
    try {
      store.write({ requests, metrics: rows });
      pending = new Map();
      lastCounters = next;
      const today = moscowDayKey(stamp);
      if (lastPurgeDay !== today) {
        lastPurgeDay = today;
        store.purge({ beforeHour: stamp - STATS_RETENTION_DAYS * DAY, beforeDay: moscowDayKey(stamp - STATS_RETENTION_DAYS * DAY) });
      }
      return true;
    } catch (error) {
      logger.error('stats.flush_failed', error);
      if (pending.size > MAX_PENDING) pending = new Map();
      return false;
    }
  };

  return Object.freeze({
    recordRequest,
    flush,
    start() {
      if (timer) return;
      timer = setInterval(flush, flushMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      flush();
    },
  });
};
