/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ДМС: страховая → программа → покрытие по филиалам и специальностям.
 *
 * ГЛАВНОЕ ПРАВИЛО: покрытие определяет ПРОГРАММА, а не работодатель.
 * У двух сотрудников одной компании программы бывают разными, а ребёнок
 * застрахован отдельной (часто семейной) программой. Поэтому всё, что нужно
 * MedKarta, — идентификатор программы. Ни ФИО, ни номера полиса, ни
 * работодателя справочнику не нужно, и в браузере хранится только plan id.
 *
 * Режимы доступа — то, как человек на практике попадает к врачу:
 *   direct             — прямое обращение в клинику с полисом;
 *   via_pult           — запись через пульт страховой (гарантийное письмо);
 *   referral_required  — по направлению терапевта/педиатра по программе;
 *   approval_required  — нужно согласование конкретной услуги;
 *   excluded           — явно не входит (исключение из программы).
 */

export const ACCESS_MODES = Object.freeze(['direct', 'via_pult', 'referral_required', 'approval_required', 'excluded']);

export const ACCESS_LABELS = Object.freeze({
  direct: 'прямое обращение с полисом',
  via_pult: 'запись через пульт страховой',
  referral_required: 'по направлению терапевта или педиатра',
  approval_required: 'нужно согласование со страховой',
  excluded: 'не входит в программу',
});

/** Чем точнее правило, тем оно главнее: услуга > специальность > вся амбулатория. */
const SCOPE_RANK = Object.freeze({ service: 3, specialty: 2, all_outpatient: 1 });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

const todayKazan = (now) => new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

/** Проверка справочника ДМС. Пустой список — всё верно. */
export const validateInsuranceData = (data, { branchIds = null } = {}) => {
  const errors = [];
  if (!data || typeof data !== 'object') return ['справочник ДМС не объект'];

  const providers = new Set();
  for (const provider of data.providers || []) {
    if (!ID.test(provider.id || '')) errors.push(`страховая: неверный id «${provider.id}»`);
    if (!provider.name) errors.push(`страховая ${provider.id}: нет названия`);
    providers.add(provider.id);
  }

  const plans = new Set();
  for (const plan of data.plans || []) {
    if (!ID.test(plan.id || '')) errors.push(`программа: неверный id «${plan.id}»`);
    if (plans.has(plan.id)) errors.push(`программа ${plan.id}: повтор id`);
    plans.add(plan.id);
    if (!providers.has(plan.providerId)) errors.push(`программа ${plan.id}: нет страховой ${plan.providerId}`);
    if (!['adult', 'child', 'family'].includes(plan.insured)) errors.push(`программа ${plan.id}: insured должен быть adult, child или family`);
    if (!DAY.test(plan.validFrom || '') || !DAY.test(plan.validTo || '') || plan.validFrom > plan.validTo) {
      errors.push(`программа ${plan.id}: неверный срок действия`);
    }
  }

  for (const [index, rule] of (data.coverage || []).entries()) {
    const label = `покрытие #${index}`;
    if (!plans.has(rule.planId)) errors.push(`${label}: нет программы ${rule.planId}`);
    if (!rule.branchId && !rule.clinicId) errors.push(`${label}: нужен branchId или clinicId`);
    if (branchIds && rule.branchId && !branchIds.has(rule.branchId)) errors.push(`${label}: нет филиала ${rule.branchId}`);
    if (!SCOPE_RANK[rule.scope]) errors.push(`${label}: неверный scope «${rule.scope}»`);
    if (rule.scope === 'specialty' && !rule.specialty) errors.push(`${label}: не указана специальность`);
    if (rule.scope === 'service' && !rule.serviceId) errors.push(`${label}: не указана услуга`);
    if (!ACCESS_MODES.includes(rule.access)) errors.push(`${label}: неверный режим доступа «${rule.access}»`);
  }

  return errors;
};

export const findPlan = (data, planId) => (data?.plans || []).find((plan) => plan.id === planId) || null;
export const findProvider = (data, providerId) => (data?.providers || []).find((provider) => provider.id === providerId) || null;

/**
 * Покрытие одной карточки выбранной программой.
 *
 * @param {object} data справочник ДМС
 * @param {string} planId
 * @param {object} place карточка: clinicId, branchId, entityKind,
 *   specialtyKey (код специальности), pediatric (детский приём)
 * @param {object} [options]
 * @param {string} [options.serviceId] конкретная услуга, если известна
 * @param {Date} [options.now]
 * @param {string} [options.today] ГГГГ-ММ-ДД по Казани вместо now
 * @returns {{status: 'covered'|'not_covered'|'unknown', access?: string,
 *   label?: string, notes?: string, limitPerYear?: number, reason?: string,
 *   specialties?: string[]}}
 */
export const coverageFor = (data, planId, place, { serviceId = null, now = new Date(), today: todayOverride = null } = {}) => {
  const plan = findPlan(data, planId);
  if (!plan) return { status: 'unknown', reason: 'no_plan' };

  // «Сегодня» можно передать готовой строкой ГГГГ-ММ-ДД: интерфейс уже
  // держит казанские часы и не должен пересчитывать время при каждом рендере.
  const today = typeof todayOverride === 'string' && DAY.test(todayOverride) ? todayOverride : todayKazan(now);
  if (today < plan.validFrom || today > plan.validTo) return { status: 'not_covered', reason: 'plan_expired' };

  // Справочник ДМС знает только филиалы, перечисленные в программах.
  // Карточка без филиала (государственная, из OSM) — «нет данных», а не «не входит».
  if (!place?.branchId && !place?.clinicId) return { status: 'unknown', reason: 'no_branch' };

  const rules = (data.coverage || []).filter((rule) =>
    rule.planId === plan.id
    && (rule.branchId ? rule.branchId === place.branchId : rule.clinicId === place.clinicId));

  if (rules.length === 0) return { status: 'not_covered', reason: 'not_in_network' };

  // Карточка учреждения: входит, если в программе есть хоть что-то по филиалу.
  if (place.entityKind !== 'doctor') {
    const open = rules.filter((rule) => rule.access !== 'excluded');
    if (open.length === 0) return { status: 'not_covered', reason: 'excluded' };
    const all = open.some((rule) => rule.scope === 'all_outpatient');
    return {
      status: 'covered',
      partial: !all,
      specialties: [...new Set(open.filter((rule) => rule.scope === 'specialty').map((rule) => rule.specialty))],
      access: open.find((rule) => rule.scope === 'all_outpatient')?.access || open[0].access,
    };
  }

  // Детская программа не покрывает взрослого врача, взрослая — детского.
  if (plan.insured === 'child' && !place.pediatric) return { status: 'not_covered', reason: 'age' };
  if (plan.insured === 'adult' && place.pediatric) return { status: 'not_covered', reason: 'age' };

  const applicable = rules
    .filter((rule) =>
      rule.scope === 'all_outpatient'
      || (rule.scope === 'specialty' && rule.specialty === place.specialtyKey)
      || (rule.scope === 'service' && serviceId && rule.serviceId === serviceId))
    .sort((left, right) => SCOPE_RANK[right.scope] - SCOPE_RANK[left.scope]);

  const rule = applicable[0];
  if (!rule) return { status: 'not_covered', reason: 'specialty_not_covered' };
  if (rule.access === 'excluded') return { status: 'not_covered', reason: 'excluded', notes: rule.notes || null };

  return {
    status: 'covered',
    access: rule.access,
    label: ACCESS_LABELS[rule.access],
    notes: rule.notes || null,
    limitPerYear: Number.isInteger(rule.limitPerYear) ? rule.limitPerYear : null,
  };
};

/** Подпись для карточки — короткая и без канцелярита. */
export const coverageBadge = (coverage, plan) => {
  if (!coverage || coverage.status === 'unknown' || !plan) return null;
  if (coverage.status === 'covered') {
    return {
      tone: 'covered',
      text: `Входит в ДМС «${plan.name}»${coverage.partial ? ' (часть специалистов)' : ''}`,
      detail: coverage.label || (coverage.access ? ACCESS_LABELS[coverage.access] : null),
    };
  }
  const reasons = {
    age: plan.insured === 'child' ? 'программа детская, а это взрослый приём' : 'это детский приём, а программа взрослая',
    plan_expired: 'срок действия программы закончился',
    excluded: 'исключено из программы',
    specialty_not_covered: 'этот специалист не входит в программу',
    not_in_network: 'клиника не входит в программу',
  };
  return { tone: 'not_covered', text: `Не по вашему ДМС`, detail: reasons[coverage.reason] || null };
};
