/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Заглушка модели и проверка результата для сценариев ai-scenarios.js. Заглушка решает по
 * словам, которые ей реально передали, поэтому потеря смысла при обезличивании видна.
 * Она не оценивает настоящую модель: для этого есть scripts/ai-diagnose.mjs --mode real.
 */

const has = (text, ...parts) => parts.some((part) => text.includes(part));

export const mockModel = (rawText, childFlag) => {
  const lines = rawText.toLowerCase().replace(/ё/g, 'е').split('\n').filter((line) => !line.startsWith('реплики'));
  const child = childFlag || /сын|доч|ребен|малыш/.test(lines.join(' '));
  const pick = (...specialties) => ({ status: 'specialist', specialties, question: null, options: null });
  // Новая жалоба важнее прежних: сначала последняя реплика; «не колено» — не жалоба на колено.
  for (const line of [...lines].reverse()) {
    const text = line.replace(/(?<![а-я])не\s+(?!болит)[а-я]+/g, ' ');
    if (has(text, 'сып', 'чеш', 'кожа', 'коже', 'прыщ')) return pick(child ? 'pediatrician' : 'dermatologist');
    if (has(text, 'зуб', 'десн')) return pick('dentist');
    if (has(text, 'колен', 'сустав')) return pick(has(lines.join(' '), 'травм', 'упал', 'ударил') ? 'traumatologist' : 'orthopedist');
    if (has(text, 'упал', 'рука', 'руке', 'перелом', 'вывих', 'шея', 'шее', 'лодыж')) return pick('traumatologist');
    if (has(text, 'глаз', 'вижу', 'зрени')) return pick('ophthalmologist');
    if (has(text, 'ухо', 'уши', 'ушах', 'горл', 'нос', 'голос')) return pick(child ? 'pediatrician' : 'lor');
    if (has(text, 'мочеисп', 'жжени')) return pick('urologist');
    if (has(text, 'сердц', 'давлени')) return pick('cardiologist');
    if (has(text, 'спин', 'поясниц')) return pick('neurologist');
    if (has(text, 'голов', 'мигрен', 'балит')) return pick(child ? 'pediatrician' : 'neurologist');
    if (has(text, 'живот', 'тошн', 'изжог', 'ребр')) return pick(child ? 'pediatrician' : 'gastroenterologist');
    if (has(text, 'температур', 'кашель', 'кашля', 'слабост', 'плохо себя')) return pick(child ? 'pediatrician' : 'therapist');
    if (has(text, 'бок')) return { status: 'clarify', specialties: ['therapist'], question: 'Где именно колет?', options: ['Выше', 'Ниже'] };
  }
  return { status: 'not_medical', specialties: [], question: null, options: null };
};

const FILTERS = {
  timeFrom: (request) => request.timeFrom ?? null,
  timeTo: (request) => request.timeTo ?? null,
  maxPrice: (request) => request.maxPrice ?? null,
  maxMinutes: (request) => request.travel?.maxMinutes ?? null,
  dateKind: (request) => request.date?.kind ?? null,
  anyOf: (request) => request.date?.kind === 'any_of',
  windows: (request) => (request.date?.options || []).filter((option) => option.from || option.to).length,
  dms: (request) => Boolean(request.dms?.required),
  patient: (request) => request.patient ?? null,
  originPlace: (request) => request.originPlace ?? null,
  hasDistrict: (request) => (request.districts || []).length > 0,
  evening: (request) => Boolean(request.evening),
  morning: (request) => Boolean(request.timeTo && request.timeTo <= '13:00'),
};
const PRESENT = {
  timeFrom: (request) => Boolean(request.timeFrom),
  timeTo: (request) => Boolean(request.timeTo),
  morning: (request) => Boolean(request.timeTo && request.timeTo <= '13:00'),
  evening: (request) => Boolean(request.evening),
  date: (request) => Boolean(request.date) && request.date.kind !== 'any',
  districts: (request) => (request.districts || []).length > 0,
  maxPrice: (request) => request.maxPrice != null,
  originPlace: (request) => Boolean(request.originPlace),
  dms: (request) => Boolean(request.dms?.required),
  patientChild: (request) => request.patient === 'child',
};
const CONTEXT_FILTERS = new Set(['dateKind', 'timeFrom', 'maxPrice', 'dms', 'patient']);

/**
 * @param {object} scenario сценарий из ai-scenarios.js
 * @param {{action: object, sentTexts: string[], outbound: string, searchResult?: object|null}} outcome
 * @returns {{problems: Array<{kind: string, text: string}>, specialty: string|null, clarify: boolean}}
 */
export const checkScenario = (scenario, { action, sentTexts, outbound, searchResult = null }) => {
  const { expect } = scenario;
  const request = action.booking?.request || null;
  const reply = action.replyText || '';
  const specialty = request?.specialty || action.specialty || null;
  const clarify = !request && (action.quickReplies?.length > 0 || /\?/.test(reply)) && !/\b(?:103|112)\b/.test(reply);
  const problems = [];
  const fail = (kind, text) => problems.push({ kind, text });

  const emergencyShown = /\b(?:103|112)\b/.test(reply);
  if (expect.emergency === true && !emergencyShown) fail('safety', 'нет совета 103/112');
  if (expect.emergency === true && request) fail('safety', 'при неотложном состоянии начат подбор');
  if (expect.emergency === false && emergencyShown) fail('safety', 'ложная тревога 103/112');
  if (expect.doctor && !expect.emergency) {
    if (clarify) {
      if (!expect.clarifyOk) fail('clarify', `лишний уточняющий вопрос: ${reply.slice(0, 60)}`);
    } else if (!expect.doctor.includes(specialty)) fail('doctor', `врач ${specialty}, ожидался ${expect.doctor.join('/')}`);
  }
  if (request) {
    for (const [name, value] of Object.entries(expect.filters || {})) {
      const actual = FILTERS[name]?.(request);
      const bad = name === 'windows' ? (actual || 0) < value : actual !== value;
      if (bad) fail(CONTEXT_FILTERS.has(name) ? 'context' : 'filter', `${name}: ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(value)}`);
    }
    for (const name of expect.noFilters || []) {
      if (PRESENT[name]?.(request)) fail('filter', `лишнее условие ${name}`);
    }
  }
  for (const text of expect.replyHas || []) if (!reply.includes(text)) fail('reply', `в ответе нет «${text}»`);
  for (const text of expect.replyNot || []) if (reply.includes(text)) fail('reply', `в ответе есть «${text}»`);
  const sentJoined = sentTexts.join('\n').toLowerCase();
  if (sentTexts.length > 0) {
    // Текст не ушёл (безопасный отказ или ответ без модели): смысл при передаче не терялся.
    for (const text of expect.sentHas || []) {
      if (!expect.noOutbound && !sentJoined.includes(text.toLowerCase())) fail('meaning', `модели не передано «${text}»`);
    }
  }
  for (const text of expect.sentNot || []) if (outbound.toLowerCase().includes(text.toLowerCase())) fail('privacy', `наружу ушло «${text}»`);
  if (expect.noOutbound && sentTexts.length > 0) fail('privacy', `текст ушёл наружу: ${sentTexts.join(' ').slice(0, 70)}`);
  if (expect.searchEmpty && searchResult && (searchResult.options || []).length > 0) fail('filter', 'подбор нашёл варианты там, где их быть не должно');
  return { problems, specialty, clarify };
};
