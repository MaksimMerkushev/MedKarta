/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Статистика для админ-панели: общий сборщик процесса и отчёт за период.
 *
 * База — рядом с базой аккаунтов (stats.sqlite) или в STATS_DB_PATH; переносится
 * при выкладке вместе с var/. STATS=off выключает сбор: сайт работает как
 * раньше, а раздел показывает, что данных нет. Нет node:sqlite — то же самое.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlite } from '../accounts/sqliteStore.js';
import { metrics } from '../observability/metrics.js';
import { logger } from '../observability/safeLogger.js';
import { createStatsCollector } from './collector.js';
import { moscowDayKey, resolvePeriod } from './period.js';
import { loadProductDays, mergeProductDays } from './product.js';
import { buildAssistantSection, buildRequestsSection } from './report.js';
import { createStatsStore } from './store.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const statsDbPath = (env = process.env) => env.STATS_DB_PATH
  || path.join(path.dirname(env.ACCOUNTS_DB_PATH || path.join(ROOT, 'var', 'accounts', 'medkarta.sqlite')), 'stats.sqlite');

const analyticsDir = (env = process.env) => env.ANALYTICS_DIR || path.join(ROOT, 'var', 'analytics');

let store = null;

export const statsCollector = createStatsCollector({ getStore: () => store, metrics });

/** Открыть базу и запустить запись (при старте сервера). Сбой статистики не мешает сайту. */
export const startStats = async (env = process.env) => {
  if (env.STATS === 'off' || store) return;
  try {
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      logger.warn('stats.unavailable', { reason: 'node_sqlite_missing' });
      return;
    }
    store = createStatsStore({ DatabaseSync, file: statsDbPath(env) });
    statsCollector.start();
    // Сигнал остановки — дописать счётчики и выйти так, как вышел бы процесс без обработчика.
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        statsCollector.stop();
        process.kill(process.pid, signal);
      });
    }
  } catch (error) {
    logger.error('stats.open_failed', error);
    store = null;
  }
};

/**
 * Запросы, ассистент и поиск за период.
 *
 * @param {object} deps
 * @param {object|null} deps.store база статистики
 * @param {string} deps.dir каталог журнала аналитики
 * @param {(id: string) => string|null} [deps.placeName] название места из справочника
 * @param {number|null} [deps.dailyLimit] суточный лимит обращений к модели
 * @param {() => void} [deps.flush] дописать счётчики перед чтением, чтобы цифры были на сейчас
 */
export const collectStats = async ({ store: source, dir, query, now = Date.now(), placeName = () => null, dailyLimit = null, flush = () => {} }) => {
  const period = resolvePeriod(query, now);
  flush();
  const rows = source?.httpRows(period) || [];
  const previousRows = source?.httpRows(period.previous) || [];
  const requests = buildRequestsSection({ period, rows, previousRows });
  const fromDay = period.days[0];
  const toDay = period.days[period.days.length - 1];
  const previousDays = { fromDay: moscowDayKey(period.previous.from), toDay: moscowDayKey(period.previous.to - 1) };
  const assistant = buildAssistantSection({
    period,
    requests,
    metricRows: source?.metricRows({ fromDay, toDay }) || [],
    previousMetricRows: source?.metricRows(previousDays) || [],
    dailyLimit,
  });
  const loaded = await loadProductDays({ dir, store: source, days: period.days, today: moscowDayKey(now) });
  return {
    period,
    requests,
    assistant,
    product: { ...mergeProductDays(loaded, { placeName }), daysWithData: loaded.length },
    coverage: {
      collecting: Boolean(source),
      requestsSince: source?.firstHour() ? new Date(source.firstHour()).toISOString() : null,
      metricsSince: source?.firstMetricDay() || null,
    },
  };
};

/** Названия мест из справочника и демо-набора для списков «чаще всего». Нет справочника — покажем id. */
const placeNames = async () => {
  const names = new Map();
  const add = (items) => {
    for (const item of items || []) if (item?.id != null && item.name) names.set(String(item.id), item.name);
  };
  try {
    const { loadCatalog } = await import('../privacy/catalog.js');
    const catalog = await loadCatalog();
    add(catalog.doctors);
    add(catalog.clinics);
    add(catalog.facilities);
  } catch {
    // Названия — удобство, отчёт работает и без них.
  }
  if (process.env.DEMO_DATA === 'on') {
    try {
      const { getDemoCatalog } = await import('../demo/catalog.js');
      const { catalog } = await getDemoCatalog();
      add(catalog.doctors);
      add(catalog.clinics);
    } catch {
      // То же.
    }
  }
  return (id) => names.get(String(id)) || null;
};

/** То же для приложения: своя база, свой журнал. */
export const defaultCollectStats = async ({ query, now, dailyLimit }) => collectStats({
  store, dir: analyticsDir(), query, now, placeName: await placeNames(), dailyLimit, flush: statsCollector.flush,
});
