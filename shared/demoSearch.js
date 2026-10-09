/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Запрос строгого подбора демо-записи: что ищем и какие условия
 * ОБЯЗАТЕЛЬНЫ. Общий модуль браузера и сервера: ассистент собирает запрос
 * из понятого (searchRequest в ответе /api/chat), интерфейс добавляет
 * программу ДМС и точку отправления, сервер проверяет и исполняет.
 *
 * Здесь только перечислимые значения и числа — ни слова пользователя.
 */

import { SPECIALTY_KEYS } from './specialties.js';
import { SERVICE_BY_ID } from './services.js';

export const VISIT_KINDS = Object.freeze(['first', 'repeat', 'procedure', 'any']);
export const DATE_KINDS = Object.freeze(['any', 'today', 'tomorrow', 'after_tomorrow', 'weekday', 'weekend', 'this_week', 'next_week', 'date']);
export const TRAVEL_MODES = Object.freeze(['driving', 'foot', 'bike']);

/*
 * Населённые пункты, которые ассистент узнаёт по названию. Демо-набор и
 * граф дорог — только Казань: всё остальное честно называется «вне
 * покрытия», а не подменяется Казанью.
 */
export const LOCALITIES = Object.freeze({
  kazan: { name: 'Казань', covered: true },
  innopolis: { name: 'Иннополис', covered: false },
  zelenodolsk: { name: 'Зеленодольск', covered: false },
  vysokaya_gora: { name: 'Высокая Гора', covered: false },
  naberezhnye_chelny: { name: 'Набережные Челны', covered: false },
  almetyevsk: { name: 'Альметьевск', covered: false },
  nizhnekamsk: { name: 'Нижнекамск', covered: false },
  moscow: { name: 'Москва', covered: false },
  saint_petersburg: { name: 'Санкт-Петербург', covered: false },
});

/** Вечер — начало приёма не раньше этого времени. */
export const EVENING_FROM = '17:00';
export const MAX_RESULTS = 5;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLAN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DOCTOR = /^demo-doc-[a-z0-9-]{2,60}$/;

const isCoordinate = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Приводит запрос к строгой форме. Неизвестное значение не «угадывается»,
 * а отбрасывается — и попадает в errors, чтобы сервер мог честно ответить.
 *
 * @returns {{request: object, errors: string[]}}
 */
export const normalizeSearchRequest = (raw = {}) => {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  const specialty = SPECIALTY_KEYS.includes(input.specialty) ? input.specialty : null;
  if (input.specialty != null && !specialty) errors.push('specialty');

  const doctorId = typeof input.doctorId === 'string' && DOCTOR.test(input.doctorId) ? input.doctorId : null;
  /*
   * Конкретная процедура или обследование («подбор очков», «ЭКГ»): запись
   * только на эту услугу. Неизвестная услуга — ошибка, а не «первичный приём».
   */
  const serviceId = typeof input.serviceId === 'string' && /^(?:proc|diag)\./.test(input.serviceId) && Object.hasOwn(SERVICE_BY_ID, input.serviceId)
    ? input.serviceId
    : null;
  if (input.serviceId != null && !serviceId) errors.push('serviceId');
  const visit = serviceId ? 'procedure' : VISIT_KINDS.includes(input.visit) ? input.visit : 'first';
  const patient = input.patient === 'child' ? 'child' : 'adult';

  const dateInput = input.date && typeof input.date === 'object' ? input.date : { kind: 'any' };
  let date = { kind: DATE_KINDS.includes(dateInput.kind) ? dateInput.kind : 'any' };
  if (date.kind === 'weekday') {
    const weekday = Number(dateInput.weekday);
    date = Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? { kind: 'weekday', weekday } : { kind: 'any' };
  }
  if (date.kind === 'date') {
    date = typeof dateInput.day === 'string' && DAY.test(dateInput.day) ? { kind: 'date', day: dateInput.day } : { kind: 'any' };
  }

  const timeFrom = TIME.test(input.timeFrom || '') ? input.timeFrom : null;
  const timeTo = TIME.test(input.timeTo || '') ? input.timeTo : null;
  const evening = input.evening === true;
  const weekend = input.weekend === true;

  const maxPrice = Number.isInteger(input.maxPrice) && input.maxPrice >= 100 && input.maxPrice <= 100000 ? input.maxPrice : null;
  if (input.maxPrice != null && maxPrice === null) errors.push('maxPrice');

  const dmsInput = input.dms && typeof input.dms === 'object' ? input.dms : {};
  const dms = {
    required: dmsInput.required === true,
    planId: typeof dmsInput.planId === 'string' && PLAN.test(dmsInput.planId) ? dmsInput.planId : null,
  };

  const travelInput = input.travel && typeof input.travel === 'object' ? input.travel : {};
  const maxMinutes = Number.isInteger(travelInput.maxMinutes) && travelInput.maxMinutes >= 5 && travelInput.maxMinutes <= 120 ? travelInput.maxMinutes : null;
  if (travelInput.maxMinutes != null && maxMinutes === null) errors.push('maxMinutes');
  const travel = {
    maxMinutes,
    mode: TRAVEL_MODES.includes(travelInput.mode) ? travelInput.mode : 'driving',
    nearest: travelInput.nearest === true,
  };

  const origin = input.origin && isCoordinate(input.origin.lat) && isCoordinate(input.origin.lng)
    ? { lat: input.origin.lat, lng: input.origin.lng }
    : null;

  const city = typeof input.city === 'string' && Object.hasOwn(LOCALITIES, input.city) ? input.city : null;
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), MAX_RESULTS) : MAX_RESULTS;

  return {
    request: { specialty, doctorId, serviceId, visit, patient, date, timeFrom, timeTo, evening, weekend, maxPrice, dms, travel, origin, city, limit },
    errors,
  };
};

const WEEKDAYS_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

/**
 * Условия запроса человеческими словами — для чата и карточек: что
 * именно понял ассистент и что будет проверено.
 */
export const describeRequest = (request, { specialtyLabel = (key) => key, planName = null } = {}) => {
  const parts = [];
  if (request.specialty) parts.push(specialtyLabel(request.specialty));
  if (request.patient === 'child') parts.push('детский приём');
  if (request.serviceId) parts.push(SERVICE_BY_ID[request.serviceId]?.name || 'процедура');
  else if (request.visit === 'procedure') parts.push('процедура или обследование');
  if (request.visit === 'repeat') parts.push('повторный приём');
  const date = request.date || { kind: 'any' };
  if (date.kind === 'today') parts.push('сегодня');
  if (date.kind === 'tomorrow') parts.push('завтра');
  if (date.kind === 'after_tomorrow') parts.push('послезавтра');
  if (date.kind === 'weekday') parts.push(`в ${WEEKDAYS_ACC[date.weekday]}`);
  if (date.kind === 'this_week') parts.push('на этой неделе');
  if (date.kind === 'next_week') parts.push('на следующей неделе');
  if (date.kind === 'date') parts.push(date.day.split('-').reverse().join('.'));
  // «В субботу» уже говорит о выходных — второй раз не повторяем.
  const weekendDay = date.kind === 'weekday' && date.weekday >= 6;
  if ((request.weekend || date.kind === 'weekend') && !weekendDay) parts.push('в выходные');
  if (request.timeFrom && request.timeTo) parts.push(`с ${request.timeFrom} до ${request.timeTo}`);
  else if (request.timeFrom) parts.push(`после ${request.timeFrom}`);
  else if (request.evening) parts.push(`вечером (с ${EVENING_FROM})`);
  if (request.timeTo && !request.timeFrom) parts.push(`до ${request.timeTo}`);
  if (request.maxPrice) parts.push(`до ${request.maxPrice.toLocaleString('ru-RU')} ₽`);
  if (request.dms?.required) parts.push(planName ? `по ДМС «${planName}»` : 'по ДМС');
  if (request.travel?.maxMinutes) {
    const mode = { driving: 'на машине', foot: 'пешком', bike: 'на велосипеде' }[request.travel.mode];
    parts.push(`не дольше ${request.travel.maxMinutes} мин ${mode}`);
  } else if (request.travel?.nearest) {
    parts.push('поближе');
  }
  if (request.city && request.city !== 'kazan') parts.push(LOCALITIES[request.city]?.name || request.city);
  return parts;
};
