/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * HTTP-слой входа и личного кабинета на карте.
 *
 *   GET    /api/account            — кто вошёл, его программа ДМС и избранное
 *   PATCH  /api/account            — имя или программа ДМС
 *   DELETE /api/account            — удалить свой аккаунт (только роль «Пользователь»)
 *   POST   /api/account/favorites  — добавить / убрать / слить избранное
 *   POST   /api/auth/login         — вход по email и паролю
 *   POST   /api/auth/logout        — выход
 * Приглашения, активация и ссылки для смены пароля — в api/activation.js.
 *
 * Публичной регистрации нет: аккаунты создаёт администратор (api/admin.js).
 * Профиль, пароль и сессии — в api/me.js.
 *
 * Сессия — случайный токен в cookie HttpOnly; SameSite=Lax; Path=/api, в базе
 * хранится только его SHA-256. Гостевых демо-аккаунтов нет: вход только по
 * email и паролю. Ассистент доступен только после входа
 * (chatAccess.js), но проверяется лишь факт входа: в конвейер /api/chat не
 * уходят ни email, ни имя, ни программа ДМС, ни избранное.
 */

import { AccountError, normalizeEmail } from '../accounts/service.js';
import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';
import { forgetDemoBookings, getDefaultAccountService, peekAccountContext } from './accountContext.js';
import {
  clientContext, isTrustedWrite, parseCookies, pathOf, readJsonObject, requireSession,
  sendError, SESSION_COOKIE, sessionCookie, tokenOf,
} from './accountHttp.js';

export { getDefaultAccountService, parseCookies, SESSION_COOKIE, sessionCookie };

// Слияние избранного: до 500 id по ~40 символов — с запасом.
const MAX_BODY_BYTES = 64 * 1024;

/*
 * Подбор паролей: 20 попыток входа за 15 минут с адреса.
 * Обычные запросы кабинета — 300 за 5 минут: это сотни нажатий на сердечко.
 */
const defaultAuthLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 20, maxPerInstance: Number.POSITIVE_INFINITY });
const defaultApiLimit = createRateLimiter({ maxPerIp: 300, maxPerInstance: Number.POSITIVE_INFINITY });
// Демо-вход без пароля и без scrypt: зал за одним NAT на питче не должен упираться в лимит входа.

/** Ассистент только для вошедших; CHAT_REQUIRES_ACCOUNT=off открывает его гостям (если не задано в настройках). */
export const chatRequiresAccount = (service = null) => {
  try {
    if (service?.settings) return service.settings.get('assistant.requiresAccount') !== false;
  } catch {
    // Настройки недоступны — действует переменная окружения.
  }
  return process.env.CHAT_REQUIRES_ACCOUNT !== 'off';
};

/*
 * Неудачные входы по email — независимо от адреса: перебор пароля одного
 * аккаунта с тысячи адресов упирается сюда. 10 ошибок за 15 минут — пауза
 * (порог меняется в настройках).
 */
export const createFailureCounter = ({ windowMs = 15 * 60 * 1000, max = null, maxTracked = 10_000, now = () => Date.now() } = {}) => {
  const failures = new Map();
  const fresh = (key) => {
    const list = (failures.get(key) || []).filter((stamp) => now() - stamp < windowMs);
    if (list.length > 0) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  return {
    // Явный max (тесты) важнее порога из настроек; без них — 10.
    blocked: (key, limit = 10) => Boolean(key) && fresh(key).length >= (max ?? limit),
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

const ROUTES = new Map([
  ['/api/account', { GET: 'me', PATCH: 'update', DELETE: 'delete' }],
  ['/api/account/favorites', { POST: 'favorites' }],
  ['/api/auth/login', { POST: 'login' }],
  ['/api/auth/logout', { POST: 'logout' }],
]);

export const ACCOUNT_PATHS = Object.freeze([...ROUTES.keys()]);

const AUTH_OPERATIONS = new Set(['login']);

/** Флаги для интерфейса: что включено на этом сервере. */
const defaultFeatures = (service) => {
  const settings = service?.settings;
  const read = (key, fallback) => {
    try {
      return settings ? settings.get(key) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    registration: false,
    assistant: read('assistant.enabled', true) !== false,
    chatRequiresAccount: chatRequiresAccount(service),
  };
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
  failures = defaultFailures,
  features = defaultFeatures,
  // Письма со ссылками для входа настроены — интерфейс предложит запросить ссылку самому.
  emailLinks = async () => Boolean((await peekAccountContext())?.invitations?.emailEnabled),
} = {}) =>
  async function accountHandler(req, res) {
    // В dev-режиме Vite (connect) отрезает от req.url путь подключения — полный путь в originalUrl.
    const route = ROUTES.get(pathOf(req.originalUrl || req.url));
    const operation = route?.[req.method];
    if (!route || !operation) {
      res.setHeader('Allow', route ? Object.keys(route).join(', ') : 'GET');
      respondJson(res, route ? 405 : 404, { error: route ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }

    const clientIp = getClientIp(req);
    const limiter = AUTH_OPERATIONS.has(operation) ? authLimit : apiLimit;
    const limit = limiter(clientIp);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много попыток. Подождите немного.', code: 'rate_limited' });
      return;
    }

    if (operation !== 'me' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
      return;
    }

    const service = await getService();
    const flags = { available: Boolean(service), ...features(service), emailLinks: service ? await emailLinks() : false };

    if (!service) {
      if (operation === 'me') {
        respondJson(res, 200, { user: null, favorites: [], features: flags });
      } else {
        respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен.', features: flags });
      }
      return;
    }

    const token = tokenOf(req);

    let body = {};
    try {
      if (operation !== 'me' && operation !== 'logout') body = await readJsonObject(req, MAX_BODY_BYTES);
    } catch (error) {
      sendError(res, error);
      return;
    }

    const startSession = (result, status = 200, extraCookies = []) => {
      res.setHeader('Set-Cookie', [sessionCookie(req, result.session.token, result.session.expiresAt), ...extraCookies]);
      respondJson(res, status, { user: result.user, favorites: result.favorites, features: flags });
    };

    try {
      switch (operation) {
        case 'me': {
          const auth = token ? service.authenticate(token) : null;
          if (!auth && token) res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
          respondJson(res, 200, auth ? { ...service.snapshot(auth.user), features: flags } : { user: null, favorites: [], features: flags });
          return;
        }
        case 'login': {
          const emailKey = normalizeEmail(body.email).slice(0, 254);
          if (failures.blocked(emailKey, service.settings.get('auth.maxFailedPerEmail'))) {
            metrics.increment('auth.throttled');
            res.setHeader('Retry-After', '900');
            respondJson(res, 429, { error: 'Много неудачных попыток входа в этот аккаунт. Подождите 15 минут.', code: 'too_many_attempts' });
            return;
          }
          try {
            const result = await service.login({ email: body.email, password: body.password }, clientContext(req));
            failures.clear(emailKey);
            logger.event('account.login', { status: 'ok' });
            metrics.increment('auth.login', { status: 'ok' });
            startSession(result);
          } catch (error) {
            if (error instanceof AccountError && error.code === 'bad_credentials') failures.record(emailKey);
            throw error;
          }
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

      const auth = requireSession(req, res, service);
      if (!auth) return;
      const { user } = auth;

      if (operation === 'update') {
        const allowed = ['displayName', 'firstName', 'lastName', 'dmsPlanId'];
        const extra = Object.keys(body).filter((key) => !allowed.includes(key));
        if (extra.length > 0) {
          respondJson(res, 400, { error: `Недопустимые поля: ${extra.slice(0, 5).join(', ')}.`, code: 'unexpected_field' });
          return;
        }
        respondJson(res, 200, { ...service.updateProfile(user, body), features: flags });
      } else if (operation === 'favorites') {
        respondJson(res, 200, service.updateFavorites(user, body));
      } else if (operation === 'delete') {
        if (body.confirm !== true) {
          respondJson(res, 400, { error: 'Подтвердите удаление.', code: 'confirm_required' });
          return;
        }
        service.deleteAccount(user);
        await onAccountDeleted(user.id);
        logger.event('account.deleted', { status: 'ok' });
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        respondJson(res, 200, { user: null, favorites: [], features: flags });
      }
    } catch (error) {
      if (error instanceof AccountError && operation === 'login') {
        logger.event('account.login', { status: 'failed', code: error.code });
        metrics.increment('auth.login', { status: error.code });
      }
      sendError(res, error);
    }
  };

/** Пользователь кабинета по cookie запроса или null (кабинет выключен, гость, сессия истекла). */
export const currentAccountUser = async (req, getService = getDefaultAccountService) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const service = await getService();
  return service ? service.sessionUser(token) : null;
};

export default createAccountHandler({ getService: getDefaultAccountService });
