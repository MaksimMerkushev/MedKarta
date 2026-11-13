/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Независимая проверка тела запроса к внешней модели — ровно того, что уйдёт в сеть.
 * Вызывается в requestCompletion перед fetch, после проверок вызывающего (планировщика
 * или триажа), и не полагается на них:
 *   - тело заново разбирается из сериализованной строки;
 *   - только известные поля верхнего уровня и известные схемы ответа;
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

export const ALLOWED_TOP_FIELDS = Object.freeze(['model', 'messages', 'response_format', 'temperature', 'max_tokens', 'reasoning', 'usage']);
export const OUTBOUND_LIMITS = Object.freeze({ MAX_MESSAGES: 10, MAX_CONTENT_CHARS: 20_000, MAX_BODY_BYTES: 96 * 1024 });

// 6+ цифр подряд или через пробел/дефис (телефоны, полисы). «160/100», «38.5», время — не номер.
const LONG_NUMBER = /\d(?:[ -]?\d){5,}/u;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/u;
// «@» между буквами в любом алфавите: почта, переведённая в другую раскладку, теряет точку («пьфшдюсщь»).
const AT_BETWEEN_LETTERS = /[\p{L}\p{N}._%+-]{2}@[\p{L}\p{N}]{2}/u;

const contentProblems = (raw, freeText = false) => {
  const problems = [];
  // Та же нормализация, что на входе: невидимые символы и двойники букв не прячут данные от проверки.
  const content = normalizeUserText(raw, { layout: false });
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
 * @param {object} wire тело запроса, которое будет сериализовано и отправлено
 * @param {object} [options]
 * @param {object[]} [options.schemas] допустимые json_schema ответа
 * @param {Set<string>} [options.staticSystem] известные статичные системные тексты
 * @param {boolean} [options.freeText] в пользовательской части — свободный текст (триаж)
 * @param {{residual: (text: string) => Promise<string[]>}|null} [options.ner] ML-слой
 * @returns {Promise<string[]>} список проблем; пустой — можно отправлять
 */
export const inspectOutbound = async (wire, { schemas = [], staticSystem = new Set(), freeText = false, ner = null } = {}) => {
  const problems = [];
  let serialized;
  let body;
  try {
    serialized = JSON.stringify(wire);
    body = JSON.parse(serialized);
  } catch {
    return ['serialization'];
  }
  if (Buffer.byteLength(serialized) > OUTBOUND_LIMITS.MAX_BODY_BYTES) problems.push('size');
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['shape'];
  for (const key of Object.keys(body)) if (!ALLOWED_TOP_FIELDS.includes(key)) problems.push(`field:${key}`);
  if (typeof body.model !== 'string' || body.model.length === 0 || body.model.length > 200) problems.push('field:model');
  if (body.temperature !== undefined && typeof body.temperature !== 'number') problems.push('field:temperature');
  if (body.max_tokens !== undefined && !(Number.isInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= 4000)) problems.push('field:max_tokens');
  if (body.reasoning !== undefined && JSON.stringify(Object.keys(body.reasoning || {})) !== '["effort"]') problems.push('field:reasoning');
  if (body.usage !== undefined && JSON.stringify(body.usage) !== '{"include":true}') problems.push('field:usage');
  const schema = JSON.stringify(body.response_format?.json_schema ?? null);
  if (body.response_format?.type !== 'json_schema' || !schemas.some((known) => JSON.stringify(known) === schema)) problems.push('schema');

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0 || messages.length > OUTBOUND_LIMITS.MAX_MESSAGES) return [...problems, 'messages'];
  const userTexts = [];
  for (const message of messages) {
    const keys = Object.keys(message || {}).sort().join(',');
    if (keys !== 'content,role' || !['system', 'user'].includes(message.role) || typeof message.content !== 'string' || message.content.length > OUTBOUND_LIMITS.MAX_CONTENT_CHARS) {
      problems.push('message');
      continue;
    }
    if (message.role === 'system' && staticSystem.has(message.content)) continue;
    problems.push(...contentProblems(message.content, freeText && message.role === 'user'));
    if (message.role === 'user') userTexts.push(message.content);
  }
  if (freeText && ner) {
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
