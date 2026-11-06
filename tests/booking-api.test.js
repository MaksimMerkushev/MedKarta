/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * API записи через слой коннекторов: /api/booking/* рядом с прежним
 * /api/demo/*, внешний коннектор через кэш слотов и коннектор без записи.
 * «Внешний» коннектор здесь — учебный: он читает то же демо-хранилище, но
 * без localSlots, schedule и записей кабинета, как настоящая МИС.
 * Время заморожено: «сейчас» — понедельник 12.10.2026, 12:00 МСК.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { defineConnector } from '../backend/booking/connectors/contract.js';
import { createDemoConnector } from '../backend/booking/connectors/demo.js';
import { createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { BOOKING_PATHS, createDemoBookingHandler, createDemoBookingService } from '../backend/api/demoBooking.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const KEY = (suffix) => `api-key-${String(suffix).padStart(8, '0')}`;

const request = (port, method, url, { body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const unlimited = () => ({ allowed: true });

const serve = async (service) => {
  const handler = createDemoBookingHandler({ getService: async () => service, getAccountUser: async () => null, searchLimit: unlimited, readLimit: unlimited, writeLimit: unlimited });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
};

const LOR_TOMORROW = { request: { specialty: 'lor', date: { kind: 'tomorrow' } } };

describe('Запись: HTTP /api/booking/* рядом с /api/demo/*', { skip: !DatabaseSync && 'нужен Node 22.13+' }, () => {
  let index;
  let service;
  let server;
  let port;

  before(async () => {
    index = await getDemoCatalog();
    const store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
    service = createDemoBookingService({ index, store, getEngine: async () => null, now: () => NOW });
    ({ server, port } = await serve(service));
  });
  after(() => {
    server?.close();
    service?.store.close();
  });

  it('гость не занимает расписание: у удержания и записи свои лимиты на адрес', async () => {
    const counter = (max) => { let used = 0; return () => { used += 1; return used > max ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true }; }; };
    const handler = createDemoBookingHandler({ getService: async () => service, getAccountUser: async () => null, searchLimit: unlimited, readLimit: unlimited, writeLimit: unlimited, holdLimit: counter(1), bookLimit: counter(1) });
    const limited = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const local = limited.address().port;
    try {
      const statuses = {};
      for (const [name, path, body] of [['hold', '/api/booking/hold', { slotId: 'нет-такого' }], ['book', '/api/booking/bookings', { slotId: 'нет-такого', idempotencyKey: 'k'.repeat(24) }]]) {
        const first = await request(local, 'POST', path, { body });
        const second = await request(local, 'POST', path, { body });
        statuses[name] = [first.status !== 429, second.status];
      }
      assert.deepEqual(statuses, { hold: [true, 429], book: [true, 429] });
    } finally {
      limited.close();
    }
  });

  it('у каждого прежнего пути есть новый', () => {
    const legacy = BOOKING_PATHS.filter((apiPath) => apiPath.startsWith('/api/demo/'));
    assert.equal(legacy.length, 8);
    assert.deepEqual(BOOKING_PATHS.filter((apiPath) => apiPath.startsWith('/api/booking/')), legacy.map((apiPath) => apiPath.replace('/api/demo/', '/api/booking/')));
    assert.equal(service.connector.id, 'demo', 'по умолчанию — демо-коннектор из хранилища');
  });

  it('полный цикл по новым путям; записи видны и по прежним — база одна', async () => {
    const found = await request(port, 'POST', '/api/booking/search', { body: LOR_TOMORROW });
    assert.equal(found.status, 200);
    assert.equal(found.body.status, 'ok');
    const legacy = await request(port, 'POST', '/api/demo/search', { body: LOR_TOMORROW });
    assert.deepEqual(legacy.body, found.body, 'прежний путь отвечает тем же');
    const option = found.body.options[0];

    const schedule = await request(port, 'GET', `/api/booking/slots?doctorId=${option.doctor.id}&branchId=${option.clinic.branchId}&from=2026-10-13&days=1`);
    assert.equal(schedule.status, 200);
    assert.ok(schedule.body.slots.some((slot) => slot.id === option.nextSlot.id && slot.status === 'FREE'));
    assert.ok(schedule.body.slots.some((slot) => slot.status !== 'FREE'), 'у демо в расписании видны и занятые');

    const hold = await request(port, 'POST', '/api/booking/hold', { body: { slotId: option.nextSlot.id } });
    assert.equal(hold.status, 200);
    const booked = await request(port, 'POST', '/api/booking/bookings', { body: { slotId: option.nextSlot.id, holdToken: hold.body.holdToken, idempotencyKey: KEY(10) } });
    assert.equal(booked.status, 201);
    const repeated = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: option.nextSlot.id, holdToken: hold.body.holdToken, idempotencyKey: KEY(10) } });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.booking.number, booked.body.booking.number);

    const { number, cancelToken } = booked.body.booking;
    const lookup = await request(port, 'POST', '/api/demo/bookings/lookup', { body: { items: [{ number, cancelToken }] } });
    assert.equal(lookup.body.bookings[0].found, true);
    const cancelled = await request(port, 'POST', '/api/booking/bookings/cancel', { body: { number, cancelToken } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.slotReleased, true);
    const mine = await request(port, 'GET', '/api/booking/bookings/mine');
    assert.equal(mine.status, 401, 'гостю — вход');
  });
});

describe('Запись: внешний коннектор через кэш', { skip: !DatabaseSync && 'нужен Node 22.13+' }, () => {
  let index;
  let store;

  before(async () => {
    index = await getDemoCatalog();
    store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
  });
  after(() => store?.close());

  /** «МИС» на демо-хранилище: без localSlots, без schedule и записей кабинета — как у настоящей. */
  const remoteMis = () => {
    const calls = { listSlots: 0 };
    const demo = createDemoConnector({ store });
    const connector = defineConnector({
      id: 'remote-mis',
      can: { slots: true, hold: true, book: true, cancel: true, status: true },
      listSlots: (query) => {
        calls.listSlots += 1;
        return demo.listSlots(query);
      },
      checkSlot: demo.checkSlot,
      hold: demo.hold,
      release: demo.release,
      book: demo.book,
      cancel: demo.cancel,
      status: demo.status,
    });
    return { connector, calls };
  };

  it('подбор читает кэш; своя запись сбрасывает его, и занятый слот больше не предлагается', async () => {
    const { connector, calls } = remoteMis();
    const service = createDemoBookingService({ index, connector, getEngine: async () => null, now: () => NOW });
    const { server, port } = await serve(service);
    try {
      const found = await request(port, 'POST', '/api/booking/search', { body: LOR_TOMORROW });
      assert.equal(found.body.status, 'ok');
      assert.equal(calls.listSlots, 1);
      await request(port, 'POST', '/api/booking/search', { body: LOR_TOMORROW });
      assert.equal(calls.listSlots, 1, 'второй поиск — из кэша');

      const slotId = found.body.options[0].nextSlot.id;
      const booked = await request(port, 'POST', '/api/booking/bookings', { body: { slotId, idempotencyKey: KEY(20) } });
      assert.equal(booked.status, 201);
      const again = await request(port, 'POST', '/api/booking/search', { body: LOR_TOMORROW });
      assert.equal(calls.listSlots, 2, 'после записи пара перечитана');
      assert.ok(!again.body.options.some((option) => option.slots.some((slot) => slot.id === slotId)), 'занятый слот не предлагается');

      const taken = await request(port, 'POST', '/api/booking/hold', { body: { slotId } });
      assert.equal(taken.status, 409);
      assert.equal(taken.body.code, 'slot_taken');
      assert.ok(service.slots.stats().hits >= 1);
    } finally {
      server.close();
    }
  });

  it('без schedule расписание врача — только свободное время; без записей кабинета — пустой список', async () => {
    const { connector } = remoteMis();
    const service = createDemoBookingService({ index, connector, getEngine: async () => null, now: () => NOW });
    // Врач и филиал — по настоящему свободному слоту: у кого-то завтра выходной.
    const pairs = index.catalog.doctors.flatMap((item) => item.branchIds.map((branchId) => ({ doctorId: item.id, branchId })));
    const [free] = createDemoConnector({ store }).listSlots({ pairs, fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    const doctor = index.doctors.get(free.doctorId);
    const schedule = await service.schedule({ doctor, branchId: free.branchId, fromDay: '2026-10-13', toDay: '2026-10-13', at: NOW });
    assert.ok(schedule.slots.some((slot) => slot.id === free.id));
    assert.ok(schedule.slots.every((slot) => slot.status === 'FREE' && slot.branchId === free.branchId));
    assert.deepEqual(schedule.slots.map((slot) => slot.startAt), [...schedule.slots.map((slot) => slot.startAt)].sort());
    assert.deepEqual(schedule.absences, []);
    assert.deepEqual(await service.listForAccount({ accountId: 'a'.repeat(32), at: NOW }), []);
  });

  it('коннектор только со слотами: удержание и запись — 409 not_supported', async () => {
    const demo = createDemoConnector({ store });
    const connector = defineConnector({ id: 'requests-only', can: { slots: true }, listSlots: demo.listSlots, checkSlot: demo.checkSlot });
    const service = createDemoBookingService({ index, connector, getEngine: async () => null, now: () => NOW });
    const { server, port } = await serve(service);
    try {
      const found = await request(port, 'POST', '/api/booking/search', { body: LOR_TOMORROW });
      assert.equal(found.body.status, 'ok', 'свободное время показывается');
      const slotId = found.body.options[0].nextSlot.id;
      for (const [url, body] of [
        ['/api/booking/hold', { slotId }],
        ['/api/booking/bookings', { slotId, idempotencyKey: KEY(30) }],
        ['/api/booking/bookings/cancel', { number: 'DEMO-121026-AAAAA', cancelToken: 'x'.repeat(40) }],
        ['/api/booking/bookings/lookup', { items: [] }],
      ]) {
        const response = await request(port, 'POST', url, { body });
        assert.equal(response.status, 409, url);
        assert.equal(response.body.code, 'not_supported', url);
      }
      assert.equal(store.getSlot(slotId, NOW).status, 'FREE', 'слот не тронут');
    } finally {
      server.close();
    }
  });
});
