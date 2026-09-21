/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Интеграционные тесты полного конвейера, включая приёмочный сценарий.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLANNER_ERROR } from '../backend/planner/client.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const ACCEPTANCE =
  'Построй маршрут сначала к терапевту Петрову, потом к ближайшему стоматологу после 18:00, а потом домой.';

describe('Приёмочный сценарий', () => {
  it('наружу уходит только санитизированное представление', async () => {
    const { pipeline, sent } = makeTestPipeline({
      respond: { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' },
    });

    await pipeline.handle({ messages: [{ role: 'user', content: ACCEPTANCE }], sessionId: TEST_SESSION });

    const outbound = sent[0].messages[0].content;
    assert.match(outbound, /^Построй маршрут сначала к терапевту @DOCTOR_[A-Z]{1,2}, потом к ближайшему стоматологу после 18:00, а потом @HOME\.$/);
    // hints глубоко заморожен: сортируем копию, а не сам массив.
    assert.deepEqual([...sent[0].hints.specialties].sort(), ['dentist', 'therapist']);
    assert.equal(sent[0].hints.constraints.availableAfter, '18:00');
  });

  it('структурный план модели исполняется и превращается в маршрут', async () => {
    let issuedToken = null;

    const { pipeline } = makeTestPipeline({
      respond: (request) => {
        issuedToken = request.placeholders.find((item) => item.kind === 'DOCTOR').token;
        return {
          action: 'BUILD_ROUTE',
          steps: [
            { type: 'specific_doctor', token: issuedToken },
            { type: 'specialty', specialty: 'dentist', selection: 'nearest', constraints: { available_after: '18:00' } },
            { type: 'location', token: '@HOME' },
          ],
          constraints: {},
          reply_hint: 'route_built',
        };
      },
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: ACCEPTANCE }],
      sessionId: TEST_SESSION,
    });

    assert.equal(result.diagnostics.planSource, 'external');
    assert.equal(result.action.buildRoute, true);

    const stops = result.action.targetStops;
    assert.equal(stops.length, 2, 'ожидались две сущности плюс дом');
    assert.equal(stops[0].doctor, 'Петров Сергей Иванович', 'терапевт разрешён неверно');
    assert.equal(stops[0].specialty, 'Терапевт');
    assert.equal(stops[1].specialty, 'Стоматолог');
    assert.notEqual(stops[0].doctor, stops[1].doctor, 'одна и та же запись попала в маршрут дважды');

    // Клиника стоматолога должна работать после 18:00 (в фикстуре — до 20:00).
    assert.equal(stops[1].clinic, 'Стоматология «Тестовая» на Победе');
  });

  it('реальные данные не появляются в ответе для внешней стороны, но приходят пользователю', async () => {
    const { pipeline, sent } = makeTestPipeline({
      respond: (request) => ({
        action: 'BUILD_ROUTE',
        steps: [{ type: 'specific_doctor', token: request.placeholders[0].token }],
        constraints: {},
        reply_hint: 'route_built',
      }),
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'Построй маршрут к терапевту Петрову' }],
      sessionId: TEST_SESSION,
    });

    assert.ok(!sent[0].serialized.includes('Петров'), 'ФИО ушло наружу');
    assert.ok(result.action.replyText.includes('Петров'), 'пользователь должен видеть реальные данные');
  });
});

describe('Деградация и fail-closed', () => {
  it('отказ внешнего планировщика приводит к локальному плану, а не к повтору с оригиналом', async () => {
    const { pipeline } = makeTestPipeline({
      respond: Object.assign(new Error('upstream down'), { code: PLANNER_ERROR.UPSTREAM }),
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: ACCEPTANCE }],
      sessionId: TEST_SESSION,
    });

    assert.equal(result.diagnostics.planSource, 'local');
    assert.equal(result.action.buildRoute, true);
    assert.ok(result.action.targetStops.length > 0, 'локальный план ничего не построил');
  });

  it('невалидный ответ модели не ломает ответ пользователю', async () => {
    const { pipeline } = makeTestPipeline({ respond: 'Конечно, вот ваш JSON: {сломан' });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: ACCEPTANCE }],
      sessionId: TEST_SESSION,
    });

    assert.equal(result.diagnostics.planSource, 'local');
    assert.ok(result.action.replyText.length > 0);
  });

  it('опасный план заменяется локальным ровно один раз', async () => {
    let calls = 0;
    const { pipeline } = makeTestPipeline({
      respond: () => {
        calls += 1;
        return { action: 'GET_ALL_PATIENTS', steps: [], constraints: {}, reply_hint: 'doctors_found' };
      },
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'найди терапевта' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(calls, 1, 'внешняя модель вызвана повторно после отказа');
    assert.ok(!JSON.stringify(result.action).includes('GET_ALL_PATIENTS'));
  });

  it('пустой и мусорный ввод не приводит к внешнему вызову', async () => {
    const { pipeline, sent } = makeTestPipeline({
      respond: { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' },
    });

    await pipeline.handle({ messages: [{ role: 'user', content: '.....' }], sessionId: TEST_SESSION });
    assert.equal(sent.length, 0, 'мусор ушёл наружу');
  });
});

describe('Честность выдачи', () => {
  it('отсутствующий профиль не подменяется похожим', async () => {
    const { pipeline } = makeTestPipeline({
      respond: {
        action: 'FIND_DOCTOR',
        steps: [{ type: 'specialty', specialty: 'psychiatrist', selection: 'any', constraints: {} }],
        constraints: {},
        reply_hint: 'doctors_found',
      },
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'нужен психиатр' }],
      sessionId: TEST_SESSION,
    });

    assert.match(result.action.replyText, /нет врачей профиля/i);
    assert.equal(result.action.targetStops.length, 0);
  });

  it('неподтверждённое ограничение по времени называется явно', async () => {
    const { pipeline } = makeTestPipeline({
      respond: {
        action: 'FIND_DOCTOR',
        steps: [{
          type: 'specialty',
          specialty: 'dentist',
          selection: 'any',
          constraints: { available_after: '23:00' },
        }],
        constraints: {},
        reply_hint: 'doctors_found',
      },
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'стоматолог после 23:00' }],
      sessionId: TEST_SESSION,
    });

    assert.match(result.action.replyText, /не удалось подтвердить условие/i);
  });

  it('состояние интерфейса собирается только из перечислимых значений', async () => {
    const { pipeline } = makeTestPipeline({
      respond: {
        action: 'FIND_DOCTOR',
        steps: [{ type: 'specialty', specialty: 'therapist', selection: 'any', constraints: {} }],
        constraints: { ownership: 'Частная', district: 'Советский', min_rating: 4 },
        reply_hint: 'doctors_found',
      },
    });

    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'частный терапевт в Советском районе с рейтингом от 4' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(result.action.ownership, 'Частная');
    assert.equal(result.action.district, 'Советский');
    assert.equal(result.action.minRating, 4);
    assert.equal(result.action.darkMode, null, 'модель не должна управлять темой интерфейса');
  });
});
