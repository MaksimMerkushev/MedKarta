/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Условия записи из текста: день, потолок цены, город, ДМС, повторный приём
 * и явные «снятия» условий («в любое время», «цена не важна», «без ДМС»).
 *
 * Работает по исходному тексту, а возвращает ТОЛЬКО перечислимые значения и
 * числа — ни одного слова пользователя. Эти условия не уходят во внешнюю
 * модель вовсе: они нужны строгому подбору демо-записи (shared/demoSearch.js),
 * который исполняется на сервере. Модель о дне, цене и городе не знает и
 * поэтому не может их «ослабить».
 *
 * Каждая реплика даёт свой набор; набор диалога — слияние по порядку, где
 * поздняя реплика важнее: «ЛОР завтра» → «а лучше послезавтра» → послезавтра.
 * Значение null означает «условие снято».
 */

import { findTrigger, isNegatedBefore } from './normalize.js';

const WORD = '[\\p{L}\\p{N}]';

/* «Добрый вечер» — приветствие, а не «вечером». */
const prepare = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(?<!\p{L})добр\p{L}*\s+(?:вечер|утр|ден|дн|ноч)\p{L}*/gu, ' ');

/** Последнее НЕотрицаемое совпадение среди нескольких шаблонов. */
const lastAffirmed = (text, entries) => {
  let best = null;
  for (const { pattern, value } of entries) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (isNegatedBefore(text, match.index)) continue;
      if (!best || match.index > best.index) best = { index: match.index, value: typeof value === 'function' ? value(match) : value };
    }
  }
  return best ? best.value : undefined;
};

/* ----------------------------- День ------------------------------------ */

const WEEKDAY_FORMS = [
  ['понедельник', 1], ['вторник', 2], ['среду', 3], ['четверг', 4], ['пятницу', 5], ['субботу', 6], ['воскресенье', 7],
];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[яй]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

const DATE_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})сегодня(?!${WORD})`, 'u'), value: { kind: 'today' } },
  { pattern: new RegExp(`(?<!${WORD})(?:на\\s+)?(?:этой|текущей)\\s+неделе(?!${WORD})`, 'u'), value: { kind: 'this_week' } },
  { pattern: new RegExp(`(?<!${WORD})(?:на\\s+)?(?:следующей|будущей)\\s+неделе(?!${WORD})`, 'u'), value: { kind: 'next_week' } },
  { pattern: new RegExp(`(?<!${WORD})(?:завтра|завтрашн\\p{L}*)(?!${WORD})`, 'u'), value: { kind: 'tomorrow' } },
  { pattern: new RegExp(`(?<!${WORD})послезавтра(?!${WORD})`, 'u'), value: { kind: 'after_tomorrow' } },
  ...WEEKDAY_FORMS.map(([form, weekday]) => ({
    pattern: new RegExp(`(?<!${WORD})(?:в|во|на|к|ко)\\s+(?:(?:эт|ближайш|следующ)\\p{L}*\\s+)?${form}(?!${WORD})`, 'u'),
    value: { kind: 'weekday', weekday },
  })),
  {
    pattern: new RegExp(`(?<!${WORD})(?:в|на)\\s+(?:эти\\s+|ближайшие\\s+)?выходн\\p{L}*`, 'u'),
    value: { kind: 'weekend' },
  },
  {
    // «13 октября», «на 5 ноября»
    pattern: new RegExp(`(?<![\\p{L}\\p{N}.:])(\\d{1,2})\\s+(${MONTHS.join('|')})\\p{L}*`, 'u'),
    value: (match) => {
      const month = MONTHS.findIndex((stem) => new RegExp(`^${stem}`, 'u').test(match[2])) + 1;
      return { kind: 'date', month, dayOfMonth: Number(match[1]) };
    },
  },
  {
    // «13.10», «на 05.11» — без года
    pattern: /(?<![\p{L}\p{N}.:])(\d{1,2})\.(\d{1,2})(?![\d.:])/u,
    value: (match) => ({ kind: 'date', month: Number(match[2]), dayOfMonth: Number(match[1]) }),
  },
  {
    pattern: new RegExp(`(?<!${WORD})(?:в\\s+любой\\s+день|день\\s+(?:не\\s+важен|неважен|любой)|когда\\s+угодно|без\\s+разницы\\s+когда|в\\s+ближайш\\p{L}*\\s+(?:дни|время))(?!${WORD})`, 'u'),
    value: { kind: 'any' },
  },
];

const validDate = (value) =>
  value.kind !== 'date' || (value.month >= 1 && value.month <= 12 && value.dayOfMonth >= 1 && value.dayOfMonth <= 31);

/* ----------------------------- Цена ------------------------------------ */

const AMOUNT = '(\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+|\\d{1,6}(?:[.,]\\d{1,2})?)';
const THOUSANDS = '(?:тыс\\p{L}*\\.?|тр\\.?|т\\.\\s?р\\.?|к)(?!\\p{L})';
const RUBLES = '(?:₽|р\\.|руб\\p{L}*\\.?|р(?!\\p{L}))';
const PRICE_LIMIT = '(?:до|не\\s+дороже|дешевле|не\\s+более|не\\s+больше|максимум|макс\\.?|в\\s+пределах|бюджет\\p{L}*(?:\\s+до)?|за)';
const parseAmount = (raw, unit) => {
  const value = Number(String(raw).replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const thousands = unit && new RegExp(`^${THOUSANDS}`, 'u').test(unit);
  const rubles = thousands ? value * 1000 : value;
  return Number.isInteger(rubles) && rubles >= 100 && rubles <= 100000 ? rubles : null;
};

const PRICE_PATTERNS = [
  // «до 3000 ₽», «не дороже 2,5 тыс», «за 1500 рублей»
  {
    pattern: new RegExp(`(?<!${WORD})${PRICE_LIMIT}\\s+${AMOUNT}\\s*(${THOUSANDS}|${RUBLES})`, 'u'),
    value: (match) => parseAmount(match[1], match[2]),
  },
  // «не дороже 3000», «дешевле 2500» — слово само говорит о цене
  {
    pattern: new RegExp(`(?<!${WORD})(?:не\\s+дороже|дешевле|бюджет\\p{L}*(?:\\s+до)?)\\s+${AMOUNT}(?![\\d\\p{L}])`, 'u'),
    value: (match) => parseAmount(match[1], null),
  },
  // «до 3000», «до 2 500» без валюты: часов и минут таких не бывает
  {
    pattern: new RegExp(`(?<!${WORD})(?:до|не\\s+более|не\\s+больше|максимум)\\s+(\\d{3,6}|\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+)(?![\\d.,:])(?!\\s*(?:мин|час|км|м(?!\\p{L})|лет|год|шаг))`, 'u'),
    value: (match) => parseAmount(match[1], null),
  },
  // «до трёх тысяч», «до полутора тысяч» — словами
  {
    pattern: new RegExp(`(?<!${WORD})${PRICE_LIMIT}\\s+(одн\\p{L}*|полтор\\p{L}*|дв\\p{L}*|тр\\p{L}*|четыр\\p{L}*|пят\\p{L}*|шест\\p{L}*|сем\\p{L}*|восьм\\p{L}*|восем\\p{L}*|девят\\p{L}*|десят\\p{L}*)\\s+тысяч\\p{L}*`, 'u'),
    value: (match) => {
      const word = match[1];
      const stems = [
        ['полтор', 1.5], ['одн', 1], ['дв', 2], ['тр', 3], ['четыр', 4], ['пят', 5], ['шест', 6], ['сем', 7], ['восьм', 8], ['восем', 8], ['девят', 9], ['десят', 10],
      ];
      const found = stems.find(([stem]) => word.startsWith(stem));
      return found ? found[1] * 1000 : null;
    },
  },
];

const PRICE_ANY = new RegExp(
  `(?<!${WORD})(?:цена\\s+не\\s+важн\\p{L}*|(?:по\\s+)?любой\\s+цен\\p{L}*|можно\\s+(?:и\\s+)?дороже|без\\s+ограничени\\p{L}*\\s+по\\s+цене|стоимость\\s+не\\s+важн\\p{L}*|неважно\\s+сколько\\s+стоит)`,
  'u',
);

/* ----------------------------- Город ----------------------------------- */

/*
 * Только формы названия города: «Нижнекамская улица» и «Московский район»
 * Казани городом не считаются.
 */
const CITY_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})казан(?:ь|и|ью)(?!${WORD})`, 'u'), value: 'kazan' },
  { pattern: new RegExp(`(?<!${WORD})иннополис(?:е|а|у|ом)?(?!${WORD})`, 'u'), value: 'innopolis' },
  { pattern: new RegExp(`(?<!${WORD})зеленодольск(?:е|а|у|ом)?(?!${WORD})`, 'u'), value: 'zelenodolsk' },
  { pattern: new RegExp(`(?<!${WORD})высок(?:ая|ой|ую)\\s+гор(?:а|е|у|ой|ы)(?!${WORD})`, 'u'), value: 'vysokaya_gora' },
  { pattern: new RegExp(`(?<!${WORD})(?:набережн\\p{L}*\\s+)?челн(?:ы|ах|ам|ов)(?!${WORD})`, 'u'), value: 'naberezhnye_chelny' },
  { pattern: new RegExp(`(?<!${WORD})альметьевск(?:е|а|у|ом)?(?!${WORD})`, 'u'), value: 'almetyevsk' },
  { pattern: new RegExp(`(?<!${WORD})нижнекамск(?:е|а|у|ом)?(?!${WORD})`, 'u'), value: 'nizhnekamsk' },
  { pattern: new RegExp(`(?<!${WORD})москв(?:а|е|у|ы|ой)(?!${WORD})`, 'u'), value: 'moscow' },
  { pattern: new RegExp(`(?<!${WORD})(?:санкт-петербург\\p{L}*|петербург\\p{L}*|питер(?:е|а|у)?|спб)(?!${WORD})`, 'u'), value: 'saint_petersburg' },
];

/* ----------------------------- ДМС ------------------------------------- */

const DMS_OFF = new RegExp(
  `(?<!${WORD})(?:без\\s+(?:дмс|страховк\\p{L}*|полиса)|не\\s+по\\s+(?:дмс|страховк\\p{L}*)|дмс\\s+(?:не\\s+нуж\\p{L}*|не\\s+надо|нет|не\\s+важ\\p{L}*)|платн\\p{L}*|за\\s+(?:свой\\s+сч[её]т|деньги|наличные))(?!${WORD})`,
  'u',
);
const DMS_ON = new RegExp(`(?<!${WORD})(?:дмс|по\\s+(?:моей\\s+)?страховк\\p{L}*|по\\s+(?:моему\\s+)?полису(?!\\s+омс))(?!${WORD})`, 'u');

/* ------------------------- Время суток ---------------------------------- */

/*
 * «Утром», «после обеда», «днём» — условие на время приёма, как «после
 * 18:00». Раньше они молча терялись, и подбор показывал весь день.
 */
const TIME_OF_DAY_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})(?:утром|с\\s+утра|до\\s+обеда|в\\s+первой\\s+половине\\s+дня)(?!${WORD})`, 'u'), value: 'morning' },
  { pattern: new RegExp(`(?<!${WORD})(?:после\\s+обеда|во\\s+второй\\s+половине\\s+дня)(?!${WORD})`, 'u'), value: 'afternoon' },
  { pattern: new RegExp(`(?<!${WORD})дн[её]м(?!${WORD})`, 'u'), value: 'daytime' },
];

export const TIME_OF_DAY = Object.freeze({
  morning: { from: null, to: '12:00' },
  afternoon: { from: '13:00', to: null },
  daytime: { from: '12:00', to: '17:00' },
});

/* --------------------- Процедуры и обследования ------------------------- */

/*
 * Запись на процедуру — это не «первичный приём»: другая услуга, другая
 * длительность и цена. Профиль врача ставится, только если процедура
 * однозначно его называет; «УЗИ» без уточнения — нет.
 */
const PROCEDURE_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})(?:подбор\\p{L}*\\s+очк\\p{L}*|подобрать\\s+очки|очки\\s+подобрать)`, 'u'), value: { serviceId: 'proc.ophthalmologist.glasses', specialty: 'ophthalmologist' } },
  { pattern: new RegExp(`(?<!${WORD})(?:экг|электрокардиограм\\p{L}*|кардиограмм\\p{L}*)(?!${WORD})`, 'u'), value: { serviceId: 'diag.ecg', specialty: 'cardiologist' } },
  { pattern: new RegExp(`(?<!${WORD})(?:чистк\\p{L}*\\s+зуб\\p{L}*|(?:проф\\p{L}*\\s+)?гигиен\\p{L}*\\s+(?:полости\\s+рта|зуб\\p{L}*)|профгигиен\\p{L}*)`, 'u'), value: { serviceId: 'proc.dentist.hygiene', specialty: 'dentist' } },
  { pattern: new RegExp(`(?<!${WORD})(?:дерматоскоп\\p{L}*|(?:проверить|посмотреть|осмотр\\p{L}*)\\s+родинк\\p{L}*)`, 'u'), value: { serviceId: 'proc.dermatologist.dermatoscopy', specialty: 'dermatologist' } },
  { pattern: new RegExp(`(?<!${WORD})промыв\\p{L}*\\s+миндалин`, 'u'), value: { serviceId: 'proc.lor.tonsils', specialty: 'lor' } },
  { pattern: new RegExp(`(?<!${WORD})узи(?!${WORD})(?=.*(?:малого\\s+таза|гинеколог|матк|яичник))|(?:гинеколог\\p{L}*.*(?<!${WORD})узи(?!${WORD}))`, 'u'), value: { serviceId: 'proc.gynecologist.ultrasound', specialty: 'gynecologist' } },
];

/* ----------------------------- Главное --------------------------------- */

/**
 * @param {string} text реплика пользователя
 * @returns {{date?: object|null, maxPrice?: number|null, city?: string, dms?: boolean,
 *   visit?: string, timeAny?: true, travelAny?: true}}
 */
export const extractBookingConstraints = (text) => {
  const lower = prepare(text);
  const result = {};

  const date = lastAffirmed(lower, DATE_PATTERNS);
  if (date && validDate(date)) result.date = date.kind === 'any' ? null : date;

  if (PRICE_ANY.test(lower)) {
    result.maxPrice = null;
  } else {
    const price = lastAffirmed(lower, PRICE_PATTERNS);
    if (Number.isInteger(price)) result.maxPrice = price;
  }

  const city = lastAffirmed(lower, CITY_PATTERNS);
  if (city) result.city = city;

  const dmsOff = DMS_OFF.test(lower);
  const dmsOn = !dmsOff && DMS_ON.test(lower) && findTrigger(lower, 'дмс', 'страховк', 'полис') !== 'negated';
  if (dmsOff) result.dms = false;
  else if (dmsOn) result.dms = true;

  const timeOfDay = lastAffirmed(lower, TIME_OF_DAY_PATTERNS);
  if (timeOfDay) result.timeOfDay = timeOfDay;

  const procedure = lastAffirmed(lower, PROCEDURE_PATTERNS);
  if (procedure) {
    result.serviceId = procedure.serviceId;
    result.procedureSpecialty = procedure.specialty;
  }

  if (findTrigger(lower, 'повторн') === 'affirmed') result.visit = 'repeat';
  else if (findTrigger(lower, 'первичн', 'перв\\p{L}*\\s+при[её]м') === 'affirmed') result.visit = 'first';

  if (/(?<![\p{L}])(?:в\s+любое\s+время|время\s+(?:не\s+важно|неважно|любое)|неважно\s+во\s+сколько|в\s+любое\s+время\s+дня)/u.test(lower)) {
    result.timeAny = true;
  }
  if (/(?<![\p{L}])(?:неважно|не\s+важно|без\s+разницы)\s+(?:сколько\s+ехать|как\s+далеко|далеко)|можно\s+(?:и\s+)?подальше|расстояние\s+не\s+важно/u.test(lower)) {
    result.travelAny = true;
  }

  return result;
};

/**
 * Слияние условий по репликам с учётом ограничений, которые уже извлекает
 * gateway (время, вечер, выходные, ДМС, время в пути). Поздняя реплика
 * важнее; «снятие» условия обнуляет его и из ранних реплик.
 *
 * @param {Array<{booking: object, constraints: object}>} turns по порядку
 */
export const mergeBookingTurns = (turns) => {
  const merged = {
    date: null,
    maxPrice: null,
    city: null,
    dms: false,
    visit: null,
    serviceId: null,
    procedureSpecialty: null,
    timeFrom: null,
    timeTo: null,
    evening: false,
    weekend: false,
    maxTravelMinutes: null,
    travelMode: null,
    nearest: false,
  };

  for (const { booking = {}, constraints = {} } of turns) {
    if ('date' in booking) {
      merged.date = booking.date;
      // Новый день отменяет «в выходные» из прошлой реплики, кроме самих выходных.
      if (booking.date && booking.date.kind !== 'weekend' && !(booking.date.kind === 'weekday' && booking.date.weekday >= 6)) merged.weekend = false;
    }
    if ('maxPrice' in booking) merged.maxPrice = booking.maxPrice;
    if ('city' in booking) merged.city = booking.city;
    if ('visit' in booking) merged.visit = booking.visit;
    if (booking.serviceId) {
      merged.serviceId = booking.serviceId;
      merged.procedureSpecialty = booking.procedureSpecialty;
    }

    if (booking.timeAny) {
      merged.timeFrom = null;
      merged.timeTo = null;
      merged.evening = false;
    }
    if (booking.timeOfDay) {
      // «Утром» после «вечером» — смена условия, а не их сумма.
      merged.timeFrom = TIME_OF_DAY[booking.timeOfDay].from;
      merged.timeTo = TIME_OF_DAY[booking.timeOfDay].to;
      merged.evening = false;
    }
    if (constraints.availableAfter) {
      merged.timeFrom = constraints.availableAfter;
      if (!constraints.availableBefore && merged.timeTo && merged.timeTo <= constraints.availableAfter) merged.timeTo = null;
    }
    if (constraints.availableBefore) {
      merged.timeTo = constraints.availableBefore;
      if (!constraints.availableAfter && merged.timeFrom && merged.timeFrom >= constraints.availableBefore) merged.timeFrom = null;
    }
    if (constraints.evening) {
      merged.evening = true;
      if (!booking.timeOfDay && merged.timeTo && merged.timeTo <= '17:00') merged.timeTo = null;
    }
    if (constraints.weekend) merged.weekend = true;

    if (booking.dms === false) merged.dms = false;
    else if (booking.dms === true || constraints.dmsOnly) merged.dms = true;

    if (booking.travelAny) {
      merged.maxTravelMinutes = null;
      merged.nearest = false;
    }
    if (Number.isInteger(constraints.maxTravelMinutes)) merged.maxTravelMinutes = constraints.maxTravelMinutes;
    if (constraints.travelMode) merged.travelMode = constraints.travelMode;
    if (constraints.selection === 'nearest') merged.nearest = true;
  }

  return merged;
};
