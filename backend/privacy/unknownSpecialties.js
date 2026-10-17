/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Профили врачей, которых нет в справочнике МедКарты: «косметолог»,
 * «мануальный терапевт»… Такой профиль даёт ответ «такого врача нет», а не
 * подмену: иначе «нет, лучше косметолог» оставил бы подбор дерматологов,
 * а «мануальный терапевт» стал бы терапевтом. Похожий профиль (related)
 * только предлагается словами.
 *
 * Во внешнюю модель ключи отсюда не уходят: это часть условий записи,
 * которые исполняет сервер.
 */

const WORD = '[\\p{L}\\p{N}]';

/** key → {pattern, label (именительный падеж), related — похожий профиль из справочника или null}. */
const ENTRIES = [
  ['cosmetologist', 'косметолог\\p{L}*', 'косметолог', 'dermatologist'],
  ['trichologist', 'трихолог\\p{L}*', 'трихолог', 'dermatologist'],
  ['venereologist', 'венеролог\\p{L}*', 'венеролог', 'dermatologist'],
  ['allergist', 'аллерголог\\p{L}*(?:[-\\s]+иммунолог\\p{L}*)?|иммунолог\\p{L}*', 'аллерголог-иммунолог', null],
  ['rheumatologist', 'ревматолог\\p{L}*', 'ревматолог', null],
  ['oncologist', '(?:онколог|маммолог|онкомаммолог)\\p{L}*', 'онколог / маммолог', null],
  ['proctologist', '(?:колопроктолог|проктолог)\\p{L}*', 'проктолог', null],
  ['nephrologist', 'нефролог\\p{L}*', 'нефролог', null],
  ['pulmonologist', 'пульмонолог\\p{L}*', 'пульмонолог', null],
  ['infectionist', 'инфекционист\\p{L}*', 'инфекционист', null],
  ['hematologist', 'гематолог\\p{L}*', 'гематолог', null],
  ['andrologist', 'андролог\\p{L}*', 'андролог', 'urologist'],
  ['speech_therapist', '(?:логопед|дефектолог)\\p{L}*', 'логопед', null],
  ['psychologist', '(?:нейро)?психолог(?!и)\\p{L}*', 'психолог', null],
  ['dietitian', '(?:диетолог|нутрициолог)\\p{L}*', 'диетолог', null],
  ['physiotherapist', '(?:физиотерапевт|рефлексотерапевт|иглорефлексотерапевт)\\p{L}*', 'физиотерапевт', null],
  ['manual_therapist', 'мануальн\\p{L}*\\s+терапевт\\p{L}*|мануальщик\\p{L}*|остеопат\\p{L}*|хиропрактик\\p{L}*', 'мануальный терапевт / остеопат', null],
  ['massage', 'массажист\\p{L}*', 'массажист', null],
  ['phlebologist', 'флеболог\\p{L}*|сосудист\\p{L}*\\s+хирург\\p{L}*|ангиохирург\\p{L}*', 'флеболог / сосудистый хирург', null],
  ['neurosurgeon', 'нейрохирург\\p{L}*', 'нейрохирург', null],
  ['plastic_surgeon', 'пластическ\\p{L}*\\s+хирург\\p{L}*|пластик\\p{L}*\\s+хирург\\p{L}*', 'пластический хирург', null],
  ['cardiac_surgeon', 'кардиохирург\\p{L}*', 'кардиохирург', null],
  ['vertebrologist', 'вертебролог\\p{L}*', 'вертебролог', 'neurologist'],
  ['audiologist', 'сурдолог\\p{L}*', 'сурдолог', 'lor'],
  ['orthodontist', '(?:ортодонт|имплантолог|пародонтолог)\\p{L}*', 'ортодонт / имплантолог', 'dentist'],
  ['reproductologist', 'репродуктолог\\p{L}*', 'репродуктолог', null],
  ['geneticist', 'генетик(?:а|у|ом|е|и|ов)?(?!\\p{L})', 'генетик', null],
  ['geriatrician', 'гериатр\\p{L}*', 'гериатр', null],
  ['podologist', 'подолог\\p{L}*', 'подолог', null],
  ['sexologist', 'сексолог\\p{L}*', 'сексолог', null],
  ['narcologist', 'нарколог\\p{L}*', 'нарколог', null],
  ['homeopath', 'гомеопат\\p{L}*', 'гомеопат', null],
  ['sleep_doctor', 'сомнолог\\p{L}*', 'сомнолог', null],
];

export const UNKNOWN_SPECIALTIES = Object.freeze(Object.fromEntries(ENTRIES.map(([key, , label, related]) => [key, Object.freeze({ label, related })])));

const PATTERNS = ENTRIES.map(([key, pattern]) => ({ key, regex: new RegExp(`(?<!${WORD})(?:${pattern})`, 'giu') }));

/**
 * Упоминания профилей, которых нет в справочнике: [{key, start, end}] по порядку.
 * @param {string} text
 */
export const findUnknownSpecialties = (text) => {
  const lower = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const found = [];
  for (const { key, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(lower)) !== null) {
      found.push({ key, start: match.index, end: match.index + match[0].length });
    }
  }
  // Пересечения (например, «онкомаммолог»): берём первое и самое длинное.
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  return found.filter((item, position) => !found.slice(0, position).some((other) => other.start <= item.start && other.end >= item.end));
};
