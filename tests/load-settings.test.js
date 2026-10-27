/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лимиты нагрузки и бюджет модели из админ-панели («Нагрузка и лимиты»):
 * весь зал на одном Wi-Fi — один адрес, и на показе лимиты «на адрес»
 * поднимаются множителем без перезапуска. Общий предохранитель нагрузки от
 * множителя не зависит, а выбранный бюджет модели — не отказ, а локальный план.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createSettingsService, settingDefinition } from '../backend/accounts/settings.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { createCpuQueue } from '../backend/api/chat.js';
import {
  createCostLimiter,
  createExternalBudget,
  createRateLimiter,
  ipLimitScale,
  liveSetting,
  setLimitSettings,
} from '../backend/http/rateLimit.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const LOAD_KEYS = ['limits.ipScale', 'limits.chatQueue', 'ai.callsPer5Min', 'ai.dailyCallLimit'];

const memoryStore = () => {
  const rows = new Map();
  return {
    listSettings: () => [...rows.values()],
    putSettings: (items, actorId, at) => {
      for (const item of items) rows.set(item.key, { key: item.key, value: item.value, updatedAt: at, updatedBy: actorId });
    },
  };
};

const withSettings = (values) => setLimitSettings((key) => values[key]);

afterEach(() => setLimitSettings(null));

describe('настройки нагрузки в админ-панели', () => {
  it('ключи, значения по умолчанию, рекомендованные значения для показа', () => {
    const settings = createSettingsService({ store: memoryStore(), env: {} });
    const items = settings.list().filter((item) => LOAD_KEYS.includes(item.key));
    assert.deepEqual(items.map((item) => item.key), LOAD_KEYS, 'одна группа, порядок как на экране');
    assert.ok(items.every((item) => item.group === 'Нагрузка и лимиты' && item.type === 'number' && !item.public));
    assert.deepEqual(Object.fromEntries(items.map((item) => [item.key, item.value])), {
      'limits.ipScale': 1,
      'limits.chatQueue': 16,
      'ai.callsPer5Min': 300,
      'ai.dailyCallLimit': 2000,
    });
    for (const item of items) assert.ok(item.demoValue > item.defaultValue, `${item.key}: «Для показа» поднимает лимит`);
    assert.equal(settings.list().find((item) => item.key === 'app.name').demoValue, null);
    assert.equal(settingDefinition('limits.ipScale').public, false, 'в /api/config не попадает');
  });

  it('суточный лимит по умолчанию — из AI_DAILY_CALL_LIMIT', () => {
    assert.equal(createSettingsService({ store: memoryStore(), env: { AI_DAILY_CALL_LIMIT: '750' } }).get('ai.dailyCallLimit'), 750);
    assert.equal(createSettingsService({ store: memoryStore(), env: { AI_DAILY_CALL_LIMIT: '0' } }).get('ai.dailyCallLimit'), 0);
    assert.equal(createSettingsService({ store: memoryStore(), env: { AI_DAILY_CALL_LIMIT: 'много' } }).get('ai.dailyCallLimit'), 2000);
    assert.equal(createSettingsService({ store: memoryStore(), env: { AI_DAILY_CALL_LIMIT: '-5' } }).get('ai.dailyCallLimit'), 2000);
    assert.equal(createSettingsService({ store: memoryStore(), env: { AI_DAILY_CALL_LIMIT: '900000' } }).get('ai.dailyCallLimit'), 100000);
  });

  it('проверка значений: границы, дроби, строки', () => {
    const settings = createSettingsService({ store: memoryStore(), env: {} });
    const rejected = [
      { 'limits.ipScale': 0 },
      { 'limits.ipScale': 51 },
      { 'limits.ipScale': 2.5 },
      { 'limits.ipScale': '×20' },
      { 'limits.ipScale': -1 },
      { 'limits.chatQueue': 3 },
      { 'limits.chatQueue': 201 },
      { 'ai.callsPer5Min': 5001 },
      { 'ai.callsPer5Min': -1 },
      { 'ai.dailyCallLimit': 100001 },
      { 'ai.dailyCallLimit': null },
      { 'ai.dailyCallLimit': Number.POSITIVE_INFINITY },
    ];
    for (const values of rejected) assert.ok(settings.update(values, 'root').errors, JSON.stringify(values));
    assert.equal(settings.get('limits.ipScale'), 1, 'отклонённое не сохранилось');
    const saved = settings.update({ 'limits.ipScale': '20', 'limits.chatQueue': 64, 'ai.callsPer5Min': 0, 'ai.dailyCallLimit': 5000 }, 'root');
    assert.deepEqual(Object.keys(saved.changes).sort(), [...LOAD_KEYS].sort());
    assert.equal(settings.get('limits.ipScale'), 20, 'строка из поля ввода — число');
    assert.equal(settings.get('ai.callsPer5Min'), 0, '0 — модель выключена, это допустимо');
  });

  it('испорченное значение в базе — действует значение по умолчанию', () => {
    const store = memoryStore();
    store.putSettings([{ key: 'limits.ipScale', value: '"много"' }, { key: 'limits.chatQueue', value: '{' }], 'root', 1);
    const settings = createSettingsService({ store, env: {} });
    assert.equal(settings.get('limits.ipScale'), 1);
    assert.equal(settings.get('limits.chatQueue'), 16);
  });
});

describe('множитель лимитов на один адрес', () => {
  it('без кабинета и при сбое чтения — значения из кода', () => {
    assert.equal(ipLimitScale(), 1);
    assert.equal(liveSetting('ai.callsPer5Min', 300), 300);
    setLimitSettings(() => {
      throw new Error('база недоступна');
    });
    assert.equal(ipLimitScale(), 1);
    assert.equal(liveSetting('limits.chatQueue', 16), 16);
    withSettings({ 'limits.ipScale': 'двадцать' });
    assert.equal(ipLimitScale(), 1, 'нечисловое значение не применяется');
    withSettings({ 'limits.ipScale': 500 });
    assert.equal(ipLimitScale(), 50, 'потолок ×50 и в обход проверки настроек');
    withSettings({ 'limits.ipScale': -3 });
    assert.equal(ipLimitScale(), 1);
  });

  it('лимит по числу запросов растёт сразу, без перезапуска; немасштабируемые не меняются', () => {
    const scaled = createRateLimiter({ windowMs: 60_000, maxPerIp: 3, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });
    const plain = createRateLimiter({ windowMs: 60_000, maxPerIp: 3, maxPerInstance: Number.POSITIVE_INFINITY });
    const now = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      assert.equal(scaled('10.0.0.1', now).allowed, true);
      assert.equal(plain('10.0.0.1', now).allowed, true);
    }
    assert.equal(scaled('10.0.0.1', now).allowed, false, '×1: четвёртый запрос отклонён');
    withSettings({ 'limits.ipScale': 20 });
    const next = scaled('10.0.0.1', now + 1);
    assert.equal(next.allowed, true, '×20: тот же адрес снова проходит');
    assert.equal(next.remaining, 60 - 4);
    assert.equal(plain('10.0.0.1', now + 1).allowed, false, 'пароль и приглашения множитель не трогает');
    let allowed = 4;
    while (scaled('10.0.0.1', now + 2).allowed) allowed += 1;
    assert.equal(allowed, 60, 'ровно 3 × 20');
    withSettings({ 'limits.ipScale': 1 });
    assert.equal(scaled('10.0.0.1', now + 3).allowed, false, 'вернули ×1 — снова строго');
  });

  it('бюджет процессора на адрес: ёмкость и пополнение умножаются', () => {
    const limiter = createCostLimiter({ capacityMs: 100, refillMsPerSecond: 10, scaled: true });
    const now = 5_000_000;
    // Долг в 50 мс: при ×1 ведро пополняется на 10 мс/с — через секунду ещё пусто.
    limiter.charge('10.0.0.2', 150, now);
    assert.equal(limiter.check('10.0.0.2', now).allowed, false, '×1: ведро пусто');
    assert.equal(limiter.check('10.0.0.2', now + 1_000).allowed, false, '×1: через секунду всё ещё пусто');
    withSettings({ 'limits.ipScale': 10 });
    assert.equal(limiter.check('10.0.0.2', now + 1_000).allowed, true, '×10: пополнение 100 мс/с — долг погашен');
    // Ёмкость тоже ×10: свежий адрес выдерживает 900 мс работы подряд.
    limiter.charge('10.0.0.3', 900, now);
    assert.equal(limiter.check('10.0.0.3', now).allowed, true, '×10: ёмкость 1000 мс');
    limiter.charge('10.0.0.3', 2_000, now);
    const denied = limiter.check('10.0.0.3', now);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSeconds <= 20, `пополнение тоже ×10, а не 190 с (${denied.retryAfterSeconds})`);
  });
});

describe('бюджет обращений к модели', () => {
  it('пятиминутный и суточный лимиты читаются при каждом вызове', () => {
    const settings = { short: 2, daily: 100 };
    const take = createExternalBudget({ windowMs: 60_000, max: () => settings.short, dailyLimit: () => settings.daily });
    const now = 9_000_000;
    assert.equal(take(now), true);
    assert.equal(take(now), true);
    assert.equal(take(now), false, 'окно выбрано');
    settings.short = 5;
    assert.equal(take(now), true, 'подняли из админ-панели — сразу действует');
    settings.daily = 3;
    assert.equal(take(now), false, 'суточный потолок важнее пятиминутного');
    settings.daily = 0;
    settings.short = 0;
    assert.equal(take(now + 120_000), false, '0 — модель не вызывается');
  });

  it('бюджет выбран — ассистент отвечает по локальному плану, а не отказывает', async () => {
    const { pipeline, sent } = makeTestPipeline({ outboundMode: 'hybrid' });
    const messages = [{ role: 'user', content: 'Нужен терапевт завтра после 17' }];
    const exhausted = await pipeline.handle({ messages, sessionId: TEST_SESSION, takeExternalBudget: () => false });
    assert.equal(sent.length, 0, 'к модели ничего не ушло');
    assert.equal(exhausted.diagnostics.planSource, 'local');
    assert.equal(exhausted.action.specialty, 'Терапевт');
    assert.match(exhausted.action.replyText, /Терапевт/);
    const allowed = await pipeline.handle({ messages, sessionId: TEST_SESSION, takeExternalBudget: () => true });
    assert.equal(sent.length, 1, 'бюджет есть — запрос уходит к модели');
    assert.equal(allowed.diagnostics.planSource, 'external');
  });
});

describe('очередь к ассистенту', () => {
  it('размер очереди меняется на лету', async () => {
    const limits = { queue: 1 };
    const queue = createCpuQueue({ maxActive: 1, maxQueue: () => limits.queue, waitMs: 5_000 });
    let release;
    const blocker = queue.run(() => new Promise((resolve) => {
      release = resolve;
    }));
    const waiting = queue.run(async () => 'второй');
    await assert.rejects(queue.run(async () => 'третий'), { code: 'busy' }, 'очередь 1 — третий отклонён');
    limits.queue = 3;
    const third = queue.run(async () => 'третий');
    const fourth = queue.run(async () => 'четвёртый');
    release('первый');
    assert.deepEqual(await Promise.all([blocker, waiting, third, fourth]), ['первый', 'второй', 'третий', 'четвёртый']);
  });

  it('число вместо функции — как раньше', async () => {
    const queue = createCpuQueue({ maxActive: 1, maxQueue: 0, waitMs: 5_000 });
    let release;
    const blocker = queue.run(() => new Promise((resolve) => {
      release = resolve;
    }));
    await assert.rejects(queue.run(async () => 'x'), { code: 'busy' });
    release('ok');
    assert.equal(await blocker, 'ok');
  });
});

describe('защита входа для зала на одном адресе', () => {
  const failFrom = (throttle, ip, email) => {
    const parts = { ipKey: throttle.keys.ipKeyOf(ip), accountKey: throttle.keys.emailKey(email), deviceKey: null };
    throttle.recordFailure(parts);
    return parts;
  };

  it('×1: ошибки в 20 разных аккаунтах с одного адреса закрывают адрес', () => {
    const { throttle } = createAccountContext({ store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }) });
    let parts = null;
    for (let index = 0; index < 20; index += 1) parts = failFrom(throttle, '10.20.0.1', `guest${index}@medkarta.test`);
    assert.equal(throttle.check(parts).scope, 'ip');
  });

  it('×20: зал ошибается в паролях — адрес открыт, подбор одного аккаунта по-прежнему останавливается', () => {
    const { throttle, settings } = createAccountContext({ store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }) });
    settings.update({ 'limits.ipScale': 20 }, 'root');
    let parts = null;
    for (let index = 0; index < 60; index += 1) parts = failFrom(throttle, '10.20.0.2', `guest${index}@medkarta.test`);
    assert.equal(throttle.check(parts).allowed, true, '60 человек ошиблись по разу — вход открыт');
    let target = null;
    for (let index = 0; index < 5; index += 1) target = failFrom(throttle, '10.20.0.2', 'victim@medkarta.test');
    assert.equal(throttle.check(target).scope, 'ipacct', 'пара «адрес + аккаунт» множитель не трогает');
    // Перебор многих аккаунтов всё равно упирается в порог адреса: 20 × 20 разных аккаунтов.
    for (let index = 60; index < 400; index += 1) parts = failFrom(throttle, '10.20.0.2', `guest${index}@medkarta.test`);
    assert.equal(throttle.check(parts).scope, 'ip');
  });
});

describe('связка с кабинетом', () => {
  it('сохранение в админ-панели сразу меняет лимиты сервера', () => {
    const context = createAccountContext({ store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }) });
    setLimitSettings((key) => context.settings.get(key));
    const limiter = createRateLimiter({ windowMs: 60_000, maxPerIp: 2, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });
    const now = 7_000_000;
    assert.equal(limiter('192.168.1.10', now).allowed, true);
    assert.equal(limiter('192.168.1.10', now).allowed, true);
    assert.equal(limiter('192.168.1.10', now).allowed, false);
    const saved = context.settings.update({ 'limits.ipScale': 25, 'limits.chatQueue': 100, 'ai.callsPer5Min': 1000 }, 'root');
    assert.equal(saved.errors, undefined);
    assert.equal(ipLimitScale(), 25);
    assert.equal(liveSetting('limits.chatQueue', 16), 100);
    assert.equal(liveSetting('ai.callsPer5Min', 300), 1000);
    assert.equal(limiter('192.168.1.10', now).allowed, true, 'тот же адрес, без перезапуска');
    context.settings.update({ 'limits.ipScale': 1 }, 'root');
    assert.equal(ipLimitScale(), 1);
  });
});
