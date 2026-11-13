/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Текст жалобы для внешней модели. Текст не обрезается: фраза остаётся целой, чтобы
 * сохранились отрицания, длительность, локализация и характер симптомов. Заменяются
 * только сведения, указывающие на человека: метка вместо значения, а роль этого места
 * в предложении модели видна. Работа и возраст остаются, если сами по себе не указывают
 * на человека: «работаю на заводе с химией» важно для врача, а «главврач больницы № 7» —
 * уже почти имя. Подробности метки значат только на этом сервере.
 *
 * Важно: это снижение риска, а не гарантия анонимности. Программа может не распознать
 * необычное описание человека. Поэтому явные признаки редких обстоятельств и особые
 * диагнозы наружу не уходят вовсе, а итог сверяется с выходным предохранителем
 * (assertOutboundSafe в planner/client.js).
 */

import { KAZAN_PLACES } from '../../shared/kazanPlaces.js';
import { classifySymptoms, SENSITIVE_RULE_IDS } from './symptoms.js';
import { isMedicalWord, MEDICAL_ABBREVIATION } from './medicalLexicon.js';
import { nearNameSpans, recognizePii } from './ruRecognizers.js';
import { applySpans } from './spanMask.js';

const prepare = (text) => String(text || '').toLowerCase().replace(/ё/gu, 'е');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

/* Диагнозы, которые опасно раскрывать даже без имени: такую реплику разбирает только сервер. */
const SENSITIVE = new RegExp(`${B}(?:вич|спид|гепатит\\p{L}*|сифилис\\p{L}*|гоноре\\p{L}*|хламиди\\p{L}*|туберкул\\p{L}*|наркоман\\p{L}*|наркотик\\p{L}*|алкоголи\\p{L}*|шизофрен\\p{L}*|биполяр\\p{L}*|психоз\\p{L}*|психиатр\\p{L}*|аборт\\p{L}*|бесплоди\\p{L}*|изнасил\\p{L}*|суицид\\p{L}*)${E}`, 'u');
/* Тот же перечень, что у локального классификатора (symptoms.js): список один на всю систему. */
export const hasSensitiveCondition = (text) => {
  const lower = prepare(text);
  if (SENSITIVE.test(lower)) return true;
  return classifySymptoms(lower).matchedRules.some((id) => SENSITIVE_RULE_IDS.includes(id));
};

/* Редкое обстоятельство указывает на человека и без имени: при сомнении текст не передаётся. */
const RARE_CIRCUMSTANCE = new RegExp(`${B}(?:единственн\\p{L}*|известн(?:ый|ая)|знаменит\\p{L}*|чемпион\\p{L}*|олимпийск\\p{L}*|народн(?:ый|ая)\\s+артист\\p{L}*|тройн(?:я|ю|ей|е)|аварийн\\p{L}*\\s+посадк\\p{L}*|член\\p{L}*\\s+сборн\\p{L}*|сборн\\p{L}*\\s+росси\\p{L}*|1[0-2]\\d\\s*(?:год|года|лет)|ведущ(?:ая|ий|ей|его)\\s+(?:новостей|эфира|программы|передачи)|диктор\\p{L}*|пожар\\p{L}*|взрыв\\p{L}*|теракт\\p{L}*|обрушени\\p{L}*)${E}`, 'u');
export const hasRareCircumstance = (text) => RARE_CIRCUMSTANCE.test(prepare(text));

/*
 * Номера. Детекторы Gateway узнают СНИЛС, ОМС и паспорт в привычном виде, но номер полиса ДМС
 * пишут как угодно («001-ДМС-778899»). Поэтому здесь два правила поверх детекторов:
 * - рядом слово «полис», «паспорт», «договор»… и номер из 4+ цифр — реплика наружу не уходит,
 *   как и с распознанным номером документа;
 * - любой другой номер из 6+ цифр или буквы вместе с 4+ цифрами заменяется меткой.
 * Давление «160/100», температура «38.5», время, год, дозировка и цена остаются: они бывают
 * нужны для жалобы и на человека не указывают.
 */
const DIGIT_WORDS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const DOCUMENT_WORD = new RegExp(`${B}(?:полис\\p{L}*|паспорт\\p{L}*|загран\\p{L}*|снилс\\p{L}*|инн|огрн\\p{L}*|свидетельств\\p{L}*|свид-во|удостоверени\\p{L}*|договор\\p{L}*|медкарт\\p{L}*|прав[аы]|омс|дмс|ву)${E}`, 'u');
const CODE_TOKEN = /[\p{L}\p{N}]+(?:[-/][\p{L}\p{N}]+)*/gu;
const NOT_CODE = /^(?:\d{2,3}\/\d{2,3}|\d{4}(?:г|гг|год\p{L}*)?|\d+(?:мг|мкг|мл|г|кг|см|мм|ед))$/u;
const SPACED_NUMBER = /(?<![\p{L}\p{N}])\d{2,}(?:[ -]\d{2,}){2,}(?![\p{L}\p{N}])/gu;
const digitCount = (value) => (value.match(/\d/gu) || []).length;
const isCode = (token) => {
  const lower = prepare(token);
  if (NOT_CODE.test(lower)) return false;
  const digits = digitCount(lower);
  return digits >= 6 || (digits >= 4 && /\p{L}/u.test(lower));
};

/** Номер документа, полиса или договора в любом написании: такую реплику разбирает только сервер. */
export const hasDocumentNumber = (text) => {
  const lower = prepare(text);
  // Номер, где часть цифр заменена звёздочками («2*9709», «34 *3**900»), — почти всегда документ.
  if (/\d[\d\s-]{0,3}\*|\*[\d\s-]{0,3}\d/u.test(lower) && (lower.match(/\d/gu) || []).length >= 4) return true;
  if (!DOCUMENT_WORD.test(lower)) return false;
  // «1655 4400 1234 5678», «92 04 123456»: группы цифр через пробел или дефис — один номер.
  // Цифры словами и звёздочки вместо части цифр («92** ***456») — тоже номер.
  // Суммы, время, расстояния и дозировки («по ДМС до 3000 рублей») — не номер документа.
  const withoutUnits = lower.replace(/(?<![\d\s])\d[\d\s]{0,12}(?=\s*(?:руб|₽|р\.|тыс|мин|час|км|мг|мл|мкг|ед\b|лет|год))/gu, ' ');
  const spelled = withoutUnits.replace(/(?<![\p{L}])(ноль|нуль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять)(?![\p{L}])/gu, (w) => String(DIGIT_WORDS.indexOf(w) >= 0 ? DIGIT_WORDS.indexOf(w) : 1));
  const unmasked = spelled.replace(/[*#xх](?=[\d*#xх\s.-]{0,12}\d)|(?<=\d[\s.-]{0,3})[*#xх]/gu, '0');
  if (/(?<![\p{L}])[ivxl]{1,4}-[а-я]{2}\s?\d/u.test(lower)) return true;
  const joined = unmasked.replace(/(\d)[ .\-\n/]+(?=\d)/gu, '$1');
  return (joined.match(CODE_TOKEN) || []).some((token) => digitCount(token) >= 4 && !NOT_CODE.test(token));
};

const maskCodes = (text) => text
  .replace(SPACED_NUMBER, (match) => (digitCount(match) >= 8 ? '[номер]' : match))
  .replace(CODE_TOKEN, (token) => (isCode(token) ? '[номер]' : token));

const TOKEN_LABEL = {
  PERSON: '[имя]', DOCTOR: '[врач]', CLINIC: '[клиника]', PHONE: '[телефон]', EMAIL: '[почта]',
  URL: '[ссылка]', HANDLE: '[аккаунт]', ADDRESS: '[адрес]', CARD: '[номер]', DOCUMENT: '[номер]',
};

const MEDICAL_ABBREVIATIONS = new Set(['МРТ', 'КТ', 'УЗИ', 'ЭКГ', 'ЭЭГ', 'ЛОР', 'ДМС', 'ОМС', 'ОРВИ', 'ОРЗ', 'АД', 'ЖКТ', 'ВСД', 'ЭКО', 'ДТП', 'СОЭ', 'ИМТ']);

const INSURER = new RegExp(`${B}(?:сбер\\s*-?\\s*страхован\\p{L}*|согаз\\p{L}*|ресо(?:\\s*-?\\s*гаранти\\p{L}*)?|ингосстрах\\p{L}*|альфа\\s*-?\\s*страхован\\p{L}*|росгосстрах\\p{L}*|энергогарант\\p{L}*|втб\\s*-?\\s*страхован\\p{L}*|ренессанс\\s+страхован\\p{L}*|т\\s*-\\s*страхован\\p{L}*|тинькофф\\s*-?\\s*страхован\\p{L}*|совкомбанк\\s*-?\\s*страхован\\p{L}*)${E}`, 'gu');
const TITLE = new RegExp(`${B}(?:завуч\\p{L}*|директор\\p{L}*|главврач\\p{L}*|главн\\p{L}*\\s+(?:врач|медсестр|инженер|бухгалтер|редактор|архитектор|энергетик|механик|технолог|тренер)\\p{L}*|заместител\\p{L}*|замглав\\p{L}*|руководител\\p{L}*|председател\\p{L}*|губернатор\\p{L}*|президент\\p{L}*|депутат\\p{L}*|мэр\\p{L}*|судь\\p{L}*|глав[аеуы]\\s+(?:\\p{L}+\\s+)?(?:района|города|администрации|поселения|республики)|капитан\\p{L}*\\s+(?:\\p{L}+\\s+)?команды|прокурор\\p{L}*|министр\\p{L}*|ректор\\p{L}*|декан\\p{L}*|заведующ\\p{L}*|начальник\\p{L}*|сенатор\\p{L}*|полковник\\p{L}*|генерал\\p{L}*|следовател\\p{L}*)${E}`, 'gu');
const INSTITUTION = new RegExp(`${B}(?:прокуратур\\p{L}*|госсовет\\p{L}*|министерств\\p{L}*|мэри\\p{L}*|администраци\\p{L}*|следственн\\p{L}*\\s+комитет\\p{L}*)${E}`, 'gu');
const PLACE_PATTERNS = [
  ...Object.values(KAZAN_PLACES).map((place) => new RegExp(`${B}(?:${place.pattern})${E}`, 'gu')),
  new RegExp(`${B}\\p{L}+(?:ом|ем)\\s+район\\p{L}*${E}`, 'gu'),
  new RegExp(`${B}(?:район\\p{L}*\\s+)?(?:азино|дербышк\\p{L}*|соцгород\\p{L}*|танкодром\\p{L}*|юдин\\p{L}*|авиастро\\p{L}*\\s+район\\p{L}*|ново-?савинов\\p{L}*)${E}`, 'gu'),
  new RegExp(`${B}(?:улиц\\p{L}*|ул\\.?|проспект\\p{L}*|пр-т\\p{L}*|переул\\p{L}*|бульвар\\p{L}*|микрорайон\\p{L}*)\\s+\\p{L}[\\p{L}-]*${E}`, 'gu'),
];
/* «Работаю в Газпроме»: название организации пишут с заглавной. */
const NAMED_ORG = /((?:[Рр]абота(?:ю|ет|ем)|[Уу]ч(?:усь|ится)|[Сс]луж(?:у|ит))\s+(?:в|во|на)\s+)[«"]?(\p{Lu}[\p{L}-]+)[»"]?/gu;
const QUOTED = /«[^»]{2,40}»/gu;
const ALL_CAPS = /(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu;
const NUMBERED = /№\s*\d+/gu;
const NUMBERED_PLACE = /((?:школ|гимнази|лице|больниц|поликлиник|детск\p{L}*\s+сад|сад)\p{L}*)\s+(?:номер\s+)?\d+/giu;
/*
 * Имена собственные пишут с заглавной: «в банке Акибанк», «соседка Галина». В середине
 * фразы такое слово заменяется меткой. Если строчными написано название, программа его не
 * отличит от обычного слова: это известное ограничение, см. начало файла.
 */
const MID_SENTENCE_NAME = /(?<=[\p{L}\p{N},:)»"\]]\s+)\p{Lu}\p{Ll}{2,}(?:-\p{Lu}?\p{Ll}+)?/gu;
const COMMON_NAMES = new RegExp(`^(?:казан\\p{L}*|россии|росси\\p{L}*|паркинсон\\p{L}*|альцгеймер\\p{L}*|бехтерев\\p{L}*|крон\\p{L}*|квинке|хашимото|рейно|меньер\\p{L}*)$`, 'u');
/* «У мужа гастрит, а у меня кашель»: чужое состояние не нужно для выбора врача этому человеку. */
const OTHER_PERSON = /(^|[.!?;]\s*)[Уу]\s+(?:муж|жен|мам|матер|пап|отц|брат|сестр|сын|доч|бабушк|дедушк|сосед|подруг|друг|коллег|свекр|тещ|тёщ|зят|невестк)\p{L}*\s+[^.!?;,]*,\s*(а\s+у\s+меня)/gu;
const FULL_DATE = /(?<![\d.])\d{1,2}[./]\d{1,2}[./]\d{2,4}(?![\d.])/gu;
const CAR_PLATE = /(?<![\p{L}\p{N}])[АВЕКМНОРСТУХ]\s?\d{3}\s?[АВЕКМНОРСТУХ]{2}\s?\d{2,3}(?![\p{L}\p{N}])/giu;

/** Заменить совпадения на метку; регистр и «ё» при поиске не важны, длина текста сохраняется при подготовке. */
const replaceSpans = (text, pattern, label) => {
  const lower = prepare(text);
  const spans = [...lower.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => [match.index, match.index + match[0].length]);
  let result = text;
  for (const [start, end] of spans.reverse()) {
    result = `${result.slice(0, start)}${typeof label === 'function' ? label(text.slice(start, end)) : label}${result.slice(end)}`;
  }
  return result;
};

/**
 * @param {string} text реплика после редактуры Gateway (метки вида @PERSON_A вместо имён)
 * @param {object} [state] общий счётчик мест на весь диалог: { places: Map<метка, исходный текст> }
 * @returns {{text: string, blocked: boolean, reason: string|null}}
 */
export const deidentifyComplaint = (text, state = { places: new Map() }) => {
  const source = String(text || '');
  if (hasRareCircumstance(source)) return { text: '', blocked: true, reason: 'rare_circumstance' };
  if (hasDocumentNumber(source)) return { text: '', blocked: true, reason: 'document_number' };
  let result = source.replace(/@([A-Z]+)(?:_[A-Z0-9]+)?/gu, (whole, kind) => TOKEN_LABEL[kind] || '[место]');
  // «Нурисламова-Вандербильт»: Gateway заменил часть фамилии, вторая часть через дефис — тоже имя.
  // Слово перед меткой ищется только с начала слова: иначе на длинном слове перебор квадратичный.
  result = result.replace(/\[имя\]-\p{L}+/gu, '[имя]').replace(/(?<!\p{L})\p{L}+-\[имя\]/gu, '[имя]');
  // Детерминированные распознаватели РФ: имена строчными, организации после «работаю в»,
  // телефоны словами, почта с заменами, ники, закодированные строки, адреса (ruRecognizers.js).
  result = applySpans(result, recognizePii(result)).text;
  result = applySpans(result, nearNameSpans(result)).text;
  result = replaceSpans(result, CAR_PLATE, '[номер]');
  result = result.replace(FULL_DATE, '[дата]');
  result = maskCodes(result);
  result = replaceSpans(result, INSURER, '[страховая]');
  result = replaceSpans(result, TITLE, '[должность]');
  result = replaceSpans(result, INSTITUTION, '[организация]');
  result = result.replace(NUMBERED_PLACE, '$1').replace(NUMBERED, '');
  result = result.replace(NAMED_ORG, (whole, prefix) => `${prefix}[организация]`);
  result = result.replace(OTHER_PERSON, '$1[о другом человеке], $2');
  result = result.replace(QUOTED, '[название]');
  result = result.replace(ALL_CAPS, (word) => (MEDICAL_ABBREVIATIONS.has(word) || MEDICAL_ABBREVIATION(word) ? word : '[организация]'));
  for (const pattern of PLACE_PATTERNS) {
    result = replaceSpans(result, pattern, (raw) => {
      const label = `[место_${state.places.size + 1}]`;
      state.places.set(label, raw);
      return label;
    });
  }
  const words = result.match(/\p{L}{3,}/gu) || [];
  const capitalized = words.filter((word) => /^\p{Lu}/u.test(word)).length;
  // Каждое слово с заглавной — манера письма, а не название.
  if (capitalized <= Math.max(2, words.length / 2)) {
    result = result.replace(MID_SENTENCE_NAME, (word) => (COMMON_NAMES.test(prepare(word)) || isMedicalWord(word) ? word : '[название]'));
  }
  return { text: result.replace(/\s+/gu, ' ').replace(/\s+([.,;!?])/gu, '$1').trim(), blocked: false, reason: null };
};
