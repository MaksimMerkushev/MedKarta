/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Условия записи из текста: день, потолок цены, город, ДМС, повторный приём
 * и явные «снятия» условий («в любое время», «цена не важна», «без ДМС»).
 *
 * Возвращает только перечислимые значения и числа, без слов пользователя. Во
 * внешнюю модель условия не уходят вовсе: их исполняет строгий подбор
 * демо-записи на сервере (shared/demoSearch.js), и модель не может их «ослабить».
 *
 * Набор диалога — слияние наборов реплик, поздняя важнее: «ЛОР завтра» →
 * «а лучше послезавтра» → послезавтра. null — «условие снято».
 */

import { findTrigger, fixCommonTypos, isNegatedBefore, rewriteNegatedTimeBounds } from './normalize.js';
import { CONSENTED_FALLBACKS, withoutDayWindow } from '../../shared/demoSearch.js';

/** Значение дня без служебной пометки «число без месяца». */
const withoutDayOnly = (value) => {
  const copy = { ...value };
  delete copy.dayOnly;
  return copy;
};

const WORD = '[\\p{L}\\p{N}]';

/* «Добрый вечер» — приветствие, а не «вечером». */
const prepare = (text) =>
  rewriteNegatedTimeBounds(fixCommonTypos(String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/(?<!\p{L})добр\p{L}*\s+(?:вечер|утр|ден|дн|ноч)\p{L}*/gu, ' ')));

/** Последнее неотрицаемое совпадение среди нескольких шаблонов: {index, value}. */
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
  // «С понедельника по среду».
  ['понедельника', 1], ['вторника', 2], ['среды', 3], ['четверга', 4], ['пятницы', 5], ['субботы', 6], ['воскресенья', 7],
];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[яй]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

/*
 * «В следующий понедельник» — понедельник следующей недели, «в эту
 * пятницу» — этой; «в ближайшую среду» — просто ближайшая. Неделя видна в
 * понятых условиях («на следующей неделе в понедельник»).
 */
const weekOf = (text) => {
  if (new RegExp(`(?<!${WORD})(?:следующ|будущ)\\p{L}*\\s+\\p{L}`, 'u').test(text)) return { week: 'next' };
  if (new RegExp(`(?<!${WORD})эт(?:от|у|о|а|им|ой)\\s+\\p{L}`, 'u').test(text)) return { week: 'this' };
  return {};
};

const DATE_PATTERNS = [
  { pattern: new RegExp(`(?<!${WORD})сегодня(?!${WORD})`, 'u'), value: { kind: 'today' } },
  { pattern: new RegExp(`(?<!${WORD})(?:на\\s+)?(?:этой|текущей)\\s+неделе(?!${WORD})`, 'u'), value: { kind: 'this_week' } },
  { pattern: new RegExp(`(?<!${WORD})(?:на\\s+)?(?:следующей|будущей)\\s+неделе(?!${WORD})`, 'u'), value: { kind: 'next_week' } },
  // «На после завтра» — частая опечатка «послезавтра», а не «завтра».
  { pattern: new RegExp(`(?<!${WORD})(?<!после\\s)(?:завтра|завтрашн\\p{L}*)(?!${WORD})`, 'u'), value: { kind: 'tomorrow' } },
  { pattern: new RegExp(`(?<!${WORD})(?:послезавтра|после\\s+завтра)(?!${WORD})`, 'u'), value: { kind: 'after_tomorrow' } },
  // «День — четверг», «когда: пятница» — день недели в именительном.
  ...[['понедельник', 1], ['вторник', 2], ['среда', 3], ['четверг', 4], ['пятница', 5], ['суббота', 6], ['воскресенье', 7]].map(([form, weekday]) => ({
    pattern: new RegExp(`(?<!${WORD})(?:день|дата|когда)\\s*[—–:-]+\\s*${form}(?!${WORD})`, 'u'),
    value: { kind: 'weekday', weekday },
  })),
  // «А только суббота?», «лучше пятница» — день недели в именительном после частицы.
  ...[['понедельник', 1], ['вторник', 2], ['среда', 3], ['четверг', 4], ['пятница', 5], ['суббота', 6], ['воскресенье', 7]].map(([form, weekday]) => ({
    pattern: new RegExp(`(?<!${WORD})(?:только|а|лучше|или|давай(?:те)?|пусть|можно)\\s+${form}(?!${WORD})`, 'u'),
    value: { kind: 'weekday', weekday },
    weekday: true,
  })),
  // «На 17-е», «в 17-го числа» — число без месяца: ближайшее такое.
  {
    pattern: new RegExp(`(?<!${WORD})(?:(?:на|в|к|до|а|или)\\s+|^\\s*)(\\d{1,2})(?:-?(?:го|е)(?:\\s+числа)?|\\s+числа)(?!${WORD})`, 'u'),
    value: (match) => ({ kind: 'date', month: null, dayOfMonth: Number(match[1]) }),
  },
  ...WEEKDAY_FORMS.map(([form, weekday]) => ({
    pattern: new RegExp(`(?<!${WORD})(?:в|во|на|к|ко)\\s+(?:(?:эт|ближайш|следующ|будущ)\\p{L}*\\s+)?${form}(?!${WORD})`, 'u'),
    // «В следующую пятницу», сказанное в среду, — это 16-е или 23-е? Подбор спросит (askWeek).
    value: (match) => ({ kind: 'weekday', weekday, ...weekOf(match[0]), ...(weekOf(match[0]).week === 'next' ? { askWeek: true } : {}) }),
    weekday: true,
  })),
  {
    pattern: new RegExp(`(?<!${WORD})(?:в|на)\\s+(?:эти\\s+|ближайшие\\s+)?выходн\\p{L}*`, 'u'),
    value: { kind: 'weekend' },
  },
  {
    // «1 января 2030», «15 октября 2026 г.» — с годом: другой год не подменяется ближайшим.
    pattern: new RegExp(`(?<![\\p{L}\\p{N}.:])(\\d{1,2})\\s+(${MONTHS.join('|')})\\p{L}*\\s+(20\\d{2})(?:\\s*(?:г\\.?|года?))?(?!\\d)`, 'u'),
    value: (match) => {
      const month = MONTHS.findIndex((stem) => new RegExp(`^${stem}`, 'u').test(match[2])) + 1;
      return { kind: 'date', month, dayOfMonth: Number(match[1]), year: Number(match[3]) };
    },
  },
  {
    // «01.01.2030», «15.10.26»
    pattern: /(?<![\p{L}\p{N}.:])(\d{1,2})\.(\d{1,2})\.(20\d{2}|\d{2})(?![\d.:])/u,
    value: (match) => ({ kind: 'date', month: Number(match[2]), dayOfMonth: Number(match[1]), year: match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]) }),
  },
  // «Вчера», «позавчера» — день уже прошёл: вопрос, а не «любой день» молча.
  { pattern: new RegExp(`(?<!${WORD})(?:вчера|позавчера|вчерашн\\p{L}*)(?!${WORD})`, 'u'), value: { kind: 'past' } },
  {
    // «Через 3 недели», «через месяц» — дальше окна расписания: подбор скажет, что так далеко его нет.
    pattern: new RegExp(`(?<!${WORD})через\\s+(\\d|два|две|три|четыре|пару)\\s+недел\\p{L}*|(?<!${WORD})через\\s+(месяц)(?!${WORD})`, 'u'),
    value: (match) => ({ kind: 'in_days', days: match[2] ? 30 : 7 * ({ два: 2, две: 2, три: 3, четыре: 4, пару: 2 }[match[1]] || Number(match[1])) }),
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
      // «Через 2» без «дня» — не день (может быть «через 2 часа»): только с «дня» или «неделю».
      return match[2] || match[1] === 'неделю' ? { kind: 'in_days', days } : { kind: 'none' };
    },
  },
  {
    pattern: new RegExp(`(?<!${WORD})(?:в\\s+любой\\s+день|(?:давай(?:те)?|можно|ладно,?|хорошо,?|пусть)\\s+любой\\s+день|день\\s+(?:не\\s+важен|неважен|любой)|когда\\s+угодно|без\\s+разницы\\s+когда|в\\s+ближайш\\p{L}*\\s+(?:дни|время))(?!${WORD})`, 'u'),
    value: { kind: 'any' },
  },
];

/*
 * Число месяца проверяется календарём при подборе: «32 октября» — не
 * «нет даты», а честное «такой даты нет».
 */
const validDate = (value) =>
  (value.kind !== 'date' || ((value.month === null || (value.month >= 1 && value.month <= 12)) && value.dayOfMonth >= 1 && value.dayOfMonth <= 99))
  && (value.kind !== 'in_days' || (Number.isInteger(value.days) && value.days >= 1 && value.days <= 60));

/*
 * Несколько дней через «или»: «в понедельник, среду или пятницу» — все, а не
 * только последний.
 */
const WEEKDAY_STEMS = WEEKDAY_FORMS.map(([form]) => form).join('|');
const LIST_ITEM = new RegExp(
  `(?<!${WORD})(?:(во|в|на|к|ко|с|со)\\s+)?(?:(?:эт|ближайш|следующ|будущ)\\p{L}*\\s+)?(${WEEKDAY_STEMS})(?!${WORD})`
  + `|(?<!${WORD})(?<!после\\s)(сегодня|послезавтра|завтра)(?!${WORD})`
  + `|(?<![\\p{L}\\p{N}.:])(\\d{1,2})\\s+(${MONTHS.join('|')})\\p{L}*`
  // «15 или 16 октября»: месяц у первого числа — от следующего.
  // «До 12, 15 октября» — «12» здесь часы, а не первое из чисел месяца.
  + `|(?<![\\p{L}\\p{N}.:])(?<!(?:до|после|около|позже|раньше)\\s)(\\d{1,2})(?=(?:\\s*(?:,|или|либо|и)\\s*\\d{1,2})+\\s+(?:${MONTHS.join('|')}))`
  // «17-го» — число без месяца.
  + `|(?<![\\p{L}\\p{N}.:])(\\d{1,2})-?го(?!${WORD})`,
  'gu',
);
const LIST_JOIN = /^\s*(?:,|или|либо|и|\/|[-–—]|по)(?:\s*(?:или|либо|и))?\s*(?:(?:на|в|во)\s+)?$/u;
/* «Пн–ср», «с понедельника по среду» — диапазон: все дни между. */
const RANGE_JOIN = /^\s*(?:[-–—]|по)\s*$/u;

const listItemValue = (match) => {
  if (match[2]) return { kind: 'weekday', weekday: WEEKDAY_FORMS.find(([form]) => form === match[2])[1], ...weekOf(match[0]) };
  if (match[3]) return { kind: { сегодня: 'today', завтра: 'tomorrow', послезавтра: 'after_tomorrow' }[match[3]] };
  if (match[6]) return { kind: 'date', month: null, dayOfMonth: Number(match[6]) };
  if (match[7]) return { kind: 'date', month: null, dayOfMonth: Number(match[7]), dayOnly: true };
  const month = MONTHS.findIndex((stem) => new RegExp(`^${stem}`, 'u').test(match[5])) + 1;
  return { kind: 'date', month, dayOfMonth: Number(match[4]) };
};

/** Последняя группа из ≥2 дней через «или»/запятую: {index, end, options} или null. */
const lastDateList = (text) => {
  const mentions = [...text.matchAll(LIST_ITEM)].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
    // «среду» без предлога — день только в перечислении («во вторник или среду»).
    // Сокращение («пн», «ср») — день и без предлога.
    bare: Boolean(match[2]) && !match[1] && match[2].length > 2,
    value: listItemValue(match),
  }));
  let best = null;
  let group = [];
  const close = () => {
    if (group.length > 1 && !isNegatedBefore(text, group[0].index)) best = group;
    group = [];
  };
  for (const mention of mentions) {
    const gap = group.length > 0 ? text.slice(group[group.length - 1].end, mention.index) : '';
    const joined = group.length > 0 && LIST_JOIN.test(gap);
    if (!joined) {
      close();
      if (mention.bare) continue;
    }
    const previous = group[group.length - 1];
    if (previous && RANGE_JOIN.test(gap) && previous.value.kind === 'weekday' && mention.value.kind === 'weekday' && mention.value.weekday > previous.value.weekday + 1) {
      for (let weekday = previous.value.weekday + 1; weekday < mention.value.weekday; weekday += 1) {
        group.push({ index: previous.index, end: previous.end, value: { kind: 'weekday', weekday } });
      }
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
  const options = best.map(({ value }) => withoutDayOnly(value))
    .filter((value) => validDate(value) && !seen.has(JSON.stringify(value)) && seen.add(JSON.stringify(value)));
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
    if (!weekday || !other || (other.value.month === null && !other.value.dayOnly) || isNegatedBefore(text, left.index)) continue;
    best = { index: left.index, end: right.end, value: { ...withoutDayOnly(other.value), expectWeekday: weekday.value.weekday } };
  }
  return best;
};

/*
 * Диапазоны дат: «с 15 по 17 октября», «до 20 октября», «после 15 октября» —
 * даты, а не часы («до 20:00»). «До» — не включая этот день (не позже, чем
 * просили), «по» — включая.
 */
const MONTH_WORD = `(?:${MONTHS.join('|')})\\p{L}*`;
const DAY_REF = `(\\d{1,2})(?:\\s+(${MONTH_WORD})|\\.(\\d{1,2})(?![\\d.:]))`;
const monthOf = (word, digits) => {
  if (digits) return Number(digits);
  if (!word) return null;
  return MONTHS.findIndex((stem) => new RegExp(`^${stem}`, 'u').test(word)) + 1;
};
const RANGE_FULL = new RegExp(
  `(?<!${WORD})(?:с|со)\\s+(\\d{1,2})(?:\\s+(${MONTH_WORD})|\\.(\\d{1,2}))?\\s*(?:по|до|[-–—])\\s*${DAY_REF}`,
  'u',
);
const RANGE_DASH = new RegExp(`(?<![\\p{L}\\p{N}.:])(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s+(${MONTH_WORD})`, 'u');
const RANGE_UNTIL = new RegExp(`(?<!${WORD})(до|по|не\\s+позже|не\\s+позднее|не\\s+дальше)\\s+${DAY_REF}`, 'u');
const RANGE_SINCE = new RegExp(`(?<!${WORD})(после|не\\s+раньше|начиная\\s+с|с|со)\\s+${DAY_REF}(?!\\s*(?:по|до|[-–—])\\s*\\d)`, 'u');
const dateRange = (text) => {
  const ref = (day, month, shift = 0) => ({ month, dayOfMonth: Number(day), shift });
  let match = RANGE_FULL.exec(text);
  if (match) {
    const toMonth = monthOf(match[5], match[6]);
    return { index: match.index, value: { kind: 'range', from: ref(match[1], monthOf(match[2], match[3]) || toMonth), to: ref(match[4], toMonth) } };
  }
  match = RANGE_DASH.exec(text);
  if (match) {
    const month = monthOf(match[3]);
    return { index: match.index, value: { kind: 'range', from: ref(match[1], month), to: ref(match[2], month) } };
  }
  match = RANGE_UNTIL.exec(text);
  if (match) return { index: match.index, value: { kind: 'range', from: null, to: ref(match[2], monthOf(match[3], match[4]), match[1] === 'до' ? -1 : 0) } };
  match = RANGE_SINCE.exec(text);
  if (match && /^(?:после|не\s+раньше|начиная)/u.test(match[1])) {
    return { index: match.index, value: { kind: 'range', from: ref(match[2], monthOf(match[3], match[4]), match[1] === 'после' ? 1 : 0), to: null } };
  }
  return null;
};

/* «В ближайшие 3 дня», «в течение недели» — несколько дней от сегодняшнего. */
const NEXT_DAYS = new RegExp(
  `(?<!${WORD})(?:в\\s+(?:ближайш\\p{L}*|следующ\\p{L}*)|в\\s+течение|за)\\s+(?:(\\d{1,2}|два|две|три|четыре|пять|шесть|семь|пару)\\s+(?:дн\\p{L}*|день|суток)|(недел\\p{L}*))(?!${WORD})`,
  'u',
);
const NEXT_DAYS_WORDS = { два: 2, две: 2, пару: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7 };

/* «Только не завтра», «сегодня не могу», «кроме 15 октября» — исключённые дни. */
const RELATIVE_DAY = { сегодня: 'today', завтра: 'tomorrow', послезавтра: 'after_tomorrow' };
const EXCLUDED_DAY_BEFORE = new RegExp(`(?<!${WORD})(?:не|кроме|исключая|только\\s+не|но\\s+не)\\s+(?:на\\s+)?(сегодня|послезавтра|завтра|(\\d{1,2})\\s+(${MONTH_WORD}))(?!${WORD})`, 'gu');
const EXCLUDED_DAY_AFTER = new RegExp(`(?<!${WORD})(сегодня|послезавтра|завтра)\\s*,?\\s+(?:я\\s+|мы\\s+|у\\s+меня\\s+)?(?:не\\s+(?:могу|смогу|получится|выйдет|подходит|успею|удобно|вариант)|занят\\p{L}?|никак|работаю)(?!${WORD})`, 'gu');
const ALSO_EXCLUDED = new RegExp(`(?<!${WORD})(сегодня|послезавтра|завтра)\\s+тоже(?!${WORD})`, 'gu');
const excludedDays = (text) => {
  const found = [];
  for (const match of text.matchAll(EXCLUDED_DAY_BEFORE)) {
    found.push(match[2] ? { kind: 'date', month: monthOf(match[3]), dayOfMonth: Number(match[2]) } : { kind: RELATIVE_DAY[match[1]] });
  }
  for (const match of text.matchAll(EXCLUDED_DAY_AFTER)) found.push({ kind: RELATIVE_DAY[match[1]] });
  if (found.length > 0) for (const match of text.matchAll(ALSO_EXCLUDED)) found.push({ kind: RELATIVE_DAY[match[1]] });
  const seen = new Set();
  return found.filter((value) => !seen.has(JSON.stringify(value)) && seen.add(JSON.stringify(value)));
};

/*
 * «В пятницу 16-го, если нельзя в пятницу — то в субботу 17-го»,
 * «сегодня, а если никого — завтра»: оба дня, а не только последний.
 */
const FALLBACK_SPLIT = new RegExp(
  `[,;]?\\s*(?:а\\s+)?если\\s+(?:[^.!?,;]{0,30}?\\s)?(?:нельзя|нет|не\\s+получится|не\\s+выйдет|никого|занято|не\\s+будет|не\\s+найд\\p{L}*)(?:[^.!?;]{0,25}?)\\s*(?:,\\s*)?(?:то|тогда|можно|давай(?:те)?|—|–|-|:)\\s+`,
  'u',
);

/* «В будни», «по рабочим дням» — фильтр поверх дня, как «в выходные». */
const WORKDAYS = new RegExp(`(?<!${WORD})(?:(?:в|по)\\s+(?:любой\\s+|любые\\s+)?будн\\p{L}*|по\\s+рабочим\\s+дням|в\\s+(?:любой\\s+)?рабоч\\p{L}*\\s+дн\\p{L}*|в\\s+(?:любой\\s+)?рабочий\\s+день|кроме\\s+выходн\\p{L}*|не\\s+в\\s+выходн\\p{L}*|без\\s+выходн\\p{L}*)`, 'u');

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

const THOUSAND_WORD = '(?:одн|полтор|полутор|дв|тр|четыр|пят|шест|сем|восьм|восем|девят|десят)\\p{L}*';
const thousandsFromWord = (word, half) => {
  const stems = [
    ['полтор', 1.5], ['полутор', 1.5], ['одн', 1], ['дв', 2], ['тр', 3], ['четыр', 4], ['пят', 5], ['шест', 6], ['сем', 7], ['восьм', 8], ['восем', 8], ['девят', 9], ['десят', 10],
  ];
  const found = stems.find(([stem]) => word.startsWith(stem));
  return found ? (found[1] + (half ? 0.5 : 0)) * 1000 : null;
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
    // «До 2500,» и «До 2500.» — конец фразы, а не дробь: запрещена только цифра после точки/запятой.
    pattern: new RegExp(`(?<!${WORD})(?:до|не\\s+более|не\\s+больше|максимум|в\\s+пределах)\\s+(\\d{3,6}|\\d{1,3}(?:[ \\u00a0\\u202f]\\d{3})+)(?![\\d:])(?![.,]\\d)(?!\\s*(?:мин|час|км|м(?!\\p{L})|лет|год|шаг))`, 'u'),
    value: (match) => parseAmount(match[1], null),
  },
  // «до трёх тысяч», «до двух с половиной тысяч» — словами
  {
    pattern: new RegExp(`(?<!${WORD})${PRICE_LIMIT}\\s+(?:(?:около|примерно)\\s+)?(${THOUSAND_WORD})(\\s+с\\s+половиной)?\\s+тыс\\p{L}*`, 'u'),
    value: (match) => thousandsFromWord(match[1], Boolean(match[2])),
  },
  // «тысячи до четырёх», «тысяч до 3» — «тысяч» впереди
  {
    pattern: new RegExp(`(?<!${WORD})тыс\\p{L}*\\s+(?:до|не\\s+больше|не\\s+более|максимум|в\\s+пределах)\\s+(${THOUSAND_WORD}|\\d{1,2})(?!${WORD})`, 'u'),
    value: (match) => (/^\d+$/.test(match[1]) ? Number(match[1]) * 1000 : thousandsFromWord(match[1], false)),
  },
  // «бюджет тысяч пять», «до тысяч трёх» — обратный порядок
  {
    pattern: new RegExp(`(?<!${WORD})${PRICE_LIMIT}\\s+(?:(?:около|примерно)\\s+)?тыс\\p{L}*\\s+(${THOUSAND_WORD}|\\d{1,2})(?!${WORD})`, 'u'),
    value: (match) => (/^\d+$/.test(match[1]) ? Number(match[1]) * 1000 : thousandsFromWord(match[1], false)),
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

/* «Утром», «после обеда», «днём» — условие на время приёма, как «после 18:00». */
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
  `(?<!${WORD})(${TIME_KIND.map(([, words]) => words).join('|')})\\s+(\\d{1,2}|${HOUR_WORD})(?::(\\d{2}))?${NOT_TIME_AFTER}(\\s+час(?:а|ов|ам)?)?(?:\\s+(утра|дня|вечера|ночи))?(?!${WORD})`,
  'gu',
);
/* «8 часов вечера в пятницу» — без предлога: ровно это время. */
const BARE_HOUR = new RegExp(`(?<![\\p{L}\\d:])(\\d{1,2}|${HOUR_WORD})\\s+час(?:а|ов)?\\s+(утра|дня|вечера)(?!${WORD})`, 'gu');
const hourFromWord = (word) => HOUR_WORDS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(word))?.[1] ?? null;

const spokenTimes = (text) => {
  const found = {};
  for (const match of text.matchAll(BARE_HOUR)) {
    const before = text.slice(Math.max(0, match.index - 14), match.index);
    // С предлогом («после 8 часов вечера») разберёт основной шаблон ниже.
    if (/(?:после|позже|раньше|ранее|до|с|к|в|на|около|примерно\s+в)\s+$/u.test(before)) continue;
    let hour = /^\d+$/.test(match[1]) ? Number(match[1]) : hourFromWord(match[1]);
    if (hour === null || hour > 23) continue;
    if ((match[2] === 'вечера' && hour < 12) || (match[2] === 'дня' && hour >= 1 && hour <= 6)) hour += 12;
    found.exact = `${String(hour).padStart(2, '0')}:00`;
  }
  for (const match of text.matchAll(SPOKEN_TIME)) {
    const [, preposition, hourText, minutes = '00', hoursWord, dayPart] = match;
    const digits = /^\d+$/.test(hourText);
    const kind = TIME_KIND.find(([, words]) => new RegExp(`^${words}$`, 'u').test(preposition.replace(/\s+/gu, ' ')))?.[0];
    if (!kind) continue;
    /*
     * Цифры без части суток — забота gateway («после 18»). Кроме числа со
     * словом «час» («к 7 часам») и с «около» («около 18»): их gateway не читает.
     */
    if (digits && !dayPart && !hoursWord && kind !== 'around') continue;
    // «До 2 часов езды» — время в пути, а не часы приёма.
    if (hoursWord && /^\s*(?:езды|пути|в\s+пути|ехать|дороги|на\s+машине|на\s+такси|пешком|ходьбы)/u.test(text.slice(match.index + match[0].length))) continue;
    if (!digits && !dayPart && !hoursWord && !['after', 'before', 'around'].includes(kind)) continue;
    let hour = digits ? Number(hourText) : hourFromWord(hourText);
    if (hour === null || hour > 23 || dayPart === 'ночи') continue;
    if ((dayPart === 'вечера' && hour < 12) || (dayPart === 'дня' && hour >= 1 && hour <= 6)) hour += 12;
    // «Тысячи до четырёх» — цена, а не время.
    if (/тыс\p{L}*\s+$/u.test(text.slice(Math.max(0, match.index - 10), match.index))) continue;
    if (!dayPart && (!digits || hoursWord || kind === 'around')) {
      /*
       * Час словами без части суток: «после шести» — 18:00 (в 6 утра клиники
       * закрыты), а «после семи», «до девяти» — и утро, и вечер: оба прочтения
       * уходят в вопрос «утра или вечера?».
       */
      const evening = /(?<!\p{L})(?:вечер|после\s+работы)/u.test(text);
      const morning = /(?<!\p{L})(?:утр|с\s+утра)/u.test(text);
      const clear = kind === 'after' ? hour <= 6 : kind === 'before' ? hour <= 7 : hour <= 6;
      const doubtful = kind === 'after' ? hour === 7 || hour === 8 : kind === 'before' ? hour === 8 || hour === 9 : hour === 7 || hour === 8;
      if (evening && hour <= 11) hour += 12;
      else if (!morning && clear) hour += 12;
      else if (!morning && doubtful) {
        if (isNegatedBefore(text, match.index) && !/^не\s/u.test(preposition)) continue;
        found.doubtful = found.doubtful || {};
        found.doubtful[kind] = [`${String(hour).padStart(2, '0')}:${minutes}`, `${String(hour + 12).padStart(2, '0')}:${minutes}`];
        continue;
      }
    }
    if (isNegatedBefore(text, match.index) && !/^не\s/u.test(preposition)) continue;
    // «Часов в пять», «в пять примерно» — это «около», а не ровно.
    const approximate = kind === 'exact'
      && (/час\p{L}*\s+$/u.test(text.slice(Math.max(0, match.index - 8), match.index)) || /^[^.!?;]{0,12}(?:примерно|где-?то|ориентировочно|плюс-минус)/u.test(text.slice(match.index + match[0].length)));
    found[approximate ? 'around' : kind] = `${String(hour).padStart(2, '0')}:${minutes}`;
  }
  /*
   * «Нужен ЛОР в 15», «к 9, пожалуйста»: час без «часов» и части суток в конце
   * фразы. «В 8» — и утро, и вечер (вопрос); «в 3» — 15:00 (ночью клиники
   * закрыты); «в 15» — ровно 15:00.
   */
  if (!found.exact && !found.around && !found.doubtful?.exact) {
    for (const match of text.matchAll(BARE_AT)) {
      let hour = Number(match[1]);
      if (hour < 1 || hour > 23 || isNegatedBefore(text, match.index)) continue;
      const evening = /(?<!\p{L})(?:вечер|после\s+работы)/u.test(text);
      const morning = /(?<!\p{L})(?:утр|с\s+утра)/u.test(text);
      if (evening && hour <= 11) hour += 12;
      else if (!morning && hour <= 6) hour += 12;
      else if (!morning && hour >= 7 && hour <= 9) {
        found.doubtful = { ...found.doubtful, exact: [`${String(hour).padStart(2, '0')}:00`, `${hour + 12}:00`] };
        break;
      }
      found.exact = `${String(hour).padStart(2, '0')}:00`;
      break;
    }
  }
  return found;
};
const BARE_AT = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:в|к)\\s+(\\d{1,2})(?![\\d:.,-]\\d|-)(?=\\s*(?:$|[,.!?;)]|(?:и|или|а|но|либо|пожалуйста)(?!\\p{L})|(?:в|во|на)\\s+(?:${WEEKDAY_STEMS}|выходн)|(?:сегодня|завтра|послезавтра)(?!\\p{L})))`,
  'gu',
);

/*
 * Несколько окон через «или»: «с 10 до 12 или после 18», «до 8 утра или
 * после 15:00» — все окна, а не одно и не «с 15:00 до 08:00».
 */
const TIME_TOKEN = `(\\d{1,2}(?::\\d{2})?|${HOUR_WORD})(?:\\s+час(?:а|ов)?)?(?:\\s+(утра|дня|вечера))?(?!\\s*(?:тысяч|тыс|руб|₽|лет|год|мин|км|${MONTHS.join('|')}|числа|-?го\\b))(?![\\d.:])`;
const WINDOW_FORMS = [
  ['between', new RegExp(`(?<!${WORD})(?:с|со)\\s+${TIME_TOKEN}\\s*(?:до|по|[-–—])\\s*${TIME_TOKEN}`, 'gu')],
  ['after', new RegExp(`(?<!${WORD})(?:после|(?<!не\\s)позже|не\\s+раньше|не\\s+ранее)\\s+${TIME_TOKEN}`, 'gu')],
  ['before', new RegExp(`(?<!${WORD})(?:до|не\\s+позже|не\\s+позднее|(?<!не\\s)раньше)\\s+${TIME_TOKEN}`, 'gu')],
  ['exact', new RegExp(`(?<!${WORD})(?:в|на|к)\\s+${TIME_TOKEN}`, 'gu')],
];
const clockOf = (raw, dayPart) => {
  const digits = /^\d/u.test(raw);
  let hour = digits ? Number(raw.split(':')[0]) : hourFromWord(raw);
  const minutes = digits && raw.includes(':') ? raw.split(':')[1] : '00';
  if (hour === null || hour > 23 || Number(minutes) > 59) return null;
  if ((dayPart === 'вечера' && hour < 12) || (dayPart === 'дня' && hour >= 1 && hour <= 6)) hour += 12;
  if (!digits && !dayPart && hour >= 1 && hour <= 7) hour += 12;
  return `${String(hour).padStart(2, '0')}:${minutes}`;
};
/*
 * Прочтения границы «после 7» / «до 9» без части суток — как у gateway:
 * понятное достраивается («после 5» — 17:00, «до 7» — 19:00), а
 * двусмысленное («после 7–8», «до 8–9», «в 7–9») даёт два прочтения.
 */
const boundReadings = (raw, dayPart, kind, clause = '') => {
  const clock = clockOf(raw, dayPart);
  if (!clock || dayPart || !/^\d{1,2}$/u.test(raw)) return clock ? [clock] : [];
  const hour = Number(raw);
  if (hour === 0 || hour >= 12) return [clock];
  const evening = /(?<!\p{L})(?:вечер|после\s+работы)/u.test(clause);
  const morning = /(?<!\p{L})(?:утр|с\s+утра)/u.test(clause);
  const pm = `${hour + 12}:00`;
  if (evening) return [pm];
  if (morning) return [clock];
  const [clear, doubtful] = kind === 'before' ? [hour <= 7, hour === 8 || hour === 9] : kind === 'after' ? [hour <= 6, hour === 7 || hour === 8] : [hour <= 6, hour >= 7 && hour <= 9];
  if (clear) return [pm];
  return doubtful ? [clock, pm] : [clock];
};
const plusMinute = (clock) => {
  const total = Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) + 1;
  return total >= 24 * 60 ? '23:59' : `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};
/*
 * Возвращает окна через «или» (массив) или null. Если одно из окон
 * двусмысленно («с 10 до 12 или после 7»), — { windows, ask }: остальные
 * окна и два прочтения спорного; ассистент спросит «утра или вечера?».
 */
const timeWindowsOf = (text) => {
  const found = [];
  const asWindow = (kind, clock) => (kind === 'after' ? { from: clock, to: null } : kind === 'before' ? { from: null, to: clock } : { from: clock, to: plusMinute(clock) });
  for (const [kind, regex] of WINDOW_FORMS) {
    for (const match of text.matchAll(regex)) {
      // «В 18» без минут и части суток — не время («в 18 лет» отсекается выше, но «в 2 клиники» — нет).
      if (kind === 'exact' && !/[:]/u.test(match[1]) && !match[2] && /^\d/u.test(match[1])) continue;
      let readings = [];
      if (kind === 'between') {
        const pair = combineTimeReadings(boundReadings(match[1], match[2] || match[4], 'after', text), boundReadings(match[3], match[4], 'before', text));
        readings = pair.ambiguity ? pair.ambiguity : pair.from && pair.to ? [{ from: pair.from, to: pair.to }] : [];
      } else {
        readings = boundReadings(match[1], match[2], kind, text).map((clock) => asWindow(kind, clock));
      }
      if (readings.length > 0) found.push({ start: match.index, end: match.index + match[0].length, readings });
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const windows = found.filter((item, position) => !found.slice(0, position).some((other) => other.start <= item.start && other.end >= item.end));
  let chain = [];
  let best = null;
  for (const item of windows) {
    const previous = chain[chain.length - 1];
    // «В 12:00 в четверг, или в 12:30» — день между окнами не разрывает перечисление.
    const gap = text.slice(previous?.end ?? 0, item.start);
    if (previous && new RegExp(`^\\s*(?:(?:в|во|на)\\s+(?:${WEEKDAY_STEMS}|сегодня|завтра|послезавтра)\\s*)?,?\\s*(?:или|либо)\\s+$`, 'u').test(gap)) chain.push(item);
    else {
      if (chain.length > 1) best = chain;
      chain = [item];
    }
  }
  if (chain.length > 1) best = chain;
  if (!best) return null;
  best = best.slice(0, 3);
  const doubtful = best.filter((item) => item.readings.length > 1);
  if (doubtful.length === 0) return best.map((item) => item.readings[0]);
  if (doubtful.length > 1) return null;
  return { windows: best.filter((item) => item.readings.length === 1).map((item) => item.readings[0]), ask: doubtful[0].readings };
};

/** Окно времени одной части фразы: «после 15:30», «только до обеда», «с утра, но не раньше девяти». */
const clauseWindow = (text) => {
  /*
   * pick — какое из двух прочтений двусмысленного часа взять: «после 7» в
   * окне дня — это и 07:00, и 19:00. Если прочтения дают разные окна, день
   * получает вопрос ask, а не молча утро.
   */
  const build = (pick) => {
    let from = null;
    let to = null;
    const tighten = (start, end) => {
      if (start && (!from || start > from)) from = start;
      if (end && (!to || end < to)) to = end;
    };
    const choose = (readings) => readings[Math.min(pick, readings.length - 1)];
    for (const [kind, regex] of WINDOW_FORMS) {
      for (const match of text.matchAll(regex)) {
        if (kind === 'between') {
          const pair = combineTimeReadings(boundReadings(match[1], match[2] || match[4], 'after', text), boundReadings(match[3], match[4], 'before', text));
          const chosen = pair.ambiguity ? pair.ambiguity[Math.min(pick, pair.ambiguity.length - 1)] : pair;
          if (chosen.from && chosen.to) tighten(chosen.from, chosen.to);
          continue;
        }
        if (kind === 'exact' && !/:/u.test(match[1]) && !match[2]) continue;
        const clock = choose(boundReadings(match[1], match[2], kind, text));
        if (!clock) continue;
        if (kind === 'exact') tighten(clock, plusMinute(clock));
        else if (kind === 'after') tighten(clock, null);
        else tighten(null, clock);
      }
    }
    if (/(?<!\p{L})(?:утром|с\s+утра|до\s+обеда|в\s+первой\s+половине\s+дня)(?!\p{L})/u.test(text)) tighten(null, '12:00');
    if (/(?<!\p{L})(?:после\s+обеда|во\s+второй\s+половине\s+дня)(?!\p{L})/u.test(text)) tighten('13:00', null);
    if (/(?<!\p{L})(?:вечером|вечерком|по\s+вечерам)(?!\p{L})/u.test(text)) tighten('17:00', null);
    if (/(?<!\p{L})дн[её]м(?!\p{L})/u.test(text)) tighten('12:00', '17:00');
    return from || to ? { from, to } : null;
  };
  const morning = build(0);
  const evening = build(1);
  if (morning && evening && JSON.stringify(morning) !== JSON.stringify(evening)) return { ask: [morning, evening] };
  return morning;
};

/*
 * Своё время у каждого дня: «в четверг после 15:30, а в пятницу только до
 * обеда» — время одного дня не переносится на другой.
 */
const perDayWindows = (text, { excludeWeekdays = [], excludeDays = [] } = {}) => {
  const raw = [...text.matchAll(LIST_ITEM)].map((match) => {
    return { index: match.index, end: match.index + match[0].length, value: withoutDayOnly(listItemValue(match)) };
  }).filter((item) => !isNegatedBefore(text, item.index));
  // «В пятницу 16 октября» — один день, а не два.
  const mentions = [];
  for (const item of raw) {
    const previous = mentions[mentions.length - 1];
    const pairable = previous && PAIR_JOIN.test(text.slice(previous.end, item.index))
      && [previous.value.kind, item.value.kind].includes('weekday') && previous.value.kind !== item.value.kind;
    if (pairable) {
      const weekday = previous.value.kind === 'weekday' ? previous.value : item.value;
      const other = previous.value.kind === 'weekday' ? item.value : previous.value;
      mentions[mentions.length - 1] = { index: previous.index, end: item.end, value: { ...other, expectWeekday: weekday.weekday } };
    } else mentions.push(item);
  }
  const kept = mentions.filter(({ value }) => !(value.kind === 'weekday' && excludeWeekdays.includes(value.weekday))
    && !excludeDays.some((day) => day.kind === value.kind && day.kind !== 'date'));
  const withWindows = kept.map((item, position) => {
    const next = kept[position + 1]?.index ?? text.length;
    let clause = text.slice(item.end, next);
    const stop = clause.search(/[.!?;]/u);
    if (stop >= 0) clause = clause.slice(0, stop);
    const window = clauseWindow(clause);
    return { ...item, clause, window: window?.ask ? null : window, ask: window?.ask || null };
  });
  /*
   * «В понедельник и среду до 15»: дни через «и», «или», запятую делят одно
   * окно — то, что сказано после последнего из них.
   */
  for (let position = withWindows.length - 2; position >= 0; position -= 1) {
    if (!withWindows[position].window && !withWindows[position].ask && /^\s*(?:,|и|или|либо)?\s*(?:в|во)?\s*$/u.test(withWindows[position].clause)) {
      withWindows[position] = { ...withWindows[position], window: withWindows[position + 1].window, ask: withWindows[position + 1].ask };
    }
  }
  /*
   * «Работаю посменно: в понедельник до 15, во вторник после 14» — это часы
   * работы, а прийти можно в остальное время: после 15 и до 14.
   */
  const busyPrefix = new RegExp(`(?<!${WORD})(?:работаю|на\\s+работе|смен\\p{L}*|занят\\p{L}?|учусь)(?!${WORD})`, 'u').test(text.slice(0, withWindows[0]?.index ?? 0));
  if (busyPrefix) {
    // Только дни из того же предложения: «…Нужен хирург, лучше в пятницу утром» — уже не часы работы.
    const sentence = text.slice(withWindows[0].index).search(/[.!?;]/u);
    const sentenceEnd = sentence >= 0 ? withWindows[0].index + sentence : text.length;
    for (const [position, item] of withWindows.entries()) {
      if (!item.window || item.index > sentenceEnd || /свобод|могу|удобно|можно/u.test(item.clause.split(',')[0])) continue;
      const { from, to } = item.window;
      withWindows[position] = { ...item, window: from && to ? null : from ? { from: null, to: from } : { from: to, to: null } };
    }
  }
  const windowed = withWindows.filter((item) => item.window || item.ask);
  if (windowed.length < 2 || new Set(windowed.map((item) => JSON.stringify(item.window || item.ask))).size < 2) return null;
  // Один и тот же день дважды («пятница свободна… лучше в пятницу утром») — один раз, первое упоминание.
  const unique = withWindows.filter((item, position) => withWindows.findIndex((other) => JSON.stringify(other.value) === JSON.stringify(item.value)) === position);
  // ask — «завтра после 7»: у дня два прочтения, ассистент спросит «утра или вечера?».
  return unique.slice(0, 7).map(({ value, window, ask }) => ({ ...value, ...(window ? { from: window.from, to: window.to } : {}), ...(ask ? { ask } : {}) }));
};

/**
 * Согласует прочтения границ времени: «с 7 до 9» — утро с утром или вечер с
 * вечером; «с 8 до 10» — только утро («до 10» не читается как 22:00).
 * Одно прочтение — {from, to}; два — {ambiguity: [утро, вечер]}.
 */
export const combineTimeReadings = (afterReadings, beforeReadings) => {
  const pairs = [];
  for (const [afterIndex, from] of afterReadings.entries()) {
    for (const [beforeIndex, to] of beforeReadings.entries()) {
      if (afterReadings.length > 1 && beforeReadings.length > 1 && afterIndex !== beforeIndex) continue;
      if (from && to && from >= to) continue;
      if ((from && from >= '22:00') || (to && to > '22:00' && from)) continue;
      pairs.push({ from, to });
    }
  }
  const unique = [...new Map(pairs.map((pair) => [`${pair.from}|${pair.to}`, pair])).values()];
  if (unique.length === 1) return unique[0];
  // Противоречие («после 18 до 10») — как сказано: его покажет подбор.
  if (unique.length === 0) return { from: afterReadings[0] || null, to: beforeReadings[0] || null };
  return { ambiguity: unique.slice(0, 2) };
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
  { pattern: new RegExp(`(?<!${WORD})(?:чистк\\p{L}*\\s+зуб\\p{L}*|почистить\\s+зуб\\p{L}*|(?:проф\\p{L}*\\s+)?гигиен\\p{L}*\\s+(?:полости\\s+рта|зуб\\p{L}*)|профгигиен\\p{L}*)`, 'u'), value: { serviceId: 'proc.dentist.hygiene', specialty: 'dentist' } },
  { pattern: new RegExp(`(?<!${WORD})(?:дерматоскоп\\p{L}*|(?:проверить|посмотреть|осмотр\\p{L}*)\\s+родинк\\p{L}*)`, 'u'), value: { serviceId: 'proc.dermatologist.dermatoscopy', specialty: 'dermatologist' } },
  { pattern: new RegExp(`(?<!${WORD})промыв\\p{L}*\\s+миндалин`, 'u'), value: { serviceId: 'proc.lor.tonsils', specialty: 'lor' } },
  { pattern: new RegExp(`(?<!${WORD})узи(?!${WORD})(?=.*(?:малого\\s+таза|гинеколог|матк|яичник))|(?:гинеколог\\p{L}*.*(?<!${WORD})узи(?!${WORD}))`, 'u'), value: { serviceId: 'proc.gynecologist.ultrasound', specialty: 'gynecologist' } },
];

/* ----------------------------- Район ----------------------------------- */

/*
 * «В Вахитовском или Приволжском районе», «кроме Советского района». Слово
 * «район» обязательно: «Московский проспект» — улица, а «в Москве» — город
 * (см. CITY_PATTERNS). «В центре» — Вахитовский район: так и пишется в понятых
 * условиях.
 */
const DISTRICT_STEMS = [
  ['авиастроительн', 'Авиастроительный'], ['вахитовск', 'Вахитовский'], ['кировск', 'Кировский'], ['московск', 'Московский'],
  ['ново-?савиновск', 'Ново-Савиновский'], ['приволжск', 'Приволжский'], ['советск', 'Советский'],
];
const DISTRICT_WORD = new RegExp(`(?<!${WORD})(${DISTRICT_STEMS.map(([stem]) => stem).join('|')})\\p{L}*(?=[^.!?;]{0,60}?(?<!${WORD})(?:район|р-н))`, 'gu');
/*
 * «В Приволжском» без слова «район» — если дальше не другое существительное
 * («на Московском проспекте» — улица).
 */
const DISTRICT_BARE = new RegExp(
  `(?<!${WORD})(?:в|во)\\s+(${DISTRICT_STEMS.map(([stem]) => stem).join('|')})(?:ом|ем)(?=\\s*(?:$|[,.;!?)]|\\s+(?:и|или|а|но|либо|на|в|во|с|со|после|до|завтра|сегодня|послезавтра|утром|вечером|дн[её]м|не|по|к|у)(?!${WORD})))`,
  'gu',
);
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
  // «Кроме Советского», «только не Приволжского» — без слова «район».
  for (const match of text.matchAll(new RegExp(`(?<!${WORD})(?:кроме|исключая)\\s+(${DISTRICT_STEMS.map(([stem]) => stem).join('|')})(?:ого|его)(?!${WORD})`, 'gu'))) {
    exclude.push(DISTRICT_STEMS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(match[1]))[1]);
  }
  for (const match of text.matchAll(DISTRICT_BARE)) {
    const name = DISTRICT_STEMS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(match[1]))[1];
    const before = text.slice(Math.max(0, match.index - 24), match.index + 3);
    (DISTRICT_EXCLUDED_BEFORE.test(text.slice(Math.max(0, match.index - 24), match.index)) || /не\s+(?:в|во)\s*$/u.test(before) ? exclude : include).push(name);
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
/* «Обязательно женщина», «а женщина есть?», «есть ли врач-мужчина» — условие о враче. */
const bareGenderPatterns = (stem, value) => [
  new RegExp(`(?<!${WORD})(?:обязательно|только|строго|непременно)\\s+(?:чтобы\\s+)?(?:был\\p{L}*\\s+)?${stem}[ауы]?(?!${WORD})`, 'u'),
  new RegExp(`(?<!${WORD})(?:а\\s+)?(?:врач\\p{L}*[-\\s]+)?${stem}[аы]?\\s+(?:есть|бывает|найд[её]тся|принимает)(?!${WORD})`, 'u'),
  new RegExp(`(?<!${WORD})есть\\s+(?:ли\\s+)?(?:врач\\p{L}*[-\\s]+)?${stem}[аы]?(?!${WORD})`, 'u'),
].map((pattern) => ({ pattern, value }));
const GENDER_PATTERNS = [
  ...genderPatterns('женщин', 'женского', 'female'), ...genderPatterns('мужчин', 'мужского', 'male'),
  ...bareGenderPatterns('женщин', 'female'), ...bareGenderPatterns('мужчин', 'male'),
];

/* ------------------------------ Стаж ------------------------------------ */

/* «С опытом больше 15 лет» — строго больше: от 16; «стаж от 10 лет» — от 10. */
const YEARS_WORD = '(пяти|пять|десяти|десять|пятнадцати|пятнадцать|двадцати\\s+пяти|двадцать\\s+пять|двадцати|двадцать|тридцати|тридцать)';
const yearsFromWord = (word) => ({
  пяти: 5, пять: 5, десяти: 10, десять: 10, пятнадцати: 15, пятнадцать: 15, двадцати: 20, двадцать: 20, тридцати: 30, тридцать: 30,
}[word] ?? (/^двадцат\p{L}*\s+пят/u.test(word) ? 25 : null));

const EXPERIENCE_PATTERNS = [
  // «с опытом лет 15» — примерно от 15
  {
    pattern: new RegExp(`(?<!${WORD})(?:опыт|стаж)\\p{L}*\\s+(?:работы\\s+)?(?:от\\s+)?лет\\s+(\\d{1,2})(?!\\d)`, 'u'),
    value: (match) => Number(match[1]),
  },
  // «стаж от десяти лет», «опыт не меньше двадцати пяти лет» — словами
  {
    pattern: new RegExp(`(?<!${WORD})(?:опыт|стаж)\\p{L}*\\s+(?:работы\\s+)?(?:(больше|более|свыше)|от|не\\s+меньше|не\\s+менее|минимум|как\\s+минимум|хотя\\s+бы)?\\s*(?:лет\\s+)?${YEARS_WORD}(?:\\s+(?:лет|года?))?(?!${WORD})`, 'u'),
    value: (match) => (yearsFromWord(match[2].replace(/\s+/gu, ' ')) ?? 0) + (match[1] ? 1 : 0) || null,
  },
  {
    pattern: new RegExp(`(?<!${WORD})(?:опыт|стаж)\\p{L}*\\s+(?:работы\\s+)?(?:(больше|более|свыше)|от|не\\s+меньше|не\\s+менее|минимум|как\\s+минимум|хотя\\s+бы)?\\s*(\\d{1,2})\\s*\\+?\\s*(?:лет|года?)(?!${WORD})`, 'u'),
    value: (match) => Number(match[2]) + (match[1] ? 1 : 0),
  },
  {
    pattern: new RegExp(`(?<!${WORD})(?:(больше|более|свыше)|от|не\\s+меньше|не\\s+менее|минимум)\\s+(\\d{1,2})\\s*(?:лет|года?)\\s+(?:опыт|стаж|практик)\\p{L}*`, 'u'),
    value: (match) => Number(match[2]) + (match[1] ? 1 : 0),
  },
  // «Со стажем от 20,» — без слова «лет», но с явным «от/больше».
  {
    pattern: new RegExp(`(?<!${WORD})(?:опыт|стаж)\\p{L}*\\s+(?:работы\\s+)?(?:(больше|более|свыше)|от|не\\s+меньше|не\\s+менее|минимум|хотя\\s+бы)\\s+(\\d{1,2})(?![\\d:.])(?!\\s*(?:тыс|руб|₽|мин|час|лет|год))`, 'u'),
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
  /*
   * Возраст врача в демо-наборе не указан (есть только стаж): «хирурга,
   * которому больше 50 лет», «врача постарше», «молодого доктора». Возраст
   * пациента («ребёнку 10 лет», «маме 67») сюда не относится.
   */
  ['doctor_age', new RegExp(
    `(?<!${WORD})${DOCTOR_NOUN}[\\s,]+(?:котор(?:ому|ой|ый|ая|ым)|чтобы\\s+(?:ему|ей)\\s+было|чей\\s+возраст)\\s+(?:уже\\s+|было\\s+)?(?:больше|более|меньше|менее|старше|моложе|за|под|около|не\\s+(?:меньше|больше|менее|более|старше|моложе))?\\s*\\d{2}`
    + `|(?<!${WORD})(?:молод|пожил|возрастн)\\p{L}*\\s+${DOCTOR_NOUN}`
    + `|(?<!${WORD})${DOCTOR_NOUN}\\s+(?:(?:был\\p{L}*|будет)\\s+)?(?:постарше|помоложе|в\\s+возрасте|пожил\\p{L}*|(?:не\\s+)?(?:старше|моложе)\\s+\\d{2})`
    + `|(?<!${WORD})возраст\\p{L}*\\s+(?:врача|доктора)`,
    'u',
  )],
  // Несколько пациентов подряд («двойня», «два слота подряд») — подбор ищет одну запись.
  ['multi_patient', new RegExp(`(?<!${WORD})(?:дв(?:а|ух)\\s+(?:слот|талон|запис|при[её]м)\\p{L}*\\s+(?:подряд|сразу|одновременно)|(?:подряд|сразу)\\s+дв(?:а|е|ух)\\s+(?:слот|талон|запис|при[её]м)\\p{L}*|двойн\\p{L}*|близнец\\p{L}*|двоих\\s+детей|на\\s+двоих|обоих\\s+детей|всей\\s+семь[её]й`
    // «Запишите меня и мужа», «нас с мамой на одно время» — два пациента.
    + `|(?:меня|нас)\\s+(?:и|с)\\s+(?:мужа|мужем|жену|женой|сына|сыном|дочь|дочку|дочкой|маму|мамой|папу|папой|ребенка|ребенком|детей|детьми|бабушку|дедушку|подругу|друга)(?!${WORD})|на\\s+одно\\s+(?:и\\s+то\\s+же\\s+)?время|на\\s+обоих|нас\\s+двоих|нас\\s+троих)`, 'u')],
  // Справка (в бассейн, на работу, водительская) — отдельная услуга, которой в демо-наборе нет.
  ['certificate', new RegExp(`(?<!${WORD})(?:справк\\p{L}*|медкомисси\\p{L}*|медосмотр\\p{L}*|санаторно-курортн\\p{L}*\\s+карт\\p{L}*|больничн(?:ый|ого)\\s+лист\\p{L}*)`, 'u')],
  // Анонимный приём — порядок клиники, которого демо-набор не знает.
  ['anonymous', new RegExp(`(?<!${WORD})(?:анонимн\\p{L}*|без\\s+(?:паспорта|документов)|не\\s+называя\\s+(?:имени|фамилии))`, 'u')],
];

/*
 * Согласие на замену заранее: «по ОМС, а если нельзя — то платно», «на
 * дом, а если нет — приеду сам». Тогда условие, которого в демо нет, не
 * блокирует подбор: ищется то, на что человек согласился, и это видно в
 * понятых условиях.
 */
const FALLBACK_LEAD = '(?:если|или|либо|можно\\s+(?:и\\s+)?|в\\s+крайнем\\s+случае|на\\s+худой\\s+конец)';
const PAID_WORD = `(?<!${WORD})(?:платн\\p{L}*|за\\s+деньги|за\\s+свой\\s+сч[её]т)`;
const IN_PERSON_WORD = `(?<!${WORD})(?:очно|очн\\p{L}*\\s+при[её]м\\p{L}*|в\\s+клинику|в\\s+клинике|сам\\p{L}*\\s+(?:приеду|приду|доеду|дойду|привезу|приведу)|приед(?:у|ем)|прид(?:у|ем)|привез(?:у|ём|ем))`;
const PAID_FALLBACK = new RegExp(`${FALLBACK_LEAD}[^.!?]{0,40}?${PAID_WORD}`, 'u');
const IN_PERSON_FALLBACK = new RegExp(`${FALLBACK_LEAD}[^.!?]{0,40}?${IN_PERSON_WORD}`, 'u');
/* В следующей реплике — без «если»: «ладно, давайте платно», «хорошо, приеду сам». */
const PAID_LATER = new RegExp(PAID_WORD, 'u');
const IN_PERSON_LATER = new RegExp(`(?<!${WORD})(?:очно|очн\\p{L}*\\s+при[её]м\\p{L}*|сам\\p{L}*\\s+(?:приеду|приду|доеду|дойду|привезу|приведу)|приед(?:у|ем)\\s+сам\\p{L}*|(?:можно|давай(?:те)?|ладно,?|хорошо,?)\\s+в\\s+клинику)`, 'u');
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
const NEAR = '(?:рядом\\s+с(?:о)?|возле|около|недалеко\\s+от|поблизости\\s+от|неподал[её]ку\\s+от|(?:по)?ближе\\s+к)';
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

/*
 * «Работаю в центре до 18:00, живу на Азино» — рассказ о себе: место не
 * становится ни районом, ни точкой отправления (а «работаю … до 18:00» —
 * по-прежнему «после 18:00»). Если при этом просят «поближе», точка — дом
 * (или работа), и подбор спросит, где это.
 */
const SELF_PLACE = new RegExp(
  `(?<!${WORD})(живу|проживаю|работаю|учусь|прописан\\p{L}*|у\\s+меня\\s+офис|офис\\s+у\\s+меня)\\s+`
  + `((?:в|во|на|около|возле|рядом\\s+с(?:о)?|недалеко\\s+от|у)\\s+(?:сам\\p{L}*\\s+|район\\p{L}*\\s+|микрорайон\\p{L}*\\s+|улиц\\p{L}*\\s+)?(?!казан)[\\p{L}-]{2,}`
  + `(?:\\s+район\\p{L}*)?)`,
  'gu',
);
const maskSelfPlaces = (text) => {
  let home = false;
  let work = false;
  const masked = text.replace(SELF_PLACE, (whole, verb, place) => {
    if (/^(?:живу|проживаю|прописан)/u.test(verb)) home = true;
    else work = true;
    return `${whole.slice(0, whole.length - place.length)}${' '.repeat(place.length)}`;
  });
  return { masked, home, work };
};

/* «Не раньше чем через час», «через пару часов», «через полчаса» — от текущего времени. */
const AFTER_HOURS = new RegExp(
  `(?<!${WORD})через\\s+(?:(полчаса)|(полтора)\\s+часа|(?:(\\d{1,2}|пару|два|три|четыре|пять)\\s+)?час(?:а|ов)?)(?!${WORD})(?!\\s+(?:езды|пути|ходьбы|на\\s+машине|пешком|на\\s+такси|на\\s+автобусе))`,
  'u',
);

/* «У кого стаж побольше», «самого опытного», «поопытнее» — опытные первыми (не условие). */
const PREFER_EXPERIENCE = new RegExp(
  `(?<!${WORD})(?:(?:стаж|опыт)\\p{L}*\\s+(?:побольше|больше(?=\\s*(?:$|[,.;!?)]|(?:и|а|но|у|в|на|неважно|не)(?!\\p{L}))))|(?:с\\s+)?(?:большим|наибольшим|максимальным|самым\\s+большим)\\s+(?:стажем|опытом)|(?:самого|самый|самую|более|по)?\\s*опытн\\p{L}*\\s+${DOCTOR_NOUN}|поопытнее|с\\s+опытом\\s+побольше|(?:врач\\p{L}*|доктор\\p{L}*)\\s+(?:со\\s+стажем|с\\s+опытом)(?!\\s+(?:от|не|больше|более|свыше|минимум|хотя|лет|\\d)))`,
  'u',
);

/* «Записаться», «запишите», «попасть к» — человек просит запись, а не маршрут. */
const BOOKING_INTENT = new RegExp(`(?<!${WORD})(?:запис\\p{L}*|запиш\\p{L}*|попасть\\s+(?:к|на)|на\\s+при[её]м)`, 'u');

/* ----------------------------- Главное --------------------------------- */

/**
 * @param {string} text реплика пользователя
 * @returns {{date?: object|null, maxPrice?: number|null, city?: string, dms?: boolean,
 *   visit?: string, timeAny?: true, travelAny?: true}} основные поля; кроме них —
 *   флаги и пожелания, которые сводит mergeBookingTurns
 */
export const extractBookingConstraints = (text, { nested = false } = {}) => {
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
  /* Диапазон дат важнее отдельной даты внутри него («с 15 по 17 октября»). */
  const range = dateRange(lower);
  if (range && !isNegatedBefore(lower, range.index)) result.date = range.value;
  const nextDays = NEXT_DAYS.exec(lower);
  if (nextDays && !range) {
    const days = nextDays[2] ? 7 : /^\d+$/u.test(nextDays[1]) ? Number(nextDays[1]) : NEXT_DAYS_WORDS[nextDays[1]];
    if (days >= 1 && days <= 14) result.date = { kind: 'next_days', days };
  }
  /*
   * «В любой день этой недели», «на следующей неделе в любой день» —
   * любой день, но этой (следующей) недели, а не любой вообще.
   */
  if (result.date === null) {
    const week = new RegExp(`(?<!${WORD})(?:на\\s+)?(?:(этой|текущей)|(следующей|будущей))\\s+недел\\p{L}*`, 'u').exec(lower);
    if (week) result.date = { kind: week[1] ? 'this_week' : 'next_week' };
  }
  const excluded = excludedDays(lower);
  if (excluded.length > 0) {
    result.excludeDays = excluded;
    const isExcluded = (value) => excluded.some((item) => item.kind === value.kind && (item.kind !== 'date' || (item.dayOfMonth === value.dayOfMonth && item.month === value.month)));
    if (result.date && isExcluded(result.date)) delete result.date;
    if (result.date?.kind === 'any_of') {
      const options = result.date.options.filter((option) => !isExcluded(option));
      result.date = options.length > 1 ? { kind: 'any_of', options } : options[0];
      if (!result.date) delete result.date;
    }
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
  // «В среду не можем — кружок», «в пятницу я занят» — тоже исключение дня.
  for (const match of lower.matchAll(new RegExp(`(?<!${WORD})(?:в|во)\\s+(${WEEKDAY_STEMS})\\s*,?\\s+(?:я\\s+|мы\\s+|у\\s+нас\\s+|у\\s+меня\\s+)?(?:не\\s+(?:могу|можем|сможем|смогу|получится|выйдет|подходит|успеваем|успею|удобно)|занят\\p{L}*|никак)(?!${WORD})`, 'gu'))) {
    excludeWeekdays.add(WEEKDAY_FORMS.find(([form]) => form === match[1])[1]);
  }
  if (excludeWeekdays.size > 0) {
    result.excludeWeekdays = [...excludeWeekdays].sort();
    // «Кроме субботы» — не «в выходные»: слово «суббота» здесь исключает день.
    if ([...excludeWeekdays].some((day) => day >= 6) && !new RegExp(`(?<!${WORD})(?:в|на)\\s+(?:эти\\s+|ближайшие\\s+)?выходн`, 'u').test(lower)) result.suppressWeekend = true;
    // «Не в понедельник» — не выбор понедельника: если день взят из этого же отрицания, его нет.
    if (result.date?.kind === 'weekday' && excludeWeekdays.has(result.date.weekday)) delete result.date;
    if (result.date?.kind === 'any_of') {
      const options = result.date.options.filter((option) => option.kind !== 'weekday' || !excludeWeekdays.has(option.weekday));
      result.date = options.length > 1 ? { ...result.date, options } : options[0];
      if (!result.date) delete result.date;
    }
  }

  /* «В эту субботу или в следующую» — две субботы, а не одна. */
  const twoWeeks = new RegExp(`(?<!${WORD})(?:в|на)\\s+(?:эт\\p{L}*|ближайш\\p{L}*)\\s+(${WEEKDAY_STEMS})\\s+или\\s+(?:в|на)\\s+следующ\\p{L}*(?!\\s+(?:${WEEKDAY_STEMS}|недел))`, 'u').exec(lower);
  if (twoWeeks) {
    const weekday = WEEKDAY_FORMS.find(([form]) => form === twoWeeks[1])[1];
    result.date = { kind: 'any_of', options: [{ kind: 'weekday', weekday, week: 'this' }, { kind: 'weekday', weekday, week: 'next' }] };
  }

  /* Точное время («на 17:30», «в 9:00») и «около 17:30» (±30 минут). «На 15.10» — дата, а не время. */
  const around = /(?<![\p{L}\p{N}])(?:около|примерно\s+в|где-?то\s+в|часов\s+в|в\s+районе|ориентировочно\s+в)\s+(\d{1,2}):(\d{2})(?![\d])/u.exec(lower);
  const exact = /(?<![\p{L}\p{N}])(?:на|в|к)\s+(\d{1,2}):(\d{2})(?![\d.:])(?!\s*(?:мин|руб|₽|тыс))/u.exec(lower);
  const asTime = (hours, minutes) => (Number(hours) <= 23 && Number(minutes) <= 59 ? `${String(Number(hours)).padStart(2, '0')}:${minutes}` : null);
  if (around && asTime(around[1], around[2])) result.timeAround = asTime(around[1], around[2]);
  else if (exact && asTime(exact[1], exact[2]) && !isNegatedBefore(lower, exact.index)) result.timeExact = asTime(exact[1], exact[2]);

  /*
   * «На следующей неделе в понедельник» — понедельник следующей недели, а
   * не ближайший; «на этой неделе в пятницу» — этой.
   */
  const weekWord = new RegExp(`(?<!${WORD})(?:на\\s+)?(следующ|будущ|эт|текущ)\\p{L}*\\s+недел\\p{L}*`, 'u').exec(lower);
  // «В понедельник на следующей неделе»: неделя названа после дня — день недели всё равно важен.
  if (weekWord && (result.date?.kind === 'next_week' || result.date?.kind === 'this_week')) {
    // «Во вторник или в среду на следующей неделе» — оба дня, а не только последний.
    const weekdayList = lastDateList(lower);
    const weekdayEntry = lastAffirmedEntry(lower, DATE_PATTERNS.filter((entry) => entry.weekday));
    if (weekdayList && weekdayList.options.every((option) => option.kind === 'weekday')) result.date = { kind: 'any_of', options: weekdayList.options };
    else if (weekdayEntry) result.date = weekdayEntry.value;
  }
  const weekdayDate = result.date && (result.date.kind === 'weekday' || (result.date.kind === 'any_of' && result.date.options.every((option) => option.kind === 'weekday')));
  if (weekWord && weekdayDate) {
    const week = /^(?:следующ|будущ)/u.test(weekWord[1]) ? 'next' : 'this';
    result.date = result.date.kind === 'weekday'
      ? { ...result.date, week }
      : { kind: 'any_of', options: result.date.options.map((option) => ({ ...option, week })) };
  }

  if (new RegExp(`(?<!${WORD})(?:в|на)\\s+(?:эти\\s+|ближайшие\\s+)?выходн`, 'u').test(lower)) result.explicitWeekend = true;
  const workdays = WORKDAYS.exec(lower);
  // «Не в выходные» само содержит «не» — это и есть будни.
  if (workdays && (/^(?:не|кроме|без)\s/u.test(workdays[0]) || !isNegatedBefore(lower, workdays.index))) {
    result.workdays = true;
    result.suppressWeekend = true;
  }

  const self = maskSelfPlaces(lower);
  const districts = extractDistricts(self.masked);
  if (districts.include.length > 0) result.districts = districts.include;
  if (districts.exclude.length > 0) result.excludeDistricts = districts.exclude;
  if (/(?<![\p{L}])(?:в\s+любом\s+районе|район\s+(?:не\s+важен|неважен|любой))/u.test(lower)) result.districtAny = true;
  /*
   * «В Советском районе, но если там никого — можно Приволжский», «…если
   * там нет — то любой район»: названный район — пожелание (такие первыми),
   * а запасной расширяет поиск.
   */
  if (districts.include.length > 0) {
    const fallback = new RegExp(
      `(?<!${WORD})(?:если|а\\s+если)\\s+(?:там\\s+|в\\s+н[её]м\\s+)?(?:нет|никого|не\\s+будет|не\\s+найд\\p{L}*|пусто)[^.!?]{0,25}?(?:можно|то|тогда|давайте?)?\\s*(?:и\\s+)?(?:в\\s+)?`
      + `(?:(любой|любом|другой|другом)\\s+район\\p{L}*|(${DISTRICT_STEMS.map(([stem]) => stem).join('|')})\\p{L}*)`,
      'u',
    ).exec(lower);
    if (fallback) {
      result.preferDistricts = districts.include;
      if (fallback[1]) {
        delete result.districts;
        result.districtAny = true;
      } else {
        const extra = DISTRICT_STEMS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(fallback[2]))[1];
        result.districts = [...new Set([...districts.include, extra])];
      }
    }
  }
  /* «А на Ново-Савиновском филиале?» — филиал в этом районе. */
  const branchDistrict = new RegExp(`(?<!${WORD})(?:на|в|во)\\s+(${DISTRICT_STEMS.map(([stem]) => stem).join('|')})(?:ом|ем)\\s+филиал\\p{L}*`, 'u').exec(lower);
  if (branchDistrict && !result.districts) result.districts = [DISTRICT_STEMS.find(([stem]) => new RegExp(`^${stem}`, 'u').test(branchDistrict[1]))[1]];

  // «Не хочу к врачу-женщине», «только не мужчина» — врач другого пола: в справочнике их два.
  let negatedGender = null;
  for (const { pattern, value } of GENDER_PATTERNS) {
    const match = new RegExp(pattern.source, 'u').exec(lower);
    if (match && (isNegatedBefore(lower, match.index) || /(?<!\p{L})не\s+(?:хочу|надо|нужно|нужен|нужна|желательно)\s+(?:к\s+|чтобы\s+)?(?:врач\p{L}*[-\s]+)?$/u.test(lower.slice(Math.max(0, match.index - 30), match.index)))) {
      negatedGender = value === 'female' ? 'male' : 'female';
    }
  }
  const genderEntry = lastAffirmedEntry(lower, GENDER_PATTERNS);
  if (genderEntry) {
    // «Желательно женщина», «лучше бы врач-женщина» — пожелание, а не условие.
    const soft = /(?<!\p{L})(?:желательно|предпочтительно|по\s+возможности|лучше(?:\s+бы)?|если\s+можно|хорошо\s+бы)[^.!?;]{0,25}$/u.test(lower.slice(Math.max(0, genderEntry.index - 30), genderEntry.index))
      || /^[^.!?;]{0,25}(?<!\p{L})(?:желательно|по\s+возможности|если\s+можно|если\s+получится)/u.test(lower.slice(genderEntry.index, genderEntry.index + 45));
    if (soft) result.preferGender = genderEntry.value;
    else result.doctorGender = genderEntry.value;
  }
  if (negatedGender && !result.doctorGender && !result.preferGender) result.doctorGender = negatedGender;
  // «Желательно женщина» без слова «врач» рядом — тоже о враче: пациент так о себе не пишет.
  if (!genderEntry) {
    const softBare = /(?<!\p{L})(?:желательно|предпочтительно|по\s+возможности|лучше(?:\s+бы)?)\s*,?\s*(?:чтобы\s+)?(?:был[аи]?\s+)?(женщин|мужчин)[ауы]?(?!\p{L})/u.exec(lower);
    if (softBare) result.preferGender = softBare[1] === 'женщин' ? 'female' : 'male';
  }
  /*
   * «К женщине, но если женщин нет — можно и к мужчине»: «женщина» —
   * пожелание, а не условие и не «к мужчине».
   */
  const genderFallback = /(?<!\p{L})(?:если|а\s+если)\s+(?:\p{L}+\s+){0,2}?(?:врач\p{L}*[-\s]+)?(женщин|мужчин)\p{L}*\s+(?:нет|не\s+будет|не\s+найд\p{L}*|никого|не\s+окажется|не\s+принима\p{L}*)/u.exec(lower);
  const genderAllowed = /(?<!\p{L})(?:(?:но|а|или|да,?|ладно,?|хорошо,?|ок,?)\s+)?(?:можно|давай(?:те)?|пусть)\s+(?:и\s+)?(?:к\s+)?(?:врач\p{L}*[-\s]+)?(мужчин|женщин)\p{L}*|(?<!\p{L})(мужчин|женщин)\p{L}*\s+тоже\s+(?:можно|подойд\p{L}*|пойд\p{L}*|нормально)/u.exec(lower);
  if (genderFallback) {
    delete result.doctorGender;
    result.preferGender = genderFallback[1] === 'женщин' ? 'female' : 'male';
  } else if (genderAllowed) {
    /*
     * «Лучше женщина, но можно и мужчина» — пожелание «женщина»; «да, можно и
     * к мужчине» отдельной репликой — согласие снять прежнее «только женщина».
     */
    const allowed = (genderAllowed[1] || genderAllowed[2]) === 'женщин' ? 'female' : 'male';
    const rest = `${lower.slice(0, genderAllowed.index)} ${lower.slice(genderAllowed.index + genderAllowed[0].length)}`;
    const other = lastAffirmed(rest, GENDER_PATTERNS) || (/(?<!\p{L})(?:лучше|желательно)[\s,]+(?:чтобы\s+)?(?:был[аи]?\s+)?(женщин|мужчин)/u.exec(rest)?.[1] === 'женщин' ? 'female'
      : /(?<!\p{L})(?:лучше|желательно)[\s,]+(?:чтобы\s+)?(?:был[аи]?\s+)?мужчин/u.test(rest) ? 'male' : null);
    delete result.doctorGender;
    delete result.preferGender;
    if (other && other !== allowed) result.preferGender = other;
    else result.genderAlsoOk = allowed;
  }
  /*
   * Короткая реплика в диалоге — «мужчина», «лучше женщину», «а вот мужчина
   * обязательно»: о враче (пациент о себе так отдельной репликой не пишет).
   */
  if (!result.doctorGender && !result.preferGender && !result.genderAlsoOk) {
    const bare = /^[\s,.!?]*(?:(?:а|и|да|ну|вот|только|нет,?)\s+)*(?:(лучше|желательно|предпочтительно)\s+)?(?:врач\p{L}*[-\s]+)?(?:к\s+)?(мужчин|женщин)\p{L}*(?:\s+(?:обязательно|только|строго|нужн\p{L}*))?[\s,.!?]*$/u.exec(lower);
    if (bare) result[bare[1] ? 'preferGender' : 'doctorGender'] = bare[2] === 'женщин' ? 'female' : 'male';
  }
  if (/(?<![\p{L}])пол\s+врача\s+(?:не\s+важен|неважен)|(?:неважно|не\s+важно|без\s+разницы)[,\s]+(?:мужчина\s+или\s+женщина|женщина\s+или\s+мужчина)/u.test(lower)) result.genderAny = true;
  // «Дерматолог-женщина или мужчина — неважно»: названы оба пола — это не условие.
  const bothGenders = /(?<!\p{L})(женщин|мужчин)\p{L}*\s+или\s+(?:врач\p{L}*[-\s]+)?(женщин|мужчин)\p{L}*/u.exec(lower);
  if (bothGenders && bothGenders[1] !== bothGenders[2]) {
    result.genderAny = true;
    delete result.doctorGender;
    delete result.preferGender;
    delete result.genderAlsoOk;
  }

  const experienceEntry = lastAffirmedEntry(lower, EXPERIENCE_PATTERNS);
  const experience = experienceEntry?.value;
  if (Number.isInteger(experience) && experience >= 1 && experience <= 60) {
    // «Лучше со стажем от 20», «желательно опыт от 10 лет» — пожелание: такие первыми, остальные остаются.
    const soft = /(?<!\p{L})(?:лучше|желательно|предпочтительно|по\s+возможности|хорошо\s+бы|если\s+можно)[\s,]+(?:\p{L}+\s+){0,2}$/u.test(lower.slice(Math.max(0, experienceEntry.index - 30), experienceEntry.index));
    result[soft ? 'preferMinExperience' : 'minExperience'] = experience;
  }

  const unsupported = UNSUPPORTED_PATTERNS
    .filter(([key, pattern]) => {
      const match = pattern.exec(lower);
      // «Только не к молодым врачам» — тоже условие на возраст врача, а не его снятие.
      return match && (key === 'doctor_age' || !isNegatedBefore(lower, match.index)) && !NOT_NEEDED_AFTER.test(lower.slice(match.index + match[0].length));
    })
    .map(([key]) => key);
  /*
   * «Гастроэнтеролог, желательно мужчина, не старше 40 лет» — возраст без
   * слова «врач» рядом. Если рядом пациент («ребёнку», «маме», «мне») — это о нём.
   */
  if (!unsupported.includes('doctor_age')) {
    for (const match of lower.matchAll(new RegExp(`(?<!${WORD})(?:не\\s+)?(?:старше|моложе)\\s+(\\d{2})\\s*(?:лет|года?)(?!${WORD})`, 'gu'))) {
      const before = lower.slice(Math.max(0, match.index - 30), match.index);
      const patient = /(?<!\p{L})(?:реб[её]н|сын|доч|мам|пап|бабуш|дедуш|муж(?:у|а|ем|е)?(?!\p{L})|жен[аеуы](?!\p{L})|внук|внуч|подрост|пациент|мне|мой|моя|моему|моей|я(?!\p{L})|дет[еяи]|для\s+\p{L}+)/u.test(before);
      if (!patient && Number(match[1]) >= 18) {
        unsupported.push('doctor_age');
        break;
      }
    }
  }
  // «По ОМС, а если нельзя — то платно»: на платный приём согласие уже дано.
  const fallbacks = [];
  if (unsupported.includes('oms') && PAID_FALLBACK.test(lower)) fallbacks.push('oms');
  for (const key of ['home_visit', 'online']) if (unsupported.includes(key) && IN_PERSON_FALLBACK.test(lower)) fallbacks.push(key);
  /*
   * «Врач не моложе 50 и с хорошими отзывами, но если такого нет — то любой
   * с большим стажем»: на врача без проверки возраста и отзывов согласие уже
   * дано — эти условия не блокируют подбор («с большим стажем» остаётся).
   */
  const anyDoctorFallback = new RegExp(`${FALLBACK_LEAD}[^.!?]{0,40}?(?<!${WORD})(?:любой|любого|любому|кто\\s+угодно|кто-нибудь|неважно\\s+кто)(?!${WORD})`, 'u').test(lower);
  // Согласие видно в понятых условиях: «без отзывов: их в демо нет, вы согласились на любого врача».
  if (anyDoctorFallback) fallbacks.push(...unsupported.filter((key) => key === 'rating' || key === 'doctor_age'));
  if (fallbacks.length > 0) result.fallbacks = fallbacks;
  const kept = unsupported.filter((key) => !fallbacks.includes(key));
  if (kept.length > 0) result.unsupported = kept;
  // То же согласие следующей репликой: «ладно, давайте платно», «хорошо, приеду сам».
  const paidLater = PAID_LATER.exec(lower);
  if (paidLater && !isNegatedBefore(lower, paidLater.index) && !unsupported.includes('oms')) result.consentPaid = true;
  const inPersonLater = IN_PERSON_LATER.exec(lower);
  if (inPersonLater && !isNegatedBefore(lower, inPersonLater.index)) result.consentInPerson = true;

  if (new RegExp(`(?<!${WORD})(?:к\\s+)?(?:любому|другому|любой|другой)\\s+${DOCTOR_NOUN}`, 'u').test(lower)) result.doctorAny = true;
  if (new RegExp(`(?<!${WORD})(?:в\\s+)?(?:любой|другой|любую|другую)\\s+клиник\\p{L}*|клиника\\s+(?:не\\s+важна|неважна|любая)`, 'u').test(lower)) result.clinicAny = true;
  /*
   * «А в другой клинике?», «к другому врачу» — не «в любой», а «не в той,
   * что была»: прежние названные клиника и врач становятся исключениями.
   */
  if (new RegExp(`(?<!${WORD})(?:в\\s+)?(?:другой|другую|других)\\s+(?:клиник|медцентр|центр|филиал)\\p{L}*|(?<!${WORD})не\\s+(?:там|в\\s+этой\\s+клиник\\p{L}*)(?!${WORD})`, 'u').test(lower)) result.clinicOther = true;
  if (new RegExp(`(?<!${WORD})(?:к\\s+)?(?:другому|другой)\\s+(?:врач|доктор|специалист)\\p{L}*|(?<!${WORD})не\\s+к\\s+(?:нему|ней|этому\\s+врачу)(?!${WORD})`, 'u').test(lower)) result.doctorOther = true;

  const planId = lastAffirmed(lower, PLAN_PATTERNS);
  if (planId) result.planId = planId;

  if (TRAVEL_CONTEXT.test(self.masked)) {
    const originHint = lastAffirmed(self.masked, ORIGIN_PATTERNS);
    if (originHint) result.originHint = originHint;
    // «Живу на Азино, найдите поближе»: поближе — к дому, а не к текущей геолокации.
    else if (self.home || self.work) result.originHint = self.home ? 'home' : 'work';
  }
  const nearPlace = NEAR_PLACE.exec(self.masked);
  if (nearPlace && !isNegatedBefore(lower, nearPlace.index)) {
    result.originHint = result.originHint || 'place';
    result.nearPlace = true;
  }

  const spoken = spokenTimes(lower);
  if (spoken.after) result.spokenAfter = spoken.after;
  if (spoken.before) result.spokenBefore = spoken.before;
  if (spoken.doubtful) {
    // «С семи до девяти» — прочтения согласуются; однозначное остаётся условием, двусмысленное — вопросом.
    const plus = (clock) => plusMinute(clock);
    const shift = (clock, delta) => {
      const total = Math.min(Math.max(Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) + delta, 0), 1439);
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    };
    const combined = spoken.doubtful.exact
      ? { ambiguity: spoken.doubtful.exact.map((clock) => ({ from: clock, to: plus(clock) })) }
      : spoken.doubtful.around
        ? { ambiguity: spoken.doubtful.around.map((clock) => ({ from: shift(clock, -30), to: shift(clock, 31) })) }
        : combineTimeReadings(spoken.doubtful.after || [result.spokenAfter || null], spoken.doubtful.before || [result.spokenBefore || null]);
    if (combined.ambiguity) {
      result.timeAmbiguity = combined.ambiguity;
      delete result.spokenAfter;
      delete result.spokenBefore;
    } else {
      if (combined.from) result.spokenAfter = combined.from;
      if (combined.to) result.spokenBefore = combined.to;
    }
  }
  if (spoken.exact && !result.timeExact && !result.timeAround) result.timeExact = spoken.exact;
  if (spoken.around && !result.timeAround) {
    result.timeAround = spoken.around;
    delete result.timeExact;
  }
  /*
   * «Желательно до 12», «лучше после 17» — пожелание, а не условие: такие
   * варианты первыми, остальные не отбрасываются.
   */
  const soft = new RegExp(`(?<!${WORD})(?:лучше|желательно|предпочтительно|по\\s+возможности|хорошо\\s+бы|если\\s+можно|в\\s+идеале)\\s+(?:(?:бы|всё\\s+же|все\\s+же)\\s+)?(после|до|не\\s+позже|не\\s+раньше)\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s+час\\p{L}*)?(?:\\s+(утра|дня|вечера))?(?![\\d:])(?!\\s*(?:тыс|руб|₽|мин|к(?!\\p{L})))`, 'u').exec(lower);
  // «А лучше после 17» отдельной репликой — исправление прежнего времени, а не пожелание.
  const correction = soft && /^лучше/u.test(soft[0]) && /^[\s,.!]*(?:(?:а|нет|ой|хотя|но|ну|тогда)[\s,.!]+)*$/u.test(lower.slice(0, soft.index));
  if (soft && !correction) {
    const after = soft[1] === 'после' || soft[1].endsWith('раньше');
    let hour = Number(soft[2]);
    const dayPart = soft[4];
    const ambiguous = !dayPart && (after ? hour === 7 || hour === 8 : hour === 8 || hour === 9);
    if (dayPart === 'вечера' && hour < 12) hour += 12;
    else if (dayPart === 'дня' && hour >= 1 && hour <= 6) hour += 12;
    else if (!dayPart && hour >= 1 && hour <= (after ? 6 : 7)) hour += 12;
    if (hour <= 23 && !ambiguous) {
      const clock = `${String(hour).padStart(2, '0')}:${soft[3] || '00'}`;
      result.preferWindow = after ? { from: clock, to: null } : { from: null, to: clock };
      if (after && result.spokenAfter === clock) delete result.spokenAfter;
      if (!after && result.spokenBefore === clock) delete result.spokenBefore;
    }
  }
  // «После работы» — вечер; в понятых условиях это так и видно.
  if (new RegExp(`(?<!${WORD})после\\s+работы(?!${WORD})`, 'u').test(lower)) result.afterWork = true;
  /*
   * «Работаю до шести», «на работе до 18» — не «приём до 18», а «после 18»:
   * так и показываем в понятых условиях. В «работаю в центре до 18:00» место
   * уже скрыто (maskSelfPlaces) — граница та же.
   */
  const busyUntil = new RegExp(`(?<!${WORD})(?:работаю|занят\\p{L}?|на\\s+работе|учусь|в\\s+офисе)\\s+(?:до|по)\\s+(\\d{1,2}(?::\\d{2})?|${HOUR_WORD})(?:\\s+час\\p{L}*)?(?:\\s+(утра|дня|вечера))?`, 'u').exec(self.masked);
  /*
   * «Я до 11 сплю», «сплю до 10», «до обеда в школе» — тоже «после этого
   * времени». Сон — утро: «сплю до 9» — это 9 утра, а не 21:00.
   */
  const SLEEP = '(?:сплю|отсыпаюсь|высыпаюсь)';
  const BUSY = `(?:работаю|занят\\p{L}?|на\\s+работе|учусь|в\\s+офисе|на\\s+смене|в\\s+школе|на\\s+учебе|на\\s+учёбе|на\\s+парах|на\\s+занятиях|${SLEEP})`;
  const busyReversed = busyUntil ? null : new RegExp(`(?<!${WORD})(?:я\\s+)?(?:до|по)\\s+(\\d{1,2}(?::\\d{2})?|${HOUR_WORD})(?:\\s+час\\p{L}*)?(?:\\s+(утра|дня|вечера))?\\s+(?:я\\s+)?${BUSY}(?!${WORD})`, 'u').exec(self.masked);
  const busySleep = busyUntil || busyReversed ? null : new RegExp(`(?<!${WORD})${SLEEP}\\s+(?:до|по)\\s+(\\d{1,2}(?::\\d{2})?|${HOUR_WORD})(?:\\s+час\\p{L}*)?(?:\\s+(утра|дня|вечера))?`, 'u').exec(self.masked);
  const busy = busyUntil || busyReversed || busySleep;
  if (busy) {
    const raw = busy[1];
    const sleeping = new RegExp(SLEEP, 'u').test(busy[0]);
    let hour = /^\d/.test(raw) ? Number(raw.split(':')[0]) : hourFromWord(raw);
    const minutes = /^\d{1,2}:\d{2}$/.test(raw) ? raw.split(':')[1] : '00';
    if (hour !== null && (busy[2] === 'вечера' || busy[2] === 'дня' || (!sleeping && hour >= 1 && hour <= 8))) hour += hour < 12 ? 12 : 0;
    if (hour !== null && hour <= 23) {
      result.spokenAfter = `${String(hour).padStart(2, '0')}:${minutes}`;
      result.busyUntil = true;
      if (result.spokenBefore === result.spokenAfter) delete result.spokenBefore;
    }
  }
  // «После школы / уроков» — с 14:00, «в обед» — 12:00–14:00.
  if (new RegExp(`(?<!${WORD})после\\s+(?:школы|уроков|учёбы|учебы|пар)(?!${WORD})`, 'u').test(lower) && !result.spokenAfter) result.spokenAfter = '14:00';
  if (new RegExp(`(?<!${WORD})(?:в\\s+обед|в\\s+обеденн\\p{L}*\\s+перерыв)(?!${WORD})`, 'u').test(lower)) {
    result.spokenAfter = '12:00';
    result.spokenBefore = '14:00';
  }
  /* «В ближайший час», «в ближайшие 2 часа», «прямо сейчас» — окно от текущего времени. */
  const withinHours = new RegExp(`(?<!${WORD})(?:в\\s+ближайш\\p{L}*\\s+(?:(\\d|пару|два|три)\\s+)?час\\p{L}*|в\\s+течение\\s+(?:(\\d|двух|трёх|трех)\\s+)?час\\p{L}*|прямо\\s+сейчас)`, 'u').exec(lower);
  if (withinHours) {
    const count = withinHours[1] || withinHours[2];
    result.withinHours = { 2: 2, пару: 2, два: 2, двух: 2, 3: 3, три: 3, трёх: 3, трех: 3 }[count] || Number(count) || 1;
  }
  // «Ближайший час / день / свободное время» — о времени, а не о расстоянии.
  if (new RegExp(`(?<!${WORD})ближайш\\p{L}*\\s+(?:(?:\\d|пару|два|две|три|несколько)\\s+)?(?:час|врем|д[не]|недел|выходн|свободн|окн|слот|запис|при[её]м|дат|понедельн|вторн|сред|четверг|пятниц|суббот|воскресен|по\\s+времени)`, 'u').test(lower)
    && !new RegExp(`(?<!${WORD})(?:рядом|недалеко|поблизости|поближе|неподал|ближайш\\p{L}*\\s+(?:клиник|врач|доктор|ко\\s+мне|к\\s+дому|от\\s|к\\s))`, 'u').test(lower)) {
    result.nearestIsTime = true;
  }
  const afterHours = AFTER_HOURS.exec(lower);
  // «Не раньше чем через час» — «не» относится к «раньше», а не к «через час».
  const notEarlier = afterHours && /(?<!\p{L})не\s+(?:раньше|ранее)[\s,]*(?:чем\s+)?$/u.test(lower.slice(Math.max(0, afterHours.index - 24), afterHours.index));
  if (afterHours && (notEarlier || !isNegatedBefore(lower, afterHours.index))) {
    const count = afterHours[3];
    result.afterHours = afterHours[1] ? 0.5 : afterHours[2] ? 1.5
      : { пару: 2, два: 2, три: 3, четыре: 4, пять: 5 }[count] || (count ? Number(count) : 1);
  }
  if (PREFER_EXPERIENCE.test(lower)) result.preferExperience = true;
  if (BOOKING_INTENT.test(lower)) result.bookingIntent = true;
  /* Время в пути в обратном порядке: «минут 20 на машине», «полчаса езды», «в пределах часа». */
  const travelReversed = new RegExp(`(?<!${WORD})минут\\s+(\\d{1,3})(?!\\d)`, 'u').exec(lower);
  const halfHour = new RegExp(`(?<!${WORD})(?<!через\\s)(?:полчаса|получаса)(?!${WORD})`, 'u').test(lower);
  const hourTravel = new RegExp(`(?<!${WORD})(?:в\\s+пределах\\s+часа|не\\s+(?:больше|дольше|дальше)\\s+часа|час\\s+(?:езды|на\\s+машине|пешком|ходьбы))(?!${WORD})`, 'u').test(lower);
  if (travelReversed && TRAVEL_CONTEXT.test(lower)) result.maxTravelMinutes = Number(travelReversed[1]);
  else if (halfHour && TRAVEL_CONTEXT.test(lower)) result.maxTravelMinutes = 30;
  else if (hourTravel) result.maxTravelMinutes = 60;
  /* «Если на 18:30 нет — то любое время после 18»: точное время — пожелание, условие — окно пошире. */
  // Только когда после «если/или» идёт именно время, а не «или пятницу … до 3000 ₽».
  const fallbackWindow = new RegExp(`(?<!${WORD})(?:если|или|либо)[^.!?]{0,40}?(?<!${WORD})(?:после|до|не\\s+позже|не\\s+раньше|с)\\s+(?:\\d{1,2}(?::\\d{2})?(?![\\d])(?!\\s*(?:тыс|руб|₽|к(?!\\p{L})|\\d))|${HOUR_WORD})`, 'u');
  if (result.timeExact && fallbackWindow.test(lower)) {
    result.preferTime = result.timeExact;
    delete result.timeExact;
  }
  /*
   * «По ДМС, а если по ДМС никого — платно», «…а если не входит — то не дороже
   * 2000»: ДМС — пожелание (покрытые первыми), а не условие; потолок — для платного.
   */
  const dmsMentioned = DMS_ON.test(lower) || Boolean(lastAffirmed(lower, PLAN_PATTERNS));
  if (dmsMentioned && new RegExp(
    `(?<!${WORD})(?:если|а\\s+если)\\s+(?:по\\s+(?:дмс|страховке|полису)\\s+)?(?:никого|нет|нельзя|не\\s+(?:получится|выйдет|найд[её]тся|входит|покрыва\\p{L}*|покро\\p{L}*|подходит|принима\\p{L}*|оплачива\\p{L}*|бер[её]т))`
    + `[^.!?]{0,30}?(?:платно|за\\s+деньги|можно\\s+и\\s+платно|за\\s+свой\\s+сч[её]т|не\\s+дороже|дешевле|до\\s+\\d|в\\s+пределах|максимум)`,
    'u',
  ).test(lower)) {
    result.preferDms = true;
  }
  /* «Лучше по ДМС», «у меня Demo Basic, но если что — готов заплатить»: ДМС — пожелание, а не условие. */
  if (dmsMentioned && (
    new RegExp(`(?<!${WORD})(?:лучше|желательно|предпочтительно|по\\s+возможности|если\\s+можно)\\s+(?:бы\\s+)?(?:по\\s+)?(?:дмс|страховк\\p{L}*|полису)`, 'u').test(lower)
    || new RegExp(`(?<!${WORD})(?:готов\\p{L}*\\s+(?:и\\s+)?(?:за)?платить|готов\\p{L}*\\s+оплатить|могу\\s+(?:и\\s+)?(?:за|о)платить|можно\\s+(?:и\\s+)?платно|или\\s+платно)`, 'u').test(lower)
  )) {
    result.preferDms = true;
  }
  /* «Хирург, но не детский, а взрослый» — взрослый приём, хотя слово «детский» в тексте есть. */
  if (new RegExp(`(?<!${WORD})(?:взросл\\p{L}*\\s+(?:при[её]м|врач|${DOCTOR_NOUN})|(?:не|без)\\s+детск\\p{L}*|(?:приём|при[её]м)\\s+для\\s+взрослых|а\\s+взросл\\p{L}*)`, 'u').test(lower)
    && !new RegExp(`(?<!${WORD})(?:реб[её]н\\p{L}*|сын\\p{L}*|доч\\p{L}*|малыш\\p{L}*|подрост\\p{L}*|внук\\p{L}*|внучк\\p{L}*)`, 'u').test(lower)) {
    result.adult = true;
  }
  if (!nested) {
    const split = FALLBACK_SPLIT.exec(lower);
    if (split) {
      const [partA, partB] = [lower.slice(0, split.index), lower.slice(split.index + split[0].length)];
      const first = extractBookingConstraints(partA, { nested: true }).date;
      const second = extractBookingConstraints(partB, { nested: true }).date;
      const SIMPLE = ['today', 'tomorrow', 'after_tomorrow', 'weekday', 'date'];
      const flat = (value) => (value?.kind === 'any_of' ? value.options : value && SIMPLE.includes(value.kind) ? [value] : []);
      // «Сегодня, а если никого — завтра с утра»: утро — только для завтра.
      const [windowA, windowB] = [clauseWindow(partA), clauseWindow(partB)];
      const separate = JSON.stringify(windowA) !== JSON.stringify(windowB);
      const withWindow = (window) => (value) => (separate && window ? { ...value, from: window.from, to: window.to } : value);
      const options = [...flat(first).map(withWindow(windowA)), ...flat(second).map(withWindow(windowB))];
      if (separate && flat(first).length > 0 && flat(second).length > 0) result.dayWindows = true;
      const seen = new Set();
      const unique = options.filter((value) => !seen.has(JSON.stringify(value)) && seen.add(JSON.stringify(value)));
      if (flat(first).length > 0 && flat(second).length > 0 && unique.length > 1) result.date = { kind: 'any_of', options: unique.slice(0, 7) };
      // «А если сегодня никого — то завтра» отдельной репликой: запасной день к прежнему.
      else if (flat(first).length === 0 && flat(second).length > 0) result.dateFallback = true;
    }
  }
  const dayWindows = perDayWindows(lower, { excludeWeekdays: result.excludeWeekdays || [], excludeDays: result.excludeDays || [] });
  if (dayWindows && dayWindows.length > 1) {
    result.date = { kind: 'any_of', options: dayWindows };
    result.dayWindows = true;
  }
  /* «С 10 до 12 или после 18» — окна через «или» заменяют одиночные границы этой реплики. */
  const found = result.dayWindows ? null : timeWindowsOf(lower);
  const windows = Array.isArray(found) ? found : found?.windows;
  if (found) {
    result.timeWindows = windows;
    // «С 10 до 12 или после 7»: спорное окно — вопрос, остальные окна ждут ответа.
    if (!Array.isArray(found)) result.windowAsk = found.ask;
    for (const key of ['timeExact', 'timeAround', 'spokenAfter', 'spokenBefore', 'preferTime', 'busyUntil', 'timeAmbiguity']) delete result[key];
  }
  /* Доступная среда и парковка — свойства филиала; у реальных клиник неизвестны, и тогда они не проходят. */
  // «Доступная среда и парковка не обязательны» — снятие условия, а не само условие.
  const accessAny = new RegExp(`(?<!${WORD})(?:(?:доступн\\p{L}*\\s+сред\\p{L}*|пандус\\p{L}*|парковк\\p{L}*|лифт\\p{L}*)[^.!?]{0,40}?(?:не\\s+(?:обязательн|нужн|важн)\\p{L}*|неважн\\p{L}*)|без\\s+требовани\\p{L}*\\s+к\\s+(?:доступн|парковк))`, 'u').test(lower);
  if (accessAny) result.accessAny = true;
  if (!accessAny && new RegExp(`(?<!${WORD})(?:пандус\\p{L}*|коляск\\p{L}*|доступн\\p{L}*\\s+сред\\p{L}*|без\\s+ступенек|лифт\\p{L}*)`, 'u').test(lower)) result.wheelchair = true;
  if (!accessAny && new RegExp(`(?<!${WORD})(?:(?:с|и|нужн\\p{L}*|был\\p{L}*|есть|своей|бесплатн\\p{L}*)\\s+парковк\\p{L}*|парковк\\p{L}*\\s+(?:нужн|обязательн|рядом)|где\\s+(?:можно\\s+)?припарковаться|чтобы\\s+(?:можно\\s+было\\s+)?припарковаться)`, 'u').test(lower)) result.parking = true;

  if (PRICE_ANY.test(lower)) {
    result.maxPrice = null;
  } else {
    const price = lastAffirmed(lower, PRICE_PATTERNS);
    if (Number.isInteger(price)) result.maxPrice = price;
  }

  const city = lastAffirmed(lower, CITY_PATTERNS);
  if (city) result.city = city;

  const dmsOff = DMS_OFF.test(lower) || Boolean(result.preferDms);
  const dmsOn = !dmsOff && (Boolean(planId) || (DMS_ON.test(lower) && findTrigger(lower, 'дмс', 'страховк', 'полис') !== 'negated'));
  if (dmsOff) result.dms = false;
  else if (dmsOn) result.dms = true;

  const timeOfDay = lastAffirmed(lower, TIME_OF_DAY_PATTERNS);
  if (timeOfDay) result.timeOfDay = timeOfDay;
  /*
   * «Только не утром», «не с утра» — после 12:00; «не после обеда» — до 13:00;
   * «не вечером» — до 17:00.
   */
  if (!timeOfDay && !result.timeWindows) {
    const negatedPart = (pattern) => {
      const regex = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      for (const match of lower.matchAll(regex)) if (isNegatedBefore(lower, match.index)) return true;
      return false;
    };
    const later = (left, right) => (!left || (right && right > left) ? right : left);
    const earlier = (left, right) => (!left || (right && right < left) ? right : left);
    if (negatedPart(TIME_OF_DAY_PATTERNS[0].pattern)) result.spokenAfter = later(result.spokenAfter, '12:00');
    if (negatedPart(TIME_OF_DAY_PATTERNS[1].pattern)) result.spokenBefore = earlier(result.spokenBefore, '13:00');
    if (negatedPart(new RegExp(`(?<!${WORD})(?:вечером|вечерн\\p{L}*|по\\s+вечерам)(?!${WORD})`, 'u'))) result.spokenBefore = earlier(result.spokenBefore, '17:00');
  }

  const procedure = lastAffirmed(lower, PROCEDURE_PATTERNS);
  if (procedure) {
    result.serviceId = procedure.serviceId;
    result.procedureSpecialty = procedure.specialty;
  }

  if (findTrigger(lower, 'повторн') === 'affirmed') result.visit = 'repeat';
  else if (findTrigger(lower, 'первичн', 'перв\\p{L}*\\s+при[её]м') === 'affirmed') result.visit = 'first';

  /*
   * Ответы на уточнения и согласия следующей репликой. Короткий ответ — вся
   * реплика («вечера», «да, утром», «ближайшую»): он выбирает одно из прочтений
   * прошлого запроса, а не добавляет новое условие.
   */
  const FILLER = '(?:(?:да|нет|ну|ок|окей|ладно|хорошо|конечно|давай(?:те)?|лучше|наверное|скорее|пожалуйста|это|в|на|а|можно|тогда)[\\s,!.?]*)*';
  const dayPart = new RegExp(`^[\\s,!.]*${FILLER}(?:\\d{1,2}\\s+)?(утра|утром|с\\s+утра|вечера|вечером|дн[её]м|после\\s+обеда)[\\s,!.?]*${FILLER}$`, 'u').exec(lower);
  if (dayPart) result.dayPartAnswer = /^(?:утр|с\s+утра)/u.test(dayPart[1]) ? 'am' : 'pm';
  const weekPart = new RegExp(`^[\\s,!.]*${FILLER}(ближайш\\p{L}*|эт(?:у|а|от|ой)|следующ\\p{L}*|через\\s+неделю|не\\s+эт\\p{L}*)(?:\\s+\\p{L}+)?[\\s,!.?]*$`, 'u').exec(lower);
  // С названным днём («в следующую среду») или неделей это не ответ, а новый день.
  if (weekPart && !/(?:недел[еия]|понедельник|вторник|сред|четверг|пятниц|суббот|воскресен)/u.test(lower.replace(/через\s+неделю/u, ''))) {
    result.weekAnswer = /^(?:ближайш|эт)/u.test(weekPart[1]) ? 'this' : 'next';
  }
  const clearUnsupported = [
    ['doctor_age', /(?<!\p{L})(?:возраст\p{L}*(?:\s+врача)?\s+(?:не\s+важ\p{L}*|неваж\p{L}*|любой)|без\s+уч[её]та\s+возраста|любого\s+возраста)/u],
    ['anonymous', /(?<!\p{L})(?:можно\s+не\s+анонимно|анонимн\p{L}*\s+(?:не\s+(?:важн|нужн|обязательн)\p{L}*|неважн\p{L}*)|не\s+анонимно)/u],
    ['rating', /(?<!\p{L})(?:(?:отзыв|рейтинг)\p{L}*\s+(?:не\s+важн\p{L}*|неважн\p{L}*)|без\s+(?:отзывов|рейтинга))/u],
    ['certificate', /(?<!\p{L})(?:без\s+справки|справк\p{L}*\s+(?:не\s+нужн\p{L}*|не\s+надо))/u],
    ['multi_patient', /(?<!\p{L})(?:по\s+одному|(?:одну|одна)\s+запис\p{L}*|сначала\s+(?:одного|одну))/u],
  ].filter(([, pattern]) => pattern.test(lower)).map(([key]) => key);
  if (clearUnsupported.length > 0) result.clearUnsupported = clearUnsupported;
  // Ответ на «поставьте точку или подтвердите, что вы там»: «я сейчас дома», «считай от меня».
  if (/(?<!\p{L})(?:(?:я|мы)\s+)?(?:сейчас|уже)\s+(?:там|дома|на\s+работе|здесь|тут|в\s+офисе)|(?:считай(?:те)?|считать)\s+от\s+(?:меня|моей\s+точки|текущ\p{L}*\s+(?:места|точки))|от\s+моего\s+(?:местоположения|места)|по\s+(?:моей\s+)?геолокации/u.test(lower)) result.originHere = true;
  // Ответ на «выберите программу ДМС» одним словом: «премиум», «у меня стандарт».
  const planAnswer = /^[\s,.!]*(?:(?:у\s+меня|программа|давай(?:те)?|да,?|полис)\s+)?(basic|standard|premium|базов\p{L}*|стандарт\p{L}*|премиум\p{L}*)[\s.!]*$/u.exec(lower);
  if (planAnswer && !result.planId) result.planAnswer = /^(?:basic|базов)/u.test(planAnswer[1]) ? 'demo-basic' : /^(?:standard|стандарт)/u.test(planAnswer[1]) ? 'demo-standard' : 'demo-premium';
  // «А подешевле?», «недорого» без суммы — дешёвые первыми, а не придуманный потолок.
  if (/(?<!\p{L})(?:подешевле|недорог\p{L}*|бюджетн\p{L}*|подешевл\p{L}*|самый\s+дешёв\p{L}*|самый\s+дешев\p{L}*|подешевше)(?!\p{L})/u.test(lower) && !Number.isInteger(result.maxPrice)) result.preferCheap = true;
  // «А просто консультация?», «обычный приём» — без процедуры, первичный приём.
  if (/(?<!\p{L})(?:(?:просто|обычн\p{L}*)\s+(?:консультаци\p{L}*|при[её]м\p{L}*)|без\s+процедур\p{L}*|только\s+консультаци\p{L}*)/u.test(lower) && !result.serviceId) result.serviceClear = true;
  // «И в выходные тоже можно» — выходные в добавление к будням, а не вместо них.
  if (/(?<!\p{L})(?:и\s+)?(?:в|на)\s+выходн\p{L}*\s+(?:тоже|также)(?:\s+(?:можно|подойд\p{L}*|норм\p{L}*))?|(?:можно|подойд\p{L}*)\s+и\s+(?:в|на)\s+выходн\p{L}*/u.test(lower)) {
    result.alsoWeekend = true;
    delete result.explicitWeekend;
    if (result.date?.kind === 'weekend') delete result.date;
  }
  // «Или в пятницу?», «или на 14:00» отдельной репликой — ещё один вариант к прежнему, а не замена.
  if (/^[\s,]*(?:или|либо|а\s+ещё|а\s+еще|можно\s+и)(?!\p{L})|(?<!\p{L})тоже\s+(?:можно|подойд\p{L}*|пойд\p{L}*)(?!\p{L})/u.test(lower)) result.alsoOption = true;
  // «А взрослому?», «для взрослого» — взрослый приём.
  if (/(?<!\p{L})(?:взросл(?:ому|ого|ый|ая|ой)|для\s+взрослых)(?!\s+(?:реб[её]н|сын|доч))(?!\p{L})/u.test(lower)
    && !/(?<!\p{L})(?:реб[её]н\p{L}*|сын\p{L}*|доч\p{L}*|малыш\p{L}*|подрост\p{L}*|детск\p{L}*)/u.test(lower)) result.adult = true;
  // «Запиши меня к первому», «давай второй вариант» — запись делается кнопкой в карточке, не текстом.
  if (/(?<!\p{L})(?:к\s+)?(?:перв|втор|трет|четв[её]рт|пят)\p{L}*\s+(?:вариант|врач\p{L}*|доктор\p{L}*|из\s+списка)|(?:запиши|запишите|записать|оформи)\p{L}*\s+(?:меня\s+)?(?:к\s+)?(?:первому|второму|третьему|нему|ней|этому|этой)(?!\p{L})|(?:беру|выбираю)\s+(?:перв|втор|трет)\p{L}*/u.test(lower)) result.pickOption = true;
  if (/(?<!\p{L})(?:можно\s+(?:и\s+)?платно|(?:давай(?:те)?|ладно,?|хорошо,?)\s+(?:и\s+)?платно|платно\s+тоже\s+(?:можно|подойд\p{L}*)|готов\p{L}*\s+(?:и\s+)?(?:за)?платить)/u.test(lower)) result.allowPaid = true;
  if (/(?<!\p{L})(?:(?:стаж|опыт)\p{L}*\s+(?:не\s+важ\p{L}*|неваж\p{L}*|любой)|без\s+(?:требовани\p{L}*\s+(?:к|по)\s+)?стаж\p{L}*)/u.test(lower)) result.experienceAny = true;
  if (/(?<![\p{L}])(?:в\s+любое\s+время|(?:давай(?:те)?|можно|ладно,?)\s+любое\s+время|без\s+ограничени\p{L}*\s+по\s+времени|время\s+(?:не\s+важно|неважно|любое)|неважно\s+во\s+сколько|в\s+любое\s+время\s+дня)/u.test(lower)) {
    result.timeAny = true;
  }
  if (/(?<![\p{L}])(?:неважно|не\s+важно|без\s+разницы)\s+(?:сколько\s+ехать|как\s+далеко|далеко)|можно\s+(?:и\s+)?подальше|расстояние\s+не\s+важно/u.test(lower)) {
    result.travelAny = true;
  }

  return result;
};

/**
 * Признаки ответа на уточняющий вопрос: «вечера, и чтобы женщина», «19»,
 * «второе». Это не условия записи: ответом они становятся, только если вопрос
 * действительно был задан, — решает mergeBookingTurns.
 */
export const extractReplySignals = (text) => {
  const lower = prepare(text);
  const reply = {};
  // Ответ внутри реплики подлиннее: «не утра, а вечера», «не эту, а следующую».
  const dayMentions = [...lower.matchAll(/(?<!\p{L})(не\s+)?(утра|утром|с\s+утра|утренн\p{L}*|вечера|вечером|вечерн\p{L}*)(?!\p{L})/gu)];
  const dayMention = dayMentions.filter((match) => !match[1]).pop() || dayMentions.pop();
  if (dayMention) {
    const morning = /^(?:утр|с\s+утра)/u.test(dayMention[2]);
    reply.dayPart = morning !== Boolean(dayMention[1]) ? 'am' : 'pm';
  }
  const weekMentions = [...lower.matchAll(new RegExp(`(?<!${WORD})(не\\s+)?(ближайш\\p{L}*(?!\\s+(?:клиник|врач|доктор|филиал|к\\s|от\\s|ко\\s))|эт(?:у|а|от|ой)|следующ\\p{L}*|через\\s+неделю)(?!${WORD})(?!\\s+(?:${WEEKDAY_STEMS}|недел))`, 'gu'))];
  const weekMention = weekMentions.filter((match) => !match[1]).pop();
  if (weekMention && !/(?:понедельник|вторник|сред[ау]|четверг|пятниц|суббот|воскресен)/u.test(lower)) {
    reply.week = /^(?:ближайш|эт)/u.test(weekMention[2]) ? 'this' : 'next';
  }
  // «19», «в 19», «19:00», «19, и чтобы женщина» — ответ на «после 07:00 или после 19:00?».
  const hourOnly = /^[\s,.!]*(?:(?:давай(?:те)?|лучше|ну|тогда)\s+)?(?:(?:в|на|к)\s+)?(\d{1,2})(?::(\d{2}))?(?:\s+час\p{L}*)?\s*(?:[,.!;]|$)/u.exec(lower);
  if (hourOnly && Number(hourOnly[1]) <= 23) reply.hour = Number(hourOnly[1]);
  // «Неважно», «без разницы», «любое» — снять то, о чём спросили.
  if (/^[\s,.!]*(?:(?:да|ну|ой|мне)\s+)?(?:неважно|не\s+важно|без\s+разницы|вс[её]\s+равно|любое|любую|любой|любые|как\s+угодно|не\s+имеет\s+значения|какая\s+разница|оба|обе|оба\s+варианта|и\s+то\s+и\s+то|подойд[её]т\s+(?:любое|любая|любой|оба|обе))(?:\s+(?:время|день|неделя|вариант))?[\s,.!)]*$/u.test(lower)) reply.indifferent = true;
  // «Первое», «второй вариант», «к первому» — выбор из двух предложенных.
  // Порядковое слово в начале реплики, дальше — конец или знак: «второе, и чтобы женщина».
  const ordinal = /^[\s,.!]*(?:(?:давай(?:те)?|лучше|ну|тогда|да,?)\s+)?(?:(?:к|на|в)\s+)?(перв|втор)\p{L}*(?:\s+(?:вариант\p{L}*|врач\p{L}*|специалист\p{L}*|время|день))?\s*(?:[,.!;)]|$)/u.exec(lower);
  if (ordinal) reply.ordinal = ordinal[1] === 'перв' ? 1 : 2;
  // «Да», «согласен», «ок», «давайте» — согласие на то, о чём спросили (без «спасибо»: это прощание).
  if (/^[\s,.!]*(?:да|ага|угу|ок|окей|ok|хорошо|ладно|согласен|согласна|согласны|давай(?:те)?|конечно|можно|подходит|устраивает|пойд[её]т|годится|верно|точно|именно)(?:[\s,.!]+(?:да|давай(?:те)?|конечно|можно|согласен|согласна|хорошо|ладно|так|пожалуйста|подходит|ищи(?:те)?|ищем))*[\s,.!)]*$/u.test(lower)) reply.yes = true;
  // «Я дома», «я на работе», «да, я там» — подтверждение точки отправления.
  // «Я на работе до 17» — о расписании, а не о том, где человек сейчас.
  if (/(?<!\p{L})(?:я|мы)\s+(?:сейчас\s+|уже\s+|как\s+раз\s+)?(?:там|дома|на\s+работе|здесь|тут|в\s+офисе)(?!\p{L})(?!\s+(?:до|по|с|после|с\s+утра|весь|целый|каждый)(?!\p{L}))/u.test(lower)) reply.atPlace = true;
  // «Стандарт, и завтра», «стандартная программа» — программа ДМС внутри реплики.
  const planWord = /(?<!\p{L})(basic|standard|premium|базов\p{L}*|стандарт\p{L}*|премиум\p{L}*)(?!\p{L})/u.exec(lower);
  if (planWord) reply.plan = /^(?:basic|базов)/u.test(planWord[1]) ? 'demo-basic' : /^(?:standard|стандарт)/u.test(planWord[1]) ? 'demo-standard' : 'demo-premium';
  // «Не знаю», «посоветуйте», «на ваше усмотрение» — человек не уверен, к кому.
  if (/(?<!\p{L})(?:не\s+знаю|не\s+уверен\p{L}*|посоветуй\p{L}*|на\s+ваше\s+усмотрение|сами\s+выберите|выберите\s+сами|кого\s+(?:посоветуете|лучше)|без\s+понятия)(?!\p{L})/u.test(lower)) reply.unsure = true;
  return reply;
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
    doctorChoice: false,
    foreignDoctor: false,
    preferTime: null,
    preferWindow: null,
    withinHours: null,
    wheelchair: false,
    parking: false,
    preferDms: false,
    preferExperience: false,
    preferMinExperience: null,
    preferDistricts: [],
    adult: false,
    pendingTime: null,
    // Номер дня в «в четверг или в пятницу», о времени которого спросили («после 7» — утра или вечера?).
    pendingDay: null,
    // «С 10 до 12 или после 7»: окна, которые ждут ответа о спорном.
    pendingWindows: null,
    busyFrom: null,
    originConfirmed: false,
    preferCheap: false,
    pickOption: false,
    timeWindows: null,
    excludeDays: [],
    afterHours: null,
    fallbacks: [],
    bookingIntent: false,
    // Последняя реплика ответила на вопрос ассистента («вечера», «да», «премиум»).
    answered: false,
  };

  for (const turn of turns) {
    let booking = turn.booking || {};
    let constraints = turn.constraints || {};
    const explicitTime = Boolean(booking.timeExact || booking.timeAround || booking.spokenAfter || booking.spokenBefore || booking.timeWindows || booking.dayWindows
      || booking.timeAmbiguity || constraints.availableAfter || constraints.availableBefore || constraints.timeAmbiguity);
    /*
     * Ответ на уточнение — продолжение прошлого запроса: «после 7» → «утра или
     * вечера?» → «вечера» выбирает одно из прочтений, а не ставит условие
     * «вечером». Ассистент свои вопросы в историю не пишет — что было спрошено,
     * восстанавливается из прежних реплик.
     */
    let answered = false;
    const reply = booking.reply || {};
    const withoutTime = () => {
      booking = { ...booking };
      constraints = { ...constraints };
      for (const key of ['timeOfDay', 'timeExact', 'timeAround', 'spokenAfter', 'spokenBefore', 'timeAmbiguity', 'afterWork']) delete booking[key];
      for (const key of ['evening', 'availableAfter', 'availableBefore', 'timeAmbiguity']) delete constraints[key];
    };
    if (merged.pendingTime) {
      // «19» или «в 19» — то из двух прочтений, где этот час; «первое» — первое.
      const byHour = Number.isInteger(reply.hour)
        ? merged.pendingTime.find((reading) => Number((reading.from || reading.to).slice(0, 2)) === reply.hour) : null;
      const part = !explicitTime ? booking.dayPartAnswer || reply.dayPart : null;
      const reading = byHour || (part ? merged.pendingTime[part === 'am' ? 0 : 1] : null)
        || (reply.ordinal && !explicitTime ? merged.pendingTime[reply.ordinal - 1] : null);
      // Вопрос был о времени одного дня («завтра после 7 или в четверг до обеда») — ответ только для него.
      const dayIndex = merged.pendingDay;
      const setDay = (window) => {
        merged.date = { ...merged.date, options: merged.date.options.map((option, position) => (position === dayIndex ? { ...withoutDayWindow(option), ...(window ? { from: window.from, to: window.to } : {}) } : option)) };
      };
      const perDay = Number.isInteger(dayIndex) && merged.date?.kind === 'any_of' && Boolean(merged.date.options[dayIndex]);
      if (reading) {
        if (perDay) setDay(reading);
        else if (merged.pendingWindows) {
          merged.timeWindows = [...merged.pendingWindows, reading];
          merged.timeFrom = null;
          merged.timeTo = null;
        } else {
          merged.timeFrom = reading.from;
          merged.timeTo = reading.to;
        }
        merged.pendingTime = null;
        merged.pendingDay = null;
        merged.pendingWindows = null;
        merged.evening = false;
        withoutTime();
        answered = true;
      } else if (reply.indifferent) {
        // «Неважно» на «утра или вечера?» — без ограничения по часам.
        if (perDay) setDay(null);
        else if (merged.pendingWindows) merged.timeWindows = null;
        else {
          merged.timeFrom = null;
          merged.timeTo = null;
        }
        merged.pendingTime = null;
        merged.pendingDay = null;
        merged.pendingWindows = null;
        withoutTime();
        answered = true;
      }
    }
    // «В следующую пятницу» → «ближайшая или через неделю?» → «ближайшую».
    // Вопрос о неделе: «в следующую пятницу» или день недели, совпавший с сегодняшним (спросит подбор).
    const asked = Boolean(merged.date?.askWeek) || (merged.date?.kind === 'weekday' && !merged.date.week);
    // «Первое», «неважно» отвечают на один вопрос — на тот, что задан первым (время).
    const ordinalFree = reply.ordinal && !answered;
    const indifferentFree = reply.indifferent && !answered;
    const weekAnswer = booking.weekAnswer
      || (asked && (!booking.date || booking.date.kind === 'in_days') ? reply.week : null)
      || (asked && !booking.date && ordinalFree ? (reply.ordinal === 1 ? 'this' : 'next') : null)
      || (booking.date?.kind === 'this_week' ? 'this' : booking.date?.kind === 'next_week' ? 'next' : null);
    const weekAnswerable = asked || (booking.weekAnswer && merged.date
      && (['this_week', 'next_week'].includes(merged.date.kind) || merged.date.kind === 'weekday'));
    if (weekAnswerable && weekAnswer
      && (!booking.date || ['this_week', 'next_week'].includes(booking.date.kind) || ((booking.weekAnswer || reply.week) && booking.date.kind === 'in_days'))) {
      // «На следующей неделе» → «а можно в эту?» — та же неделя-вопрос, другой ответ.
      merged.date = merged.date.kind === 'weekday'
        ? { kind: 'weekday', weekday: merged.date.weekday, week: weekAnswer }
        : { kind: weekAnswer === 'this' ? 'this_week' : 'next_week' };
      booking = { ...booking };
      delete booking.date;
      // «Ближайшую» здесь — о дне, а не «поближе по расстоянию».
      constraints = { ...constraints };
      delete constraints.selection;
      delete booking.nearPlace;
      answered = true;
    } else if (asked && merged.date.kind === 'weekday' && indifferentFree && !booking.date) {
      // «Любую» — обе: ближайшая и через неделю.
      merged.date = { kind: 'any_of', options: [{ kind: 'weekday', weekday: merged.date.weekday, week: 'this' }, { kind: 'weekday', weekday: merged.date.weekday, week: 'next' }] };
      answered = true;
    }
    // «Да» — ответ на открытый вопрос: сначала об условии, которого в демо нет, потом о точке.
    if (reply.yes && merged.unsupported.length > 0) {
      booking = { ...booking, consentAll: true };
      answered = true;
    } else if (reply.yes && merged.originHint && !merged.originConfirmed) {
      booking = { ...booking, originHere: true };
      answered = true;
    }
    // «Стандарт, и завтра» на вопрос о программе ДМС.
    if (merged.dms === true && !merged.planId && reply.plan && !booking.planId && !booking.planAnswer) {
      booking = { ...booking, planAnswer: reply.plan };
      answered = true;
    }
    // «Я дома», «я на работе» — подтверждение точки, названной словами.
    if (reply.atPlace && !booking.originHere) booking = { ...booking, originHere: true };
    if (booking.originHere && merged.originHint && !merged.originConfirmed) answered = true;
    if (booking.planAnswer && merged.dms === true && !merged.planId) answered = true;
    merged.answered = answered;
    // «Желательно до 12»: строгая граница gateway из той же реплики снимается — остаётся пожелание.
    if (booking.preferWindow) {
      constraints = { ...constraints };
      if (booking.preferWindow.from) delete constraints.availableAfter;
      if (booking.preferWindow.to) delete constraints.availableBefore;
    }
    const SIMPLE_KINDS = ['today', 'tomorrow', 'after_tomorrow', 'weekday', 'date'];
    // «Или на 14:00» после «на 13:30» — оба времени.
    if (booking.alsoOption && (booking.timeExact || booking.timeAround) && merged.timeFrom && merged.timeTo) {
      const previous = merged.timeWindows || [{ from: merged.timeFrom, to: merged.timeTo }];
      const [hours, minutes] = (booking.timeExact || booking.timeAround).split(':').map(Number);
      const at = hours * 60 + minutes;
      const asText = (value) => `${String(Math.floor(Math.min(Math.max(value, 0), 1439) / 60)).padStart(2, '0')}:${String(Math.min(Math.max(value, 0), 1439) % 60).padStart(2, '0')}`;
      const added = booking.timeExact ? { from: asText(at), to: asText(at + 1) } : { from: asText(at - 30), to: asText(at + 31) };
      booking = { ...booking, timeWindows: [...previous, added].slice(0, 3) };
      delete booking.timeExact;
      delete booking.timeAround;
    }
    if ((booking.dateFallback || booking.alsoOption) && booking.date && SIMPLE_KINDS.includes(booking.date.kind)
      && merged.date && (SIMPLE_KINDS.includes(merged.date.kind) || merged.date.kind === 'any_of')) {
      const previous = merged.date.kind === 'any_of' ? merged.date.options : [merged.date];
      merged.date = { kind: 'any_of', options: [...previous, booking.date].slice(0, 7) };
      booking = { ...booking };
      delete booking.date;
    }
    // «На этой неделе» → «тогда в четверг»: четверг той же недели, а не просто ближайший.
    if (booking.date?.kind === 'weekday' && !booking.date.week && ['this_week', 'next_week'].includes(merged.date?.kind)) {
      booking = { ...booking, date: { ...booking.date, week: merged.date.kind === 'this_week' ? 'this' : 'next' } };
    }
    // «На следующей неделе» → «в понедельник или вторник»: оба дня — той же недели.
    if (booking.date?.kind === 'any_of' && booking.date.options.every((option) => option.kind === 'weekday' && !option.week)
      && ['this_week', 'next_week'].includes(merged.date?.kind)) {
      const week = merged.date.kind === 'this_week' ? 'this' : 'next';
      booking = { ...booking, date: { ...booking.date, options: booking.date.options.map((option) => ({ ...option, week })) } };
    }
    /*
     * «Только не завтра» → … → «давайте всё же завтра»: названный позже день
     * снимает его прежнее исключение.
     */
    if (booking.date && ['today', 'tomorrow', 'after_tomorrow', 'date', 'weekday'].includes(booking.date.kind)) {
      const named = booking.date;
      merged.excludeDays = merged.excludeDays.filter((day) => !(day.kind === named.kind && (named.kind !== 'date' || (day.dayOfMonth === named.dayOfMonth && day.month === named.month))));
      if (named.kind === 'weekday') merged.excludeWeekdays = merged.excludeWeekdays.filter((day) => day !== named.weekday);
    }
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
      // «В выходные» → «а в будни?»: прежний день «выходные» снимается вместе с фильтром.
      if (merged.date?.kind === 'weekend' && !('date' in booking)) merged.date = null;
    }
    if (booking.districtAny) {
      merged.districts = [];
      merged.excludeDistricts = [];
    }
    if (booking.districts || booking.excludeDistricts) {
      // «А в Приволжском?» → «или в Вахитовском»: «или» добавляет район к прежнему.
      merged.districts = booking.alsoOption && booking.districts && !booking.excludeDistricts
        ? [...new Set([...merged.districts, ...booking.districts])] : booking.districts || [];
      merged.excludeDistricts = booking.excludeDistricts || [];
    }
    if (booking.districts || booking.districtAny) merged.preferDistricts = booking.preferDistricts || [];
    if (booking.adult) merged.adult = true;
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
    if (booking.excludeWeekdays) {
      merged.excludeWeekdays = [...new Set([...merged.excludeWeekdays, ...booking.excludeWeekdays])].sort();
      // «В понедельник или вторник» → «кроме понедельника»: остаётся вторник.
      if (merged.date?.kind === 'any_of' && !('date' in booking)) {
        const options = merged.date.options.filter((option) => option.kind !== 'weekday' || !merged.excludeWeekdays.includes(option.weekday));
        if (options.length > 0) merged.date = options.length > 1 ? { ...merged.date, options } : options[0];
      }
    }
    if (booking.excludeDoctorIds) merged.excludeDoctorIds = [...new Set([...merged.excludeDoctorIds, ...booking.excludeDoctorIds])];
    if (booking.excludeBranchIds) merged.excludeBranchIds = [...new Set([...merged.excludeBranchIds, ...booking.excludeBranchIds])];
    if (booking.minExperience) merged.minExperience = booking.minExperience;
    // Условие, которого в демо нет, остаётся, пока его не снимут кнопкой или словами согласия.
    if (booking.unsupported) merged.unsupported = [...new Set([...merged.unsupported, ...booking.unsupported])];
    const consented = [
      ...(booking.fallbacks || []),
      ...(booking.consentPaid && merged.unsupported.includes('oms') ? ['oms'] : []),
      ...(booking.consentInPerson ? merged.unsupported.filter((key) => key === 'home_visit' || key === 'online') : []),
      // «Да» на «этого в демо нет — искать без этого?»: замена есть — с пометкой, нет — условие снимается.
      ...(booking.consentAll ? merged.unsupported.filter((key) => key in CONSENTED_FALLBACKS) : []),
    ];
    if (booking.consentAll) merged.unsupported = merged.unsupported.filter((key) => key in CONSENTED_FALLBACKS);
    if (consented.length > 0) {
      merged.fallbacks = [...new Set([...merged.fallbacks, ...consented])];
      merged.unsupported = merged.unsupported.filter((key) => !consented.includes(key));
    }
    if (booking.preferExperience) merged.preferExperience = true;
    // Согласие словами: «возраст не важен», «можно не анонимно», «без справки».
    if (booking.clearUnsupported) merged.unsupported = merged.unsupported.filter((key) => !booking.clearUnsupported.includes(key));
    if (booking.experienceAny) {
      merged.minExperience = null;
      merged.preferMinExperience = null;
    }
    // «Да, можно и к мужчине» после «только женщина» — пол становится пожеланием.
    if (booking.genderAlsoOk && merged.doctorGender && merged.doctorGender !== booking.genderAlsoOk) {
      merged.preferGender = merged.doctorGender;
      merged.doctorGender = null;
    } else if (booking.genderAlsoOk && !merged.doctorGender && !merged.preferGender) {
      // «А можно женщину?», когда пол ещё не называли, — просьба о враче-женщине, а не «можно и так».
      merged.doctorGender = booking.genderAlsoOk;
    }
    if (booking.preferMinExperience) {
      merged.preferMinExperience = booking.preferMinExperience;
      merged.minExperience = null;
    }
    if (booking.minExperience) merged.preferMinExperience = null;
    // «В любой день» снимает и исключённые даты; новые исключения добавляются.
    if ('date' in booking && booking.date === null) merged.excludeDays = [];
    if (booking.excludeDays) merged.excludeDays = [...merged.excludeDays, ...booking.excludeDays];
    if (booking.bookingIntent) merged.bookingIntent = true;
    if (booking.afterHours) merged.afterHours = booking.afterHours;
    // Новый день или время снимают «через час» прошлой реплики.
    else if ('date' in booking || booking.timeExact || booking.timeAround || constraints.availableAfter || booking.spokenAfter) merged.afterHours = null;
    if (booking.planId) merged.planId = booking.planId;
    if (booking.originHint) {
      merged.originHint = booking.originHint;
      merged.originConfirmed = false;
    }
    if (booking.originHere) merged.originConfirmed = true;
    if (booking.planAnswer) merged.planId = booking.planAnswer;
    if (booking.preferCheap) merged.preferCheap = true;
    if ('maxPrice' in booking && booking.maxPrice) merged.preferCheap = false;
    // «Запиши к первому» — только в этой реплике: следующая — уже о другом.
    merged.pickOption = Boolean(booking.pickOption);

    // «К другому врачу» — не к тому, что был назван.
    if (booking.doctorOther && !booking.doctorIds?.length && merged.doctorIds.length > 0) {
      merged.excludeDoctorIds = [...new Set([...merged.excludeDoctorIds, ...merged.doctorIds])];
      merged.doctorIds = [];
    }
    // Названные врач и клиника — до тех пор, пока не назовут других или не скажут «к любому».
    if (booking.doctorIds?.length) {
      merged.doctorIds = booking.doctorIds;
      merged.doctorChoice = Boolean(booking.doctorChoice);
      merged.foreignDoctor = false;
    } else if (booking.foreignDoctor) {
      merged.doctorIds = [];
      merged.foreignDoctor = true;
    } else if (booking.doctorAny) {
      merged.doctorIds = [];
      merged.foreignDoctor = false;
    }
    if (booking.clinicOther && !booking.branchIds?.length && merged.branchIds.length > 0) {
      merged.excludeBranchIds = [...new Set([...merged.excludeBranchIds, ...merged.branchIds.filter((id) => id.startsWith('demo-') && id !== 'demo-none')])];
      merged.branchIds = [];
      merged.clinicChoice = false;
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
    if (booking.serviceClear) {
      merged.serviceId = null;
      merged.procedureSpecialty = null;
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
    /*
     * Часы словами и с частью суток точнее разбора цифр gateway в той же реплике.
     * Противоположная граница снимается, только если она из прошлой реплики:
     * «после 18 до 10 утра» — вопрос, а не «до 10».
     */
    if (booking.spokenAfter) {
      merged.timeFrom = booking.spokenAfter;
      if (!booking.spokenBefore && !constraints.availableBefore && merged.timeTo && merged.timeTo <= booking.spokenAfter) merged.timeTo = null;
    }
    if (booking.spokenBefore) {
      merged.timeTo = booking.spokenBefore;
      if (!booking.spokenAfter && !constraints.availableAfter && merged.timeFrom && merged.timeFrom >= booking.spokenBefore) merged.timeFrom = null;
    }
    if (booking.afterWork) merged.evening = true;
    if (booking.busyUntil && booking.spokenAfter) merged.busyFrom = booking.spokenAfter;
    if (booking.nearPlace) merged.nearest = true;
    // «Работаю до 18» — не граница «до 18», которую мог прочитать gateway в той же реплике.
    if (booking.busyUntil && constraints.availableBefore && !booking.spokenBefore) merged.timeTo = null;
    // «Работаю до шести, поэтому после 19» — названное время позже конца работы: берём его.
    if (booking.busyUntil && constraints.availableAfter && constraints.availableAfter > booking.spokenAfter) merged.timeFrom = constraints.availableAfter;
    if (booking.preferTime) merged.preferTime = booking.preferTime;
    if (booking.preferWindow) merged.preferWindow = booking.preferWindow;
    else if (booking.timeAny || booking.timeOfDay || booking.timeExact || booking.timeAround || booking.spokenAfter || booking.spokenBefore
      || booking.timeWindows || booking.dayWindows || constraints.availableAfter || constraints.availableBefore) merged.preferWindow = null;
    if (booking.withinHours) merged.withinHours = booking.withinHours;
    if (booking.accessAny) {
      merged.wheelchair = false;
      merged.parking = false;
    }
    if (booking.wheelchair) merged.wheelchair = true;
    if (booking.parking) merged.parking = true;
    if (booking.preferDms) merged.preferDms = true;
    // «В пять вечера», «около семи вечера» — «вечера» здесь часть времени, а не отдельное «вечером».
    if (constraints.evening && !booking.timeExact && !booking.timeAround) {
      merged.evening = true;
      if (!booking.timeOfDay && merged.timeTo && merged.timeTo <= '17:00') merged.timeTo = null;
    }
    // «В субботу 16 октября»: «суббота» здесь — проверка даты, а не отдельное «в выходные».
    // «В пятницу 16-го или в субботу 17-го»: суббота — один из названных дней, а не «только выходные».
    const datedDays = booking.date && ['date', 'any_of', 'range'].includes(booking.date.kind) && !booking.explicitWeekend;
    if (constraints.weekend && !booking.workdays && !booking.date?.expectWeekday && !booking.suppressWeekend && !datedDays && !booking.alsoWeekend) {
      merged.weekend = true;
      merged.workdays = false;
    }

    /*
     * «После 7», «до 9» без «утра/вечера» — не выбираем: прежнее условие на
     * время заменяется вопросом, ответ придёт следующей репликой или кнопкой.
     */
    const ambiguity = booking.timeAmbiguity || constraints.timeAmbiguity;
    if (ambiguity && !booking.timeWindows && !booking.dayWindows && !booking.busyUntil) {
      merged.pendingTime = ambiguity;
      merged.timeFrom = null;
      merged.timeTo = null;
      merged.evening = false;
    } else if (explicitTime || booking.timeAny || booking.timeOfDay) {
      merged.pendingTime = null;
      merged.pendingDay = null;
      merged.pendingWindows = null;
    }
    /* У одного из дней двусмысленный час: «завтра после 7 или в четверг до обеда» — вопрос о нём. */
    if (booking.dayWindows && merged.date?.kind === 'any_of') {
      const asked = merged.date.options.findIndex((option) => Array.isArray(option.ask));
      if (asked >= 0) {
        merged.pendingTime = merged.date.options[asked].ask;
        merged.pendingDay = asked;
      }
      merged.date = { ...merged.date, options: merged.date.options.map(({ ask: _ask, ...option }) => option) };
    }
    /*
     * «Работаю до 19» → «и в выходные тоже можно»: будни — после 19:00,
     * выходные — в любое время.
     */
    if (booking.alsoWeekend) {
      const from = merged.busyFrom && merged.timeFrom === merged.busyFrom ? merged.busyFrom : null;
      if (from || merged.workdays) {
        merged.date = {
          kind: 'any_of',
          options: [1, 2, 3, 4, 5].map((weekday) => ({ kind: 'weekday', weekday, ...(from ? { from, to: merged.timeTo } : {}) }))
            .concat([{ kind: 'weekday', weekday: 6 }, { kind: 'weekday', weekday: 7 }]),
        };
        merged.timeFrom = null;
        merged.timeTo = null;
        merged.workdays = false;
        merged.weekend = false;
        booking = { ...booking, dayWindows: Boolean(from) };
      } else {
        merged.workdays = false;
      }
    }
    // У каждого дня своё окно — общие границы этой реплики не действуют.
    if (booking.dayWindows) {
      merged.timeFrom = null;
      merged.timeTo = null;
      merged.evening = false;
      merged.timeWindows = null;
      merged.preferTime = null;
    } else if (merged.date?.kind === 'any_of' && merged.date.options.some((option) => option.from || option.to)
      && (booking.timeAny || booking.timeOfDay || booking.timeExact || booking.timeAround || booking.spokenAfter || booking.spokenBefore
        || booking.timeWindows || constraints.availableAfter || constraints.availableBefore || constraints.evening)) {
      // Новое время в следующей реплике — для всех дней сразу.
      merged.date = { ...merged.date, options: merged.date.options.map(withoutDayWindow) };
    }
    // Окна через «или» — условие на время этой реплики целиком; новое время в следующей реплике их снимает.
    if (booking.timeWindows) {
      merged.timeWindows = booking.timeWindows;
      merged.timeFrom = null;
      merged.timeTo = null;
      merged.evening = false;
      merged.preferTime = null;
      if (booking.windowAsk) {
        merged.pendingTime = booking.windowAsk;
        merged.pendingWindows = booking.timeWindows;
        merged.timeWindows = null;
      }
    } else if (booking.timeAny || booking.timeOfDay || booking.timeExact || booking.timeAround || booking.spokenAfter || booking.spokenBefore
      || constraints.availableAfter || constraints.availableBefore || constraints.evening) {
      merged.timeWindows = null;
    }

    // «Можно и платно» после «по ДМС» — ДМС становится пожеланием: покрытые первыми.
    if (booking.allowPaid && merged.dms === true) merged.preferDms = true;
    if (booking.dms === false) merged.dms = false;
    else if (booking.dms === true || constraints.dmsOnly) merged.dms = true;

    if (booking.travelAny) {
      merged.maxTravelMinutes = null;
      merged.nearest = false;
      merged.originHint = null;
    }
    if (Number.isInteger(constraints.maxTravelMinutes)) merged.maxTravelMinutes = constraints.maxTravelMinutes;
    else if (Number.isInteger(booking.maxTravelMinutes)) merged.maxTravelMinutes = booking.maxTravelMinutes;
    if (constraints.travelMode) merged.travelMode = constraints.travelMode;
    if (constraints.selection === 'nearest' && !booking.nearestIsTime) merged.nearest = true;
  }

  return merged;
};
