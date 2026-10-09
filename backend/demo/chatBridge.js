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

import { describeRequest, normalizeSearchRequest } from '../../shared/demoSearch.js';
import { SPECIALTY_CANON } from '../../shared/specialties.js';
import { addDays, moscowDay } from './time.js';

const BOOKING_ACTIONS = new Set(['FIND_DOCTOR', 'GET_AVAILABLE_SLOTS']);

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
  Boolean(booking.date || booking.timeFrom || booking.timeTo || booking.evening || booking.maxPrice || booking.dms || booking.city);

/**
 * {request, doctorLabel} — запрос строгого подбора — или null, если ответ ассистента — не о записи
 * к одному специалисту (маршрут из нескольких точек, клиника, услуга…).
 *
 * @param {object} params
 * @param {object|null} params.booking context.booking из gateway
 * @param {object} params.execution результат executor.run
 * @param {number} params.now мс
 */
export const buildBookingRequest = ({ booking, execution, now }) => {
  if (!booking) return null;
  const action = execution?.action;
  const clarifying = action === 'CLARIFY' && hasBookingCue(booking);
  if (!BOOKING_ACTIONS.has(action) && !clarifying) return null;

  // Несколько профилей в одной реплике — это маршрут по нескольким врачам, не одна запись.
  if (booking.specialties.length > 1) return null;

  const doctorStops = (execution.stops || []).filter((stop) => stop.kind === 'doctor');
  const named = doctorStops.find((stop) => stop.token);
  let doctorId = null;
  if (named) {
    // Названный врач не из демо-набора: записи к нему нет, подменять его другим нельзя.
    if (!String(named.id || '').startsWith('demo-doc-')) return null;
    doctorId = String(named.id).split('--')[0];
  }

  const specialty = booking.specialties[0] || (named?.specialtyKey in SPECIALTY_CANON ? named.specialtyKey : null);
  const today = moscowDay(now);

  let date = booking.date || { kind: 'any' };
  if (date.kind === 'date') {
    const day = resolveCalendarDate(date, today);
    date = day ? { kind: 'date', day } : { kind: 'date', day: addDays(today, -1) };
  }

  const { request: normalized } = normalizeSearchRequest({
    specialty,
    doctorId,
    visit: booking.visit || 'first',
    patient: booking.child ? 'child' : 'adult',
    date,
    timeFrom: booking.timeFrom,
    timeTo: booking.timeTo,
    evening: booking.evening,
    weekend: booking.weekend,
    maxPrice: booking.maxPrice,
    dms: { required: booking.dms === true, planId: null },
    travel: {
      maxMinutes: booking.maxTravelMinutes,
      mode: booking.travelMode || execution.travelMode || 'driving',
      nearest: booking.nearest,
    },
    city: booking.city,
  });
  return {
    request: normalized,
    // Имя демо-врача — из справочника, а не из слов пользователя.
    doctorLabel: named ? [named.name, named.specialty].filter(Boolean).join(', ') : null,
  };
};

/** Условия запроса словами — для чата; названный демо-врач идёт первым. */
export const summarizeBooking = ({ request, doctorLabel = null }) => [
  ...(doctorLabel ? [doctorLabel] : []),
  ...describeRequest(request, { specialtyLabel: (key) => SPECIALTY_CANON[key] || key }),
];

/** Текст ассистента для режима записи: что понято и что будет проверено. */
export const bookingReplyText = ({ request, doctorLabel = null, booking }) => {
  const parts = [];
  const summary = summarizeBooking({ request, doctorLabel });
  if (!request.specialty && !request.doctorId) {
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

