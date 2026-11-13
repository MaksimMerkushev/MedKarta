/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Маскирование найденных диапазонов поверх уже очищенного текста — общее для правил
 * (ruRecognizers) и локальных моделей. Перекрытия объединяются, метки правил не
 * трогаются и не раскрываются, медицинские слова не маскируются. Повторяющаяся
 * сущность получает ту же метку во всём диалоге: «[имя_1]» в первой и третьей реплике.
 */
import { isMedicalPhrase, mentionsMedicalName } from './medicalLexicon.js';

export const SPAN_LABEL = Object.freeze({ PERSON: 'имя', ORG: 'организация', LOC: 'место', ADDRESS: 'адрес', PHONE: 'телефон', EMAIL: 'почта', DOC: 'номер', URL: 'аккаунт', DATE: 'дата', SECRET: 'код', PROFESSION: 'должность' });
export const SPAN_TYPES = Object.freeze(Object.keys(SPAN_LABEL));
const PRIORITY = { SECRET: 10, DOC: 9, PHONE: 8, EMAIL: 8, URL: 7, PERSON: 6, ADDRESS: 5, ORG: 4, PROFESSION: 3, LOC: 2, DATE: 1 };
// Метки правил шлюза и уже выданные метки этого слоя.
export const LABEL_PATTERN = /\[[^[\]\n]{1,40}\]/gu;
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
  // «Цитрамон 2 таблетки в день»: модель отметила фразу целиком — в ней название лекарства, это не имя.
  return isMedicalPhrase(value) || mentionsMedicalName(value);
};

/** Новое состояние нумерации меток на диалог. */
export const createLabelState = () => ({ byKey: new Map(), counters: new Map() });

/**
 * @param {string} text
 * @param {Array<{type: string, start: number, end: number}>} spans
 * @param {{state?: object}} [options] state — для стабильных номеров меток в диалоге
 * @returns {{text: string, masked: number, types: string[]}}
 */
export const applySpans = (text, spans, { state = null } = {}) => {
  const labels = [...text.matchAll(LABEL_PATTERN)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const ranges = [];
  for (const span of spans) {
    if (!SPAN_LABEL[span.type]) continue;
    let { start, end } = span;
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
    if (keepUnmasked(text.slice(start, end).replace(LABEL_PATTERN, ' '), span.type)) continue;
    ranges.push({ start, end, type: span.type });
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
    const name = SPAN_LABEL[r.type];
    let label = `[${name}]`;
    if (state) {
      const key = `${r.type}:${text.slice(r.start, r.end).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`;
      if (!state.byKey.has(key)) {
        const next = (state.counters.get(name) || 0) + 1;
        state.counters.set(name, next);
        state.byKey.set(key, next);
      }
      label = `[${name}_${state.byKey.get(key)}]`;
    }
    out = `${out.slice(0, r.start)}${label}${out.slice(r.end)}`;
  }
  return { text: out, masked: merged.length, types: merged.map((r) => r.type) };
};
