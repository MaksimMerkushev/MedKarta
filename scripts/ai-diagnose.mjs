#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Полный путь сообщения через систему: что написал человек, как это понято, какой запрос
 * реально ушёл в модель (перехват на последней точке перед сетью), что она реально ответила,
 * что из этого принято и что увидел пользователь.
 *
 *   node scripts/ai-diagnose.mjs --mode mock
 *       без сети: локальная заглушка, можно гонять все сценарии, в том числе с идентификаторами
 *
 *   node --env-file=.env scripts/ai-diagnose.mjs --mode real --confirm-real --max-calls 70
 *       настоящая модель, расходует деньги. Только сценарии без идентификаторов; остальные
 *       отбрасываются всегда, сверх --max-calls вызовов не будет.
 *
 *   --ids P01,P02   только эти сценарии
 *   --out каталог   куда писать (по умолчанию var/ai-trace/<время>); var/ не попадает в репозиторий
 *
 * В файлах трасс нет ключей и заголовков авторизации. В production скрипт не запускается.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAiTraceSink } from '../backend/observability/aiTrace.js';
import { checkScenario, mockModel } from '../tests/fixtures/ai-check.js';
import { REAL_SCENARIOS, SCENARIOS } from '../tests/fixtures/ai-scenarios.js';

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : null;
};
const mode = option('mode') || 'mock';
const maxCalls = Number(option('max-calls') || 70);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(option('out') || path.join(ROOT, 'var', 'ai-trace', new Date().toISOString().replace(/[:.]/g, '-')));

if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
  console.error('В production диагностика запрещена.');
  process.exit(2);
}
if (mode === 'real' && !process.argv.includes('--confirm-real')) {
  console.error('Настоящая модель расходует деньги: нужен флаг --confirm-real.');
  process.exit(2);
}
process.env.DEMO_DATA = process.env.DEMO_DATA || 'on';
process.env.DEMO_ONLY = process.env.DEMO_ONLY || 'on';
process.env.CHAT_REQUIRES_ACCOUNT = 'off';
if (mode === 'mock') for (const name of ['OPENROUTER_API_KEY', 'AI_API_KEY', 'AI_UPSTREAM_URL', 'AI_PROXY_URL']) delete process.env[name];

const { sanitizeAiAction } = await import('../shared/contract.js');
const { buildQueryFrame } = await import('../backend/understanding/frame.js');
const { createBookingStore, loadSqlite } = await import('../backend/demo/bookingStore.js');
const { getDemoCatalog } = await import('../backend/demo/catalog.js');
const { createDemoSearch } = await import('../backend/demo/search.js');
const { moscowMoment } = await import('../backend/demo/time.js');

const pool = mode === 'real' ? REAL_SCENARIOS : SCENARIOS;
const ids = option('ids')?.split(',');
const selected = ids ? pool.filter((item) => ids.includes(item.id)) : pool;

let exchanges = [];
let callsMade = 0;
setAiTraceSink((exchange) => {
  exchanges.push(exchange);
  callsMade += 1;
});

let pipeline;
let clockNow = Date.now();
if (mode === 'real') {
  const { getDefaultPipeline } = await import('../backend/pipeline.js');
  pipeline = await getDefaultPipeline();
} else {
  const { loadCatalog } = await import('../backend/privacy/catalog.js');
  const { createExternalTriage } = await import('../backend/planner/triage.js');
  const { makeTestPipeline } = await import('../tests/helpers.js');
  clockNow = moscowMoment('2026-10-12', '12:00');
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const text = body.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
    const child = body.messages.some((message) => message.role === 'system' && message.content === 'Приём детский.');
    const payload = { id: 'mock', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(mockModel(text, child)) }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const triage = createExternalTriage({ apiKey: 'mock-key', url: 'https://mock.invalid/api/v1/chat/completions', model: 'mock', fetchImpl });
  ({ pipeline } = makeTestPipeline({ catalog: await loadCatalog(), triage, booking: { enabled: true, now: () => clockNow } }));
}

const DatabaseSync = await loadSqlite();
const index = await getDemoCatalog();
const store = DatabaseSync ? createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => clockNow }) : null;
const search = store ? createDemoSearch({ index, store, getEngine: async () => null, now: () => clockNow }) : null;

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
let stopped = false;
for (const scenario of selected) {
  if (callsMade >= maxCalls) {
    stopped = true;
    break;
  }
  exchanges = [];
  const probe = {};
  const started = Date.now();
  const { action: rawAction, diagnostics } = await pipeline.handle({
    messages: scenario.turns.map((content) => ({ role: 'user', content })),
    sessionId: `diagnose-${scenario.id}-000000`,
    probe,
    takeExternalBudget: () => callsMade < maxCalls,
  });
  const ms = Date.now() - started;
  const action = sanitizeAiAction(JSON.parse(JSON.stringify(rawAction)));
  const request = action.booking?.request || null;
  const searchResult = search && request ? await search.search({ ...request, origin: null, dms: { ...request.dms, planId: null } }) : null;
  const sentTexts = exchanges.filter((item) => JSON.stringify(item.request.body?.response_format || '').includes('medkarta_triage'))
    .flatMap((item) => item.request.body.messages.filter((message) => message.role === 'user').map((message) => message.content));
  const outbound = exchanges.map((item) => JSON.stringify(item.request.body.messages.filter((message) => message.role !== 'system'))).join('\n');
  const { problems, specialty, clarify } = checkScenario(scenario, { action, sentTexts, outbound, searchResult });
  const usage = exchanges.reduce((sum, item) => ({
    prompt: sum.prompt + (item.response?.json?.usage?.prompt_tokens || 0),
    completion: sum.completion + (item.response?.json?.usage?.completion_tokens || 0),
    cost: sum.cost + (Number(item.response?.json?.usage?.cost) || 0),
  }), { prompt: 0, completion: 0, cost: 0 });
  const trace = {
    id: scenario.id,
    mode: mode === 'real' ? 'REAL' : 'MOCK',
    stage1: { turns: scenario.turns, expected: scenario.expect },
    stage2: buildQueryFrame(probe),
    stage3and4: exchanges,
    stage5: {
      decision: diagnostics?.decision,
      planSource: diagnostics?.planSource,
      reply: action.replyText,
      quickReplies: action.quickReplies || [],
      request,
      search: searchResult ? { status: searchResult.status, total: searchResult.total, options: (searchResult.options || []).slice(0, 5).map((option_) => ({ doctor: option_.doctor?.name, price: option_.price?.amount ?? option_.price, next: option_.nextSlot?.startAt })) } : null,
    },
    ms,
    usage,
    specialty,
    clarify,
    problems,
  };
  const statuses = exchanges.map((item) => item.response?.status ?? item.error);
  trace.modelAnswered = exchanges.length > 0 && statuses.every((status) => status === 200);
  fs.writeFileSync(path.join(OUT, `${scenario.id}.json`), JSON.stringify(trace, null, 1));
  rows.push({ id: scenario.id, group: scenario.group, turns: scenario.turns, expected: scenario.expect, specialty, clarify, reply: action.replyText || '', calls: exchanges.length, ms, usage, statuses, modelAnswered: trace.modelAnswered, problems });
  // Ответ без модели (отказ, сбой) — ответ локальных правил: его нельзя выдавать за ответ модели.
  const source = exchanges.length === 0 ? 'без модели' : trace.modelAnswered ? 'модель' : `ОТКАЗ ${statuses.join(',')}`;
  console.log(`${scenario.id}\t${problems.length === 0 ? 'ok' : 'FAIL'}\t${source}\t${specialty || (clarify ? 'вопрос' : '—')}\tвызовов ${exchanges.length}\t${ms} мс\t${problems.map((problem) => problem.text).join('; ').slice(0, 110)}`);
  const denied = statuses.find((status) => status === 401 || status === 402 || status === 403);
  if (mode === 'real' && denied) {
    console.error(`Модель отклонила запрос (HTTP ${denied}): серия остановлена, дальше были бы ответы правил, а не модели.`);
    stopped = true;
    break;
  }
}
store?.close();
setAiTraceSink(null);

const total = rows.reduce((sum, row) => ({ prompt: sum.prompt + row.usage.prompt, completion: sum.completion + row.usage.completion, cost: sum.cost + row.usage.cost, calls: sum.calls + row.calls }), { prompt: 0, completion: 0, cost: 0, calls: 0 });
const times = rows.map((row) => row.ms).sort((a, b) => a - b);
const statusCount = {};
for (const row of rows) for (const status of row.statuses) statusCount[status] = (statusCount[status] || 0) + 1;
const summary = { mode: mode === 'real' ? 'REAL' : 'MOCK', scenarios: rows.length, passed: rows.filter((row) => row.problems.length === 0).length, modelAnswered: rows.filter((row) => row.modelAnswered).length, statuses: statusCount, stopped, ...total, meanMs: Math.round(times.reduce((a, b) => a + b, 0) / (times.length || 1)), p95Ms: times[Math.floor(times.length * 0.95)] ?? 0 };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
console.log(`Трассы: ${OUT}`);
process.exit(0);
