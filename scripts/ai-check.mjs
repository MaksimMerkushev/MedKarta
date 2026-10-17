#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Проверка связи с моделью: npm run ai:check. Один запрос той же формы, что у
 * ассистента (промпт, JSON-схема плана, параметры; настройки из .env), ответ — через тот
 * же валидатор. Пользовательских данных в запросе нет (служебное «нужен терапевт рядом»);
 * ключ и пароль прокси не печатаются.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlannerBody, REASONING_EFFORTS } from '../backend/planner/client.js';
import { PLANNER_SYSTEM_PROMPT } from '../backend/planner/prompts.js';
import { validatePlan } from '../backend/planner/validator.js';
import { createProxyFetch, describeProxy, parseProxyUrl } from '../backend/planner/proxyFetch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const DEFAULT_URL = 'https://modelhub.my/v1/chat/completions';
const apiKey = process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY || '';
const url = process.env.AI_UPSTREAM_URL || DEFAULT_URL;
const model = process.env.AI_MODEL || 'gpt-5.4-mini';
const proxySetting = process.env.AI_PROXY_URL || '';
const effort = process.env.AI_REASONING_EFFORT || '';

const ok = (text) => console.log(`  ✓ ${text}`);
const warn = (text) => console.log(`  ! ${text}`);
const fail = (text, hint) => {
  console.log(`  ✗ ${text}`);
  if (hint) console.log(`    → ${hint}`);
  process.exitCode = 1;
};
const scrub = (text) => {
  let result = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (apiKey) result = result.split(apiKey).join('***');
  return result;
};

console.log('\nМедКарта · проверка связи с моделью\n');

let target;
try {
  target = new URL(url);
} catch {
  fail('AI_UPSTREAM_URL — не адрес.', 'Пример: AI_UPSTREAM_URL=https://openrouter.ai/api/v1/chat/completions');
  process.exit(1);
}
if (process.env.AI_UPSTREAM_URL) ok(`Адрес модели: ${target.host}${target.pathname}`);
else warn(`AI_UPSTREAM_URL не задан — запрос уйдёт на ${target.host}. Для OpenRouter задайте https://openrouter.ai/api/v1/chat/completions`);
if (target.protocol !== 'https:') fail('Адрес модели должен быть https://');

if (apiKey) ok('Ключ модели задан');
else fail('Ключ модели не задан.', 'Добавьте в .env строку OPENROUTER_API_KEY=… (ключ из openrouter.ai/keys)');

ok(`Модель: ${model}${effort ? `, рассуждения: ${effort}` : ''}`);
if (effort && !REASONING_EFFORTS.includes(effort)) {
  fail(`AI_REASONING_EFFORT=${scrub(effort)} — такого значения нет.`, `Допустимо: ${REASONING_EFFORTS.join(', ')}`);
}
if (target.host === 'openrouter.ai' && !model.includes('/')) {
  warn('Для OpenRouter имя модели пишется с префиксом поставщика, например openai/gpt-5.4-mini');
}

let fetchImpl = fetch;
if (proxySetting) {
  try {
    const proxy = parseProxyUrl(proxySetting);
    fetchImpl = createProxyFetch({ proxy, connectTimeoutMs: 15_000 });
    ok(`Прокси: ${describeProxy(proxy)}${proxy.username ? ' (с логином)' : ''}`);
  } catch (error) {
    fail(`AI_PROXY_URL: ${error.message}`, 'Формат: AI_PROXY_URL=login:password@ip:port (или socks5://login:password@ip:port)');
  }
} else {
  warn('Прокси не задан (AI_PROXY_URL) — запрос пойдёт напрямую с этого сервера');
}

if (process.exitCode) {
  console.log('\nИсправьте настройки выше и запустите проверку снова.\n');
  process.exit(1);
}

const PROXY_HINTS = {
  proxy_auth: 'Прокси не принял логин или пароль — сверьте AI_PROXY_URL с данными от продавца прокси.',
  proxy_connect: 'Прокси недоступен с этого сервера: проверьте IP и порт, оплачен ли прокси, не нужен ли белый список IP у продавца.',
  proxy_timeout: 'Прокси не ответил за 15 секунд: он перегружен или недоступен из этой сети.',
  proxy_refused: 'Прокси отказался подключаться к модели: у некоторых прокси закрыт порт 443 или есть список разрешённых сайтов.',
  proxy_protocol: 'Прокси отвечает не по этому протоколу. Если это SOCKS5 — запишите AI_PROXY_URL=socks5://login:password@ip:port, если HTTP — без схемы.',
  proxy_config: 'Адрес прокси записан с ошибкой.',
  tls: 'Сертификат модели не прошёл проверку. Так бывает, если прокси подменяет HTTPS — такой прокси использовать нельзя: он видит ключ.',
  upstream_timeout: 'Модель не ответила за 30 секунд.',
  upstream_connect: 'Соединение с моделью оборвалось на полпути.',
};

// Тот же запрос, что собирает ассистент (backend/planner/client.js): промпт, схема, параметры.
const body = buildPlannerBody({
  model,
  messages: [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: 'Пользователь ищет врача по профилю: therapist. Ограничения: selection=nearest.' },
  ],
  reasoningEffort: REASONING_EFFORTS.includes(effort) ? effort : null,
});

/*
 * Для OpenRouter — какой ключ на самом деле используется и сколько по нему
 * потрачено (GET /api/v1/key). По метке ключа его можно найти на
 * openrouter.ai/keys и убедиться, что запросы идут именно туда.
 */
const isOpenRouter = target.host === 'openrouter.ai';
const keyInfo = async () => {
  try {
    const response = await fetchImpl(new URL('/api/v1/key', target).href, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return (await response.json())?.data || null;
  } catch (error) {
    return { error: error?.code || error?.name || 'ошибка' };
  }
};
const money = (value) => (Number.isFinite(value) ? `$${value.toFixed(4)}` : '—');
let keyBefore = null;
if (isOpenRouter) {
  keyBefore = await keyInfo();
  if (keyBefore && !keyBefore.error) {
    ok(`Ключ OpenRouter: ${scrub(keyBefore.label || 'без метки')} · потрачено ${money(keyBefore.usage)}${Number.isFinite(keyBefore.limit) ? ` из лимита $${keyBefore.limit}` : ''} · сегодня ${money(keyBefore.usage_daily)}`);
  } else {
    warn(`Сведения о ключе не получены (${keyBefore?.error || 'пустой ответ'})`);
  }
  // Стоимость этого запроса — в ответе (usage accounting OpenRouter).
  body.usage = { include: true };
}

console.log('\nЗапрос к модели…');
const started = Date.now();
let response;
try {
  response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(45_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
} catch (error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    fail('Нет ответа за 45 секунд.', proxySetting ? PROXY_HINTS.proxy_timeout : 'Проверьте доступ этого сервера в интернет.');
  } else if (PROXY_HINTS[error?.code]) {
    fail(scrub(error.message), PROXY_HINTS[error.code]);
  } else {
    const cause = error?.cause?.code || error?.code || error?.name || 'ошибка сети';
    fail(`Не удалось связаться с ${target.host} (${cause}).`, proxySetting ? null : 'С российского сервера OpenRouter недоступен напрямую — задайте AI_PROXY_URL.');
  }
  process.exit(1);
}

const elapsed = Date.now() - started;
let payload = null;
try {
  payload = await response.json();
} catch {
  payload = null;
}

if (!response.ok) {
  // OpenRouter кладёт настоящую причину от провайдера в error.metadata.raw.
  const raw = payload?.error?.metadata?.raw;
  const rawText = typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '';
  const message = scrub([payload?.error?.message || payload?.message || '', rawText].filter(Boolean).join(' — '));
  const status = response.status;
  let hint = null;
  if (status === 401) hint = 'Ключ неверный или отозван — выпустите новый на openrouter.ai/keys.';
  else if (status === 402) hint = 'На балансе OpenRouter не хватает денег.';
  else if (status === 403 && /region|country|location|territor/i.test(message)) {
    hint = proxySetting
      ? 'OpenRouter видит адрес из запрещённого региона. Проверьте страну прокси: нужна не Россия (например, Нидерланды, Германия, Финляндия).'
      : 'Запрос идёт с российского адреса — задайте AI_PROXY_URL.';
  } else if (status === 403) hint = 'Доступ к этой модели закрыт для аккаунта (так бывает при российском платёжном адресе). Попробуйте другую модель или аккаунт.';
  else if (status === 404) hint = 'Модель не найдена. Для OpenRouter: AI_MODEL=openai/gpt-5.4-mini (список — openrouter.ai/models).';
  else if (status === 400 && effort && /reason|effort/i.test(message)) hint = `Модель не принимает AI_REASONING_EFFORT=${effort} — уберите строку или поставьте low.`;
  else if (status === 400) hint = 'Модель не приняла параметры запроса. Пришлите этот вывод — поправлю запрос под модель.';
  else if (status === 429) hint = 'Слишком много запросов — подождите минуту.';
  else if (status >= 500) hint = 'Сбой на стороне провайдера — повторите позже или выберите другую модель.';
  fail(`Модель ответила ${status}${message ? `: ${message}` : ''}`, hint);
  process.exit(1);
}

const choice = payload?.choices?.[0];
const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
const usage = payload?.usage || {};
const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
ok(`Ответ за ${(elapsed / 1000).toFixed(1)} с, модель: ${payload?.model || model}${payload?.provider ? `, провайдер: ${payload.provider}` : ''}`);
if (payload?.id) ok(`ID запроса в OpenRouter: ${scrub(payload.id)}${Number.isFinite(usage.cost) ? ` · стоимость ${money(usage.cost)}` : ''}`);
if (Number.isFinite(usage.prompt_tokens)) {
  ok(`Токены: запрос ${usage.prompt_tokens}, ответ ${usage.completion_tokens}${Number.isFinite(reasoning) ? ` (из них рассуждения ${reasoning})` : ''}`);
}

if (!content.trim()) {
  fail(
    `Ответ пустой${choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ''}.`,
    effort ? 'Модель потратила лимит ответа на рассуждения. Пришлите этот вывод — подстрою запрос.' : 'Модель потратила лимит ответа на рассуждения — добавьте в .env AI_REASONING_EFFORT=low.',
  );
  process.exit(1);
}
const verdict = validatePlan(content, { allowedTokens: new Set(), allowedDistricts: [] });
const plan = verdict?.value || null;
const steps = Array.isArray(plan?.steps) ? plan.steps : [];
if (!verdict?.ok) {
  fail(`План модели не прошёл проверку: ${scrub(content)}`, 'Модель плохо следует схеме плана — пришлите этот вывод.');
} else if (plan?.action === 'FIND_DOCTOR' && steps.some((step) => step.specialty === 'therapist')) {
  ok(`План принят валидатором: ${plan.action}, терапевт — ассистент будет работать через эту модель`);
} else {
  warn(`План принят валидатором, но неожиданный: ${scrub(content)}`);
}

if (isOpenRouter && keyBefore && !keyBefore.error) {
  const keyAfter = await keyInfo();
  if (keyAfter && !keyAfter.error) {
    ok(`Потрачено по ключу после запроса: ${money(keyAfter.usage)} (статистика на сайте OpenRouter обновляется с задержкой)`);
  }
}

console.log(process.exitCode ? '\nЕсть проблемы — см. выше.\n' : '\nВсё в порядке.\n');
