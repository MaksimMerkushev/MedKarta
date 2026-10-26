/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * HTTP-слой входа и личного кабинета на карте.
 *
 *   GET    /api/account            — кто вошёл, его программа ДМС и избранное
 *   PATCH  /api/account            — имя или программа ДМС
 *   DELETE /api/account            — удалить свой аккаунт (только роль «Пользователь»)
 *   POST   /api/account/favorites  — добавить / убрать / слить избранное
 *   POST   /api/auth/login         — вход по email и паролю; если включён второй
 *                                     фактор — {mfaRequired} и cookie второго шага
 *   POST   /api/auth/mfa/options   — способы второго шага и вызов для ключа доступа
 *   POST   /api/auth/mfa/verify    — второй шаг: код, резервный код или ключ доступа
 *   POST   /api/auth/logout        — выход
 * Регистрация, приглашения, активация, ссылки для смены пароля и
 * подтверждение нового email — в api/activation.js.
 * Профиль, пароль, факторы входа и сессии — в api/me.js.
 *
 * Сессия — случайный токен в cookie HttpOnly (__Host-mk_sid по HTTPS),
 * SameSite=Lax; в базе хранится только его SHA-256. Гостевых демо-аккаунтов
 * нет: вход только по email и паролю. Ассистент доступен только после входа
 * (chatAccess.js), но проверяется лишь факт входа: в конвейер /api/chat не
 * уходят ни email, ни имя, ни программа ДМС, ни избранное.
 */

import { AccountError } from '../accounts/service.js';
import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';
import { forgetDemoBookings, getDefaultAccountService, peekAccountContext } from './accountContext.js';
import { ASSISTANT_PASS_COOKIE, ASSISTANT_PASS_PATH } from './assistantPass.js';
import {
  clientContext, cookie, ensureDevice, isTrustedWrite, legacyCookieClear, mfaCookie, mfaTokenOf, parseCookies, pathOf, readJsonObject, requireFresh,
  requireSession, sendError, SESSION_COOKIE, sessionCookie, tokenOf,
} from './accountHttp.js';

export { getDefaultAccountService, parseCookies, SESSION_COOKIE, sessionCookie };

// Слияние избранного: до 500 id по ~40 символов — с запасом.
const MAX_BODY_BYTES = 64 * 1024;

/*
 * Быстрый лимит в памяти — 20 попыток входа за 15 минут с адреса; основной,
 * переживающий перезапуск, — в базе (accounts/throttle.js: адрес, аккаунт,
 * пара «адрес + аккаунт», устройство).
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

const ROUTES = new Map([
  ['/api/account', { GET: 'me', PATCH: 'update', DELETE: 'delete' }],
  ['/api/account/favorites', { POST: 'favorites' }],
  // Пропуск к ассистенту без id аккаунта (api/assistantPass.js).
  ['/api/account/assistant-pass', { POST: 'assistantPass' }],
  ['/api/auth/login', { POST: 'login' }],
  ['/api/auth/mfa/options', { POST: 'mfaOptions' }],
  ['/api/auth/mfa/verify', { POST: 'mfaVerify' }],
  ['/api/auth/logout', { POST: 'logout' }],
]);

export const ACCOUNT_PATHS = Object.freeze([...ROUTES.keys()]);

const AUTH_OPERATIONS = new Set(['login', 'mfaVerify']);
// Второй шаг: тело — код или ответ ключа доступа (до нескольких КБ).
const MFA_BODY_BYTES = 16 * 1024;

/** Флаги для интерфейса: что включено на этом сервере. */
const defaultFeatures = (service, context = null) => {
  const settings = service?.settings;
  const read = (key, fallback) => {
    try {
      return settings ? settings.get(key) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    registration: Boolean(context?.registration?.enabled),
    registrationMode: context?.registration?.mode || 'invite_only',
    // Почему регистрация закрыта (invite_only | mail_disabled | legal_unavailable | legal_documents_incomplete) — для текста на странице.
    registrationClosed: context?.registration ? context.registration.closedReason : 'invite_only',
    passkeys: Boolean(service?.mfa?.passkeysAvailable),
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
  getContext = peekAccountContext,
  onAccountDeleted = forgetDemoBookings,
  authLimit = defaultAuthLimit,
  apiLimit = defaultApiLimit,
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
    const context = await getContext().catch(() => null);
    const flags = { available: Boolean(service), ...features(service, context), emailLinks: service ? await emailLinks() : false };

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
      if (operation !== 'me' && operation !== 'logout') body = await readJsonObject(req, operation === 'mfaVerify' ? MFA_BODY_BYTES : MAX_BODY_BYTES);
    } catch (error) {
      sendError(res, error);
      return;
    }

    const startSession = (result, status = 200, extraCookies = []) => {
      res.setHeader('Set-Cookie', [sessionCookie(req, result.session.token, result.session.expiresAt), ...extraCookies, ...legacyCookieClear(req)]);
      respondJson(res, status, { user: result.user, favorites: result.favorites, security: result.security, features: flags });
    };

    try {
      switch (operation) {
        case 'me': {
          const auth = token ? service.authenticate(token) : null;
          const clears = [...(!auth && token ? [sessionCookie(req, '', 0)] : []), ...legacyCookieClear(req)];
          if (clears.length > 0) res.setHeader('Set-Cookie', clears);
          // Документы, которые аккаунт «Пользователь» ещё не принял в действующей редакции (интерфейс попросит принять).
          const legalPending = auth && context?.consents ? context.consents.pendingFor(auth.user) : [];
          respondJson(res, 200, auth ? { ...service.snapshot(auth.user, auth.session), legalPending, features: flags } : { user: null, favorites: [], features: flags });
          return;
        }
        case 'login': {
          // Устройство: если cookie ещё нет — выдаём; по ней владелец не попадёт под чужие блокировки.
          const device = ensureDevice(req);
          const deviceCookies = device.setCookie ? [device.setCookie] : [];
          try {
            const result = await service.login({ email: body.email, password: body.password }, clientContext(req, { deviceToken: device.token }));
            if (result.mfaRequired) {
              const seconds = Math.max(1, Math.floor((result.expiresAt - Date.now()) / 1000));
              res.setHeader('Set-Cookie', [mfaCookie(req, result.challengeToken, seconds), ...deviceCookies]);
              logger.event('account.login', { status: 'mfa_required' });
              metrics.increment('auth.login', { status: 'mfa_required' });
              respondJson(res, 200, { mfaRequired: true, methods: result.methods, expiresAt: new Date(result.expiresAt).toISOString(), features: flags });
              return;
            }
            logger.event('account.login', { status: 'ok' });
            metrics.increment('auth.login', { status: 'ok' });
            startSession(result, 200, deviceCookies);
          } catch (error) {
            if (deviceCookies.length > 0) res.setHeader('Set-Cookie', deviceCookies);
            if (error instanceof AccountError && error.code === 'too_many_attempts') metrics.increment('auth.throttled');
            throw error;
          }
          return;
        }
        case 'mfaOptions': {
          respondJson(res, 200, service.mfaLoginOptions(mfaTokenOf(req)));
          return;
        }
        case 'mfaVerify': {
          const extra = Object.keys(body).filter((key) => !['method', 'code', 'credential'].includes(key));
          if (extra.length > 0 || !['totp', 'recovery', 'webauthn'].includes(body.method)) {
            respondJson(res, 400, { error: 'Некорректный запрос.', code: 'bad_request' });
            return;
          }
          try {
            const result = await service.completeMfaLogin(mfaTokenOf(req), { method: body.method, code: body.code, credential: body.credential }, clientContext(req));
            // В этом браузере мог быть вход в другой аккаунт — та сессия завершается.
            const previous = tokenOf(req);
            if (previous) service.logout(previous);
            logger.event('account.login', { status: 'ok', action: 'mfa' });
            metrics.increment('auth.login', { status: 'ok_mfa' });
            res.setHeader('Set-Cookie', [sessionCookie(req, result.session.token, result.session.expiresAt), mfaCookie(req, '', 0), ...legacyCookieClear(req)]);
            respondJson(res, 200, { user: result.user, favorites: result.favorites, security: result.security, recoveryCodesLeft: result.recoveryCodesLeft, features: flags });
          } catch (error) {
            if (error instanceof AccountError && error.code === 'mfa_expired') res.setHeader('Set-Cookie', mfaCookie(req, '', 0));
            throw error;
          }
          return;
        }
        case 'logout': {
          service.logout(token);
          res.setHeader('Set-Cookie', [
            sessionCookie(req, '', 0), mfaCookie(req, '', 0), cookie(req, ASSISTANT_PASS_COOKIE, '', 0, { path: ASSISTANT_PASS_PATH, sameSite: 'Strict' }),
            ...legacyCookieClear(req),
          ]);
          respondJson(res, 200, { user: null, favorites: [], features: flags });
          return;
        }
        default:
          break;
      }

      const auth = requireSession(req, res, service);
      if (!auth) return;
      const { user } = auth;

      if (operation === 'assistantPass') {
        // Пропуск без id аккаунта: дальше /api/chat проверяет только его подпись и срок. Выдача нигде не записывается.
        if (!context?.assistantPass) {
          respondJson(res, 503, { error: 'Ассистент сейчас недоступен.', code: 'accounts_unavailable' });
          return;
        }
        res.setHeader('Set-Cookie', cookie(req, ASSISTANT_PASS_COOKIE, context.assistantPass.issue(), context.assistantPass.ttlMs / 1000, {
          path: ASSISTANT_PASS_PATH, sameSite: 'Strict',
        }));
        respondJson(res, 200, { ok: true, expiresIn: Math.floor(context.assistantPass.ttlMs / 1000) });
        return;
      }

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
        // Удаление аккаунта — критическое действие: нужен свежий пароль (и второй фактор, если включён).
        if (!requireFresh(res, auth, service)) return;
        service.deleteAccount(user);
        await onAccountDeleted(user.id);
        logger.event('account.deleted', { status: 'ok' });
        res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
        respondJson(res, 200, { user: null, favorites: [], features: flags });
      }
    } catch (error) {
      if (error instanceof AccountError && (operation === 'login' || operation === 'mfaVerify')) {
        logger.event('account.login', { status: 'failed', code: error.code });
        metrics.increment('auth.login', { status: error.code });
      }
      sendError(res, error);
    }
  };

/** Пользователь кабинета по cookie запроса или null (кабинет выключен, гость, сессия истекла). */
export const currentAccountUser = async (req, getService = getDefaultAccountService) => {
  const token = tokenOf(req);
  if (!token) return null;
  const service = await getService();
  return service ? service.sessionUser(token) : null;
};

export default createAccountHandler({ getService: getDefaultAccountService });
