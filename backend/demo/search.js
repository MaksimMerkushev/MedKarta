/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Строгий подбор демо-записи.
 *
 * Ассистент понимает намерение; решает, кто подходит, — только этот код,
 * по данным демо-набора и состояниям слотов. Каждое условие пользователя
 * ОБЯЗАТЕЛЬНО:
 *   — специальность и возраст пациента: врач, не ведущий детский приём,
 *     ребёнку не предлагается;
 *   — дата и время: слот начинается не раньше «после ЧЧ:ММ», в нужный
 *     день по Москве и не в прошлом;
 *   — цена: услуга не дороже потолка;
 *   — ДМС: «по ДМС» — только то, что программа покрывает; без выбранной
 *     программы — вопрос, а не догадка;
 *   — время в пути: по графу дорог нашим движком, а не по прямой; если
 *     точка вне графа или граф не загружен — честный ответ, а не оценка;
 *   — город: демо есть только в Казани, другой город — «вне покрытия».
 *
 * Если ничего не подошло, ответ — «подходящих вариантов нет» и какое
 * условие отсекло последних кандидатов. Ослабить условие можно, но только
 * по согласию пользователя: сервер предлагает варианты (relax) с числом
 * найденных, а не применяет их сам.
 */

import { ACCESS_LABELS, coverageFor } from '../../shared/dms.js';
import { describeRequest, EVENING_FROM, LOCALITIES, normalizeSearchRequest, UNSUPPORTED_CONDITIONS, withoutDayWindow } from '../../shared/demoSearch.js';
import { addDays, minutesOf, moscowDay, weekdayOf } from './time.js';
import { branchLabelsOf } from './chatBridge.js';
import { SLOT_WINDOW_DAYS } from './generator.js';

const SECONDS_IN_MINUTE = 60;
const NEAREST_CEILING_MINUTES = 120;

const STAGE_LABELS = Object.freeze({
  specialty: 'врачи нужного профиля',
  doctor: 'названный врач',
  age: 'ведут приём для этого возраста',
  clinic: 'принимают в названной клинике',
  district: 'принимают в нужном районе',
  gender: 'врач нужного пола',
  access: 'доступная среда / парковка',
  experience: 'со стажем не меньше указанного',
  service: 'оказывают нужную услугу',
  price: 'укладываются в цену',
  dms: 'входят в программу ДМС',
  travel: 'укладываются во время в пути',
  slots: 'есть свободное время в нужные дни и часы',
});

/** Почему пусто — по этапу, на котором кончились кандидаты. */
const BLOCKING_TEXT = Object.freeze({
  specialty: 'в демо-наборе нет врачей этого профиля',
  doctor: 'названный врач не ведёт такой приём',
  age: 'никто из врачей этого профиля не ведёт приём для этого возраста',
  clinic: 'в названной клинике нет демо-записи к такому врачу',
  district: 'в нужном районе таких врачей нет',
  gender: 'среди подходящих врачей нет врача нужного пола',
  access: 'нет филиала, где точно есть доступная среда или парковка (у реальных клиник это не указано — не обещаю)',
  experience: 'ни у кого из подходящих врачей нет такого стажа',
  service: 'нужную услугу эти врачи не оказывают',
  price: 'все варианты дороже указанной цены',
  dms: 'ни один вариант не входит в выбранную программу ДМС',
  travel: 'все подходящие клиники дальше указанного времени в пути',
  slots: 'нет свободного времени в нужные дни и часы',
});

/* Что будет вместо условия, которого в демо нет, — словами кнопки согласия. */
const UNSUPPORTED_RELAX = Object.freeze({
  home_visit: 'Приём в клинике вместо выезда на дом',
  online: 'Очный приём в клинике вместо онлайн-консультации',
  rating: 'Без учёта отзывов и рейтинга',
  oms: 'Платный приём (или по ДМС) в частной клинике',
  doctor_age: 'Без учёта возраста врача',
  anonymous: 'Обычная (не анонимная) демо-запись',
  multi_patient: 'Подобрать одну запись (вторую — отдельным поиском)',
  certificate: 'Обычный приём врача (справку уточните в клинике)',
});

const RELAX_LABELS = Object.freeze({
  doctor: 'к другим врачам этого профиля',
  clinic: 'в других клиниках',
  district: 'в любом районе Казани',
  gender: 'врач любого пола',
  access: 'без требования к доступной среде и парковке',
  experience: 'без требования к стажу',
  time: 'без ограничения по времени приёма',
  date: 'в любой день ближайших двух недель',
  price: 'без ограничения по цене',
  dms: 'не только по ДМС (платный приём)',
  travel: 'без ограничения по времени в пути',
});

const WEEKDAY_NAMES = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS_GENITIVE = ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** Дни поиска по запросу в окне расписания. */
export const resolveDays = (request, today, windowSize = SLOT_WINDOW_DAYS) => {
  const window = Array.from({ length: windowSize }, (_, offset) => addDays(today, offset));
  const { date } = request;
  let days;
  if (date.kind === 'today') days = [today];
  else if (date.kind === 'tomorrow') days = [addDays(today, 1)];
  else if (date.kind === 'after_tomorrow') days = [addDays(today, 2)];
  else if (date.kind === 'weekday') {
    // Неделя: эта — до воскресенья включительно, следующая — с ближайшего понедельника.
    const weekDays = date.week === 'this' ? window.slice(0, 8 - weekdayOf(today))
      : date.week === 'next' ? window.slice(8 - weekdayOf(today), 15 - weekdayOf(today)) : window;
    days = [weekDays.find((day) => weekdayOf(day) === date.weekday)].filter(Boolean);
  }
  else if (date.kind === 'date') days = window.includes(date.day) ? [date.day] : [];
  else if (date.kind === 'this_week') days = window.slice(0, 8 - weekdayOf(today));
  else if (date.kind === 'next_week') days = window.slice(8 - weekdayOf(today), 15 - weekdayOf(today));
  else if (date.kind === 'any_of') {
    // «Во вторник или среду», «сегодня или завтра»: каждый вариант — ближайший такой день.
    const chosen = new Set(date.options.flatMap((option) => resolveDays({ date: option }, today, windowSize)));
    days = window.filter((day) => chosen.has(day));
  } else if (date.kind === 'range') {
    // «С 15 по 17 октября», «до 20 октября»: границы включительно.
    days = window.filter((day) => (!date.from || day >= date.from) && (!date.to || day <= date.to));
  } else days = window;
  if (request.weekend || date.kind === 'weekend') days = days.filter((day) => weekdayOf(day) >= 6);
  if (request.workdays) days = days.filter((day) => weekdayOf(day) <= 5);
  if (request.excludeWeekdays?.length) days = days.filter((day) => !request.excludeWeekdays.includes(weekdayOf(day)));
  if (request.excludeDates?.length) days = days.filter((day) => !request.excludeDates.includes(day));
  return days;
};

/** Окно времени приёма в минутах от полуночи: [от, до). */
const timeWindow = (request) => {
  let from = request.timeFrom ? minutesOf(request.timeFrom) : 0;
  if (request.evening) from = Math.max(from, minutesOf(EVENING_FROM));
  const to = request.timeTo ? minutesOf(request.timeTo) : 24 * 60;
  return [from, to];
};

/** Все окна времени: одно — или несколько через «или» («с 10 до 12 или после 18»). */
const timeWindows = (request) => (request.timeWindows?.length
  ? request.timeWindows.map((item) => [item.from ? minutesOf(item.from) : 0, item.to ? minutesOf(item.to) : 24 * 60])
  : [timeWindow(request)]);
const inWindows = (windows, start) => windows.some(([from, to]) => start >= from && start < to);

const serviceFor = (doctor, visit, serviceId = null) => {
  if (serviceId) return doctor.serviceIds.includes(serviceId) ? [serviceId] : [];
  const first = `consult.${doctor.specialtyKey}.first`;
  const repeat = `consult.${doctor.specialtyKey}.repeat`;
  if (visit === 'first') return doctor.serviceIds.includes(first) ? [first] : [];
  if (visit === 'repeat') return doctor.serviceIds.includes(repeat) ? [repeat] : [];
  if (visit === 'procedure') return doctor.serviceIds.filter((id) => !id.startsWith('consult.'));
  return doctor.serviceIds;
};

/**
 * Покрытие услуги программой — для конкретного пациента и филиала.
 * @returns {{status: 'covered'|'not_covered'|'no_plan', access?, label, note?}}
 */
export const coverageOf = (index, planId, { doctor, branchId, serviceId, patient, today }) => {
  const plan = planId ? index.plans.get(planId) : null;
  if (!plan) return { status: 'no_plan', label: 'Программа ДМС не выбрана' };
  const { clinic } = index.branches.get(branchId);
  const result = coverageFor(index.catalog.insurance, planId, {
    entityKind: 'doctor',
    clinicId: clinic.id,
    branchId,
    specialtyKey: doctor.specialtyKey,
    pediatric: patient === 'child',
  }, { serviceId, today });
  if (result.status === 'covered') {
    const conditional = result.access === 'approval_required' || result.access === 'referral_required';
    return {
      status: 'covered',
      access: result.access,
      conditional,
      planId,
      planName: plan.name,
      label: conditional ? `${plan.name}: ${ACCESS_LABELS[result.access]}` : `Входит в ${plan.name}`,
      note: result.notes || null,
    };
  }
  const reasons = {
    age: plan.insured === 'adult' ? 'программа для взрослых' : 'программа детская',
    plan_expired: 'срок программы истёк',
    excluded: result.notes || 'исключено из программы',
    specialty_not_covered: 'специалист не входит в программу',
    not_in_network: 'клиника не входит в программу',
  };
  return { status: 'not_covered', planId, planName: plan.name, label: `Не входит в ${plan.name}`, note: reasons[result.reason] || null, reason: result.reason || null };
};

/**
 * @param {object} deps
 * @param {object} deps.index индекс демо-набора
 * @param {object} deps.store хранилище слотов (bookingStore)
 * @param {Function} [deps.getEngine] async () => движок маршрутов или null
 * @param {Function} [deps.now]
 */
export const createDemoSearch = ({ index, store, getEngine = async () => null, now = () => Date.now() }) => {
  /*
   * Кандидаты: профиль и/или названные врачи. Названы врачи — только они
   * (однофамильцы — все, кто подходит по форме фамилии); назван и профиль —
   * оба условия сразу.
   */
  const doctorPairs = (request) => index.catalog.doctors
    .filter((doctor) => (request.specialty ? doctor.specialtyKey === request.specialty : request.specialtyAny.length === 0 || request.specialtyAny.includes(doctor.specialtyKey)))
    .flatMap((doctor) => doctor.branchIds.map((branchId) => ({ doctor, branchId })));

  /*
   * Ядро: применяет условия по очереди и считает, сколько кандидатов
   * осталось после каждого. Один и тот же код — для ответа и для расчёта
   * «если убрать условие X, найдётся N».
   */
  const run = async (request, { at, today, travelCache }) => {
    const funnel = [];
    const stage = (key, list) => {
      funnel.push({ key, label: STAGE_LABELS[key], count: list.length });
      return list;
    };

    let candidates = stage('specialty', doctorPairs(request));
    if (request.doctorIds.length > 0) candidates = stage('doctor', candidates.filter(({ doctor }) => request.doctorIds.includes(doctor.id)));
    if (request.excludeDoctorIds.length > 0) candidates = stage('doctor', candidates.filter(({ doctor }) => !request.excludeDoctorIds.includes(doctor.id)));
    candidates = stage('age', candidates.filter(({ doctor }) => doctor.ageGroups.includes(request.patient)));
    if (request.branchIds.length > 0) candidates = stage('clinic', candidates.filter(({ branchId }) => request.branchIds.includes(branchId)));
    if (request.excludeBranchIds.length > 0) candidates = stage('clinic', candidates.filter(({ branchId }) => !request.excludeBranchIds.includes(branchId)));
    if (request.districts.length > 0 || request.excludeDistricts.length > 0) {
      candidates = stage('district', candidates.filter(({ branchId }) => {
        const { district } = index.branches.get(branchId).branch;
        // Район филиала не известен точно — условие по району он не проходит ни в какую сторону.
        if (!district) return false;
        if (request.districts.length > 0 && !request.districts.includes(district)) return false;
        return !request.excludeDistricts.includes(district);
      }));
    }
    if (request.doctorGender) candidates = stage('gender', candidates.filter(({ doctor }) => doctor.gender === request.doctorGender));
    /* Доступная среда и парковка: только там, где это указано; у реальных клиник неизвестно — не проходят. */
    if (request.wheelchair || request.parking) {
      candidates = stage('access', candidates.filter(({ branchId }) => {
        const features = index.branches.get(branchId).branch.features || {};
        return (!request.wheelchair || features.wheelchair === true) && (!request.parking || features.parking === true);
      }));
    }
    if (request.minExperience) candidates = stage('experience', candidates.filter(({ doctor }) => doctor.experienceYears >= request.minExperience));
    candidates = stage('service', candidates
      .map((item) => ({ ...item, serviceIds: serviceFor(item.doctor, request.visit, request.serviceId) }))
      .filter((item) => item.serviceIds.length > 0));

    // Цена — по каждой услуге отдельно: процедура дороже приёма.
    candidates = candidates.map((item) => ({
      ...item,
      prices: Object.fromEntries(item.serviceIds.map((serviceId) => [serviceId, index.priceOf(item.branchId, serviceId)])),
      coverage: Object.fromEntries(item.serviceIds.map((serviceId) => [serviceId, coverageOf(index, request.dms.planId, { doctor: item.doctor, branchId: item.branchId, serviceId, patient: request.patient, today })])),
    }));
    if (request.maxPrice) {
      // «По ДМС, а если не входит — не дороже 2000»: потолок — только для платного приёма.
      const coveredPasses = request.dms.prefer && Boolean(request.dms.planId);
      candidates = candidates
        .map((item) => ({
          ...item,
          serviceIds: item.serviceIds.filter((serviceId) => (coveredPasses && item.coverage[serviceId].status === 'covered')
            || (item.prices[serviceId] !== null && item.prices[serviceId] <= request.maxPrice)),
        }))
        .filter((item) => item.serviceIds.length > 0);
    }
    candidates = stage('price', candidates);
    if (request.dms.required) {
      candidates = candidates
        .map((item) => ({ ...item, serviceIds: item.serviceIds.filter((serviceId) => item.coverage[serviceId].status === 'covered') }))
        .filter((item) => item.serviceIds.length > 0);
    }
    candidates = stage('dms', candidates);

    /*
     * Время в пути — по графу дорог, одним обходом на все филиалы. Есть
     * точка отправления — считаем всегда, чтобы показать на карточках;
     * отсекаем — только при заданном потолке.
     */
    const needTravel = Boolean(request.travel.maxMinutes || request.travel.nearest || request.origin);
    let travelState = 'not_requested';
    if (needTravel && request.origin && candidates.length > 0) {
      const branchIds = [...new Set(candidates.map((item) => item.branchId))];
      const ceiling = (request.travel.maxMinutes || NEAREST_CEILING_MINUTES) * SECONDS_IN_MINUTE;
      const cacheKey = `${request.travel.mode}|${ceiling}`;
      let times = travelCache.get(cacheKey);
      if (!times) {
        const engine = await getEngine();
        if (!engine || typeof engine.travelTimes !== 'function') {
          times = { state: 'routing_unavailable', byBranch: new Map() };
        } else {
          const estimates = await engine.travelTimes(
            request.origin,
            branchIds.map((id) => ({ lat: index.branches.get(id).branch.lat, lng: index.branches.get(id).branch.lng })),
            request.travel.mode,
            { maxSeconds: ceiling },
          );
          const byBranch = new Map();
          estimates.forEach((estimate, position) => {
            if (Number.isFinite(estimate?.durationSeconds) && estimate.approximate !== true) {
              byBranch.set(branchIds[position], { minutes: Math.max(1, Math.round(estimate.durationSeconds / 60)), distanceKm: estimate.distanceKm });
            }
          });
          // Ни одной цели не достигли — проверяем, на дороге ли сама точка отправления.
          const originOnNetwork = byBranch.size > 0 || (typeof engine.snapsToNetwork === 'function' ? engine.snapsToNetwork(request.origin, request.travel.mode) : true);
          times = { state: originOnNetwork ? 'ok' : 'origin_off_network', byBranch };
        }
        travelCache.set(cacheKey, times);
      }
      travelState = times.state;
      candidates = candidates.map((item) => ({ ...item, travel: times.byBranch.get(item.branchId) || null }));
      if (request.travel.maxMinutes) {
        candidates = candidates.filter((item) => item.travel && item.travel.minutes <= request.travel.maxMinutes);
      }
    }
    candidates = stage('travel', candidates);

    /* Свободные слоты — из хранилища, в нужные дни и часы, не в прошлом. */
    const days = resolveDays(request, today);
    // «В четверг после 15:30, а в пятницу до обеда»: у дня своё окно вместо общего.
    const dayWindows = new Map();
    if (request.date.kind === 'any_of') {
      for (const option of request.date.options) {
        if (!option.from && !option.to) continue;
        for (const day of resolveDays({ date: option }, today)) {
          dayWindows.set(day, [...(dayWindows.get(day) || []), [option.from ? minutesOf(option.from) : 0, option.to ? minutesOf(option.to) : 24 * 60]]);
        }
      }
    }
    const windows = timeWindows(request);
    let free = new Map();
    if (candidates.length > 0 && days.length > 0) {
      free = store.freeSlots({
        pairs: candidates.map((item) => ({ doctorId: item.doctor.id, branchId: item.branchId })),
        fromDay: days[0],
        toDay: days[days.length - 1],
        at,
      });
    }
    const daySet = new Set(days);
    candidates = candidates
      .map((item) => {
        const slots = (free.get(`${item.doctor.id}|${item.branchId}`) || []).filter((slot) => {
          const start = minutesOf(slot.start);
          return daySet.has(slot.day) && inWindows(dayWindows.get(slot.day) || windows, start) && item.serviceIds.includes(slot.serviceId) && slot.bookable;
        });
        return { ...item, slots };
      })
      .filter((item) => item.slots.length > 0);
    candidates = stage('slots', candidates);

    return { candidates, funnel, travelState, days };
  };

  const optionView = (item, request, today) => {
    const { clinic, branch } = index.branches.get(item.branchId);
    const first = item.slots[0];
    const service = index.services.get(first.serviceId);
    const coverage = item.coverage[first.serviceId];
    return {
      id: `${item.doctor.id}--${item.branchId}`,
      demo: true,
      doctor: {
        id: item.doctor.id,
        name: item.doctor.name,
        specialty: item.doctor.specialty,
        specialtyKey: item.doctor.specialtyKey,
        experienceYears: item.doctor.experienceYears,
        gender: item.doctor.gender,
        ageGroups: item.doctor.ageGroups,
      },
      clinic: {
        id: clinic.id,
        name: clinic.name,
        branchId: branch.id,
        branchName: branch.name,
        address: branch.address,
        district: branch.district,
        lat: branch.lat,
        lng: branch.lng,
        phone: branch.phone || null,
        real: Boolean(clinic.real),
      },
      service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
      price: item.prices[first.serviceId],
      coverage: request.dms.planId ? coverage : null,
      travel: item.travel ? { minutes: item.travel.minutes, distanceKm: item.travel.distanceKm, mode: request.travel.mode } : null,
      nextSlot: first,
      slots: item.slots.slice(0, 6),
      today,
    };
  };

  const sortCandidates = (list, request) => [...list].sort((left, right) => {
    // «По ДМС, а если никого — платно»: покрытые программой — первыми.
    if (request.dms.prefer && request.dms.planId) {
      const covered = (item) => Number(item.coverage[item.slots[0].serviceId]?.status === 'covered');
      const byCoverage = covered(right) - covered(left);
      if (byCoverage !== 0) return byCoverage;
    }
    // «Желательно в 18:30»: у кого есть ровно это время — первыми.
    if (request.preferTime) {
      const hasTime = (item) => Number(item.slots.some((slot) => slot.start === request.preferTime));
      const byTime = hasTime(right) - hasTime(left);
      if (byTime !== 0) return byTime;
    }
    // «В Советском, а если там никого — Приволжский»: названный первым район — первым.
    if (request.preferDistricts.length > 0) {
      const preferred = (item) => Number(request.preferDistricts.includes(index.branches.get(item.branchId).branch.district));
      const byDistrict = preferred(right) - preferred(left);
      if (byDistrict !== 0) return byDistrict;
    }
    // «Желательно женщина»: такие врачи первыми, остальные остаются в списке.
    if (request.preferGender) {
      const byGender = Number(right.doctor.gender === request.preferGender) - Number(left.doctor.gender === request.preferGender);
      if (byGender !== 0) return byGender;
    }
    // «Лучше со стажем от 20»: у кого такой стаж — первыми.
    if (request.preferMinExperience) {
      const meets = (item) => Number(item.doctor.experienceYears >= request.preferMinExperience);
      const byThreshold = meets(right) - meets(left);
      if (byThreshold !== 0) return byThreshold;
    }
    // «У кого стаж побольше»: опытные первыми.
    if (request.preferExperience) {
      const byExperience = right.doctor.experienceYears - left.doctor.experienceYears;
      if (byExperience !== 0) return byExperience;
    }
    if (request.travel.nearest) {
      const byTravel = (left.travel?.minutes ?? Infinity) - (right.travel?.minutes ?? Infinity);
      if (byTravel !== 0) return byTravel;
    }
    const bySlot = Date.parse(left.slots[0].startAt) - Date.parse(right.slots[0].startAt);
    if (bySlot !== 0) return bySlot;
    const byTravel = (left.travel?.minutes ?? Infinity) - (right.travel?.minutes ?? Infinity);
    if (byTravel !== 0) return byTravel;
    return (left.prices[left.slots[0].serviceId] ?? 0) - (right.prices[right.slots[0].serviceId] ?? 0);
  });

  /** Подбор по запросу. Всегда отвечает объектом со status — без исключений наружу. */
  const search = async (raw) => {
    const at = now();
    const today = moscowDay(at);
    const { request, errors } = normalizeSearchRequest(raw);
    const plan = request.dms.planId ? index.plans.get(request.dms.planId) : null;
    // Названия врачей и клиник — из справочника демо, а не из слов пользователя.
    const doctorLabels = request.doctorIds.map((id) => index.doctors.get(id)).filter(Boolean).map((doctor) => `${doctor.name} (${doctor.specialty.toLowerCase()})`);
    const branchLabels = branchLabelsOf(index, request.branchIds);
    const excludedDoctorLabels = request.excludeDoctorIds.map((id) => index.doctors.get(id)?.name).filter(Boolean);
    const excludedBranchLabels = branchLabelsOf(index, request.excludeBranchIds);
    const applied = describeRequest(request, {
      specialtyLabel: index.specialtyLabel, planName: plan?.name || null, doctorLabels, branchLabels, excludedDoctorLabels, excludedBranchLabels,
    });
    const base = { request, applied, today, timezone: 'Europe/Moscow', demo: true };

    if (errors.length > 0) {
      return { ...base, status: 'needs', needs: ['clarify'], invalid: errors, message: 'Часть условий не удалось разобрать — уточните, пожалуйста, запрос.' };
    }
    if (!request.specialty && request.specialtyAny.length === 0 && request.doctorIds.length === 0) {
      return { ...base, status: 'needs', needs: ['specialty'], message: 'Уточните, к какому специалисту нужно записаться.' };
    }
    if (request.city && !LOCALITIES[request.city].covered) {
      const name = LOCALITIES[request.city].name;
      return {
        ...base,
        status: 'out_of_coverage',
        city: request.city,
        message: `${name} — вне покрытия МедКарты: демо-клиники и карта дорог есть только по Казани. Подменять ваш город Казанью без согласия не буду.`,
        relax: [{ key: 'city', label: 'Искать в Казани', patch: { city: 'kazan' } }],
      };
    }
    if (request.dms.required && !request.dms.planId) {
      return {
        ...base,
        status: 'needs',
        needs: ['dms_plan'],
        plans: index.catalog.insurance.plans.map((item) => ({ id: item.id, name: item.name, summary: item.summary, insured: item.insured })),
        message: 'Чтобы искать по ДМС, выберите программу: без неё нельзя утверждать, что приём покрывается страховкой.',
      };
    }
    if (request.dms.planId && !plan) {
      return {
        ...base,
        status: 'needs',
        needs: ['dms_plan'],
        plans: index.catalog.insurance.plans.map((item) => ({ id: item.id, name: item.name, summary: item.summary, insured: item.insured })),
        message: 'Такой программы ДМС в демо нет. Выберите одну из демонстрационных программ.',
      };
    }
    /*
     * Условия, которых в демо нет (выезд на дом, онлайн-приём, отзывы):
     * не делаем вид, что учли, — «нет» и, с согласия, поиск без них.
     */
    if (request.unsupported.length > 0) {
      const names = request.unsupported.map((key) => UNSUPPORTED_CONDITIONS[key]);
      const relaxed = normalizeSearchRequest({ ...request, unsupported: [] }).request;
      // Без точки отправления время в пути не проверить — тогда без числа, а не с завышенным.
      const countable = !(relaxed.travel.maxMinutes || relaxed.travel.nearest) || (relaxed.origin && (!relaxed.originHint || relaxed.originConfirmed));
      const attempt = countable ? await run(relaxed, { at, today, travelCache: new Map() }) : null;
      return {
        ...base,
        status: 'empty',
        notices: [],
        blocking: { key: 'unsupported', label: names.join(', '), text: `в демо-наборе этого нет: ${names.join(', ')}` },
        relax: [{
          key: 'unsupported',
          label: request.unsupported.map((key) => UNSUPPORTED_RELAX[key]).join('; '),
          ...(attempt && attempt.candidates.length > 0 ? { count: attempt.candidates.length } : {}),
          patch: { unsupported: [] },
        }],
        message: `Подходящих вариантов нет: ${names.join(', ')} — этого в демо-наборе нет, и проверить такое условие я не могу. Делать вид, что учёл его, не буду.`,
      };
    }
    if (request.originHint && !request.originConfirmed) {
      return {
        ...base,
        status: 'needs',
        needs: ['origin_place'],
        originHint: request.originHint,
        message: 'Точку отправления вы назвали словами — по названию я её не определяю, а подставлять текущее местоположение без вашего подтверждения не буду. Поставьте точку на карте или подтвердите, что вы сейчас там.',
        relax: [{ key: 'origin', label: 'Искать без учёта местоположения', patch: { originHint: null, origin: null, travel: { ...request.travel, maxMinutes: null, nearest: false } } }],
      };
    }
    if ((request.travel.maxMinutes || request.travel.nearest) && !request.origin) {
      return {
        ...base,
        status: 'needs',
        needs: ['origin'],
        message: 'Чтобы учесть время в пути, нужна точка отправления: разрешите геолокацию или поставьте точку на карте. Придумывать её не буду.',
      };
    }

    /* Противоречивые условия — вопрос, а не молчаливый выбор одного из них. */
    if (request.date.kind === 'invalid') {
      const label = `${request.date.dayOfMonth} ${MONTHS_GENITIVE[request.date.month]}`;
      return {
        ...base,
        status: 'needs',
        needs: ['date_invalid'],
        message: `${label} — такой даты в календаре нет. Уточните день — подставлять соседний за вас не буду.`,
        relax: [{ key: 'date', label: RELAX_LABELS.date, patch: { date: { kind: 'any' } } }],
      };
    }
    // День, который даёт сама дата (без фильтра «выходные»): с ним сверяется названный день недели.
    const resolvedDays = resolveDays({ ...request, weekend: false, workdays: false, date: { ...request.date } }, today);
    if (request.date.expectWeekday && resolvedDays.length === 1 && weekdayOf(resolvedDays[0]) !== request.date.expectWeekday) {
      const [day] = resolvedDays;
      return {
        ...base,
        status: 'needs',
        needs: ['date_conflict'],
        message: `${day.split('-').reverse().join('.')} — ${WEEKDAY_NAMES[weekdayOf(day)]}, а не ${WEEKDAY_NAMES[request.date.expectWeekday]}. Уточните день — выбирать за вас не буду.`,
        relax: [
          { key: 'date_exact', label: `${day.split('-').reverse().join('.')} (${WEEKDAY_NAMES[weekdayOf(day)]})`, patch: { date: { kind: 'date', day } } },
          { key: 'date_weekday', label: `Ближайший: ${WEEKDAY_NAMES[request.date.expectWeekday]}`, patch: { date: { kind: 'weekday', weekday: request.date.expectWeekday } } },
        ],
      };
    }
    const [windowFrom, windowTo] = timeWindow(request);
    if (!request.timeWindows.length && windowFrom >= windowTo) {
      return {
        ...base,
        status: 'needs',
        needs: ['time_conflict'],
        message: `«${request.evening && !request.timeFrom ? 'вечером' : `после ${request.timeFrom || EVENING_FROM}`}» и «до ${request.timeTo}» вместе не оставляют ни минуты. Уточните часы — выбирать за вас не буду.`,
        relax: [{ key: 'time', label: RELAX_LABELS.time, patch: { timeFrom: null, timeTo: null, timeWindows: [], evening: false } }],
      };
    }

    const travelCache = new Map();
    const result = await run(request, { at, today, travelCache });

    const travelRequired = Boolean(request.travel.maxMinutes || request.travel.nearest);
    const withoutOrigin = { origin: null, travel: { ...request.travel, maxMinutes: null, nearest: false } };
    const notices = [];
    if (result.travelState === 'routing_unavailable') {
      if (travelRequired) {
        return { ...base, status: 'unavailable', reason: 'routing_unavailable', funnel: result.funnel, message: 'Сейчас не могу рассчитать время в пути по дорогам, а оценку по прямой выдавать за время в пути не буду. Попробуйте позже или уберите ограничение по времени в пути.', relax: [{ key: 'travel', label: RELAX_LABELS.travel, patch: withoutOrigin }] };
      }
      notices.push('travel_unavailable');
    }
    if (result.travelState === 'origin_off_network') {
      return {
        ...base,
        status: 'unavailable',
        reason: 'origin_off_network',
        funnel: result.funnel,
        message: 'Ваша точка отправления вне карты дорог МедКарты: демо-клиники и дороги есть только по Казани и ближайшим пригородам. Время в пути посчитать не могу — поставьте точку в Казани на карте или ищите без учёта местоположения.',
        relax: [{ key: 'origin', label: 'Искать без учёта местоположения', patch: withoutOrigin }],
      };
    }

    if (result.candidates.length > 0) {
      const sorted = sortCandidates(result.candidates, request);
      return {
        ...base,
        status: 'ok',
        notices,
        total: sorted.length,
        options: sorted.slice(0, request.limit).map((item) => optionView(item, request, today)),
        funnel: result.funnel,
      };
    }

    /* Ничего не подошло: какое условие отсекло последних, и что будет, если его снять. */
    const blockingStage = result.funnel.find((item) => item.count === 0) || result.funnel[result.funnel.length - 1];
    const relax = [];
    const tried = [];
    const tryRelax = async (key, patch) => {
      tried.push({ key, patch });
      const relaxed = normalizeSearchRequest({ ...request, ...patch }).request;
      const attempt = await run(relaxed, { at, today, travelCache });
      if (attempt.candidates.length > 0) relax.push({ key, label: RELAX_LABELS[key], count: attempt.candidates.length, patch });
    };
    if (request.doctorIds.length > 0 && request.specialty) await tryRelax('doctor', { doctorIds: [], doctorId: null });
    if (request.branchIds.length > 0) await tryRelax('clinic', { branchIds: [] });
    if (request.districts.length > 0 || request.excludeDistricts.length > 0) await tryRelax('district', { districts: [], excludeDistricts: [] });
    if (request.doctorGender) await tryRelax('gender', { doctorGender: null });
    if (request.wheelchair || request.parking) await tryRelax('access', { wheelchair: false, parking: false });
    if (request.minExperience) await tryRelax('experience', { minExperience: null });
    const dayWindowed = request.date.kind === 'any_of' && request.date.options.some((option) => option.from || option.to);
    if (request.timeFrom || request.timeTo || request.evening || request.timeWindows.length > 0 || dayWindowed) {
      await tryRelax('time', {
        timeFrom: null, timeTo: null, timeWindows: [], evening: false,
        ...(dayWindowed ? { date: { ...request.date, options: request.date.options.map(withoutDayWindow) } } : {}),
      });
    }
    if (request.date.kind !== 'any' || request.weekend || request.workdays || request.excludeWeekdays.length > 0 || request.excludeDates.length > 0) {
      await tryRelax('date', { date: { kind: 'any' }, weekend: false, workdays: false, excludeWeekdays: [], excludeDates: [] });
    }
    if (request.maxPrice) await tryRelax('price', { maxPrice: null });
    if (request.dms.required) await tryRelax('dms', { dms: { required: false, planId: request.dms.planId } });
    if (request.travel.maxMinutes) await tryRelax('travel', { travel: { ...request.travel, maxMinutes: null } });

    /*
     * Ни одно условие по отдельности не помогает («психиатр-мужчина со стажем
     * от 20 лет»): предлагаем снять сразу те, что мешают, — и называем их все.
     * Это тоже только предложение: без нажатия ничего не меняется.
     */
    /*
     * Сначала — по два условия («другой день и другое время»): это меньше,
     * чем снимать всё сразу. Предлагаем не больше двух таких пар.
     */
    if (relax.length === 0 && tried.length > 2) {
      for (let first = 0; first < tried.length && relax.length < 2; first += 1) {
        for (let second = first + 1; second < tried.length && relax.length < 2; second += 1) {
          const pair = [tried[first], tried[second]];
          const patch = Object.assign({}, ...pair.map((item) => item.patch));
          const attempt = await run(normalizeSearchRequest({ ...request, ...patch }).request, { at, today, travelCache });
          if (attempt.candidates.length > 0) {
            relax.push({ key: 'combined', label: `Снять два условия: ${pair.map((item) => RELAX_LABELS[item.key]).join(' и ')}`, count: attempt.candidates.length, patch });
          }
        }
      }
    }
    if (relax.length === 0 && tried.length > 1) {
      const patch = Object.assign({}, ...tried.map((item) => item.patch));
      const relaxed = normalizeSearchRequest({ ...request, ...patch }).request;
      const attempt = await run(relaxed, { at, today, travelCache });
      if (attempt.candidates.length > 0) {
        relax.push({ key: 'combined', label: `Снять сразу: ${tried.map((item) => RELAX_LABELS[item.key]).join('; ')}`, count: attempt.candidates.length, patch });
      }
    }

    const days = result.days;
    const noDays = days.length === 0;
    return {
      ...base,
      status: 'empty',
      notices,
      funnel: result.funnel,
      blocking: blockingStage ? { key: blockingStage.key, label: blockingStage.label, text: BLOCKING_TEXT[blockingStage.key] } : null,
      relax,
      message: noDays
        ? 'Подходящих вариантов нет: в расписании на ближайшие две недели нет дня под это условие. Условия я не ослаблял.'
        : `Подходящих вариантов нет: ${BLOCKING_TEXT[blockingStage?.key] || 'под все условия сразу никто не подошёл'}. Условия я не ослаблял.`,
    };
  };

  return Object.freeze({ search, coverageOf: (planId, args) => coverageOf(index, planId, args) });
};
