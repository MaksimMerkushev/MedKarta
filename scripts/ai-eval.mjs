#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Проверка понимания запросов на сценариях tests/fixtures/ai-scenarios.js. Модель здесь —
 * локальная заглушка, сети нет, ключ не нужен. Качество настоящей модели проверяет
 * scripts/ai-diagnose.mjs --mode real.
 *
 *   node scripts/ai-eval.mjs                   — код этого каталога
 *   node scripts/ai-eval.mjs --root ../old     — другая версия кода (для сравнения A/B)
 *   node scripts/ai-eval.mjs --group holdout   — одна группа сценариев
 *   node scripts/ai-eval.mjs --json out.json   — сохранить результаты
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkScenario, mockModel } from '../tests/fixtures/ai-check.js';
import { SCENARIOS } from '../tests/fixtures/ai-scenarios.js';

const option = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : null;
};
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(option('root') || HERE);
const load = (relative) => import(pathToFileURL(path.join(ROOT, relative)).href);

process.env.DEMO_DATA = 'on';
for (const name of ['OPENROUTER_API_KEY', 'AI_API_KEY', 'AI_UPSTREAM_URL', 'AI_PROXY_URL', 'AI_SYMPTOM_TRIAGE', 'PUBLIC_CLINICS']) delete process.env[name];

const { loadCatalog, __resetCatalogCache } = await load('backend/privacy/catalog.js');
const { moscowMoment } = await load('backend/demo/time.js');
const { createExternalTriage } = await load('backend/planner/triage.js');
const { sanitizeAiAction } = await load('shared/contract.js');
const { makeTestPipeline, TEST_SESSION } = await load('tests/helpers.js');
const { createBookingStore, loadSqlite } = await load('backend/demo/bookingStore.js');
const { getDemoCatalog } = await load('backend/demo/catalog.js');
const { createDemoSearch } = await load('backend/demo/search.js');

const NOW = moscowMoment('2026-10-12', '12:00');
const DatabaseSync = await loadSqlite();
__resetCatalogCache();
const catalog = await loadCatalog();
const index = await getDemoCatalog();
const store = DatabaseSync ? createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW }) : null;
const search = store ? createDemoSearch({ index, store, getEngine: async () => null, now: () => NOW }) : null;

const runScenario = async (scenario) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const text = body.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
    calls.push({ text, serialized: JSON.stringify(body.messages.filter((message) => message.role !== 'system')) });
    const child = body.messages.some((message) => message.role === 'system' && message.content === 'Приём детский.');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: JSON.stringify(mockModel(text, child)) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), clone() { return { text: async () => '{}' }; } };
  };
  const triage = createExternalTriage({ apiKey: 'test-key', url: 'https://llm.example.test/v1/chat/completions', model: 'mock', fetchImpl });
  const { pipeline, sent } = makeTestPipeline({ catalog, triage, booking: { enabled: true, now: () => NOW } });
  const started = performance.now();
  const { action: rawAction } = await pipeline.handle({ messages: scenario.turns.map((content) => ({ role: 'user', content })), sessionId: TEST_SESSION });
  const ms = performance.now() - started;
  const action = sanitizeAiAction(JSON.parse(JSON.stringify(rawAction)));
  const request = action.booking?.request || null;
  const searchResult = scenario.expect.searchEmpty && search && request ? await search.search({ ...request, origin: null, dms: { ...request.dms, planId: null } }) : null;
  const outbound = [...calls.map((call) => call.serialized), ...sent.map((item) => item.serialized)].join('\n');
  const { problems, specialty, clarify } = checkScenario(scenario, { action, sentTexts: calls.map((call) => call.text), outbound, searchResult });
  return { id: scenario.id, group: scenario.group, turns: scenario.turns, specialty, clarify, reply: action.replyText || '', request, sent: calls.map((call) => call.text), calls: calls.length, ms, problems };
};

const group = option('group');
const selected = group ? SCENARIOS.filter((item) => item.group === group) : SCENARIOS;
const results = [];
for (const scenario of selected) {
  try {
    results.push(await runScenario(scenario));
  } catch (error) {
    results.push({ id: scenario.id, group: scenario.group, turns: scenario.turns, problems: [{ kind: 'crash', text: String(error?.message || error).slice(0, 140) }], ms: 0 });
  }
}
store?.close();

const groups = {};
for (const item of results) {
  const entry = (groups[item.group] ||= { total: 0, ok: 0 });
  entry.total += 1;
  if (item.problems.length === 0) entry.ok += 1;
}
const kinds = {};
for (const item of results) for (const problem of item.problems) kinds[problem.kind] = (kinds[problem.kind] || 0) + 1;
const times = results.map((item) => item.ms).sort((a, b) => a - b);
const summary = { root: ROOT, total: results.length, ok: results.filter((item) => item.problems.length === 0).length, groups, kinds, meanMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length), p95Ms: Math.round(times[Math.floor(times.length * 0.95)]) };
if (option('json')) fs.writeFileSync(option('json'), JSON.stringify({ summary, results }, null, 1));

console.log(`Версия: ${ROOT}`);
console.log(`Прошло ${summary.ok} из ${summary.total}; группы ${JSON.stringify(groups)}`);
console.log(`Проблемы по видам: ${JSON.stringify(kinds)}; среднее ${summary.meanMs} мс, p95 ${summary.p95Ms} мс (локально, без сети)`);
if (!process.argv.includes('--quiet')) {
  for (const item of results) {
    if (item.problems.length === 0) continue;
    console.log(`  ${item.id} ${item.problems.map((problem) => `[${problem.kind}] ${problem.text}`).join('; ').slice(0, 210)}`);
  }
}
process.exit(0);
