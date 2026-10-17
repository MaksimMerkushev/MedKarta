/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * HTTP-слой личного кабинета.
 *
 *   GET    /api/account            — кто вошёл, его программа ДМС и избранное
 *   PATCH  /api/account            — имя или программа ДМС
 *   DELETE /api/account            — удалить аккаунт со всеми данными
 *   POST   /api/account/favorites  — добавить / убрать / слить избранное
 *   POST   /api/auth/login         — вход по email и паролю
 *   POST   /api/auth/register      — регистрация (если ACCOUNTS_REGISTRATION=on)
 *   POST   /api/auth/demo          — вход в демо-аккаунт (если DEMO_DATA=on)
 *   POST   /api/auth/logout        — выход
 *
 * Сессия — случайный токен в cookie HttpOnly; SameSite=Lax; Path=/api, в базе
 * хранится только его SHA-256. Cookie mk_demo с теми же флагами связывает
 * браузер с его копиями демо-аккаунтов. С ассистентом кабинет не связан: в
 * /api/chat не уходят ни email, ни имя, ни программа ДМС, ни избранное.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoInsurance } from '../../data/demo/insurance.js';
import { AccountError, createAccountService, DEMO_ACCOUNTS, normalizeEmail } from '../accounts/service.js';
import { createSqliteAccountStore, loadSqlite } from '../accounts/sqliteStore.js';
import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { createRateLimiter, getClientIp, isFromTrustedProxy } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SESSION_COOKIE = 'mk_session';
export const DEMO_OWNER_COOKIE = 'mk_demo';
const DEMO_OWNER_MAX_AGE_S = 30 * 24 * 60 * 60;
// Слияние избранного: до 500 id по ~40 символов — с запасом.
const MAX_BODY_BYTES = 64 * 1024;

const KNOWN_PLANS = new Set((demoInsurance?.plans || []).map((plan) => plan.id));

/*
 * Подбор паролей: 20 попыток входа и регистрации за 15 минут с адреса.
 * Обычные запросы кабинета — 300 за 5 минут: это сотни нажатий на сердечко.
 */
const defaultAuthLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 20, maxPerInstance: Number.POSITIVE_INFINITY });
const defaultApiLimit = createRateLimiter({ maxPerIp: 300, maxPerInstance: Number.POSITIVE_INFINITY });
// Демо-вход без пароля и без scrypt: зал за одним NAT на питче не должен упираться в лимит входа.
const defaultDemoLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 200, maxPerInstance: Number.POSITIVE_INFINITY });

/*
 * Неудачные входы по email — независимо от адреса: перебор пароля одного
 * аккаунта с тысячи адресов упирается сюда. 10 ошибок за 15 минут — пауза.
 */
export const createFailureCounter = ({ windowMs = 15 * 60 * 1000, max = 10, maxTracked = 10_000, now = () => Date.now() } = {}) => {
  const failures = new Map();
  const fresh = (key) => {
    const list = (failures.get(key) || []).filter((stamp) => now() - stamp < windowMs);
    if (list.length > 0) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  return {
    blocked: (key) => Boolean(key) && fresh(key).length >= max,
    record(key) {
      if (!key) return;
      const list = fresh(key);
      list.push(now());
      failures.delete(key);
      failures.set(key, list);
      while (failures.size > maxTracked) failures.delete(failures.keys().next().value);
    },
    clear: (key) => failures.delete(key),
  };
};
const defaultFailures = createFailureCounter();

export const parseCookies = (header) => {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
};

/*
 * Secure у cookie: при NODE_ENV=production — всегда, сайт работает только по
 * HTTPS. Иначе — по соединению или по X-Forwarded-Proto, но только от нашего
 * прокси: этот заголовок может прислать кто угодно.
 */
const isSecureRequest = (req) => {
  if (process.env.COOKIE_SECURE === 'on') return true;
  if (process.env.COOKIE_SECURE === 'off') return false;
  if (process.env.NODE_ENV === 'production') return true;
  if (req.socket?.encrypted) return true;
  return isFromTrustedProxy(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
};

const cookie = (req, name, value, maxAgeSeconds) => {
  const parts = [`${name}=${value}`, 'Path=/api', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
};

export const sessionCookie = (req, token, expiresAt) =>
  cookie(req, SESSION_COOKIE, token, token ? (expiresAt - Date.now()) / 1000 : 0);

/*
 * CSRF — в три слоя: SameSite=Lax у cookie, обязательный Content-Type:
 * application/json (с чужого сайта такой запрос требует предварительного
 * разрешения, которого мы не даём) и проверка Origin / Sec-Fetch-Site.
 */
const isTrustedWrite = (req) => {
  if (!verifyOrigin(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
};

const ROUTES = new Map([
  ['/api/account', { GET: 'me', PATCH: 'update', DELETE: 'delete' }],
  ['/api/account/favorites', { POST: 'favorites' }],
  ['/api/auth/login', { POST: 'login' }],
  ['/api/auth/register', { POST: 'register' }],
  ['/api/auth/demo', { POST: 'demo' }],
  ['/api/auth/logout', { POST: 'logout' }],
]);

export const ACCOUNT_PATHS = Object.freeze([...ROUTES.keys()]);

const AUTH_OPERATIONS = new Set(['login', 'register', 'demo']);

const pathOf = (url) => {
  const raw = String(url || '');
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
};

/*
 * Удалённый аккаунт отвязывается от своих демо-записей: записи остаются
 * занятыми слотами, но больше ни с кем не связаны.
 */
const forgetDemoBookings = async (userId) => {
  const { getDefaultDemoBookingService } = await import('./demoBooking.js');
  const service = await getDefaultDemoBookingService();
  service?.store.forgetAccount(userId);
};

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.getService сервис кабинета или null, если он выключен
 * @param {(userId: string) => Promise<void>} [deps.onAccountDeleted]
 */
export const createAccountHandler = ({
  getService,
  onAccountDeleted = forgetDemoBookings,
  authLimit = defaultAuthLimit,
  apiLimit = defaultApiLimit,
  demoLimit = defaultDemoLimit,
  failures = defaultFailures,
  features = () => ({ registration: process.env.ACCOUNTS_REGISTRATION === 'on', demo: process.env.DEMO_DATA === 'on' }),
} = {}) =>
  async function accountHandler(req, res) {
    // В dev-режиме Vite (connect) отрезает от req.url путь подключения — полный путь в originalUrl.
    const route = ROUTES.get(pathOf(req.originalUrl || req.url));
    const operation = route?.[req.method];
    if (!route || !operation) {
      res.setHeader('Allow', route ? Object.keys(route).join(', ') : 'GET');
      respondJson(res, 405, { error: 'Метод не поддерживается.' });
      return;
    }

    const clientIp = getClientIp(req);
    const limiter = operation === 'demo' ? demoLimit : AUTH_OPERATIONS.has(operation) ? authLimit : apiLimit;
    const limit = limiter(clientIp);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много попыток. Подождите немного.' });
      return;
    }

    if (operation !== 'me' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.' });
      return;
    }

    const service = await getService();
    const flags = { available: Boolean(service), ...features() };
    // Кнопки «Войти как …»: только имя и описание программы, без email.
    flags.demoAccounts = flags.available && flags.demo
      ? DEMO_ACCOUNTS.map(({ key, displayName, note }) => ({ key, displayName, note }))
      : [];

    if (!service) {
      if (operation === 'me') {
        respondJson(res, 200, { user: null, favorites: [], features: flags });
      } else {
        respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен.', features: flags });
      }
      return;
    }

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';

    let body = {};
    if (operation !== 'me' && operation !== 'logout') {
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        respondJson(res, error.status || 400, { error: 'Некорректный запрос.' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        respondJson(res, 400, { error: 'Некорректный запрос.' });
        return;
      }
    }

    const startSession = (result, status = 200, extraCookies = []) => {
      res.setHeader('Set-Cookie', [sessionCookie(req, result.session.token, result.session.expiresAt), ...extraCookies]);
      respondJson(res, status, { user: result.user, favorites: result.favorites, features: flags });
    };

    try {
      switch (operation) {
        case 'me': {
          const user = service.sessionUser(token);
          if (!user && token) res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
          respondJson(res, 200, user ? { ...service.snapshot(user), features: flags } : { user: null, favorites: [], features: flags });
          return;
        }
        case 'login': {
          const emailKey = normalizeEmail(body.email);
          if (failures.blocked(emailKey)) {
            res.setHeader('Retry-After', '900');
            respondJson(res, 429, { error: 'Много неудачных попыток входа в этот аккаунт. Подождите 15 минут.', code: 'too_many_attempts' });
            return;
          }
          try {
            const result = await service.login(body);
            failures.clear(emailKey);
            logger.event('account.login', { status: 'ok' });
            startSession(result);
          } catch (error) {
            if (error instanceof AccountError && error.code === 'bad_credentials') failures.record(emailKey);
            throw error;
          }
          return;
        }
        case 'register': {
          if (!flags.registration) {
            respondJson(res, 403, { error: 'Регистрация пока закрыта — попробуйте демо-аккаунт.' });
            return;
          }
          const result = await service.register(body);
          logger.event('account.register', { status: 'ok' });
          startSession(result, 201);
          return;
        }
        case 'demo': {
          if (!flags.demo) {
            respondJson(res, 403, { error: 'Демо-аккаунты выключены на этом сервере.' });
            return;
          }
          const result = service.demoLogin(body.account, { owner: parseCookies(req.headers.cookie)[DEMO_OWNER_COOKIE] });
          startSession(result, 200, [cookie(req, DEMO_OWNER_COOKIE, result.owner, DEMO_OWNER_MAX_AGE_S)]);
          return;
        }
        case 'logout': {
          service.logout(token);
          res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
          respondJson(res, 200, { user: null, favorites: [], features: flags });
          return;
        }
        default:
          break;
      }

      const user = service.sessionUser(token);
      if (!user) {
        respondJson(res, 401, { error: 'Войдите в личный кабинет.' });
        return;
      }

      if (operation === 'update') {
        respondJson(res, 200, { ...service.updateProfile(user, body), features: flags });
      } else if (operation === 'favorites') {
        respondJson(res, 200, service.updateFavorites(user, body));
      } else if (operation === 'delete') {
        if (body.confirm !== true) {
          respondJson(res, 400, { error: 'Подтвердите удаление.' });
          return;
        }
        service.deleteAccount(user);
        try {
          await onAccountDeleted(user.id);
        } catch (error) {
          logger.error('account.forget_bookings_failed', error);
        }
        logger.event('account.deleted', { status: 'ok' });
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        respondJson(res, 200, { user: null, favorites: [], features: flags });
      }
    } catch (error) {
      if (error instanceof AccountError) {
        if (operation === 'login') logger.event('account.login', { status: 'failed', code: error.code });
        respondJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  };

/*
 * SQLite-файл в var/accounts/ открывается при первом запросе к кабинету. Без
 * node:sqlite (Node < 22.13) или при ACCOUNTS=off кабинет выключен, а
 * остальной сайт работает.
 */
let defaultService;

export const getDefaultAccountService = async () => {
  if (defaultService !== undefined) return defaultService;
  defaultService = (async () => {
    if (process.env.ACCOUNTS === 'off') return null;
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      logger.warn('account.unavailable', { reason: 'node_sqlite_missing' });
      return null;
    }
    try {
      const store = createSqliteAccountStore({
        DatabaseSync,
        file: process.env.ACCOUNTS_DB_PATH || path.join(ROOT, 'var', 'accounts', 'medkarta.sqlite'),
      });
      const service = createAccountService({ store, isKnownPlan: (planId) => KNOWN_PLANS.has(planId) });
      service.purgeExpiredSessions();
      return service;
    } catch (error) {
      logger.error('account.store_failed', error);
      return null;
    }
  })();
  return defaultService;
};

/** Пользователь кабинета по cookie запроса или null (кабинет выключен, гость, сессия истекла). */
export const currentAccountUser = async (req, getService = getDefaultAccountService) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const service = await getService();
  return service ? service.sessionUser(token) : null;
};

export default createAccountHandler({ getService: getDefaultAccountService });
