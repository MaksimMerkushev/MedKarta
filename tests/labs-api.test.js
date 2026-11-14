/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории через настоящий HTTP: публичный API (каталог, подбор, расписание,
 * запись, отмена, защита от подделки запроса, лимиты) и админ-API с правами
 * labs.view / labs.manage / labs.bookings и журналом действий.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { bootstrapSuperadmin } from '../backend/accounts/bootstrap.js';
import { createDelivery } from '../backend/accounts/delivery.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { createLabsHandler } from '../backend/api/labs.js';
import { addDays, moscowMoment } from '../backend/demo/time.js';
import { __setDefaultLabService, createLabService } from '../backend/labs/service.js';
import { createLabStore } from '../backend/labs/store.js';
import { acceptLink, browserFor, softAuthenticator, startAuthServer } from './helpers/authKit.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-11-09', '09:00');
const unlimited = () => ({ allowed: true });

const startLabs = async (service, options = {}) => {
  const handler = createLabsHandler({ getService: async () => service, readLimit: unlimited, quoteLimit: unlimited, writeLimit: unlimited, bookLimit: unlimited, getAccountUser: async () => null, ...options });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, origin = base, contentType = 'application/json', headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': contentType } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { server, base, call };
};

describe('Лаборатории: публичный API', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let store;
  let labs;
  before(async () => {
    store = createLabStore({ DatabaseSync, file: ':memory:', now: () => NOW });
    labs = await startLabs(createLabService({ store, now: () => NOW }));
  });
  after(() => {
    labs.server.close();
    store.close();
  });

  it('каталог, исследование с подготовкой и примером бланка, лаборатория с филиалами и часами', async () => {
    const catalog = await labs.call('/api/labs/catalog');
    assert.equal(catalog.status, 200);
    assert.ok(catalog.body.tests.length >= 50 && catalog.body.categories.length >= 8);
    assert.ok(catalog.body.tests.find((test) => test.code === 'FERRITIN').minPrice > 0);
    const test = await labs.call('/api/labs/tests/CBC_DIFF');
    assert.equal(test.status, 200);
    assert.ok(test.body.test.preparation && test.body.test.synonyms.includes('ОАК'));
    assert.ok(test.body.demoResults.length >= 1 && test.body.labs.length >= 3);
    assert.equal((await labs.call('/api/labs/tests/NOPE_TEST')).status, 404);
    const lab = await labs.call('/api/labs/labs/lab-mediana');
    assert.equal(lab.status, 200);
    assert.ok(lab.body.branches.length >= 3 && lab.body.branches.every((branch) => branch.collection && branch.fees.length > 0));
  });

  it('подбор: 200 с вариантами; пустая корзина — 400', async () => {
    const quote = await labs.call('/api/labs/quote', { method: 'POST', body: { request: { tests: ['CBC_DIFF', 'TSH'], date: { kind: 'tomorrow' } } } });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.status, 'ok');
    assert.ok(quote.body.options[0].slots.length > 0);
    assert.equal((await labs.call('/api/labs/quote', { method: 'POST', body: { request: { tests: [] } } })).status, 400);
  });

  it('расписание, запись, повтор, просмотр по коду и отмена с освобождением места', async () => {
    const branchId = 'lab-probirka-ulyanova-lenina';
    const schedule = await labs.call(`/api/labs/slots?branchId=${branchId}&days=3&tests=CBC_DIFF,TSH`);
    assert.equal(schedule.status, 200);
    const slot = schedule.body.slots.find((item) => item.bookable && item.day === addDays('2026-11-09', 1));
    const body = { branchId, slotId: slot.id, tests: ['CBC_DIFF', 'TSH'], idempotencyKey: randomBytes(12).toString('hex'), expectedTotal: schedule.body.quote.total };
    const created = await labs.call('/api/labs/bookings', { method: 'POST', body });
    assert.equal(created.status, 201);
    assert.equal(created.body.booking.total, schedule.body.quote.total);
    assert.equal((await labs.call('/api/labs/bookings', { method: 'POST', body })).status, 200);
    const { number, cancelToken } = created.body.booking;
    const lookup = await labs.call('/api/labs/bookings/lookup', { method: 'POST', body: { items: [{ number, cancelToken }, { number, cancelToken: 'x'.repeat(30) }] } });
    assert.deepEqual(lookup.body.bookings.map((item) => item.found), [true, false]);
    const cancelled = await labs.call('/api/labs/bookings/cancel', { method: 'POST', body: { number, cancelToken } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.slotReleased, true);
    assert.equal((await labs.call('/api/labs/bookings/mine')).status, 401);
  });

  it('запись с чужого сайта (Origin или Sec-Fetch-Site) и без JSON — 403; сверх лимита — 429', async () => {
    const body = { branchId: 'lab-probirka-ulyanova-lenina', slotId: 'x', tests: ['CBC_DIFF'], idempotencyKey: 'k'.repeat(20) };
    assert.equal((await labs.call('/api/labs/bookings', { method: 'POST', body, origin: 'https://evil.example' })).status, 403);
    assert.equal((await labs.call('/api/labs/bookings', { method: 'POST', body, contentType: 'text/plain' })).status, 403);
    // Без Origin запрос проходит, как и у записи к врачам (часть браузеров его не шлёт), но браузер с чужого сайта выдаёт Sec-Fetch-Site.
    assert.equal((await labs.call('/api/labs/bookings', { method: 'POST', body, origin: null, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const limited = await startLabs(createLabService({ store, now: () => NOW }), { quoteLimit: () => ({ allowed: false, retryAfterSeconds: 30 }) });
    assert.equal((await limited.call('/api/labs/quote', { method: 'POST', body: { request: { tests: ['CBC_DIFF'] } } })).status, 429);
    limited.server.close();
  });

  it('раздел выключен — 404 с кодом, а не ошибка', async () => {
    const off = await startLabs(null);
    const result = await off.call('/api/labs/catalog');
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'labs_disabled');
    off.server.close();
  });
});

describe('Лаборатории: админ-API и права', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let context;
  let server;
  let base;
  let root;
  let store;
  const ROOT_PASSWORD = 'Корневой-пароль-2026';

  before(async () => {
    store = createLabStore({ DatabaseSync, file: ':memory:', now: () => NOW });
    __setDefaultLabService(createLabService({ store, now: () => NOW }));
    context = createAccountContext({
      store: createSqliteAccountStore({ DatabaseSync, file: ':memory:' }), delivery: createDelivery({ env: {} }), env: { PUBLIC_BASE_URL: 'https://medkarta.test' },
      mfaKey: randomBytes(32), breachCheck: async () => ({ breached: false }), isKnownPlan: () => false, onAccountDeleted: async () => {}, systemInfo: async () => null,
    });
    await bootstrapSuperadmin({ store: context.store, email: 'root@medkarta.test', firstName: 'Максим', password: ROOT_PASSWORD });
    ({ server, base } = await startAuthServer(context));
    root = browserFor(base);
    assert.equal((await root.login('root@medkarta.test', ROOT_PASSWORD)).status, 200);
    await root.enrollPasskey(softAuthenticator());
  });
  after(() => {
    server?.close();
    store.close();
    __setDefaultLabService(undefined);
  });

  const createActive = async ({ email, role }) => {
    const created = await root.call('/api/admin/users', { method: 'POST', body: { email, firstName: 'Тест', lastName: 'Тестов', role } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { tab } = await acceptLink(base, created.body.link, 'Постоянный-пароль-1');
    if (role !== 'user') {
      tab.password = 'Постоянный-пароль-1';
      await tab.enrollPasskey(softAuthenticator());
    }
    return tab;
  };

  it('суперадминистратор: обзор, цена, расписание, процедура, исследование; всё — в журнале', async () => {
    const overview = await root.call('/api/admin/labs');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.labs.length, 6);
    const price = await root.call('/api/admin/labs/branches/lab-mediana-tatarstan/offerings/FERRITIN', { method: 'PUT', body: { price: 777, turnaroundHours: 12 } });
    assert.equal(price.status, 200, JSON.stringify(price.body));
    assert.equal(price.body.price, 777);
    const branch = await root.call('/api/admin/labs/branches/lab-mediana-tatarstan', { method: 'PATCH', body: { slotCapacity: 4 } });
    assert.equal(branch.status, 200);
    assert.equal(branch.body.slotCapacity, 4);
    const fee = await root.call('/api/admin/labs/branches/lab-mediana-tatarstan/fees/venous_blood', { method: 'PUT', body: { price: 199 } });
    assert.equal(fee.body.fee.price, 199);
    const test = await root.call('/api/admin/labs/tests', { method: 'POST', body: { code: 'DEMO_ADMIN', name: 'Тест от администратора', category: 'clinical', biomaterial: 'venous_blood', turnaroundHours: 24, synonyms: ['админ тест'] } });
    assert.equal(test.status, 201);
    const bad = await root.call('/api/admin/labs/branches/lab-mediana-tatarstan/offerings/FERRITIN', { method: 'PUT', body: { price: 'дорого' } });
    assert.equal(bad.status, 400);
    const audit = await root.call('/api/admin/audit?q=labs');
    const actions = (audit.body.items || []).map((item) => item.action);
    assert.ok(actions.includes('labs.offering_put') && actions.includes('labs.branch_update') && actions.includes('labs.test_create'), actions.join(','));
  });

  it('обычный пользователь к админ-API лабораторий не допускается', async () => {
    const user = await createActive({ email: 'user.labs@medkarta.test', role: 'user' });
    const result = await user.call('/api/admin/labs');
    assert.equal(result.status, 403);
    const write = await user.call('/api/admin/labs/branches/lab-mediana-tatarstan/offerings/FERRITIN', { method: 'PUT', body: { price: 1 } });
    assert.equal(write.status, 403);
    assert.notEqual(store.branchOfferings('lab-mediana-tatarstan').find((item) => item.testCode === 'FERRITIN').price, 1);
  });

  it('модератор: смотреть можно, менять цены и записи — нет; попытка изменения — в журнале', async () => {
    const moderator = await createActive({ email: 'moderator.labs@medkarta.test', role: 'moderator' });
    assert.equal((await moderator.call('/api/admin/labs/tests')).status, 200);
    const write = await moderator.call('/api/admin/labs/branches/lab-mediana-tatarstan/offerings/FERRITIN', { method: 'PUT', body: { price: 2 } });
    assert.equal(write.status, 403);
    assert.equal((await moderator.call('/api/admin/labs/bookings')).status, 403);
    const audit = await root.call('/api/admin/audit?q=labs');
    assert.ok((audit.body.items || []).some((item) => item.action === 'labs.labsOfferingPut' && item.result === 'denied'));
  });

  it('записи: список и отмена администратором освобождают место', async () => {
    const branchId = 'lab-eritro-khakima';
    const slot = store.freeSlots({ branchIds: [branchId], days: [addDays('2026-11-09', 2)], at: NOW }).get(branchId)[0];
    const booking = store.book({ branchId, slotId: slot.id, testCodes: ['CBC_DIFF'], idempotencyKey: randomBytes(12).toString('hex'), at: NOW });
    const list = await root.call('/api/admin/labs/bookings?status=CONFIRMED');
    assert.ok(list.body.items.some((item) => item.number === booking.number));
    assert.ok(list.body.items.every((item) => !('cancelToken' in item) && !('accountId' in item)));
    const cancelled = await root.call(`/api/admin/labs/bookings/${booking.number}/cancel`, { method: 'POST', body: {} });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancelledBy, 'admin');
    assert.equal(store.getSlot(slot.id, NOW).free, slot.free);
  });
});
