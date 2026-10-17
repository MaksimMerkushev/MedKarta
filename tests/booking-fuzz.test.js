/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Генеративная проверка разбора условий записи: воспроизводимые сочетания
 * профиля, дня, часов, цены, ДМС, пола, района и стажа — одной фразой и
 * диалогом по условию на реплику. Ни одно условие не теряется, не додумывается
 * и не забывается через несколько реплик.
 *
 * Время заморожено: понедельник 12.10.2026, 12:00 МСК.
 */

import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { moscowMoment } from '../backend/demo/time.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { PLANNER_ERROR } from '../backend/planner/client.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const NOW = moscowMoment('2026-10-12', '12:00');
const PLANNER_DOWN = Object.assign(new Error('upstream down'), { code: PLANNER_ERROR.UPSTREAM });

const SPEC = [['лор', 'lor'], ['кардиолог', 'cardiologist'], ['невролог', 'neurologist'], ['гинеколог', 'gynecologist'], ['терапевт', 'therapist'], ['дерматолог', 'dermatologist'],
  ['уролог', 'urologist'], ['офтальмолог', 'ophthalmologist'], ['эндокринолог', 'endocrinologist'], ['хирург', 'surgeon'], ['к ЛОРу', 'lor'], ['нужен кардиолог', 'cardiologist']];
const DATE = [['завтра', { kind: 'tomorrow' }], ['послезавтра', { kind: 'after_tomorrow' }], ['в среду', { kind: 'weekday' }], ['в субботу', { kind: 'weekday' }],
  ['на этой неделе', { kind: 'this_week' }], ['на следующей неделе', { kind: 'next_week' }], ['в четверг или пятницу', { kind: 'any_of' }], ['15 октября', { kind: 'date', day: '2026-10-15' }],
  ['с 15 по 17 октября', { kind: 'range', from: '2026-10-15', to: '2026-10-17' }], ['в ближайшие 3 дня', { kind: 'range', from: '2026-10-12', to: '2026-10-14' }], ['до 20 октября', { kind: 'range', to: '2026-10-19' }], ['', { kind: 'any' }]];
const TIME = [['после 18', { timeFrom: '18:00' }], ['до 12', { timeTo: '12:00' }], ['утром', { timeTo: '12:00' }], ['вечером', { evening: true }], ['с 10 до 14', { timeFrom: '10:00', timeTo: '14:00' }],
  ['после шести вечера', { timeFrom: '18:00', evening: true }], ['в 2 часа дня', { timeFrom: '14:00', timeTo: '14:01' }], ['после 5', { timeFrom: '17:00' }], ['не раньше 16:00', { timeFrom: '16:00' }], ['', {}]];
const PRICE = [['до 3000 ₽', 3000], ['не дороже двух тысяч', 2000], ['в пределах 2500', 2500], ['дешевле 4000', 4000], ['', null]];
const DMS = [['по ДМС Demo Standard', { required: true, planId: 'demo-standard' }], ['по программе Demo Premium', { required: true, planId: 'demo-premium' }], ['без ДМС', { required: false }], ['', { required: false }]];
const GENDER = [['врач-женщина', ['female', null]], ['чтобы врач был мужчина', ['male', null]], ['желательно женщина', [null, 'female']], ['', [null, null]]];
const DISTRICT = [['в Вахитовском районе', [['Вахитовский'], []]], ['не в Советском районе', [[], ['Советский']]], ['в Приволжском или Советском районе', [['Приволжский', 'Советский'], []]], ['', [[], []]]];
const EXPERIENCE = [['стаж от 10 лет', 10], ['с опытом не меньше 20 лет', 20], ['', null]];
const JOIN = [', ', ' и ', '; ', ', а ещё '];
/* Реплики, которые не меняют условий: благодарность, вопрос о найденном, вопрос не по теме. */
const NOISE = ['спасибо', 'понятно', 'а сколько стоит?', 'а где это?', 'какая погода?', 'как записаться?', 'ок', 'расскажи анекдот'];
const LEAD = ['', 'а ', 'и ', 'ещё ', 'да, и ', 'кстати, '];

/** Воспроизводимый генератор: одно и то же зерно — те же запросы. */
const generator = (seed) => {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  return { random, pick: (list) => list[Math.floor(random() * list.length)] };
};

const expectMatches = (request, expected, label) => {
  const [spec, date, time, price, dms, gender, district, experience] = expected;
  assert.equal(request.specialty, spec, `${label}: профиль`);
  assert.equal(request.date.kind, date.kind, `${label}: день ${JSON.stringify(request.date)}`);
  if (date.day) assert.equal(request.date.day, date.day, `${label}: дата`);
  if (date.kind === 'range') {
    assert.equal(request.date.to, date.to, `${label}: конец диапазона`);
    if (date.from) assert.equal(request.date.from, date.from, `${label}: начало диапазона`);
  }
  assert.equal(request.timeFrom, time.timeFrom || null, `${label}: с`);
  assert.equal(request.timeTo, time.timeTo || null, `${label}: до`);
  assert.equal(request.evening, Boolean(time.evening), `${label}: вечер`);
  assert.equal(request.maxPrice, price, `${label}: цена`);
  assert.equal(request.dms.required, dms.required, `${label}: ДМС`);
  if (dms.planId) assert.equal(request.dms.planId, dms.planId, `${label}: программа`);
  assert.deepEqual([request.doctorGender, request.preferGender], gender, `${label}: пол`);
  assert.deepEqual([request.districts, request.excludeDistricts], district, `${label}: район`);
  assert.equal(request.minExperience, experience, `${label}: стаж`);
};

let catalog;
before(async () => {
  process.env.DEMO_DATA = 'on';
  __resetCatalogCache();
  catalog = await loadCatalog();
});

const run = async (turns) => {
  const { pipeline } = makeTestPipeline({ catalog, respond: PLANNER_DOWN, booking: { enabled: true, now: () => NOW } });
  const { action } = await pipeline.handle({ messages: turns.map((content) => ({ role: 'user', content })), sessionId: TEST_SESSION });
  return sanitizeAiAction(JSON.parse(JSON.stringify(action)));
};

describe('Генеративная проверка разбора: ни одно условие не теряется и не забывается', () => {
  for (const mode of ['одной фразой', 'диалогом — условие на реплику', 'диалогом с посторонними репликами']) {
    it(`${mode}: 60 случайных сочетаний`, async () => {
      const { random, pick } = generator({ 'одной фразой': 7, 'диалогом — условие на реплику': 9 }[mode] || 11);
      for (let count = 0; count < 60; count += 1) {
        const parts = [pick(SPEC), pick(DATE), pick(TIME), pick(PRICE), pick(DMS), pick(GENDER), pick(DISTRICT), pick(EXPERIENCE)];
        const phrases = parts.slice(1).map((part) => part[0]).filter(Boolean).sort(() => random() - 0.5);
        const turns = mode === 'одной фразой'
          ? [[parts[0][0], ...phrases].reduce((text, phrase, position) => (position === 0 ? phrase : text + pick(JOIN) + phrase), '')]
          : mode === 'диалогом — условие на реплику'
            ? [parts[0][0], ...phrases.map((phrase) => pick(LEAD) + phrase)]
            // Между условиями — «спасибо», «а где это?», «какая погода?»: контекст не теряется и не меняется.
            : [parts[0][0], ...phrases.flatMap((phrase) => [pick(LEAD) + phrase, ...(random() < 0.6 ? [pick(NOISE)] : [])])].slice(0, 20);
        const action = await run(turns);
        assert.ok(action.booking, `${turns.join(' → ')}: нет подбора — ${action.replyText}`);
        expectMatches(action.booking.request, parts.map((part) => part[1]), turns.join(' → '));
      }
    });
  }
});
