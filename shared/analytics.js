/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ЗАКРЫТЫЙ СЛОВАРЬ СОБЫТИЙ ПРОДУКТОВОЙ АНАЛИТИКИ.
 *
 * Аналитика нужна, чтобы понять, доходят ли люди от поиска до действия
 * (звонок, сайт, маршрут) и почему не доходят. Для этого НЕ нужны ни текст
 * запроса, ни координаты, ни IP, ни что-либо о самом человеке.
 *
 * Поэтому событие — это только значения из перечислений и ограниченные
 * числа. Свободного текста здесь нет ни в одном поле: строка поиска
 * «болит ухо у сына» — это сведения о здоровье, и в журнал она не попадает
 * даже частично. Всё, что не прошло проверку, отбрасывается целиком.
 *
 * Модуль общий: браузер чистит событие перед отправкой, сервер — повторно
 * при приёме (браузеру доверять нельзя).
 */

import { SPECIALTY_KEYS } from './specialties.js';

export const ANALYTICS_SCHEMA_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  'search',
  'result_open',
  'contact_click',
  'route_build',
  'external_map_click',
  'feedback',
  'data_report',
]);

/** Откуда пришёл поиск: ручные фильтры, ассистент или открытая ссылка. */
export const SEARCH_SOURCES = Object.freeze(['filters', 'assistant', 'url']);
export const ENTITY_KINDS = Object.freeze(['doctor', 'facility']);
export const OWNERSHIP_CODES = Object.freeze(['state', 'private', 'unknown']);
export const OWNERSHIP_FILTERS = Object.freeze(['any', 'state', 'private']);
export const CONTACT_CHANNELS = Object.freeze(['phone', 'website', 'gosuslugi', 'source', 'pult']);
export const EXTERNAL_MAP_PROVIDERS = Object.freeze(['yandex', '2gis']);
export const EXTERNAL_MAP_MODES = Object.freeze(['auto', 'transit', 'foot', 'bike']);
export const ROUTE_MODES = Object.freeze(['driving', 'foot', 'bike']);
export const ROUTE_OUTCOMES = Object.freeze(['ok', 'failed']);
export const FEEDBACK_ANSWERS = Object.freeze(['yes', 'no']);
export const FEEDBACK_CONTEXTS = Object.freeze(['list', 'assistant']);
export const OPEN_SURFACES = Object.freeze(['list', 'map']);

export const FEEDBACK_REASONS = Object.freeze([
  'no_doctor',
  'too_far',
  'bad_time',
  'too_expensive',
  'not_covered',
  'wrong_data',
  'other',
]);

export const DATA_REPORT_REASONS = Object.freeze([
  'closed',
  'wrong_hours',
  'wrong_phone',
  'wrong_address',
  'doctor_left',
  'other',
]);

/** Какие фильтры были включены. Значения фильтров не передаются — только факт. */
export const FILTER_KEYS = Object.freeze([
  'query',
  'profile',
  'facilityType',
  'ownership',
  'clinic',
  'district',
  'services',
  'children',
  'open',
  'weekend',
  'evening',
  'online',
  'wheelchair',
  'favorites',
  'minRating',
  'minExperience',
  'maxDistance',
  'maxTravel',
  'dms',
]);

export const SPECIALTY_CODES = Object.freeze([...SPECIALTY_KEYS, 'other']);

export const ANALYTICS_LIMITS = Object.freeze({
  MAX_BATCH: 20,
  MAX_BODY_BYTES: 8 * 1024,
  MAX_RESULTS: 5000,
  MAX_RANK: 500,
  MAX_STOPS: 6,
  MIN_TRAVEL_MINUTES: 5,
  MAX_TRAVEL_MINUTES: 120,
});

/*
 * Идентификатор сессии — случайная строка из sessionStorage вкладки. Он не
 * связан ни с человеком, ни с идентификатором диалога ассистента и живёт
 * до закрытия вкладки. Нужен только чтобы связать «искал» и «позвонил».
 */
const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/*
 * Идентификатор места из справочника (osm-node-123, verified-mkdc-4). Это
 * ссылка на запись о клинике или враче, а не данные пользователя: без неё
 * нельзя ни исправить запись по жалобе, ни посчитать переходы в клинику.
 */
const PLACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/;

const pick = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);

const integerIn = (value, min, max) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;

const placeId = (value) => (typeof value === 'string' && PLACE_ID_PATTERN.test(value) ? value : null);

const specialty = (value) => (value === null || value === undefined ? null : pick(value, SPECIALTY_CODES));

/** Описание полей каждого события: [имя, проверка, обязательно ли]. */
const FIELDS = {
  search: [
    ['source', (v) => pick(v, SEARCH_SOURCES), true],
    ['specialty', specialty, false],
    ['ownership', (v) => pick(v, OWNERSHIP_FILTERS), false],
    ['filters', (v) => {
      if (!Array.isArray(v) || v.length > FILTER_KEYS.length) return null;
      const known = [...new Set(v.filter((key) => FILTER_KEYS.includes(key)))];
      return known.length === v.length ? known.sort() : null;
    }, true],
    ['results', (v) => integerIn(v, 0, ANALYTICS_LIMITS.MAX_RESULTS), true],
    ['hasLocation', (v) => (typeof v === 'boolean' ? v : null), false],
    ['maxTravel', (v) => integerIn(v, ANALYTICS_LIMITS.MIN_TRAVEL_MINUTES, ANALYTICS_LIMITS.MAX_TRAVEL_MINUTES), false],
    // Выбрана ли программа ДМС — да/нет. Какая именно, в событие не попадает:
    // по программе можно узнать работодателя.
    ['dmsPlan', (v) => (typeof v === 'boolean' ? v : null), false],
  ],
  result_open: [
    ['surface', (v) => pick(v, OPEN_SURFACES), true],
    ['kind', (v) => pick(v, ENTITY_KINDS), true],
    ['ownership', (v) => pick(v, OWNERSHIP_CODES), false],
    ['specialty', specialty, false],
    ['rank', (v) => integerIn(v, 1, ANALYTICS_LIMITS.MAX_RANK), false],
    ['placeId', placeId, false],
  ],
  contact_click: [
    ['channel', (v) => pick(v, CONTACT_CHANNELS), true],
    ['kind', (v) => pick(v, ENTITY_KINDS), true],
    ['ownership', (v) => pick(v, OWNERSHIP_CODES), false],
    ['specialty', specialty, false],
    ['placeId', placeId, false],
  ],
  route_build: [
    ['mode', (v) => pick(v, ROUTE_MODES), true],
    ['stops', (v) => integerIn(v, 1, ANALYTICS_LIMITS.MAX_STOPS), true],
    ['outcome', (v) => pick(v, ROUTE_OUTCOMES), true],
  ],
  external_map_click: [
    ['provider', (v) => pick(v, EXTERNAL_MAP_PROVIDERS), true],
    ['mode', (v) => pick(v, EXTERNAL_MAP_MODES), true],
    ['stops', (v) => integerIn(v, 1, ANALYTICS_LIMITS.MAX_STOPS), true],
    ['placeId', placeId, false],
  ],
  feedback: [
    ['context', (v) => pick(v, FEEDBACK_CONTEXTS), true],
    ['answer', (v) => pick(v, FEEDBACK_ANSWERS), true],
    ['reason', (v) => (v === null || v === undefined ? null : pick(v, FEEDBACK_REASONS)), false],
  ],
  data_report: [
    ['reason', (v) => pick(v, DATA_REPORT_REASONS), true],
    ['kind', (v) => pick(v, ENTITY_KINDS), true],
    ['placeId', placeId, true],
  ],
};

/**
 * Приводит событие к закрытой форме или возвращает null.
 *
 * Правило «всё или ничего»: если обязательное поле не прошло проверку или
 * в объекте есть неизвестный ключ, событие отбрасывается целиком, а не
 * частично. Неизвестный ключ — это либо ошибка клиента, либо попытка
 * протащить в журнал что-то лишнее; в обоих случаях хранить нечего.
 */
export const sanitizeEvent = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const type = pick(raw.type, EVENT_TYPES);
  if (!type) return null;

  const sid = typeof raw.sid === 'string' && SESSION_PATTERN.test(raw.sid) ? raw.sid : null;
  if (!sid) return null;

  const fields = FIELDS[type];
  const allowedKeys = new Set(['type', 'sid', 'v', ...fields.map(([name]) => name)]);
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) return null;

  const event = { v: ANALYTICS_SCHEMA_VERSION, type, sid };
  for (const [name, check, required] of fields) {
    const present = raw[name] !== undefined && raw[name] !== null;
    if (!present) {
      if (required) return null;
      continue;
    }
    const value = check(raw[name]);
    if (value === null) return null;
    event[name] = value;
  }

  // Причина «нет» имеет смысл только у отрицательного ответа.
  if (type === 'feedback' && event.answer === 'yes' && event.reason) return null;

  return event;
};

/** Код формы собственности для событий. */
export const ownershipCode = (value) =>
  value === 'Государственная' ? 'state' : value === 'Частная' ? 'private' : 'unknown';
