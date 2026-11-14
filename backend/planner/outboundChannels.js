/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Каналы обращения к внешней модели — единственный способ что-то отправить наружу
 * (requestCompletion требует имя канала). Канал объявляет один раз, при загрузке своего
 * модуля, что в его запросах доверенное: статичные системные промпты, схема ответа,
 * пределы полей; и есть ли в нём свободный текст пользователя (тогда работают
 * распознаватели ПДн и ML-слой). Вызывающий код не может на вызове расширить доверие —
 * ни своим «статичным» промптом, ни своей схемой.
 *
 *   planner — планировщик (planner/client.js): структурированное описание запроса;
 *   triage  — триаж жалоб (planner/triage.js): свободный текст реплик;
 *   labs    — сопоставление названий анализов (planner/labParser.js): короткие фрагменты.
 */

export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high']);
/** Имя модели — идентификатор провайдера, не произвольный текст («@», пробелы, кириллица — отказ). */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/u;

const channels = new Map();

/**
 * @param {string} name
 * @param {object} spec
 * @param {(content: string) => boolean} spec.isTrustedSystem системный текст — доверенный промпт канала
 * @param {(jsonSchema: object, systemTexts: string[]) => boolean} spec.isKnownSchema схема ответа канала
 * @param {boolean} spec.freeText в пользовательской части свободный текст
 * @param {number} spec.maxTokens потолок max_tokens
 */
export const defineChannel = (name, spec) => {
  if (channels.has(name)) throw new Error(`канал ${name} уже объявлен`);
  if (typeof spec?.isTrustedSystem !== 'function' || typeof spec?.isKnownSchema !== 'function') throw new Error(`канал ${name}: нет проверок промпта и схемы`);
  channels.set(name, Object.freeze({ name, freeText: Boolean(spec.freeText), maxTokens: Number(spec.maxTokens) || 700, isTrustedSystem: spec.isTrustedSystem, isKnownSchema: spec.isKnownSchema }));
  return name;
};

export const channelSpec = (name) => channels.get(name) || null;

/** Схема совпадает с одной из известных ровно (порядок ключей — как при сериализации). */
export const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
