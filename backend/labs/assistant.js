/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории в ассистенте МедКарты: тот же чат, что и для врачей. Разбор
 * запроса — на сервере (labs/understanding.js); модель нужна только для
 * названий, которых нет в каталоге синонимов (planner/labParser.js), и получает
 * лишь эти обезличенные фрагменты. Исследования, цены, филиалы и время берутся
 * из базы: ответ ассистента — запрос подбора, который исполняет /api/labs/quote.
 *
 * Если в той же реплике просят и врача («нужен эндокринолог и анализ ТТГ»),
 * ответ складывается из двух частей: запись к врачу — обычным путём, анализы —
 * отсюда.
 */

import { describeLabRequest, LAB_SORT_LABELS } from '../../shared/labSearch.js';
import { KAZAN_PLACES } from '../../shared/kazanPlaces.js';
import { sanitizeAiAction } from '../../shared/contract.js';
import { validateLabParse } from '../planner/labParser.js';
import { deidentifyComplaint, hasSensitiveCondition } from '../privacy/deidentify.js';
import { PREPARATION_NOTE } from './catalog.js';
import { describeLabOverlaps, findLabOverlaps } from './quote.js';
import { createLabUnderstanding } from './understanding.js';

/* Просьба о враче: «нужен эндокринолог», «запишите к терапевту», «к неврологу». Врач в роли «назначил» — не просьба. */
const SPECIALTY = '\\p{L}*(?:олог|иатр|ирург|апевт|опед)\\p{L}*|окулист\\p{L}*|лор\\p{L}{0,2}';
const DOCTOR_REQUEST = new RegExp(`(?:^|[^\\p{L}])(?:нуж\\p{L}*|записат\\p{L}*|запиши\\p{L}*|запишите|хочу|ищу|подбери\\p{L}*|найди\\p{L}*|к|ко)\\s+(?:\\p{L}+\\s+){0,2}?(?:${SPECIALTY})(?![\\p{L}])`, 'u');
const ONLY_SPECIALTY = new RegExp(`^\\s*(?:${SPECIALTY})\\s*[.!?]?\\s*$`, 'u');
const REFERRER = new RegExp(`(?:${SPECIALTY})\\s+(?:назначил\\p{L}*|выписал\\p{L}*|направил\\p{L}*|сказал\\p{L}*)`, 'u');

/** Номера реплик, где человек просит врача (а не рассказывает, кто назначил анализы). */
export const doctorRequestTurns = (texts) => {
  const result = new Set();
  texts.forEach((text, index) => {
    const source = String(text || '').toLowerCase().replace(/ё/gu, 'е');
    if (REFERRER.test(source) && !DOCTOR_REQUEST.test(source.replace(REFERRER, ' '))) return;
    if (DOCTOR_REQUEST.test(source) || ONLY_SPECIALTY.test(source)) result.add(index);
  });
  return result;
};

const joinNames = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} и ${names[names.length - 1]}`);
/* Короткое имя для реплики: «ОАК», «ТТГ», «HbA1c» — сокращение из скобок, если оно есть. */
const shortName = (test) => {
  if (test.code === 'CBC_DIFF') return 'ОАК';
  if (test.code === 'URINE_GENERAL') return 'ОАМ';
  const abbreviation = test.name.match(/\(([A-ZА-ЯЁ0-9][A-Za-zА-ЯЁа-яё0-9-]{1,9})\)/u)?.[1];
  if (abbreviation && /[A-ZА-ЯЁ]{2}|\d/u.test(abbreviation)) return abbreviation;
  return test.name.replace(/\s*\([^)]*\)\s*$/u, '');
};

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.getService лабораторный сервис
 * @param {object|null} [deps.parser] модель для неизвестных названий (planner/labParser.js)
 */
export const createLabAssistant = ({ getService, parser = null, logger = null, metrics = null }) => {
  /**
   * @returns {Promise<null|{action: object, withDoctor: boolean, analysis: object, model: object|null}>}
   *   null — реплика не о лаборатории
   */
  const handle = async ({ messages, takeExternalBudget = () => true }) => {
    const service = await getService();
    if (!service) return null;
    const { store } = service;
    const tests = new Map(store.listTests().map((test) => [test.code, test]));
    const understanding = createLabUnderstanding({ synonyms: store.synonymIndex(), tests });
    const userTexts = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === 'user').map((message) => String(message.content || '')).slice(-12);
    const doctorTurns = doctorRequestTurns(userTexts);
    const analysis = understanding.analyze(userTexts, { doctorTurns });
    if (!analysis.active || !analysis.latestIsLab) return null;

    /* Неизвестные названия — модели, только сами фрагменты после обезличивания. */
    let cart = [...analysis.tests];
    let unknownFragments = [];
    let model = null;
    if (analysis.unresolved.length > 0) {
      const safe = analysis.unresolved
        .filter((fragment) => !hasSensitiveCondition(fragment))
        .map((fragment) => ({ fragment, sent: deidentifyComplaint(fragment) }))
        .filter((item) => !item.sent.blocked && !/\[/u.test(item.sent.text));
      unknownFragments = analysis.unresolved.filter((fragment) => !safe.some((item) => item.fragment === fragment));
      if (safe.length > 0 && parser && takeExternalBudget()) {
        const fragments = safe.map((item) => item.sent.text);
        try {
          const completion = await parser.parse({ fragments, tests: [...tests.values()].map((test) => ({ code: test.code, name: test.name })) });
          const mapped = validateLabParse(completion.raw, { fragments: completion.fragments, codes: [...tests.keys()] }) || [];
          model = { fragments: completion.fragments, mapped, usage: completion.usage || null };
          metrics?.increment('labs.parser', { status: 'ok' });
          for (const item of mapped) {
            if (item.code === 'UNKNOWN') unknownFragments.push(item.fragment);
            else if (!cart.some((test) => test.code === item.code)) cart.push({ code: item.code, name: tests.get(item.code).name, byModel: true });
          }
          for (const fragment of completion.fragments) if (!mapped.some((item) => item.fragment === fragment)) unknownFragments.push(fragment);
        } catch (error) {
          metrics?.increment('labs.parser', { status: 'error' });
          logger?.warn?.('labs.parser_failed', { code: error?.code || 'error' });
          unknownFragments.push(...fragments);
        }
      } else {
        unknownFragments.push(...safe.map((item) => item.fragment));
      }
    }
    unknownFragments = [...new Set(unknownFragments)].slice(0, 3);

    const latestIndex = userTexts.length - 1;
    const withDoctor = doctorTurns.has(latestIndex);
    const filters = analysis.filters;
    const request = {
      tests: cart.map((test) => test.code),
      date: filters.date || { kind: 'any' },
      timeOfDay: filters.timeOfDay || null,
      timeFrom: filters.timeFrom || null,
      timeTo: filters.timeTo || null,
      maxTotalPrice: filters.maxTotalPrice || null,
      originPlace: filters.originPlace || null,
      travel: filters.maxMinutes ? { maxMinutes: filters.maxMinutes, mode: 'driving' } : undefined,
      sort: filters.sort || null,
      maxTurnaroundHours: filters.maxTurnaroundHours || null,
    };
    const cartTests = cart.map((test) => tests.get(test.code)).filter(Boolean);
    const names = cartTests.map(shortName);
    const placeLabel = filters.originPlace && KAZAN_PLACES[filters.originPlace] ? KAZAN_PLACES[filters.originPlace].from : null;
    const summary = describeLabRequest({ ...request, travel: request.travel || null }, { testNames: names, placeLabel });
    const intents = new Set(analysis.intents);
    if (cart.length > analysis.tests.length) intents.add('laboratory_test_search');

    const parts = [];
    let quickReplies = null;
    let search = false;
    const latestOps = analysis.operations.filter((item) => item.turn === latestIndex);
    const added = latestOps.filter((item) => item.op === 'add').flatMap((item) => item.codes).map((code) => tests.get(code)).filter(Boolean).map(shortName);
    const removed = latestOps.filter((item) => item.op === 'remove').flatMap((item) => item.codes).map((code) => tests.get(code)).filter(Boolean).map(shortName);
    const ambiguityOpen = analysis.ambiguous && (cart.length === 0 || intents.has('clarification'));

    if (analysis.resultsAsked) {
      parts.push('Я не расшифровываю результаты анализов: оценить их может только врач, с учётом самочувствия и других данных. Могу помочь записаться к врачу или подобрать лабораторию для повторной сдачи.');
      quickReplies = ['Нужен терапевт'];
    } else if (ambiguityOpen) {
      parts.push(analysis.ambiguous.question);
      if (cart.length > 0) parts.push(`В списке уже есть: ${joinNames(names)}.`);
      quickReplies = analysis.ambiguous.options.length
        ? analysis.ambiguous.options.map((code) => tests.get(code)).filter(Boolean).map((test) => shortName(test))
        : analysis.ambiguous.advice === 'thyroid' ? ['Нужен эндокринолог'] : null;
    } else if (cart.length === 0) {
      if (unknownFragments.length) parts.push(`Не нашёл в каталоге: ${unknownFragments.map((item) => `«${item}»`).join(', ')}. Если это область (например, печень или почки), набор анализов назначает врач.`);
      parts.push('Какие анализы нужно сдать? Напишите названия из направления — например, «ОАК и ферритин».');
      if (summary.length) parts.push(`Условия запомнил: ${summary.join(', ')}.`);
    } else {
      search = true;
      if (added.length) parts.push(`Добавил в список: ${joinNames(added)}.`);
      if (removed.length) parts.push(`Убрал из списка: ${joinNames(removed)}.`);
      parts.push(`Подбираю лабораторию: ${summary.join(', ')}. Сравниваю полную стоимость визита — анализы и взятие биоматериала — только там, где можно сдать всё сразу.`);
      const overlaps = findLabOverlaps(cart.map((test) => tests.get(test.code)), store.synonymIndex());
      for (const sentence of describeLabOverlaps(overlaps, (code) => shortName(tests.get(code)))) parts.push(sentence);
      if (cart.some((test) => test.byModel)) parts.push(`Название «${analysis.unresolved.join('», «')}» сопоставил с каталогом: ${joinNames(cart.filter((test) => test.byModel).map((test) => shortName(tests.get(test.code))))}. Если в направлении другое — поправьте.`);
      const fasting = cartTests.filter((test) => test.fasting);
      if (fasting.length) {
        const evening = request.timeOfDay === 'evening' || (request.timeFrom && request.timeFrom >= '12:00');
        parts.push(evening
          ? `${joinNames(fasting.map(shortName))} ${fasting.length > 1 ? 'сдаются' : 'сдаётся'} натощак — вечером это обычно невозможно. Лучше выбрать утро.`
          : `${joinNames(fasting.map(shortName))} ${fasting.length > 1 ? 'сдаются' : 'сдаётся'} натощак — показываю время до 12:00.`);
      }
      if (unknownFragments.length) parts.push(`Не нашёл в каталоге: ${unknownFragments.map((item) => `«${item}»`).join(', ')} — напишите название из направления.`);
      if (intents.has('laboratory_booking')) parts.push('Выберите вариант и время — запись демонстрационная.');
      quickReplies = request.sort === 'total' ? ['Быстрее результат'] : ['Подешевле', 'Быстрее результат'];
    }

    const preparation = analysis.preparationAsked || intents.has('laboratory_preparation_info')
      ? cartTests.map((test) => ({ code: test.code, name: test.name, text: test.preparation }))
      : [];
    if (preparation.length) parts.push(`Подготовка (справочно): ${preparation.map((item) => `${shortName(tests.get(item.code))} — ${item.text}`).join(' ')} ${PREPARATION_NOTE}`);
    if (search) parts.push('Лаборатории, цены и время — демонстрационные.');
    if (request.sort && LAB_SORT_LABELS[request.sort] && !search) parts.push(`Порядок: ${LAB_SORT_LABELS[request.sort]}.`);

    const action = sanitizeAiAction({
      replyText: parts.join(' '),
      quickReplies,
      labs: { request, tests: cartTests.map((test) => ({ code: test.code, name: test.name })), summary, intents: [...intents], preparation, search },
    });
    return { action, withDoctor, analysis: { ...analysis, tests: cart }, model, unknownFragments };
  };

  return Object.freeze({ handle });
};
