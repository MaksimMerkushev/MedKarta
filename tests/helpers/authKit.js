/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общие помощники тестов входа: программный ключ доступа (WebAuthn,
 * ES256, «none»-аттестация — как у настоящего устройства, но ключ в
 * памяти), «браузер» с cookie и сервер со всеми маршрутами кабинета.
 * Только для тестов.
 */

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';

import { createAccountHandler } from '../../backend/api/account.js';
import { createActivationHandler } from '../../backend/api/activation.js';
import { createAdminHandler } from '../../backend/api/admin.js';
import { createChatAccessGate, withChatAccess } from '../../backend/api/chatAccess.js';
import { createMeHandler } from '../../backend/api/me.js';
import { createPrivacyHandler } from '../../backend/api/privacy.js';
import { respondJson } from '../../backend/http/request.js';

export const TEST_ORIGIN = 'https://medkarta.test';
export const unlimited = () => ({ allowed: true });

/* ------------------------------ CBOR (запись) ------------------------------ */

const head = (major, length) => {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(length, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(length, 1);
  return buffer;
};

export const encodeCbor = (value) => {
  if (Number.isInteger(value)) return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encodeCbor)]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])]);
  if (value && typeof value === 'object') return encodeCbor(new Map(Object.entries(value)));
  throw new Error('cbor: unsupported value');
};

const sha256 = (data) => createHash('sha256').update(data).digest();
const b64 = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * Программный ключ доступа. register(options) — ответ на credentials.create,
 * assert(options) — на credentials.get. tamper — испортить подпись,
 * origin/rpId — подставить чужие (проверки фишинга). uv: false — ключ без
 * проверки человека (как старый U2F без PIN): флаг UV не ставится.
 */
export const softAuthenticator = ({ origin = TEST_ORIGIN, rpId = new URL(origin).hostname, uv = true } = {}) => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  let counter = 0;
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);

  return {
    credentialId: b64(credentialId),
    register(options, { overrideOrigin = origin, overrideRpId = rpId } = {}) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: overrideOrigin, crossOrigin: false }));
      const flags = 0x01 | (uv ? 0x04 : 0) | 0x40;
      const signCount = Buffer.alloc(4);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([sha256(overrideRpId), Buffer.from([flags]), signCount, Buffer.alloc(16), idLength, credentialId, encodeCbor(cose)]);
      const attestationObject = encodeCbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: 'public-key',
        response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
      };
    },
    assert(options, { overrideOrigin = origin, overrideRpId = rpId, tamper = false, replayCounter = false, skipUv = !uv } = {}) {
      if (!replayCounter) counter += 1;
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: overrideOrigin, crossOrigin: false }));
      const signCount = Buffer.alloc(4);
      signCount.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(overrideRpId), Buffer.from([0x01 | (skipUv ? 0 : 0x04)]), signCount]);
      let signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), privateKey);
      if (tamper) signature = Buffer.concat([signature.subarray(0, -1), Buffer.from([signature[signature.length - 1] ^ 1])]);
      return {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: 'public-key',
        response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature), userHandle: null },
      };
    },
  };
};

/* --------------------------------- сервер --------------------------------- */

/** Сервер со всеми маршрутами кабинета поверх одного контекста. */
export const startAuthServer = async (context, { authLimit = unlimited, activationLimit = unlimited, requestLimit = unlimited, emailWindow = () => true, chatHandler = null } = {}) => {
  const getService = async () => context.accounts;
  const getContext = async () => context;
  const accountHandler = createAccountHandler({
    getService, getContext, onAccountDeleted: async () => {}, authLimit, apiLimit: unlimited,
    emailLinks: async () => context.invitations.emailEnabled,
  });
  const meHandler = createMeHandler({ getContext, apiLimit: unlimited, passwordLimit: unlimited });
  const adminHandler = createAdminHandler({ getContext, limit: unlimited, systemInfo: async () => ({ components: [], process: { nodeVersion: process.version } }) });
  const activationHandler = createActivationHandler({ getContext, activationLimit, requestLimit, emailWindow });
  const chat = withChatAccess(
    chatHandler || (async (req, res) => respondJson(res, 200, { replyText: 'ok' })),
    createChatAccessGate({ getService, getPass: async () => context.assistantPass }),
  );
  const privacyHandler = createPrivacyHandler({ getContext, getDocuments: () => context.documents, limit: unlimited });
  const server = http.createServer((req, res) => {
    const url = req.url;
    if (url.startsWith('/api/admin')) return adminHandler(req, res);
    if (url === '/api/me' || url.startsWith('/api/me/') || url.startsWith('/api/me?')) return meHandler(req, res);
    if (url.startsWith('/api/auth/activation') || url === '/api/auth/access-link' || url.startsWith('/api/auth/register') || url.startsWith('/api/auth/email-change')) return activationHandler(req, res);
    if (url === '/api/chat') return chat(req, res);
    if (url.startsWith('/api/legal') || url.startsWith('/api/privacy')) return privacyHandler(req, res);
    return accountHandler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

/** «Браузер»: свой набор cookie, Origin своего сайта, JSON. */
export const browserFor = (base) => {
  const jar = new Map();
  const cookies = [];
  const call = async (urlPath, { method = 'GET', body, headers = {}, raw = false } = {}) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        origin: base,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const line of response.headers.getSetCookie()) {
      cookies.push(line);
      const [pair] = line.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (/Max-Age=0/i.test(line) || !value) jar.delete(name);
      else jar.set(name, value);
    }
    if (raw) return response;
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  const browser = {
    jar,
    cookies,
    call,
    // Пароль последнего входа — для подтверждения личности в тестах (reauth).
    password: null,
    login: (email, password) => {
      browser.password = password;
      return call('/api/auth/login', { method: 'POST', body: { email, password } });
    },
    /** Подтвердить личность: пароль и — если у аккаунта есть факторы — ключ доступа authenticator. */
    async reauth(authenticator = null, password = browser.password) {
      const options = await call('/api/me/reauth/options', { method: 'POST', body: {} });
      assert.equal(options.status, 200, JSON.stringify(options.body));
      const body = { password };
      if (options.body.methods.length > 0) {
        assert.ok(authenticator && options.body.passkey, 'для подтверждения нужен ключ доступа');
        Object.assign(body, { method: 'webauthn', credential: authenticator.assert(options.body.passkey) });
      }
      const done = await call('/api/me/reauth', { method: 'POST', body });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      return done;
    },
    logout: () => call('/api/auth/logout', { method: 'POST', body: {} }),
    /** Пропуск к ассистенту (cookie mk_ai) по текущей сессии. */
    chatPass: () => call('/api/account/assistant-pass', { method: 'POST', body: {} }),
    /** Второй шаг входа ключом доступа. */
    async passkeyStep(authenticator, overrides = {}) {
      const options = await call('/api/auth/mfa/options', { method: 'POST', body: {} });
      assert.equal(options.status, 200, JSON.stringify(options.body));
      assert.ok(options.body.passkey, 'ожидались параметры ключа доступа');
      return call('/api/auth/mfa/verify', { method: 'POST', body: { method: 'webauthn', credential: authenticator.assert(options.body.passkey, overrides) } });
    },
    /** Вход сотрудника: пароль и (если нужно) ключ доступа. */
    async signIn(email, password, authenticator = null) {
      const first = await browser.login(email, password);
      browser.password = password;
      if (first.status !== 200 || !first.body?.mfaRequired) return first;
      assert.ok(authenticator, 'нужен ключ доступа');
      return browser.passkeyStep(authenticator);
    },
    /**
     * Добавить ключ доступа к своему аккаунту. Нужна свежая проверка
     * личности: если её нет — сначала reauth (паролем последнего входа и,
     * если факторы уже есть, ключом confirmWith).
     */
    async enrollPasskey(authenticator, label = 'Тестовый ключ', { confirmWith = null } = {}) {
      let started = await call('/api/me/mfa/passkey', { method: 'POST', body: {} });
      if (started.status === 403 && started.body?.code === 'reauth_required') {
        await browser.reauth(confirmWith);
        started = await call('/api/me/mfa/passkey', { method: 'POST', body: {} });
      }
      assert.equal(started.status, 200, JSON.stringify(started.body));
      const finished = await call('/api/me/mfa/passkey/finish', { method: 'POST', body: { credential: authenticator.register(started.body.publicKey), label } });
      assert.equal(finished.status, 200, JSON.stringify(finished.body));
      return finished.body;
    },
  };
  return browser;
};

export const tokenOfLink = (link) => new URL(link).hash.replace(/^#token=/, '');
export const linkIn = (text) => String(text).match(/https?:\/\/\S+#token=[A-Za-z0-9_-]{43}/)?.[0] || null;

/** Учебная почта: письма складываются в массив (транспорт подменён). */
export const capture = (outbox) => async ({ to, content }) => {
  outbox.push({ to, subject: content.subject, text: content.text, html: content.html });
};

/**
 * Отметка «принимаю соглашение» с редакциями, которые показала страница
 * (context.legal или context.documents), — как её отправляет интерфейс.
 */
export const legalAcceptance = (context) => {
  const source = context?.legal?.documents || context?.documents || null;
  if (!source) return {};
  const documents = {};
  for (const [key, value] of Object.entries(source)) documents[key] = value.version;
  return { acceptTerms: true, documents };
};

/** Пройти ссылку-приглашение в новом браузере: подтвердить и задать пароль (и принять соглашение, если нужно). */
export const acceptLink = async (base, link, password) => {
  const tab = browserFor(base);
  const token = tokenOfLink(link);
  const peek = await tab.call('/api/auth/activation/peek', { method: 'POST', body: { token } });
  assert.equal(peek.status, 200, JSON.stringify(peek.body));
  const started = await tab.call('/api/auth/activation/start', { method: 'POST', body: { token } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const legal = started.body.context.legal ? legalAcceptance(started.body.context) : {};
  const done = await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password, ...legal } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return { tab, user: done.body.user };
};
