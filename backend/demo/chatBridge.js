/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Мост «ассистент → строгий подбор демо-записи».
 *
 * Из понятого запроса (условия, извлечённые gateway по исходному тексту, и
 * план) собирается запрос строгого подбора (shared/demoSearch.js). Его
 * исполняет сервер — POST /api/demo/search, — а интерфейс добавляет только
 * точку отправления и выбранную программу ДМС: эти данные остаются в
 * браузере и в /api/chat не приходят.
 *
 * Важно: условия берутся НЕ из ответа модели, а из детерминированного
 * разбора текста. Модель выбирает действие, но не может «потерять» или
 * ослабить «завтра», «после 18:00», «по ДМС» или «до 3000 ₽».
 */

import { describeRequest, LOCALITIES, normalizeSearchRequest } from '../../shared/demoSearch.js';
import { SPECIALTY_CANON } from '../../shared/specialties.js';
import { moscowDay } from './time.js';

const BOOKING_ACTIONS = new Set(['FIND_DOCTOR', 'GET_AVAILABLE_SLOTS']);
// «ЛОР в клинике Ясень»: модель может ответить поиском клиники, а запись — к врачу в ней.
const CLINIC_ACTIONS = new Set(['FIND_CLINIC']);

export { bookingModeFromEnv } from './flags.js';

/** «15 октября» без года → ближайшая такая дата не раньше сегодняшней. */
const resolveCalendarDate = ({ month, dayOfMonth }, today) => {
  const [year] = today.split('-').map(Number);
  for (const candidateYear of [year, year + 1]) {
    const day = `${candidateYear}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
    const check = new Date(`${day}T12:00:00Z`);
    if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== dayOfMonth) return null;
    if (day >= today) return day;
  }
  return null;
};

const hasBookingCue = (booking) =>
  Boolean(booking.date || booking.timeFrom || booking.timeTo || booking.evening || booking.maxPrice || booking.dms || booking.city || booking.serviceId
    || booking.workdays || booking.minExperience || booking.doctorGender || booking.doctorIds?.length || booking.unsupported?.length);

const resolveDate = (date, today) => {
  if (date.kind === 'date') {
    const day = resolveCalendarDate(date, today);
    const expect = date.expectWeekday ? { expectWeekday: date.expectWeekday } : {};
    // Несуществующая дата («31 ноября») — вопрос, а не соседний день.
    return day ? { kind: 'date', day, ...expect } : { kind: 'invalid', month: date.month, dayOfMonth: date.dayOfMonth };
  }
  if (date.kind === 'any_of') return { kind: 'any_of', options: date.options.map((option) => resolveDate(option, today)) };
  return date;
};

/** Подписи названных врачей и клиник — из справочника демо, не из слов пользователя. */
export const refLabels = (index, request) => ({
  doctorLabels: index ? request.doctorIds.map((id) => index.doctors.get(id)).filter(Boolean).map((doctor) => `${doctor.name} (${doctor.specialty.toLowerCase()})`) : [],
  branchLabels: index ? branchLabelsOf(index, request.branchIds) : [],
  excludedDoctorLabels: index ? request.excludeDoctorIds.map((id) => index.doctors.get(id)?.name).filter(Boolean) : [],
  excludedBranchLabels: index ? branchLabelsOf(index, request.excludeBranchIds) : [],
});

/** «Разумед» — если названы все его филиалы; «Разумед, ул. Пушкина» — если один. */
export const branchLabelsOf = (index, branchIds) => {
  const byClinic = new Map();
  for (const id of branchIds) {
    const entry = index.branches.get(id);
    if (!entry) continue;
    if (!byClinic.has(entry.clinic.id)) byClinic.set(entry.clinic.id, { clinic: entry.clinic, branches: [] });
    byClinic.get(entry.clinic.id).branches.push(entry.branch);
  }
  return [...byClinic.values()].flatMap(({ clinic, branches }) => (branches.length === clinic.branches.length
    ? [clinic.name]
    : branches.map((branch) => `${clinic.name}, ${branch.name}`)));
};

/**
 * {request, doctorLabel} — запрос строгого подбора — или null, если ответ ассистента — не о записи
 * к одному специалисту (маршрут из нескольких точек, клиника, услуга…).
 *
 * @param {object} params
 * @param {object|null} params.booking context.booking из gateway
 * @param {object} params.execution результат executor.run
 * @param {number} params.now мс
 */
export const buildBookingRequest = ({ booking, execution, now, index = null }) => {
  if (!booking) return null;
  const action = execution?.action;
  const clarifying = action === 'CLARIFY' && hasBookingCue(booking);
  // «Подбор очков», «ЭКГ»: модель видит в этом услугу, а запись — на процедуру к врачу.
  const procedure = action === 'SEARCH_SERVICE' && Boolean(booking.serviceId);
  const atClinic = CLINIC_ACTIONS.has(action) && booking.specialties.length === 1 && (booking.branchIds.length > 0 || hasBookingCue(booking));
  /*
   * «ЛОР не дальше 15 минут от дома»: дом здесь — точка отправления, а не
   * следующая остановка маршрута «ЛОР → дом», как может решить планировщик.
   */
  const singleDoctorRoute = action === 'BUILD_ROUTE' && booking.specialties.length === 1
    && (execution.stops || []).filter((stop) => stop.kind === 'doctor').length <= 1;
  const fromPlace = singleDoctorRoute && Boolean(booking.originHint);
  // «Кардиолог в Ситидок или Разумед»: выбор клиники, а не маршрут через обе.
  const clinicChoice = singleDoctorRoute && booking.clinicChoice;
  if (!BOOKING_ACTIONS.has(action) && !clarifying && !procedure && !atClinic && !fromPlace && !clinicChoice) return null;

  // Несколько профилей в одной реплике — это маршрут по нескольким врачам, не одна запись.
  if (booking.specialties.length > 1) return null;
  // Названный врач не из демо-набора: записи к нему нет, подменять его другим нельзя.
  if (booking.foreignDoctor) return null;

  /*
   * Врачи — только из разбора текста (все однофамильцы подходящей формы,
   * «но не Ефимов» — исключение), а не из выбора модели: модель могла
   * поставить в план и врача, которого пользователь исключил.
   */
  const doctorIds = booking.doctorIds;

  const specialty = booking.specialties[0] || null;
  const today = moscowDay(now);

  const { request: normalized } = normalizeSearchRequest({
    specialty,
    doctorIds,
    excludeDoctorIds: booking.excludeDoctorIds,
    branchIds: booking.branchIds,
    excludeBranchIds: booking.excludeBranchIds,
    excludeWeekdays: booking.excludeWeekdays,
    preferGender: booking.preferGender,
    districts: booking.districts,
    excludeDistricts: booking.excludeDistricts,
    doctorGender: booking.doctorGender,
    minExperience: booking.minExperience,
    unsupported: booking.unsupported,
    serviceId: booking.serviceId || null,
    visit: booking.visit || 'first',
    // Педиатр — всегда детский приём, даже если ребёнок не упомянут.
    patient: booking.child || specialty === 'pediatrician' ? 'child' : 'adult',
    date: resolveDate(booking.date || { kind: 'any' }, today),
    timeFrom: booking.timeFrom,
    timeTo: booking.timeTo,
    evening: booking.evening,
    weekend: booking.weekend,
    workdays: booking.workdays,
    maxPrice: booking.maxPrice,
    dms: { required: booking.dms === true, planId: booking.planId || null },
    travel: {
      maxMinutes: booking.maxTravelMinutes,
      mode: booking.travelMode || execution.travelMode || 'driving',
      nearest: booking.nearest,
    },
    originHint: booking.originHint,
    city: booking.city,
  });
  return { request: normalized, ...refLabels(index, normalized), planName: index?.plans.get(normalized.dms.planId)?.name || null };
};

/** Условия запроса словами — для чата; названные демо-врачи идут первыми. */
export const summarizeBooking = ({ request, doctorLabels = [], branchLabels = [], excludedDoctorLabels = [], excludedBranchLabels = [], planName = null }) =>
  describeRequest(request, { specialtyLabel: (key) => SPECIALTY_CANON[key] || key, doctorLabels, branchLabels, excludedDoctorLabels, excludedBranchLabels, planName });

/** Текст ассистента для режима записи: что понято и что будет проверено. */
export const bookingReplyText = ({ request, booking, ...labels }) => {
  const parts = [];
  const summary = summarizeBooking({ request, ...labels });
  const locality = request.city ? LOCALITIES[request.city] : null;
  if (locality && !locality.covered) {
    // Город вне покрытия: не обещаем «подбор ниже» — сразу говорим как есть.
    parts.push(`Понял запрос: ${summary.join(', ')}.`);
    parts.push(`${locality.name} — вне покрытия: демо-клиники и карта дорог МедКарты есть только по Казани. Искать в Казани вместо этого — только если скажете.`);
  } else if (!request.specialty && request.doctorIds.length === 0) {
    parts.push('Подберу врача и свободное время. Подскажите, какой специалист нужен?');
    if (summary.length > 0) parts.push(`Условия, которые я учту: ${summary.join(', ')}.`);
  } else {
    parts.push(`Ищу свободное время: ${summary.join(', ')}.`);
    parts.push('Показываю только варианты, которые подходят под все условия, — подбор ниже. Условия без вашего согласия не ослабляю.');
  }
  if (booking?.medicalText && request.specialty) {
    parts.push('Профиль врача подобран по описанию — это не диагноз.');
  }
  parts.push('Запись демонстрационная: клиники и расписание вымышлены.');
  return parts.join(' ');
};

