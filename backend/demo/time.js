/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Время демо-расписания: Europe/Moscow (Казань живёт по московскому
 * времени, UTC+3, без перехода на летнее время с 2014 года).
 *
 * Все моменты хранятся как миллисекунды UTC, а день и время приёма
 * считаются по Москве: «сегодня», «завтра», «после 18:00» — это московские
 * сутки и часы, где бы ни стоял сервер. Фиксированный сдвиг вместо
 * Intl.DateTimeFormat — намеренно: он одинаков на любом сервере и в тестах.
 */

export const DEMO_TIMEZONE = 'Europe/Moscow';
const OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isDay = (value) => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
export const isTime = (value) => typeof value === 'string' && TIME.test(value);

/** Московские дата и время момента. */
export const moscowParts = (ms) => {
  const shifted = new Date(ms + OFFSET_MS);
  const day = shifted.toISOString().slice(0, 10);
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  // 1 — понедельник … 7 — воскресенье, как в ISO 8601.
  const weekday = ((shifted.getUTCDay() + 6) % 7) + 1;
  return { day, time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, minutes: hours * 60 + minutes, weekday };
};

/** Московская дата момента: ГГГГ-ММ-ДД. */
export const moscowDay = (ms) => moscowParts(ms).day;

/** Момент UTC для московских даты и времени. */
export const moscowMoment = (day, time = '00:00') => {
  if (!isDay(day)) throw new RangeError(`неверная дата «${day}»`);
  const [hours, minutes] = (isTime(time) ? time : '00:00').split(':').map(Number);
  return Date.parse(`${day}T00:00:00Z`) + (hours * 60 + minutes) * 60_000 - OFFSET_MS;
};

/** День через n суток. */
export const addDays = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);

/** День недели даты: 1 — понедельник … 7 — воскресенье. */
export const weekdayOf = (day) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** Номер дня от 1970-01-01 — для детерминированных расчётов по дате. */
export const dayIndex = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/** Минуты от полуночи для «ЧЧ:ММ». */
export const minutesOf = (time) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export const timeOf = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * «Сейчас» для демо. Для воспроизводимых проверок интерфейса время можно
 * заморозить переменной DEMO_NOW — но только вне продакшена: на боевом
 * сервере подставное время сломало бы расписание для всех.
 */
export const demoNow = (env = process.env) => {
  if (env.DEMO_NOW && env.NODE_ENV !== 'production') {
    const frozen = Date.parse(env.DEMO_NOW);
    if (Number.isFinite(frozen)) return frozen;
  }
  return Date.now();
};

export const WEEKDAY_NAMES = Object.freeze(['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье']);
