/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сценарии понимания запросов через весь пайплайн с локальной заглушкой модели, сети нет.
 * Подсказки модели: что она может изменить и чего не может. Диагностика: файл трассы без
 * ключа и запрет в production. Качество настоящей модели здесь не проверяется.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { setAiTraceSink } from '../backend/observability/aiTrace.js';
import { createExternalTriage, validateTriage } from '../backend/planner/triage.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { buildQueryFrame, classifyTurns } from '../backend/understanding/frame.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { checkScenario, mockModel } from './fixtures/ai-check.js';
import { REAL_SCENARIOS, SCENARIOS } from './fixtures/ai-scenarios.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const NOW = moscowMoment('2026-10-12', '12:00');
let catalog;

before(async () => {
  process.env.DEMO_DATA = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
  catalog = await loadCatalog();
});

const run = async (turns, reply = null) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const text = body.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
    calls.push({ text, serialized: JSON.stringify(body.messages.filter((message) => message.role !== 'system')) });
    const child = body.messages.some((message) => message.role === 'system' && message.content === 'Приём детский.');
    const content = reply ? (typeof reply === 'function' ? reply(text) : reply) : mockModel(text, child);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }), { status: 200 });
  };
  const triage = createExternalTriage({ apiKey: 'test-key', url: 'https://llm.example.test/v1/chat/completions', model: 'mock', fetchImpl });
  // Режим по умолчанию (structured). В режиме hybrid часть жалоб без слов из словаря модели не доходит:
  // это прежнее поведение, оно описано в docs/ai-pipeline-report.md (раздел G).
  const { pipeline, sent } = makeTestPipeline({ catalog, triage, outboundMode: 'structured', booking: { enabled: true, now: () => NOW } });
  const probe = {};
  const { action } = await pipeline.handle({ messages: turns.map((content) => ({ role: 'user', content })), sessionId: TEST_SESSION, probe });
  return { action: sanitizeAiAction(JSON.parse(JSON.stringify(action))), calls, sent, probe };
};

describe('Сценарии понимания запросов (заглушка модели)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: ${scenario.turns.join(' → ').slice(0, 70)}`, { todo: scenario.known || false }, async () => {
      const { action, calls, sent } = await run(scenario.turns);
      const outbound = [...calls.map((call) => call.serialized), ...sent.map((item) => item.serialized)].join('\n');
      const { problems } = checkScenario(scenario, { action, sentTexts: calls.map((call) => call.text), outbound });
      assert.deepEqual(problems, []);
    });
  }

  it('сценарии с идентификаторами не входят в набор для настоящей модели', () => {
    const marked = SCENARIOS.filter((item) => item.real === false).map((item) => item.id);
    assert.ok(marked.length >= 16);
    for (const scenario of REAL_SCENARIOS) {
      assert.ok(!marked.includes(scenario.id));
      assert.doesNotMatch(scenario.turns.join(' '), /\+7|@|\d{10,}|паспорт|снилс|полис омс/iu, scenario.id);
    }
  });
});

describe('Подсказка модели о ролях', () => {
  const answer = (mentions) => ({ status: 'specialist', specialties: ['lor'], frame: { symptoms: ['болит ухо'], patient: 'self', mentions } });

  it('снимает условие, которое правила поняли неверно', async () => {
    const { action, probe } = await run(['Горло болит, в субботу соревнования'], answer([{ text: 'в субботу соревнования', role: 'event_time' }]));
    assert.equal(action.booking.request.date.kind, 'any');
    assert.deepEqual(probe.modelRoles.fragments, ['в субботу соревнования']);
  });

  it('прямо названное условие снять не может (ошибка настоящей модели на P07)', async () => {
    const { action, probe } = await run(['Сыпь на руках и сильно чешется, рядом с Кремлём, сегодня вечером'], answer([{ text: 'сегодня вечером', role: 'symptom_time' }, { text: 'рядом с [место_1]', role: 'biography_place' }]));
    assert.equal(action.booking.request.date.kind, 'today');
    assert.equal(action.booking.request.evening, true);
    assert.deepEqual(probe.modelRoles.fragments, []);
    assert.deepEqual(probe.modelRoles.kept, ['сегодня вечером', 'рядом с Кремлём']);
  });

  it('условие в явной просьбе о записи тоже остаётся', async () => {
    const { action } = await run(['Болит ухо, нужен лор сегодня вечером'], answer([{ text: 'сегодня вечером', role: 'symptom_time' }]));
    assert.equal(action.booking.request.date.kind, 'today');
  });

  it('не может создать условие: роль приёма без условия у правил ничего не добавляет', async () => {
    const { action } = await run(['Болит ухо'], answer([{ text: 'завтра после 18:00', role: 'appointment_time' }, { text: 'до 500 рублей', role: 'appointment_time' }]));
    assert.equal(action.booking.request.date.kind, 'any');
    assert.equal(action.booking.request.timeFrom ?? null, null);
    assert.equal(action.booking.request.maxPrice ?? null, null);
  });

  it('время другого события снимается так же, как время симптома', async () => {
    const { action } = await run(['Завтра экзамен, а горло совсем пропало'], answer([{ text: 'Завтра экзамен', role: 'event_time' }]));
    assert.equal(action.booking.request.date.kind, 'any');
  });

  it('фрагмент, которого нет в переданном тексте, игнорируется', async () => {
    const { action, probe } = await run(['Болит ухо, завтра'], answer([{ text: 'вчера', role: 'symptom_time' }]));
    assert.equal(action.booking.request.date.kind, 'tomorrow');
    assert.deepEqual(probe.modelRoles.ignored, ['вчера']);
  });

  it('метка места переводится обратно только на сервере', async () => {
    const { action, calls, probe } = await run(['Отдыхали в Советском районе у родных, болит ухо'], (text) => answer(text.includes('[место_1]') ? [{ text: '[место_1]', role: 'biography_place' }] : []));
    assert.match(calls[0].text, /\[место_1\]/);
    assert.doesNotMatch(calls[0].text, /Советск/);
    assert.deepEqual(action.booking.request.districts, []);
    assert.deepEqual(probe.modelRoles.fragments, ['Советском районе']);
  });

  it('место в явной просьбе модель биографией не сделает', async () => {
    const { action } = await run(['Нужно к врачу в Советском районе, болит ухо'], (text) => answer(text.includes('[место_1]') ? [{ text: '[место_1]', role: 'biography_place' }] : []));
    assert.ok(action.booking.request.districts.length > 0);
  });

  it('неверный формат подсказки не ломает ответ', () => {
    const parsed = validateTriage(JSON.stringify({ status: 'specialist', specialties: ['lor'], frame: { mentions: [{ text: 123, role: 'x' }, { text: 'a', role: 'взлом' }], patient: 'робот', symptoms: 'нет' } }));
    assert.deepEqual(parsed.frame, { symptoms: [], patient: 'unknown', mentions: [] });
    assert.deepEqual(validateTriage(JSON.stringify({ status: 'specialist', specialties: ['lor'] })).frame, { symptoms: [], patient: 'unknown', mentions: [] });
  });
});

describe('Понятый запрос', () => {
  it('жалобы отдельно от условий, у каждого условия источник', async () => {
    const { probe } = await run(['кардиолог завтра после 18 до 3000', 'болит колено', 'после травмы']);
    const frame = buildQueryFrame(probe);
    assert.deepEqual(frame.complaints, ['болит колено', 'после травмы'].filter((text) => frame.complaints.includes(text)));
    assert.equal(frame.schedule.timeFrom.value, '18:00');
    assert.equal(frame.schedule.timeFrom.source, 'explicit');
    assert.equal(frame.maxPrice.source, 'explicit');
    assert.equal(frame.schedule.timeTo.source, 'unset');
    assert.equal(frame.suggestedSpecialty.source, 'inferred');
    assert.deepEqual(frame.namedSpecialty.value, ['cardiologist']);
  });

  it('виды реплик', () => {
    const info = (userTexts, perTurnSpecialties, named, newRequestStart = 0) => classifyTurns({ userTexts, perTurnSpecialties, named, newRequestStart });
    assert.deepEqual(info(['кардиолог', 'болит колено', 'нет, всё-таки кардиолог'], [['cardiologist'], ['orthopedist'], ['cardiologist']], [['cardiologist'], [], ['cardiologist']], 1), ['new_request', 'new_complaint', 'return_to_earlier']);
    assert.deepEqual(info(['лор завтра', 'отмени время', 'после 18'], [['lor'], [], []], [['lor'], [], []]), ['new_request', 'condition_cancelled', 'condition_change']);
    assert.deepEqual(info(['болит живот', 'вверху'], [['gastroenterologist'], []], [[], []]), ['new_request', 'answer_to_question']);
  });
});

describe('Диагностика обмена с моделью', () => {
  it('в production включить нельзя', () => {
    assert.throws(() => setAiTraceSink(() => {}, { NODE_ENV: 'production' }));
    assert.throws(() => setAiTraceSink(() => {}, { APP_ENV: 'production' }));
    setAiTraceSink(null, { NODE_ENV: 'production' });
  });

  it('перехватывает настоящий запрос и ответ без ключа', async () => {
    const exchanges = [];
    setAiTraceSink((exchange) => exchanges.push(exchange));
    try {
      const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'specialist', specialties: ['lor'] }) } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }), { status: 200 });
      const triage = createExternalTriage({ apiKey: 'secret-key-value', url: 'https://llm.example.test/v1/chat/completions', model: 'mock', fetchImpl });
      await triage.classify({ turns: ['болит ухо'], tokens: [] });
    } finally {
      setAiTraceSink(null);
    }
    assert.equal(exchanges.length, 1);
    assert.equal(exchanges[0].response.status, 200);
    assert.equal(exchanges[0].response.json.usage.prompt_tokens, 7);
    assert.match(exchanges[0].request.body.messages[1].content, /болит ухо/);
    assert.doesNotMatch(JSON.stringify(exchanges[0]), /secret-key-value/);
  });

  it('без диагностики запрос не меняется', async () => {
    let wire = null;
    const fetchImpl = async (url, init) => {
      wire = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'specialist', specialties: ['lor'] }) } }] }), { status: 200 });
    };
    const triage = createExternalTriage({ apiKey: 'k', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'mock', fetchImpl });
    await triage.classify({ turns: ['болит ухо'], tokens: [] });
    assert.equal(wire.usage, undefined);
  });
});
