/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Подробная статистика админ-панели: период, обезличивание адресов, почасовые
 * счётчики в своей базе, сводка запросов и ассистента, журнал аналитики за
 * период, разделы из базы аккаунтов и права (только суперадминистратор).
 * Время заморожено: «сейчас» — среда 04.11.2026, 12:30 МСК.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bootstrapSuperadmin } from '../backend/accounts/bootstrap.js';
import { createDelivery } from '../backend/accounts/delivery.js';
import { checkRolePermissions, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS } from '../backend/accounts/rbac.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { createStatsCollector, STATS_RETENTION_DAYS } from '../backend/stats/collector.js';
import { endpointOf, groupOfEndpoint } from '../backend/stats/endpoints.js';
import { collectStats } from '../backend/stats/index.js';
import { bucketIndex, bucketStarts, moscowDayKey, PeriodError, resolvePeriod } from '../backend/stats/period.js';
import { loadProductDays, mergeProductDays, PRODUCT_SUMMARY_VERSION, summarizeDay } from '../backend/stats/product.js';
import { buildAssistantSection, buildRequestsSection, changeOf, parseMetricKey, percentileOf } from '../backend/stats/report.js';
import { buildBookingSection, buildMailSection, rollup } from '../backend/stats/sections.js';
import { createStatsStore, latencyBucket, LATENCY_BOUNDS } from '../backend/stats/store.js';
import { browserFor, softAuthenticator, startAuthServer } from './helpers/authKit.js';

const DatabaseSync = await loadSqlite();
const skip = !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)';
const msk = (text) => Date.parse(`${text}+03:00`);
const NOW = msk('2026-11-04T12:30:00');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* -------------------------------- Период --------------------------------- */

describe('Статистика: период', () => {
  it('готовые варианты — по московскому календарю', () => {
    const today = resolvePeriod({ preset: 'today' }, NOW);
    assert.equal(today.from, msk('2026-11-04T00:00:00'));
    assert.equal(today.to, NOW);
    assert.equal(today.bucket, 'hour');
    const yesterday = resolvePeriod({ preset: 'yesterday' }, NOW);
    assert.equal(yesterday.from, msk('2026-11-03T00:00:00'));
    assert.equal(yesterday.to, msk('2026-11-04T00:00:00'));
    assert.deepEqual(yesterday.days, ['2026-11-03']);
    const week = resolvePeriod({ preset: '7d' }, NOW);
    assert.equal(week.from, msk('2026-10-29T00:00:00'));
    assert.equal(week.bucket, 'day');
    assert.equal(week.buckets.length, 7);
    const month = resolvePeriod({ preset: 'month' }, NOW);
    assert.equal(month.from, msk('2026-11-01T00:00:00'));
    const previous = resolvePeriod({ preset: 'prev_month' }, NOW);
    assert.equal(previous.from, msk('2026-10-01T00:00:00'));
    assert.equal(previous.to, msk('2026-11-01T00:00:00'));
    assert.equal(previous.buckets.length, 31);
    assert.equal(resolvePeriod({ preset: 'year' }, NOW).from, msk('2026-01-01T00:00:00'));
  });

  it('свои даты: конец включительно, будущее обрезается, прошлый период той же длины', () => {
    const period = resolvePeriod({ from: '2026-10-01', to: '2026-10-07' }, NOW);
    assert.equal(period.key, 'custom');
    assert.equal(period.from, msk('2026-10-01T00:00:00'));
    assert.equal(period.to, msk('2026-10-08T00:00:00'));
    assert.equal(period.previous.to, period.from);
    assert.equal(period.previous.to - period.previous.from, 7 * DAY);
    assert.equal(resolvePeriod({ from: '2026-11-01', to: '2030-01-01' }, NOW).to, NOW, 'будущего нет');
    const hours = resolvePeriod({ from: '2026-11-03T14:00', to: '2026-11-03T18:30' }, NOW);
    assert.equal(hours.to - hours.from, 4.5 * HOUR);
    assert.equal(hours.bucket, 'hour');
  });

  it('неверный период — отказ с понятным текстом, а не молчаливая подмена', () => {
    for (const query of [
      { from: '2026-02-31', to: '2026-03-01' },
      { from: 'вчера', to: '2026-03-01' },
      { from: '2026-03-01' },
      { from: '2026-03-02', to: '2026-03-01' },
      { from: '2026-03-02T25:00', to: '2026-03-03' },
      { from: '2020-01-01', to: '2026-01-01' },
      { from: { x: 1 }, to: '2026-01-01' },
    ]) {
      assert.throws(() => resolvePeriod(query, NOW), PeriodError, JSON.stringify(query));
    }
  });

  it('ключи прототипа и неизвестные значения — период по умолчанию', () => {
    for (const preset of ['__proto__', 'constructor', 'toString', 'нет такого', 42]) {
      assert.equal(resolvePeriod({ preset }, NOW).key, '7d', String(preset));
    }
  });

  it('шаг: автоматический по длине, свой — если помещается, иначе экран об этом узнает', () => {
    assert.equal(resolvePeriod({ preset: '24h' }, NOW).bucket, 'hour');
    assert.equal(resolvePeriod({ preset: '90d' }, NOW).bucket, 'day');
    assert.equal(resolvePeriod({ from: '2026-01-01', to: '2026-11-01' }, NOW).bucket, 'week');
    assert.equal(resolvePeriod({ from: '2025-01-01', to: '2026-11-01' }, NOW).bucket, 'month');
    const weekly = resolvePeriod({ preset: '30d', bucket: 'week' }, NOW);
    assert.equal(weekly.bucket, 'week');
    assert.equal(weekly.bucketAdjusted, false);
    const tooFine = resolvePeriod({ preset: '90d', bucket: 'hour' }, NOW);
    assert.equal(tooFine.bucket, 'day');
    assert.equal(tooFine.bucketAdjusted, true);
    assert.equal(resolvePeriod({ preset: '7d', bucket: 'год' }, NOW).bucket, 'day');
  });

  it('корзины: неделя с понедельника, месяц с первого числа, поиск корзины', () => {
    const weeks = bucketStarts(msk('2026-11-04T00:00:00'), NOW, 'week');
    assert.equal(weeks[0], msk('2026-11-02T00:00:00'), 'понедельник');
    const months = bucketStarts(msk('2026-10-15T00:00:00'), NOW, 'month');
    assert.deepEqual(months, [msk('2026-10-01T00:00:00'), msk('2026-11-01T00:00:00')]);
    assert.equal(bucketIndex(months, msk('2026-10-20T00:00:00')), 0);
    assert.equal(bucketIndex(months, msk('2026-11-01T00:00:00')), 1);
    assert.equal(bucketIndex(months, msk('2026-09-20T00:00:00')), -1);
  });
});

/* ----------------------------- Обезличивание ----------------------------- */

describe('Статистика: адрес запроса обезличен', () => {
  it('идентификаторы заменяются, параметров и слов пользователя в строке нет', () => {
    assert.equal(endpointOf('POST', '/api/chat', 200), 'POST /api/chat');
    assert.equal(endpointOf('GET', '/api/admin/users', 200), 'GET /api/admin/users');
    assert.equal(endpointOf('GET', '/api/admin/users/0a1b2c3d4e5f60718293a4b5c6d7e8f9', 200), 'GET /api/admin/users/:id');
    assert.equal(endpointOf('POST', '/api/admin/users/0a1b2c/block', 200), 'POST /api/admin/users/:id/block');
    assert.equal(endpointOf('GET', '/api/admin/users/maximka@example.ru', 200), 'GET /api/admin/users/:id');
    assert.equal(endpointOf('GET', '/api/legal/terms/2026-10-28.1', 200), 'GET /api/legal/terms/:id');
    assert.equal(endpointOf('GET', '/api/me/ИВАНОВ', 200), 'GET /api/me/:id');
  });

  it('несуществующие адреса, статика и странные методы не плодят строк', () => {
    assert.equal(endpointOf('GET', '/api/wp-admin/setup-config', 404), 'unknown');
    assert.equal(endpointOf('GET', '/login', 200), 'static');
    assert.equal(endpointOf('GET', '/assets/index-abc.js', 200), 'static');
    assert.equal(endpointOf('BREW', '/api/chat', 405), 'OTHER /api/chat');
    assert.equal(endpointOf('GET', '/api/a/b/c/d/e/f/g', 200), 'unknown');
  });

  it('группы маршрутов — как в разделе «Система», новые пути записи — там же', () => {
    assert.equal(groupOfEndpoint('POST /api/chat'), 'Ассистент');
    assert.equal(groupOfEndpoint('GET /api/admin/users/:id'), 'Админ-панель');
    assert.equal(groupOfEndpoint('POST /api/demo/search'), 'Демо-запись');
    assert.equal(groupOfEndpoint('POST /api/booking/search'), 'Демо-запись');
    assert.equal(groupOfEndpoint('static'), 'Статика');
    assert.equal(groupOfEndpoint('unknown'), 'Несуществующие адреса');
  });
});

/* ------------------------------- Хранилище ------------------------------- */

describe('Статистика: счётчики в своей базе', { skip }, () => {
  const setup = ({ counters = {}, ...options } = {}) => {
    const clock = { t: NOW };
    const store = createStatsStore({ DatabaseSync, file: ':memory:' });
    const live = { counters };
    const collector = createStatsCollector({ getStore: () => store, metrics: { snapshot: () => ({ counters: live.counters }) }, now: () => clock.t, ...options });
    return { clock, store, collector, live };
  };

  it('запросы копятся в памяти и дописываются одной строкой на час и адрес', () => {
    const { clock, store, collector } = setup();
    collector.recordRequest('POST', '/api/chat', 200, 120);
    collector.recordRequest('POST', '/api/chat', 200, 80);
    collector.recordRequest('POST', '/api/chat', 429, 1);
    collector.recordRequest('POST', '/api/chat', 503, 6000);
    assert.equal(store.httpRows({ from: 0, to: NOW * 2 }).length, 0, 'до записи базы не трогаем');
    assert.equal(collector.flush(), true);
    collector.recordRequest('POST', '/api/chat', 302, 10);
    collector.flush();
    clock.t += HOUR;
    collector.recordRequest('POST', '/api/chat', 200, 10);
    collector.flush();
    const rows = store.httpRows({ from: 0, to: NOW * 2 });
    assert.equal(rows.length, 2, 'следующий час — новая строка');
    const [first] = rows;
    assert.equal(first.endpoint, 'POST /api/chat');
    assert.equal(first.hour, Math.floor(NOW / HOUR) * HOUR);
    assert.equal(first.count, 5);
    assert.deepEqual([first.s2xx, first.s3xx, first.s4xx, first.s429, first.s5xx], [2, 1, 1, 1, 1]);
    assert.equal(first.totalMs, 6211);
    assert.equal(first.latency.reduce((sum, value) => sum + value, 0), 5);
    assert.equal(first.latency[latencyBucket(6000)], 1);
    assert.equal(store.firstHour(), first.hour);
  });

  it('в файле базы нет ни адресов, ни токенов, ни почты', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-stats-'));
    const file = path.join(dir, 'stats.sqlite');
    const store = createStatsStore({ DatabaseSync, file });
    const collector = createStatsCollector({ getStore: () => store, now: () => NOW });
    collector.recordRequest('GET', '/api/admin/users/maximka@example.ru', 200, 5);
    collector.recordRequest('GET', '/api/auth/activation/SecretTokenValue0123456789', 200, 5);
    collector.flush();
    store.close();
    const raw = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name)).toString('latin1')).join('');
    assert.ok(!raw.includes('maximka') && !raw.includes('SecretTokenValue'));
    assert.ok(raw.includes(':id'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('счётчики процесса — разницей и по суткам; перезапуск не даёт отрицательных чисел', () => {
    const { clock, store, collector, live } = setup({ counters: { 'planner.usage{provider=x}': 5 } });
    collector.flush();
    live.counters = { 'planner.usage{provider=x}': 8, 'gateway.emergency': 1 };
    collector.flush();
    clock.t += DAY;
    live.counters = { 'planner.usage{provider=x}': 1 };
    collector.flush();
    const rows = store.metricRows({ fromDay: '2026-01-01', toDay: '2027-01-01' }).map((row) => [row.day, row.key, row.value]);
    assert.deepEqual(rows.sort(), [
      ['2026-11-04', 'gateway.emergency', 1],
      ['2026-11-04', 'planner.usage{provider=x}', 8],
    ], 'после перезапуска счётчик начал с 1 — это меньше прошлого значения, разницы нет');
  });

  it('потолок строк на час: перебор адресов не раздувает таблицу', () => {
    const { store, collector } = setup({ maxEndpoints: 3 });
    for (const word of ['alpha', 'beta', 'gamma', 'delta', 'omega']) collector.recordRequest('GET', `/api/${word}`, 200, 1);
    collector.flush();
    const names = store.httpRows({ from: 0, to: NOW * 2 }).map((row) => row.endpoint).sort();
    assert.equal(names.length, 4);
    assert.ok(names.includes('unknown'));
  });

  it('сбой записи не теряет данные и не мешает запросам', () => {
    let broken = true;
    const real = createStatsStore({ DatabaseSync, file: ':memory:' });
    const store = { ...real, write: (batch) => { if (broken) throw new Error('disk full'); real.write(batch); } };
    const collector = createStatsCollector({ getStore: () => store, now: () => NOW });
    collector.recordRequest('GET', '/api/config', 200, 1);
    assert.equal(collector.flush(), false);
    broken = false;
    assert.equal(collector.flush(), true);
    assert.equal(real.httpRows({ from: 0, to: NOW * 2 })[0].count, 1);
  });

  it('база ещё не открыта — запросы копятся до открытия', () => {
    let store = null;
    const collector = createStatsCollector({ getStore: () => store, now: () => NOW });
    collector.recordRequest('GET', '/api/config', 200, 1);
    assert.equal(collector.flush(), false);
    store = createStatsStore({ DatabaseSync, file: ':memory:' });
    assert.equal(collector.flush(), true);
    assert.equal(store.httpRows({ from: 0, to: NOW * 2 }).length, 1);
  });

  it('срок хранения: старые строки удаляются при первой записи за сутки', () => {
    const { clock, store, collector } = setup();
    const old = NOW - (STATS_RETENTION_DAYS + 2) * DAY;
    store.write({
      requests: [{ hour: Math.floor(old / HOUR) * HOUR, endpoint: 'GET /api/config', count: 1, s2xx: 1, s3xx: 0, s4xx: 0, s429: 0, s5xx: 0, totalMs: 1, latency: Array(LATENCY_BOUNDS.length + 1).fill(0) }],
      metrics: [{ day: moscowDayKey(old), key: 'planner.usage', value: 1 }],
    });
    collector.recordRequest('GET', '/api/config', 200, 1);
    collector.flush();
    clock.t += 1;
    const rows = store.httpRows({ from: 0, to: NOW * 2 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hour, Math.floor(NOW / HOUR) * HOUR);
    assert.equal(store.metricRows({ fromDay: '2000-01-01', toDay: '2100-01-01' }).length, 0);
  });
});

/* -------------------------------- Сводка --------------------------------- */

const httpRow = (hour, endpoint, count, extra = {}) => ({
  hour, endpoint, count, s2xx: count, s3xx: 0, s4xx: 0, s429: 0, s5xx: 0, totalMs: count * 40, latency: [0, count, 0, 0, 0, 0, 0, 0, 0, 0], ...extra,
});

describe('Статистика: сводка запросов', () => {
  const period = resolvePeriod({ from: '2026-11-02', to: '2026-11-03' }, NOW);
  const rows = [
    httpRow(msk('2026-11-02T10:00:00'), 'POST /api/chat', 10, { s2xx: 7, s4xx: 2, s429: 1, s5xx: 1, totalMs: 5000, latency: [0, 0, 0, 0, 0, 10, 0, 0, 0, 0] }),
    httpRow(msk('2026-11-02T10:00:00'), 'GET /api/config', 30),
    httpRow(msk('2026-11-03T23:00:00'), 'GET /api/config', 20),
    httpRow(msk('2026-11-03T23:00:00'), 'static', 40),
  ];
  const previousRows = [httpRow(msk('2026-10-31T10:00:00'), 'GET /api/config', 50)];

  it('итоги, изменение к прошлому периоду, ряды по корзинам', () => {
    const section = buildRequestsSection({ period, rows, previousRows });
    assert.equal(period.bucket, 'hour');
    assert.equal(section.totals.count, 100);
    assert.equal(section.totals.s5xx, 1);
    assert.equal(section.totals.s429, 1);
    assert.equal(section.totals.errorRate, 1);
    assert.equal(section.previous.count, 50);
    assert.equal(section.change.count, 100);
    assert.equal(section.series.count.reduce((sum, value) => sum + value, 0), 100);
    assert.equal(section.series.count[bucketIndex(period.buckets, msk('2026-11-02T10:00:00'))], 40);
    assert.equal(section.series.s5xx.reduce((sum, value) => sum + value, 0), 1);
  });

  it('разрезы: адреса, группы, карта часов и пик', () => {
    const section = buildRequestsSection({ period, rows, previousRows });
    assert.equal(section.byEndpoint[0].name, 'GET /api/config');
    assert.equal(section.byEndpoint[0].count, 50);
    assert.equal(section.byEndpoint[0].share, 50);
    assert.equal(section.byEndpoint.find((row) => row.name === 'POST /api/chat').group, 'Ассистент');
    assert.deepEqual(section.byGroup.map((row) => row.name), ['Служебные', 'Статика', 'Ассистент']);
    assert.equal(section.heatmap[0][10], 40, 'понедельник, 10 часов');
    assert.equal(section.heatmap[1][23], 60, 'вторник, 23 часа');
    assert.equal(section.perHourOfDay[23], 60);
    assert.equal(section.peakHour.count, 60);
    assert.equal(section.peakDay.count, 60);
  });

  it('время ответа: среднее точно, процентили — верхняя граница корзины', () => {
    const section = buildRequestsSection({ period, rows, previousRows });
    const chat = section.byEndpoint.find((row) => row.name === 'POST /api/chat');
    assert.equal(chat.avgMs, 500);
    assert.equal(chat.p95Ms, 1000);
    assert.equal(percentileOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.5), null);
    assert.equal(percentileOf([9, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0.5), 25);
    assert.equal(percentileOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 0.95), 10000, 'дольше всех корзин — нижняя граница последней');
  });

  it('пустой период и деление на ноль', () => {
    const section = buildRequestsSection({ period, rows: [], previousRows: [] });
    assert.equal(section.totals.count, 0);
    assert.equal(section.totals.avgMs, null);
    assert.equal(section.totals.errorRate, null);
    assert.equal(section.change.count, null);
    assert.equal(section.peakHour, null);
    assert.equal(changeOf(5, 0), null);
    assert.equal(changeOf(5, 10), -50);
  });

  it('ассистент: обращения к модели, токены, решения и отказы из счётчиков по суткам', () => {
    const requests = buildRequestsSection({ period, rows, previousRows });
    const metricRows = [
      { day: '2026-11-02', key: 'planner.usage{provider=openrouter}', value: 6 },
      { day: '2026-11-03', key: 'planner.usage{provider=openrouter}', value: 4 },
      { day: '2026-11-02', key: 'planner.tokens{kind=prompt}', value: 1000 },
      { day: '2026-11-02', key: 'planner.tokens{kind=completion}', value: 200 },
      { day: '2026-11-02', key: 'planner.local_fallback{reason=medical_text_policy}', value: 3 },
      { day: '2026-11-02', key: 'gateway.decision{decision=local_only}', value: 3 },
      { day: '2026-11-02', key: 'gateway.decision{decision=allow_external}', value: 7 },
      { day: '2026-11-02', key: 'triage.result{status=clarify}', value: 2 },
      { day: '2026-11-02', key: 'gateway.emergency', value: 1 },
      { day: '2026-11-03', key: 'planner.budget_exhausted', value: 2 },
      { day: '2026-11-03', key: 'api.chat.shed', value: 1 },
      { day: '2026-11-03', key: 'planner.error{code=timeout}', value: 1 },
    ];
    const section = buildAssistantSection({ period, requests, metricRows, previousMetricRows: [{ day: '2026-10-31', key: 'planner.usage{provider=openrouter}', value: 5 }], dailyLimit: 2000 });
    assert.equal(section.requests.count, 10);
    assert.equal(section.modelCalls, 10);
    assert.equal(section.modelCallsChange, 100);
    assert.deepEqual(section.tokens, { prompt: 1000, completion: 200, total: 1200 });
    assert.equal(section.localAnswers, 3);
    assert.deepEqual(section.gatewayDecisions[0], { key: 'allow_external', value: 7 });
    assert.deepEqual(section.triage.results, [{ key: 'clarify', value: 2 }]);
    assert.equal(section.emergency, 1);
    assert.equal(section.problems.budgetExhausted, 2);
    assert.equal(section.problems.shed, 1);
    assert.deepEqual(section.problems.plannerErrors, [{ key: 'timeout', value: 1 }]);
    assert.deepEqual(section.daily.map((row) => row.modelCalls), [6, 4]);
    assert.equal(section.dailyLimit, 2000);
    assert.deepEqual(parseMetricKey('auth.login{status=ok}'), { name: 'auth.login', labels: { status: 'ok' } });
    assert.deepEqual(parseMetricKey('gateway.emergency'), { name: 'gateway.emergency', labels: {} });
  });
});

/* ---------------------------- Журнал аналитики --------------------------- */

const event = (ts, type, sid, fields) => JSON.stringify({ ts, v: 1, type, sid, ...fields });
const SEARCH = { source: 'filters', specialty: 'lor', filters: ['profile'], results: 4 };

describe('Статистика: поиск и карта за период', { skip }, () => {
  let dir;
  let store;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-product-'));
    store = createStatsStore({ DatabaseSync, file: ':memory:' });
    fs.writeFileSync(path.join(dir, 'events-2026-11-02.jsonl'), [
      event('2026-11-02T07:10Z', 'search', 'session-aaa', { ...SEARCH, hasLocation: true, dmsPlan: true }),
      event('2026-11-02T07:11Z', 'result_open', 'session-aaa', { surface: 'map', kind: 'doctor', specialty: 'lor', placeId: 'doc-1' }),
      event('2026-11-02T07:12Z', 'contact_click', 'session-aaa', { channel: 'phone', kind: 'doctor', placeId: 'doc-1' }),
      event('2026-11-02T07:13Z', 'search', 'session-bbb', { source: 'assistant', specialty: 'therapist', filters: ['district'], results: 0 }),
      event('2026-11-02T07:14Z', 'feedback', 'session-bbb', { context: 'list', answer: 'no', reason: 'too_far' }),
      event('2026-11-02T07:15Z', 'route_build', 'session-bbb', { mode: 'foot', stops: 1, outcome: 'failed' }),
      '{повреждённая строка',
      JSON.stringify({ ts: '2026-11-02T07:16Z', v: 1, type: 'search', sid: 'session-ccc', source: 'filters', filters: [], results: 1, query: 'болит ухо у сына' }),
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'events-2026-11-03.jsonl'), [
      event('2026-11-03T08:00Z', 'search', 'session-ddd', { ...SEARCH, results: 9 }),
      event('2026-11-03T08:01Z', 'route_build', 'session-ddd', { mode: 'driving', stops: 1, outcome: 'ok' }),
      event('2026-11-03T08:02Z', 'external_map_click', 'session-ddd', { provider: 'yandex', mode: 'auto', stops: 1 }),
      event('2026-11-03T08:03Z', 'data_report', 'session-ddd', { reason: 'wrong_phone', kind: 'doctor', placeId: 'doc-1' }),
    ].join('\n'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('сутки складываются; успешный поиск — как в отчёте по поискам; лишнее поле отбрасывает событие', async () => {
    const loaded = await loadProductDays({ dir, store, days: ['2026-11-01', '2026-11-02', '2026-11-03'], today: '2026-11-04' });
    assert.equal(loaded.length, 2, 'за 1 ноября журнала нет');
    const names = { 'doc-1': 'Иванова Анна' };
    const product = mergeProductDays(loaded, { placeName: (id) => names[id] || null });
    assert.equal(product.events, 10, 'повреждённая строка и событие с текстом запроса не считаются');
    assert.equal(product.funnel.sessions, 3);
    assert.equal(product.searches.total, 3);
    assert.equal(product.searches.zeroResults, 1);
    assert.equal(product.searches.successful, 2);
    assert.equal(product.searches.withLocation, 1);
    assert.equal(product.searches.withDms, 1);
    assert.deepEqual(product.bySpecialty[0], { specialty: 'lor', searches: 2, successful: 2, zeroResults: 0, successRate: 100 });
    assert.deepEqual(product.bySource.map((row) => [row.source, row.searches]), [['filters', 2], ['assistant', 1]]);
    assert.deepEqual(product.filters, [{ key: 'profile', value: 2 }, { key: 'district', value: 1 }]);
    assert.deepEqual(product.resultCounts, { zero: 1, few: 1, many: 1 });
    assert.deepEqual(product.zeroResults.bySpecialty, [{ key: 'therapist', value: 1 }]);
    assert.deepEqual(product.contacts.topPlaces, [{ id: 'doc-1', name: 'Иванова Анна', value: 1 }]);
    assert.deepEqual(product.opens.topPlaces, [{ id: 'doc-1', name: 'Иванова Анна', value: 1 }]);
    assert.deepEqual(product.routes, { ok: 1, failed: 1, failureRate: 50, modes: [{ key: 'driving', value: 1 }, { key: 'foot', value: 1 }] });
    assert.deepEqual(product.feedback.reasons, [{ key: 'too_far', value: 1 }]);
    assert.deepEqual(product.dataReports.topPlaces, [{ id: 'doc-1', name: 'Иванова Анна', value: 1 }]);
    assert.equal(product.searchesPerHour[10], 2, 'часы — московские: 07:10 UTC → 10');
    assert.equal(product.searchesPerHour[11], 1);
    assert.deepEqual(product.daily.map((row) => [row.day, row.searches]), [['2026-11-02', 2], ['2026-11-03', 1]]);
    assert.doesNotMatch(JSON.stringify(product), /болит|session-/);
  });

  it('завершённые сутки берутся из свода, текущие — читаются заново', async () => {
    const days = ['2026-11-02', '2026-11-03'];
    const fresh = createStatsStore({ DatabaseSync, file: ':memory:' });
    await loadProductDays({ dir, store: fresh, days, today: '2026-11-03' });
    assert.ok(fresh.productDay('2026-11-02', PRODUCT_SUMMARY_VERSION), 'завершённые — в своде');
    assert.equal(fresh.productDay('2026-11-03', PRODUCT_SUMMARY_VERSION), null, 'текущие — нет: день ещё идёт');
    assert.equal(fresh.productDay('2026-11-02', PRODUCT_SUMMARY_VERSION + 1), null, 'другая версия формата — считать заново');

    const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-product-empty-'));
    const again = await loadProductDays({ dir: moved, store: fresh, days, today: '2026-11-03' });
    assert.deepEqual(again.map((item) => item.day), ['2026-11-02'], 'файла уже нет, а свод остался');
    fs.rmSync(moved, { recursive: true, force: true });
  });

  it('пустой журнал — нули, а не ошибки', () => {
    const product = mergeProductDays([]);
    assert.equal(product.events, 0);
    assert.equal(product.searches.successRate, null);
    assert.deepEqual(product.bySpecialty, []);
    assert.equal(summarizeDay([]).funnel.sessions, 0);
  });

  it('отчёт целиком: период, запросы, ассистент, поиск и то, откуда ведётся учёт', async () => {
    const stats = createStatsStore({ DatabaseSync, file: ':memory:' });
    const hour = msk('2026-11-03T10:00:00');
    stats.write({
      requests: [httpRow(hour, 'POST /api/chat', 5)],
      metrics: [{ day: '2026-11-03', key: 'planner.usage{provider=x}', value: 2 }],
    });
    let flushed = 0;
    const report = await collectStats({ store: stats, dir, query: { from: '2026-11-02', to: '2026-11-03' }, now: NOW, flush: () => { flushed += 1; } });
    assert.equal(flushed, 1, 'перед чтением счётчики дописываются — цифры на сейчас');
    assert.equal(report.requests.totals.count, 5);
    assert.equal(report.assistant.modelCalls, 2);
    assert.equal(report.product.searches.total, 3);
    assert.equal(report.product.daysWithData, 2);
    assert.equal(report.coverage.collecting, true);
    assert.equal(report.coverage.requestsSince, new Date(hour).toISOString());

    const off = await collectStats({ store: null, dir: '/нет/такого', query: { preset: '7d' }, now: NOW });
    assert.equal(off.coverage.collecting, false);
    assert.equal(off.requests.totals.count, 0);
    assert.equal(off.product.events, 0);
  });
});

/* ------------------------------- Разделы --------------------------------- */

describe('Статистика: письма и запись', () => {
  const period = resolvePeriod({ from: '2026-11-02', to: '2026-11-03' }, NOW);
  const at = msk('2026-11-02T10:00:00');

  it('письма: по видам и статусам, коды ошибок', () => {
    const section = buildMailSection({
      period,
      keepDays: 30,
      rows: [
        { kind: 'reset', status: 'sent', error: null, createdAt: at },
        { kind: 'reset', status: 'failed', error: 'smtp_auth', createdAt: at },
        { kind: 'reset', status: 'failed', error: 'smtp_auth', createdAt: at },
        { kind: 'invite', status: 'pending', error: null, createdAt: at },
      ],
    });
    assert.deepEqual([section.total, section.sent, section.failed, section.pending], [4, 1, 2, 1]);
    assert.equal(section.deliveryRate, 33.3);
    assert.deepEqual(section.byKind[0], { kind: 'reset', total: 3, sent: 1, failed: 2, pending: 0 });
    assert.deepEqual(section.errors, [{ key: 'smtp_auth', value: 2 }]);
    assert.equal(section.series.failed.reduce((sum, value) => sum + value, 0), 2);
    assert.equal(section.keepDays, 30);
  });

  it('запись: созданные и отменённые в период, разрезы по справочнику', () => {
    const start = msk('2026-11-05T18:30:00');
    const row = (extra) => ({ status: 'CONFIRMED', createdAt: at, cancelledAt: null, startAt: start, withPlan: false, withAccount: false, specialty: 'ЛОР', doctor: 'Иванова', clinic: 'Витарис', district: 'Вахитовский', service: 'Приём', ...extra });
    const section = buildBookingSection({
      period,
      now: NOW,
      rows: [
        row({ withPlan: true, withAccount: true }),
        row({ specialty: 'Терапевт', status: 'CANCELLED', cancelledAt: msk('2026-11-03T09:00:00') }),
        // Создана раньше периода, отменена в нём: в созданные не идёт, в отменённые — да.
        row({ createdAt: msk('2026-10-20T09:00:00'), status: 'CANCELLED', cancelledAt: msk('2026-11-02T09:00:00') }),
      ],
    });
    assert.equal(section.available, true);
    assert.deepEqual([section.created, section.cancelled, section.stillActive], [2, 2, 1]);
    assert.equal(section.withPlan, 1);
    assert.equal(section.withAccount, 1);
    assert.equal(section.upcomingActive, 1);
    assert.deepEqual(section.bySpecialty, [{ key: 'Терапевт', value: 1 }, { key: 'ЛОР', value: 1 }].sort((a, b) => a.key.localeCompare(b.key)));
    assert.equal(section.hourOfDay[18], 2);
    assert.equal(section.weekday[3], 2, 'приём в четверг');
    assert.ok(section.averageLeadHours > 0);
    assert.equal(section.series.created.reduce((sum, value) => sum + value, 0), 2);
    assert.equal(section.series.cancelled.reduce((sum, value) => sum + value, 0), 2);
    assert.deepEqual(buildBookingSection({ period, rows: null, now: NOW }), { available: false });
  });

  it('мелкие корзины сворачиваются в корзины периода', () => {
    const weekly = resolvePeriod({ from: '2026-10-26', to: '2026-11-03', bucket: 'week' }, NOW);
    assert.deepEqual(rollup({ period: weekly, since: weekly.from, stepMs: DAY, values: [1, 1, 1, 1, 1, 1, 1, 5, 5] }), [7, 10]);
  });
});

/* -------------------------------- Права ---------------------------------- */

describe('Статистика: права и API', { skip }, () => {
  const ROOT_PASSWORD = 'Корневой-пароль-для-тестов-1';
  let server;
  let base;
  let root;
  let context;
  const seen = [];

  before(async () => {
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    context = createAccountContext({
      store,
      mfaKey: randomBytes(32),
      delivery: createDelivery({ env: {} }),
      env: { PUBLIC_BASE_URL: 'https://medkarta.test' },
      breachCheck: async () => ({ breached: false }),
      systemInfo: async () => null,
      onAccountDeleted: async () => {},
      collectStats: async ({ query, now }) => {
        seen.push(query);
        const stats = createStatsStore({ DatabaseSync, file: ':memory:' });
        return collectStats({ store: stats, dir: '/нет/такого', query, now });
      },
      bookingRows: async () => [],
    });
    await bootstrapSuperadmin({ store, email: 'root@medkarta.test', firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startAuthServer(context));
    root = browserFor(base);
    assert.equal((await root.login('root@medkarta.test', ROOT_PASSWORD)).status, 200);
    await root.enrollPasskey(softAuthenticator());
  });
  after(() => server?.close());

  it('разрешение есть только у суперадминистратора и другим не выдаётся', () => {
    assert.ok(PERMISSION_KEYS.includes('stats.view'));
    assert.ok(DEFAULT_ROLE_PERMISSIONS.superadmin.includes('stats.view'));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.admin.includes('stats.view'));
    assert.ok(!DEFAULT_ROLE_PERMISSIONS.moderator.includes('stats.view'));
    assert.match(checkRolePermissions('admin', ['admin.access', 'stats.view']).errors.join(' '), /только суперадминистратору/);
  });

  it('суперадминистратор получает отчёт со всеми разделами', async () => {
    const response = await root.call('/api/admin/stats?preset=30d');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const { body } = response;
    assert.equal(body.period.key, '30d');
    assert.equal(body.period.buckets.length, body.requests.series.count.length);
    assert.equal(body.period.buckets.length, 30);
    assert.ok(body.presets.some((item) => item.key === 'prev_month'));
    for (const section of ['requests', 'assistant', 'product', 'accounts', 'mail', 'booking', 'coverage']) assert.ok(body[section], section);
    assert.equal(body.accounts.users.total, 1);
    assert.ok(body.accounts.auth.some((item) => item.key === 'login_ok' && item.value >= 1));
    assert.equal(body.accounts.series.logins.length, 30);
    assert.equal(body.accounts.series.activeUsers.length, 30);
    assert.equal(body.booking.available, true);
    assert.equal(body.coverage.mailKeepDays, 30);
    assert.equal(seen.at(-1).preset, '30d');
  });

  it('шаг и свои даты — из адреса; неверный период — 400', async () => {
    const custom = await root.call('/api/admin/stats?from=2026-01-01&to=2026-01-31&bucket=week');
    assert.equal(custom.status, 200);
    assert.equal(custom.body.period.bucket, 'week');
    assert.equal(custom.body.period.key, 'custom');
    const hourly = await root.call('/api/admin/stats?preset=today');
    assert.equal(hourly.body.period.bucket, 'hour');
    assert.equal(hourly.body.accounts.series.activeUsers, null, 'активность — по суткам, по часам её нет');
    for (const query of ['from=2026-02-31&to=2026-03-01', 'from=2026-03-02&to=2026-03-01', 'from=2026-03-01']) {
      const response = await root.call(`/api/admin/stats?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.code, 'bad_period');
    }
    for (const preset of ['__proto__', 'constructor']) {
      assert.equal((await root.call(`/api/admin/stats?preset=${preset}`)).status, 200, preset);
    }
  });

  it('админ и гость статистику не получают; в ответе нет людей', async () => {
    const created = await root.call('/api/admin/users', { method: 'POST', body: { email: 'admin@medkarta.test', firstName: 'Админ', lastName: 'Тестов', role: 'admin' } });
    assert.equal(created.status, 201);
    assert.equal((await browserFor(base).call('/api/admin/stats')).status, 401);
    const denied = await context.admin.stats({ id: 'x', role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin }, {}).catch((error) => error);
    assert.equal(denied.code, 'forbidden');
    const { body } = await root.call('/api/admin/stats?preset=30d');
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /root@medkarta|admin@medkarta|Максим/);
    assert.equal(text.includes(created.body.user.id), false);
  });
});
