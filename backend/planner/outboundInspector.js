/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Независимая проверка тела запроса к внешней модели — ровно тех байтов, что уйдут в сеть.
 * Вызывается в requestCompletion перед fetch, после проверок вызывающего (планировщика,
 * триажа, лабораторного парсера), и не полагается на них:
 *   - тело разбирается из той самой строки, которая будет отправлена;
 *   - доверенное (промпты, схема, пределы) объявляет канал (outboundChannels.js), не вызов;
 *   - только известные поля; model — идентификатор, reasoning.effort — из списка;
 *   - метки в свободном тексте — только серверные; закодированные остатки — отказ;
 *   - сообщения — только system/user, только {role, content};
 *   - системный текст пропускается без проверки, только если это известный статичный промпт;
 *     любой другой текст (включая системные подсказки) проходит детекторы;
 *   - номера из 6+ цифр, e-mail, телефоны — отказ;
 *   - если включён ML-слой и в запросе свободный текст — модель смотрит ещё раз
 *     итоговый текст; её ошибка — отказ (fail closed).
 */
import { detectEntities } from '../privacy/detectors.js';
import { isKnownPlace, isStreetMention } from '../privacy/vocabulary.js';
import { normalizeUserText } from '../privacy/inputNormalize.js';
import { recognizePii } from '../privacy/ruRecognizers.js';
import { hasDocumentNumber } from '../privacy/deidentify.js';
import { untrustedBrackets } from '../privacy/labels.js';
import { channelSpec, MODEL_NAME, REASONING_EFFORTS, sameJson } from './outboundChannels.js';

export const ALLOWED_TOP_FIELDS = Object.freeze(['model', 'messages', 'response_format', 'temperature', 'max_tokens', 'reasoning', 'usage']);
export const OUTBOUND_LIMITS = Object.freeze({ MAX_MESSAGES: 10, MAX_CONTENT_CHARS: 20_000, MAX_BODY_BYTES: 96 * 1024 });

// 6+ цифр подряд или через пробел/дефис (телефоны, полисы). «160/100», «38.5», время — не номер.
const LONG_NUMBER = /\d(?:[ -]?\d){5,}/u;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
// «@» между буквами в любом алфавите: почта, переведённая в другую раскладку, теряет точку («пьфшдюсщь»).
const AT_BETWEEN_LETTERS = /[\p{L}\p{N}._%+-]{2}@[\p{L}\p{N}]{2}/u;
// Обратимая запись, оставшаяся после раскодирования на входе (privacy/inputNormalize.js).
const ENCODED_RESIDUE = /&#x?[0-9a-f]{2,6};|(?:%[0-9a-f]{2}){2,}|(?:\\u[0-9a-f]{4}){2,}/iu;
const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const contentProblems = (raw, freeText = false) => {
  const problems = [];
  // Та же нормализация, что на входе: невидимые символы и двойники букв не прячут данные от проверки.
  const content = normalizeUserText(raw, { layout: false, brackets: false });
  if (content !== raw.trim() && /[\u200b-\u200f\u2060\ufeff\u00ad]/u.test(raw)) problems.push('invisible');
  // Распознаватели свободного текста — для жалоб (триаж). Описание для планировщика собирает сам
  // шлюз из словаря улиц и мест: «Места: улица Ямашева» — ориентир маршрута, его проверяют детекторы.
  if (freeText) {
    for (const span of recognizePii(content)) {
      if (span.type === 'ADDRESS' && !/\d/u.test(content.slice(span.start, span.end))) continue;
      problems.push(`pii:${span.type}`);
    }
  }
  if (hasDocumentNumber(content)) problems.push('document');
  const { spans } = detectEntities(content);
  for (const span of spans) {
    if (isStreetMention(content, span) || isKnownPlace(content.slice(span.start, span.end))) continue;
    problems.push(`entity:${span.kind}`);
  }
  // Метки Gateway (@PERSON_A) — не данные; убираем их перед поиском чисел и адресов.
  const plain = content.replace(/@[A-Z]+(?:_[A-Z0-9]+)?/gu, ' ');
  if (LONG_NUMBER.test(plain)) problems.push('number');
  if (EMAIL.test(plain) || AT_BETWEEN_LETTERS.test(plain)) problems.push('email');
  return problems;
};

/**
 * Проверка ровно тех байтов, что уйдут в сеть (requestCompletion сериализует тело один раз и
 * отправляет эту же строку). Доверенное — только то, что объявил канал (outboundChannels.js).
 *
 * @param {string} bytes сериализованное тело запроса
 * @param {object} options
 * @param {string} options.channel имя канала: planner | triage | labs
 * @param {{residual: (text: string) => Promise<string[]>}|null} [options.ner] ML-слой (только добавляет проверки)
 * @returns {Promise<string[]>} список проблем; пустой — можно отправлять
 */
export const inspectOutboundBytes = async (bytes, { channel, ner = null } = {}) => {
  const spec = channelSpec(channel);
  if (!spec) return ['channel'];
  if (typeof bytes !== 'string') return ['serialization'];
  const problems = [];
  if (Buffer.byteLength(bytes) > OUTBOUND_LIMITS.MAX_BODY_BYTES) problems.push('size');
  let body;
  try {
    body = JSON.parse(bytes);
  } catch {
    return ['serialization'];
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['shape'];
  for (const key of Object.keys(body)) if (!ALLOWED_TOP_FIELDS.includes(key)) problems.push(`field:${key}`);
  if (typeof body.model !== 'string' || !MODEL_NAME.test(body.model)) problems.push('field:model');
  if (body.temperature !== undefined && !(typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2)) problems.push('field:temperature');
  if (body.max_tokens !== undefined && !(Number.isInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= spec.maxTokens)) problems.push('field:max_tokens');
  if (body.reasoning !== undefined && !(isPlain(body.reasoning) && sameJson(Object.keys(body.reasoning), ['effort']) && REASONING_EFFORTS.includes(body.reasoning.effort))) problems.push('field:reasoning');
  if (body.usage !== undefined && JSON.stringify(body.usage) !== '{"include":true}') problems.push('field:usage');

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0 || messages.length > OUTBOUND_LIMITS.MAX_MESSAGES) return [...problems, 'messages'];
  const systemTexts = messages.filter((m) => m?.role === 'system' && typeof m.content === 'string').map((m) => m.content);
  const format = body.response_format;
  if (!isPlain(format) || !sameJson(Object.keys(format).sort(), ['json_schema', 'type']) || format.type !== 'json_schema' || !spec.isKnownSchema(format.json_schema, systemTexts)) problems.push('schema');

  const userTexts = [];
  for (const message of messages) {
    const keys = Object.keys(message || {}).sort().join(',');
    if (keys !== 'content,role' || !['system', 'user'].includes(message.role) || typeof message.content !== 'string' || message.content.length > OUTBOUND_LIMITS.MAX_CONTENT_CHARS) {
      problems.push('message');
      continue;
    }
    if (message.role === 'system' && spec.isTrustedSystem(message.content)) continue;
    const freeText = spec.freeText && message.role === 'user';
    problems.push(...contentProblems(message.content, freeText));
    if (freeText) {
      // Пользовательские скобки на входе обезврежены: любая не-серверная метка — подделка или ошибка.
      if (untrustedBrackets(message.content)) problems.push('untrusted_label');
      // Осталось закодированным после ограниченного раскодирования на входе — не отправляется.
      if (ENCODED_RESIDUE.test(message.content)) problems.push('encoded');
      userTexts.push(message.content);
    }
  }
  if (spec.freeText && ner) {
    for (const text of userTexts) {
      try {
        const residual = await ner.residual(text);
        problems.push(...residual.map((type) => `ner:${type}`));
      } catch (error) {
        problems.push(`ner_error:${error?.code || 'unknown'}`);
      }
    }
  }
  return [...new Set(problems)];
};

/** То же для объекта (тесты, проверки): сериализуется здесь один раз. */
export const inspectOutbound = async (wire, options = {}) => {
  let bytes;
  try {
    bytes = JSON.stringify(wire);
  } catch {
    return ['serialization'];
  }
  return inspectOutboundBytes(bytes, options);
};
