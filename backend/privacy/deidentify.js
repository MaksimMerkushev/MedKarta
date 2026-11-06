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

const prepare = (text) => String(text || '').toLowerCase().replace(/ё/gu, 'е');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

/* Диагнозы, которые опасно раскрывать даже без имени: такую реплику разбирает только сервер. */
const SENSITIVE = new RegExp(`${B}(?:вич|спид|гепатит\\p{L}*|сифилис\\p{L}*|гоноре\\p{L}*|хламиди\\p{L}*|туберкул\\p{L}*|наркоман\\p{L}*|наркотик\\p{L}*|алкоголи\\p{L}*|шизофрен\\p{L}*|биполяр\\p{L}*|психоз\\p{L}*|психиатр\\p{L}*|аборт\\p{L}*|бесплоди\\p{L}*|изнасил\\p{L}*|суицид\\p{L}*)${E}`, 'u');
export const hasSensitiveCondition = (text) => SENSITIVE.test(prepare(text));

/* Редкое обстоятельство указывает на человека и без имени: при сомнении текст не передаётся. */
const RARE_CIRCUMSTANCE = new RegExp(`${B}(?:единственн\\p{L}*|известн(?:ый|ая)|знаменит\\p{L}*|чемпион\\p{L}*|олимпийск\\p{L}*|народн(?:ый|ая)\\s+артист\\p{L}*)${E}`, 'u');
export const hasRareCircumstance = (text) => RARE_CIRCUMSTANCE.test(prepare(text));

const TOKEN_LABEL = {
  PERSON: '[имя]', DOCTOR: '[врач]', CLINIC: '[клиника]', PHONE: '[телефон]', EMAIL: '[почта]',
  URL: '[ссылка]', HANDLE: '[аккаунт]', ADDRESS: '[адрес]', CARD: '[номер]', DOCUMENT: '[номер]',
};

const MEDICAL_ABBREVIATIONS = new Set(['МРТ', 'КТ', 'УЗИ', 'ЭКГ', 'ЭЭГ', 'ЛОР', 'ДМС', 'ОМС', 'ОРВИ', 'ОРЗ', 'АД', 'ЖКТ', 'ВСД', 'ЭКО', 'ДТП', 'СОЭ', 'ИМТ']);

const INSURER = new RegExp(`${B}(?:сбер\\s*-?\\s*страхован\\p{L}*|согаз\\p{L}*|ресо(?:\\s*-?\\s*гаранти\\p{L}*)?|ингосстрах\\p{L}*|альфа\\s*-?\\s*страхован\\p{L}*|росгосстрах\\p{L}*|энергогарант\\p{L}*|втб\\s*-?\\s*страхован\\p{L}*|ренессанс\\s+страхован\\p{L}*|т\\s*-\\s*страхован\\p{L}*|тинькофф\\s*-?\\s*страхован\\p{L}*|совкомбанк\\s*-?\\s*страхован\\p{L}*)${E}`, 'gu');
const TITLE = new RegExp(`${B}(?:завуч\\p{L}*|директор\\p{L}*|главврач\\p{L}*|депутат\\p{L}*|мэр\\p{L}*|судь[яиеюй]|прокурор\\p{L}*|министр\\p{L}*|ректор\\p{L}*|декан\\p{L}*|заведующ\\p{L}*|начальник\\p{L}*|сенатор\\p{L}*|полковник\\p{L}*|генерал\\p{L}*|следовател\\p{L}*)${E}`, 'gu');
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
  let result = source.replace(/@([A-Z]+)(?:_[A-Z0-9]+)?/gu, (whole, kind) => TOKEN_LABEL[kind] || '[место]');
  result = replaceSpans(result, CAR_PLATE, '[номер]');
  result = result.replace(FULL_DATE, '[дата]');
  result = replaceSpans(result, INSURER, '[страховая]');
  result = replaceSpans(result, TITLE, '[должность]');
  result = replaceSpans(result, INSTITUTION, '[организация]');
  result = result.replace(NUMBERED_PLACE, '$1').replace(NUMBERED, '');
  result = result.replace(NAMED_ORG, (whole, prefix) => `${prefix}[организация]`);
  result = result.replace(QUOTED, '[название]');
  result = result.replace(ALL_CAPS, (word) => (MEDICAL_ABBREVIATIONS.has(word) ? word : '[организация]'));
  for (const pattern of PLACE_PATTERNS) {
    result = replaceSpans(result, pattern, (raw) => {
      const label = `[место_${state.places.size + 1}]`;
      state.places.set(label, raw);
      return label;
    });
  }
  return { text: result.replace(/\s+/gu, ' ').replace(/\s+([.,;!?])/gu, '$1').trim(), blocked: false, reason: null };
};
