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
 *   narrative  — время или место внутри рассказа о другом: «сегодня сильнее», «езжу через
 *                Ново-Савиновский район». Условием это не становится;
 *   request    — всё остальное: врач, день, время, цена, ДМС, место поиска.
 *
 * Жалоба и рассказ определяются по явным признакам, в остальном действует request.
 * Обратное правило (условие только в явной просьбе) проверялось и отвергнуто: оно теряло
 * настоящие условия вроде «а есть кто-то после 18». Необычно сказанное время симптома
 * разбирает модель: она может снять условие, указав его фрагмент (см. applyModelRoles).
 */

import { KAZAN_PLACES } from '../../shared/kazanPlaces.js';
import { classifySymptoms } from '../privacy/symptoms.js';

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const SYMPTOM_PREDICATE = new RegExp(`${B}(?:бол(?:ит|ят|ело|ела|ел|ели|ь|и|ью|ей)|заболе\\p{L}*|заболит|побаливает|ноет|ноют|тошнит|подташнивает|тошнот\\p{L}*|рвет|рвот\\p{L}*|кружит\\p{L}*|поднимает\\p{L}*|повышает\\p{L}*|падает|скачет|кашля\\p{L}*|кашель|кашл\\p{L}*|чешет\\p{L}*|чешут\\p{L}*|зудит|зуд|жжет|жжени\\p{L}*|колет|колют|тянет|режет|ломит|сводит|немеет|немеют|онемел\\p{L}*|отекл\\p{L}*|отекает|опух\\p{L}*|закладывает|заложи\\p{L}*|заложе\\p{L}*|слезят\\p{L}*|темнеет|кровит|температур\\p{L}*|давлени\\p{L}*|сып\\p{L}*|насморк\\p{L}*|слабост\\p{L}*|бессонниц\\p{L}*|простуд\\p{L}*|продуло|шумит|шум|звенит|першит|щиплет|стреляет|пульсирует|дергает|хрипит|сипит|печет|сушит|щемит|покалывает|жмет|давит|распирает|мутит|знобит|лихорадит|упал\\p{L}*|ударил\\p{L}*|подвернул\\p{L}*|обострил\\p{L}*|дтп|авари\\p{L}*|травм(?:а|ы|е|у|ой|ирован\\p{L}*|ировал\\p{L}*)|беспокоит|мучает|мучают|началось|началась|начался|не\\s+сплю|плохо\\s+сплю)${E}`, 'u');

/* Признак просьбы о записи. С ним время и место в той же части относятся к приёму. */
const BOOKING_CUE = new RegExp(`${B}(?:\\p{L}+(?:олог|иатр|ирург|апевт|опед)\\p{L}*|окулист\\p{L}*|травмпункт\\p{L}*|лор\\p{L}{0,2}|врач\\p{L}{0,3}|доктор\\p{L}{0,3}|запиш\\p{L}*|запис\\p{L}*|при[еа]м\\p{L}*|попасть|сходить|прийти|приду|приехать|хочу|хотел\\p{L}*|нужен|нужна|нужно|нужны|найди\\p{L}*|подбери\\p{L}*|подберите|ищу|смогу|свободн\\p{L}*|завтра|послезавтра|дмс|омс|страхов\\p{L}*|полис\\p{L}*|рублей|руб|₽|стоимост\\p{L}*|дешевл\\p{L}*|на\\s+машин\\p{L}*|пешком|поближе|ближе|на\\s+(?:сегодня|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)|к\\s+\\p{L}+(?:логу|педу|апевту|иатру|ирургу|лору|врачу|доктору))${E}`, 'u');
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

/* Время, день или район: только в такой части рассказ можно спутать с условием записи. */
const CONDITION_TOKEN = new RegExp(`${B}(?:сегодня|завтра|послезавтра|утр\\p{L}*|вечер\\p{L}*|днем|ноч\\p{L}*|обед\\p{L}*|понедельник\\p{L}*|вторник\\p{L}*|сред[ауеы]|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*|выходн\\p{L}*|район\\p{L}*|\\d{1,2}(?::\\d{2})?)${E}`, 'u');
/* Признаки рассказа: как меняется состояние и перемещения, не связанные с приёмом. */
const NARRATIVE = new RegExp(`${B}(?:сильнее|хуже|слабее|легче|нормально|отпусти\\p{L}*|отпускает|стало|становится|прошл[оаи]|прошел|усилил\\p{L}*|усилива\\p{L}*|езжу|проезжа\\p{L}*|мимо|через\\s+\\p{L}+(?:-\\p{L}+)?\\s+район\\p{L}*|гуля\\p{L}*|бываю)${E}`, 'u');

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
 * @returns {Array<{text: string, separator: string, role: 'complaint'|'biography'|'narrative'|'request'}>}
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
    else if (NARRATIVE.test(lower) && CONDITION_TOKEN.test(lower) && !BOOKING_CUE.test(lower)) role = 'narrative';
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
    if (segment.role === 'complaint' || segment.role === 'narrative') return ' '.repeat(segment.text.length) + segment.separator;
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

/* Явная просьба о записи: специальность, «запишите», «нужен врач». */
const REQUEST_CUE = new RegExp(`${B}(?:\\p{L}+(?:олог|иатр|ирург|апевт|опед)\\p{L}*|окулист\\p{L}*|травмпункт\\p{L}*|лор\\p{L}{0,2}|врач\\p{L}{0,3}|доктор\\p{L}{0,3}|запиш\\p{L}*|запис\\p{L}*|при[еа]м\\p{L}*|нужен|нужна|нужно|хочу|хотел\\p{L}*|найди\\p{L}*|подбери\\p{L}*|подберите|ищу|попасть)${E}`, 'u');
/* Слова, из которых состоит условие, сказанное само по себе: «сегодня вечером», «рядом с Кремлём». */
const CONDITION_WORD = new RegExp(`^(?:сегодня|завтра|послезавтра|утр\\p{L}*|вечер\\p{L}*|днем|день|дня|ноч\\p{L}*|обед\\p{L}*|понедельник\\p{L}*|вторник\\p{L}*|сред[ауеы]|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*|воскресень\\p{L}*|выходн\\p{L}*|будн\\p{L}*|недел\\p{L}*|час\\p{L}*|минут\\p{L}*|руб\\p{L}*|тыс\\p{L}*|район\\p{L}*|дом\\p{L}*|работ\\p{L}*|рядом|около|возле|недалеко|поближе|ближе|с|со|до|после|в|во|на|к|от|у|по|и|а|но|или|лучше|желательно|можно|пожалуйста|тогда|только|мне|бы|ну|да|если|еще|уже|любой|любое|\\d+(?::\\d{2})?)$`, 'u');
const PLACE_NAMES = Object.values(KAZAN_PLACES).map((place) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${place.pattern})(?![\\p{L}\\p{N}])`, 'gu'));
const isBareCondition = (lower) => {
  let rest = lower.replace(/\p{L}+(?:ом|ем|ой|ий|ый)\s+район\p{L}*/gu, ' ');
  for (const pattern of PLACE_NAMES) rest = rest.replace(pattern, ' ');
  return (rest.match(/[\p{L}\p{N}:]+/gu) || []).every((word) => CONDITION_WORD.test(word));
};

/**
 * Условие, сказанное прямо, догадка модели снять не может. Это так, если фрагмент стоит
 * отдельной частью-просьбой («сыпь на руках, сегодня вечером») или в части с явной просьбой
 * о записи («нужен лор сегодня вечером»). Модель ошибается и в простых фразах: на настоящей
 * модели «сегодня вечером» в первом примере было отмечено как время симптома.
 *
 * @param {string} text исходная реплика пользователя
 * @param {string} fragment фрагмент, который модель отнесла к симптому, событию или биографии
 */
export const isExplicitRequest = (text, fragment) => {
  const needle = prepare(fragment).trim();
  if (!needle) return false;
  return segmentTurn(text).some((segment) => {
    if (segment.role !== 'request') return false;
    const lower = prepare(segment.text);
    const at = lower.indexOf(needle);
    if (at < 0) return false;
    return REQUEST_CUE.test(lower) || isBareCondition(lower);
  });
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
