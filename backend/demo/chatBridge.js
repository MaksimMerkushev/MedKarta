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

import { describeRequest, describeTimeWindow, LOCALITIES, normalizeSearchRequest, UNSUPPORTED_CONDITIONS } from '../../shared/demoSearch.js';
import { SPECIALTY_CANON } from '../../shared/specialties.js';
import { addDays, moscowDay, moscowParts } from './time.js';

const BOOKING_ACTIONS = new Set(['FIND_DOCTOR', 'GET_AVAILABLE_SLOTS']);
// «ЛОР в клинике Ясень»: модель может ответить поиском клиники, а запись — к врачу в ней.
const CLINIC_ACTIONS = new Set(['FIND_CLINIC']);

export { bookingModeFromEnv } from './flags.js';

/** «15 октября» без года → ближайшая такая дата не раньше сегодняшней; «17-го» без месяца — ближайшее 17-е. */
const resolveCalendarDate = ({ month, dayOfMonth }, today) => {
  const [year, currentMonth] = today.split('-').map(Number);
  if (month === null || month === undefined) {
    if (dayOfMonth > 31) return null;
    for (let step = 0; step < 3; step += 1) {
      const candidateMonth = ((currentMonth - 1 + step) % 12) + 1;
      const candidateYear = year + Math.floor((currentMonth - 1 + step) / 12);
      const day = resolveCalendarDate({ month: candidateMonth, dayOfMonth }, `${candidateYear}-${String(candidateMonth).padStart(2, '0')}-01`);
      if (day && day >= today) return day;
    }
    return null;
  }
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
    || booking.workdays || booking.minExperience || booking.doctorGender || booking.preferGender || booking.doctorIds?.length || booking.unsupported?.length
    || booking.excludeDoctorIds?.length || booking.excludeBranchIds?.length || booking.excludeWeekdays?.length || booking.districts?.length
    || booking.excludeDistricts?.length || booking.planId || booking.withinHours || booking.wheelchair || booking.parking || booking.preferDms || booking.preferTime
    || booking.afterHours || booking.preferExperience || booking.fallbacks?.length || booking.bookingIntent);

const resolveDate = (date, today) => {
  // Своё окно у дня в перечислении («в четверг после 15:30») переносится как есть.
  if ((date.from || date.to) && date.kind !== 'range') {
    const { from, to, ...rest } = date;
    return { ...resolveDate(rest, today), from: from || null, to: to || null };
  }
  if (date.kind === 'date') {
    const day = resolveCalendarDate(date, today);
    const expect = date.expectWeekday ? { expectWeekday: date.expectWeekday } : {};
    // Несуществующая дата («31 ноября») — вопрос, а не соседний день.
    return day ? { kind: 'date', day, ...expect } : { kind: 'invalid', month: date.month, dayOfMonth: date.dayOfMonth };
  }
  if (date.kind === 'in_days') return { kind: 'date', day: addDays(today, date.days) };
  if (date.kind === 'any_of') return { kind: 'any_of', options: date.options.map((option) => resolveDate(option, today)) };
  if (date.kind === 'next_days') return { kind: 'range', from: today, to: addDays(today, date.days - 1) };
  if (date.kind === 'range') {
    // Границы диапазона: «до 20 октября» — по 19-е, «после 15-го» — с 16-го.
    const bound = (ref) => {
      if (!ref) return { day: null };
      const day = resolveCalendarDate(ref, today);
      return day ? { day: addDays(day, ref.shift || 0) } : { invalid: ref };
    };
    const from = bound(date.from);
    const to = bound(date.to);
    const invalid = from.invalid || to.invalid;
    if (invalid) return { kind: 'invalid', month: invalid.month, dayOfMonth: invalid.dayOfMonth };
    // «До 20 октября» — с сегодняшнего; конец раньше начала («с 17 по 15») — поменять местами нельзя, значит вопрос.
    return { kind: 'range', from: from.day && from.day > today ? from.day : date.from ? from.day : today, to: to.day };
  }
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
  /*
   * Модель переспросила, но запрос уже ясен: есть условие записи, названный
   * врач или профиль, названный словами («невролог» → «а в любой клинике?»).
   * Профиль, выведенный только из жалобы, — повод для её вопроса, а не для записи.
   */
  const clarifying = action === 'CLARIFY'
    && (hasBookingCue(booking) || (booking.explicitSpecialty && booking.specialties.length === 1));
  // «Подбор очков», «ЭКГ»: модель видит в этом услугу, а запись — на процедуру к врачу.
  const procedure = action === 'SEARCH_SERVICE' && Boolean(booking.serviceId);
  /*
   * «Невролог в Разумеде» → «а в любой клинике?»: модель отвечает поиском
   * клиник, а разговор — о записи к одному врачу. Один профиль в запросе —
   * это запись к нему в любой из клиник.
   */
  const atClinic = CLINIC_ACTIONS.has(action) && booking.specialties.length === 1;
  /*
   * «ЛОР не дальше 15 минут от дома»: дом здесь — точка отправления, а не
   * следующая остановка маршрута «ЛОР → дом», как может решить планировщик.
   */
  const singleDoctorRoute = action === 'BUILD_ROUTE' && booking.specialties.length === 1
    && (execution.stops || []).filter((stop) => stop.kind === 'doctor').length <= 1;
  const fromPlace = singleDoctorRoute && Boolean(booking.originHint);
  // «Кардиолог в Ситидок или Разумед»: выбор клиники, а не маршрут через обе.
  const clinicChoice = singleDoctorRoute && booking.clinicChoice;
  // «Невролог или терапевт»: планировщик мог построить маршрут через обоих — это выбор одного.
  const specialtyChoiceRoute = action === 'BUILD_ROUTE' && booking.specialtyChoice && booking.specialties.length > 1 && booking.specialties.length <= 3;
  /*
   * «Лор, но не в Айболите и не в Мать и дитя», «терапевт, только не к
   * Морозову»: планировщик видит названия и строит маршрут через них, а
   * это исключения из одной записи.
   */
  const exclusionRoute = action === 'BUILD_ROUTE' && booking.specialties.length === 1
    && (booking.excludeBranchIds.length > 0 || booking.excludeDoctorIds.length > 0);
  /*
   * «Записаться в Кузляр к окулисту …»: человек просит запись к одному
   * врачу, а планировщик увидел клинику и врача и построил маршрут.
   */
  const intentRoute = singleDoctorRoute && Boolean(booking.bookingIntent);
  const routeAsBooking = fromPlace || clinicChoice || specialtyChoiceRoute || exclusionRoute || intentRoute;
  if (!BOOKING_ACTIONS.has(action) && !clarifying && !procedure && !atClinic && !routeAsBooking) return null;

  // Несколько профилей через «и» — маршрут по нескольким врачам; через «или» — выбор для одной записи.
  const choice = booking.specialtyChoice && booking.specialties.length > 1 && booking.specialties.length <= 3;
  if (booking.specialties.length > 1 && !choice) return null;
  // Названный врач не из демо-набора: записи к нему нет, подменять его другим нельзя.
  if (booking.foreignDoctor) return null;
  // Последним назван профиль, которого нет («нет, лучше косметолог»): записи нет — ответит pipeline.
  if (booking.unknownSpecialty && booking.specialties.length === 0 && booking.doctorIds.length === 0) return null;
  /*
   * «Болит голова и живот» — два профиля поровну: не выбираем, а спрашиваем
   * (запрос без профиля → «к кому записаться?», остальные условия сохраняются).
   */
  const askSpecialty = Array.isArray(booking.specialtyQuestion) && booking.specialtyQuestion.length === 2;
  if (askSpecialty) booking = { ...booking, specialties: [] };

  /*
   * Врачи — только из разбора текста (все однофамильцы подходящей формы,
   * «но не Ефимов» — исключение), а не из выбора модели: модель могла
   * поставить в план и врача, которого пользователь исключил.
   */
  const doctorIds = booking.doctorIds;

  const specialty = choice ? null : booking.specialties[0] || null;
  const today = moscowDay(now);
  /* «В ближайший час / 2 часа»: сегодня, от текущего времени (по Москве). */
  let windowFrom = booking.timeFrom;
  let windowTo = booking.timeTo;
  let date = booking.date || { kind: 'any' };
  const { time } = moscowParts(now);
  const nowMinutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const clock = (value) => `${String(Math.floor(Math.min(value, 1439) / 60)).padStart(2, '0')}:${String(Math.min(value, 1439) % 60).padStart(2, '0')}`;
  if (booking.withinHours) {
    date = { kind: 'today' };
    windowFrom = clock(nowMinutes);
    windowTo = clock(nowMinutes + booking.withinHours * 60);
  }
  /*
   * «Не раньше чем через час», «через пару часов» — сегодня, начиная с
   * текущего времени плюс столько часов. С другим днём («завтра») это
   * время не сравнить — тогда оно не применяется.
   */
  if (booking.afterHours && !booking.withinHours && (date.kind === 'any' || date.kind === 'today')) {
    date = { kind: 'today' };
    const from = clock(Math.ceil((nowMinutes + booking.afterHours * 60) / 5) * 5);
    if (!windowFrom || windowFrom < from) windowFrom = from;
  }

  /* «Только не завтра», «кроме 15 октября» — конкретные даты. */
  const excludeDates = (booking.excludeDays || [])
    .map((value) => resolveDate(value, today))
    .flatMap((value) => (value.kind === 'date' ? [value.day]
      : value.kind === 'today' ? [today] : value.kind === 'tomorrow' ? [addDays(today, 1)] : value.kind === 'after_tomorrow' ? [addDays(today, 2)] : []));

  /*
   * «В следующую пятницу»: вопрос нужен, только если ближайшая пятница ещё
   * впереди на этой неделе. Сказанное в пятницу или в субботу — это точно
   * следующая неделя, спрашивать нечего.
   */
  if (date.kind === 'weekday' && date.askWeek) {
    const todayWeekday = weekdayOfDay(today);
    if (!(date.weekday > todayWeekday)) date = { kind: 'weekday', weekday: date.weekday, week: 'next' };
  }

  const { request: normalized } = normalizeSearchRequest({
    specialty,
    specialtyAny: choice ? booking.specialties : [],
    doctorIds,
    excludeDoctorIds: booking.excludeDoctorIds,
    branchIds: booking.branchIds,
    excludeBranchIds: booking.excludeBranchIds,
    excludeWeekdays: booking.excludeWeekdays,
    preferGender: booking.preferGender,
    districts: booking.districts,
    preferDistricts: booking.preferDistricts,
    excludeDistricts: booking.excludeDistricts,
    doctorGender: booking.doctorGender,
    minExperience: booking.minExperience,
    preferMinExperience: booking.preferMinExperience,
    preferExperience: booking.preferExperience,
    excludeDates,
    timeWindows: booking.timeWindows,
    timeChoice: booking.pendingTime || [],
    unsupported: booking.unsupported,
    fallbacks: booking.fallbacks,
    serviceId: booking.serviceId || null,
    visit: booking.visit || 'first',
    // Педиатр — всегда детский приём, даже если ребёнок не упомянут.
    patient: booking.child || specialty === 'pediatrician' || (choice && booking.specialties.every((key) => key === 'pediatrician')) ? 'child' : 'adult',
    date: resolveDate(date, today),
    timeFrom: windowFrom,
    timeTo: windowTo,
    preferTime: booking.preferTime,
    wheelchair: booking.wheelchair,
    parking: booking.parking,
    evening: booking.evening,
    weekend: booking.weekend,
    workdays: booking.workdays,
    maxPrice: booking.maxPrice,
    dms: { required: booking.dms === true && !booking.preferDms, planId: booking.planId || null, prefer: Boolean(booking.preferDms) },
    travel: {
      maxMinutes: booking.maxTravelMinutes,
      mode: booking.travelMode || execution.travelMode || 'driving',
      nearest: booking.nearest,
    },
    originHint: booking.originHint,
    originConfirmed: Boolean(booking.originConfirmed),
    preferCheap: Boolean(booking.preferCheap),
    city: booking.city,
  });
  return {
    request: normalized,
    ...refLabels(index, normalized),
    planName: index?.plans.get(normalized.dms.planId)?.name || null,
    // Маршрут «ЛОР → дом» или «Ситидок → Разумед», который составил планировщик, — не то, о чём просили.
    dropRoute: routeAsBooking,
    // Исключённую клинику или врача фильтр карты выразить не может — фильтр по ним снимается.
    dropPlaceFilter: normalized.excludeBranchIds.length > 0 || normalized.excludeDoctorIds.length > 0,
  };
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
    parts.push(`Понял запрос: ${summary.join(', ').replace(/\.$/u, '')}.`);
    parts.push(`${locality.name} — вне покрытия: демо-клиники и карта дорог МедКарты есть только по Казани. Искать в Казани вместо этого — только если скажете.`);
  } else if (!request.specialty && request.specialtyAny.length === 0 && request.doctorIds.length === 0 && booking?.specialtyQuestion?.length === 2) {
    const [first, second] = booking.specialtyQuestion.map((key) => SPECIALTY_CANON[key]);
    parts.push(`По описанию подходят разные врачи — ${first.toLowerCase()} или ${second.toLowerCase()}. К кому записаться? Если не уверены, можно начать с терапевта: он посмотрит всё вместе. Гадать за вас не буду.`);
    if (summary.length > 0) parts.push(`Условия, которые я учту: ${summary.join(', ')}.`);
  } else if (!request.specialty && request.specialtyAny.length === 0 && request.doctorIds.length === 0) {
    parts.push('Подберу врача и свободное время. Подскажите, какой специалист нужен?');
    if (summary.length > 0) parts.push(`Условия, которые я учту: ${summary.join(', ')}.`);
  } else if (blockingNote(request)) {
    // Условие, которое не проверить, или противоречие: не обещаем «подбор ниже» — говорим, что мешает.
    parts.push(`Понял запрос: ${summary.join(', ').replace(/\.$/u, '')}.`);
    parts.push(blockingNote(request));
  } else {
    parts.push(`Ищу свободное время: ${summary.join(', ').replace(/\.$/u, '')}.`);
    parts.push('Показываю только варианты, которые подходят под все условия, — подбор ниже. Условия без вашего согласия не ослабляю.');
  }
  // Однофамильцы («к Ефимову(ой)»): показываем всех и спрашиваем, к кому именно.
  if (booking?.pickOption) {
    parts.push('Записать вас сам по тексту не могу: выберите время в карточке нужного врача и нажмите «Записаться» — запись подтверждаете вы.');
  }
  const bySurname = new Map();
  for (const label of labels.doctorLabels || []) {
    const stem = label.split(' ')[0].toLowerCase().replace(/(?:а|ой)$/u, '');
    bySurname.set(stem, [...(bySurname.get(stem) || []), label]);
  }
  const namesakes = [...bySurname.values()].find((group) => group.length > 1);
  if (namesakes) {
    parts.push(`Нашёл нескольких врачей с такой фамилией: ${namesakes.join('; ')}. Показываю всех — если нужен один, уточните имя или профиль.`);
  }
  if (booking?.medicalText && request.specialty) {
    parts.push('Профиль врача подобран по описанию — это не диагноз.');
  }
  parts.push(request.branchIds.some((id) => id.startsWith('demo-real-'))
    ? 'Запись демонстрационная: клиника реальная, но врачи и расписание вымышлены — в клинику ничего не уходит.'
    : 'Запись демонстрационная: врачи и расписание вымышлены.');
  return parts.join(' ');
};

const weekdayOfDay = (day) => {
  const value = new Date(`${day}T12:00:00Z`).getUTCDay();
  return value === 0 ? 7 : value;
};

/** Что мешает подбору ещё до поиска: условие, которого в демо нет, или противоречие. */
const blockingNote = (request) => {
  if (request.unsupported.length > 0) {
    const names = request.unsupported.map((key) => UNSUPPORTED_CONDITIONS[key]).join(', ');
    return `${names[0].toUpperCase()}${names.slice(1)} — этого в демо нет, проверить не могу. Ниже — что могу предложить вместо, и только с вашего согласия.`;
  }
  if (request.date.kind === 'invalid') return 'Такой даты в календаре нет — уточните день, соседний подставлять не буду.';
  if (request.timeChoice?.length === 2) {
    const [morning, evening] = request.timeChoice.map(describeTimeWindow);
    return `Уточните, пожалуйста: ${morning} (утра) или ${evening} (вечера)? Ответьте «утра» или «вечера» — или нажмите кнопку ниже. Выбирать за вас не буду.`;
  }
  if (request.date.kind === 'weekday' && request.date.askWeek) {
    return 'Уточните, пожалуйста: ближайший такой день (на этой неделе) или через неделю? Ответьте «ближайшую» или «через неделю» — или нажмите кнопку ниже.';
  }
  if (request.date.kind === 'date' && request.date.expectWeekday && weekdayOfDay(request.date.day) !== request.date.expectWeekday) {
    return 'Дата и день недели не совпадают — уточните, какой день имели в виду; выбирать за вас не буду.';
  }
  if (request.timeFrom && request.timeTo && request.timeFrom >= request.timeTo) return 'Условия по часам не оставляют ни минуты — уточните время, выбирать за вас не буду.';
  if (request.originHint && !request.originConfirmed) return 'Точку отправления вы назвали словами — по названию я её не определяю: поставьте её на карте или подтвердите, что вы сейчас там.';
  return null;
};

