/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сохранение контекста диалога после обезличивания: один человек — одна метка во всех
 * репликах (в любом падеже), разные люди — разные метки, родство и местоимения остаются,
 * проверяется вся отправляемая история. Смотрится перехваченное тело запроса к триажу.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { moscowMoment } from '../backend/demo/time.js';
import { createExternalTriage } from '../backend/planner/triage.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { createLabelState, entityKey, labelFor } from '../backend/privacy/labels.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const NOW = moscowMoment('2026-10-12', '12:00');
let catalog;
before(async () => {
  process.env.DEMO_DATA = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
  catalog = await loadCatalog();
});

/** Реплики пользователя в теле запроса к триажу, по одной на строку; [] — запрос не ушёл. */
const sentTurns = async (turns) => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'specialist', specialties: ['cardiologist'], question: null, options: null }) } }], usage: {} }) };
  };
  const triage = createExternalTriage({ apiKey: 'k', url: 'https://llm.example.test/v1/chat/completions', model: 'm', fetchImpl });
  const { pipeline } = makeTestPipeline({ catalog, triage, booking: { enabled: true, now: () => NOW } });
  await pipeline.handle({ messages: turns.map((content) => ({ role: 'user', content })), sessionId: TEST_SESSION });
  const user = bodies.at(-1)?.messages.find((m) => m.role === 'user')?.content || '';
  return user.split('\n').slice(1).map((line) => line.replace(/^\d+\.\s*/u, ''));
};
const labelsIn = (text) => text.match(/\[имя_\d+\]/gu) || [];

describe('Контекст диалога: устойчивые метки', () => {
  it('один человек в разных падежах и репликах — одна метка; другой человек — другая', async () => {
    const turns = await sentTurns([
      'Мой брат Ринат Сафин жалуется на давящую боль в груди второй день.',
      'У Рината такие же симптомы, как у отца было перед инфарктом.',
      'Вчера ему стало хуже при подъёме по лестнице, а моя мама Гульнара Хайруллина говорит, что у неё тоже давление 160/100.',
    ]);
    assert.equal(turns.length, 3);
    const [first, second, third] = turns.map(labelsIn);
    assert.deepEqual(first, ['[имя_1]']);
    assert.deepEqual(second, ['[имя_1]'], turns[1]);
    assert.deepEqual(third, ['[имя_2]'], turns[2]);
    const all = turns.join('\n').toLowerCase();
    assert.doesNotMatch(all, /ринат|сафин|гульнар|хайруллин/u);
    // Родство, местоимения и связки, по которым понятно, о ком речь.
    for (const word of ['мой брат', 'такие же симптомы', 'ему стало хуже', 'моя мама', 'у неё тоже', 'давление 160/100', 'перед инфарктом']) assert.ok(all.includes(word), `потеряно «${word}»: ${all}`);
  });

  it('имя строчными и то же имя в другом падеже с заглавной — одна метка', async () => {
    const turns = await sentTurns(['Меня зовут ильнур петров, болит колено после падения.', 'Петрову Ильнуру назначили ибупрофен 400 мг, не помогает.']);
    assert.deepEqual(turns.map(labelsIn), [['[имя_1]'], ['[имя_1]']]);
    assert.match(turns[1], /ибупрофен 400 мг, не помогает/u);
  });

  it('ребёнок без имени и ребёнок с именем различимы', async () => {
    const turns = await sentTurns(['У дочки температура 38.5 третий день, кашель.', 'Она не ест, а сын Тимур тоже начал кашлять.', 'Тимуру 5 лет, ей 3 года.']);
    assert.match(turns[0], /у дочки температура 38\.5 третий день/iu);
    assert.deepEqual(turns.slice(1).map(labelsIn), [['[имя_1]'], ['[имя_1]']]);
    assert.match(turns[2], /5 лет, ей 3 года/u);
  });

  it('вся история проверяется: имя из первой реплики не уходит, даже если жалоба в последней', async () => {
    const turns = await sentTurns(['Это Зульфия Гарипова пишет.', 'Ладно.', 'Болит горло и температура 38 третий день.']);
    assert.ok(!turns.join('\n').toLowerCase().includes('зульфи'));
    assert.ok(!turns.join('\n').toLowerCase().includes('гарипов'));
  });
});

describe('Метки: связывание имён по основам', () => {
  it('«Ринат» входит в «Ринат Сафин»; «Ринат Ахметов» — другой человек', () => {
    const state = createLabelState();
    const a = labelFor(state, 'имя', entityKey('PERSON', 'Ринат Сафин'));
    assert.equal(labelFor(state, 'имя', entityKey('PERSON', 'Рината')), a);
    assert.equal(labelFor(state, 'имя', entityKey('PERSON', 'Сафину')), a);
    assert.notEqual(labelFor(state, 'имя', entityKey('PERSON', 'Ринат Ахметов')), a);
  });

  it('фамилия в разных падежах — одна основа', () => {
    for (const form of ['Петров', 'Петрова', 'Петрову', 'Петровым', 'Петровой']) assert.equal(entityKey('PERSON', form), 'PERSON:петров', form);
  });

  it('номера продолжают уже выданные', () => {
    const state = createLabelState(['У [имя_1] и [имя_2] кашель', '[место_3]']);
    assert.equal(labelFor(state, 'имя', 'PERSON:зульфи'), '[имя_3]');
    assert.equal(labelFor(state, 'место', 'LOC:x'), '[место_4]');
  });
});
