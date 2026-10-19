/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Строгий запрос подбора демо-записи, общий для браузера и сервера: ассистент
 * собирает его (searchRequest в ответе /api/chat), интерфейс добавляет ДМС и точку
 * отправления, сервер проверяет и исполняет. Только перечисления и числа — без слов пользователя.
 */

import { SPECIALTY_KEYS } from './specialties.js';
import { SERVICE_BY_ID } from './services.js';

export const VISIT_KINDS = Object.freeze(['first', 'repeat', 'procedure', 'any']);
// past — «вчера», «1 января 2020»: день уже прошёл, подбор спросит другой.
export const DATE_KINDS = Object.freeze(['any', 'today', 'tomorrow', 'after_tomorrow', 'weekday', 'weekend', 'this_week', 'next_week', 'date', 'any_of', 'range', 'invalid', 'past']);
/* Дни, которые можно перечислить через «или»: «во вторник или среду», «сегодня или завтра». */
const SIMPLE_DATE_KINDS = Object.freeze(['today', 'tomorrow', 'after_tomorrow', 'weekday', 'date']);

/** Районы Казани — как в справочнике. */
export const DISTRICTS = Object.freeze(['Авиастроительный', 'Вахитовский', 'Кировский', 'Московский', 'Ново-Савиновский', 'Приволжский', 'Советский']);

/*
 * Условия, которые демо проверить не может. Подбор не делает вид, что учёл их:
 * отвечает «не могу» и снимает условие только с согласия.
 */
export const UNSUPPORTED_CONDITIONS = Object.freeze({
  home_visit: 'выезд врача на дом',
  online: 'онлайн-консультация',
  rating: 'рейтинг и отзывы о врачах',
  oms: 'бесплатный приём по ОМС',
  doctor_age: 'возраст врача (в демо-наборе указан только стаж)',
  anonymous: 'анонимный приём',
  multi_patient: 'запись нескольких пациентов подряд',
  certificate: 'оформление справки',
});

/*
 * Замена, на которую пользователь согласился заранее («по ОМС, а если нельзя —
 * платно»): подбор ищет её и так и пишет в понятых условиях.
 */
export const CONSENTED_FALLBACKS = Object.freeze({
  oms: 'платно: приёма по ОМС в демо нет, вы разрешили платный',
  home_visit: 'в клинике: выезда на дом в демо нет, вы согласились приехать',
  online: 'очно: онлайн-консультаций в демо нет, вы согласились на очный приём',
  rating: 'без отзывов: их в демо нет, вы согласились на любого врача',
  doctor_age: 'без учёта возраста врача: в демо его нет, вы согласились на любого',
});

/*
 * Точка отправления, названная словами («от дома», «рядом с Кремлём»). Координат
 * по названию демо не знает и геолокацию за «дом» не выдаёт — подбор спросит точку.
 * Сюда попадает только вид места, не слова пользователя.
 */
export const ORIGIN_HINTS = Object.freeze({ home: 'от дома', work: 'от работы', place: 'от названного места' });

/*
 * Названная клиника без демо-записи: подбор не подменяет её другими, а отвечает
 * «там записи нет» и ищет в других только с согласия.
 */
export const NO_DEMO_BRANCH = 'demo-none';
export const TRAVEL_MODES = Object.freeze(['driving', 'foot', 'bike']);

/*
 * Населённые пункты, которые ассистент узнаёт по названию. Демо-набор и граф
 * дорог — только Казань: остальное — «вне покрытия», а не подменяется Казанью.
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

/*
 * Своё окно времени у дня в перечислении: «в четверг после 15:30, а в
 * пятницу до обеда». Только у вариантов внутри any_of.
 */
const dayWindowOf = (input) => {
  const from = TIME.test(input.from || '') ? input.from : null;
  const to = TIME.test(input.to || '') ? input.to : null;
  return from || to ? { from, to } : {};
};

/** День без своего окна времени — когда окно переносится в общее или снимается. */
export const withoutDayWindow = (option) => {
  const copy = { ...option };
  delete copy.from;
  delete copy.to;
  return copy;
};

const normalizeSimpleDate = (input, { windows = false, top = false } = {}) => {
  if (!input || typeof input !== 'object' || !SIMPLE_DATE_KINDS.includes(input.kind)) return null;
  const window = windows ? dayWindowOf(input) : {};
  if (input.kind === 'weekday') {
    const weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return null;
    /*
     * «На следующей неделе в понедельник» — день этой или следующей недели.
     * «В следующую пятницу», сказанное раньше пятницы, — вопрос (askWeek):
     * ближайшая или через неделю — подбор не выбирает за пользователя.
     */
    const ask = top && input.week === 'next' && input.askWeek === true ? { askWeek: true } : {};
    return ['this', 'next'].includes(input.week) ? { kind: 'weekday', weekday, week: input.week, ...ask, ...window } : { kind: 'weekday', weekday, ...window };
  }
  if (input.kind === 'date') return typeof input.day === 'string' && DAY.test(input.day) ? { kind: 'date', day: input.day, ...window } : null;
  return { kind: input.kind, ...window };
};

const isCoordinate = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Приводит запрос к строгой форме. Неизвестное значение не «угадывается», а
 * отбрасывается; неверные specialty, serviceId, maxPrice и travel.maxMinutes
 * попадают в errors, чтобы сервер мог честно ответить.
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
  // «В Советском, а если там никого — можно Приволжский»: Советский — первыми.
  const preferDistricts = uniqueList(input.preferDistricts, (item) => DISTRICTS.includes(item), 3);
  const excludeDistricts = uniqueList(input.excludeDistricts, (item) => DISTRICTS.includes(item) && !districts.includes(item), 7);
  const minExperience = Number.isInteger(input.minExperience) && input.minExperience >= 1 && input.minExperience <= 60 ? input.minExperience : null;
  // «Лучше со стажем от 20» — пожелание: такие врачи первыми, остальные не отбрасываются.
  const preferMinExperience = !minExperience && Number.isInteger(input.preferMinExperience) && input.preferMinExperience >= 1 && input.preferMinExperience <= 60
    ? input.preferMinExperience
    : null;
  const doctorGender = input.doctorGender === 'female' || input.doctorGender === 'male' ? input.doctorGender : null;
  // «Желательно женщина» — пожелание: такие врачи первыми, остальные не отбрасываются.
  const preferGender = !doctorGender && (input.preferGender === 'female' || input.preferGender === 'male') ? input.preferGender : null;
  // «Но не Ефимов», «не в Ясене», «только не в понедельник» — исключения.
  const excludeDoctorIds = uniqueList(input.excludeDoctorIds, (item) => DOCTOR.test(item) && !doctorIds.includes(item), 10);
  const excludeBranchIds = uniqueList(input.excludeBranchIds, (item) => BRANCH.test(item) && !branchIds.includes(item), 10);
  // «Невролог или терапевт» — любой из профилей (не больше трёх).
  const specialtyAny = uniqueList(input.specialtyAny, (item) => SPECIALTY_KEYS.includes(item), 3);
  // «Желательно в 18:30» — такие варианты первыми; условие — окно пошире.
  const preferTime = typeof input.preferTime === 'string' && TIME.test(input.preferTime) ? input.preferTime : null;
  // «Желательно до 12», «лучше после 17» — окно-пожелание: подходящие первыми.
  const softFrom = TIME.test(input.preferWindow?.from || '') ? input.preferWindow.from : null;
  const softTo = TIME.test(input.preferWindow?.to || '') ? input.preferWindow.to : null;
  const preferWindow = (softFrom || softTo) && !(softFrom && softTo && softFrom >= softTo) ? { from: softFrom, to: softTo } : null;
  // Доступная среда и парковка — свойства филиала.
  const wheelchair = input.wheelchair === true;
  const parking = input.parking === true;
  const excludeWeekdays = Array.isArray(input.excludeWeekdays)
    ? [...new Set(input.excludeWeekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort().slice(0, 6)
    : [];
  const unsupported = uniqueList(input.unsupported, (item) => Object.hasOwn(UNSUPPORTED_CONDITIONS, item), 4);
  const fallbacks = uniqueList(input.fallbacks, (item) => Object.hasOwn(CONSENTED_FALLBACKS, item) && !unsupported.includes(item), 3);
  // «У кого стаж побольше» — опытные первыми; условием не становится.
  const preferExperience = input.preferExperience === true;
  // «Подешевле», «недорого» без суммы — дешёвые первыми, потолок цены не выдумывается.
  const preferCheap = input.preferCheap === true;
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
  let singleWindow = null;
  let date = { kind: DATE_KINDS.includes(dateInput.kind) ? dateInput.kind : 'any' };
  if (date.kind === 'weekday') date = normalizeSimpleDate(dateInput, { top: true }) || { kind: 'any' };
  if (date.kind === 'date') {
    date = typeof dateInput.day === 'string' && DAY.test(dateInput.day) ? { kind: 'date', day: dateInput.day } : { kind: 'any' };
  }
  if (date.kind === 'invalid') {
    // «31 ноября»: такой даты нет — подбор спросит, а не подставит соседний день.
    const month = Number(dateInput.month);
    const dayOfMonth = Number(dateInput.dayOfMonth);
    date = Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 99
      ? { kind: 'invalid', month, dayOfMonth }
      : { kind: 'any' };
  }
  if (date.kind === 'any_of') {
    const options = (Array.isArray(dateInput.options) ? dateInput.options : []).map((option) => normalizeSimpleDate(option, { windows: true })).filter(Boolean).slice(0, 7);
    // Один вариант с окном — это просто день и время: окно переходит в timeFrom/timeTo ниже.
    date = options.length > 1 ? { kind: 'any_of', options } : options[0] ? withoutDayWindow(options[0]) : { kind: 'any' };
    if (options.length === 1 && (options[0].from || options[0].to)) singleWindow = { from: options[0].from || null, to: options[0].to || null };
  }
  if (date.kind === 'range') {
    // «С 15 по 17 октября», «до 20 октября», «в ближайшие 3 дня» — дни между границами включительно.
    const from = typeof dateInput.from === 'string' && DAY.test(dateInput.from) ? dateInput.from : null;
    const to = typeof dateInput.to === 'string' && DAY.test(dateInput.to) ? dateInput.to : null;
    date = from || to ? { kind: 'range', from, to } : { kind: 'any' };
  }
  // «В субботу 16 октября»: день недели, который пользователь ждёт от этой даты, — для проверки.
  const expectWeekday = Number(dateInput.expectWeekday);
  if (['date', 'today', 'tomorrow', 'after_tomorrow'].includes(date.kind) && Number.isInteger(expectWeekday) && expectWeekday >= 1 && expectWeekday <= 7) {
    date = { ...date, expectWeekday };
  }

  const timeFrom = TIME.test(input.timeFrom || '') ? input.timeFrom : singleWindow?.from || null;
  const timeTo = TIME.test(input.timeTo || '') ? input.timeTo : singleWindow?.to || null;
  /*
   * «С 10 до 12 или после 18», «в 18:00 или в 19:00» — несколько окон через
   * «или»: слот подходит, если попадает хотя бы в одно. Тогда timeFrom/timeTo
   * не задаются — окна и есть условие на время.
   */
  const timeWindows = Array.isArray(input.timeWindows)
    ? input.timeWindows
      .filter((item) => item && typeof item === 'object' && (TIME.test(item.from || '') || TIME.test(item.to || '')))
      .map((item) => ({ from: TIME.test(item.from || '') ? item.from : null, to: TIME.test(item.to || '') ? item.to : null }))
      .slice(0, 3)
    : [];
  const excludeDates = uniqueList(input.excludeDates, (item) => DAY.test(item), 7);
  /*
   * «После 7», «до 9» без «утра/вечера» — два прочтения (утро и вечер).
   * Подбор не выбирает: спрашивает, а ответ («вечера» или кнопка) ставит одно.
   */
  const timeChoice = Array.isArray(input.timeChoice) && input.timeChoice.length === 2
    && input.timeChoice.every((item) => item && typeof item === 'object' && (TIME.test(item.from || '') || TIME.test(item.to || '')))
    ? input.timeChoice.map((item) => ({ from: TIME.test(item.from || '') ? item.from : null, to: TIME.test(item.to || '') ? item.to : null }))
    : [];
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
    // «По ДМС, а если никого — платно»: покрытые программой — первыми, остальные не отбрасываются.
    prefer: dmsInput.prefer === true && dmsInput.required !== true,
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
      specialty, specialtyAny, doctorIds, excludeDoctorIds, branchIds, excludeBranchIds, districts, preferDistricts, excludeDistricts, serviceId, visit, patient,
      minExperience, preferMinExperience, doctorGender, preferGender, preferExperience, preferCheap, excludeWeekdays, excludeDates, preferTime, preferWindow, wheelchair, parking, fallbacks,
      date, timeFrom: timeWindows.length > 0 ? null : timeFrom, timeTo: timeWindows.length > 0 ? null : timeTo, timeWindows, timeChoice, evening, weekend, workdays, maxPrice, dms, travel, origin, originHint, originConfirmed, city, unsupported, limit,
    },
    errors,
  };
};

const WEEKDAYS_ACC = ['', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];

const describeDayWindow = (date) => {
  if (date.from && date.to) return ` с ${date.from} до ${date.to}`;
  if (date.from) return ` после ${date.from}`;
  if (date.to) return ` до ${date.to}`;
  return '';
};

/*
 * caption — конкретный день, который сервер вычислил по московскому «сегодня»:
 * «завтра (вторник, 20 октября)». Без него — как раньше, одними словами.
 */
const describeSimpleDate = (date, caption = null) => {
  const withCaption = (words) => `${words}${caption ? ` (${caption})` : ''}${describeDayWindow(date)}`;
  if (date.kind === 'today') return withCaption('сегодня');
  if (date.kind === 'tomorrow') return withCaption('завтра');
  if (date.kind === 'after_tomorrow') return withCaption('послезавтра');
  if (date.kind === 'weekday' && date.askWeek) {
    const nearest = [3, 5, 6].includes(date.weekday) ? 'ближайшую' : date.weekday === 7 ? 'ближайшее' : 'ближайший';
    return `${date.weekday === 2 ? 'во' : 'в'} ${WEEKDAYS_ACC[date.weekday]} — ${nearest} или через неделю (уточните)`;
  }
  if (date.kind === 'weekday') {
    const prefix = date.week === 'next' ? 'на следующей неделе ' : date.week === 'this' ? 'на этой неделе ' : '';
    return withCaption(`${prefix}${date.weekday === 2 ? 'во' : 'в'} ${WEEKDAYS_ACC[date.weekday]}`);
  }
  if (date.kind === 'date') return withCaption(date.day.split('-').reverse().join('.'));
  return null;
};

/** Окно времени словами: «после 19:00», «до 09:00», «с 07:00 до 09:00», «ровно в 20:00». */
export const describeTimeWindow = (item) => {
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  if (item.from && item.to && minutes(item.to) - minutes(item.from) === 1) return `ровно в ${item.from}`;
  if (item.from && item.to && minutes(item.to) - minutes(item.from) === 61) {
    const middle = minutes(item.from) + 30;
    return `около ${String(Math.floor(middle / 60)).padStart(2, '0')}:${String(middle % 60).padStart(2, '0')}`;
  }
  if (item.from && item.to) return `с ${item.from} до ${item.to}`;
  return item.from ? `после ${item.from}` : `до ${item.to}`;
};

const yearsGenitive = (count) => (count % 10 === 1 && count % 100 !== 11 ? 'года' : 'лет');

const WEEKDAYS_GEN = ['', 'понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы', 'воскресенья'];
const weekdayOfDay = (day) => {
  const value = new Date(`${day}T12:00:00Z`).getUTCDay();
  return value === 0 ? 7 : value;
};

/** Условия запроса словами — для чата и карточек: что понял ассистент и что будет проверено. */
export const describeRequest = (request, {
  specialtyLabel = (key) => key, planName = null, doctorLabels = [], branchLabels = [], excludedDoctorLabels = [], excludedBranchLabels = [],
  dayCaption = null,
} = {}) => {
  const parts = [];
  if (doctorLabels.length > 0) parts.push(doctorLabels.join(' или '));
  // Профиль уже виден в подписи названного врача («Ефимова Мария (невролог)») — второй раз не пишем.
  const specialtyShown = request.specialty && doctorLabels.length > 0
    && doctorLabels.every((label) => label.toLowerCase().includes(`(${specialtyLabel(request.specialty).toLowerCase()})`));
  if (request.specialty && !specialtyShown) parts.push(specialtyLabel(request.specialty));
  else if (request.specialtyAny?.length) {
    // «Невролог или терапевт»: после первого — со строчной (кроме аббревиатур вроде «ЛОР»).
    parts.push(request.specialtyAny.map(specialtyLabel).map((label, position) => (position === 0 || label === label.toUpperCase() ? label : label[0].toLowerCase() + label.slice(1))).join(' или '));
  }
  // «Не Морозов» — после профиля: «Уролог или хирург, не Морозов…», а не «не Морозов, Уролог…».
  if (excludedDoctorLabels.length > 0) parts.push(`не ${excludedDoctorLabels.join(', не ')}`);
  if (request.patient === 'child') parts.push('детский приём');
  if (request.branchIds?.includes(NO_DEMO_BRANCH)) parts.push('в названной клинике');
  else if (branchLabels.length > 0) parts.push(`клиника: ${branchLabels.join(' или ')}`);
  if (excludedBranchLabels.length > 0) parts.push(`кроме: ${excludedBranchLabels.join(', ')}`);
  if (request.districts?.length) {
    const preferred = (request.preferDistricts || []).filter((name) => request.districts.includes(name) && request.districts.length > 1);
    parts.push(`${request.districts.join(' или ')} район${preferred.length > 0 ? ` (сначала ${preferred.join(', ')})` : ''}`);
  } else if (request.preferDistricts?.length) {
    parts.push(`лучше ${request.preferDistricts.join(' или ')} район (такие — первыми), можно любой`);
  }
  if (request.excludeDistricts?.length) parts.push(`не ${request.excludeDistricts.join(', не ')} район`);
  if (request.doctorGender) parts.push(request.doctorGender === 'female' ? 'врач-женщина' : 'врач-мужчина');
  if (request.preferGender) parts.push(request.preferGender === 'female' ? 'желательно женщина (такие — первыми)' : 'желательно мужчина (такие — первыми)');
  if (request.minExperience) parts.push(`стаж от ${request.minExperience} ${yearsGenitive(request.minExperience)}`);
  if (request.preferMinExperience) parts.push(`желательно стаж от ${request.preferMinExperience} ${yearsGenitive(request.preferMinExperience)} (такие — первыми)`);
  if (request.preferExperience) parts.push('сначала — врачи с большим стажем');
  if (request.preferCheap) parts.push('сначала — дешевле');
  if (request.serviceId) parts.push(SERVICE_BY_ID[request.serviceId]?.name || 'процедура');
  else if (request.visit === 'procedure') parts.push('процедура или обследование');
  if (request.visit === 'repeat') parts.push('повторный приём');
  const date = request.date || { kind: 'any' };
  // Названный день недели показываем рядом с датой и только если он с ней расходится.
  const mismatch = date.expectWeekday && !(date.day && weekdayOfDay(date.day) === date.expectWeekday);
  const simple = describeSimpleDate(date, mismatch ? null : dayCaption);
  if (simple) parts.push(mismatch ? `${simple} (вы указали ${WEEKDAYS_ACC[date.expectWeekday]})` : simple);
  // «Будни после 19:00 или выходные»: дни недели с одинаковым окном — одной группой.
  const plainWeekdays = date.kind === 'any_of' && date.options.length > 3 && date.options.every((option) => option.kind === 'weekday' && !option.week);
  if (plainWeekdays) {
    const groups = new Map();
    for (const option of date.options) {
      const key = `${option.from || ''}|${option.to || ''}`;
      groups.set(key, [...(groups.get(key) || []), option]);
    }
    parts.push([...groups.values()].map((group) => {
      const days = group.map((option) => option.weekday).sort().join(',');
      const label = days === '1,2,3,4,5' ? 'в будни' : days === '6,7' ? 'в выходные'
        : group.map((option) => `${option.weekday === 2 ? 'во' : 'в'} ${WEEKDAYS_ACC[option.weekday]}`).join(', ');
      return `${label}${describeDayWindow(group[0])}`;
    }).join(' или '));
  } else if (date.kind === 'any_of') {
    const sharedWeek = date.options.every((option) => option.week && option.week === date.options[0].week) ? date.options[0].week : null;
    const options = date.options.map((option) => describeSimpleDate(sharedWeek ? { ...option, week: undefined } : option));
    if (sharedWeek) parts.push(sharedWeek === 'next' ? 'на следующей неделе' : 'на этой неделе');
    parts.push(options.length > 2 ? `${options.slice(0, -1).join(', ')} или ${options[options.length - 1]}` : options.join(' или '));
  }
  if (date.kind === 'invalid') parts.push(`${String(date.dayOfMonth).padStart(2, '0')}.${String(date.month).padStart(2, '0')} — такой даты нет`);
  if (date.kind === 'past') parts.push('прошедший день (уточните)');
  if (date.kind === 'range') {
    const short = (day) => day.split('-').reverse().slice(0, 2).join('.');
    if (date.from && date.to) parts.push(date.from === date.to ? short(date.from) : `с ${short(date.from)} по ${short(date.to)} включительно`);
    else if (date.to) parts.push(`по ${short(date.to)} включительно`);
    else parts.push(`с ${short(date.from)}`);
  }
  if (request.excludeDates?.length) parts.push(`кроме ${request.excludeDates.map((day) => day.split('-').reverse().slice(0, 2).join('.')).join(' и ')}`);
  if (request.excludeWeekdays?.length) parts.push(`кроме ${request.excludeWeekdays.map((day) => WEEKDAYS_GEN[day]).join(' и ')}`);
  if (date.kind === 'this_week') parts.push('на этой неделе');
  if (date.kind === 'next_week') parts.push('на следующей неделе');
  // «В субботу» уже говорит о выходных — второй раз не повторяем.
  const weekendDay = (date.kind === 'weekday' && date.weekday >= 6)
    || (date.kind === 'any_of' && date.options.every((option) => option.kind === 'weekday' && option.weekday >= 6));
  if ((request.weekend || date.kind === 'weekend') && !weekendDay) parts.push('в выходные');
  if (request.workdays) parts.push('в будни');
  const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const width = request.timeFrom && request.timeTo ? minutes(request.timeTo) - minutes(request.timeFrom) : null;
  const clock = (value) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  // «На 17:30» — окно в минуту, «около 18:00» — ±30 минут: так и пишем, а не «с 17:30 до 17:31».
  if (request.timeChoice?.length === 2) {
    parts.push(`время: ${request.timeChoice.map((item) => describeTimeWindow(item)).join(' или ')} (уточните)`);
  }
  if (request.timeWindows?.length) {
    const windowText = (item) => {
      const span = item.from && item.to ? minutes(item.to) - minutes(item.from) : null;
      if (span === 1) return `ровно в ${item.from}`;
      if (item.from && item.to) return `с ${item.from} до ${item.to}`;
      return item.from ? `после ${item.from}` : `до ${item.to}`;
    };
    parts.push(request.timeWindows.map(windowText).join(' или '));
  }
  if (width === 1) parts.push(`ровно в ${request.timeFrom}`);
  else if (width === 61) parts.push(`около ${clock(minutes(request.timeFrom) + 30)} (±30 мин)`);
  else if (request.timeFrom && request.timeTo) parts.push(`с ${request.timeFrom} до ${request.timeTo}`);
  else if (request.timeFrom) parts.push(`после ${request.timeFrom}`);
  else if (request.evening) parts.push(`вечером (с ${EVENING_FROM})`);
  if (request.timeTo && !request.timeFrom) parts.push(`до ${request.timeTo}`);
  if (request.preferTime) parts.push(`желательно в ${request.preferTime}`);
  if (request.preferWindow) parts.push(request.preferWindow.from && request.preferWindow.to ? `желательно с ${request.preferWindow.from} до ${request.preferWindow.to}` : request.preferWindow.from ? `желательно после ${request.preferWindow.from}` : `желательно до ${request.preferWindow.to}`);
  // «По ДМС, а если не входит — не дороже 2000»: потолок цены — для платного приёма.
  const paidLimit = request.maxPrice ? ` до ${request.maxPrice.toLocaleString('ru-RU')} ₽` : '';
  if (request.maxPrice && !request.dms?.prefer) parts.push(`до ${request.maxPrice.toLocaleString('ru-RU')} ₽`);
  if (request.dms?.prefer) parts.push(planName ? `лучше по ДМС «${planName}», можно платно${paidLimit}` : `лучше по ДМС, можно платно${paidLimit}`);
  else if (request.dms?.required) parts.push(planName ? `по ДМС «${planName}»` : 'по ДМС');
  else if (planName && request.dms?.planId && !request.dms?.prefer) parts.push(`программа «${planName}»`);
  if (request.wheelchair) parts.push('доступная среда');
  if (request.parking) parts.push('с парковкой');
  if (request.travel?.maxMinutes) {
    const mode = { driving: 'на машине', foot: 'пешком', bike: 'на велосипеде' }[request.travel.mode];
    parts.push(`не дольше ${request.travel.maxMinutes} мин ${mode}`);
  } else if (request.travel?.nearest) {
    parts.push('поближе');
  }
  if (request.originHint) parts.push(ORIGIN_HINTS[request.originHint]);
  if (request.city && request.city !== 'kazan') parts.push(LOCALITIES[request.city]?.name || request.city);
  for (const key of request.unsupported || []) parts.push(UNSUPPORTED_CONDITIONS[key]);
  for (const key of request.fallbacks || []) parts.push(CONSENTED_FALLBACKS[key]);
  return parts;
};
