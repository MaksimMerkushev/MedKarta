/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный ML-слой Privacy Gateway (флаг PII_NER, по умолчанию выключен).
 *
 * Работает ПОСЛЕ правил (gateway, deidentify.js, ruRecognizers.js), на уже очищенных
 * репликах. Правила и модели не спорят о том, пропустить ли текст: находки всех
 * маскируются (объединение, spanMask.js). Моделей может быть несколько — ошибка любой
 * останавливает внешний вызов.
 *
 * Неуверенность. Модель отметила имя, организацию или место с уверенностью ниже порога —
 * текст не отправляется (ошибка ner_uncertain): маскировать всё сомнительное подряд значило
 * бы ломать жалобу, а отправлять — рисковать. Пользователь получает локальный ответ.
 *
 * Это снижение риска, а не юридическое обезличивание.
 */
import { NerError } from './nerClient.js';
import { isMedicalPhrase } from './medicalLexicon.js';
import { applySpans, createLabelState, LABEL_PATTERN } from './spanMask.js';

export const NER_LABEL = Object.freeze({ PERSON: '[имя]', ORG: '[организация]', LOC: '[место]' });
const LEGACY = { PER: 'PERSON', MEDIA: 'ORG', GEOPOLIT: 'LOC' };
const CONTEXTUAL = new Set(['PERSON', 'ORG', 'LOC', 'PROFESSION']);
export const DEFAULT_UNCERTAIN = Object.freeze({ min: 0.4, max: 0.6 });

const unify = (entity) => ({ ...entity, type: LEGACY[entity.type] || entity.type });
const insideLabel = (text, e) => [...text.matchAll(LABEL_PATTERN)].some((m) => m.index <= e.start && e.end <= m.index + m[0].length);

/** Разделить находки на уверенные (маскировать) и сомнительные (не отправлять). */
export const splitByConfidence = (text, entities, uncertain = DEFAULT_UNCERTAIN) => {
  const confident = [];
  const doubtful = [];
  for (const raw of entities) {
    const e = unify(raw);
    if (e.score == null || e.score >= uncertain.max || !CONTEXTUAL.has(e.type)) { confident.push(e); continue; }
    if (e.score < uncertain.min) continue;
    const value = text.slice(e.start, e.end);
    if (insideLabel(text, e) || isMedicalPhrase(value) || !/[\p{L}]{2,}/u.test(value)) continue;
    doubtful.push(e);
  }
  return { confident, doubtful };
};

/** Маскирование одной реплики поверх правил (для тестов и совместимости). */
export const applyEntities = (text, entities, options = {}) => applySpans(text, entities.map(unify), options);

export const createNerLayer = ({ client = null, clients = null, logger = null, metrics = null, uncertain = DEFAULT_UNCERTAIN }) => {
  const sources = clients || (client ? [client] : []);
  const entitiesOf = async (text) => {
    const all = [];
    for (const source of sources) all.push(...await source.entities(text));
    return all;
  };

  const maskTurns = async (turns) => {
    const state = createLabelState();
    const result = [];
    let masked = 0;
    for (const turn of turns) {
      const { confident, doubtful } = splitByConfidence(turn, await entitiesOf(turn), uncertain);
      if (doubtful.length > 0) {
        metrics?.increment('ner.uncertain');
        throw new NerError('ner_uncertain');
      }
      const applied = applySpans(turn, confident, { state });
      masked += applied.masked;
      result.push(applied.text);
    }
    metrics?.increment('ner.masked', { status: masked > 0 ? 'found' : 'none' });
    logger?.event?.('ner.applied', { count: masked });
    return result;
  };

  /** Что модели видят в итоговом тексте помимо меток и медицинских слов (финальная проверка). */
  const residual = async (text) => {
    const { confident, doubtful } = splitByConfidence(text, await entitiesOf(text), uncertain);
    return [...applySpans(text, confident).types, ...doubtful.map((e) => `uncertain:${e.type}`)];
  };
  return Object.freeze({ maskTurns, residual });
};
