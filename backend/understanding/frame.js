/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Понятый запрос в одной структуре: отдельно жалобы, отдельно условия поиска, у каждого
 * условия — откуда оно взялось. Структура описывает решение пайплайна и нужна для проверки:
 * фильтры применяет бизнес-логика, а не этот объект. Содержит текст жалоб, поэтому не
 * пишется в журналы и не возвращается пользователю; читает её только диагностика.
 *
 * Источник условия:
 *   explicit — сказано прямо;
 *   inferred — предположила система или модель, жёстким фильтром не становится;
 *   unset    — сведений нет.
 */

import { complaintParts, segmentTurn } from './turnRoles.js';

const SOURCES = Object.freeze({ EXPLICIT: 'explicit', INFERRED: 'inferred', UNSET: 'unset' });

const isEmpty = (value) => value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0);
const constraint = (value, source = SOURCES.EXPLICIT) => (isEmpty(value)
  ? { value: null, source: SOURCES.UNSET }
  : { value, source });

const REVERT = /(?<![\p{L}])(?:вс[её]-?таки|верн[её]мся|обратно|как\s+раньше)(?![\p{L}])/u;
const CANCEL = /(?<![\p{L}])(?:отмени\p{L}*|убери\p{L}*|сними\p{L}*|не\s+важн\p{L}*|неважн\p{L}*|без\s+разницы|любое|без\s+дмс)(?![\p{L}])/u;
const CONDITION = /(?<![\p{L}])(?:завтра|сегодня|послезавтра|после\s+\d|до\s+\d|утром|вечером|дмс|район\p{L}*|рядом|поближе|руб\p{L}*|₽)(?![\p{L}])/u;

/** Чем была каждая реплика: новый запрос, уточнение, смена врача, смена условий, отмена. */
export const classifyTurns = ({ userTexts, perTurnSpecialties, named, newRequestStart = 0 }) => userTexts.map((text, index) => {
  if (index === 0) return 'new_request';
  const lower = String(text).toLowerCase();
  const keys = perTurnSpecialties[index] || [];
  const before = (perTurnSpecialties.slice(0, index).reverse().find((item) => item.length > 0)) || [];
  const hasComplaint = complaintParts(text).length > 0;
  if ((named[index] || []).length > 0) {
    if (keys.some((key) => !before.includes(key))) return REVERT.test(lower) ? 'return_to_earlier' : 'specialty_change';
    return 'specialty_confirmed';
  }
  if (hasComplaint) return index === newRequestStart ? 'new_complaint' : 'complaint_detail';
  if (CANCEL.test(lower)) return 'condition_cancelled';
  if (CONDITION.test(lower)) return 'condition_change';
  return 'answer_to_question';
});

/**
 * @param {object} probe что записал pipeline.handle: gate, triaged, modelRoles
 * @returns {object|null} понятый запрос; null, если разбор не состоялся
 */
export const buildQueryFrame = (probe) => {
  const context = probe?.gate?.context;
  const info = context?.turnInfo;
  if (!context || !info) return null;
  const booking = context.booking || {};
  const triaged = probe.triaged || null;
  const named = info.named.flat();
  const modelMentions = triaged?.frame?.mentions || [];
  const biography = info.userTexts.flatMap((text) => segmentTurn(text).filter((part) => part.role === 'biography').map((part) => part.text.trim()));
  const suggested = triaged?.specialties?.length ? triaged.specialties : !booking.explicitSpecialty ? (booking.specialties || []) : [];
  const uncertainties = [];
  if (triaged?.status === 'clarify') uncertainties.push('specialty');
  if (booking.insurer) uncertainties.push('insurer_coverage');
  if (booking.originHint && !booking.originConfirmed) uncertainties.push('origin_point');
  for (const mention of modelMentions) {
    // Модель считает место местом поиска, а правила — рассказом о себе: фильтр не включается.
    if (mention.role === 'search_place' && /\[место_\d+\]/u.test(mention.text) && (booking.districts || []).length === 0 && !booking.originPlace) uncertainties.push('search_place');
  }
  return {
    complaints: info.userTexts.flatMap((text) => complaintParts(text)),
    modelSymptoms: triaged?.frame?.symptoms || [],
    namedSpecialty: constraint(named.length > 0 ? [...new Set(named)] : null),
    suggestedSpecialty: { ...constraint(suggested, SOURCES.INFERRED), by: triaged?.specialties?.length ? 'model' : 'local' },
    geoContext: constraint(biography.length > 0 ? biography : null, SOURCES.INFERRED),
    searchPlace: {
      districts: constraint(booking.districts),
      originPlace: constraint(booking.originPlace),
      nearest: constraint(booking.nearest, SOURCES.INFERRED),
    },
    schedule: {
      date: constraint(booking.date),
      timeFrom: constraint(booking.timeFrom),
      timeTo: constraint(booking.timeTo),
      evening: constraint(booking.evening),
    },
    maxPrice: constraint(booking.maxPrice),
    dms: { required: constraint(booking.dms), planId: constraint(booking.planId), insurer: constraint(booking.insurer) },
    patient: constraint(booking.child ? 'child' : null, SOURCES.INFERRED),
    turns: classifyTurns(info),
    uncertainties: [...new Set(uncertainties)],
    emergency: Boolean(context.classification?.emergency) || triaged?.status === 'emergency',
    modelHints: { mentions: modelMentions, patient: triaged?.frame?.patient || null, applied: probe.modelRoles?.fragments || [], ignored: probe.modelRoles?.ignored || [] },
    sentToModel: context.triageTurns ? [...context.triageTurns] : [],
    decision: { gateway: probe.gate.decision, reason: probe.gate.reason || null, triage: Boolean(probe.gate.triage) },
  };
};
