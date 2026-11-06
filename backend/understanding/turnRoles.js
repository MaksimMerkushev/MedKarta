/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Роли частей реплики. Условия записи разбираются правилами, но не из всего текста:
 * «с утра тошнит» — про симптом, а не про время приёма, «работаю в Авиастроительном
 * районе» — про человека, а не про место поиска. Поэтому реплика сначала делится на
 * части, и правила условий видят только то, что относится к записи.
 *
 * Роли:
 *   complaint  — жалоба с её временем и длительностью: условий записи здесь нет;
 *   biography  — рассказ о себе: место здесь не становится условием поиска;
 *   request    — всё остальное: врач, день, время, цена, ДМС, место поиска.
 *
 * Сомнение толкуется в пользу роли request только при явном признаке записи. Без него
 * фраза с симптомом остаётся жалобой: лучше спросить, чем молча сузить подбор.
 */

import { classifySymptoms } from '../privacy/symptoms.js';

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const SYMPTOM_PREDICATE = new RegExp(`${B}(?:бол(?:ит|ят|ело|ела|ел|ели|ь|и|ью|ей)|заболе\\p{L}*|заболит|побаливает|ноет|ноют|тошнит|подташнивает|тошнот\\p{L}*|рвет|рвот\\p{L}*|кружит\\p{L}*|поднимает\\p{L}*|повышает\\p{L}*|падает|скачет|кашля\\p{L}*|кашель|кашл\\p{L}*|чешет\\p{L}*|чешут\\p{L}*|зудит|зуд|жжет|жжени\\p{L}*|колет|колют|тянет|режет|ломит|сводит|немеет|немеют|онемел\\p{L}*|отекл\\p{L}*|отекает|опух\\p{L}*|закладывает|заложи\\p{L}*|заложе\\p{L}*|слезят\\p{L}*|темнеет|кровит|температур\\p{L}*|давлени\\p{L}*|сып\\p{L}*|насморк\\p{L}*|слабост\\p{L}*|бессонниц\\p{L}*|упал\\p{L}*|ударил\\p{L}*|подвернул\\p{L}*|обострил\\p{L}*|дтп|авари\\p{L}*|травм(?:а|ы|е|у|ой|ирован\\p{L}*|ировал\\p{L}*)|беспокоит|мучает|мучают|началось|началась|начался|не\\s+сплю|плохо\\s+сплю)${E}`, 'u');

/* Признак просьбы о записи. С ним время и место в той же части относятся к приёму. */
const BOOKING_CUE = new RegExp(`${B}(?:\\p{L}+(?:олог|иатр|ирург|апевт|опед)\\p{L}*|травмпункт\\p{L}*|лор\\p{L}{0,2}|врач\\p{L}{0,3}|доктор\\p{L}{0,3}|запиш\\p{L}*|запис\\p{L}*|при[еа]м\\p{L}*|попасть|сходить|прийти|приду|приехать|хочу|хотел\\p{L}*|нужен|нужна|нужно|нужны|найди\\p{L}*|подбери\\p{L}*|подберите|ищу|смогу|свободн\\p{L}*|завтра|послезавтра|дмс|омс|страхов\\p{L}*|полис\\p{L}*|рублей|руб|₽|стоимост\\p{L}*|дешевл\\p{L}*|на\\s+машин\\p{L}*|пешком|поближе|ближе|на\\s+(?:сегодня|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|к\\s+\\p{L}+(?:логу|педу|апевту|иатру|ирургу|лору|врачу|доктору))${E}`, 'u');
const CAN_I = new RegExp(`${B}можно${E}`, 'u');

const BIOGRAPHY = new RegExp(`${B}(?:работаю|работает|учусь|учится|служу|преподаю|живу|живем|проживаю|прописан\\p{L}*|у\\s+меня\\s+офис|мой\\s+офис|ходит\\s+в\\s+(?:школу|сад|садик)|хожу\\s+в\\s+(?:школу|сад|садик)|завуч\\p{L}*|учител\\p{L}*|директор\\p{L}*|преподавател\\p{L}*|водител\\p{L}*|школ\\p{L}*|гимнази\\p{L}*|лице[йя]\\p{L}*|университет\\p{L}*|институт\\p{L}*|завод\\p{L}*|компани\\p{L}*|фирм\\p{L}*)${E}`, 'u');
const WANTS_NEAR_WORK = new RegExp(`${B}(?:рядом|недалеко|возле|около|поближе|ближе)(?:\\s+(?:с|со|от|к))?\\s+(?:работ\\p{L}*|офис\\p{L}*)${E}`, 'u');
const WORK = new RegExp(`${B}(?:работаю|у\\s+меня\\s+офис|мой\\s+офис)${E}`, 'u');
// Место в рассказе о себе. Дни и смены — не место: «работаю в понедельник до 15» остаётся условием.
const PLACE_IN_BIOGRAPHY = /(^|\s)(?:в|во|на|около|возле|рядом\s+с|рядом\s+со|недалеко\s+от|у)\s+(?!(?:понедельник|вторник|сред[уы]|четверг|пятниц|суббот|воскресень|будни|выходн|смен|ночь|ноч|утро|день|вечер|\d)\S*)(.+?)(?=\s+(?:до|после|с|к)\s+\d|$)/iu;
// «Живу у вокзала»: о доме правила условий знают сами и спросят, откуда считать путь.
const HOME = new RegExp(`${B}(?:живу|живем|проживаю|прописан\\p{L}*)${E}`, 'u');

/* «…и до вечера»: продолжение времени симптома, без своего сказуемого. */
const TIME_ONLY = new RegExp(`^(?:(?:с|со|до|после|к|по)\\s+)?(?:утра|вечера|обеда|ночи|вечером|утром|ночью|днем)${E}`, 'u');

const prepare = (text) => String(text || '').toLowerCase().replace(/ё/gu, 'е');

const isComplaint = (lower) => {
  if (SYMPTOM_PREDICATE.test(lower)) return true;
  try {
    return Boolean(classifySymptoms(lower)?.complaint);
  } catch {
    return false;
  }
};

/**
 * Части реплики с ролями; разделители сохранены, чтобы текст можно было собрать обратно.
 *
 * @param {string} text реплика пользователя
 * @returns {Array<{text: string, separator: string, role: 'complaint'|'biography'|'request'}>}
 */
export const segmentTurn = (text) => {
  const pieces = String(text || '').split(/([.!?;\n]+|,|\s+(?:и|а|но)\s+)/u);
  const segments = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const clause = pieces[index] || '';
    const separator = pieces[index + 1] || '';
    const lower = prepare(clause).trim();
    if (!lower) {
      segments.push({ text: clause, separator, role: 'request' });
      continue;
    }
    const previous = segments[segments.length - 1];
    const joinedByAnd = previous && /^\s+(?:и|а|но)\s+$/u.test(previous.separator);
    let role = 'request';
    if (BIOGRAPHY.test(lower) && !isComplaint(lower)) role = 'biography';
    else if (isComplaint(lower) && !BOOKING_CUE.test(lower) && !(CAN_I.test(lower) && !SYMPTOM_PREDICATE.test(lower))) role = 'complaint';
    else if (joinedByAnd && previous.role === 'complaint' && TIME_ONLY.test(lower)) role = 'complaint';
    segments.push({ text: clause, separator, role });
  }
  return segments;
};

/**
 * Текст для правил условий записи: части с жалобой заменены пробелами, в рассказе о себе
 * убрано место. Если просят врача рядом с работой, место работы становится местом поиска:
 * об этом сказано прямо.
 *
 * @param {string} text реплика пользователя
 * @param {{blanks?: string[]}} [options] фрагменты, которые модель отнесла к симптому или биографии
 */
export const bookingView = (text, { blanks = [] } = {}) => {
  const segments = segmentTurn(text);
  const wantsNearWork = WANTS_NEAR_WORK.test(prepare(text));
  let workPlace = null;
  let view = segments.map((segment) => {
    if (segment.role === 'complaint') return ' '.repeat(segment.text.length) + segment.separator;
    if (segment.role === 'biography') {
      if (HOME.test(prepare(segment.text))) return segment.text + segment.separator;
      const place = segment.text.match(PLACE_IN_BIOGRAPHY);
      if (place && WORK.test(prepare(segment.text))) workPlace = place[2].trim();
      return segment.text.replace(PLACE_IN_BIOGRAPHY, (whole) => ' '.repeat(whole.length)) + segment.separator;
    }
    return segment.text + segment.separator;
  }).join('');
  if (wantsNearWork && workPlace) view = `${view} рядом с ${workPlace}`;
  for (const blank of blanks) {
    if (typeof blank === 'string' && blank.trim()) view = view.split(blank).join(' '.repeat(blank.length));
  }
  return view;
};

/** Жалоба из реплики — только для локального представления запроса, в журналы не идёт. */
export const complaintParts = (text) => segmentTurn(text).filter((segment) => segment.role === 'complaint').map((segment) => segment.text.trim());

/* «Нужен кардиолог завтра. Хотя нет, болит колено»: одна реплика, но две мысли. */
const CORRECTION = /(?:^|[.!?,;]\s*|\s)(хотя\s+нет|а\s+нет|или\s+нет|нет,?\s+стоп|передумал\p{L}*)[,.:!\s]+/iu;

/** Реплика с исправлением внутри — как две реплики подряд. */
export const expandCorrections = (messages) => messages.flatMap((message) => {
  const content = String(message.content || '');
  const match = content.match(CORRECTION);
  if (!match || match.index < 3) return [message];
  const before = content.slice(0, match.index).trim();
  const after = content.slice(match.index + match[0].length).trim();
  if (before.length < 2 || after.length < 2) return [message];
  return [{ ...message, content: before }, { ...message, content: after }];
});
