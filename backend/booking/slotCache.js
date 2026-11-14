/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Свободное время для подбора: freeSlots({ pairs, fromDay, toDay, at }) →
 * Map «врач|филиал» → слоты по времени — как у демо-хранилища.
 *
 *   — коннектор со своей базой (localSlots, демо) читается напрямую, без кэша;
 *   — внешний (МИС, интегратор) — через кэш в памяти, чтобы подбор не ходил в
 *     МИС на каждый поиск. Пара «врач × филиал» загружается на окно в 14 дней
 *     от «сегодня» и обновляется не чаще раза в ttlMs (10 минут). МИС не
 *     ответила — отдаётся прежний ответ не старше staleMs (30 минут), старше —
 *     у пары нет свободного времени: пустой подбор честнее давно занятого слота.
 *
 * Свои изменения (удержание, запись, отмена) сбрасывают кэш пары сразу —
 * invalidateSlot, в том числе при отказе: слот могли занять в МИС мимо нас.
 * Чужие записи в МИС видны после следующего обновления.
 */

import { addDays, moscowDay } from '../demo/time.js';

export const SLOT_CACHE_TTL_MS = 10 * 60 * 1000;
export const SLOT_CACHE_STALE_MS = 30 * 60 * 1000;
export const SLOT_CACHE_WINDOW_DAYS = 14;
const MAX_PAIRS = 5000;

const pairKey = (doctorId, branchId) => `${doctorId}|${branchId}`;
const byStart = (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt);

/** Слоты списком → Map «врач|филиал» → слоты; только запрошенные пары, порядок — как в списке. */
export const groupByPair = (slots, pairs) => {
  const wanted = new Set(pairs.map((pair) => pairKey(pair.doctorId, pair.branchId)));
  const result = new Map();
  for (const slot of slots) {
    const key = pairKey(slot.doctorId, slot.branchId);
    if (!wanted.has(key)) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(slot);
  }
  return result;
};

/** Без кэша: слоты коннектора со своей базой и так актуальны на момент запроса. */
export const createLocalSlotSource = (connector) => Object.freeze({
  freeSlots: async (query) => groupByPair(await connector.listSlots(query), query.pairs),
  invalidateSlot: () => {},
  invalidateAll: () => {},
  stats: () => null,
});

/** Коннектор без свободного времени (заявка): подбор не находит слотов, а не падает. */
const NO_SLOTS = Object.freeze({
  freeSlots: async () => new Map(),
  invalidateSlot: () => {},
  invalidateAll: () => {},
  stats: () => null,
});

/**
 * @param {object} options
 * @param {object} options.connector коннектор с can.slots (defineConnector)
 * @param {Function} [options.clock] настоящее время для срока кэша, мс (не демо-время)
 * @param {Function} [options.onError] ошибка загрузки — в журнал
 */
export const createSlotCache = ({
  connector,
  ttlMs = SLOT_CACHE_TTL_MS,
  staleMs = SLOT_CACHE_STALE_MS,
  windowDays = SLOT_CACHE_WINDOW_DAYS,
  maxPairs = MAX_PAIRS,
  clock = () => Date.now(),
  onError = () => {},
}) => {
  // «врач|филиал» → { loadedAt, fromDay, slots }; порядок вставки — для вытеснения самых старых.
  const entries = new Map();
  const pairOfSlot = new Map();
  // Пара уже загружается — второй поиск ждёт ту же загрузку, а не идёт в МИС ещё раз.
  const pending = new Map();
  const counters = { hits: 0, misses: 0, errors: 0 };

  const forget = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    for (const slot of entry.slots) {
      if (pairOfSlot.get(slot.id) === key) pairOfSlot.delete(slot.id);
    }
    entries.delete(key);
  };

  const remember = (key, entry) => {
    forget(key);
    entries.set(key, entry);
    for (const slot of entry.slots) pairOfSlot.set(slot.id, key);
    while (entries.size > maxPairs) forget(entries.keys().next().value);
  };

  const load = async (due, fromDay, toDay, at, loadedAt) => {
    const pairs = due.map(([, pair]) => pair);
    try {
      const grouped = groupByPair(await connector.listSlots({ pairs, fromDay, toDay, at }), pairs);
      for (const [key] of due) remember(key, { loadedAt, fromDay, slots: [...(grouped.get(key) || [])].sort(byStart) });
    } catch (error) {
      counters.errors += 1;
      onError(error);
      for (const [key] of due) {
        if (entries.has(key) && loadedAt - entries.get(key).loadedAt >= staleMs) forget(key);
      }
    }
  };

  const freeSlots = async ({ pairs, fromDay, toDay, at = Date.now() }) => {
    const today = moscowDay(at);
    const now = clock();
    const unique = new Map(pairs.map((pair) => [pairKey(pair.doctorId, pair.branchId), pair]));
    const due = [...unique].filter(([key]) => {
      const entry = entries.get(key);
      return !(entry && entry.fromDay === today && now - entry.loadedAt < ttlMs);
    });
    counters.hits += unique.size - due.length;
    counters.misses += due.length;

    const waits = [];
    const toLoad = due.filter(([key]) => {
      if (!pending.has(key)) return true;
      waits.push(pending.get(key));
      return false;
    });
    if (toLoad.length > 0) {
      const job = load(toLoad, today, addDays(today, windowDays - 1), at, now);
      for (const [key] of toLoad) pending.set(key, job);
      waits.push(job.finally(() => {
        for (const [key] of toLoad) if (pending.get(key) === job) pending.delete(key);
      }));
    }
    await Promise.all(waits);

    const result = new Map();
    for (const key of unique.keys()) {
      const slots = (entries.get(key)?.slots || []).filter((slot) => slot.day >= fromDay && slot.day <= toDay && Date.parse(slot.startAt) > at);
      if (slots.length > 0) result.set(key, slots);
    }
    return result;
  };

  /** Слот изменился у нас (удержан, записан, отменён) — пара перечитывается при следующем поиске. */
  const invalidateSlot = (slotId) => {
    const key = pairOfSlot.get(slotId);
    if (key) forget(key);
  };

  /** Расписание изменилось в МИС (синхронизация, webhook) — всё перечитывается при следующем поиске. */
  const invalidateAll = () => {
    for (const key of [...entries.keys()]) forget(key);
  };

  const stats = () => ({ pairs: entries.size, ...counters });

  return Object.freeze({ freeSlots, invalidateSlot, invalidateAll, stats });
};

/** Источник слотов для подбора — по возможностям коннектора. */
export const createSlotSource = ({ connector, ...options }) => {
  if (!connector.can.slots) return NO_SLOTS;
  // Маршрутизатор коннекторов (booking/mis/router.js) собирает свой источник: демо — напрямую, МИС — через кэш.
  if (typeof connector.createSlotSource === 'function') return connector.createSlotSource(options);
  return connector.localSlots ? createLocalSlotSource(connector) : createSlotCache({ connector, ...options });
};
