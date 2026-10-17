/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Контракт плана внешней модели: модель выбирает из конечного множества, всего
 * неперечисленного не существует — ни действия «выполнить запрос», ни поля
 * «SQL», ни свободного текста для интерфейса.
 *
 * Текст ответа собирают шаблоны (executor/resultBuilder.js), модель влияет на
 * него только перечислимыми полями. Ответ менее живой, зато инъекция не
 * подсунет пользователю фразу вроде «позвоните по номеру…».
 */

/** Белый список действий. */
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
 * Действия, которых нет и быть не должно. Перечислены, чтобы такая попытка
 * отклонялась с отдельным кодом ошибки как выход за границу (validator.js,
 * policyEngine.js). Защищает не этот список, а белый список ACTIONS.
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

/** Перечислимые подсказки вместо свободного текста; шаблоны ответа их не читают. */
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
  // Потолок времени в пути, мин. Фильтрует интерфейс: координаты остаются в браузере.
  'max_travel_minutes',
  // «Есть ДМС»: программа выбирается и проверяется в браузере, серверу она не нужна.
  'dms_only',
  'min_rating',
  'min_experience_years',
]);

/**
 * JSON с 10000 остановок валиден, но не исполним: лимиты проверяются до
 * исполнения. MAX_CANDIDATES_PER_STEP не проверяется (см. COMPLEXITY_BUDGET).
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
 * JSON Schema для structured output — подсказка модели, а не барьер: ответ
 * всё равно проходит validator.js (провайдер может схему не поддержать или
 * ошибиться).
 *
 * strict: false: строгий режим OpenAI требует перечислить в required каждое
 * поле (необязательные — через null), не знает maxLength и на эту схему
 * отвечает 400. Приведение к нему заставило бы модель выписывать все
 * ограничения как null — сотни лишних токенов на запрос.
 * tests/planner-schema.test.js не даст включить strict без такой переделки.
 */
export const PLAN_JSON_SCHEMA = Object.freeze({
  name: 'medkarta_plan',
  strict: false,
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
