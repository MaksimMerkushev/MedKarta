/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * «Мои демо-записи» в браузере: значок считает только предстоящие
 * подтверждённые записи; статус «не найдена» (демо сброшено) сохраняется.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUpcomingBooking, readMyBookings, writeMyBookings } from '../frontend/src/services/demoBooking.js';

const NOW = Date.parse('2026-10-19T13:00:00+03:00');
const booking = (patch) => ({ number: 'DEMO-261019-AB12C', cancelToken: 'token', status: 'CONFIRMED', day: '2026-10-20', start: '14:00', end: '14:40', ...patch });

describe('isUpcomingBooking', () => {
  it('предстоящая подтверждённая — считается', () => {
    assert.equal(isUpcomingBooking(booking(), NOW), true);
    assert.equal(isUpcomingBooking(booking({ day: '2026-10-19', end: '13:30' }), NOW), true, 'идёт сейчас');
  });

  it('прошедшая, отменённая и пропавшая после сброса демо — не считаются', () => {
    assert.equal(isUpcomingBooking(booking({ day: '2026-10-10', end: '11:10' }), NOW), false);
    assert.equal(isUpcomingBooking(booking({ day: '2026-10-19', end: '12:40' }), NOW), false, 'закончилась сегодня по Москве');
    assert.equal(isUpcomingBooking(booking({ status: 'CANCELLED' }), NOW), false);
    assert.equal(isUpcomingBooking(booking({ status: 'NOT_FOUND' }), NOW), false);
  });

  it('без даты — считается: не прячем запись, время которой неизвестно', () => {
    assert.equal(isUpcomingBooking(booking({ day: null, end: null }), NOW), true);
  });
});

describe('хранение записей гостя', () => {
  let store;
  beforeEach(() => {
    store = new Map();
    globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) };
  });
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('«не найдена» переживает запись и чтение, неизвестный статус становится «подтверждена»', () => {
    writeMyBookings([booking({ status: 'NOT_FOUND' }), booking({ number: 'DEMO-261019-ZZ99Z', status: 'WHATEVER' })]);
    assert.deepEqual(readMyBookings().map((item) => item.status), ['NOT_FOUND', 'CONFIRMED']);
  });
});
