/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * База статистики: отдельный файл SQLite, только сводные счётчики.
 *
 * Отдельно от базы аккаунтов намеренно: схеме аккаунтов не нужна миграция (и
 * откат выкладки остаётся безопасным), а частая запись счётчиков не касается
 * файла с персональными данными и его резервных копий.
 *
 *   http_hourly   — запросы по часам и строкам endpoints.js: число, классы
 *                   ответов, суммарное время и гистограмма времени ответа;
 *   metric_daily  — счётчики процесса (metrics.js) по суткам. Только по суткам:
 *                   среди них признаки здоровья (триаж, срочные случаи), и
 *                   почасовая строка при малом трафике сопоставлялась бы по
 *                   времени с журналом nginx;
 *   product_daily — свод журнала аналитики за завершённые сутки: чтобы отчёт
 *                   за полгода не перечитывал все файлы.
 *
 * Людей здесь нет: ни адресов, ни id пользователей и сессий, ни текста запросов.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Границы корзин времени ответа, мс; последняя корзина — всё, что дольше. */
export const LATENCY_BOUNDS = Object.freeze([25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
const LATENCY_COLUMNS = Array.from({ length: LATENCY_BOUNDS.length + 1 }, (_, index) => `b${index}`);
const COUNTERS = ['count', 's2xx', 's3xx', 's4xx', 's429', 's5xx', 'total_ms', ...LATENCY_COLUMNS];

const SCHEMA_VERSION = 1;
const SCHEMA = `
  CREATE TABLE http_hourly (
    hour INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    ${COUNTERS.map((column) => `${column} INTEGER NOT NULL DEFAULT 0`).join(',\n    ')},
    PRIMARY KEY (hour, endpoint)
  ) WITHOUT ROWID;
  CREATE TABLE metric_daily (
    day TEXT NOT NULL,
    key TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key)
  ) WITHOUT ROWID;
  CREATE TABLE product_daily (
    day TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    summary TEXT NOT NULL
  ) WITHOUT ROWID;
`;

export const latencyBucket = (milliseconds) => {
  const index = LATENCY_BOUNDS.findIndex((bound) => milliseconds <= bound);
  return index === -1 ? LATENCY_BOUNDS.length : index;
};

const toHttpRow = (row) => ({
  hour: row.hour,
  endpoint: row.endpoint,
  count: row.count,
  s2xx: row.s2xx,
  s3xx: row.s3xx,
  s4xx: row.s4xx,
  s429: row.s429,
  s5xx: row.s5xx,
  totalMs: row.total_ms,
  latency: LATENCY_COLUMNS.map((column) => row[column]),
});

export const createStatsStore = ({ DatabaseSync, file }) => {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Том без прав доступа — не повод падать.
    }
    db.exec('PRAGMA journal_mode = WAL;');
  }
  db.exec('PRAGMA busy_timeout = 3000;');
  if (db.prepare('PRAGMA user_version').get().user_version === 0) {
    db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
  }

  const addRequest = db.prepare(`INSERT INTO http_hourly (hour, endpoint, ${COUNTERS.join(', ')})
    VALUES (?, ?, ${COUNTERS.map(() => '?').join(', ')})
    ON CONFLICT(hour, endpoint) DO UPDATE SET ${COUNTERS.map((column) => `${column} = ${column} + excluded.${column}`).join(', ')}`);
  const addMetric = db.prepare(`INSERT INTO metric_daily (day, key, value) VALUES (?, ?, ?)
    ON CONFLICT(day, key) DO UPDATE SET value = value + excluded.value`);

  return Object.freeze({
    /** Пачка счётчиков одной транзакцией: {requests: [...], metrics: [...]}. */
    write({ requests = [], metrics = [] }) {
      if (requests.length === 0 && metrics.length === 0) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of requests) {
          addRequest.run(row.hour, row.endpoint, row.count, row.s2xx, row.s3xx, row.s4xx, row.s429, row.s5xx, Math.round(row.totalMs), ...row.latency);
        }
        for (const row of metrics) addMetric.run(row.day, row.key, row.value);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    httpRows: ({ from, to }) => db.prepare('SELECT * FROM http_hourly WHERE hour >= ? AND hour < ?').all(from, to).map(toHttpRow),
    metricRows: ({ fromDay, toDay }) => db.prepare('SELECT day, key, value FROM metric_daily WHERE day >= ? AND day <= ?').all(fromDay, toDay),
    firstHour: () => db.prepare('SELECT MIN(hour) AS hour FROM http_hourly').get().hour ?? null,
    firstMetricDay: () => db.prepare('SELECT MIN(day) AS day FROM metric_daily').get().day ?? null,
    productDay(day, version) {
      const row = db.prepare('SELECT summary FROM product_daily WHERE day = ? AND version = ?').get(day, version);
      if (!row) return null;
      try {
        return JSON.parse(row.summary);
      } catch {
        return null;
      }
    },
    saveProductDay: (day, version, summary) => {
      db.prepare(`INSERT INTO product_daily (day, version, summary) VALUES (?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET version = excluded.version, summary = excluded.summary`).run(day, version, JSON.stringify(summary));
    },
    purge({ beforeHour, beforeDay }) {
      db.prepare('DELETE FROM http_hourly WHERE hour < ?').run(beforeHour);
      db.prepare('DELETE FROM metric_daily WHERE day < ?').run(beforeDay);
      db.prepare('DELETE FROM product_daily WHERE day < ?').run(beforeDay);
    },
    close: () => db.close(),
  });
};
