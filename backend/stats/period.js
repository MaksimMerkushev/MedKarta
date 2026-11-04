/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Период статистики: готовые варианты или свои даты, шаг графика и корзины.
 * Время — московское (UTC+3, без перехода на летнее время): так же считаются
 * сутки у записей и активности пользователей.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MSK = 3 * HOUR;

export const MAX_RANGE_DAYS = 800;
export const MAX_BUCKETS = 400;
export const BUCKETS = Object.freeze(['hour', 'day', 'week', 'month']);

export const moscowDayStart = (ms) => Math.floor((ms + MSK) / DAY) * DAY - MSK;
export const moscowDayKey = (ms) => new Date(ms + MSK).toISOString().slice(0, 10);
const moscowHourStart = (ms) => Math.floor(ms / HOUR) * HOUR;

/** 0 — понедельник … 6 — воскресенье, 0–23 — час; всё по Москве. */
export const moscowWeekdayHour = (ms) => {
  const shifted = new Date(ms + MSK);
  return { weekday: (shifted.getUTCDay() + 6) % 7, hour: shifted.getUTCHours() };
};

const weekStart = (ms) => {
  const day = moscowDayStart(ms);
  return day - moscowWeekdayHour(day).weekday * DAY;
};

const monthStart = (ms, shift = 0) => {
  const shifted = new Date(ms + MSK);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + shift, 1) - MSK;
};

const yearStart = (ms) => Date.UTC(new Date(ms + MSK).getUTCFullYear(), 0, 1) - MSK;

const PRESETS = Object.freeze({
  today: { label: 'Сегодня', range: (now) => [moscowDayStart(now), now] },
  yesterday: { label: 'Вчера', range: (now) => [moscowDayStart(now) - DAY, moscowDayStart(now)] },
  '24h': { label: '24 часа', range: (now) => [moscowHourStart(now) - 23 * HOUR, now] },
  '7d': { label: '7 дней', range: (now) => [moscowDayStart(now) - 6 * DAY, now] },
  '30d': { label: '30 дней', range: (now) => [moscowDayStart(now) - 29 * DAY, now] },
  '90d': { label: '90 дней', range: (now) => [moscowDayStart(now) - 89 * DAY, now] },
  month: { label: 'Этот месяц', range: (now) => [monthStart(now), now] },
  prev_month: { label: 'Прошлый месяц', range: (now) => [monthStart(now, -1), monthStart(now)] },
  year: { label: 'Этот год', range: (now) => [yearStart(now), now] },
});

export const PERIOD_PRESETS = Object.freeze(Object.entries(PRESETS).map(([key, { label }]) => ({ key, label })));
const DEFAULT_PRESET = '7d';

const MOMENT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

/**
 * «2026-11-03» или «2026-11-03T14:30» по Москве → мс. Несуществующая дата
 * («2026-02-31») — null, а не молчаливый перенос на март. Дата без времени в
 * конце периода — до конца этих суток включительно.
 */
const parseMoment = (value, { endOfDay = false } = {}) => {
  const match = typeof value === 'string' ? MOMENT.exec(value) : null;
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const base = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(base);
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  if (hour === undefined) return base - MSK + (endOfDay ? DAY : 0);
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return base - MSK + Number(hour) * HOUR + Number(minute) * 60 * 1000;
};

const autoBucket = (span) => {
  if (span <= 2 * DAY) return 'hour';
  if (span <= 92 * DAY) return 'day';
  if (span <= 400 * DAY) return 'week';
  return 'month';
};

const bucketFloor = (ms, bucket) => {
  if (bucket === 'hour') return moscowHourStart(ms);
  if (bucket === 'day') return moscowDayStart(ms);
  if (bucket === 'week') return weekStart(ms);
  return monthStart(ms);
};

const nextBucket = (start, bucket) => {
  if (bucket === 'hour') return start + HOUR;
  if (bucket === 'day') return start + DAY;
  if (bucket === 'week') return start + 7 * DAY;
  return monthStart(start, 1);
};

/** Начала корзин, покрывающих [from, to). */
export const bucketStarts = (from, to, bucket) => {
  const starts = [];
  for (let start = bucketFloor(from, bucket); start < to; start = nextBucket(start, bucket)) starts.push(start);
  return starts;
};

/** Номер корзины для момента (двоичный поиск) или -1, если момент раньше первой. */
export const bucketIndex = (starts, ms) => {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= ms) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

/** Сутки (ключи ГГГГ-ММ-ДД), которые задевает период [from, to). */
export const daysOf = (from, to) => {
  const days = [];
  for (let start = moscowDayStart(from); start < to; start += DAY) days.push(moscowDayKey(start));
  return days;
};

export class PeriodError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PeriodError';
    this.code = 'bad_period';
  }
}

/**
 * Период из строки запроса: {preset} или {from, to}, необязательно {bucket}.
 * Только собственные ключи: «__proto__» из адреса — не период.
 *
 * @returns {{key: string, label: string, from: number, to: number, bucket: string, bucketRequested: string|null,
 *   bucketAdjusted: boolean, buckets: number[], previous: {from: number, to: number}, days: string[]}}
 */
export const resolvePeriod = ({ preset, from, to, bucket } = {}, now = Date.now()) => {
  let key;
  let label;
  let start;
  let end;
  if (from || to) {
    start = parseMoment(from);
    end = parseMoment(to, { endOfDay: true });
    if (start === null || end === null) throw new PeriodError('Укажите начало и конец периода.');
    end = Math.min(end, now);
    if (start >= end) throw new PeriodError('Начало периода должно быть раньше конца.');
    if (end - start > MAX_RANGE_DAYS * DAY) throw new PeriodError(`Период не длиннее ${MAX_RANGE_DAYS} дней.`);
    key = 'custom';
    label = 'Свой период';
  } else {
    key = typeof preset === 'string' && Object.hasOwn(PRESETS, preset) ? preset : DEFAULT_PRESET;
    label = PRESETS[key].label;
    [start, end] = PRESETS[key].range(now);
  }

  const requested = typeof bucket === 'string' && BUCKETS.includes(bucket) ? bucket : null;
  const automatic = autoBucket(end - start);
  // Слишком мелкий шаг для длинного периода — автоматический, и экран об этом говорит.
  const fits = requested && bucketStarts(start, end, requested).length <= MAX_BUCKETS;
  const chosen = fits ? requested : automatic;

  const span = end - start;
  return {
    key,
    label,
    from: start,
    to: end,
    bucket: chosen,
    bucketRequested: requested,
    bucketAdjusted: Boolean(requested && !fits),
    buckets: bucketStarts(start, end, chosen),
    previous: { from: start - span, to: start },
    days: daysOf(start, end),
  };
};
