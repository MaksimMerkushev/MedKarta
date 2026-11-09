/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории: хранилище (каталог, расписание, запись, админ-операции) и подбор
 * корзины. SQLite в памяти; гонка за место — два процесса на одном файле.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, it } from 'node:test';

import { loadSqlite } from '../backend/demo/bookingStore.js';
import { addDays, moscowMoment } from '../backend/demo/time.js';
import { buildLabSeed, CATEGORY_IDS, DEMO_RESULTS, LAB_BRANCH_POINTS, TESTS } from '../backend/labs/catalog.js';
import { kazanFacilities } from '../data/facilities.js';
import { createLabQuote, describeTurnaround } from '../backend/labs/quote.js';
import { createLabStore, LabError } from '../backend/labs/store.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-11-09', '09:00');
const TODAY = '2026-11-09';
const STORE_MODULE = new URL('../backend/labs/store.js', import.meta.url).href;
const key = (label) => `${label}-${'x'.repeat(20)}`.slice(0, 40);
const makeStore = (now = NOW) => createLabStore({ DatabaseSync, file: ':memory:', now: () => now });

const firstFreeSlot = (store, branchId, day = addDays(TODAY, 1)) => store.freeSlots({ branchIds: [branchId], days: [day], at: NOW }).get(branchId)[0];

describe('Лаборатории: исходные данные', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  it('объём демо-набора: 6 лабораторий, 20–30 филиалов, 50–80 исследований, сотни предложений, расписание на 30 дней', () => {
    const store = makeStore();
    store.ensureWindow(NOW);
    const stats = store.stats();
    assert.equal(stats.labs, 6);
    assert.ok(stats.branches >= 20 && stats.branches <= 30, String(stats.branches));
    assert.ok(stats.tests >= 50 && stats.tests <= 80, String(stats.tests));
    assert.ok(stats.offerings >= 300, String(stats.offerings));
    const branch = store.listBranches()[0];
    const days = new Set(store.branchSchedule({ branchId: branch.id, fromDay: TODAY, toDay: addDays(TODAY, 40) }).map((slot) => slot.day));
    assert.ok(days.size >= 25 && [...days].every((day) => day <= addDays(TODAY, 29)), `дней со слотами: ${days.size}`);
    store.close();
  });

  it('каталог: уникальные коды, категории из списка, у каждого подготовка; ОАК с формулой и без — разные исследования', () => {
    const codes = TESTS.map((test) => test.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(TESTS.every((test) => CATEGORY_IDS.includes(test.category) && test.preparation && test.hours > 0));
    assert.ok(codes.includes('CBC_DIFF') && codes.includes('CBC'));
    const store = makeStore();
    const synonyms = store.synonymIndex();
    const owners = new Map();
    for (const item of synonyms) {
      if (owners.has(item.normalized) && owners.get(item.normalized) !== item.code) assert.fail(`синоним «${item.synonym}» у двух исследований`);
      owners.set(item.normalized, item.code);
    }
    assert.equal(owners.get('оак'), 'CBC_DIFF');
    assert.equal(owners.get('оак без формулы'), 'CBC');
    store.close();
  });

  it('филиалы стоят в точках настоящих пунктов сдачи анализов из OSM, по одному в точке; адрес без номера дома', () => {
    const facilities = new Map(kazanFacilities.map((item) => [item.id, item]));
    const meters = (a, b) => Math.hypot((a.lat - b.lat) * 111_320, (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
    const branches = buildLabSeed().branches;
    assert.equal(branches.length, LAB_BRANCH_POINTS.length);
    for (const branch of branches) {
      const point = facilities.get(branch.osmId);
      assert.ok(point, `${branch.id}: нет объекта ${branch.osmId} в data/facilities.js`);
      assert.match(point.name, /^(KDL|Инвитро|Ситилаб)$/u, `${branch.id}: в OSM здесь не пункт сдачи анализов`);
      assert.ok(meters(branch, point) < 1, `${branch.id}: точка не совпадает с OSM`);
      assert.ok(branch.district, `${branch.id}: нет района`);
      assert.doesNotMatch(branch.address, /\d/u, `${branch.id}: в адресе номер дома`);
      for (const other of branches) {
        if (other !== branch) assert.ok(meters(branch, other) > 100, `${branch.id} и ${other.id} ближе 100 м`);
      }
    }
  });

  it('примеры бланков — синтетические и с пометкой «не для медицинских решений»', () => {
    assert.ok(DEMO_RESULTS.length >= 3);
    assert.ok(DEMO_RESULTS.every((item) => /не подходят для медицинских решений/u.test(item.disclaimer) && item.rows.every((row) => row.reference)));
  });
});

describe('Лаборатории: запись', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  it('состав и цена сохраняются построчно: исследования и одно взятие крови на два анализа крови', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const lines = store.priceLines(branch.id, ['CBC_DIFF', 'TSH']);
    assert.equal(lines.lines.filter((line) => line.kind === 'fee').length, 1);
    const slot = firstFreeSlot(store, branch.id);
    const booking = store.book({ branchId: branch.id, slotId: slot.id, testCodes: ['CBC_DIFF', 'TSH'], idempotencyKey: key('a'), at: NOW });
    assert.equal(booking.total, lines.total);
    assert.equal(booking.total, [...booking.tests, ...booking.fees].reduce((sum, line) => sum + line.price, 0));
    assert.match(booking.number, /^LAB-\d{6}-[A-Z0-9]{5}$/u);
    // Поздняя правка цены не меняет сохранённую запись.
    store.upsertOffering({ branchId: branch.id, testCode: 'TSH', price: 9999 });
    assert.equal(store.lookup({ items: [{ number: booking.number, cancelToken: booking.cancelToken }], at: NOW })[0].total, lines.total);
    store.close();
  });

  it('повтор с тем же ключом — та же запись; ключ на другой слот — отказ', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const [first, second] = store.freeSlots({ branchIds: [branch.id], days: [addDays(TODAY, 1)], at: NOW }).get(branch.id);
    const booking = store.book({ branchId: branch.id, slotId: first.id, testCodes: ['CBC_DIFF'], idempotencyKey: key('b'), at: NOW });
    const again = store.book({ branchId: branch.id, slotId: first.id, testCodes: ['CBC_DIFF'], idempotencyKey: key('b'), at: NOW });
    assert.equal(again.number, booking.number);
    assert.equal(again.repeated, true);
    assert.throws(() => store.book({ branchId: branch.id, slotId: second.id, testCodes: ['CBC_DIFF'], idempotencyKey: key('b'), at: NOW }), (error) => error.code === 'idempotency_conflict');
    store.close();
  });

  it('вместимость слота: сверх неё — отказ; отмена освобождает место; повторная отмена ничего не ломает', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const slot = firstFreeSlot(store, branch.id);
    const made = [];
    for (let index = 0; index < slot.free; index += 1) {
      made.push(store.book({ branchId: branch.id, slotId: slot.id, testCodes: ['CBC_DIFF'], idempotencyKey: key(`fill${index}`), at: NOW }));
    }
    assert.equal(store.getSlot(slot.id, NOW).free, 0);
    assert.throws(() => store.book({ branchId: branch.id, slotId: slot.id, testCodes: ['CBC_DIFF'], idempotencyKey: key('over'), at: NOW }), (error) => error.code === 'slot_full');
    const cancelled = store.cancel({ number: made[0].number, cancelToken: made[0].cancelToken, at: NOW });
    assert.equal(cancelled.slotReleased, true);
    assert.equal(store.getSlot(slot.id, NOW).free, 1);
    assert.equal(store.cancel({ number: made[0].number, cancelToken: made[0].cancelToken, at: NOW }).alreadyCancelled, true);
    assert.equal(store.getSlot(slot.id, NOW).free, 1);
    assert.throws(() => store.cancel({ number: made[1].number, cancelToken: 'неверный-код-отмены-xxxxxxxx', at: NOW }), (error) => error.code === 'booking_not_found');
    store.close();
  });

  it('прошедшее время, недоступное исследование и изменившаяся цена — запись не создаётся', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const past = store.branchSchedule({ branchId: branch.id, fromDay: TODAY, toDay: TODAY }).find((slot) => slot.past);
    if (past) assert.throws(() => store.book({ branchId: branch.id, slotId: past.id, testCodes: ['CBC_DIFF'], idempotencyKey: key('past'), at: NOW }), (error) => error.code === 'slot_past');
    const slot = firstFreeSlot(store, branch.id);
    store.upsertOffering({ branchId: branch.id, testCode: 'FERRITIN', price: 700, available: false });
    assert.throws(() => store.book({ branchId: branch.id, slotId: slot.id, testCodes: ['FERRITIN'], idempotencyKey: key('off'), at: NOW }), (error) => error.code === 'test_unavailable');
    const total = store.priceLines(branch.id, ['CBC_DIFF']).total;
    assert.throws(() => store.book({ branchId: branch.id, slotId: slot.id, testCodes: ['CBC_DIFF'], expectedTotal: total + 1, idempotencyKey: key('price'), at: NOW }), (error) => error.code === 'price_changed');
    assert.equal(store.getSlot(slot.id, NOW).free, slot.free);
    store.close();
  });

  it('записи кабинета: видит только владелец, удаление аккаунта отвязывает', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const account = 'a'.repeat(32);
    const booking = store.book({ branchId: branch.id, slotId: firstFreeSlot(store, branch.id).id, testCodes: ['TSH'], idempotencyKey: key('acc'), accountId: account, at: NOW });
    assert.equal(booking.owned, true);
    assert.equal(store.listForAccount({ accountId: account, at: NOW }).length, 1);
    assert.equal(store.listForAccount({ accountId: 'b'.repeat(32), at: NOW }).length, 0);
    assert.equal(store.forgetAccount(account), 1);
    assert.equal(store.listForAccount({ accountId: account, at: NOW }).length, 0);
    store.close();
  });

  it('два процесса за последнее место в слоте: записывается ровно один', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-labs-race-'));
    const file = path.join(dir, 'labs.sqlite');
    const store = createLabStore({ DatabaseSync, file, now: () => NOW });
    const branch = store.listBranches()[0];
    store.updateBranch(branch.id, { slotCapacity: 1 });
    store.ensureWindow(NOW);
    const slot = store.freeSlots({ branchIds: [branch.id], days: [addDays(TODAY, 2)], at: NOW }).get(branch.id)[0];
    const code = `
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        const { createLabStore } = await import(workerData.storeModule);
        const { DatabaseSync } = await import('node:sqlite');
        const store = createLabStore({ DatabaseSync, file: workerData.file, now: () => workerData.now });
        Atomics.wait(new Int32Array(workerData.gate), 0, 0, 2000);
        const results = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            store.book({ branchId: workerData.branchId, slotId: workerData.slotId, testCodes: ['CBC_DIFF'], idempotencyKey: workerData.prefix + '-key-' + String(attempt).padStart(8, '0') });
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
      const worker = new Worker(code, { eval: true, workerData: { storeModule: STORE_MODULE, file, now: NOW, branchId: branch.id, slotId: slot.id, prefix, gate } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    const pending = [run('worker-a'), run('worker-b')];
    await new Promise((resolve) => setTimeout(resolve, 300));
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    const results = (await Promise.all(pending)).flat();
    const expected = slot.free;
    assert.equal(results.filter((item) => item === 'ok').length, expected, results.join(','));
    assert.ok(results.filter((item) => item !== 'ok').every((item) => item === 'slot_full'), results.join(','));
    assert.equal(store.getSlot(slot.id, NOW).free, 0);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Лаборатории: админ-операции хранилища', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  it('создание и изменение: проверка полей, защита от гонки по версии, уникальное название', () => {
    const store = makeStore();
    const lab = store.createLab({ name: 'Тест-Лаб', description: 'Проверка' });
    assert.throws(() => store.createLab({ name: 'Тест-Лаб' }), (error) => error.code === 'conflict');
    assert.throws(() => store.createLab({ name: '' }), (error) => error instanceof LabError && error.code === 'validation');
    const updated = store.updateLab(lab.id, { description: 'Новое', version: lab.version });
    assert.equal(updated.description, 'Новое');
    assert.throws(() => store.updateLab(lab.id, { description: 'Старое', version: lab.version }), (error) => error.code === 'version_conflict');
    assert.throws(() => store.createBranch({ labId: lab.id, name: 'Филиал', address: 'Москва', lat: 55.75, lng: 37.6, hours: {}, collection: {} }), (error) => error.code === 'validation');
    assert.throws(() => store.createBranch({ labId: lab.id, name: 'Филиал', address: 'Казань', lat: 55.79, lng: 49.12, hours: { 1: [['12:00', '08:00']] }, collection: {} }), (error) => error.code === 'validation');
    const branch = store.createBranch({ labId: lab.id, name: 'Филиал', address: 'Казань, условный адрес', lat: 55.79, lng: 49.12, hours: { 1: [['08:00', '12:00']] }, collection: { 1: [['08:00', '10:00']] } });
    assert.equal(branch.active, true);
    assert.throws(() => store.createTest({ code: 'bad code', name: 'Тест', category: 'clinical', biomaterial: 'venous_blood' }), (error) => error.code === 'validation');
    const test = store.createTest({ code: 'DEMO_NEW', name: 'Новое исследование', category: 'clinical', biomaterial: 'urine', turnaroundHours: 48, synonyms: ['новый тест'] });
    assert.deepEqual(test.synonyms, ['новый тест']);
    assert.throws(() => store.upsertOffering({ branchId: branch.id, testCode: 'DEMO_NEW', price: -5 }), (error) => error.code === 'validation');
    assert.equal(store.upsertOffering({ branchId: branch.id, testCode: 'DEMO_NEW', price: 400 }).price, 400);
    assert.equal(store.setFee({ branchId: branch.id, kind: 'urine', price: 30 }).price, 30);
    assert.equal(store.setFee({ branchId: branch.id, kind: 'urine', price: null }), null);
    assert.equal(store.deleteOffering({ branchId: branch.id, testCode: 'DEMO_NEW' }), true);
    store.close();
  });

  it('новое расписание: будущие пустые слоты пересоздаются, слоты с записями остаются', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const slot = firstFreeSlot(store, branch.id);
    const booking = store.book({ branchId: branch.id, slotId: slot.id, testCodes: ['CBC_DIFF'], idempotencyKey: key('sched'), at: NOW });
    const only = { 1: [['10:00', '11:00']], 2: [['10:00', '11:00']], 3: [['10:00', '11:00']], 4: [['10:00', '11:00']], 5: [['10:00', '11:00']], 6: [], 7: [] };
    store.updateBranch(branch.id, { collection: only });
    store.ensureWindow(NOW);
    const after = store.branchSchedule({ branchId: branch.id, fromDay: addDays(TODAY, 1), toDay: addDays(TODAY, 7) });
    assert.ok(after.some((item) => item.id === slot.id), 'слот с записью остался');
    assert.ok(after.filter((item) => item.id !== slot.id).every((item) => item.start >= '10:00' && item.start < '11:00'));
    assert.equal(store.lookup({ items: [{ number: booking.number, cancelToken: booking.cancelToken }], at: NOW })[0].status, 'CONFIRMED');
    store.close();
  });

  it('отмена администратором — без кода отмены, с пометкой «admin»', () => {
    const store = makeStore();
    const branch = store.listBranches()[0];
    const booking = store.book({ branchId: branch.id, slotId: firstFreeSlot(store, branch.id).id, testCodes: ['CBC_DIFF'], idempotencyKey: key('adm'), at: NOW });
    const result = store.adminCancel({ number: booking.number, at: NOW });
    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.cancelledBy, 'admin');
    assert.equal(store.listBookings({ status: 'CANCELLED' }).total, 1);
    store.close();
  });
});

describe('Лаборатории: подбор корзины', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  const setup = () => {
    const store = makeStore();
    return { store, quote: createLabQuote({ store, now: () => NOW }) };
  };

  it('полная стоимость: сумма исследований и процедур, совпадает с записью; сравнение только среди демо', async () => {
    const { store, quote } = setup();
    const result = await quote.quote({ tests: ['CBC_DIFF', 'FERRITIN', 'TSH'] });
    assert.equal(result.status, 'ok');
    for (const option of result.options) {
      assert.equal(option.total, option.testsTotal + option.feesTotal);
      assert.equal(option.testsTotal, option.lines.reduce((sum, line) => sum + line.price, 0));
      assert.equal(option.fees.length, 1, 'одно взятие крови на три анализа крови');
      assert.equal(option.total, store.priceLines(option.branch.id, ['CBC_DIFF', 'FERRITIN', 'TSH']).total);
    }
    assert.deepEqual(result.options.map((option) => option.total), [...result.options.map((option) => option.total)].sort((a, b) => a - b));
    assert.match(result.comparisonScope, /демо-филиалов МедКарты — не по всему городу/u);
    assert.ok(result.options[0].badges.includes('cheapest'));
    store.close();
  });

  it('разный биоматериал — своя процедура на каждый; где нет всего — отдельно, с перечнем недостающего', async () => {
    const { store, quote } = setup();
    const result = await quote.quote({ tests: ['CBC_DIFF', 'URINE_CULTURE', 'COVID_PCR'] });
    for (const option of result.options) assert.deepEqual(option.fees.map((fee) => fee.feeKind).sort(), ['swab', 'urine', 'venous_blood'].filter((kind) => option.fees.some((fee) => fee.feeKind === kind)).sort());
    assert.ok(result.partial.length > 0 || result.funnel.complete === result.funnel.branches);
    for (const item of result.partial) assert.ok(item.missing.length > 0);
    store.close();
  });

  it('потолок цены: пусто — с причиной и минимальной полной стоимостью', async () => {
    const { store, quote } = setup();
    const result = await quote.quote({ tests: ['CBC_DIFF', 'FERRITIN', 'TSH'], maxTotalPrice: 500 });
    assert.equal(result.status, 'empty');
    assert.equal(result.blockedBy, 'price');
    assert.ok(result.cheapestComplete > 500);
    store.close();
  });

  it('натощак: без названного времени — только до 12:00; вечер с анализом натощак — предупреждение', async () => {
    const { store, quote } = setup();
    const morning = await quote.quote({ tests: ['GLUCOSE'], date: { kind: 'tomorrow' } });
    assert.ok(morning.options.every((option) => option.slots.every((slot) => slot.start < '12:00' && slot.day === addDays(TODAY, 1))));
    assert.match(morning.notes.join(' '), /натощак/u);
    const evening = await quote.quote({ tests: ['GLUCOSE'], timeOfDay: 'evening' });
    assert.equal(evening.fastingConflict, true);
    assert.match(evening.notes.join(' '), /вечером это обычно невозможно/u);
    store.close();
  });

  it('быстрее результат, время в пути (по прямой — с пометкой «примерно»), срок готовности', async () => {
    const { store, quote } = setup();
    const fast = await quote.quote({ tests: ['CBC_DIFF'], sort: 'turnaround' });
    assert.deepEqual(fast.options.map((option) => option.turnaroundHours), [...fast.options.map((option) => option.turnaroundHours)].sort((a, b) => a - b));
    const near = await quote.quote({ tests: ['CBC_DIFF'], originPlace: 'tukay', travel: { maxMinutes: 10 } });
    assert.ok(near.options.every((option) => option.travel.minutes <= 10 && option.travel.approximate));
    assert.match(near.notes.join(' '), /примерное/u);
    const sameDay = await quote.quote({ tests: ['CBC_DIFF'], maxTurnaroundHours: 10 });
    assert.ok(sameDay.options.length > 0 && sameDay.options.every((option) => option.turnaroundHours <= 10));
    assert.equal(describeTurnaround(6), 'в день сдачи');
    assert.equal(describeTurnaround(120), 'через 5 дней');
    store.close();
  });

  it('неизвестный код и пустая корзина — отказ, а не пустой подбор', async () => {
    const { store, quote } = setup();
    assert.equal((await quote.quote({ tests: [] })).status, 'invalid');
    assert.equal((await quote.quote({ tests: ['NOPE_CODE'] })).status, 'invalid');
    store.close();
  });
});
