/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ассистент только для вошедших в личный кабинет: гость получает 401
 * login_required, вошедший проходит к обработчику чата, в который не уходит
 * ничего из кабинета. Кабинет — настоящий (SQLite в памяти и http-сервер),
 * вместо конвейера ассистента — заглушка, которая запоминает запрос.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';

import { hashPassword } from '../backend/accounts/passwords.js';
import { createAccountService } from '../backend/accounts/service.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountHandler, parseCookies, SESSION_COOKIE } from '../backend/api/account.js';
import { createChatAccessGate, withChatAccess } from '../backend/api/chatAccess.js';
import { readBody, respondJson } from '../backend/http/request.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';

const DatabaseSync = await loadSqlite();
const PLANS = new Set(['demo-basic', 'demo-standard', 'demo-premium']);

describe('Ассистент только после входа', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let server;
  let base;
  let required = true;
  let accountsOn = true;
  let store;
  const seen = [];

  before(async () => {
    store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const service = createAccountService({ store, isKnownPlan: (id) => PLANS.has(id) });
    const getService = async () => (accountsOn ? service : null);
    const limiter = createRateLimiter({ windowMs: 60_000, maxPerIp: 10_000, maxPerInstance: Number.POSITIVE_INFINITY });
    const accountHandler = createAccountHandler({
      getService,
      onAccountDeleted: async () => {},
      authLimit: limiter,
      apiLimit: limiter,
      features: () => ({ registration: false, chatRequiresAccount: required }),
    });
    // Заглушка вместо конвейера: видно, что дошло до ассистента.
    const fakeChat = async (req, res) => {
      if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'Метод не поддерживается.' });
        return;
      }
      const body = await readBody(req);
      seen.push({ body, headers: { ...req.headers } });
      respondJson(res, 200, { replyText: 'ok' });
    };
    const chat = withChatAccess(fakeChat, createChatAccessGate({ getService, isRequired: () => required }));
    server = http.createServer((req, res) => (req.url === '/api/chat' ? chat(req, res) : accountHandler(req, res)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server?.close());

  const ask = (cookie) => fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'нужен лор на завтра' }], sessionId: 'session-abcdef123456' }),
  });

  // Вход настоящего пользователя: гостевых демо-аккаунтов нет, аккаунт создаёт администратор.
  const signIn = async (name) => {
    if (!store.getUserByEmail(`${name}@user.ru`)) {
      store.createUser({ id: randomBytes(16).toString('hex'), email: `${name}@user.ru`, firstName: name, lastName: 'Тест', passwordHash: await hashPassword('пароль-пароль'), now: Date.now() });
    }
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: `${name}@user.ru`, password: 'пароль-пароль' }),
    });
    const sessionLine = response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    return `${SESSION_COOKIE}=${parseCookies(sessionLine.split(';')[0])[SESSION_COOKIE]}`;
  };

  it('гость получает 401 login_required, до ассистента запрос не доходит', async () => {
    const before = seen.length;
    const response = await ask();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'login_required');
    const forged = await ask(`${SESSION_COOKIE}=${'x'.repeat(43)}`);
    assert.equal(forged.status, 401);
    assert.equal(seen.length, before);
  });

  it('CSRF: не JSON или с чужого сайта — 403, даже с действующей сессией', async () => {
    const cookie = await signIn('anna');
    const before = seen.length;
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'нужен лор на завтра' }], sessionId: 'session-abcdef123456' });
    const plain = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: base, cookie }, body });
    assert.equal(plain.status, 403);
    const crossSite = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', cookie }, body });
    assert.equal(crossSite.status, 403);
    const foreign = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie }, body });
    assert.equal(foreign.status, 403);
    assert.equal(seen.length, before, 'до ассистента запрос не дошёл');
  });

  it('вошедший проходит; в тело запроса ассистента кабинет ничего не добавляет', async () => {
    const cookie = await signIn('anna');
    const response = await ask(cookie);
    assert.equal(response.status, 200);
    const last = seen.at(-1);
    assert.deepEqual(Object.keys(last.body).sort(), ['messages', 'sessionId']);
    assert.equal(JSON.stringify(last.body).includes('anna'), false);
  });

  it('после выхода та же cookie больше не открывает ассистента', async () => {
    const cookie = await signIn('family');
    assert.equal((await ask(cookie)).status, 200);
    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: '{}' });
    assert.equal((await ask(cookie)).status, 401);
  });

  it('кабинет выключен — 503 accounts_unavailable; флаг выключен — гостю можно', async () => {
    accountsOn = false;
    const off = await ask();
    assert.equal(off.status, 503);
    assert.equal((await off.json()).code, 'accounts_unavailable');
    accountsOn = true;

    required = false;
    assert.equal((await ask()).status, 200);
    const features = await (await fetch(`${base}/api/account`)).json();
    assert.equal(features.features.chatRequiresAccount, false);
    required = true;
  });

  it('OPTIONS и неверный метод уходят обработчику чата без проверки входа', async () => {
    const response = await fetch(`${base}/api/chat`, { method: 'GET' });
    assert.equal(response.status, 405);
  });
});
