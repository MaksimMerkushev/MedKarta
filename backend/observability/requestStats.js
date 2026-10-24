/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Счётчики запросов для мониторинга в админ-панели: число, коды ответа и
 * задержка по группам маршрутов, плюс поминутная история за сутки. Только
 * в памяти процесса и с момента его запуска: путь запроса сводится к группе,
 * адреса, параметры и тела не сохраняются.
 */

const MAX_SAMPLES = 500;
const MINUTES = 24 * 60;

const GROUPS = [
  [/^\/api\/chat$/, 'Ассистент'],
  [/^\/api\/(route|travel-times)$/, 'Маршруты'],
  [/^\/api\/auth\//, 'Вход'],
  [/^\/api\/account/, 'Кабинет'],
  [/^\/api\/me(\/|$)/, 'Профиль'],
  [/^\/api\/admin(\/|$)/, 'Админ-панель'],
  [/^\/api\/demo\//, 'Демо-запись'],
  [/^\/api\/(events|config)$/, 'Служебные'],
  [/^\/api\//, 'Прочие API'],
];

export const groupOf = (path) => GROUPS.find(([pattern]) => pattern.test(path))?.[1] || 'Статика';

const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

export const createRequestStats = ({ now = () => Date.now() } = {}) => {
  const startedAt = now();
  const groups = new Map();
  // Кольцо поминутных счётчиков: [минута, запросов, ошибок 5xx].
  const minutes = new Map();

  return Object.freeze({
    record(path, status, milliseconds) {
      const name = groupOf(path);
      const entry = groups.get(name) || { count: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, samples: [], totalMs: 0 };
      entry.count += 1;
      const klass = `${Math.min(Math.max(Math.floor(status / 100), 2), 5)}xx`;
      entry.status[klass] += 1;
      entry.totalMs += milliseconds;
      entry.samples.push(milliseconds);
      if (entry.samples.length > MAX_SAMPLES) entry.samples.splice(0, entry.samples.length - MAX_SAMPLES);
      groups.set(name, entry);

      const minute = Math.floor(now() / 60_000);
      const bucket = minutes.get(minute) || [minute, 0, 0];
      bucket[1] += 1;
      if (status >= 500) bucket[2] += 1;
      minutes.set(minute, bucket);
      if (minutes.size > MINUTES + 5) {
        for (const key of minutes.keys()) {
          if (key < minute - MINUTES) minutes.delete(key);
        }
      }
    },
    snapshot() {
      // Часы по часам: последние 24, текущий — неполный.
      const hour = Math.floor(now() / 3_600_000);
      const perHour = Array.from({ length: 24 }, (_, index) => {
        const hourStart = (hour - (23 - index)) * 60;
        let count = 0;
        let errors = 0;
        for (let step = 0; step < 60; step += 1) {
          const bucket = minutes.get(hourStart + step);
          if (bucket) {
            count += bucket[1];
            errors += bucket[2];
          }
        }
        return { start: new Date((hourStart) * 60_000).toISOString(), count, errors };
      });
      const items = [...groups].map(([name, entry]) => ({
        group: name,
        count: entry.count,
        status: entry.status,
        avgMs: entry.count ? Math.round(entry.totalMs / entry.count) : null,
        p50Ms: Math.round(percentile(entry.samples, 0.5) ?? 0),
        p95Ms: Math.round(percentile(entry.samples, 0.95) ?? 0),
      })).sort((left, right) => right.count - left.count);
      return {
        since: new Date(startedAt).toISOString(),
        total: items.reduce((sum, item) => sum + item.count, 0),
        errors5xx: items.reduce((sum, item) => sum + item.status['5xx'], 0),
        errors4xx: items.reduce((sum, item) => sum + item.status['4xx'], 0),
        groups: items,
        perHour,
      };
    },
  });
};

export const requestStats = createRequestStats();
