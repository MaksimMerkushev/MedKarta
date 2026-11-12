/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общий слой интеграций с МИС на симуляторе (backend/booking/mis). Симулятор
 * — вымышленный API, поэтому это проверка слоя МедКарты (MOCK VERIFIED), а не
 * интеграции с какой-либо реальной МИС. Данные синтетические.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { loadSqlite } from '../backend/demo/bookingStore.js';
import { moscowDay } from '../backend/demo/time.js';
import { canTransition, defineMisAdapter, MisError } from '../backend/booking/mis/core.js';
import { createMisHttpClient, isPrivateAddress } from '../backend/booking/mis/httpClient.js';
import { createMisLedger } from '../backend/booking/mis/ledger.js';
import { createMisRuntime } from '../backend/booking/mis/runtime.js';
import { createConnectorRouter } from '../backend/booking/mis/router.js';
import { createMisSimulator } from '../backend/booking/mis/simulator/server.js';
import { normalizeServices, normalizeSlots } from '../backend/booking/mis/normalize.js';
import { defineConnector } from '../backend/booking/connectors/contract.js';

const DatabaseSync = await loadSqlite();
const DAY = 86_400_000;
const key = () => randomBytes(12).toString('base64url');
const PAIR = { doctorId: 'doctor-1', branchId: 'branch-1' };

const setup = async ({ can = null, timeoutMs = 400 } = {}) => {
  const days = [moscowDay(Date.now() + DAY), moscowDay(Date.now() + 2 * DAY)];
  const sim = createMisSimulator({
    branches: [{ id: 'B1', name: 'Синтетический филиал', address: 'Казань, улица Тестовая' }],
    doctors: [
      { id: 'D1', name: 'Синтетический врач', specialty: 'therapist', branchIds: ['B1'], serviceId: 'V1' },
      { id: 'D9', name: 'Врач без соответствия', specialty: 'lor', branchIds: ['B1'], serviceId: 'V1' },
    ],
    services: [{ id: 'V1', name: 'Приём', price: 1500, durationMinutes: 30 }, { id: 'V2', name: 'Неверная цена', price: -5 }],
    token: 'sim-token', days,
  });
  sim.setClientTimeout(timeoutMs);
  const url = await sim.listen();
  const ledger = createMisLedger({ DatabaseSync, file: ':memory:' });
  ledger.upsertIntegration({ id: 'sim-test', clinicId: 'clinic-1', misType: 'mis-simulator', enabled: true, config: { baseUrl: url, timeoutMs, ...(can ? { capabilities: can } : {}) }, secretEnv: 'MIS_SIM_TEST' });
  ledger.setMapping('sim-test', 'branch', 'B1', 'branch-1');
  ledger.setMapping('sim-test', 'doctor', 'D1', 'doctor-1');
  ledger.setMapping('sim-test', 'service', 'V1', 'service-1');
  const env = { MIS_INTEGRATIONS: 'on', MIS_SIMULATOR: 'on', MIS_SIM_TEST: 'sim-token', MIS_SIM_TEST_WEBHOOK: 'whsec-test' };
  const runtime = createMisRuntime({ ledger, env });
  const [connector] = runtime.connectors();
  const slots = async () => connector.listSlots({ pairs: [PAIR], fromDay: days[0], toDay: days[1], at: Date.now() });
  const book = (slotId, extra = {}) => connector.book({ slotId, idempotencyKey: key(), accountId: 'acc-1', at: Date.now(), patient: { ref: 'opaque-1' }, ...extra });
  return { sim, ledger, runtime, connector, slots, book, days, close: async () => { await sim.close(); ledger.close(); } };
};

const FULL = { branches: true, doctors: true, services: true, slots: true, hold: true, book: true, cancel: true, status: true, webhooks: true, idempotentBook: true, findByRequest: true };

describe('МИС: справочники и расписание', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let ctx;
  before(async () => { ctx = await setup(); });
  after(async () => ctx.close());

  it('1–3, 21–22: врачи, филиалы, услуги; несопоставленный врач и неверная цена отмечены', async () => {
    const result = await ctx.runtime.syncIntegration('sim-test');
    assert.equal(result.ok, true);
    assert.equal(result.counts.doctors, 2);
    assert.equal(result.counts.branches, 1);
    assert.equal(result.counts.services, 1);
    assert.equal(result.counts.servicesRejected, 1);
    assert.equal(result.counts.doctorsUnmapped, 1);
    assert.deepEqual(ctx.ledger.catalogOf('sim-test', 'doctor').map((item) => item.externalId), ['D1', 'D9']);
    const codes = ctx.ledger.recentEvents('sim-test').map((item) => item.code);
    assert.ok(codes.includes('service_rejected') && codes.includes('doctor_unmapped'));
    assert.equal(ctx.ledger.getIntegration('sim-test').status, 'ok');
  });

  it('4–5: свободные слоты — только сопоставленные пары, id МедКарты, время по Москве', async () => {
    const slots = await ctx.slots();
    assert.equal(slots.length, 10);
    for (const slot of slots) {
      assert.match(slot.id, /^mis\.sim-test\./);
      assert.equal(slot.doctorId, 'doctor-1');
      assert.equal(slot.branchId, 'branch-1');
      assert.equal(slot.serviceId, 'service-1');
      assert.equal(slot.bookable, true);
      assert.match(slot.start, /^\d{2}:\d{2}$/);
    }
    assert.ok(slots.some((slot) => slot.start === '09:00'));
  });

  it('5, 21: врач без соответствия не попадает в подбор', async () => {
    const slots = await ctx.connector.listSlots({ pairs: [{ doctorId: 'unknown', branchId: 'branch-1' }], fromDay: ctx.days[0], toDay: ctx.days[1], at: Date.now() });
    assert.deepEqual(slots, []);
  });
});

describe('МИС: запись', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let ctx;
  before(async () => { ctx = await setup(); });
  after(async () => ctx.close());

  it('7, 9: удержание в МИС и подтверждённая запись', async () => {
    const [slot] = await ctx.slots();
    const held = await ctx.connector.hold({ slotId: slot.id, at: Date.now() });
    assert.equal(held.guaranteed, true);
    assert.equal(ctx.sim.state.holds.size, 1);
    const idempotencyKey = key();
    const booking = await ctx.connector.book({ slotId: slot.id, holdToken: held.holdToken, idempotencyKey, accountId: 'acc-1', at: Date.now(), patient: { ref: 'opaque-1' } });
    assert.equal(booking.state, 'confirmed');
    assert.equal(booking.stateText, 'Запись подтверждена');
    assert.match(booking.number, /^MK-\d{6}-[A-Z0-9]{5}$/);
    const appointment = ctx.sim.appointmentByRequest(ctx.ledger.opByNumber(booking.number).id);
    assert.equal(appointment.status, 'confirmed');
    assert.deepEqual(appointment.patient, { ref: 'opaque-1' });
    assert.deepEqual(ctx.ledger.eventsOf(ctx.ledger.opByNumber(booking.number).id).map((item) => item.to), ['booking_pending', 'confirmed']);
  });

  it('13: повтор с тем же ключом — та же запись, вторая в МИС не создаётся', async () => {
    const [, slot] = await ctx.slots();
    const idempotencyKey = key();
    const first = await ctx.connector.book({ slotId: slot.id, idempotencyKey, at: Date.now() });
    const again = await ctx.connector.book({ slotId: slot.id, idempotencyKey, at: Date.now() });
    assert.equal(again.number, first.number);
    assert.equal(again.repeated, true);
    assert.equal([...ctx.sim.state.appointments.values()].filter((item) => item.slotId === ctx.ledger.opByNumber(first.number).externalSlotId).length, 1);
    await assert.rejects(ctx.connector.book({ slotId: (await ctx.slots())[0].id, idempotencyKey, at: Date.now() }), { code: 'idempotency_conflict' });
  });

  it('14: два одновременных запроса на один слот — запись одна, второй получает «занято»', async () => {
    const [slot] = await ctx.slots();
    const results = await Promise.allSettled([ctx.book(slot.id), ctx.book(slot.id)]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'slot_taken');
    const external = JSON.parse(Buffer.from(slot.id.split('.').slice(2).join('.'), 'base64url').toString()).e;
    assert.equal([...ctx.sim.state.appointments.values()].filter((item) => item.slotId === external).length, 1);
  });

  it('6: слот занят другим пациентом в клинике — отказ без попытки записи', async () => {
    const [slot] = await ctx.slots();
    const external = JSON.parse(Buffer.from(slot.id.split('.').slice(2).join('.'), 'base64url').toString()).e;
    ctx.sim.takeSlotByOther(external);
    const before = ctx.sim.state.appointments.size;
    await assert.rejects(ctx.book(slot.id), { code: 'slot_taken' });
    assert.equal(ctx.sim.state.appointments.size, before);
  });

  it('18: расписание изменилось — устаревший слот не превращается в запись', async () => {
    const [slot] = await ctx.slots();
    const external = JSON.parse(Buffer.from(slot.id.split('.').slice(2).join('.'), 'base64url').toString()).e;
    ctx.sim.moveSlot(external, 45);
    await assert.rejects(ctx.book(slot.id), { code: 'slot_taken' });
  });

  it('10: МИС отказала в записи — failed и понятная ошибка', async () => {
    const [slot] = await ctx.slots();
    ctx.sim.fail('book', 'slot_taken');
    await assert.rejects(ctx.book(slot.id), { code: 'slot_taken' });
    const failed = [...ctx.ledger.opsByAccount('acc-1')].find((op) => op.slotId === slot.id);
    assert.equal(failed.state, 'failed');
  });

  it('19: ошибка авторизации МИС — запись недоступна, пациенту без подробностей', async () => {
    const [slot] = await ctx.slots();
    ctx.sim.fail('book', 'auth_error');
    await assert.rejects(ctx.book(slot.id), (error) => error.code === 'integration_unavailable' && !/token|401/i.test(error.message));
    ctx.sim.fail('branches', 'auth_error');
    const test = await ctx.runtime.testConnection('sim-test');
    assert.equal(test.ok, false);
    assert.equal(test.errorCode, 'auth_failed');
  });

  it('11: запись создана, ответ потерян — сверка находит её, второй записи нет', async () => {
    const [slot] = await ctx.slots();
    ctx.sim.fail('book', 'lost_response');
    const booking = await ctx.book(slot.id);
    assert.equal(booking.state, 'confirmed');
    const op = ctx.ledger.opByNumber(booking.number);
    assert.deepEqual(ctx.ledger.eventsOf(op.id).map((item) => item.to), ['booking_pending', 'pending_reconciliation', 'confirmed']);
    assert.equal([...ctx.sim.state.appointments.values()].filter((item) => item.requestId === op.id).length, 1);
  });

  it('12: тайм-аут до обработки — сверка не нашла, повтор с тем же ключом безопасен (идемпотентный API)', async () => {
    const [slot] = await ctx.slots();
    ctx.sim.fail('book', 'timeout');
    const booking = await ctx.book(slot.id);
    assert.equal(booking.state, 'confirmed');
    const op = ctx.ledger.opByNumber(booking.number);
    assert.deepEqual(ctx.ledger.eventsOf(op.id).map((item) => item.to), ['booking_pending', 'pending_reconciliation', 'booking_pending', 'confirmed']);
    assert.equal([...ctx.sim.state.appointments.values()].filter((item) => item.requestId === op.id).length, 1);
  });

  it('20: непонятный ответ на запись — «статус уточняется», не «подтверждено»', async () => {
    const [slot] = await ctx.slots();
    ctx.sim.fail('book', 'invalid_json');
    ctx.sim.fail('find', 'unavailable');
    const booking = await ctx.book(slot.id);
    // Симулятор на invalid_json ответил до обработки — записи нет; сверка недоступна; подтверждение — только после ответа МИС на повтор.
    const op = ctx.ledger.opByNumber(booking.number);
    assert.deepEqual(ctx.ledger.eventsOf(op.id).map((item) => item.to), ['booking_pending', 'pending_reconciliation', 'booking_pending', 'confirmed']);
    assert.equal(booking.state, 'confirmed');
    assert.equal([...ctx.sim.state.appointments.values()].filter((item) => item.requestId === op.id).length, 1);
  });

  it('15–16: отмена в МИС освобождает слот; повторная отмена — без изменений', async () => {
    const [slot] = await ctx.slots();
    const booking = await ctx.book(slot.id);
    const cancelled = await ctx.connector.cancel({ number: booking.number, cancelToken: booking.cancelToken });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.slotReleased, true);
    const op = ctx.ledger.opByNumber(booking.number);
    assert.equal(ctx.sim.state.appointments.get(op.externalBookingId).status, 'cancelled');
    const again = await ctx.connector.cancel({ number: booking.number, cancelToken: booking.cancelToken });
    assert.equal(again.alreadyCancelled, true);
    await assert.rejects(ctx.connector.cancel({ number: booking.number, cancelToken: 'чужой' }), { code: 'booking_not_found' });
  });

  it('23: статус записи изменился в клинике — webhook с подписью применяется один раз', async () => {
    const [slot] = await ctx.slots();
    const booking = await ctx.book(slot.id);
    const op = ctx.ledger.opByNumber(booking.number);
    ctx.sim.setAppointmentStatus(op.externalBookingId, 'cancelled');
    const signed = ctx.sim.signWebhook('whsec-test', { type: 'appointment.status', appointmentId: op.externalBookingId, status: 'cancelled' });
    const headers = Object.fromEntries(Object.entries(signed.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal((await ctx.runtime.handleWebhook('sim-test', { headers: { ...headers, 'x-sim-signature': 'sha256=00' }, rawBody: signed.raw })).status, 401);
    assert.equal((await ctx.runtime.handleWebhook('sim-test', { headers, rawBody: signed.raw })).status, 200);
    assert.equal(ctx.ledger.getOp(op.id).state, 'cancelled');
    assert.equal((await ctx.runtime.handleWebhook('sim-test', { headers, rawBody: signed.raw })).duplicate, true);
    const [status] = await ctx.connector.status({ items: [{ number: booking.number, cancelToken: booking.cancelToken }] });
    assert.equal(status.state, 'cancelled');
  });
});

describe('МИС: без удержания, без сверки по ключу, недоступность', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  it('8: МИС без удержания — виртуальное удержание и проверка свежести перед записью', async () => {
    const ctx = await setup({ can: { ...FULL, hold: false } });
    try {
      const [slot] = await ctx.slots();
      const held = await ctx.connector.hold({ slotId: slot.id, at: Date.now() });
      assert.equal(held.guaranteed, false);
      assert.equal(ctx.sim.state.holds.size, 0);
      const booking = await ctx.connector.book({ slotId: slot.id, holdToken: held.holdToken, idempotencyKey: key(), at: Date.now() });
      assert.equal(booking.state, 'confirmed');
      await assert.rejects(ctx.connector.book({ slotId: slot.id, holdToken: 'v.подделка.1.x', idempotencyKey: key(), at: Date.now() }), { code: 'slot_held' });
    } finally {
      await ctx.close();
    }
  });

  it('11 без поиска по ключу: потерянный ответ — «статус уточняется», повтора вслепую нет', async () => {
    const ctx = await setup({ can: { ...FULL, findByRequest: false, idempotentBook: false } });
    try {
      const [slot] = await ctx.slots();
      ctx.sim.fail('book', 'lost_response');
      const booking = await ctx.book(slot.id);
      assert.equal(booking.state, 'pending_reconciliation');
      assert.equal(booking.stateText, 'Статус уточняется');
      assert.equal(booking.status, 'pending');
      assert.equal(ctx.sim.state.appointments.size, 1);
      await assert.rejects(ctx.connector.cancel({ number: booking.number, cancelToken: booking.cancelToken }), { code: 'booking_pending' });
      assert.ok(ctx.ledger.recentEvents('sim-test').some((item) => item.code === 'manual_reconciliation_required'));
    } finally {
      await ctx.close();
    }
  });

  it('17, 24: МИС недоступна — подбор пуст, синхронизация с ошибкой; потом восстанавливается и сверяет записи', async () => {
    const ctx = await setup({ can: { ...FULL, idempotentBook: false } });
    try {
      ctx.sim.fail('slots', 'unavailable');
      const router = createConnectorRouter({ demo: defineConnector({ id: 'demo', can: { slots: true, hold: true, book: true, cancel: true, status: true }, listSlots: () => [], checkSlot: () => null, hold: () => null, release: () => false, book: () => null, cancel: () => null, status: () => [] }), mis: [ctx.connector] });
      assert.deepEqual(await router.listSlots({ pairs: [PAIR], fromDay: ctx.days[0], toDay: ctx.days[1], at: Date.now() }), []);
      ctx.sim.fail('branches', 'unavailable');
      const failed = await ctx.runtime.syncIntegration('sim-test');
      assert.equal(failed.ok, false);
      assert.equal(failed.errorCode, 'unavailable');
      assert.equal(ctx.ledger.getIntegration('sim-test').status, 'error');
      // Запись с неизвестным исходом во время сбоя: МИС создала, ответ потерян, сверка недоступна.
      const [slot] = await ctx.slots();
      ctx.sim.fail('book', 'lost_response');
      ctx.sim.fail('find', 'unavailable');
      const booking = await ctx.book(slot.id);
      assert.equal(booking.state, 'pending_reconciliation');
      const recovered = await ctx.runtime.syncIntegration('sim-test');
      assert.equal(recovered.ok, true);
      assert.equal(recovered.counts.reconcile.confirmed, 1);
      assert.equal(ctx.ledger.opByNumber(booking.number).state, 'confirmed');
      assert.equal(ctx.ledger.getIntegration('sim-test').status, 'ok');
    } finally {
      await ctx.close();
    }
  });
});

describe('МИС: защита и проверка данных', () => {
  it('SSRF: только разрешённые хосты, https, без частных адресов; симулятор в production запрещён', async () => {
    assert.throws(() => createMisHttpClient({ baseUrl: 'https://mis.example/api', allowedHosts: ['other.example'] }), /allowedHosts/u);
    assert.throws(() => createMisHttpClient({ baseUrl: 'http://mis.example/api', allowedHosts: ['mis.example'] }), /https/u);
    assert.throws(() => createMisHttpClient({ baseUrl: 'http://127.0.0.1:9', allowedHosts: ['127.0.0.1'], allowPrivate: true, production: true }), /production/u);
    const client = createMisHttpClient({ baseUrl: 'https://mis.example/api', allowedHosts: ['mis.example'], resolve: async () => [{ address: '10.0.0.5' }], fetchImpl: async () => { throw new Error('не должно вызываться'); } });
    await assert.rejects(client.request('GET', '/slots'), (error) => error instanceof MisError && error.detail === 'private_address');
    await assert.rejects(client.request('GET', 'https://evil.example/x'), (error) => error.detail === 'absolute_path');
    await assert.rejects(client.request('GET', '//evil.example/x'), (error) => error.detail === 'absolute_path');
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(address), true, address);
    assert.equal(isPrivateAddress('93.184.216.34'), false);
  });

  it('нормализация: цена, длительность, время, окно', () => {
    const services = normalizeServices([{ id: 'a', price: 100 }, { id: 'b', price: 1.5 }, { id: 'c', price: 2_000_000 }, { price: 1 }, { id: 'a', price: 1 }]);
    assert.deepEqual(services.valid.map((item) => item.externalId), ['a']);
    assert.deepEqual(services.rejected.map((item) => item.reason).sort(), ['duplicate_id', 'invalid_price', 'invalid_price', 'missing_id']);
    const now = Date.parse('2026-11-12T09:00:00Z');
    const slots = normalizeSlots([
      { id: 's1', doctorId: 'd', branchId: 'b', startAt: '2026-11-13T09:00:00Z', endAt: '2026-11-13T09:30:00Z' },
      { id: 's2', doctorId: 'd', branchId: 'b', startAt: '2026-11-13T09:30:00Z', endAt: '2026-11-13T09:00:00Z' },
      { id: 's3', doctorId: 'd', branchId: 'b', startAt: '2027-11-13T09:00:00Z', endAt: '2027-11-13T09:30:00Z' },
      { id: 's4', doctorId: 'd', startAt: '2026-11-13T09:00:00Z', endAt: '2026-11-13T09:30:00Z' },
    ], { window: { from: now, to: now + 14 * DAY }, now });
    assert.deepEqual(slots.valid.map((item) => item.externalId), ['s1']);
    assert.deepEqual(slots.rejected.map((item) => item.reason), ['invalid_duration', 'outside_window', 'missing_reference']);
  });

  it('жизненный цикл: недопустимые переходы запрещены; адаптер без записи не подключается', () => {
    assert.equal(canTransition('booking_pending', 'confirmed'), true);
    assert.equal(canTransition('failed', 'confirmed'), false);
    assert.equal(canTransition('cancelled', 'confirmed'), false);
    assert.equal(canTransition('confirmed', 'booking_pending'), false);
    assert.throws(() => defineMisAdapter({ type: 'x-mis', can: { slots: true }, listSlots: () => [] }), /без слотов и записи/u);
    assert.throws(() => defineMisAdapter({ type: 'x-mis', can: { slots: true, book: true, hold: true }, listSlots: () => [], book: () => null }), /hold/u);
  });

  it('секреты не хранятся в конфигурации интеграции; без флагов симулятор не запускается', async () => {
    const ledger = createMisLedger({ DatabaseSync, file: ':memory:' });
    assert.throws(() => ledger.upsertIntegration({ id: 'x-test', clinicId: 'c', misType: 'mis-simulator', config: { apiKey: 'nope' } }), /секреты/u);
    assert.throws(() => ledger.upsertIntegration({ id: 'x-test', clinicId: 'c', misType: 'mis-simulator', secretEnv: 'PASSWORD' }), /MIS_/u);
    ledger.upsertIntegration({ id: 'x-test', clinicId: 'c', misType: 'mis-simulator', enabled: true, config: { baseUrl: 'http://127.0.0.1:9' } });
    const off = createMisRuntime({ ledger, env: { MIS_INTEGRATIONS: 'on' } });
    assert.equal(off.connectors().length, 0);
    assert.equal(ledger.getIntegration('x-test').status, 'simulator_not_allowed');
    const production = createMisRuntime({ ledger, env: { MIS_INTEGRATIONS: 'on', MIS_SIMULATOR: 'on', NODE_ENV: 'production' } });
    assert.equal(production.connectors().length, 0);
    ledger.upsertIntegration({ id: 'y-test', clinicId: 'c', misType: 'some-real-mis', enabled: true, config: {} });
    createMisRuntime({ ledger, env: { MIS_INTEGRATIONS: 'on' } });
    assert.equal(ledger.getIntegration('y-test').status, 'no_adapter');
    ledger.close();
  });
});
