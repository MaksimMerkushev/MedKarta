/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Запрос подбора лаборатории — общий для сервера, интерфейса и ответа ассистента.
 * Корзина — коды исследований из каталога; дата, время, точка отправления и
 * время в пути нормализуются тем же модулем, что и у подбора врача
 * (shared/demoSearch.js): одни и те же «завтра утром» и «не дальше 20 минут».
 */

import { describeTimeWindow, normalizeSearchRequest } from './demoSearch.js';

export const LAB_SORTS = Object.freeze(['total', 'distance', 'turnaround', 'soonest']);
export const LAB_SORT_LABELS = Object.freeze({ total: 'дешевле всего', distance: 'ближе всего', turnaround: 'быстрее результат', soonest: 'ближайшее время' });
export const LAB_TIMES_OF_DAY = Object.freeze({ morning: ['06:00', '12:00'], afternoon: ['12:00', '17:00'], evening: ['17:00', '23:59'] });
export const LAB_INTENTS = Object.freeze([
  'laboratory_search', 'laboratory_test_search', 'laboratory_cart', 'laboratory_booking', 'laboratory_preparation_info',
  'doctor_search', 'clarification', 'emergency', 'unsupported_request',
]);
const CODE = /^[A-Z0-9_]{2,40}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
export const MAX_LAB_TESTS = 25;

/*
 * Готовность для человека: «в день сдачи», «через 1 день», «через 5 дней». Общая
 * для подбора, карточки и диалога записи — чтобы они не расходились.
 * Срок — в календарных днях от дня сдачи. Считаем, что сдали около 9:00, а
 * результаты выдают до 20:00: 30 часов — это завтра днём («через 1 день»), а не
 * «через 2 дня», как дало бы деление с округлением вверх.
 */
export const describeTurnaround = (hours) => {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const ready = 9 + hours;
  const days = Math.floor(ready / 24) + (ready % 24 > 20 ? 1 : 0);
  if (days === 0) return 'в день сдачи';
  const tail = days % 100;
  const word = tail >= 11 && tail <= 14 ? 'дней' : days % 10 === 1 ? 'день' : days % 10 >= 2 && days % 10 <= 4 ? 'дня' : 'дней';
  return `через ${days} ${word}`;
};

const uniqueList = (list, valid, max) => (Array.isArray(list) ? [...new Set(list.filter((item) => typeof item === 'string' && valid(item)))].slice(0, max) : []);

/** Запрос подбора лаборатории; ошибки — список кодов, неизвестное отбрасывается. */
export const normalizeLabRequest = (raw = {}) => {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const tests = uniqueList(input.tests, (code) => CODE.test(code), MAX_LAB_TESTS);
  if (Array.isArray(input.tests) && input.tests.length > MAX_LAB_TESTS) errors.push('too_many_tests');
  const timeOfDay = Object.hasOwn(LAB_TIMES_OF_DAY, input.timeOfDay) ? input.timeOfDay : null;
  const base = normalizeSearchRequest({
    date: input.date,
    timeFrom: input.timeFrom ?? (timeOfDay ? LAB_TIMES_OF_DAY[timeOfDay][0] : null),
    timeTo: input.timeTo ?? (timeOfDay && timeOfDay !== 'evening' ? LAB_TIMES_OF_DAY[timeOfDay][1] : null),
    evening: input.evening === true || timeOfDay === 'evening',
    weekend: input.weekend === true,
    workdays: input.workdays === true,
    excludeWeekdays: input.excludeWeekdays,
    excludeDates: input.excludeDates,
    origin: input.origin,
    originPlace: input.originPlace,
    travel: input.travel,
  });
  errors.push(...base.errors.filter((code) => code !== 'specialty'));
  const maxTotalPrice = Number.isInteger(input.maxTotalPrice) && input.maxTotalPrice > 0 && input.maxTotalPrice <= 500_000 ? input.maxTotalPrice : null;
  const maxTurnaroundHours = Number.isInteger(input.maxTurnaroundHours) && input.maxTurnaroundHours > 0 && input.maxTurnaroundHours <= 720 ? input.maxTurnaroundHours : null;
  return {
    request: {
      tests,
      date: base.request.date,
      timeFrom: base.request.timeFrom,
      timeTo: base.request.timeTo,
      evening: base.request.evening,
      timeOfDay,
      weekend: base.request.weekend,
      workdays: base.request.workdays,
      excludeWeekdays: base.request.excludeWeekdays,
      excludeDates: base.request.excludeDates,
      origin: base.request.origin,
      originPlace: base.request.originPlace,
      travel: base.request.travel,
      maxTotalPrice,
      maxTurnaroundHours,
      sort: LAB_SORTS.includes(input.sort) ? input.sort : null,
      labIds: uniqueList(input.labIds, (id) => ID.test(id), 6),
      branchIds: uniqueList(input.branchIds, (id) => ID.test(id), 24),
    },
    errors,
  };
};

const formatRub = (value) => `${String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')} ₽`;
const DATE_WORDS = Object.freeze({ today: 'сегодня', tomorrow: 'завтра', after_tomorrow: 'послезавтра', this_week: 'на этой неделе', next_week: 'на следующей неделе', weekend: 'в выходные' });
const WEEKDAY_IN = Object.freeze(['', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье']);

/** Условия подбора словами — для подписи под ответом ассистента и в интерфейсе. */
export const describeLabRequest = (request, { testNames = [], placeLabel = null } = {}) => {
  const parts = [];
  if (testNames.length) parts.push(testNames.join(' + '));
  const date = request?.date;
  if (date?.kind && DATE_WORDS[date.kind]) parts.push(DATE_WORDS[date.kind]);
  else if (date?.kind === 'weekday' && WEEKDAY_IN[date.weekday]) parts.push(WEEKDAY_IN[date.weekday]);
  else if (date?.kind === 'date' && date.day) parts.push(date.day.split('-').reverse().slice(0, 2).join('.'));
  if (request?.timeOfDay === 'morning') parts.push('утром');
  else if (request?.timeOfDay === 'afternoon') parts.push('днём');
  else if (request?.timeOfDay === 'evening' || (request?.evening && !request.timeFrom)) parts.push('вечером');
  else if (request?.timeFrom || request?.timeTo) parts.push(describeTimeWindow({ from: request.timeFrom || null, to: request.timeTo || null }));
  if (request?.maxTotalPrice) parts.push(`до ${formatRub(request.maxTotalPrice)} за всё`);
  if (request?.travel?.maxMinutes) parts.push(`не дольше ${request.travel.maxMinutes} мин в пути`);
  if (placeLabel) parts.push(placeLabel);
  if (request?.maxTurnaroundHours) parts.push(request.maxTurnaroundHours <= 10 ? 'результат в день сдачи' : `результат не позже чем через ${Math.ceil(request.maxTurnaroundHours / 24)} дн.`);
  if (request?.sort && LAB_SORT_LABELS[request.sort]) parts.push(LAB_SORT_LABELS[request.sort]);
  return parts;
};

/* Поиск исследования в каталоге */

const searchText = (value) => String(value || '').toLowerCase().replace(/ё/gu, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Отличаются не больше чем одной правкой: замена, вставка, удаление или две соседние буквы местами. */
const withinOneEdit = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
};

// Опечатку прощаем в словах от 5 букв: в «ОАК» или «ТТГ» одна буква — уже другое исследование.
const FUZZY_FROM = 5;
// Падеж: «моча» находит «анализ мочи», «кровь» — «кровь из вены» и «крови».
const stemOf = (word) => (word.length >= 4 && /[аеиоуыэюяьй]$/u.test(word) ? word.slice(0, -1) : word);
// Уровни: 0 — слово начинается с запроса, 1 — ещё и без падежного окончания, 2 — ещё и с опечаткой.
const wordMatches = (query, word, level) => word.startsWith(query)
  || (level >= 1 && word.startsWith(stemOf(query)))
  || (level >= 2 && query.length >= FUZZY_FROM && [query.length - 1, query.length, query.length + 1].some((size) => withinOneEdit(query, word.slice(0, size))));

/** Насколько фраза каталога (название, код или синоним) подходит под запрос: меньше — лучше. */
const phraseScore = (phrase, query, words) => {
  if (phrase === query) return 0;
  if (phrase.startsWith(query)) return 1;
  const phraseWords = phrase.split(' ');
  const all = (level) => words.every((word) => phraseWords.some((item) => wordMatches(word, item, level)));
  if (all(0)) return 2;
  if (all(1)) return 3;
  if (phrase.includes(query)) return 4;
  if (all(2)) return 5;
  return Infinity;
};

/*
 * Исследования по запросу: по названию, коду и синонимам («ОАК», «сахар в крови»,
 * «витамин Д»). Регистр, «ё» и знаки не важны; каждое слово запроса — начало
 * слова в названии или синониме; в словах от 5 букв прощается одна опечатка
 * («ферритинн»). Сначала точные совпадения, затем по началу, затем с опечаткой;
 * при равенстве — порядок каталога. Пустой запрос — весь список.
 */
export const searchLabTests = (tests, rawQuery) => {
  const list = Array.isArray(tests) ? tests : [];
  const query = searchText(rawQuery);
  if (!query) return list;
  const words = query.split(' ');
  return list
    .map((test, index) => {
      const phrases = [test.name, test.code, ...(Array.isArray(test.synonyms) ? test.synonyms : [])].map(searchText).filter(Boolean);
      return { test, index, score: Math.min(...phrases.map((phrase) => phraseScore(phrase, query, words))) };
    })
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((item) => item.test);
};
