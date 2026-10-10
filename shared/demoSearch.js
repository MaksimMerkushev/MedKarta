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
export const DATE_KINDS = Object.freeze(['any', 'today', 'tomorrow', 'after_tomorrow', 'weekday', 'weekend', 'this_week', 'next_week', 'date', 'any_of', 'invalid']);
/* Дни, которые можно перечислить через «или»: «во вторник или среду», «сегодня или завтра». */
const SIMPLE_DATE_KINDS = Object.freeze(['today', 'tomorrow', 'after_tomorrow', 'weekday', 'date']);

/** Районы Казани — как в справочнике. */
export const DISTRICTS = Object.freeze(['Авиастроительный', 'Вахитовский', 'Кировский', 'Московский', 'Ново-Савиновский', 'Приволжский', 'Советский']);

/*
 * Условия, которые демо проверить не может: в нём нет выездов на дом,
 * онлайн-приёмов и отзывов о врачах. Подбор не делает вид, что учёл их, —
 * отвечает «не могу» и предлагает снять условие только с согласия.
 */
export const UNSUPPORTED_CONDITIONS = Object.freeze({
  home_visit: 'выезд врача на дом',
  online: 'онлайн-консультация',
  rating: 'рейтинг и отзывы о врачах',
  oms: 'бесплатный приём по ОМС',
});

/*
 * Точка отправления, названная словами («от дома», «от работы», «рядом с
 * Кремлём»). Координат по названию демо не знает и текущую геолокацию за
 * «дом» не выдаёт: подбор спросит точку. Слова пользователя сюда не
 * попадают — только вид места.
 */
export const ORIGIN_HINTS = Object.freeze({ home: 'от дома', work: 'от работы', place: 'от названного места' });

/*
 * Названная клиника, в которой демо-записи нет: подбор не подменяет её
 * другими клиниками, а честно отвечает «там записи нет» и предлагает
 * поискать в других — только с согласия.
 */
export const NO_DEMO_BRANCH = 'demo-none';
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
const BRANCH = /^demo-[a-z0-9-]{2,80}$/;

const uniqueList = (value, test, max) => (Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && test(item)))].slice(0, max) : []);

const normalizeSimpleDate = (input) => {
  if (!input || typeof input !== 'object' || !SIMPLE_DATE_KINDS.includes(input.kind)) return null;
  if (input.kind === 'weekday') {
    const weekday = Number(input.weekday);
    return Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? { kind: 'weekday', weekday } : null;
  }
  if (input.kind === 'date') return typeof input.day === 'string' && DAY.test(input.day) ? { kind: 'date', day: input.day } : null;
  return { kind: input.kind };
};

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
  // Названные врачи (однофамильцы — все) и клиники: подбор только среди них.
  const doctorIds = uniqueList([...(doctorId ? [doctorId] : []), ...(Array.isArray(input.doctorIds) ? input.doctorIds : [])], (item) => DOCTOR.test(item), 5);
  const branchIds = uniqueList(input.branchIds, (item) => BRANCH.test(item), 8);
  const districts = uniqueList(input.districts, (item) => DISTRICTS.includes(item), 3);
  const excludeDistricts = uniqueList(input.excludeDistricts, (item) => DISTRICTS.includes(item) && !districts.includes(item), 7);
  const minExperience = Number.isInteger(input.minExperience) && input.minExperience >= 1 && input.minExperience <= 60 ? input.minExperience : null;
  const doctorGender = input.doctorGender === 'female' || input.doctorGender === 'male' ? input.doctorGender : null;
  // «Желательно женщина» — пожелание: такие врачи первыми, остальные не отбрасываются.
  const preferGender = !doctorGender && (input.preferGender === 'female' || input.preferGender === 'male') ? input.preferGender : null;
  // «Но не Ефимов», «не в Ясене», «только не в понедельник» — исключения.
  const excludeDoctorIds = uniqueList(input.excludeDoctorIds, (item) => DOCTOR.test(item) && !doctorIds.includes(item), 10);
  const excludeBranchIds = uniqueList(input.excludeBranchIds, (item) => BRANCH.test(item) && !branchIds.includes(item), 10);
  const excludeWeekdays = Array.isArray(input.excludeWeekdays)
    ? [...new Set(input.excludeWeekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort().slice(0, 6)
    : [];
  const unsupported = uniqueList(input.unsupported, (item) => Object.hasOwn(UNSUPPORTED_CONDITIONS, item), 3);
  const originHint = Object.hasOwn(ORIGIN_HINTS, input.originHint) ? input.originHint : null;
  // Точку для названного места пользователь подтвердил сам (поставил на карте / «я там»).
  const originConfirmed = input.originConfirmed === true;
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
  if (date.kind === 'invalid') {
    // «31 ноября»: такой даты нет — подбор спросит, а не подставит соседний день.
    const month = Number(dateInput.month);
    const dayOfMonth = Number(dateInput.dayOfMonth);
    date = Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31
      ? { kind: 'invalid', month, dayOfMonth }
      : { kind: 'any' };
  }
  if (date.kind === 'any_of') {
    const options = (Array.isArray(dateInput.options) ? dateInput.options : []).map(normalizeSimpleDate).filter(Boolean).slice(0, 7);
    date = options.length > 1 ? { kind: 'any_of', options } : options[0] || { kind: 'any' };
  }
  // «В субботу 16 октября»: день недели, который пользователь ждёт от этой даты, — для проверки.
  const expectWeekday = Number(dateInput.expectWeekday);
  if (['date', 'today', 'tomorrow', 'after_tomorrow'].includes(date.kind) && Number.isInteger(expectWeekday) && expectWeekday >= 1 && expectWeekday <= 7) {
    date = { ...date, expectWeekday };
  }

  const timeFrom = TIME.test(input.timeFrom || '') ? input.timeFrom : null;
  const timeTo = TIME.test(input.timeTo || '') ? input.timeTo : null;
  const evening = input.evening === true;
  // «В будни» и «в выходные» — фильтр поверх дня; вместе не бывают, побеждает будни.
  const workdays = input.workdays === true;
  const weekend = input.weekend === true && !workdays;

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
    request: {
      specialty, doctorIds, excludeDoctorIds, branchIds, excludeBranchIds, districts, excludeDistricts, serviceId, visit, patient,
      minExperience, doctorGender, preferGender, excludeWeekdays,
      date, timeFrom, timeTo, evening, weekend, workdays, maxPrice, dms, travel, origin, originHint, originConfirmed, city, unsupported, limit,
    },
    errors,
  };
};

const WEEKDAYS_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

const describeSimpleDate = (date) => {
  if (date.kind === 'today') return 'сегодня';
  if (date.kind === 'tomorrow') return 'завтра';
  if (date.kind === 'after_tomorrow') return 'послезавтра';
  if (date.kind === 'weekday') return `${date.weekday === 2 ? 'во' : 'в'} ${WEEKDAYS_ACC[date.weekday]}`;
  if (date.kind === 'date') return date.day.split('-').reverse().join('.');
  return null;
};

const yearsGenitive = (count) => (count % 10 === 1 && count % 100 !== 11 ? 'года' : 'лет');

/**
 * Условия запроса человеческими словами — для чата и карточек: что
 * именно понял ассистент и что будет проверено.
 */
const WEEKDAYS_GEN = ['', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы', 'воскресенья'];
const weekdayOfDay = (day) => {
  const value = new Date(`${day}T12:00:00Z`).getUTCDay();
  return value === 0 ? 7 : value;
};

export const describeRequest = (request, {
  specialtyLabel = (key) => key, planName = null, doctorLabels = [], branchLabels = [], excludedDoctorLabels = [], excludedBranchLabels = [],
} = {}) => {
  const parts = [];
  if (doctorLabels.length > 0) parts.push(doctorLabels.join(' или '));
  if (excludedDoctorLabels.length > 0) parts.push(`не ${excludedDoctorLabels.join(', не ')}`);
  if (request.specialty) parts.push(specialtyLabel(request.specialty));
  if (request.patient === 'child') parts.push('детский приём');
  if (request.branchIds?.includes(NO_DEMO_BRANCH)) parts.push('в названной клинике');
  else if (branchLabels.length > 0) parts.push(`клиника: ${branchLabels.join(' или ')}`);
  if (excludedBranchLabels.length > 0) parts.push(`кроме: ${excludedBranchLabels.join(', ')}`);
  if (request.districts?.length) parts.push(`${request.districts.join(' или ')} район`);
  if (request.excludeDistricts?.length) parts.push(`не ${request.excludeDistricts.join(', не ')} район`);
  if (request.doctorGender) parts.push(request.doctorGender === 'female' ? 'врач-женщина' : 'врач-мужчина');
  if (request.preferGender) parts.push(request.preferGender === 'female' ? 'желательно женщина (такие — первыми)' : 'желательно мужчина (такие — первыми)');
  if (request.minExperience) parts.push(`стаж от ${request.minExperience} ${yearsGenitive(request.minExperience)}`);
  if (request.serviceId) parts.push(SERVICE_BY_ID[request.serviceId]?.name || 'процедура');
  else if (request.visit === 'procedure') parts.push('процедура или обследование');
  if (request.visit === 'repeat') parts.push('повторный приём');
  const date = request.date || { kind: 'any' };
  const simple = describeSimpleDate(date);
  if (simple) parts.push(simple);
  if (date.kind === 'any_of') {
    const options = date.options.map(describeSimpleDate);
    parts.push(options.length > 2 ? `${options.slice(0, -1).join(', ')} или ${options[options.length - 1]}` : options.join(' или '));
  }
  if (date.kind === 'invalid') parts.push(`${String(date.dayOfMonth).padStart(2, '0')}.${String(date.month).padStart(2, '0')} — такой даты нет`);
  // Названный день недели показываем, только если он расходится с датой.
  if (date.expectWeekday && !(date.day && weekdayOfDay(date.day) === date.expectWeekday)) parts.push(`(вы указали ${WEEKDAYS_ACC[date.expectWeekday]})`);
  if (request.excludeWeekdays?.length) parts.push(`кроме ${request.excludeWeekdays.map((day) => WEEKDAYS_GEN[day]).join(' и ')}`);
  if (date.kind === 'this_week') parts.push('на этой неделе');
  if (date.kind === 'next_week') parts.push('на следующей неделе');
  // «В субботу» уже говорит о выходных — второй раз не повторяем.
  const weekendDay = date.kind === 'weekday' && date.weekday >= 6;
  if ((request.weekend || date.kind === 'weekend') && !weekendDay) parts.push('в выходные');
  if (request.workdays) parts.push('в будни');
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const width = request.timeFrom && request.timeTo ? minutes(request.timeTo) - minutes(request.timeFrom) : null;
  const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  // «На 17:30» — окно в минуту, «около 18:00» — ±30 минут: так и пишем, а не «с 17:30 до 17:31».
  if (width === 1) parts.push(`ровно в ${request.timeFrom}`);
  else if (width === 61) parts.push(`около ${clock(minutes(request.timeFrom) + 30)} (±30 мин)`);
  else if (request.timeFrom && request.timeTo) parts.push(`с ${request.timeFrom} до ${request.timeTo}`);
  else if (request.timeFrom) parts.push(`после ${request.timeFrom}`);
  else if (request.evening) parts.push(`вечером (с ${EVENING_FROM})`);
  if (request.timeTo && !request.timeFrom) parts.push(`до ${request.timeTo}`);
  if (request.maxPrice) parts.push(`до ${request.maxPrice.toLocaleString('ru-RU')} ₽`);
  if (request.dms?.required) parts.push(planName ? `по ДМС «${planName}»` : 'по ДМС');
  else if (planName && request.dms?.planId) parts.push(`программа «${planName}»`);
  if (request.travel?.maxMinutes) {
    const mode = { driving: 'на машине', foot: 'пешком', bike: 'на велосипеде' }[request.travel.mode];
    parts.push(`не дольше ${request.travel.maxMinutes} мин ${mode}`);
  } else if (request.travel?.nearest) {
    parts.push('поближе');
  }
  if (request.originHint) parts.push(ORIGIN_HINTS[request.originHint]);
  if (request.city && request.city !== 'kazan') parts.push(LOCALITIES[request.city]?.name || request.city);
  for (const key of request.unsupported || []) parts.push(UNSUPPORTED_CONDITIONS[key]);
  return parts;
};
