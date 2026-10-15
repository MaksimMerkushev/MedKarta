#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Замер модели на настоящих запросах ассистента: npm run ai:bench
 *
 * Прогоняет несколько типичных запросов через весь конвейер (шлюз
 * приватности → модель → валидатор) с разной глубиной рассуждений и
 * печатает время ответа, токены рассуждений, долю принятых планов и цену.
 * Настройки — из .env, как у сервера: адрес модели, ключ, модель, прокси.
 *
 *   npm run ai:bench
 *   npm run ai:bench -- --efforts=default,none,low,medium --runs=2
 *   npm run ai:bench -- --price-in=0.75 --price-out=4.50   (долларов за 1 млн токенов)
 *
 * «default» — параметр рассуждений не отправляется, модель решает сама.
 * Запросы — служебные фразы без персональных данных. Ключ не печатается.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../backend/privacy/catalog.js';
import { createPipeline, plannerTransportFromEnv } from '../backend/pipeline.js';
import { createMemoryStore, createTokenVault } from '../backend/storage/tokenVault.js';
import { createExternalPlanner, REASONING_EFFORTS } from '../backend/planner/client.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const args = Object.fromEntries(process.argv.slice(2).map((item) => {
  const [key, value = ''] = item.replace(/^--/, '').split('=');
  return [key, value];
}));

const QUERIES = [
  'Нужен лор для ребёнка по ДМС, не дальше 20 минут на машине',
  'Кардиолог после 18:00 в Вахитовском районе',
  'Сначала к терапевту, потом к стоматологу, потом домой, пешком',
  'Болит зуб, где ближайшая открытая стоматология?',
  'Окулист со стажем от 10 лет, покажи по рейтингу',
  'Найди эндокринолога, который принимает в выходные',
];

const efforts = (args.efforts || 'default,none,low,medium').split(',').map((item) => item.trim()).filter(Boolean);
for (const effort of efforts) {
  if (effort !== 'default' && !REASONING_EFFORTS.includes(effort)) {
    console.error(`Неизвестный уровень «${effort}». Допустимо: default, ${REASONING_EFFORTS.join(', ')}`);
    process.exit(1);
  }
}
const runs = Math.min(5, Math.max(1, Number(args.runs) || 1));
const priceIn = Number(args['price-in'] || 0.75);
const priceOut = Number(args['price-out'] || 4.5);

const url = process.env.AI_UPSTREAM_URL || '';
const model = process.env.AI_MODEL || 'gpt-5.4-mini';
const transport = plannerTransportFromEnv(process.env, { event() {}, warn() {} });
if (!url) {
  console.error('Задайте AI_UPSTREAM_URL в .env (для OpenRouter: https://openrouter.ai/api/v1/chat/completions). Сначала: npm run ai:check');
  process.exit(1);
}
if (!transport.apiKey) {
  console.error(process.env.AI_PROXY_URL ? 'AI_PROXY_URL записан с ошибкой — проверьте: npm run ai:check' : 'Не задан ключ модели (OPENROUTER_API_KEY).');
  process.exit(1);
}

const catalog = await loadCatalog();
const quiet = createSafeLogger({ enabled: false });

/* Обёртка над транспортом: время до полного ответа и токены из usage. */
const measuredFetch = (calls) => async (target, init) => {
  const started = performance.now();
  const call = { ms: null, status: null, usage: null };
  calls.push(call);
  try {
    const response = await transport.fetchImpl(target, init);
    call.status = response.status;
    const copy = response.clone();
    try {
      const payload = await copy.json();
      call.usage = payload?.usage || null;
    } catch {
      call.usage = null;
    }
    call.ms = performance.now() - started;
    return response;
  } catch (error) {
    call.ms = performance.now() - started;
    call.error = error?.code || error?.name || 'error';
    throw error;
  }
};

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const fmt = (value, digits = 1) => (value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits));

console.log(`\nМедКарта · замер модели ${model}`);
console.log(`Прокси: ${process.env.AI_PROXY_URL ? 'да' : 'нет'} · запросов на уровень: ${QUERIES.length * runs} · цены: $${priceIn} / $${priceOut} за 1 млн\n`);

const rows = [];
for (const effort of efforts) {
  const calls = [];
  const planner = createExternalPlanner({
    apiKey: transport.apiKey,
    url,
    model,
    fetchImpl: measuredFetch(calls),
    reasoningEffort: effort === 'default' ? null : effort,
    logger: quiet,
  });
  const pipeline = createPipeline({
    catalog,
    vault: createTokenVault({ store: createMemoryStore(), secret: randomUUID() + randomUUID() }),
    planner,
    routing: createHaversineRoutingProvider(),
    logger: quiet,
    metrics: createMetrics(),
  });

  const outcomes = [];
  for (let round = 0; round < runs; round += 1) {
    for (const query of QUERIES) {
      const before = calls.length;
      const { diagnostics } = await pipeline.handle({ messages: [{ role: 'user', content: query }], sessionId: randomUUID() });
      const call = calls[before] || null;
      outcomes.push({ query, planSource: diagnostics?.planSource, call });
      process.stdout.write(diagnostics?.planSource === 'external' ? '.' : call ? 'x' : '-');
    }
  }

  const made = outcomes.filter((item) => item.call);
  const answered = made.filter((item) => item.call.status === 200);
  const times = answered.map((item) => item.call.ms / 1000);
  const reasoning = answered.map((item) => item.call.usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  const output = answered.map((item) => item.call.usage?.completion_tokens ?? 0);
  const input = answered.map((item) => item.call.usage?.prompt_tokens ?? 0);
  const reported = answered.map((item) => item.call.usage?.cost).filter(Number.isFinite);
  const costPerCall = reported.length === answered.length && reported.length > 0
    ? reported.reduce((sum, value) => sum + value, 0) / reported.length
    : answered.length > 0
      ? (input.reduce((a, b) => a + b, 0) * priceIn + output.reduce((a, b) => a + b, 0) * priceOut) / 1e6 / answered.length
      : null;
  rows.push({
    effort,
    accepted: outcomes.filter((item) => item.planSource === 'external').length,
    total: outcomes.length,
    failed: made.length - answered.length,
    medianS: median(times),
    maxS: times.length ? Math.max(...times) : null,
    reasoning: median(reasoning),
    output: median(output),
    input: median(input),
    per1000: costPerCall === null ? null : costPerCall * 1000,
    costSource: reported.length === answered.length && reported.length > 0 ? 'OpenRouter' : 'по ценам',
    errors: [...new Set(made.filter((item) => item.call.status !== 200).map((item) => item.call.error || `HTTP ${item.call.status}`))],
  });
  console.log(`  ${effort}`);
}

console.log('\n(. — план модели прошёл валидатор, x — модель не ответила или план отклонён, - — запрос до модели не дошёл)\n');
console.log('Уровень    | Принято | Время, с (медиана / макс) | Рассуждения | Ответ | Вход  | $ за 1000 запросов');
console.log('-----------|---------|---------------------------|-------------|-------|-------|-------------------');
for (const row of rows) {
  console.log([
    row.effort.padEnd(10),
    `${row.accepted}/${row.total}`.padEnd(7),
    `${fmt(row.medianS)} / ${fmt(row.maxS)}`.padEnd(25),
    fmt(row.reasoning, 0).padEnd(11),
    fmt(row.output, 0).padEnd(5),
    fmt(row.input, 0).padEnd(5),
    `${fmt(row.per1000, 2)} (${row.costSource})`,
  ].join(' | '));
  if (row.errors.length) console.log(`           ошибки: ${row.errors.join(', ')}`);
}
console.log('\nТаймаут ассистента — 20 с: всё, что дольше, ассистент не дождётся и ответит по локальному плану.\n');
