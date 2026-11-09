#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Путь лабораторного запроса через систему, по этапам: исходный текст → что понял
 * сервер → обезличенные фрагменты → настоящий запрос к модели (перехват на
 * последней точке перед сетью) → её ответ → разобранный результат → условия
 * подбора → найденные лаборатории → токены и стоимость.
 *
 *   node scripts/labs-diagnose.mjs --mode mock
 *       без сети: модель — локальная заглушка, можно гонять все сценарии
 *   node --env-file=.env scripts/labs-diagnose.mjs --mode real --confirm-real --max-calls 10
 *       настоящая модель, расходует деньги. Модели уходят только фрагменты, которых
 *       нет в каталоге; сценарии с идентификаторами (real: false) отбрасываются всегда.
 *   --ids L28,L29  только эти сценарии;  --out каталог (по умолчанию var/ai-trace/labs-<время>)
 *
 * В файлах нет ключей и заголовков авторизации. В production скрипт не запускается.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setAiTraceSink } from '../backend/observability/aiTrace.js';
import { LAB_SCENARIOS, checkLabScenario } from '../tests/fixtures/lab-scenarios.js';

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : null;
};
const mode = option('mode') || 'mock';
const maxCalls = Number(option('max-calls') || 10);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(option('out') || path.join(ROOT, 'var', 'ai-trace', `labs-${new Date().toISOString().replace(/[:.]/g, '-')}`));

if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
  console.error('В production диагностика запрещена.');
  process.exit(2);
}
if (mode === 'real' && !process.argv.includes('--confirm-real')) {
  console.error('Настоящая модель расходует деньги: нужен флаг --confirm-real.');
  process.exit(2);
}
if (mode === 'mock') for (const name of ['OPENROUTER_API_KEY', 'AI_API_KEY', 'AI_UPSTREAM_URL', 'AI_PROXY_URL']) delete process.env[name];

const { loadSqlite } = await import('../backend/demo/bookingStore.js');
const { moscowMoment } = await import('../backend/demo/time.js');
const { createLabStore } = await import('../backend/labs/store.js');
const { createLabService } = await import('../backend/labs/service.js');
const { createLabAssistant } = await import('../backend/labs/assistant.js');
const { createExternalLabParser } = await import('../backend/planner/labParser.js');

const DatabaseSync = await loadSqlite();
const now = mode === 'mock' ? () => moscowMoment('2026-11-09', '09:00') : () => Date.now();
const service = createLabService({ store: createLabStore({ DatabaseSync, file: ':memory:', now }), now });

let parser;
if (mode === 'real') {
  const { plannerTransportFromEnv } = await import('../backend/pipeline.js');
  parser = createExternalLabParser({
    ...plannerTransportFromEnv(),
    url: process.env.AI_UPSTREAM_URL,
    model: process.env.AI_LAB_MODEL || process.env.AI_TRIAGE_MODEL || process.env.AI_MODEL,
  });
} else {
  // Заглушка в формате настоящего ответа: перехват видит тот же запрос, что ушёл бы в сеть.
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const fragments = body.messages[1].content.split('\n').slice(1).map((line) => line.replace(/^\d+\.\s*/u, ''));
    const items = fragments.map((fragment) => ({ fragment, code: /ферритинн/u.test(fragment) ? 'FERRITIN' : 'UNKNOWN' }));
    const payload = { id: 'mock', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ items }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  parser = createExternalLabParser({ apiKey: 'mock-key', url: 'https://mock.invalid/api/v1/chat/completions', model: 'mock', fetchImpl });
}

let exchanges = [];
let callsMade = 0;
setAiTraceSink((exchange) => {
  exchanges.push(exchange);
  callsMade += 1;
});
const assistant = createLabAssistant({ getService: async () => service, parser });

const ids = option('ids')?.split(',');
const pool = LAB_SCENARIOS.filter((item) => ['labs'].includes(item.expect.path) && (mode !== 'real' || item.real !== false));
const selected = ids ? pool.filter((item) => ids.includes(item.id)) : pool;
fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const scenario of selected) {
  if (callsMade >= maxCalls) break;
  exchanges = [];
  const started = Date.now();
  const answer = await assistant.handle({ messages: scenario.turns.map((content) => ({ role: 'user', content })), takeExternalBudget: () => callsMade < maxCalls });
  const ms = Date.now() - started;
  if (!answer) {
    rows.push({ id: scenario.id, skipped: 'не лабораторный ответ' });
    continue;
  }
  const quote = answer.action.labs?.search ? await service.quote(answer.action.labs.request) : null;
  const fragments = answer.model?.fragments || [];
  const problems = checkLabScenario(scenario, { action: answer.action, planSource: 'labs', fragments });
  const usage = exchanges.reduce((sum, item) => ({
    prompt: sum.prompt + (item.response?.json?.usage?.prompt_tokens || 0),
    completion: sum.completion + (item.response?.json?.usage?.completion_tokens || 0),
    cost: sum.cost + (Number(item.response?.json?.usage?.cost) || 0),
  }), { prompt: 0, completion: 0, cost: 0 });
  const trace = {
    id: scenario.id,
    mode: mode === 'real' ? 'REAL' : 'MOCK',
    stage1_input: scenario.turns,
    stage2_understood: { tests: answer.analysis.tests, operations: answer.analysis.operations, filters: answer.analysis.filters, ambiguous: answer.analysis.ambiguous, intents: answer.analysis.intents, unresolved: answer.analysis.unresolved },
    stage3_deidentified_fragments: fragments,
    stage4_request_and_response: exchanges,
    stage5_parsed: answer.model?.mapped || null,
    stage6_applied_request: answer.action.labs?.request || null,
    stage7_reply: { text: answer.action.replyText, quickReplies: answer.action.quickReplies },
    stage8_labs: quote ? { status: quote.status, total: quote.total, top: quote.options.slice(0, 3).map((item) => ({ lab: item.lab.name, branch: item.branch.name, total: item.total, tests: item.testsTotal, fees: item.feesTotal, firstSlot: item.slots[0] ? `${item.slots[0].day} ${item.slots[0].start}` : null, turnaround: item.turnaroundText })) } : null,
    usage,
    ms,
    problems,
  };
  fs.writeFileSync(path.join(OUT, `${scenario.id}.json`), JSON.stringify(trace, null, 1));
  rows.push({ id: scenario.id, calls: exchanges.length, statuses: exchanges.map((item) => item.response?.status ?? item.error), ms, usage, problems });
  console.log(`${scenario.id}\t${problems.length ? 'FAIL' : 'ok'}\tвызовов ${exchanges.length}\t${ms} мс\t${(answer.action.labs?.tests || []).map((test) => test.code).join('+') || '—'}\t${problems.join('; ').slice(0, 100)}`);
}
setAiTraceSink(null);
const total = rows.reduce((sum, row) => ({ calls: sum.calls + (row.calls || 0), prompt: sum.prompt + (row.usage?.prompt || 0), completion: sum.completion + (row.usage?.completion || 0), cost: sum.cost + (row.usage?.cost || 0) }), { calls: 0, prompt: 0, completion: 0, cost: 0 });
const summary = { mode: mode === 'real' ? 'REAL' : 'MOCK', scenarios: rows.length, passed: rows.filter((row) => row.problems && row.problems.length === 0).length, ...total };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
console.log(`Трассы: ${OUT}`);
process.exit(0);
