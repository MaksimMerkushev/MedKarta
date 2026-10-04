/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Валидация ответа внешней модели.
 *
 * ВЫВОД МОДЕЛИ — ЭТО НЕДОВЕРЕННЫЙ ПОЛЬЗОВАТЕЛЬСКИЙ ВВОД.
 * Даже синтаксически корректный JSON здесь не имеет привилегий: он приходит
 * из-за границы доверия и мог быть сформирован под влиянием инъекции в тексте
 * пользователя. Поэтому проверяется не только форма, но и семантика, а
 * неизвестные поля вызывают ОТКАЗ, а не молчаливое отбрасывание: молчаливое
 * отбрасывание скрывает от нас факт попытки выхода за контракт.
 */

import {
  ACTIONS,
  CONSTRAINT_KEYS,
  DENIED_ACTIONS,
  LOCATION_TOKENS,
  OWNERSHIPS,
  PLAN_LIMITS,
  SELECTIONS,
  SORT_MODES,
  SPECIALTY_KEYS,
  STEP_TYPES,
  TRAVEL_MODES,
  REPLY_HINTS,
} from './schema.js';

export const VALIDATION_ERROR = Object.freeze({
  NOT_JSON: 'plan_not_json',
  NOT_OBJECT: 'plan_not_object',
  TOO_LARGE: 'plan_too_large',
  TOO_DEEP: 'plan_too_deep',
  PROTOTYPE_POLLUTION: 'plan_prototype_key',
  UNKNOWN_FIELD: 'plan_unknown_field',
  UNKNOWN_ACTION: 'plan_unknown_action',
  DENIED_ACTION: 'plan_denied_action',
  BAD_STEP: 'plan_bad_step',
  TOO_MANY_STEPS: 'plan_too_many_steps',
  BAD_CONSTRAINT: 'plan_bad_constraint',
  BAD_TOKEN: 'plan_bad_token',
  BAD_ENUM: 'plan_bad_enum',
});

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const PLAN_KEYS = new Set([
  'action', 'steps', 'constraints', 'reply_hint', 'travel_mode', 'sort_mode', 'services',
]);

const STEP_KEYS = new Set(['type', 'token', 'specialty', 'selection', 'constraints']);

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TOKEN_PATTERN = /^@[A-Z][A-Z_]{1,24}(?:_[A-Z]{1,2})?$/;

const fail = (code, detail) => ({ ok: false, error: { code, detail: detail || null } });

/** Рекурсивная проверка глубины и ключей-ловушек прототипа. */
const inspectStructure = (value, depth = 0) => {
  if (depth > PLAN_LIMITS.MAX_DEPTH) {
    return VALIDATION_ERROR.TOO_DEEP;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = inspectStructure(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (PROTOTYPE_KEYS.has(key)) {
        return VALIDATION_ERROR.PROTOTYPE_POLLUTION;
      }
      const problem = inspectStructure(value[key], depth + 1);
      if (problem) return problem;
    }
  }
  return null;
};

/**
 * Разбор строки ответа модели.
 * Никаких «вытащим JSON из середины текста, если получится»: модель обязана
 * отвечать JSON-объектом. Снисходительный парсер — это способ принять
 * вперемешку с JSON ещё и текст инъекции.
 */
export const parsePlanJson = (raw) => {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) {
    return fail(VALIDATION_ERROR.NOT_JSON);
  }
  if (Buffer.byteLength(text, 'utf8') > PLAN_LIMITS.MAX_JSON_BYTES) {
    return fail(VALIDATION_ERROR.TOO_LARGE);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail(VALIDATION_ERROR.NOT_JSON);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(VALIDATION_ERROR.NOT_OBJECT);
  }

  return { ok: true, value: parsed };
};

const validateConstraints = (raw, allowedDistricts) => {
  if (raw === null || raw === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(VALIDATION_ERROR.BAD_CONSTRAINT, 'not_object');
  }

  const keys = Object.keys(raw);
  if (keys.length > PLAN_LIMITS.MAX_CONSTRAINT_KEYS) {
    return fail(VALIDATION_ERROR.BAD_CONSTRAINT, 'too_many_keys');
  }

  const result = {};
  for (const key of keys) {
    if (!CONSTRAINT_KEYS.includes(key)) {
      return fail(VALIDATION_ERROR.UNKNOWN_FIELD, key);
    }

    const value = raw[key];
    if (value === null || value === undefined) continue;

    switch (key) {
      case 'available_after':
      case 'available_before': {
        if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
          return fail(VALIDATION_ERROR.BAD_CONSTRAINT, key);
        }
        result[key] = value;
        break;
      }
      case 'open_now':
      case 'weekend':
      case 'evening':
      case 'children':
      case 'dms_only':
      case 'wheelchair':
      case 'online_booking': {
        if (typeof value !== 'boolean') {
          return fail(VALIDATION_ERROR.BAD_CONSTRAINT, key);
        }
        result[key] = value;
        break;
      }
      case 'ownership': {
        if (!OWNERSHIPS.includes(value)) {
          return fail(VALIDATION_ERROR.BAD_ENUM, key);
        }
        result[key] = value;
        break;
      }
      case 'district': {
        if (typeof value !== 'string' || !allowedDistricts.includes(value)) {
          return fail(VALIDATION_ERROR.BAD_ENUM, key);
        }
        result[key] = value;
        break;
      }
      case 'max_distance_km': {
        // Меньше 300 м — не ограничение, а способ обнулить выдачу (1e-300 проходило).
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 50) {
          return fail(VALIDATION_ERROR.BAD_CONSTRAINT, key);
        }
        result[key] = value;
        break;
      }
      case 'max_travel_minutes': {
        if (!Number.isInteger(value) || value < 5 || value > 120) {
          return fail(VALIDATION_ERROR.BAD_CONSTRAINT, key);
        }
        result[key] = value;
        break;
      }
      case 'min_rating': {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5) {
          return fail(VALIDATION_ERROR.BAD_CONSTRAINT, key);
        }
        result[key] = value;
        break;
      }
      case 'min_experience_years': {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 60) {
          return fail(VALIDATION_ERROR.BAD_CONSTRAINT, key);
        }
        result[key] = value;
        break;
      }
      default:
        return fail(VALIDATION_ERROR.UNKNOWN_FIELD, key);
    }
  }

  return { ok: true, value: result };
};

const validateStep = (raw, options) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(VALIDATION_ERROR.BAD_STEP, 'not_object');
  }

  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.has(key)) {
      return fail(VALIDATION_ERROR.UNKNOWN_FIELD, `steps.${key}`);
    }
  }

  if (!STEP_TYPES.includes(raw.type)) {
    return fail(VALIDATION_ERROR.BAD_STEP, 'type');
  }

  const step = { type: raw.type };

  if (raw.selection !== undefined && raw.selection !== null) {
    if (!SELECTIONS.includes(raw.selection)) {
      return fail(VALIDATION_ERROR.BAD_ENUM, 'selection');
    }
    step.selection = raw.selection;
  }

  const constraints = validateConstraints(raw.constraints, options.allowedDistricts);
  if (!constraints.ok) return constraints;
  step.constraints = constraints.value;

  if (raw.type === 'specific_doctor' || raw.type === 'specific_clinic') {
    if (typeof raw.token !== 'string' || !TOKEN_PATTERN.test(raw.token)) {
      return fail(VALIDATION_ERROR.BAD_TOKEN, raw.type);
    }
    /*
     * Ключевая проверка против галлюцинаций и инъекций: модель может
     * сослаться только на тот токен, который мы ей ВЫДАЛИ в этом запросе.
     * Любой другой @DOCTOR_Z — выдуманный, и план отклоняется целиком.
     */
    if (!options.allowedTokens.has(raw.token)) {
      return fail(VALIDATION_ERROR.BAD_TOKEN, 'unknown_token');
    }
    step.token = raw.token;
  }

  if (raw.type === 'specialty') {
    if (!SPECIALTY_KEYS.includes(raw.specialty)) {
      return fail(VALIDATION_ERROR.BAD_ENUM, 'specialty');
    }
    step.specialty = raw.specialty;
  }

  if (raw.type === 'location') {
    if (typeof raw.token !== 'string' || !LOCATION_TOKENS.includes(raw.token)) {
      return fail(VALIDATION_ERROR.BAD_TOKEN, 'location');
    }
    if (!options.allowedTokens.has(raw.token)) {
      return fail(VALIDATION_ERROR.BAD_TOKEN, 'unknown_location');
    }
    step.token = raw.token;
  }

  return { ok: true, value: step };
};

/**
 * Полная проверка плана.
 *
 * @param {unknown} raw строка или уже разобранный объект
 * @param {object} options
 * @param {Set<string>} options.allowedTokens токены, выданные ЭТОМУ запросу
 * @param {string[]} options.allowedDistricts
 * @param {Map<string, string>} [options.allowedServices] нижний регистр → название услуги
 * @returns {{ok: true, value: object} | {ok: false, error: {code: string, detail: string|null}}}
 */
export const validatePlan = (raw, options) => {
  const allowedTokens = options?.allowedTokens instanceof Set ? options.allowedTokens : new Set();
  const allowedDistricts = Array.isArray(options?.allowedDistricts) ? options.allowedDistricts : [];

  let plan = raw;
  if (typeof raw === 'string') {
    const parsed = parsePlanJson(raw);
    if (!parsed.ok) return parsed;
    plan = parsed.value;
  }

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return fail(VALIDATION_ERROR.NOT_OBJECT);
  }

  const structural = inspectStructure(plan);
  if (structural) {
    return fail(structural);
  }

  for (const key of Object.keys(plan)) {
    if (!PLAN_KEYS.has(key)) {
      return fail(VALIDATION_ERROR.UNKNOWN_FIELD, key);
    }
  }

  const action = plan.action;
  if (typeof action !== 'string') {
    return fail(VALIDATION_ERROR.UNKNOWN_ACTION);
  }
  if (DENIED_ACTIONS.some((denied) => action.toUpperCase().includes(denied))) {
    // Отдельный код ошибки: это не «опечатка модели», это сигнал инцидента.
    return fail(VALIDATION_ERROR.DENIED_ACTION, action.slice(0, 40));
  }
  if (!ACTIONS.includes(action)) {
    return fail(VALIDATION_ERROR.UNKNOWN_ACTION, action.slice(0, 40));
  }

  const rawSteps = plan.steps === undefined || plan.steps === null ? [] : plan.steps;
  if (!Array.isArray(rawSteps)) {
    return fail(VALIDATION_ERROR.BAD_STEP, 'steps_not_array');
  }
  if (rawSteps.length > PLAN_LIMITS.MAX_STEPS) {
    return fail(VALIDATION_ERROR.TOO_MANY_STEPS, String(rawSteps.length));
  }

  const steps = [];
  for (const rawStep of rawSteps) {
    const step = validateStep(rawStep, { allowedTokens, allowedDistricts });
    if (!step.ok) return step;
    steps.push(step.value);
  }

  const constraints = validateConstraints(plan.constraints, allowedDistricts);
  if (!constraints.ok) return constraints;

  const replyHint = plan.reply_hint;
  if (replyHint !== undefined && replyHint !== null && !REPLY_HINTS.includes(replyHint)) {
    return fail(VALIDATION_ERROR.BAD_ENUM, 'reply_hint');
  }

  if (plan.travel_mode !== undefined && plan.travel_mode !== null && !TRAVEL_MODES.includes(plan.travel_mode)) {
    return fail(VALIDATION_ERROR.BAD_ENUM, 'travel_mode');
  }
  if (plan.sort_mode !== undefined && plan.sort_mode !== null && !SORT_MODES.includes(plan.sort_mode)) {
    return fail(VALIDATION_ERROR.BAD_ENUM, 'sort_mode');
  }

  let services = null;
  if (plan.services !== undefined && plan.services !== null) {
    if (!Array.isArray(plan.services) || plan.services.length > PLAN_LIMITS.MAX_SERVICES) {
      return fail(VALIDATION_ERROR.BAD_CONSTRAINT, 'services');
    }
    services = plan.services
      .filter((item) => typeof item === 'string')
      .map((item) => item.replace(/[^\p{L}\p{N}\s-]/gu, '').trim().slice(0, 60))
      .filter(Boolean);
    if (services.length !== plan.services.length) {
      return fail(VALIDATION_ERROR.BAD_CONSTRAINT, 'services');
    }
    /*
     * Услуга — только из справочника. Строка модели иначе попадала в поле
     * поиска у пользователя и в адрес страницы: «Запись только по тел
     * 8-800-… звоните» проходила очистку от разметки как обычный текст.
     * Неизвестные услуги отбрасываются молча: это подсказка, а не шаг плана.
     */
    const known = options.allowedServices;
    services = known
      ? services.map((item) => known.get(item.toLowerCase())).filter(Boolean)
      : [];
    if (services.length === 0) services = null;
  }

  return {
    ok: true,
    value: Object.freeze({
      action,
      steps: Object.freeze(steps),
      constraints: constraints.value,
      replyHint: replyHint || null,
      travelMode: plan.travel_mode || null,
      sortMode: plan.sort_mode || null,
      services,
    }),
  };
};
