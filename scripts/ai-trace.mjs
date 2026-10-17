#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Что именно уходит в модель на настоящих запросах. Прогоняет сообщения через весь
 * конвейер с настоящей моделью (адрес, ключ, модель, прокси — из .env) и печатает
 * исходный текст, исходящий запрос, ответ, задержку и проверку на утечку.
 *
 *   npm run ai:trace                         — встроенные примеры с вымышленными данными
 *   npm run ai:trace -- "свой запрос" "ещё"  — свои сообщения
 *
 * Вывод остаётся в терминале; ключ и пароль прокси не печатаются.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../backend/privacy/catalog.js';
import { detectEntities } from '../backend/privacy/detectors.js';
import { createPipeline, plannerTransportFromEnv } from '../backend/pipeline.js';
import { createMemoryStore, createTokenVault } from '../backend/storage/tokenVault.js';
import { assertOutboundSafe, createExternalPlanner } from '../backend/planner/client.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

/* Данные в примерах вымышлены. */
const SAMPLES = [
  'Меня зовут Иван Петров, мой телефон +7 917 123-45-67. Нужен лор для сына Артёма, ему 6 лет, по ДМС',
  'Живу на улице Баумана, дом 15, квартира 4 — найди ближайшего кардиолога, который принимает после 18:00',
  'Мой полис ОМС 1234567890123456, почта ivan.petrov@mail.ru. Нужен эндокринолог в выходные',
  'Сначала к терапевту, потом к окулисту, потом домой на Чистопольскую 20, пешком',
];

const messages = process.argv.slice(2).filter((item) => item.trim()).length > 0
  ? process.argv.slice(2).filter((item) => item.trim())
  : SAMPLES;

const url = process.env.AI_UPSTREAM_URL || '';
const model = process.env.AI_MODEL || 'gpt-5.4-mini';
const effort = process.env.AI_REASONING_EFFORT || null;
const transport = plannerTransportFromEnv(process.env, { event() {}, warn() {} });
if (!url || !transport.apiKey) {
  console.error('Сначала настройте модель и проверьте связь: npm run ai:check');
  process.exit(1);
}

const normalize = (text) => String(text).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
const digitsOf = (text) => String(text).replace(/\D/g, '');

/*
 * Утечка — если в исходящем запросе нашлось то, что детекторы увидели во
 * входящем: слово имени или адреса целиком, либо последовательность цифр от
 * пяти знаков (телефон, полис, номер дома с квартирой). Плюс независимая
 * проверка исходящего теми же детекторами, что стоят перед отправкой.
 */
const findLeaks = (original, outbound) => {
  const text = normalize(outbound);
  const words = new Set(text.split(/[^\p{L}\p{N}@._-]+/u).filter(Boolean));
  const digits = digitsOf(outbound);
  const leaks = [];
  for (const span of detectEntities(original).spans) {
    const value = original.slice(span.start, span.end);
    const valueDigits = digitsOf(value);
    const hitWords = normalize(value).split(/[^\p{L}@._-]+/u).filter((word) => word.length >= 3 && words.has(word));
    const hitDigits = valueDigits.length >= 5 && digits.includes(valueDigits);
    if (hitWords.length > 0 || hitDigits) leaks.push(`${span.kind}: «${value}»`);
  }
  for (const kind of assertOutboundSafe(outbound)) leaks.push(`детектор в исходящем: ${kind}`);
  return [...new Set(leaks)];
};

// Самопроверка: проверка утечек должна ловить заведомую утечку, иначе её «чисто» ничего не стоит.
if (findLeaks('Меня зовут Иван Петров, телефон +7 917 123-45-67', 'Пользователь Иван, номер 79171234567').length < 2) {
  console.error('Проверка утечек не распознала контрольный пример — результатам ниже доверять нельзя. Пришлите этот вывод.');
  process.exit(1);
}

const catalog = await loadCatalog();
const quiet = createSafeLogger({ enabled: false });
const calls = [];
const recordingFetch = async (target, init) => {
  const call = { body: JSON.parse(init.body), ms: null, status: null, content: null, usage: null, error: null };
  calls.push(call);
  const started = performance.now();
  try {
    const response = await transport.fetchImpl(target, init);
    call.status = response.status;
    try {
      const payload = await response.clone().json();
      const raw = payload?.error?.metadata?.raw;
      call.content = payload?.choices?.[0]?.message?.content
        ?? ([payload?.error?.message, typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : null].filter(Boolean).join(' — ') || null);
      call.usage = payload?.usage || null;
    } catch {
      call.content = null;
    }
    call.ms = performance.now() - started;
    return response;
  } catch (error) {
    call.ms = performance.now() - started;
    call.error = error?.code || error?.name || 'error';
    throw error;
  }
};

const pipeline = createPipeline({
  catalog,
  vault: createTokenVault({ store: createMemoryStore(), secret: randomUUID() + randomUUID() }),
  planner: createExternalPlanner({ apiKey: transport.apiKey, url, model, fetchImpl: recordingFetch, reasoningEffort: effort, logger: quiet }),
  routing: createHaversineRoutingProvider(),
  logger: quiet,
  metrics: createMetrics(),
});

console.log(`\nМедКарта · что уходит в модель ${model}${effort ? ` (рассуждения: ${effort})` : ''} · прокси: ${process.env.AI_PROXY_URL ? 'да' : 'нет'}`);
console.log('Системная инструкция модели одна и та же для всех запросов и данных пользователя не содержит — ниже она не показана.\n');

let leakedTotal = 0;
const times = [];
for (const [index, original] of messages.entries()) {
  const before = calls.length;
  const started = performance.now();
  const { action, diagnostics } = await pipeline.handle({ messages: [{ role: 'user', content: original }], sessionId: randomUUID() });
  const total = performance.now() - started;
  const call = calls[before] || null;

  console.log(`── ${index + 1} ${'─'.repeat(60)}`);
  console.log(`Пользователь:  ${original}`);
  if (!call) {
    console.log(`В модель:      ничего не отправлено — шлюз приватности решил ответить без внешней модели (${diagnostics?.decision || diagnostics?.planSource || 'локально'})`);
    console.log(`Итог:          ${action?.reply || action?.message || 'ответ собран без модели'}`.slice(0, 200));
    continue;
  }
  const outbound = call.body.messages.slice(1).map((message) => `[${message.role}] ${message.content}`).join('\n               ');
  console.log(`В модель:      ${outbound}`);
  console.log(`Ответ модели:  ${call.error ? `ошибка ${call.error}` : `HTTP ${call.status} · ${String(call.content ?? '').replace(/\s+/g, ' ').slice(0, 220)}`}`);
  const reasoning = call.usage?.completion_tokens_details?.reasoning_tokens;
  console.log(`Задержка:      модель ${(call.ms / 1000).toFixed(2)} с · весь ответ ассистента ${(total / 1000).toFixed(2)} с${Number.isFinite(reasoning) ? ` · рассуждения ${reasoning} ток.` : ''}`);
  console.log(`План:          ${diagnostics?.planSource === 'external' ? 'от модели, прошёл проверку' : `локальный (${diagnostics?.planSource || '—'})`}`);
  if (call.status === 200 && !call.error) times.push(call.ms / 1000);

  const leaks = findLeaks(original, call.body.messages.slice(1).map((message) => message.content).join('\n'));
  leakedTotal += leaks.length;
  console.log(leaks.length === 0 ? 'Утечки:        ✓ имена, телефоны, адреса и номера в модель не ушли' : `Утечки:        ✗ ${leaks.join('; ')}`);
}

console.log(`\n${'═'.repeat(64)}`);
if (times.length > 0) {
  const sorted = [...times].sort((a, b) => a - b);
  console.log(`Задержка модели: от ${sorted[0].toFixed(2)} до ${sorted.at(-1).toFixed(2)} с, медиана ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} с (${times.length} запр.)`);
}
console.log(leakedTotal === 0 ? 'Персональные данные: не найдены ни в одном исходящем запросе.\n' : `Персональные данные: найдено совпадений — ${leakedTotal}. Пришлите этот вывод.\n`);
process.exitCode = leakedTotal === 0 ? 0 : 1;
