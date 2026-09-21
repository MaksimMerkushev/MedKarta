/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Тест 12: сырые данные не попадают в логи и метрики.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const capture = () => {
  const lines = [];
  const logger = createSafeLogger({
    enabled: true,
    sink: (line) => lines.push(line),
    errorSink: (line) => lines.push(line),
  });
  return { lines, logger };
};

describe('12. Логи не содержат персональных данных', () => {
  it('поле prompt отбрасывается целиком', () => {
    const { lines, logger } = capture();
    logger.event('planner.request', {
      request_id: 'r-1',
      prompt: 'Меня зовут Иван Иванов, болит живот',
      intent: 'BUILD_ROUTE',
    });

    assert.ok(!lines[0].includes('Иван'), 'сырой промпт попал в лог');
    assert.ok(!lines[0].includes('prompt'), 'запрещённое поле вообще не должно появляться');
    assert.ok(lines[0].includes('BUILD_ROUTE'), 'полезные поля потерялись');
  });

  it('разрешённое поле с PII заменяется маркером', () => {
    const { lines, logger } = capture();
    logger.event('gateway.decision', { reason: 'звоните +7 843 291-10-16', decision: 'local_only' });

    assert.ok(lines[0].includes('[redacted]'));
    assert.ok(!lines[0].includes('291-10-16'));
  });

  it('объекты произвольной формы не логируются', () => {
    const { lines, logger } = capture();
    logger.event('x', { intent: { nested: 'Меня зовут Иван' } });
    assert.ok(!lines[0].includes('Иван'));
  });

  it('ошибка логируется только кодом: без message и без стека', () => {
    const { lines, logger } = capture();
    const error = Object.assign(new Error('upstream rejected body: Меня зовут Иван'), { code: 'E_UPSTREAM' });
    logger.error('planner.error', error, { request_id: 'r-1' });

    assert.ok(lines[0].includes('E_UPSTREAM'));
    assert.ok(!lines[0].includes('Иван'), 'текст ошибки попал в лог');
    assert.ok(!lines[0].includes('stack'));
  });

  it('соответствие токена и реальной сущности не логируется', () => {
    const { lines, logger } = capture();
    logger.event('vault.mint', { token: '@DOCTOR_A', mapping: { '@DOCTOR_A': 'fx-doc-petrov-therapist' } });

    assert.ok(!lines[0].includes('fx-doc-petrov-therapist'), 'соответствие токена попало в лог');
    assert.ok(!lines[0].includes('@DOCTOR_A'), 'токен попал в лог');
  });

  it('полный прогон конвейера не оставляет ввода в логах', async () => {
    const { lines, logger } = capture();
    const { pipeline } = makeTestPipeline({
      respond: { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' },
    });

    // Подменяем логгер конвейера: проверяем именно то, что он пишет.
    const { createPipeline } = await import('../backend/pipeline.js');
    const { fixtureCatalog } = await import('./fixtures/catalog.js');
    const { makeVault } = await import('./helpers.js');
    const { createHaversineRoutingProvider } = await import('../backend/executor/routing.js');

    const instrumented = createPipeline({
      catalog: fixtureCatalog(),
      vault: makeVault(),
      planner: { name: 'test', async generate() { throw Object.assign(new Error('nope'), { code: 'E' }); } },
      routing: createHaversineRoutingProvider(),
      logger,
      metrics: createMetrics(),
    });

    await instrumented.handle({
      messages: [{ role: 'user', content: 'Меня зовут Иван Петров, телефон +7 843 291-10-16, болит живот' }],
      sessionId: TEST_SESSION,
    });

    const blob = lines.join('\n');
    for (const secret of ['Иван', 'Петров', '291-10-16', 'живот', TEST_SESSION]) {
      assert.ok(!blob.includes(secret), `в логах найдено: ${secret}`);
    }
    assert.ok(blob.includes('gateway.decision'), 'структурные события не пишутся');
    assert.ok(pipeline, 'вспомогательный конвейер собран');
  });
});

describe('17. Метрики privacy-safe', () => {
  it('метки с высокой кардинальностью отбрасываются', () => {
    const metrics = createMetrics();
    metrics.increment('planner.usage', { provider: 'external', doctor: 'Петров Сергей Иванович' });

    const keys = Object.keys(metrics.snapshot().counters);
    assert.ok(keys.some((key) => key.includes('provider=external')));
    assert.ok(!keys.join('|').includes('Петров'), 'ФИО попало в метку метрики');
  });

  it('считает задержки и решения', () => {
    const metrics = createMetrics();
    metrics.increment('gateway.decision', { decision: 'local_only' });
    metrics.observe('pipeline.latency_ms', 42, { plan_source: 'local' });

    const snapshot = metrics.snapshot();
    assert.equal(snapshot.counters['gateway.decision{decision=local_only}'], 1);
    assert.equal(snapshot.timings['pipeline.latency_ms{plan_source=local}'].count, 1);
  });
});
