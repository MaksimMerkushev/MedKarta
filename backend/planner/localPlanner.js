/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный детерминированный планировщик — обязательная часть fail-closed:
 * когда Privacy Gateway не выпускает текст наружу (документы, неуверенная
 * классификация жалоб, остаточный риск), план всё равно строится — иначе
 * единственным способом ответить осталась бы отправка данных наружу.
 *
 * Работает только по извлечённым Gateway структурам (outline, specialties,
 * constraints, signals), без сети и исходного текста. Форма плана — та же,
 * что у validator.js, поэтому Executor не различает источник.
 *
 * Сюда же встанет локальная LLM с тем же интерфейсом plan(context).
 */

import { PLAN_LIMITS, SPECIALTY_KEYS } from './schema.js';

const LOCATION_KINDS = new Set(['LOCATION']);

const toPlanConstraints = (constraints = {}, isChild = false) => {
  const result = {};
  if (constraints.availableAfter) result.available_after = constraints.availableAfter;
  if (constraints.availableBefore) result.available_before = constraints.availableBefore;
  if (constraints.openNow) result.open_now = true;
  if (constraints.weekend) result.weekend = true;
  if (constraints.evening) result.evening = true;
  if (constraints.onlineBooking) result.online_booking = true;
  if (constraints.wheelchair) result.wheelchair = true;
  if (constraints.ownership) result.ownership = constraints.ownership;
  if (typeof constraints.minRating === 'number') result.min_rating = constraints.minRating;
  if (typeof constraints.minExperience === 'number') result.min_experience_years = constraints.minExperience;
  if (typeof constraints.maxTravelMinutes === 'number') result.max_travel_minutes = constraints.maxTravelMinutes;
  if (constraints.dmsOnly) result.dms_only = true;
  if (isChild) result.children = true;
  return result;
};

/**
 * @param {object} context результат privacy/gateway.js
 * @returns {object} план в форме, которую возвращает planner/validator.js
 */
export const planLocally = (context) => {
  // Для кого приём — по последней реплике, где это сказано («педиатр для сына» → «а теперь мне»).
  const constraints = toPlanConstraints(context.constraints, context.booking ? context.booking.child : context.classification?.isChild);
  const selection = context.constraints?.selection || null;

  if (context.signals?.clear) {
    return {
      action: 'CLEAR_FILTERS',
      steps: [],
      constraints: {},
      replyHint: 'filters_cleared',
      travelMode: null,
      sortMode: null,
      services: null,
      source: 'local',
    };
  }

  const steps = [];
  const outline = context.outline || [];

  for (let index = 0; index < outline.length; index += 1) {
    const item = outline[index];
    if (steps.length >= PLAN_LIMITS.MAX_STEPS) break;

    // «к терапевту @DOCTOR_A» — одна остановка: специальность прямо перед
    // врачом или клиникой лишь уточняет её и своего шага не порождает.
    if (item.kind === 'SPECIALTY') {
      const next = outline[index + 1];
      if (next && (next.kind === 'DOCTOR' || next.kind === 'CLINIC')) {
        continue;
      }
    }

    if (item.kind === 'DOCTOR') {
      steps.push({ type: 'specific_doctor', token: item.token, constraints: {} });
      continue;
    }
    if (item.kind === 'CLINIC') {
      steps.push({ type: 'specific_clinic', token: item.token, constraints: {} });
      continue;
    }
    if (item.kind === 'SPECIALTY' && SPECIALTY_KEYS.includes(item.specialty)) {
      steps.push({
        type: 'specialty',
        specialty: item.specialty,
        selection: selection || 'nearest',
        constraints,
      });
      continue;
    }
    if (LOCATION_KINDS.has(item.kind)) {
      steps.push({ type: 'location', token: item.token, constraints: {} });
    }
  }

  let stepsAreSequence = steps.length > 0;

  /*
   * Нет цели поиска (точка «дом» или «работа» сама по себе — не цель), но
   * классификатор жалоб дал профили — шаги строятся по ним. Основной путь для
   * «болит живот»: жалоба наружу не ушла, а искать есть что.
   */
  const hasTarget = steps.some((step) => step.type !== 'location');

  if (!hasTarget && (context.specialties || []).length > 0) {
    // Альтернативы («терапевт или гастроэнтеролог»), а не последовательность
    // посещений: маршрут из них строить нельзя.
    stepsAreSequence = false;
    for (const specialty of context.specialties.slice(0, 2)) {
      if (!SPECIALTY_KEYS.includes(specialty)) continue;
      steps.push({
        type: 'specialty',
        specialty,
        selection: selection || 'nearest',
        constraints,
      });
    }
  }

  const hasDoctorOrSpecialty = steps.some(
    (step) => step.type === 'specific_doctor' || step.type === 'specialty',
  );

  let action = 'CLARIFY';
  let replyHint = 'need_clarification';

  if (steps.length === 0) {
    action = 'CLARIFY';
    replyHint = 'need_clarification';
  } else if (context.signals?.route || (stepsAreSequence && steps.length > 1)) {
    action = 'BUILD_ROUTE';
    replyHint = 'route_built';
  } else if (context.signals?.slots) {
    action = 'GET_AVAILABLE_SLOTS';
    replyHint = 'slots_found';
  } else if (context.signals?.service) {
    action = 'SEARCH_SERVICE';
    replyHint = 'services_found';
  } else if (hasDoctorOrSpecialty) {
    action = 'FIND_DOCTOR';
    replyHint = 'doctors_found';
  } else {
    action = 'FIND_CLINIC';
    replyHint = 'clinics_found';
  }

  return {
    action,
    steps,
    constraints,
    replyHint,
    travelMode: context.constraints?.travelMode || null,
    sortMode: context.constraints?.sortMode || (selection === 'best_rated' ? 'rating' : null),
    services: null,
    source: 'local',
  };
};

export const createLocalPlanner = () => Object.freeze({
  name: 'local',
  async plan(context) {
    return planLocally(context);
  },
});
