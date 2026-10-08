/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Прогон набора через настоящий конвейер и подсчёт утечек.
 *
 * Внешняя модель подменяется заглушкой, которая записывает всё, что ушло бы
 * в сеть, и отвечает пустым планом. Проверяется ровно то, что покинуло бы
 * сервер: реплики и блок подсказок (системный промпт статичен и данных не
 * содержит).
 */

import { normalizeRu } from '../../backend/privacy/normalize.js';
import { inferExpect } from './generate.js';

/* ---------- Разметка ручного набора ---------- */

const KIND_BY_MARK = { P: 'PERSON', PH: 'PHONE_TEXT', E: 'EMAIL_TEXT', A: 'ADDRESS', D: 'DOCUMENT_TEXT', B: 'DOB_TEXT', M: 'MEDICAL', C: 'CATALOG_DOCTOR' };

/** Строка с [[P:…]] → текст без разметки и список чувствительного. */
export const parseMarked = (line) => {
  const sensitive = [];
  let text = '';
  let last = 0;
  const pattern = /\[\[(PH|P|E|A|D|B|M|C):([^\]]+)\]\]/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    text += line.slice(last, match.index);
    const [, mark, value] = match;
    const kind = KIND_BY_MARK[mark];
    const near = text.trim().split(/\s+/).pop() || '';
    if (kind === 'PHONE_TEXT' || kind === 'DOCUMENT_TEXT' || kind === 'DOB_TEXT') {
      const digits = value.replace(/\D/g, '');
      if (digits.length >= 4) sensitive.push({ kind: kind === 'PHONE_TEXT' ? 'PHONE' : kind === 'DOB_TEXT' ? 'DOB' : 'DOCUMENT', value: digits });
      if (/\p{L}{3,}/u.test(value) && kind !== 'DOCUMENT_TEXT') sensitive.push({ kind: kind === 'PHONE_TEXT' ? 'PHONE_WORDS' : 'DOB_WORDS', value });
    } else if (kind === 'EMAIL_TEXT') {
      sensitive.push({ kind: 'EMAIL', value: value.split(/@|\s|\(/)[0].toLowerCase() });
    } else if (kind === 'ADDRESS') {
      sensitive.push({ kind: 'ADDRESS', value, near });
    } else {
      sensitive.push({ kind, value });
    }
    text += value;
    last = match.index + match[0].length;
  }
  text += line.slice(last);
  return { text, sensitive };
};

export const handwrittenSamples = (entries) =>
  entries.map((entry, index) => {
    const lines = Array.isArray(entry) ? entry : [entry];
    const parsed = lines.map(parseMarked);
    const sensitive = parsed.flatMap((item) => item.sensitive);
    const kinds = new Set(sensitive.map((item) => item.kind));
    const category = sensitive.length === 0
      ? 'benign'
      : kinds.size > 1 && kinds.has('PERSON') ? 'combined'
        : kinds.has('PERSON') ? 'person'
          : kinds.has('CATALOG_DOCTOR') ? 'catalog_doctor'
            : kinds.has('MEDICAL') ? 'medical'
              : kinds.has('ADDRESS') ? 'address'
                : kinds.has('EMAIL') ? 'email'
                  : [...kinds].some((kind) => kind.startsWith('PHONE')) ? 'phone' : 'document';
    return {
      expect: inferExpect(parsed.map((item) => item.text).join(' ')),
      id: `hand-${index + 1}`,
      split: 'handwritten',
      category,
      benign: sensitive.length === 0,
      messages: parsed.map((item) => item.text),
      sensitive,
    };
  });

/* ---------- Проверка утечки ---------- */

const words = (text) => ` ${normalizeRu(text)} `;
const digitsOf = (text) => String(text).replace(/\D/g, '');

const containsWindow = (haystackDigits, value, size) => {
  if (value.length < size) return haystackDigits.includes(value);
  for (let start = 0; start + size <= value.length; start += 1) {
    if (haystackDigits.includes(value.slice(start, start + size))) return true;
  }
  return false;
};

/**
 * Что из чувствительного попало в исходящий текст.
 *
 * @param {object[]} sensitive разметка примера
 * @param {string[]} outbound тексты, ушедшие бы в сеть
 */
export const findLeaks = (sensitive, outbound) => {
  const joined = outbound.join('\n');
  const normalized = words(joined);
  const lower = joined.toLowerCase();
  const digits = outbound.map(digitsOf).join('|');
  const leaks = [];

  for (const item of sensitive) {
    const value = String(item.value);
    const norm = normalizeRu(value);
    let leaked = false;
    switch (item.kind) {
      case 'PERSON':
      case 'CATALOG_DOCTOR':
        leaked = norm.length >= 3 && normalized.includes(` ${norm} `);
        break;
      case 'PHONE':
        leaked = containsWindow(digits, digitsOf(value).slice(-10), 5);
        break;
      case 'PHONE_WORDS': {
        const list = norm.split(' ');
        for (let start = 0; start + 4 <= list.length && !leaked; start += 1) {
          leaked = normalized.includes(` ${list.slice(start, start + 4).join(' ')} `);
        }
        break;
      }
      case 'DOCUMENT':
      case 'DOB':
        leaked = containsWindow(digits, digitsOf(value), 6);
        break;
      case 'DOB_WORDS':
        leaked = normalized.includes(` ${norm} `);
        break;
      case 'EMAIL':
        leaked = value.length >= 3 && (lower.includes(value) || normalized.includes(` ${normalizeRu(value)} `));
        break;
      case 'ADDRESS': {
        const near = normalizeRu(item.near || '');
        leaked = [
          near && ` ${near} ${norm} `, near && ` ${near} д ${norm} `, near && ` ${near} дом ${norm} `,
          ` д ${norm} `, ` дом ${norm} `, ` кв ${norm} `, ` квартира ${norm} `,
        ].filter(Boolean).some((needle) => normalized.includes(needle));
        break;
      }
      case 'MEDICAL': {
        const stem = norm.length > 5 ? norm.slice(0, norm.length - 2) : norm;
        leaked = normalized.split(' ').some((word) => word.length >= 3 && word.startsWith(stem));
        break;
      }
      default:
        break;
    }
    if (leaked) leaks.push(item);
  }
  return leaks;
};

/* ---------- Сколько смысла дошло до модели ---------- */

const SPECIALTY_STEMS = {
  therapist: 'терапевт', pediatrician: 'педиатр', cardiologist: 'кардиолог', neurologist: 'невролог', dentist: 'стоматолог',
  lor: 'лор', ophthalmologist: 'окулист', gynecologist: 'гинеколог', urologist: 'уролог', endocrinologist: 'эндокринолог',
  surgeon: 'хирург', dermatologist: 'дерматолог', traumatologist: 'травм(?:атолог|отолог|пункт)', orthopedist: 'ортопед',
};

/*
 * Идут ли шаги в нужном порядке. В описании порядок есть только в строке
 * «Порядок в запросе:», и считается только она: перечисление «профили:
 * therapist, dentist» порядка не задаёт. В тексте пользователя — весь текст.
 */
const orderKept = (order, text) => {
  const start = text.indexOf('порядок в запросе:');
  const scope = start >= 0 ? text.slice(start) : text.includes('пользователь ищет') ? '' : text;
  let cursor = -1;
  for (const marker of order) {
    const pattern = marker.startsWith('@')
      ? new RegExp(marker.toLowerCase(), 'gu')
      : new RegExp(`(?<!\\p{L})(?:${marker}|${SPECIALTY_STEMS[marker]})`, 'gu');
    let found = -1;
    for (const match of scope.matchAll(pattern)) {
      if (match.index > cursor) {
        found = match.index;
        break;
      }
    }
    if (found < 0) return false;
    cursor = found;
  }
  return true;
};
const TIME_MARKERS = {
  availableAfter: ['availableafter', 'available_after', '18:00', 'после 18'],
  evening: ['evening', 'вечер'],
  weekend: ['weekend', 'выходн'],
};

/** Дошли ли до модели профиль, время и место (текстом или в описании). */
export const coverageOf = (expect, outbound) => {
  const text = outbound.join(' ').toLowerCase().replace(/ё/g, 'е');
  const result = {};
  if (expect.specialty) {
    const stem = SPECIALTY_STEMS[expect.specialty];
    result.specialty = text.includes(expect.specialty) || new RegExp(`(?<!\\p{L})${stem}`, 'u').test(text);
  }
  if (expect.time) result.time = TIME_MARKERS[expect.time].some((marker) => text.includes(marker));
  if (expect.child) result.child = /детск|ребен|малыш|грудн|ischild/.test(text);
  if (expect.dms) result.dms = /dmsonly|dms_only|дмс/.test(text);
  if (expect.travel) result.travel = text.includes(expect.travel) || { foot: 'пешком', driving: 'машин', bike: 'велосипед' }[expect.travel] && text.includes({ foot: 'пешком', driving: 'машин', bike: 'велосипед' }[expect.travel]);
  if (expect.clinic) result.clinic = /@clinic|ркб|мкдц|поликлиник/.test(text);
  if (expect.order) result.order = orderKept(expect.order, text);
  if (expect.experience) result.experience = text.includes(`minexperience=${expect.experience}`) || new RegExp(`(?:опыт|стаж)\\p{L}*\\D{0,20}${expect.experience}`, 'u').test(text);
  if (expect.sort) result.sort = text.includes(`sortmode=${expect.sort}`) || text.includes({ rating: 'по рейтинг', experience: 'по стаж' }[expect.sort]);
  if (expect.place) {
    const { kind, value } = expect.place;
    result.place = kind === 'nearest'
      ? ['nearest', 'рядом', 'недалеко', 'поближе', 'поблизости', 'ближайш', '@current_location'].some((marker) => text.includes(marker))
      : text.includes(value) || (kind === 'landmark' && /@location|@place/.test(text));
  }
  return result;
};

/* ---------- Прогон ---------- */

const CLARIFY_PLAN = JSON.stringify({ action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' });

/**
 * Собирает конвейер с записывающей заглушкой вместо модели.
 * Модули передаются снаружи: скрипт и тесты собирают его одинаково.
 */
export const createRecordingPipeline = async ({ modules, outboundMode = undefined }) => {
  const { loadCatalog, createPipeline, createMemoryStore, createTokenVault, createExternalPlanner, createHaversineRoutingProvider, createSafeLogger, createMetrics } = modules;
  let calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.messages.filter((message, index) => !(message.role === 'system' && index === 0)).map((message) => message.content));
    return new Response(JSON.stringify({ choices: [{ message: { content: CLARIFY_PLAN } }], usage: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const catalog = await loadCatalog();
  const pipeline = createPipeline({
    catalog,
    vault: createTokenVault({ store: createMemoryStore(), secret: 'privacy-eval-secret-0123456789' }),
    planner: createExternalPlanner({ apiKey: 'eval', url: 'https://planner.invalid/v1/chat/completions', model: 'eval', fetchImpl }),
    routing: createHaversineRoutingProvider(),
    logger: createSafeLogger({ enabled: false }),
    metrics: createMetrics(),
    outboundMode,
  });
  return {
    catalog,
    async run(messages, sessionId) {
      calls = [];
      const started = performance.now();
      const { action, diagnostics } = await pipeline.handle({
        messages: messages.map((content) => ({ role: 'user', content })),
        sessionId,
      });
      return { action, diagnostics, outbound: calls.flat(), sent: calls.length > 0, ms: performance.now() - started };
    },
  };
};

/** Прогоняет примеры и возвращает результаты по каждому. */
export const evaluateSamples = async (runner, samples, { onProgress = () => {} } = {}) => {
  const results = [];
  for (const [index, item] of samples.entries()) {
    const sessionId = `eval-session-${String(index).padStart(6, '0')}`;
    let outcome;
    try {
      outcome = await runner.run(item.messages, sessionId);
    } catch (error) {
      outcome = { outbound: [], sent: false, ms: 0, error: error?.message || String(error), diagnostics: {} };
    }
    const piiItems = item.sensitive.filter((entry) => entry.kind !== 'CATALOG_DOCTOR');
    const leaks = findLeaks(piiItems, outcome.outbound);
    const catalogLeaks = findLeaks(item.sensitive.filter((entry) => entry.kind === 'CATALOG_DOCTOR'), outcome.outbound);
    const userOutbound = outcome.outbound.filter((text) => !/^Пользователь ищет|^Профили|^Упомянут/.test(text));
    results.push({
      id: item.id,
      split: item.split,
      category: item.category,
      origin: item.origin || null,
      variant: item.variant || null,
      benign: item.benign,
      messages: item.messages,
      sent: outcome.sent,
      leaks,
      catalogLeaks,
      tokens: (outcome.outbound.join(' ').match(/@[A-Z_]+/g) || []).length,
      // Метки персональных данных. @CURRENT_LOCATION и @CLINIC — штатная замена, не порча.
      piiTokens: (outcome.outbound.join(' ').match(/@(?:PERSON|ADDRESS|PHONE|EMAIL|DOB|SNILS|OMS|PASSPORT|ACCOUNT|DOCUMENT|COORDS|URL|HANDLE|PLATE)\w*/g) || []).length,
      verbatim: outcome.sent && item.messages.every((message) => userOutbound.some((text) => normalizeRu(text) === normalizeRu(message))),
      decision: outcome.diagnostics?.decision || null,
      reason: outcome.diagnostics?.reason || outcome.diagnostics?.rejected || null,
      emergency: outcome.diagnostics?.decision === 'emergency',
      synthetic: outcome.sent && outcome.outbound.some((text) => text.startsWith('Пользователь ищет')),
      coverage: outcome.sent ? coverageOf(item.expect || {}, outcome.outbound) : null,
      outbound: outcome.outbound,
      ms: outcome.ms,
      error: outcome.error || null,
    });
    if (index % 500 === 0) onProgress(index, samples.length);
  }
  return results;
};

const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);
const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] * 10) / 10;
};

const coverageSummary = (list) => {
  const out = {};
  for (const key of ['specialty', 'time', 'place', 'child', 'dms', 'travel', 'clinic', 'order', 'experience', 'sort']) {
    const relevant = list.filter((item) => item.coverage && key in item.coverage);
    const synthetic = relevant.filter((item) => item.synthetic);
    out[`${key}Coverage`] = rate(relevant.filter((item) => item.coverage[key]).length, relevant.length);
    out[`${key}CoverageSynthetic`] = rate(synthetic.filter((item) => item.coverage[key]).length, synthetic.length);
  }
  out.syntheticRate = rate(list.filter((item) => item.synthetic).length, list.filter((item) => item.sent).length);
  return out;
};

/** Сводные цифры по результатам. */
export const summarize = (results) => {
  const groups = new Map();
  const add = (key, result) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  };
  for (const result of results) {
    add(`категория:${result.category}`, result);
    if (result.origin) add(`происхождение:${result.origin}`, result);
    if (result.variant) add(`написание:${result.variant}`, result);
  }

  const describe = (list) => {
    const pii = list.filter((item) => !item.benign && item.category !== 'catalog_doctor');
    // «Привет» и «спасибо» — обычные реплики, но запроса в них нет: их правильный путь — локальный ответ.
    const benign = list.filter((item) => item.benign && item.category !== 'smalltalk');
    const smalltalk = list.filter((item) => item.category === 'smalltalk');
    const catalog = list.filter((item) => item.category === 'catalog_doctor');
    return {
      samples: list.length,
      piiSamples: pii.length,
      leakedSamples: pii.filter((item) => item.leaks.length > 0).length,
      leakRate: rate(pii.filter((item) => item.leaks.length > 0).length, pii.length),
      piiSentRate: rate(pii.filter((item) => item.sent && item.leaks.length === 0).length, pii.length),
      piiLocalRate: rate(pii.filter((item) => !item.sent).length, pii.length),
      benignSamples: benign.length,
      benignSentRate: rate(benign.filter((item) => item.sent).length, benign.length),
      benignVerbatimRate: rate(benign.filter((item) => item.verbatim).length, benign.length),
      benignTokenizedRate: rate(benign.filter((item) => item.piiTokens > 0).length, benign.length),
      emergencyFalseAlarms: benign.filter((item) => item.emergency).length,
      // Шлюз разрешил, а выходной предохранитель (planner/client.js) отменил:
      // описание, собранное самим шлюзом, не должно на нём спотыкаться.
      outboundBlocked: list.filter((item) => item.decision === 'allow_external' && !item.sent && !item.error).length,
      smalltalkSamples: smalltalk.length,
      smalltalkSentRate: rate(smalltalk.filter((item) => item.sent).length, smalltalk.length),
      catalogSamples: catalog.length,
      catalogTokenRate: rate(catalog.filter((item) => item.sent && item.catalogLeaks.length === 0 && item.tokens > 0).length, catalog.length),
      catalogNameSentRate: rate(catalog.filter((item) => item.catalogLeaks.length > 0).length, catalog.length),
      ...coverageSummary(list),
      errors: list.filter((item) => item.error).length,
      p50ms: percentile(list.map((item) => item.ms), 50),
      p95ms: percentile(list.map((item) => item.ms), 95),
      maxms: percentile(list.map((item) => item.ms), 100),
    };
  };

  return {
    overall: describe(results),
    groups: Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, list]) => [key, describe(list)])),
  };
};
