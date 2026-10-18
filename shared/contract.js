/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Нормализация ответа модели: её вывод недоверенный и управляет состоянием UI, поэтому
 * каждое поле проходит белый список и лимиты длины. Модуль работает и на клиенте
 * (defense in depth).
 */

import { normalizeSearchRequest } from './demoSearch.js';

export const LIMITS = {
  // Всего сообщений в истории (сервер отклоняет больше) и реплик пользователя, которые шлёт клиент.
  MAX_MESSAGES: 40,
  MAX_USER_TURNS: 20,
  MAX_MESSAGE_CHARS: 1000,
  MAX_REPLY_CHARS: 1500,
  MAX_FIELD_CHARS: 80,
  MAX_QUERY_CHARS: 100,
  MAX_STOPS: 5,
  MAX_SERVICES: 6,
  MAX_BODY_BYTES: 32 * 1024,
};

export const OWNERSHIPS = ['Государственная', 'Частная'];
export const TRAVEL_MODES = ['driving', 'foot', 'bike'];
export const CARD_MODES = ['all', 'doctor', 'facility'];
export const SORT_MODES = ['recommendation', 'rating', 'experience', 'distance', 'schedule', 'name', 'clinic', 'price'];

// Управляющие символы, невидимые разделители и bidi-оверрайды: ими маскируют
// инъекции и ломают отображение — поэтому здесь они и есть предмет проверки.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Как cleanText, но сохраняет переводы строк (не больше одной пустой
 * строки подряд): нумерованный список в ответе ассистента иначе
 * склеивается в одну строку.
 */
export const cleanMultilineText = (value, maxLength) => {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
};

export const cleanText = (value, maxLength) => {
  if (typeof value !== 'string') {
    return null;
  }

  const cleaned = value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  return cleaned.slice(0, maxLength);
};

const pickFrom = (value, allowed) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return allowed.includes(trimmed) ? trimmed : null;
};

// Модель может вернуть true/false/null/"true" — приводим к строгому tri-state.
const triState = (value) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
};

const boundedNumber = (value, min, max) => {
  // null и пустая строка остаются null: Number(null) === 0, и незаданный фильтр
  // стал бы реально применённым ограничением (minRating=0, maxDistance=0).
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }

  return Math.min(max, Math.max(min, num));
};

const normalizeStops = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, LIMITS.MAX_STOPS)
    .map((stop) => {
      if (!stop || typeof stop !== 'object') {
        return null;
      }

      const specialty = cleanText(stop.specialty, LIMITS.MAX_FIELD_CHARS);
      const clinic = cleanText(stop.clinic, LIMITS.MAX_FIELD_CHARS);
      // doctor — конкретный врач: иначе маршрут к названному специалисту свёлся бы
      // к любому врачу того же профиля в той же клинике.
      const doctor = cleanText(stop.doctor, LIMITS.MAX_FIELD_CHARS);
      if (!specialty && !clinic && !doctor) {
        return null;
      }

      return { specialty, clinic, doctor };
    })
    .filter(Boolean);
};

const normalizeServices = (value) => {
  if (!Array.isArray(value)) {
    return null;
  }

  const services = value
    .map((service) => cleanText(service, LIMITS.MAX_FIELD_CHARS))
    .filter(Boolean)
    .slice(0, LIMITS.MAX_SERVICES);

  return services.length > 0 ? services : null;
};

/*
 * Запрос строгого подбора демо-записи (backend/demo/chatBridge.js).
 * Нормализуется тем же модулем, что и на сервере подбора: в интерфейс не
 * попадает ни неизвестный ключ, ни строка произвольной длины.
 */
const sanitizeBooking = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { request } = normalizeSearchRequest(value.request);
  const summary = Array.isArray(value.summary)
    ? value.summary.map((item) => cleanText(item, LIMITS.MAX_FIELD_CHARS)).filter(Boolean).slice(0, 20)
    : [];
  // route — маршрут просили явно: интерфейс проложит его к первому варианту подбора.
  return { request, summary, route: value.route === true };
};

export const DEFAULT_REPLY =
  'Готово! Посмотрите на карту — я применил подходящие фильтры.';

/**
 * Приводит произвольный объект от модели к строго типизированному «действию».
 * Всё, что не прошло проверку, становится null и просто игнорируется в UI.
 */
export const sanitizeAiAction = (raw) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  return {
    searchQuery: cleanText(source.searchQuery, LIMITS.MAX_QUERY_CHARS),
    specialty: cleanText(source.specialty, LIMITS.MAX_FIELD_CHARS),
    service: cleanText(source.service, LIMITS.MAX_FIELD_CHARS),
    clinic: cleanText(source.clinic, LIMITS.MAX_FIELD_CHARS),
    facilityType: cleanText(source.facilityType, LIMITS.MAX_FIELD_CHARS),
    doctorProfile: cleanText(source.doctorProfile, LIMITS.MAX_FIELD_CHARS),
    district: cleanText(source.district, LIMITS.MAX_FIELD_CHARS),
    services: normalizeServices(source.services),
    targetStops: normalizeStops(source.targetStops),

    ownership: pickFrom(source.ownership, OWNERSHIPS),
    travelMode: pickFrom(source.travelMode, TRAVEL_MODES),
    cardDisplayMode: pickFrom(source.cardDisplayMode, CARD_MODES),
    sortMode: pickFrom(source.sortMode, SORT_MODES),

    isChild: triState(source.isChild) === true,
    buildRoute: triState(source.buildRoute) === true,
    clearRoute: triState(source.clearRoute) === true,
    clearFilters: triState(source.clearFilters) === true,

    openOnly: triState(source.openOnly),
    favoritesOnly: triState(source.favoritesOnly),
    weekendOnly: triState(source.weekendOnly),
    eveningOnly: triState(source.eveningOnly),
    onlineOnly: triState(source.onlineOnly),
    wheelchairOnly: triState(source.wheelchairOnly),
    darkMode: triState(source.darkMode),

    minRating: boundedNumber(source.minRating, 0, 5),
    minExperience: boundedNumber(source.minExperience, 0, 40),
    maxDistance: boundedNumber(source.maxDistance, 0, 50),
    // Потолок времени в пути: целое число минут или null. Ноль и мусор — null,
    // а не «5 минут»: незаданный фильтр не должен превращаться в заданный.
    maxTravelMinutes: Number.isInteger(source.maxTravelMinutes) && source.maxTravelMinutes >= 5 && source.maxTravelMinutes <= 120
      ? source.maxTravelMinutes
      : null,
    dmsOnly: triState(source.dmsOnly) === true,
    booking: sanitizeBooking(source.booking),

    replyText: cleanMultilineText(source.replyText, LIMITS.MAX_REPLY_CHARS) || DEFAULT_REPLY,
  };
};

/**
 * Проверяет историю чата, пришедшую от клиента, перед отправкой в модель.
 * Кидает Error с полем `status`, если данные не годятся.
 */
export const validateChatMessages = (value) => {
  if (!Array.isArray(value) || value.length === 0) {
    const error = new Error('Ожидается непустой массив messages.');
    error.status = 400;
    throw error;
  }

  if (value.length > LIMITS.MAX_MESSAGES) {
    const error = new Error('Слишком длинная история диалога.');
    error.status = 400;
    throw error;
  }

  const messages = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const role = item.role === 'user' ? 'user' : 'assistant';
    const content = cleanText(item.content, LIMITS.MAX_MESSAGE_CHARS);
    if (content) {
      messages.push({ role, content });
    }
  }

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    const error = new Error('Последнее сообщение должно быть от пользователя.');
    error.status = 400;
    throw error;
  }

  return messages;
};
