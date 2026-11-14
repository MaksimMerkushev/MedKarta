/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Маскирование найденных диапазонов поверх уже очищенного текста — общее для правил
 * (ruRecognizers) и локальных моделей. Перекрытия объединяются, серверные метки не
 * трогаются и не раскрываются. Повторяющаяся сущность получает ту же метку во всём
 * диалоге: «[имя_1]» в первой и третьей реплике, «Ринат» и «Рината» — одна метка.
 *
 * Медицинский смысл. Фрагмент, где есть название лекарства, анализа или эпоним, не
 * сохраняется целиком: маскируются его слова, не относящиеся к медицине («зарвелинариз
 * сөмбелә метформин» → «[имя_1] метформин»). Витамин с буквой и доза с единицей
 * («витамин D», «1000 МЕ») не входят ни в одну маску, кроме номеров и контактов.
 */
import { isDosageWord, isMedicalPhrase, isMedicalWord, mentionsMedicalName, protectedMedicalRanges } from './medicalLexicon.js';
import { createLabelState as createState, entityKey, labelFor, trustedLabelPattern } from './labels.js';

export const SPAN_LABEL = Object.freeze({ PERSON: 'имя', ORG: 'организация', LOC: 'место', ADDRESS: 'адрес', PHONE: 'телефон', EMAIL: 'почта', DOC: 'номер', URL: 'аккаунт', DATE: 'дата', SECRET: 'код', PROFESSION: 'должность' });
export const SPAN_TYPES = Object.freeze(Object.keys(SPAN_LABEL));
const PRIORITY = { SECRET: 10, DOC: 9, PHONE: 8, EMAIL: 8, URL: 7, PERSON: 6, ADDRESS: 5, ORG: 4, PROFESSION: 3, LOC: 2, DATE: 1 };
/** Серверные метки (точная грамматика, privacy/labels.js); пользовательские скобки к ним не относятся. */
export const LABEL_PATTERN = trustedLabelPattern();
const ALWAYS_MASK = new Set(['DOC', 'PHONE', 'EMAIL', 'URL', 'SECRET', 'ADDRESS']);
const isRealDate = (value) => /\d{1,2}[./]\d{1,2}|(?<!\d)(?:19|20)\d{2}(?!\d)/u.test(value);

// Местоимения, приветствия и служебные слова модели иногда отмечают как имя или организацию.
const NON_IDENTIFYING = new Set(['я', 'мы', 'ты', 'вы', 'он', 'она', 'они', 'это', 'меня', 'мне', 'мой', 'моя', 'мое', 'мои', 'нас', 'нам', 'зовут', 'здравствуйте', 'привет', 'добрый', 'день', 'вечер', 'утро', 'спасибо', 'пожалуйста', 'реплики', 'пользователя', 'my', 'name', 'is', 'hi', 'hello', 'i', 'am', 'почта', 'телефон', 'тел', 'адрес', 'лечилась', 'лечился', 'работаю', 'живу', 'казань', 'казани', 'казанью']);
const keepUnmasked = (value, type) => {
  if (!/[\p{L}\p{N}]/u.test(value)) return true;
  if (ALWAYS_MASK.has(type)) return false;
  if (type === 'DATE') return !isRealDate(value);
  const words = value.toLowerCase().replace(/ё/gu, 'е').match(/[\p{L}\p{N}-]+/gu) || [];
  if (words.length > 0 && words.every((w) => NON_IDENTIFYING.has(w))) return true;
  return isMedicalPhrase(value);
};

/** Новое состояние нумерации меток на диалог (seedTexts — реплики с уже выданными метками). */
export const createLabelState = (seedTexts = []) => createState(seedTexts);

/*
 * Фрагмент с медицинским названием → части без медицины. Слова-названия, числа, единицы и
 * слова дозировки («таблетки в день») остаются; подряд идущие прочие слова — маска.
 */
const splitMedical = (text, start, end) => {
  const value = text.slice(start, end);
  if (!mentionsMedicalName(value)) return [{ start, end }];
  const parts = [];
  let current = null;
  for (const m of value.matchAll(/[\p{L}\p{N}-]+/gu)) {
    const keep = isMedicalWord(m[0]) || isDosageWord(m[0]);
    const s = start + m.index;
    const e = s + m[0].length;
    if (keep) {
      current = null;
      continue;
    }
    if (current && /^[\s\-«»"'.]*$/u.test(text.slice(current.end, s))) current.end = e;
    else {
      current = { start: s, end: e };
      parts.push(current);
    }
  }
  return parts;
};

/** Диапазон без защищённых медицинских участков: «витамин [D]» маской не станет. */
const withoutProtected = (range, protectedRanges) => {
  let pieces = [range];
  for (const p of protectedRanges) {
    pieces = pieces.flatMap((r) => {
      if (p.end <= r.start || r.end <= p.start) return [r];
      return [{ start: r.start, end: p.start }, { start: p.end, end: r.end }].filter((x) => x.end > x.start);
    });
  }
  return pieces;
};

/**
 * @param {string} text
 * @param {Array<{type: string, start: number, end: number}>} spans
 * @param {{state?: object}} [options] state — для стабильных номеров меток в диалоге
 * @returns {{text: string, masked: number, types: string[]}}
 */
export const applySpans = (text, spans, { state = null } = {}) => {
  const labels = [...text.matchAll(trustedLabelPattern())].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const protectedRanges = protectedMedicalRanges(text);
  const ranges = [];
  for (const span of spans) {
    if (!SPAN_LABEL[span.type]) continue;
    const pieces = ALWAYS_MASK.has(span.type)
      ? [{ start: span.start, end: span.end }]
      : splitMedical(text, span.start, span.end).flatMap((piece) => withoutProtected(piece, protectedRanges));
    for (const piece of pieces) {
      let { start, end } = piece;
      while (start < end && !/[\p{L}\p{N}@%+]/u.test(text[start])) start += 1;
      while (end > start && !/[\p{L}\p{N}=]/u.test(text[end - 1])) end -= 1;
      if (start >= end) continue;
      if (labels.some((l) => l.start <= start && end <= l.end)) continue;
      for (const l of labels) if (l.start < end && start < l.end) { start = Math.min(start, l.start); end = Math.max(end, l.end); }
      // Метка, приклеенная дефисом («[имя]-Вандербильт»), — та же сущность.
      for (const l of labels) {
        if (l.end <= start && /^-$/u.test(text.slice(l.end, start))) start = l.start;
        if (l.start >= end && /^-$/u.test(text.slice(end, l.start))) end = l.end;
      }
      if (keepUnmasked(text.slice(start, end).replace(trustedLabelPattern(), ' '), span.type)) continue;
      ranges.push({ start, end, type: span.type });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    const gap = last ? text.slice(last.end, r.start) : '';
    if (last && (r.start <= last.end || (/^[\s\-«»"'.]*$/u.test(gap) && r.type === last.type))) {
      last.end = Math.max(last.end, r.end);
      if (PRIORITY[r.type] > PRIORITY[last.type]) last.type = r.type;
    } else merged.push({ ...r });
  }
  let out = text;
  for (const r of [...merged].reverse()) {
    const value = text.slice(r.start, r.end);
    // Уже выданная метка внутри объединённого диапазона — та же сущность: метка сохраняется.
    const inner = value.match(trustedLabelPattern());
    const label = inner && inner.length === 1 && r.type === 'PERSON' && /^\[имя/u.test(inner[0])
      ? inner[0]
      : labelFor(state, SPAN_LABEL[r.type], entityKey(r.type, value.replace(trustedLabelPattern(), ' ')));
    out = `${out.slice(0, r.start)}${label}${out.slice(r.end)}`;
  }
  return { text: out, masked: merged.length, types: merged.map((r) => r.type) };
};
