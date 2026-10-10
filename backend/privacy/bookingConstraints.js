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

/** Последнее НЕотрицаемое совпадение среди нескольких шаблонов: {index, value}. */
const lastAffirmedEntry = (text, entries) => {
  let best = null;
  for (const { pattern, value } of entries) {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (isNegatedBefore(text, match.index)) continue;
      if (!best || match.index > best.index) best = { index: match.index, value: typeof value === 'function' ? value(match) : value };
    }
  }
  return best;
};

const lastAffirmed = (text, entries) => lastAffirmedEntry(text, entries)?.value;

/* ----------------------------- День ------------------------------------ */

const WEEKDAY_FORMS = [
  ['понедельник', 1], ['вторник', 2], ['среду', 3], ['четверг', 4], ['пятницу', 5], ['субботу', 6], ['воскресенье', 7],
  // Сокращения: «в пн или ср».
  ['пн', 1], ['вт', 2], ['ср', 3], ['чт', 4], ['пт', 5], ['сб', 6], ['вс', 7],
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
    // «Через 2 дня», «через неделю» — день от сегодняшнего.
    pattern: new RegExp(`(?<!${WORD})через\\s+(\\d{1,2}|один|два|две|три|четыре|пять|шесть|семь|неделю)(?:\\s+(дн\\p{L}*|день|сут\\p{L}*))?(?!${WORD})`, 'u'),
    value: (match) => {
      const words = { один: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, неделю: 7 };
      const days = /^\d+$/.test(match[1]) ? Number(match[1]) : words[match[1]];
      // «Через 2» без «дня» — не день (может быть «через 2 часа» в другой форме); берём только с «дня» или «неделю».
      return match[2] || match[1] === 'неделю' ? { kind: 'in_days', days } : { kind: 'none' };
    },
  },
  {
    pattern: new RegExp(`(?<!${WORD})(?:в\\s+любой\\s+день|день\\s+(?:не\\s+важен|неважен|любой)|когда\\s+угодно|без\\s+разницы\\s+когда|в\\s+ближайш\\p{L}*\\s+(?:дни|время))(?!${WORD})`, 'u'),
    value: { kind: 'any' },
  },
];

const validDate = (value) =>
  (value.kind !== 'date' || (value.month >= 1 && value.month <= 12 && value.dayOfMonth >= 1 && value.dayOfMonth <= 31))
  && (value.kind !== 'in_days' || (Number.isInteger(value.days) && value.days >= 1 && value.days <= 60));

/*
 * Несколько дней через «или»: «во вторник или среду», «сегодня или завтра»,
 * «в понедельник, среду или пятницу». Раньше брался только последний день,
 * и «вторник или среда» молча превращались в «среду».
 */
const WEEKDAY_STEMS = WEEKDAY_FORMS.map(([form]) => form).join('|');
const LIST_ITEM = new RegExp(
  `(?<!${WORD})(?:(во|в|на|к|ко)\\s+)?(?:(?:эт|ближайш|следующ)\\p{L}*\\s+)?(${WEEKDAY_STEMS})(?!${WORD})`
  + `|(?<!${WORD})(сегодня|послезавтра|завтра)(?!${WORD})`
  + `|(?<![\\p{L}\\p{N}.:])(\\d{1,2})\\s+(${MONTHS.join('|')})\\p{L}*`
  // «15 или 16 октября»: месяц у первого числа — от следующего.
  + `|(?<![\\p{L}\\p{N}.:])(\\d{1,2})(?=(?:\\s*(?:,|или|либо|и)\\s*\\d{1,2})+\\s+(?:${MONTHS.join('|')}))`,
  'gu',
);
const LIST_JOIN = /^\s*(?:,|или|либо|и|\/)(?:\s*(?:или|либо|и))?\s*(?:(?:на|в|во)\s+)?$/u;

const listItemValue = (match) => {
  if (match[2]) return { kind: 'weekday', weekday: WEEKDAY_FORMS.find(([form]) => form === match[2])[1] };
  if (match[3]) return { kind: { сегодня: 'today', завтра: 'tomorrow', послезавтра: 'after_tomorrow' }[match[3]] };
  if (match[6]) return { kind: 'date', month: null, dayOfMonth: Number(match[6]) };
  const month = MONTHS.findIndex((stem) => new RegExp(`^${stem}`, 'u').test(match[5])) + 1;
  return { kind: 'date', month, dayOfMonth: Number(match[4]) };
};

/** Последняя группа из ≥2 дней через «или»/запятую: {index, end, options} или null. */
const lastDateList = (text) => {
  const mentions = [...text.matchAll(LIST_ITEM)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    // «среду» без предлога — день только в перечислении («во вторник или среду»).
    bare: Boolean(match[2]) && !match[1],
    value: listItemValue(match),
  }));
  let best = null;
  let group = [];
  const close = () => {
    if (group.length > 1 && !isNegatedBefore(text, group[0].index)) best = group;
    group = [];
  };
  for (const mention of mentions) {
    const joined = group.length > 0 && LIST_JOIN.test(text.slice(group[group.length - 1].end, mention.index));
    if (!joined) {
      close();
      if (mention.bare) continue;
    }
    group.push(mention);
  }
  close();
  if (!best) return null;
  // Число без месяца берёт месяц ближайшей следующей даты группы.
  for (let position = best.length - 1, month = null; position >= 0; position -= 1) {
    const { value } = best[position];
    if (value.kind === 'date' && value.month) month = value.month;
    else if (value.kind === 'date') value.month = month;
  }
  const seen = new Set();
  const options = best.map((item) => item.value).filter((value) => validDate(value) && !seen.has(JSON.stringify(value)) && seen.add(JSON.stringify(value)));
  return options.length > 1 ? { index: best[0].index, end: best[best.length - 1].end, options } : null;
};

/*
 * «В субботу 16 октября», «завтра, в пятницу»: день недели рядом с датой —
 * проверка, а не второе условие. Если они расходятся (16 октября — пятница),
 * подбор спросит, какой день имелся в виду, а не выберет за пользователя.
 */
const PAIR_JOIN = /^[\s,()—–-]*$/u;
const lastDatePair = (text) => {
  const mentions = [...text.matchAll(LIST_ITEM)].map((match) => ({ index: match.index, end: match.index + match[0].length, value: listItemValue(match) }));
  let best = null;
  for (let position = 1; position < mentions.length; position += 1) {
    const [left, right] = [mentions[position - 1], mentions[position]];
    if (!PAIR_JOIN.test(text.slice(left.end, right.index))) continue;
    const weekday = [left, right].find((item) => item.value.kind === 'weekday');
    const other = [left, right].find((item) => item.value.kind !== 'weekday');
    if (!weekday || !other || other.value.month === null || isNegatedBefore(text, left.index)) continue;
    best = { index: left.index, end: right.end, value: { ...other.value, expectWeekday: weekday.value.weekday } };
  }
  return best;
};

/* «В будни», «по рабочим дням» — фильтр поверх дня, как «в выходные». */
const WORKDAYS = new RegExp(`(?<!${WORD})(?:(?:в|по)\\s+будн\\p{L}*|в\\s+будний\\s+день|по\\s+рабочим\\s+дням|в\\s+рабоч\\p{L}*\\s+дн\\p{L}*|в\\s+рабочий\\s+день)`, 'u');

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

/*
 * Часы словами и с частью суток: «после шести вечера», «в 2 часа дня»,
 * «с 9 утра до 2 дня», «к десяти». Цифры без части суток («после 18»)
 * разбирает gateway; здесь — то, что он прочитал бы неверно («после 6
 * вечера» — это 18:00, а не 06:00) или не прочитал бы вовсе.
 */
const HOUR_WORDS = [
  ['одиннадцат', 11], ['двенадцат', 12], ['одного', 1], ['один', 1], ['час', 1], ['двух', 2], ['два', 2], ['тр[её]х', 3], ['три', 3],
  ['четыр[её]х', 4], ['четыре', 4], ['пяти', 5], ['пять', 5], ['шести', 6], ['шесть', 6], ['семи', 7], ['семь', 7], ['восьми', 8],
  ['восемь', 8], ['девяти', 9], ['девять', 9], ['десяти', 10], ['десять', 10],
];
const HOUR_WORD = `(?:${HOUR_WORDS.map(([word]) => `${word}\\p{L}*`).join('|')})`;
const TIME_KIND = [
  ['after', '(?:после|позже|не\\s+раньше|не\\s+ранее|начиная\\s+с|с)'],
  ['before', '(?:до|не\\s+позже|не\\s+позднее|раньше)'],
  ['around', '(?:около|примерно\\s+в|где-?то\\s+в)'],
  ['exact', '(?:к|в|на)'],
];
const NOT_TIME_AFTER = '(?!\\s+(?:тысяч|руб|лет|год|раз|минут|недел|дней|суток|месяц|человек|детей|процент|км|метр|приём|прием|врач|клиник))';
const SPOKEN_TIME = new RegExp(
  `(?<!${WORD})(${TIME_KIND.map(([, words]) => words).join('|')})\\s+(\\d{1,2}|${HOUR_WORD})(?::(\\d{2}))?${NOT_TIME_AFTER}(\\s+час(?:а|ов)?)?(?:\\s+(утра|дня|вечера|ночи))?(?!${WORD})`,
  'gu',
);
const hourFromWord = (word) => HOUR_WORDS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(word))?.[1] ?? null;

const spokenTimes = (text) => {
  const found = {};
  for (const match of text.matchAll(SPOKEN_TIME)) {
    const [, preposition, hourText, minutes = '00', hoursWord, dayPart] = match;
    const digits = /^\d+$/.test(hourText);
    // Цифры без части суток — забота gateway; слово без «часов» и части суток — только после «после/до/с».
    if (digits && !dayPart) continue;
    const kind = TIME_KIND.find(([, words]) => new RegExp(`^${words}$`, 'u').test(preposition.replace(/\s+/gu, ' ')))?.[0];
    if (!kind) continue;
    if (!digits && !dayPart && !hoursWord && !['after', 'before'].includes(kind)) continue;
    let hour = digits ? Number(hourText) : hourFromWord(hourText);
    if (hour === null || hour > 23 || dayPart === 'ночи') continue;
    if ((dayPart === 'вечера' && hour < 12) || (dayPart === 'дня' && hour >= 1 && hour <= 6)) hour += 12;
    // «После шести» без части суток: в часах приёма это вечер, а не 6 утра; в понятых условиях видно «после 18:00».
    if (!digits && !dayPart && hour >= 1 && hour <= 7) hour += 12;
    if (isNegatedBefore(text, match.index) && !/^не\s/u.test(preposition)) continue;
    found[kind] = `${String(hour).padStart(2, '0')}:${minutes}`;
  }
  return found;
};

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

/* ----------------------------- Район ----------------------------------- */

/*
 * «В Вахитовском районе», «в Вахитовском или Приволжском районе», «не в
 * Советском районе», «кроме Советского района». Слово «район» обязательно:
 * «Московский проспект» — улица, а «в Москве» — город (см. CITY_PATTERNS).
 * «В центре» — Вахитовский район: так и пишется в понятых условиях.
 */
const DISTRICT_STEMS = [
  ['авиастроительн', 'Авиастроительный'], ['вахитовск', 'Вахитовский'], ['кировск', 'Кировский'], ['московск', 'Московский'],
  ['ново-?савиновск', 'Ново-Савиновский'], ['приволжск', 'Приволжский'], ['советск', 'Советский'],
];
const DISTRICT_WORD = new RegExp(`(?<!${WORD})(${DISTRICT_STEMS.map(([stem]) => stem).join('|')})\\p{L}*(?=[^.!?;]{0,60}?(?<!${WORD})(?:район|р-н))`, 'gu');
const DISTRICT_EXCLUDED_BEFORE = /(?:(?<!\p{L})не(?:\s+(?:в|во|из|на))?|кроме|исключая|только\s+не(?:\s+(?:в|во))?|подальше\s+от)\s*$/u;
const CITY_CENTER = new RegExp(
  `(?<!${WORD})в\\s+(?:самом\\s+)?центре(?:\\s+(?:города|казани))?`
  + `(?=\\s*$|\\s*[,.!?;)]|\\s+(?:и|или|а|но|после|до|с|со|на|в|во|по|завтра|сегодня|послезавтра|утром|вечером|дн[её]м|не|недорого|подешевле)(?!\\p{L}))`,
  'u',
);

const extractDistricts = (text) => {
  const include = [];
  const exclude = [];
  for (const match of text.matchAll(DISTRICT_WORD)) {
    const name = DISTRICT_STEMS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(match[1]))[1];
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    (DISTRICT_EXCLUDED_BEFORE.test(before) ? exclude : include).push(name);
  }
  const centre = CITY_CENTER.exec(text);
  if (centre) (DISTRICT_EXCLUDED_BEFORE.test(text.slice(Math.max(0, centre.index - 24), centre.index)) ? exclude : include).push('Вахитовский');
  return { include: [...new Set(include)], exclude: [...new Set(exclude)].filter((name) => !include.includes(name)) };
};

/* --------------------------- Пол врача ---------------------------------- */

/*
 * Только про врача: «врач-женщина», «к женщине-гинекологу», «чтобы врач был
 * мужчина». «Я женщина, 35 лет» — о пациенте, не о враче, и не учитывается.
 */
const DOCTOR_NOUN = '(?:врач|доктор|специалист|терапевт|лор|отоларинголог|невролог|кардиолог|офтальмолог|окулист|гинеколог|эндокринолог|гастроэнтеролог|уролог|дерматолог|хирург|ортопед|травматолог|педиатр|стоматолог|психиатр)\\p{L}*';
/*
 * Через дефис — любая форма («к врачу-женщине»). Без дефиса — только
 * «женщина/женщину»: «гинеколог женщине 30 лет» и «для женщины» — о пациентке.
 */
const genderPatterns = (stem, adjective, value) => [
  new RegExp(`(?<!${WORD})${DOCTOR_NOUN}\\s*[-–—]\\s*${stem}\\p{L}*`, 'u'),
  new RegExp(`(?<!${WORD})${DOCTOR_NOUN}\\s+(?:(?:был\\p{L}*|будет)\\s+(?:бы\\s+)?)?${stem}[ау](?!${WORD})`, 'u'),
  new RegExp(`(?<!${WORD})${stem}\\p{L}*\\s*[-–—]\\s*${DOCTOR_NOUN}`, 'u'),
  // «Я женщина, …» — о себе; «нужна женщина-терапевт» / «женщина терапевт» — о враче.
  new RegExp(`(?<!(?<!${WORD})я\\s+|${WORD})${stem}[ау]\\s+${DOCTOR_NOUN}`, 'u'),
  new RegExp(`(?<!${WORD})(?:к|ко)\\s+${stem}(?:е|ам)(?!${WORD})`, 'u'),
  new RegExp(`(?<!${WORD})${DOCTOR_NOUN}\\s+${adjective}\\s+пола`, 'u'),
  new RegExp(`(?<!${WORD})(?:чтобы|что\\s*бы)\\s+(?:это\\s+)?(?:(?:врач|доктор)\\p{L}*\\s+)?(?:был\\p{L}*\\s+)?${stem}`, 'u'),
].map((pattern) => ({ pattern, value }));
const GENDER_PATTERNS = [...genderPatterns('женщин', 'женского', 'female'), ...genderPatterns('мужчин', 'мужского', 'male')];

/* ------------------------------ Стаж ------------------------------------ */

/* «С опытом больше 15 лет» — строго больше: от 16; «стаж от 10 лет» — от 10. */
const EXPERIENCE_PATTERNS = [
  {
    pattern: new RegExp(`(?<!${WORD})(?:опыт|стаж)\\p{L}*\\s+(?:работы\\s+)?(?:(больше|более|свыше)|от|не\\s+меньше|не\\s+менее|минимум|как\\s+минимум|хотя\\s+бы)?\\s*(\\d{1,2})\\s*\\+?\\s*(?:лет|года?)(?!${WORD})`, 'u'),
    value: (match) => Number(match[2]) + (match[1] ? 1 : 0),
  },
  {
    pattern: new RegExp(`(?<!${WORD})(?:(больше|более|свыше)|от|не\\s+меньше|не\\s+менее|минимум)\\s+(\\d{1,2})\\s*(?:лет|года?)\\s+(?:опыт|стаж|практик)\\p{L}*`, 'u'),
    value: (match) => Number(match[2]) + (match[1] ? 1 : 0),
  },
];

/* ---------------------- Чего в демо нет вовсе --------------------------- */

const UNSUPPORTED_PATTERNS = [
  ['home_visit', new RegExp(`(?<!${WORD})(?:на\\s+дом(?!${WORD})|на\\s+дому|выезд\\p{L}*\\s+(?:врача|доктора|на\\s+дом)|с\\s+выездом|вызвать\\s+(?:врача|доктора|педиатра|терапевта)|вызов\\s+(?:врача|доктора))`, 'u')],
  ['online', new RegExp(`(?<!${WORD})(?:онлайн[-\\s]*(?:консультац|при[её]м|врач|доктор)|видео[-\\s]*(?:связ|звон|консультац|при[её]м)|телемедицин|дистанционн\\p{L}*\\s+(?:консультац|при[её]м)|по\\s+видео)`, 'u')],
  ['rating', new RegExp(`(?<!${WORD})(?:отзыв|рейтинг|топов\\p{L}*\\s+(?:врач|клиник)|(?:самого\\s+|самый\\s+|самую\\s+)?лучш(?:ий|ая|его|ую|ие|их|ей|ему)\\s+${DOCTOR_NOUN.replace('(?:врач', '(?:клиник|врач')})`, 'u')],
  // Демо — только частные клиники: бесплатного приёма по ОМС в нём нет, и платный за него не выдаётся.
  ['oms', new RegExp(`(?<!${WORD})(?:по\\s+(?:полису\\s+)?омс|бесплатн\\p{L}*(?!\\p{L})(?!\\s+(?:парковк|wi-?fi|вайфай|консультац\\p{L}*\\s+по\\s+телефону)))`, 'u')],
];
/* «Онлайн-консультация не нужна», «отзывы не важны» — условие снято, а не поставлено. */
const NOT_NEEDED_AFTER = /^[^.!?;,]{0,20}?(?<!\p{L})не\s+(?:нуж\p{L}*|надо|обязательн\p{L}*|важн\p{L}*|интересу\p{L}*)/u;

/* ------------------------ Программа ДМС --------------------------------- */

/*
 * Названная программа: «по программе Demo Premium», «полис Демо Стандарт».
 * Без «демо»/«программы»/«полиса» рядом слово «премиум» — это название
 * клиники («Кама Премиум»), а не программа.
 */
const PLAN_WORD = '(basic|standard|premium|базов\\p{L}*|стандарт\\p{L}*|премиум\\p{L}*)';
const PLAN_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})(?:demo|демо)[\\s-]*${PLAN_WORD}(?!${WORD})`, 'u') },
  { pattern: new RegExp(`(?<!${WORD})(?:программ\\p{L}*|полис\\p{L}*|тариф\\p{L}*|дмс)\\s+(?:дмс\\s+)?«?(?:(?:demo|демо)[\\s-]*)?${PLAN_WORD}`, 'u') },
].map(({ pattern }) => ({
  pattern,
  value: (match) => {
    const word = match[1];
    if (/^(?:basic|базов)/u.test(word)) return 'demo-basic';
    if (/^(?:standard|стандарт)/u.test(word)) return 'demo-standard';
    return 'demo-premium';
  },
}));

/* ----------------- Точка отправления, названная словами ------------------ */

/*
 * «От дома», «от работы», «рядом с Кремлём». Координат по названию нет, а
 * геолокация — это где человек сейчас, не обязательно «дом»: подбор спросит
 * точку. «Рядом со мной», «поближе» — это и есть геолокация, вопроса нет.
 */
const NEAR = '(?:рядом\\s+с(?:о)?|возле|около|недалеко\\s+от|поблизости\\s+от|неподал[её]ку\\s+от|ближе\\s+к)';
const FROM = `(?:от|${NEAR})`;
const OWNER = '(?:(?:моего|моему|моим|нашего|нашему|нашим|своего|своему)\\s+)?';
const TRAVEL_CONTEXT = new RegExp(`(?<!${WORD})(?:\\d+\\s*мин|ехать|езды|доехать|добираться|добраться|дойти|ходьбы|пешком|на\\s+машине|на\\s+велосипеде|поближе|рядом|недалеко|возле|около|поблизости|неподал)`, 'u');
const NOT_A_PLACE = '(?:меня|мне|мной|нас|нам|ним|ней|них|него|дом|работ|офис|\\d|час|минут|недел|дн|месяц|год|лет|раз|тысяч|рубл|бол|кашл|температур|простуд|давлен|аллерг|насморк|головн|зуб|горл|спин|живот'
  // «Около семи вечера» — время, а не место.
  + '|одного|двух|тр[её]х|четыр[её]х|пяти|шести|семи|восьми|девяти|десяти|одиннадцати|двенадцати|полудня|полуночи|утра|вечера)';
/*
 * Микрорайоны и места («в районе Горок», «на Азино») — это «рядом с местом»,
 * а не район Казани: координат по названию нет, подбор попросит точку.
 */
const MICRO_DISTRICT = '(?:горк|азино|дербышк|савинов|соцгород|танкодром|юдино|аметьев|кварталах|жилплощадк|кадышев|борисков|дубравн|константиновк|салмачи)\\p{L}*';
const NEAR_PLACE = new RegExp(
  `(?<!${WORD})(?:в\\s+районе\\s+(?!(?:${DISTRICT_STEMS.map(([stem]) => stem).join('|')}))\\p{L}{3,}|(?:в|во|на)\\s+(?:микрорайоне\\s+)?${MICRO_DISTRICT})`,
  'u',
);

const ORIGIN_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})${FROM}\\s+${OWNER}дом(?:а|у|ом)?(?!${WORD})`, 'u'), value: 'home' },
  { pattern: new RegExp(`(?<!${WORD})${FROM}\\s+${OWNER}(?:работ(?:ы|е|ой)|офис(?:а|у|ом)?)(?!${WORD})`, 'u'), value: 'work' },
  { pattern: new RegExp(`(?<!${WORD})${NEAR}\\s+(?!${NOT_A_PLACE})\\p{L}{3,}`, 'u'), value: 'place' },
  // «От Кремля» — только рядом со словами о дороге: «от кашля» — не место.
  { pattern: new RegExp(`(?<!${WORD})от\\s+(?!${NOT_A_PLACE})\\p{L}{3,}(?=[^.!?;]{0,40}(?:\\d+\\s*мин|ехать|езды|добира|доехать|дойти|ходьбы))`, 'u'), value: 'place' },
  { pattern: new RegExp(`(?:\\d+\\s*мин\\p{L}*|ехать|езды|добираться|доехать|дойти|ходьбы)[^.!?;]{0,25}?(?<!${WORD})от\\s+(?!${NOT_A_PLACE})\\p{L}{3,}`, 'u'), value: 'place' },
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

  const dateEntry = lastAffirmedEntry(lower, DATE_PATTERNS);
  const list = lastDateList(lower);
  const pair = lastDatePair(lower);
  // «Завтра, в субботу» — уточнение одного дня (через запятую), а не «завтра или в субботу».
  const pairWins = pair && validDate(pair.value) && (!dateEntry || dateEntry.index < pair.end)
    && (!list || list.end <= pair.index || (list.index === pair.index && list.end === pair.end));
  if (pairWins) {
    result.date = pair.value;
  } else if (list && (!dateEntry || dateEntry.index < list.end)) {
    result.date = { kind: 'any_of', options: list.options };
  } else if (dateEntry && validDate(dateEntry.value) && dateEntry.value.kind !== 'none') {
    result.date = dateEntry.value.kind === 'any' ? null : dateEntry.value;
  }
  /* «Только не в понедельник», «кроме пятницы» — исключённые дни недели. */
  const excludeWeekdays = new Set();
  for (const match of lower.matchAll(new RegExp(`(?<!${WORD})(?:не|кроме)\\s+(?:в|во)\\s+(${WEEKDAY_STEMS})(?!${WORD})`, 'gu'))) {
    excludeWeekdays.add(WEEKDAY_FORMS.find(([form]) => form === match[1])[1]);
  }
  const GENITIVE = [['понедельник', 1], ['вторник', 2], ['сред', 3], ['четверг', 4], ['пятниц', 5], ['суббот', 6], ['воскресень', 7]];
  for (const match of lower.matchAll(new RegExp(`(?<!${WORD})(?:кроме|исключая|без)\\s+((?:${GENITIVE.map(([stem]) => stem).join('|')})\\p{L}*(?:\\s*(?:,|и)\\s*(?:${GENITIVE.map(([stem]) => stem).join('|')})\\p{L}*)*)`, 'gu'))) {
    for (const [stem, day] of GENITIVE) if (new RegExp(`(?<!${WORD})${stem}`, 'u').test(match[1])) excludeWeekdays.add(day);
  }
  if (excludeWeekdays.size > 0) {
    result.excludeWeekdays = [...excludeWeekdays].sort();
    // «Кроме субботы» — не «в выходные»: слово «суббота» здесь исключает день.
    if ([...excludeWeekdays].some((day) => day >= 6) && !new RegExp(`(?<!${WORD})(?:в|на)\\s+(?:эти\\s+|ближайшие\\s+)?выходн`, 'u').test(lower)) result.suppressWeekend = true;
    // «Не в понедельник» — не выбор понедельника: если день взят из этого же отрицания, его нет.
    if (result.date?.kind === 'weekday' && excludeWeekdays.has(result.date.weekday)) delete result.date;
  }

  /* Точное время («на 17:30», «в 9:00») и «около 17:30» (±30 минут). «На 15.10» — дата, а не время. */
  const around = /(?<![\p{L}\p{N}])(?:около|примерно\s+в|где-?то\s+в|часов\s+в)\s+(\d{1,2}):(\d{2})(?![\d])/u.exec(lower);
  const exact = /(?<![\p{L}\p{N}])(?:на|в|к)\s+(\d{1,2}):(\d{2})(?![\d.:])(?!\s*(?:мин|руб|₽|тыс))/u.exec(lower);
  const asTime = (hours, minutes) => (Number(hours) <= 23 && Number(minutes) <= 59 ? `${String(Number(hours)).padStart(2, '0')}:${minutes}` : null);
  if (around && asTime(around[1], around[2])) result.timeAround = asTime(around[1], around[2]);
  else if (exact && asTime(exact[1], exact[2]) && !isNegatedBefore(lower, exact.index)) result.timeExact = asTime(exact[1], exact[2]);

  const workdays = WORKDAYS.exec(lower);
  if (workdays && !isNegatedBefore(lower, workdays.index)) result.workdays = true;

  const districts = extractDistricts(lower);
  if (districts.include.length > 0) result.districts = districts.include;
  if (districts.exclude.length > 0) result.excludeDistricts = districts.exclude;
  if (/(?<![\p{L}])(?:в\s+любом\s+районе|район\s+(?:не\s+важен|неважен|любой))/u.test(lower)) result.districtAny = true;

  const genderEntry = lastAffirmedEntry(lower, GENDER_PATTERNS);
  if (genderEntry) {
    // «Желательно женщина», «лучше бы врач-женщина» — пожелание, а не условие.
    const soft = /(?<!\p{L})(?:желательно|предпочтительно|по\s+возможности|лучше(?:\s+бы)?|если\s+можно|хорошо\s+бы)[^.!?;]{0,25}$/u.test(lower.slice(Math.max(0, genderEntry.index - 30), genderEntry.index))
      || /^[^.!?;]{0,25}(?<!\p{L})(?:желательно|по\s+возможности|если\s+можно|если\s+получится)/u.test(lower.slice(genderEntry.index, genderEntry.index + 45));
    if (soft) result.preferGender = genderEntry.value;
    else result.doctorGender = genderEntry.value;
  }
  // «Желательно женщина» без слова «врач» рядом — тоже о враче: пациент так о себе не пишет.
  if (!genderEntry) {
    const softBare = /(?<!\p{L})(?:желательно|предпочтительно|по\s+возможности|лучше(?:\s+бы)?)\s*,?\s*(?:чтобы\s+)?(?:был[аи]?\s+)?(женщин|мужчин)[ауы]?(?!\p{L})/u.exec(lower);
    if (softBare) result.preferGender = softBare[1] === 'женщин' ? 'female' : 'male';
  }
  if (/(?<![\p{L}])пол\s+врача\s+(?:не\s+важен|неважен)|(?:неважно|не\s+важно|без\s+разницы)[,\s]+(?:мужчина\s+или\s+женщина|женщина\s+или\s+мужчина)/u.test(lower)) result.genderAny = true;

  const experience = lastAffirmed(lower, EXPERIENCE_PATTERNS);
  if (Number.isInteger(experience) && experience >= 1 && experience <= 60) result.minExperience = experience;

  const unsupported = UNSUPPORTED_PATTERNS
    .filter(([, pattern]) => {
      const match = pattern.exec(lower);
      return match && !isNegatedBefore(lower, match.index) && !NOT_NEEDED_AFTER.test(lower.slice(match.index + match[0].length));
    })
    .map(([key]) => key);
  if (unsupported.length > 0) result.unsupported = unsupported;

  if (new RegExp(`(?<!${WORD})(?:к\\s+)?(?:любому|другому|любой|другой)\\s+${DOCTOR_NOUN}`, 'u').test(lower)) result.doctorAny = true;
  if (new RegExp(`(?<!${WORD})(?:в\\s+)?(?:любой|другой|любую|другую)\\s+клиник\\p{L}*|клиника\\s+(?:не\\s+важна|неважна|любая)`, 'u').test(lower)) result.clinicAny = true;

  const planId = lastAffirmed(lower, PLAN_PATTERNS);
  if (planId) result.planId = planId;

  if (TRAVEL_CONTEXT.test(lower)) {
    const originHint = lastAffirmed(lower, ORIGIN_PATTERNS);
    if (originHint) result.originHint = originHint;
  }
  const nearPlace = NEAR_PLACE.exec(lower);
  if (nearPlace && !isNegatedBefore(lower, nearPlace.index)) {
    result.originHint = result.originHint || 'place';
    result.nearPlace = true;
  }

  const spoken = spokenTimes(lower);
  if (spoken.after) result.spokenAfter = spoken.after;
  if (spoken.before) result.spokenBefore = spoken.before;
  if (spoken.exact && !result.timeExact && !result.timeAround) result.timeExact = spoken.exact;
  if (spoken.around && !result.timeAround) {
    result.timeAround = spoken.around;
    delete result.timeExact;
  }
  // «После работы» — вечер; в понятых условиях это так и видно.
  if (new RegExp(`(?<!${WORD})после\\s+работы(?!${WORD})`, 'u').test(lower)) result.afterWork = true;

  if (PRICE_ANY.test(lower)) {
    result.maxPrice = null;
  } else {
    const price = lastAffirmed(lower, PRICE_PATTERNS);
    if (Number.isInteger(price)) result.maxPrice = price;
  }

  const city = lastAffirmed(lower, CITY_PATTERNS);
  if (city) result.city = city;

  const dmsOff = DMS_OFF.test(lower);
  const dmsOn = !dmsOff && (Boolean(planId) || (DMS_ON.test(lower) && findTrigger(lower, 'дмс', 'страховк', 'полис') !== 'negated'));
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
    workdays: false,
    maxTravelMinutes: null,
    travelMode: null,
    nearest: false,
    districts: [],
    excludeDistricts: [],
    doctorGender: null,
    preferGender: null,
    excludeWeekdays: [],
    excludeDoctorIds: [],
    excludeBranchIds: [],
    minExperience: null,
    unsupported: [],
    planId: null,
    originHint: null,
    doctorIds: [],
    branchIds: [],
    clinicChoice: false,
    foreignDoctor: false,
  };

  for (const { booking = {}, constraints = {} } of turns) {
    if ('date' in booking) {
      merged.date = booking.date;
      // «В любой день» снимает и «в выходные», и «в будни», и исключённые дни.
      if (booking.date === null) {
        merged.weekend = false;
        merged.workdays = false;
        merged.excludeWeekdays = [];
      }
      const weekendDays = (value) => value.kind === 'weekend'
        || (value.kind === 'weekday' && value.weekday >= 6)
        || (value.kind === 'any_of' && value.options.every((option) => option.kind === 'weekday' && option.weekday >= 6));
      // Новый день отменяет «в выходные» из прошлой реплики, кроме самих выходных.
      if (booking.date && !weekendDays(booking.date)) merged.weekend = false;
      // …и «в будни», если новый день сам не будний.
      if (booking.date && !booking.workdays) merged.workdays = false;
    }
    if (booking.workdays) {
      merged.workdays = true;
      merged.weekend = false;
    }
    if (booking.districtAny) {
      merged.districts = [];
      merged.excludeDistricts = [];
    }
    if (booking.districts || booking.excludeDistricts) {
      merged.districts = booking.districts || [];
      merged.excludeDistricts = booking.excludeDistricts || [];
    }
    if (booking.genderAny) {
      merged.doctorGender = null;
      merged.preferGender = null;
    }
    if (booking.doctorGender) {
      merged.doctorGender = booking.doctorGender;
      merged.preferGender = null;
    }
    if (booking.preferGender) {
      merged.preferGender = booking.preferGender;
      merged.doctorGender = null;
    }
    if (booking.excludeWeekdays) merged.excludeWeekdays = [...new Set([...merged.excludeWeekdays, ...booking.excludeWeekdays])].sort();
    if (booking.excludeDoctorIds) merged.excludeDoctorIds = [...new Set([...merged.excludeDoctorIds, ...booking.excludeDoctorIds])];
    if (booking.excludeBranchIds) merged.excludeBranchIds = [...new Set([...merged.excludeBranchIds, ...booking.excludeBranchIds])];
    if (booking.minExperience) merged.minExperience = booking.minExperience;
    // Условие, которого в демо нет, остаётся, пока его не снимут кнопкой (согласием).
    if (booking.unsupported) merged.unsupported = [...new Set([...merged.unsupported, ...booking.unsupported])];
    if (booking.planId) merged.planId = booking.planId;
    if (booking.originHint) merged.originHint = booking.originHint;

    // Названные врач и клиника — до тех пор, пока не назовут других или не скажут «к любому».
    if (booking.doctorIds?.length) {
      merged.doctorIds = booking.doctorIds;
      merged.foreignDoctor = false;
    } else if (booking.foreignDoctor) {
      merged.doctorIds = [];
      merged.foreignDoctor = true;
    } else if (booking.doctorAny) {
      merged.doctorIds = [];
      merged.foreignDoctor = false;
    }
    if (booking.branchIds?.length) {
      merged.branchIds = booking.branchIds;
      merged.clinicChoice = Boolean(booking.clinicChoice);
    } else if (booking.clinicAny) {
      merged.branchIds = [];
      merged.clinicChoice = false;
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
    if (booking.timeExact || booking.timeAround) {
      // Точное время — окно в одну минуту; «около» — ±30 минут. Прежние «после/до/вечером» заменяются.
      const [hours, minutes] = (booking.timeExact || booking.timeAround).split(':').map(Number);
      const at = hours * 60 + minutes;
      const clamp = (value) => Math.min(Math.max(value, 0), 24 * 60 - 1);
      const asText = (value) => `${String(Math.floor(clamp(value) / 60)).padStart(2, '0')}:${String(clamp(value) % 60).padStart(2, '0')}`;
      merged.timeFrom = asText(booking.timeExact ? at : at - 30);
      merged.timeTo = asText(booking.timeExact ? at + 1 : at + 31);
      merged.evening = false;
    }
    if (constraints.availableAfter && !booking.timeExact && !booking.timeAround) {
      merged.timeFrom = constraints.availableAfter;
      if (!constraints.availableBefore && merged.timeTo && merged.timeTo <= constraints.availableAfter) merged.timeTo = null;
    }
    if (constraints.availableBefore && !booking.timeExact && !booking.timeAround) {
      merged.timeTo = constraints.availableBefore;
      if (!constraints.availableAfter && merged.timeFrom && merged.timeFrom >= constraints.availableBefore) merged.timeFrom = null;
    }
    // Часы словами и с частью суток — точнее разбора цифр gateway в той же реплике.
    // Противоположная граница снимается, только если она из прошлой реплики: «после 18 до 10 утра» — это вопрос, а не «до 10».
    if (booking.spokenAfter) {
      merged.timeFrom = booking.spokenAfter;
      if (!booking.spokenBefore && !constraints.availableBefore && merged.timeTo && merged.timeTo <= booking.spokenAfter) merged.timeTo = null;
    }
    if (booking.spokenBefore) {
      merged.timeTo = booking.spokenBefore;
      if (!booking.spokenAfter && !constraints.availableAfter && merged.timeFrom && merged.timeFrom >= booking.spokenBefore) merged.timeFrom = null;
    }
    if (booking.afterWork) merged.evening = true;
    if (booking.nearPlace) merged.nearest = true;
    if (constraints.evening) {
      merged.evening = true;
      if (!booking.timeOfDay && merged.timeTo && merged.timeTo <= '17:00') merged.timeTo = null;
    }
    // «В субботу 16 октября»: «суббота» здесь — проверка даты, а не отдельное «в выходные».
    if (constraints.weekend && !booking.workdays && !booking.date?.expectWeekday && !booking.suppressWeekend) {
      merged.weekend = true;
      merged.workdays = false;
    }

    if (booking.dms === false) merged.dms = false;
    else if (booking.dms === true || constraints.dmsOnly) merged.dms = true;

    if (booking.travelAny) {
      merged.maxTravelMinutes = null;
      merged.nearest = false;
      merged.originHint = null;
    }
    if (Number.isInteger(constraints.maxTravelMinutes)) merged.maxTravelMinutes = constraints.maxTravelMinutes;
    if (constraints.travelMode) merged.travelMode = constraints.travelMode;
    if (constraints.selection === 'nearest') merged.nearest = true;
  }

  return merged;
};
