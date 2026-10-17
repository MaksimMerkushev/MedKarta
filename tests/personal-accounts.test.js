/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Личные кабинеты не пересекаются: у каждого браузера своя копия демо-аккаунта,
 * демо-записи привязаны к аккаунту и видны только ему. Кабинет и демо-запись
 * подняты в одном http-сервере, «браузер» — свой набор cookie.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createAccountService } from '../backend/accounts/service.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountHandler, currentAccountUser, DEMO_OWNER_COOKIE, SESSION_COOKIE } from '../backend/api/account.js';
import { createDemoBookingHandler, createDemoBookingService } from '../backend/api/demoBooking.js';
import { createBookingStore } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const PLANS = new Set(['demo-basic', 'demo-standard', 'demo-premium']);
const unlimited = () => ({ allowed: true });

describe('Личные кабинеты: изоляция', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let server;
  let base;
  let accounts;
  let bookings;
  let flags = { registration: true, demo: true };
  let nextKey = 0;

  before(async () => {
    const accountStore = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    // Кабинет — на реальных часах: срок cookie считается от Date.now().
    accounts = createAccountService({ store: accountStore, isKnownPlan: (id) => PLANS.has(id) });
    const index = await getDemoCatalog();
    const bookingStore = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
    bookings = createDemoBookingService({ index, store: bookingStore, getEngine: async () => null, now: () => NOW });

    const getAccountService = async () => accounts;
    const limiter = createRateLimiter({ windowMs: 60_000, maxPerIp: 10_000, maxPerInstance: Number.POSITIVE_INFINITY });
    const accountHandler = createAccountHandler({
      getService: getAccountService,
      onAccountDeleted: async (userId) => bookings.store.forgetAccount(userId),
      authLimit: limiter,
      apiLimit: limiter,
      demoLimit: limiter,
      features: () => flags,
    });
    const bookingHandler = createDemoBookingHandler({
      getService: async () => bookings,
      getAccountUser: (req) => currentAccountUser(req, getAccountService),
      searchLimit: unlimited,
      readLimit: unlimited,
      writeLimit: unlimited,
    });
    server = http.createServer((req, res) => (req.url.startsWith('/api/demo/') ? bookingHandler(req, res) : accountHandler(req, res)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server?.close();
    bookings?.store.close();
  });

  /** «Браузер»: хранит cookie между запросами, как настоящий. */
  const browser = () => {
    const jar = new Map();
    const call = async (path, { method = 'GET', body } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          origin: base,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
        if (/Max-Age=0/i.test(line) || !value) jar.delete(name);
        else jar.set(name, value);
      }
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    return {
      jar,
      call,
      demo: (account) => call('/api/auth/demo', { method: 'POST', body: { account } }),
      logout: () => call('/api/auth/logout', { method: 'POST', body: {} }),
      mine: () => call('/api/demo/bookings/mine'),
      book: (slotId) => {
        nextKey += 1;
        return call('/api/demo/bookings', { method: 'POST', body: { slotId, idempotencyKey: `iso-key-${String(nextKey).padStart(8, '0')}`, planId: 'demo-standard' } });
      },
    };
  };

  const freeSlots = (count) => {
    const pairs = bookings.index.catalog.doctors.flatMap((doctor) => doctor.branchIds.map((branchId) => ({ doctorId: doctor.id, branchId })));
    const found = [...bookings.store.freeSlots({ pairs, fromDay: '2026-10-13', toDay: '2026-10-20', at: NOW }).values()].flat();
    const unique = [...new Map(found.map((slot) => [slot.id, slot])).values()].slice(0, count);
    assert.equal(unique.length, count, 'не хватило свободных слотов');
    return unique;
  };

  it('демо-вход ставит долгую cookie браузера HttpOnly, отдельную от сессии', async () => {
    const tab = browser();
    const login = await tab.demo('anna');
    assert.equal(login.status, 200);
    const lines = login.headers.getSetCookie();
    const owner = lines.find((line) => line.startsWith(`${DEMO_OWNER_COOKIE}=`));
    assert.ok(owner, 'нет cookie браузера');
    assert.match(owner, /HttpOnly/);
    assert.match(owner, /SameSite=Lax/);
    assert.match(owner, /Path=\/api/);
    assert.match(owner, /Max-Age=2592000/);
    assert.ok(tab.jar.get(SESSION_COOKIE));
    assert.equal(JSON.stringify(login.body).includes(tab.jar.get(DEMO_OWNER_COOKIE)), false, 'токен браузера не попадает в тело ответа');
  });

  it('записи из кабинета видит только этот кабинет; гость — 401', async () => {
    const [first, second] = freeSlots(2);
    const annaTab = browser();
    await annaTab.demo('anna');
    const booked = await annaTab.book(first.id);
    assert.equal(booked.status, 201);
    assert.equal(booked.body.booking.owned, true);

    const mine = await annaTab.mine();
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.bookings.map((item) => item.number), [booked.body.booking.number]);
    assert.equal(mine.body.bookings[0].demo, true);
    assert.equal(mine.body.bookings[0].cancelToken, booked.body.booking.cancelToken);

    // Тот же браузер, другой демо-аккаунт — пустой кабинет.
    await annaTab.logout();
    await annaTab.demo('family');
    assert.deepEqual((await annaTab.mine()).body.bookings, []);
    const familyBooked = await annaTab.book(second.id);
    assert.equal(familyBooked.body.booking.owned, true);
    assert.deepEqual((await annaTab.mine()).body.bookings.map((item) => item.number), [familyBooked.body.booking.number]);

    // Возврат в «Анну» в этом же браузере — её запись на месте, чужой нет.
    await annaTab.logout();
    assert.equal((await annaTab.mine()).status, 401);
    await annaTab.demo('anna');
    assert.deepEqual((await annaTab.mine()).body.bookings.map((item) => item.number), [booked.body.booking.number]);

    // Другой браузер под той же «Анной» — своя копия без чужих записей.
    const otherTab = browser();
    await otherTab.demo('anna');
    assert.deepEqual((await otherTab.mine()).body.bookings, []);

    // Гость записывается без привязки и списка в кабинете не получает.
    const guest = browser();
    const [third] = freeSlots(1);
    const guestBooked = await guest.book(third.id);
    assert.equal(guestBooked.status, 201);
    assert.equal(guestBooked.body.booking.owned, false);
    assert.equal((await guest.mine()).status, 401);
  });

  it('повтор запроса с чужим ключом не переносит запись в другой кабинет', async () => {
    const [slot] = freeSlots(1);
    const body = { slotId: slot.id, idempotencyKey: 'iso-repeat-key-0001' };
    const first = browser();
    await first.demo('basic');
    const booked = await first.call('/api/demo/bookings', { method: 'POST', body });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.booking.owned, true);

    const second = browser();
    await second.demo('basic');
    const repeated = await second.call('/api/demo/bookings', { method: 'POST', body });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.booking.owned, false);
    assert.deepEqual((await second.mine()).body.bookings, []);
    assert.deepEqual((await first.mine()).body.bookings.map((item) => item.number), [booked.body.booking.number]);
  });

  it('отмена из кабинета видна в его списке', async () => {
    const [slot] = freeSlots(1);
    const tab = browser();
    await tab.demo('kids');
    const booked = (await tab.book(slot.id)).body.booking;
    const cancelled = await tab.call('/api/demo/bookings/cancel', { method: 'POST', body: { number: booked.number, cancelToken: booked.cancelToken } });
    assert.equal(cancelled.status, 200);
    const [item] = (await tab.mine()).body.bookings;
    assert.equal(item.number, booked.number);
    assert.equal(item.status, 'CANCELLED');
  });

  it('удалённый аккаунт: записи отвязываются, новый аккаунт их не видит', async () => {
    const [slot] = freeSlots(1);
    const tab = browser();
    const created = await tab.call('/api/auth/register', { method: 'POST', body: { email: 'iso@user.ru', password: 'пароль-пароль', displayName: 'Изоляция', consent: true } });
    assert.equal(created.status, 201);
    const booked = (await tab.book(slot.id)).body.booking;
    assert.equal(booked.owned, true);
    assert.equal((await tab.mine()).body.bookings.length, 1);
    assert.equal((await tab.call('/api/account', { method: 'DELETE', body: { confirm: true } })).status, 200);

    const again = await tab.call('/api/auth/register', { method: 'POST', body: { email: 'iso@user.ru', password: 'пароль-пароль', displayName: 'Изоляция', consent: true } });
    assert.equal(again.status, 201);
    assert.deepEqual((await tab.mine()).body.bookings, []);
    flags = { registration: false, demo: true };
  });

  it('поддельная или чужая cookie браузера не открывает чужую копию', async () => {
    const owner = browser();
    await owner.demo('basic');
    await owner.call('/api/account', { method: 'PATCH', body: { dmsPlanId: 'demo-premium' } });

    const forged = browser();
    const real = owner.jar.get(DEMO_OWNER_COOKIE);
    forged.jar.set(DEMO_OWNER_COOKIE, `${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`);
    const login = await forged.demo('basic');
    assert.equal(login.body.user.dmsPlanId, 'demo-basic');
    assert.notEqual(forged.jar.get(DEMO_OWNER_COOKIE), owner.jar.get(DEMO_OWNER_COOKIE));
  });
});
