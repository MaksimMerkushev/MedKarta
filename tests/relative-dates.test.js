/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * «Сегодня», «завтра», «послезавтра», «в пятницу» — по московскому календарю
 * в момент запроса. Если сегодня понедельник, «завтра» — вторник: ответ
 * называет день («завтра (вторник, 13 октября)»), а подбор показывает время
 * только на него. Сервер может работать в UTC: в 00:30 по Москве (21:30 UTC
 * прошлого дня) «завтра» — всё равно следующий московский день.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { createDemoSearch, dayCaptionOf } from '../backend/demo/search.js';
import { addDays, moscowMoment, moscowParts, WEEKDAY_NAMES } from '../backend/demo/time.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { PLANNER_ERROR } from '../backend/planner/client.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const DOWN = Object.assign(new Error('upstream down'), { code: PLANNER_ERROR.UPSTREAM });
const MODELS = {
  'модель недоступна': () => DOWN,
  'модель ищет врача': (request) => {
    const keys = request.hints.specialties || [];
    return keys.length
      ? { action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: keys[0], selection: 'nearest' }], constraints: {}, reply_hint: 'doctors_found' }
      : { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' };
  },
};
const MONTHS = ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const caption = (day) => `${WEEKDAY_NAMES[moscowParts(moscowMoment(day, '12:00')).weekday]}, ${Number(day.slice(8))} ${MONTHS[Number(day.slice(5, 7))]}`;

let catalog;
let index;
let store;
let search;
let clock;

before(async () => {
  process.env.DEMO_DATA = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
  catalog = await loadCatalog();
  index = await getDemoCatalog();
  if (DatabaseSync) {
    clock = moscowMoment('2026-10-12', '10:00');
    store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => clock });
    search = createDemoSearch({ index, store, getEngine: async () => null, now: () => clock });
  }
});

after(() => {
  store?.close();
  __resetCatalogCache();
});

/** Ответ ассистента на реплику в момент at и подбор по его запросу в тот же момент. */
const ask = async (text, at, respond = MODELS['модель недоступна']) => {
  clock = at;
  const { pipeline } = makeTestPipeline({ catalog, respond, booking: { enabled: true, now: () => at } });
  const { action } = await pipeline.handle({ messages: [{ role: 'user', content: text }], sessionId: TEST_SESSION });
  const clean = sanitizeAiAction(JSON.parse(JSON.stringify(action)));
  const found = store && clean.booking ? await search.search(clean.booking.request) : null;
  return { action: clean, found };
};

const slotDays = (found) => [...new Set(found.options.flatMap((option) => option.slots.map((slot) => slot.day)))];

describe('Относительные даты — по московскому «сегодня»', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  // Неделя с понедельника 12.10.2026: «завтра» в каждый из семи дней.
  const WEEK = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'];

  for (const today of WEEK) {
    const tomorrow = addDays(today, 1);
    it(`${WEEKDAY_NAMES[moscowParts(moscowMoment(today, '10:00')).weekday]} ${today}: «завтра» — ${caption(tomorrow)}, время только на этот день`, async () => {
      const { action, found } = await ask('Нужен терапевт завтра', moscowMoment(today, '10:00'));
      assert.deepEqual(action.booking.request.date, { kind: 'tomorrow' });
      assert.match(action.replyText, new RegExp(`завтра \\(${caption(tomorrow)}\\)`, 'u'));
      assert.equal(found.status, 'ok', found.message);
      assert.deepEqual(slotDays(found), [tomorrow]);
      assert.ok(found.applied.some((part) => part.includes(`завтра (${caption(tomorrow)})`)), found.applied.join(' · '));
    });
  }

  it('сервер в UTC, в Москве уже следующий день: «завтра» считается от московской даты', async () => {
    // 21:30 UTC понедельника = 00:30 МСК вторника.
    const at = Date.parse('2026-10-12T21:30:00Z');
    assert.equal(moscowParts(at).day, '2026-10-13');
    const { action, found } = await ask('ЛОР завтра', at);
    assert.match(action.replyText, /завтра \(среда, 14 октября\)/u);
    assert.deepEqual(slotDays(found), ['2026-10-14']);
    const today = await ask('ЛОР сегодня', at);
    assert.match(today.action.replyText, /сегодня \(вторник, 13 октября\)/u);
    assert.equal(today.found.status, 'ok', today.found.message);
    assert.deepEqual(slotDays(today.found), ['2026-10-13']);
  });

  it('«сегодня после 18» вечером — только время, которое ещё не прошло', async () => {
    const at = moscowMoment('2026-10-14', '18:40');
    const { found } = await ask('Нужен ЛОР сегодня после 18', at);
    assert.equal(found.status, 'ok', found.message);
    for (const option of found.options) {
      for (const slot of option.slots) {
        assert.equal(slot.day, '2026-10-14');
        assert.ok(Date.parse(slot.startAt) > at, `${slot.day} ${slot.start} уже прошло`);
      }
    }
  });

  it('«послезавтра» и «в пятницу» в понедельник — среда и ближайшая пятница', async () => {
    const at = moscowMoment('2026-10-12', '09:00');
    const after2 = await ask('Кардиолог послезавтра', at);
    assert.match(after2.action.replyText, /послезавтра \(среда, 14 октября\)/u);
    assert.deepEqual(slotDays(after2.found), ['2026-10-14']);
    const friday = await ask('Терапевт в пятницу', at);
    assert.match(friday.action.replyText, /в пятницу \(16 октября\)/u);
    assert.deepEqual(slotDays(friday.found), ['2026-10-16']);
  });

  it('так же, когда модель доступна: день считает сервер, а не модель', async () => {
    const at = moscowMoment('2026-10-18', '15:00');
    const { action, found } = await ask('Нужен терапевт завтра', at, MODELS['модель ищет врача']);
    assert.match(action.replyText, /завтра \(понедельник, 19 октября\)/u);
    assert.deepEqual(slotDays(found), ['2026-10-19']);
  });

  it('подпись дня: дата — с днём недели, «через неделю?» — без подписи', () => {
    assert.equal(dayCaptionOf({ date: { kind: 'date', day: '2026-10-23' } }, '2026-10-19'), 'пятница');
    assert.equal(dayCaptionOf({ date: { kind: 'weekday', weekday: 5, week: 'next', askWeek: true } }, '2026-10-19'), null);
    assert.equal(dayCaptionOf({ date: { kind: 'any' } }, '2026-10-19'), null);
    assert.equal(dayCaptionOf({ date: { kind: 'tomorrow' } }, null), null);
  });
});
