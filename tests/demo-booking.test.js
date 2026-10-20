/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-запись: состояния слотов, атомарная запись, повторы, гонки,
 * удержание, отмена, перезапуск и HTTP-обработчик /api/demo/*.
 * Время заморожено: «сейчас» — понедельник 12.10.2026, 12:00 МСК.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { BookingError, createBookingStore, HOLD_TTL_MS, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createDemoBookingHandler, createDemoBookingService } from '../backend/api/demoBooking.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const KEY = (suffix) => `test-key-${String(suffix).padStart(8, '0')}`;
const STORE_MODULE = new URL('../backend/demo/bookingStore.js', import.meta.url).href;
const CATALOG_MODULE = new URL('../backend/demo/catalog.js', import.meta.url).href;

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-demo-')), 'booking.sqlite');

describe('Демо-запись: хранилище', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let index;
  let store;
  let clock;

  before(async () => {
    index = await getDemoCatalog();
    clock = NOW;
    store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => clock });
  });
  after(() => store?.close());

  const freeSlot = (filter = () => true, at = clock) => {
    const pairs = index.catalog.doctors.flatMap((doctor) => doctor.branchIds.map((branchId) => ({ doctorId: doctor.id, branchId })));
    const found = [...store.freeSlots({ pairs, fromDay: '2026-10-13', toDay: '2026-10-20', at }).values()].flat().filter(filter);
    assert.ok(found.length > 0, 'нет свободного слота под условие');
    return found[0];
  };

  it('окно расписания — 14 дней; есть FREE, BOOKED и BLOCKED', () => {
    const stats = store.stats();
    assert.ok(stats.FREE > 1000 && stats.BOOKED > 500 && stats.BLOCKED > 50, JSON.stringify(stats));
  });

  it('запись переводит слот в BOOKED и выдаёт демо-номер', () => {
    const slot = freeSlot();
    const booking = store.book({ slotId: slot.id, idempotencyKey: KEY(1) });
    assert.match(booking.number, /^DEMO-121026-[A-Z0-9]{5}$/, 'дата оформления — ДДММГГ, как принято в России');
    assert.equal(booking.status, 'CONFIRMED');
    assert.equal(booking.repeated, false);
    assert.equal(booking.slot.status, 'BOOKED');
    assert.equal(store.getSlot(slot.id).status, 'BOOKED');
    assert.equal(store.getSlot(slot.id).bookable, false);
  });

  it('повтор с тем же ключом — та же запись, а не вторая', () => {
    const slot = freeSlot();
    const first = store.book({ slotId: slot.id, idempotencyKey: KEY(2) });
    const again = store.book({ slotId: slot.id, idempotencyKey: KEY(2) });
    assert.equal(again.number, first.number);
    assert.equal(again.cancelToken, first.cancelToken);
    assert.equal(again.repeated, true);
    assert.throws(() => store.book({ slotId: freeSlot().id, idempotencyKey: KEY(2) }), (error) => error.code === 'idempotency_conflict');
  });

  it('повторная запись на занятый слот отклоняется', () => {
    const slot = freeSlot();
    store.book({ slotId: slot.id, idempotencyKey: KEY(3) });
    assert.throws(() => store.book({ slotId: slot.id, idempotencyKey: KEY(4) }), (error) => error instanceof BookingError && error.code === 'slot_taken');
  });

  it('BOOKED и BLOCKED из расписания, прошедшее время и несуществующий слот — не записываются', () => {
    const schedule = store.doctorSchedule({ doctorId: index.catalog.doctors[0].id, fromDay: '2026-10-12', toDay: '2026-10-25' });
    const booked = schedule.slots.find((slot) => slot.status === 'BOOKED');
    if (booked) assert.throws(() => store.book({ slotId: booked.id, idempotencyKey: KEY(5) }), (error) => error.code === 'slot_taken');
    const allBlocked = index.catalog.doctors.flatMap((doctor) => store.doctorSchedule({ doctorId: doctor.id, fromDay: '2026-10-13', toDay: '2026-10-20' }).slots).find((slot) => slot.status === 'BLOCKED');
    assert.ok(allBlocked);
    assert.throws(() => store.book({ slotId: allBlocked.id, idempotencyKey: KEY(6) }), (error) => error.code === 'slot_unavailable');
    const morning = index.catalog.doctors.flatMap((doctor) => store.doctorSchedule({ doctorId: doctor.id, fromDay: '2026-10-12', toDay: '2026-10-12' }).slots).find((slot) => slot.start < '12:00');
    assert.ok(morning, 'есть утренний слот сегодня');
    assert.equal(morning.past, true);
    assert.equal(morning.bookable, false);
    assert.throws(() => store.book({ slotId: morning.id, idempotencyKey: KEY(7) }), (error) => error.code === 'slot_past' || error.code === 'slot_taken' || error.code === 'slot_unavailable');
    assert.throws(() => store.book({ slotId: 'demo-doc-nobody--x--20261013-1800', idempotencyKey: KEY(8) }), (error) => error.code === 'slot_not_found');
    assert.throws(() => store.book({ slotId: freeSlot().id, idempotencyKey: 'short' }), (error) => error.code === 'bad_request');
  });

  it('удержание: другой не может ни удержать, ни записаться; хозяин — может', () => {
    const slot = freeSlot();
    const hold = store.hold({ slotId: slot.id });
    assert.equal(hold.slot.status, 'HELD');
    assert.equal(hold.ttlSeconds, HOLD_TTL_MS / 1000);
    assert.throws(() => store.hold({ slotId: slot.id }), (error) => error.code === 'slot_held');
    assert.throws(() => store.book({ slotId: slot.id, idempotencyKey: KEY(9) }), (error) => error.code === 'slot_held');
    assert.throws(() => store.book({ slotId: slot.id, holdToken: 'wrong-token-wrong-token', idempotencyKey: KEY(10) }), (error) => error.code === 'slot_held');
    const booking = store.book({ slotId: slot.id, holdToken: hold.holdToken, idempotencyKey: KEY(11) });
    assert.equal(booking.slot.status, 'BOOKED');
  });

  it('удержание истекает (TTL), снятое удержание освобождает слот', () => {
    const slot = freeSlot();
    store.hold({ slotId: slot.id, at: clock });
    assert.equal(store.getSlot(slot.id, clock + HOLD_TTL_MS - 1000).status, 'HELD');
    assert.equal(store.getSlot(slot.id, clock + HOLD_TTL_MS + 1000).status, 'FREE');
    const other = store.hold({ slotId: slot.id, at: clock + HOLD_TTL_MS + 1000 });
    assert.ok(other.holdToken);
    assert.equal(store.release({ slotId: slot.id, holdToken: 'not-mine-not-mine-xx' }), false);
    assert.equal(store.release({ slotId: slot.id, holdToken: other.holdToken }), true);
    assert.equal(store.getSlot(slot.id).status, 'FREE');
  });

  it('отмена освобождает слот; повторная отмена — без изменений; чужой токен — «не найдено»', () => {
    const slot = freeSlot();
    const booking = store.book({ slotId: slot.id, idempotencyKey: KEY(12) });
    assert.throws(() => store.cancel({ number: booking.number, cancelToken: 'x'.repeat(43) }), (error) => error.code === 'booking_not_found');
    const cancelled = store.cancel({ number: booking.number, cancelToken: booking.cancelToken });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.slotReleased, true);
    assert.equal(store.getSlot(slot.id).status, 'FREE');
    const again = store.cancel({ number: booking.number, cancelToken: booking.cancelToken });
    assert.equal(again.alreadyCancelled, true);
    assert.equal(store.book({ slotId: slot.id, idempotencyKey: KEY(13) }).status, 'CONFIRMED');
  });

  it('lookup отдаёт статус только по номеру с верным токеном', () => {
    const booking = store.book({ slotId: freeSlot().id, idempotencyKey: KEY(14) });
    const [found, foreign] = store.lookup({ items: [{ number: booking.number, cancelToken: booking.cancelToken }, { number: booking.number, cancelToken: 'y'.repeat(43) }] });
    assert.equal(found.found, true);
    assert.equal(found.status, 'CONFIRMED');
    assert.equal(foreign.found, false);
  });

  it('свободные слоты для подбора — только FREE и только в будущем', () => {
    const pairs = index.catalog.doctors.map((doctor) => ({ doctorId: doctor.id, branchId: doctor.branchIds[0] }));
    const all = [...store.freeSlots({ pairs, fromDay: '2026-10-12', toDay: '2026-10-25', at: clock }).values()].flat();
    assert.ok(all.length > 500);
    assert.ok(all.every((slot) => slot.status === 'FREE' && slot.bookable && Date.parse(slot.startAt) > clock));
  });
});

describe('Демо-запись: перезапуск и сброс', { skip: !DatabaseSync && 'нужен Node 22.13+' }, () => {
  it('запись переживает перезапуск сервера (файл базы)', async () => {
    const index = await getDemoCatalog();
    const file = tempFile();
    let store = createBookingStore({ DatabaseSync, file, index, now: () => NOW });
    const pairs = index.catalog.doctors.map((doctor) => ({ doctorId: doctor.id, branchId: doctor.branchIds[0] }));
    const slot = [...store.freeSlots({ pairs, fromDay: '2026-10-13', toDay: '2026-10-13' }).values()].flat()[0];
    const booking = store.book({ slotId: slot.id, idempotencyKey: KEY(100) });
    store.close();

    store = createBookingStore({ DatabaseSync, file, index, now: () => NOW });
    assert.equal(store.getSlot(slot.id).status, 'BOOKED');
    const [found] = store.lookup({ items: [{ number: booking.number, cancelToken: booking.cancelToken }] });
    assert.equal(found.status, 'CONFIRMED');
    // Токен отмены после перезапуска тот же — секрет хранится в базе.
    assert.equal(store.cancel({ number: booking.number, cancelToken: booking.cancelToken }).status, 'CANCELLED');

    store.reset(NOW);
    assert.equal(store.lookup({ items: [{ number: booking.number, cancelToken: booking.cancelToken }] })[0].found, false);
    store.close();
  });

  it('два процесса на одну базу: из десяти одновременных попыток записаться на один слот проходит одна', async () => {
    const index = await getDemoCatalog();
    const file = tempFile();
    const store = createBookingStore({ DatabaseSync, file, index, now: () => NOW });
    const pairs = index.catalog.doctors.map((doctor) => ({ doctorId: doctor.id, branchId: doctor.branchIds[0] }));
    const slot = [...store.freeSlots({ pairs, fromDay: '2026-10-14', toDay: '2026-10-14' }).values()].flat()[0];

    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        const { createBookingStore, loadSqlite } = await import(workerData.storeModule);
        const { getDemoCatalog } = await import(workerData.catalogModule);
        const DatabaseSync = await loadSqlite();
        const index = await getDemoCatalog();
        const store = createBookingStore({ DatabaseSync, file: workerData.file, index, now: () => workerData.now });
        const results = [];
        const start = Atomics.wait(new Int32Array(workerData.gate), 0, 0, 2000);
        void start;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            store.book({ slotId: workerData.slotId, idempotencyKey: workerData.prefix + '-key-' + String(attempt).padStart(6, '0') });
            results.push('ok');
          } catch (error) {
            results.push(error.code || error.message);
          }
        }
        store.close();
        parentPort.postMessage(results);
      })().catch((error) => parentPort.postMessage(['crash:' + error.message]));
    `;
    const gate = new SharedArrayBuffer(4);
    const run = (prefix) => new Promise((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData: { storeModule: STORE_MODULE, catalogModule: CATALOG_MODULE, file, now: NOW, slotId: slot.id, prefix, gate } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const pending = [run('worker-a'), run('worker-b')];
    await new Promise((resolve) => setTimeout(resolve, 300));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = (await Promise.all(pending)).flat();
    assert.equal(results.filter((item) => item === 'ok').length, 1, results.join(','));
    assert.ok(results.filter((item) => item !== 'ok').every((item) => item === 'slot_taken'), results.join(','));
    assert.equal(store.getSlot(slot.id).status, 'BOOKED');
    store.close();
  });
});

/* ------------------------------ HTTP ---------------------------------- */

const request = (port, method, url, { body, origin = `http://127.0.0.1:${port}`, contentType = 'application/json' } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(origin ? { Origin: origin } : {}),
        ...(payload ? { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) } : {}),
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

describe('Демо-запись: HTTP /api/demo/*', { skip: !DatabaseSync && 'нужен Node 22.13+' }, () => {
  let server;
  let port;
  let service;
  const unlimited = () => ({ allowed: true });

  before(async () => {
    const index = await getDemoCatalog();
    const store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
    service = createDemoBookingService({ index, store, getEngine: async () => null, now: () => NOW });
    const handler = createDemoBookingHandler({ getService: async () => service, getAccountUser: async () => null, searchLimit: unlimited, readLimit: unlimited, writeLimit: unlimited });
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(() => {
    server?.close();
    service?.store.close();
  });

  it('полный цикл: подбор → расписание → удержание → запись → повтор → отмена', async () => {
    const found = await request(port, 'POST', '/api/demo/search', { body: { request: { specialty: 'lor', date: { kind: 'tomorrow' }, timeFrom: '18:00' } } });
    assert.equal(found.status, 200);
    assert.equal(found.body.status, 'ok');
    const option = found.body.options[0];
    assert.ok(option.nextSlot.start >= '18:00' && option.nextSlot.day === '2026-10-13');

    const schedule = await request(port, 'GET', `/api/demo/slots?doctorId=${option.doctor.id}&branchId=${option.clinic.branchId}&from=2026-10-13&days=1&planId=demo-standard`);
    assert.equal(schedule.status, 200);
    assert.equal(schedule.body.timezone, 'Europe/Moscow');
    assert.ok(schedule.body.slots.some((slot) => slot.id === option.nextSlot.id && slot.status === 'FREE'));
    assert.ok(schedule.body.coverage[option.nextSlot.serviceId]);

    const hold = await request(port, 'POST', '/api/demo/hold', { body: { slotId: option.nextSlot.id } });
    assert.equal(hold.status, 200);
    const stolen = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: option.nextSlot.id, idempotencyKey: KEY(200) } });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.code, 'slot_held');

    const booked = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: option.nextSlot.id, holdToken: hold.body.holdToken, idempotencyKey: KEY(201), planId: 'demo-standard' } });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.booking.demo, true);
    assert.equal(booked.body.booking.slot.status, 'BOOKED');
    assert.equal(booked.body.booking.doctor.id, option.doctor.id);
    assert.equal(booked.body.booking.coverage.planId, 'demo-standard');

    const repeated = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: option.nextSlot.id, holdToken: hold.body.holdToken, idempotencyKey: KEY(201), planId: 'demo-standard' } });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.booking.number, booked.body.booking.number);

    const second = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: option.nextSlot.id, idempotencyKey: KEY(202) } });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'slot_taken');

    const after = await request(port, 'GET', `/api/demo/slots?doctorId=${option.doctor.id}&branchId=${option.clinic.branchId}&from=2026-10-13&days=1`);
    assert.equal(after.body.slots.find((slot) => slot.id === option.nextSlot.id).status, 'BOOKED');

    const again = await request(port, 'POST', '/api/demo/search', { body: { request: { specialty: 'lor', date: { kind: 'tomorrow' }, timeFrom: '18:00' } } });
    assert.ok(!again.body.options.some((item) => item.slots.some((slot) => slot.id === option.nextSlot.id)), 'занятый слот не предлагается');

    const cancelled = await request(port, 'POST', '/api/demo/bookings/cancel', { body: { number: booked.body.booking.number, cancelToken: booked.body.booking.cancelToken } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.slotReleased, true);
    const freed = await request(port, 'GET', `/api/demo/slots?doctorId=${option.doctor.id}&branchId=${option.clinic.branchId}&from=2026-10-13&days=1`);
    assert.equal(freed.body.slots.find((slot) => slot.id === option.nextSlot.id).status, 'FREE');
  });

  it('две одновременные записи на один слот: одна 201, другая 409', async () => {
    const found = await request(port, 'POST', '/api/demo/search', { body: { request: { specialty: 'therapist', date: { kind: 'after_tomorrow' } } } });
    const slotId = found.body.options[0].nextSlot.id;
    const results = await Promise.all([
      request(port, 'POST', '/api/demo/bookings', { body: { slotId, idempotencyKey: KEY(300) } }),
      request(port, 'POST', '/api/demo/bookings', { body: { slotId, idempotencyKey: KEY(301) } }),
    ]);
    assert.deepEqual(results.map((item) => item.status).sort(), [201, 409]);
  });

  it('защита: чужой Origin, не-JSON, неизвестный метод, неизвестный врач', async () => {
    const foreign = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: 'x' }, origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    const form = await request(port, 'POST', '/api/demo/hold', { body: { slotId: 'x' }, contentType: 'text/plain' });
    assert.equal(form.status, 403);
    const method = await request(port, 'GET', '/api/demo/bookings');
    assert.equal(method.status, 405);
    const unknown = await request(port, 'GET', '/api/demo/slots?doctorId=demo-doc-nobody-here');
    assert.equal(unknown.status, 404);
    const bad = await request(port, 'POST', '/api/demo/bookings', { body: { slotId: '../../etc', idempotencyKey: KEY(400) } });
    assert.equal(bad.status, 400);
  });

  it('при выключенном демо — 404 demo_disabled', async () => {
    const handler = createDemoBookingHandler({ getService: async () => null, searchLimit: unlimited, readLimit: unlimited, writeLimit: unlimited });
    const off = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => off.listen(0, '127.0.0.1', resolve));
    const response = await request(off.address().port, 'POST', '/api/demo/search', { body: { request: { specialty: 'lor' } } });
    off.close();
    assert.equal(response.status, 404);
    assert.equal(response.body.code, 'demo_disabled');
  });
});

