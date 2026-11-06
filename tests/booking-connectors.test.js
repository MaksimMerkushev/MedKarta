/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Слой коннекторов записи: контракт, демо-коннектор поверх хранилища и кэш
 * слотов для внешних коннекторов. Внешняя МИС здесь — учебная: отдаёт
 * заданные слоты, считает обращения и умеет «не отвечать».
 * Время заморожено: «сейчас» — понедельник 12.10.2026, 12:00 МСК.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, defineConnector, requireCapability } from '../backend/booking/connectors/contract.js';
import { createDemoConnector } from '../backend/booking/connectors/demo.js';
import { BookingError } from '../backend/booking/errors.js';
import { createSlotCache, createSlotSource, groupByPair } from '../backend/booking/slotCache.js';
import { BookingError as StoreBookingError, createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const KEY = (suffix) => `conn-key-${String(suffix).padStart(8, '0')}`;
const noop = () => null;

/* ------------------------------ Контракт ------------------------------- */

describe('Коннектор: контракт', () => {
  const slotsOnly = { id: 'requests-only', can: { slots: true }, listSlots: noop, checkSlot: noop };

  it('флаги can дополняются до полного набора, коннектор заморожен', () => {
    const connector = defineConnector(slotsOnly);
    assert.deepEqual(Object.keys(connector.can), [...CAPABILITIES]);
    assert.equal(connector.can.slots, true);
    assert.equal(connector.can.book, false);
    assert.equal(connector.localSlots, false);
    assert.ok(Object.isFrozen(connector) && Object.isFrozen(connector.can));
    assert.deepEqual(defineConnector(connector).can, connector.can, 'повторная проверка ничего не меняет');
  });

  it('неполный коннектор падает при создании, а не на первой записи', () => {
    assert.throws(() => defineConnector(null), TypeError);
    assert.throws(() => defineConnector({ ...slotsOnly, id: 'Bad ID' }), /неверный id/);
    assert.throws(() => defineConnector({ ...slotsOnly, can: { slots: true, teleport: true } }), /неизвестные возможности teleport/);
    assert.throws(() => defineConnector({ ...slotsOnly, can: { slots: true, hold: true } }), /для hold нужны hold, release/);
    assert.throws(() => defineConnector({ ...slotsOnly, can: { slots: true, book: true } }), /для book нужны book/);
    assert.throws(() => defineConnector({ ...slotsOnly, schedule: 'нет' }), /schedule — не функции/);
    assert.doesNotThrow(() => defineConnector({ id: 'push-only', can: { push: true } }), 'push методов не требует');
  });

  it('нет возможности — отказ not_supported того же класса, что у хранилища', () => {
    const connector = defineConnector(slotsOnly);
    assert.doesNotThrow(() => requireCapability(connector, 'slots'));
    assert.throws(() => requireCapability(connector, 'hold'), (error) => error instanceof BookingError && error.code === 'not_supported');
    assert.equal(StoreBookingError, BookingError, 'прежний импорт из bookingStore — тот же класс');
  });
});

/* --------------------------- Демо-коннектор ---------------------------- */

describe('Коннектор: демо поверх хранилища', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let index;
  let store;
  let connector;
  let pairs;

  before(async () => {
    index = await getDemoCatalog();
    store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
    connector = createDemoConnector({ store });
    pairs = index.catalog.doctors.slice(0, 5).flatMap((doctor) => doctor.branchIds.map((branchId) => ({ doctorId: doctor.id, branchId })));
  });
  after(() => store?.close());

  it('умеет всё, кроме push; слоты — из своей базы', () => {
    assert.equal(connector.id, 'demo');
    assert.deepEqual(connector.can, { slots: true, hold: true, book: true, cancel: true, status: true, push: false });
    assert.equal(connector.localSlots, true);
  });

  it('listSlots и checkSlot отдают то же, что хранилище', () => {
    const query = { pairs, fromDay: '2026-10-13', toDay: '2026-10-15', at: NOW };
    const listed = connector.listSlots(query);
    assert.deepEqual(listed, [...store.freeSlots(query).values()].flat());
    assert.ok(listed.length > 0);
    assert.deepEqual(connector.checkSlot({ slotId: listed[0].id, at: NOW }), store.getSlot(listed[0].id, NOW));
    assert.equal(connector.checkSlot({ slotId: 'demo-doc-nobody--x--20261013-1000', at: NOW }), null);
    assert.equal(connector.checkSlot({ slotId: { not: 'a string' }, at: NOW }), null);
  });

  it('удержание → запись → состояние → отмена проходят в хранилище', () => {
    const [slot] = connector.listSlots({ pairs, fromDay: '2026-10-14', toDay: '2026-10-14', at: NOW });
    const hold = connector.hold({ slotId: slot.id, at: NOW });
    assert.equal(store.getSlot(slot.id, NOW).status, 'HELD');
    const booking = connector.book({ slotId: slot.id, holdToken: hold.holdToken, idempotencyKey: KEY(1), planId: null, accountId: null, at: NOW });
    assert.equal(booking.status, 'CONFIRMED');
    assert.equal(store.getSlot(slot.id, NOW).status, 'BOOKED');
    const [state] = connector.status({ items: [{ number: booking.number, cancelToken: booking.cancelToken }], at: NOW });
    assert.equal(state.found, true);
    const cancelled = connector.cancel({ number: booking.number, cancelToken: booking.cancelToken, at: NOW });
    assert.equal(cancelled.slotReleased, true);
    assert.equal(store.getSlot(slot.id, NOW).status, 'FREE');
    assert.throws(() => connector.hold({ slotId: '../../etc', at: NOW }), (error) => error.code === 'bad_request');
  });
});

/* ----------------------------- Кэш слотов ------------------------------ */

describe('Кэш слотов внешнего коннектора', () => {
  const DOCTOR = 'demo-doc-test';
  const pair = (branchId) => ({ doctorId: DOCTOR, branchId });
  const slotAt = (branchId, day, time) => ({
    id: `${DOCTOR}--${branchId}--${day.replaceAll('-', '')}-${time.replace(':', '')}`,
    doctorId: DOCTOR, branchId, clinicId: 'demo-clinic', serviceId: 'consult.test',
    day, start: time, end: time, startAt: new Date(moscowMoment(day, time)).toISOString(), endAt: new Date(moscowMoment(day, time)).toISOString(),
    status: 'FREE', bookable: true, past: false,
  });

  /** Учебная МИС: отдаёт заданные слоты, считает обращения, может «упасть». */
  const fakeMis = (slots) => {
    const mis = { calls: [], failing: false, slots };
    mis.connector = defineConnector({
      id: 'fake-mis',
      can: { slots: true },
      listSlots: async (query) => {
        mis.calls.push(query);
        if (mis.failing) throw new Error('МИС не отвечает');
        return mis.slots;
      },
      checkSlot: noop,
    });
    return mis;
  };

  const setup = ({ slots, ...options } = {}) => {
    const mis = fakeMis(slots || [slotAt('b1', '2026-10-12', '11:00'), slotAt('b1', '2026-10-12', '15:00'), slotAt('b1', '2026-10-13', '10:00'), slotAt('b2', '2026-10-13', '12:00')]);
    let clock = 1_000_000;
    const errors = [];
    const cache = createSlotCache({ connector: mis.connector, clock: () => clock, onError: (error) => errors.push(error), ...options });
    return { mis, cache, errors, tick: (ms) => { clock += ms; } };
  };

  it('отдаёт только запрошенные пары, дни и будущее время', async () => {
    const { cache } = setup();
    const free = await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-12', toDay: '2026-10-13', at: NOW });
    assert.deepEqual([...free.keys()], [`${DOCTOR}|b1`]);
    assert.deepEqual(free.get(`${DOCTOR}|b1`).map((slot) => `${slot.day} ${slot.start}`), ['2026-10-12 15:00', '2026-10-13 10:00'], '11:00 сегодня уже прошло');
    const tomorrow = await cache.freeSlots({ pairs: [pair('b1'), pair('b2')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.equal(tomorrow.get(`${DOCTOR}|b1`).length, 1);
    assert.equal(tomorrow.get(`${DOCTOR}|b2`).length, 1);
  });

  it('загружает окно в 14 дней от «сегодня» и не ходит в МИС повторно до истечения срока', async () => {
    const { mis, cache, tick } = setup();
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.equal(mis.calls.length, 1);
    assert.deepEqual([mis.calls[0].fromDay, mis.calls[0].toDay], ['2026-10-12', '2026-10-25']);
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-12', toDay: '2026-10-20', at: NOW });
    tick(9 * 60 * 1000);
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-12', toDay: '2026-10-20', at: NOW });
    assert.equal(mis.calls.length, 1, 'в пределах 10 минут — из кэша');
    tick(2 * 60 * 1000);
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-12', toDay: '2026-10-20', at: NOW });
    assert.equal(mis.calls.length, 2, 'после 10 минут — заново');
    assert.deepEqual(cache.stats(), { pairs: 1, hits: 2, misses: 2, errors: 0 });
  });

  it('догружает только недостающие пары', async () => {
    const { mis, cache } = setup();
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    await cache.freeSlots({ pairs: [pair('b1'), pair('b2')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.equal(mis.calls.length, 2);
    assert.deepEqual(mis.calls[1].pairs, [pair('b2')]);
  });

  it('новый день по Москве — загрузка заново', async () => {
    const { mis, cache } = setup();
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: moscowMoment('2026-10-13', '00:05') });
    assert.equal(mis.calls.length, 2);
    assert.equal(mis.calls[1].fromDay, '2026-10-13');
  });

  it('свой слот изменился — пара перечитывается при следующем поиске', async () => {
    const { mis, cache } = setup();
    const query = { pairs: [pair('b1'), pair('b2')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW };
    const free = await cache.freeSlots(query);
    const taken = free.get(`${DOCTOR}|b1`)[0];
    mis.slots = mis.slots.filter((slot) => slot.id !== taken.id);
    cache.invalidateSlot(taken.id);
    cache.invalidateSlot('неизвестный-слот');
    const after = await cache.freeSlots(query);
    assert.equal(mis.calls.length, 2);
    assert.deepEqual(mis.calls[1].pairs, [pair('b1')], 'вторая пара осталась в кэше');
    assert.equal(after.has(`${DOCTOR}|b1`), false);
    assert.equal(after.get(`${DOCTOR}|b2`).length, 1);
  });

  it('МИС не отвечает: прежний ответ до 30 минут, дальше — свободного времени нет', async () => {
    const { mis, cache, errors, tick } = setup();
    const query = { pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW };
    await cache.freeSlots(query);
    mis.failing = true;
    tick(11 * 60 * 1000);
    assert.equal((await cache.freeSlots(query)).get(`${DOCTOR}|b1`).length, 1, 'через 11 минут — прежний ответ');
    tick(20 * 60 * 1000);
    assert.equal((await cache.freeSlots(query)).size, 0, 'через 31 минуту — пусто');
    assert.equal(errors.length, 2);
    assert.equal(cache.stats().errors, 2);
    mis.failing = false;
    assert.equal((await cache.freeSlots(query)).get(`${DOCTOR}|b1`).length, 1, 'МИС ожила — слоты снова есть');
  });

  it('одновременные поиски по одной паре — одна загрузка', async () => {
    const { mis, cache } = setup();
    const query = { pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW };
    const results = await Promise.all([cache.freeSlots(query), cache.freeSlots(query), cache.freeSlots(query)]);
    assert.equal(mis.calls.length, 1);
    assert.ok(results.every((free) => free.get(`${DOCTOR}|b1`).length === 1));
  });

  it('лишние пары вытесняются, самые старые первыми', async () => {
    const { mis, cache } = setup({ maxPairs: 1 });
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    await cache.freeSlots({ pairs: [pair('b2')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.equal(cache.stats().pairs, 1);
    await cache.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.equal(mis.calls.length, 3);
  });

  it('источник слотов по возможностям: без slots — пусто, localSlots — без кэша', async () => {
    const none = createSlotSource({ connector: defineConnector({ id: 'requests-only', can: { push: true } }) });
    assert.equal((await none.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW })).size, 0);
    const { mis } = setup();
    const local = createSlotSource({ connector: defineConnector({ ...mis.connector, localSlots: true }) });
    await local.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    await local.freeSlots({ pairs: [pair('b1')], fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.equal(mis.calls.length, 2, 'каждый поиск — к своей базе');
    assert.equal(local.stats(), null);
  });

  it('groupByPair сохраняет порядок и отбрасывает чужие пары', () => {
    const slots = [slotAt('b2', '2026-10-13', '09:00'), slotAt('b1', '2026-10-13', '10:00'), slotAt('b1', '2026-10-13', '11:00')];
    const grouped = groupByPair(slots, [pair('b1')]);
    assert.deepEqual([...grouped.keys()], [`${DOCTOR}|b1`]);
    assert.deepEqual(grouped.get(`${DOCTOR}|b1`).map((slot) => slot.start), ['10:00', '11:00']);
  });
});
