/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ассистент только для вошедших, но без связи с аккаунтом: /api/chat
 * проверяет пропуск (cookie mk_ai без id аккаунта, api/assistantPass.js), а
 * сессию не читает вовсе. Гость получает 401 assistant_pass_required,
 * вошедший получает пропуск отдельным запросом и проходит к обработчику
 * чата, в который не уходит ничего из кабинета. Кабинет — настоящий (SQLite
 * в памяти и http-сервер), вместо конвейера ассистента — заглушка.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';

import { hashPassword } from '../backend/accounts/passwords.js';
import { createAccountService } from '../backend/accounts/service.js';
import { createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountHandler, parseCookies, SESSION_COOKIE } from '../backend/api/account.js';
import { ASSISTANT_PASS_COOKIE, createAssistantPass } from '../backend/api/assistantPass.js';
import { createChatAccessGate, withChatAccess } from '../backend/api/chatAccess.js';
import { readBody, respondJson } from '../backend/http/request.js';
import { createRateLimiter } from '../backend/http/rateLimit.js';

const DatabaseSync = await loadSqlite();
const PLANS = new Set(['demo-basic', 'demo-standard', 'demo-premium']);

describe('Ассистент только после входа — и без связи с аккаунтом', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  let server;
  let base;
  let required = true;
  let accountsOn = true;
  let store;
  let authenticateCalls = 0;
  const clock = { t: Date.now() };
  const pass = createAssistantPass({ key: randomBytes(32), now: () => clock.t });
  const seen = [];

  before(async () => {
    store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const service = createAccountService({ store, isKnownPlan: (id) => PLANS.has(id) });
    // Счётчик проверок сессии: во время запросов к ассистенту он не должен расти.
    const counted = {
      ...service,
      authenticate: (...args) => {
        authenticateCalls += 1;
        return service.authenticate(...args);
      },
    };
    const getService = async () => (accountsOn ? counted : null);
    const limiter = createRateLimiter({ windowMs: 60_000, maxPerIp: 10_000, maxPerInstance: Number.POSITIVE_INFINITY });
    const accountHandler = createAccountHandler({
      getService,
      getContext: async () => (accountsOn ? { assistantPass: pass } : null),
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
    const gate = createChatAccessGate({ getService, isRequired: () => required, getPass: async () => (accountsOn ? pass : null) });
    const chat = withChatAccess(fakeChat, gate);
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
  const signIn = async (name, { mustChangePassword = false } = {}) => {
    if (!store.getUserByEmail(`${name}@user.ru`)) {
      store.createUser({
        id: randomBytes(16).toString('hex'), email: `${name}@user.ru`, firstName: name, lastName: 'Тест', passwordHash: await hashPassword('пароль-пароль'),
        mustChangePassword, now: Date.now(),
      });
    }
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: `${name}@user.ru`, password: 'пароль-пароль' }),
    });
    const sessionLine = response.headers.getSetCookie().find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    return `${SESSION_COOKIE}=${parseCookies(sessionLine.split(';')[0])[SESSION_COOKIE]}`;
  };

  /** Пропуск к ассистенту по сессии: {status, cookie, setCookie}. */
  const getPass = async (cookie) => {
    const response = await fetch(`${base}/api/account/assistant-pass`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: '{}',
    });
    const line = response.headers.getSetCookie().find((item) => item.startsWith(`${ASSISTANT_PASS_COOKIE}=`));
    return { status: response.status, body: await response.json(), setCookie: line || null, cookie: line ? line.split(';')[0] : null };
  };

  it('гость получает 401 assistant_pass_required, до ассистента запрос не доходит; поддельный пропуск — тоже 401', async () => {
    const before = seen.length;
    const response = await ask();
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'assistant_pass_required');
    assert.equal((await ask(`${SESSION_COOKIE}=${'x'.repeat(43)}`)).status, 401);
    assert.equal((await ask(`${ASSISTANT_PASS_COOKIE}=${'A'.repeat(27)}.${'B'.repeat(43)}`)).status, 401);
    assert.equal((await getPass(null)).status, 401, 'без сессии пропуск не выдаётся');
    assert.equal(seen.length, before);
  });

  it('пропуск: только для /api/chat, HttpOnly, SameSite=Strict, на час; в нём нет id и email аккаунта', async () => {
    const cookie = await signIn('olga');
    const issued = await getPass(cookie);
    assert.equal(issued.status, 200);
    assert.match(issued.setCookie, /Path=\/api\/chat/);
    assert.match(issued.setCookie, /HttpOnly/);
    assert.match(issued.setCookie, /SameSite=Strict/);
    assert.match(issued.setCookie, /Max-Age=3600/);
    const token = issued.cookie.split('=')[1];
    const user = store.getUserByEmail('olga@user.ru');
    const decoded = Buffer.from(token.split('.')[0], 'base64url');
    assert.equal(decoded.length, 20, 'срок и случайное число — и ничего больше');
    assert.equal(token.includes(user.id) || decoded.toString('hex').includes(user.id) || token.includes('olga'), false);
  });

  it('CSRF: не JSON или с чужого сайта — 403, даже с действующим пропуском', async () => {
    const { cookie } = await getPass(await signIn('anna'));
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

  it('с пропуском проходит без сессии; сессия при запросе к ассистенту не проверяется; в тело ничего из кабинета не добавляется', async () => {
    const session = await signIn('anna');
    const { cookie } = await getPass(session);
    const callsBefore = authenticateCalls;
    const onlyPass = await ask(cookie);
    assert.equal(onlyPass.status, 200);
    const both = await ask(`${session}; ${cookie}`);
    assert.equal(both.status, 200);
    assert.equal(authenticateCalls, callsBefore, 'сервер не узнаёт, чей это запрос');
    const last = seen.at(-1);
    assert.deepEqual(Object.keys(last.body).sort(), ['messages', 'sessionId']);
    assert.equal(JSON.stringify(last.body).includes('anna'), false);
  });

  it('выход стирает cookie пропуска; пропуск истекает через час', async () => {
    const session = await signIn('family');
    const { cookie } = await getPass(session);
    assert.equal((await ask(cookie)).status, 200);
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie: `${session}; ${cookie}` }, body: '{}' });
    const cleared = logout.headers.getSetCookie().find((line) => line.startsWith(`${ASSISTANT_PASS_COOKIE}=`));
    assert.match(cleared, /Max-Age=0/);
    assert.match(cleared, /Path=\/api\/chat/);
    clock.t += 61 * 60 * 1000;
    assert.equal((await ask(cookie)).status, 401, 'истёкший пропуск не действует');
    clock.t = Date.now();
  });

  it('временный пароль не сменён — пропуск не выдаётся (403 password_change_required)', async () => {
    const session = await signIn('legacy', { mustChangePassword: true });
    const denied = await getPass(session);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'password_change_required');
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
