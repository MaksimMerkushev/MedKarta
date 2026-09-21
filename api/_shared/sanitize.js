/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Единая нормализация ответа модели.
 * Модель — недоверенный источник: её вывод управляет состоянием UI,
 * поэтому каждое поле проходит через белый список и жёсткие лимиты длины.
 * Тот же модуль переиспользуется на клиенте (defense in depth).
 */

export const LIMITS = {
  MAX_MESSAGES: 12,
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
export const SORT_MODES = ['recommendation', 'rating', 'experience', 'distance', 'schedule', 'name', 'clinic'];

// Управляющие символы, невидимые разделители и bidi-оверрайды: ими маскируют
// инъекции в тексте и ломают отображение. Оставляем только печатаемое.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

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
  // null и пустая строка должны остаться null: Number(null) === 0, и без этой
  // проверки незаданный фильтр превращался в minRating=0, minExperience=0,
  // maxDistance=0 — то есть в реально применённое ограничение.
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
      // doctor добавлен, чтобы остановка могла указывать на конкретного врача,
      // а не только на пару «профиль + клиника»: иначе маршрут к названному
      // специалисту сводился бы к любому врачу того же профиля в той же клинике.
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

    replyText: cleanText(source.replyText, LIMITS.MAX_REPLY_CHARS) || DEFAULT_REPLY,
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
