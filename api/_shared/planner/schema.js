/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Контракт плана, возвращаемого внешней моделью.
 *
 * ПРИНЦИП. Модель не «описывает словами, что сделать» — она выбирает из
 * конечного множества. Всё, что не перечислено здесь, не существует: нет
 * действия «выполнить запрос», нет поля «SQL», нет свободного текста,
 * попадающего в интерфейс.
 *
 * Свободный текст ответа пользователю формируется детерминированными
 * шаблонами на стороне backend (executor/resultBuilder.js). Модель влияет
 * на формулировку только через перечислимый replyHint. Это сознательный
 * размен: чуть менее живой ответ — зато инъекция не может подсунуть
 * пользователю произвольную фразу вроде «позвоните по номеру…».
 */

/** Разрешённые действия. Полный список, расширяется только осознанно. */
export const ACTIONS = Object.freeze([
  'FIND_DOCTOR',
  'FIND_CLINIC',
  'BUILD_ROUTE',
  'GET_AVAILABLE_SLOTS',
  'SEARCH_SERVICE',
  'CLEAR_FILTERS',
  'CLARIFY',
]);

/**
 * Действия, которых не существует и существовать не должно.
 * Перечислены явно: если модель вернёт любое из них, это фиксируется
 * отдельной метрикой как попытка выхода за границу (см. policyEngine.js).
 * Список не является механизмом защиты — защищает белый список ACTIONS.
 */
export const DENIED_ACTIONS = Object.freeze([
  'RAW_SQL',
  'EXECUTE_QUERY',
  'READ_DATABASE',
  'GET_ALL_PATIENTS',
  'GET_PATIENT_DATABASE',
  'GET_MEDICAL_RECORD',
  'LIST_USERS',
  'EXPORT_DATA',
  'DELETE',
  'UPDATE',
  'ADMIN',
]);

export const STEP_TYPES = Object.freeze(['specific_doctor', 'specific_clinic', 'specialty', 'location']);

export const SELECTIONS = Object.freeze(['nearest', 'best_rated', 'soonest', 'any']);

export const LOCATION_TOKENS = Object.freeze(['@HOME', '@CURRENT_LOCATION', '@WORK']);

export const OWNERSHIPS = Object.freeze(['Государственная', 'Частная']);

export const TRAVEL_MODES = Object.freeze(['driving', 'foot', 'bike']);

export const SORT_MODES = Object.freeze([
  'recommendation', 'rating', 'experience', 'distance', 'schedule', 'name', 'clinic',
]);

/** Перечислимые подсказки для шаблонов ответа. Свободного текста нет. */
export const REPLY_HINTS = Object.freeze([
  'route_built',
  'doctors_found',
  'clinics_found',
  'slots_found',
  'services_found',
  'filters_cleared',
  'need_clarification',
  'out_of_scope',
  'nothing_found',
]);

/** Ключи специальностей из справочника (privacy/catalog.js). */
export const SPECIALTY_KEYS = Object.freeze([
  'therapist', 'neurologist', 'cardiologist', 'lor', 'ophthalmologist', 'surgeon',
  'orthopedist', 'dermatologist', 'gynecologist', 'pediatrician', 'dentist',
  'endocrinologist', 'gastroenterologist', 'urologist', 'psychiatrist', 'traumatologist',
]);

/** Допустимые ключи объекта constraints. Всё прочее — отказ, а не игнор. */
export const CONSTRAINT_KEYS = Object.freeze([
  'available_after',
  'available_before',
  'open_now',
  'weekend',
  'evening',
  'children',
  'wheelchair',
  'online_booking',
  'ownership',
  'district',
  'max_distance_km',
  'min_rating',
  'min_experience_years',
]);

/**
 * Лимиты сложности. Валидный JSON с 10000 остановок — валидный JSON,
 * но не исполнимый план: ограничения проверяются до исполнения.
 */
export const PLAN_LIMITS = Object.freeze({
  MAX_JSON_BYTES: 8 * 1024,
  MAX_DEPTH: 6,
  MAX_STEPS: 5,
  MAX_CONSTRAINT_KEYS: 8,
  MAX_SERVICES: 6,
  MAX_TOKEN_LENGTH: 32,
  MAX_CANDIDATES_PER_STEP: 50,
});

/**
 * JSON Schema для structured output провайдера.
 *
 * Строгая схема на стороне API — первый барьер, но НЕ основной: ответ всё
 * равно проходит validator.js, потому что провайдер может схему не поддержать,
 * деградировать на fallback-модель или просто ошибиться.
 */
export const PLAN_JSON_SCHEMA = Object.freeze({
  name: 'medkarta_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'steps', 'constraints', 'reply_hint'],
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      reply_hint: { type: 'string', enum: [...REPLY_HINTS] },
      steps: {
        type: 'array',
        maxItems: PLAN_LIMITS.MAX_STEPS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: [...STEP_TYPES] },
            token: { type: ['string', 'null'], maxLength: PLAN_LIMITS.MAX_TOKEN_LENGTH },
            specialty: { type: ['string', 'null'], enum: [...SPECIALTY_KEYS, null] },
            selection: { type: ['string', 'null'], enum: [...SELECTIONS, null] },
            constraints: {
              type: ['object', 'null'],
              additionalProperties: false,
              properties: Object.fromEntries(
                CONSTRAINT_KEYS.map((key) => [key, { type: ['string', 'number', 'boolean', 'null'] }]),
              ),
            },
          },
        },
      },
      constraints: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: Object.fromEntries(
          CONSTRAINT_KEYS.map((key) => [key, { type: ['string', 'number', 'boolean', 'null'] }]),
        ),
      },
      travel_mode: { type: ['string', 'null'], enum: [...TRAVEL_MODES, null] },
      sort_mode: { type: ['string', 'null'], enum: [...SORT_MODES, null] },
      services: {
        type: ['array', 'null'],
        maxItems: PLAN_LIMITS.MAX_SERVICES,
        items: { type: 'string', maxLength: 60 },
      },
    },
  },
});
