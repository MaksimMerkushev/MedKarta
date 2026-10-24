/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * HTTP-слой приглашений и ссылок для входа (логика — accounts/invitations.js).
 *
 *   POST /api/auth/access-link          — «нет пароля / забыл пароль»: ссылка на почту.
 *                                         Ответ одинаков для любого адреса (202).
 *   POST /api/auth/activation/peek      — что за ссылка: имя, email маской, срок.
 *                                         Ничего не меняет.
 *   POST /api/auth/activation/start     — подтвердить ссылку: токен гаснет, ставится
 *                                         cookie контекста на 30 минут.
 *   GET  /api/auth/activation           — контекст по cookie (после перезагрузки).
 *   POST /api/auth/activation/complete  — задать пароль: аккаунт активирован, вход.
 *
 * Токен приходит только в теле POST: в адресе запроса, журналах и Referer
 * его нет. Cookie контекста — HttpOnly; SameSite=Strict; Path=/api/auth/activation.
 */

import { AccountError, normalizeEmail } from '../accounts/service.js';
import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';
import { getAccountContext } from './accountContext.js';
import {
  clientContext, cookie, cookieCount, isSecureRequest, isTrustedWrite, parseCookies, pathOf, readJsonObject, sendError, sessionCookie, tokenOf,
} from './accountHttp.js';

export const ACTIVATION_COOKIE = 'mk_activation';
/*
 * По HTTPS — с префиксом __Secure-: такую cookie браузер примет только с
 * флагом Secure, её не подбросить с HTTP-страницы или соседнего поддомена
 * без HTTPS. По HTTP (локальная разработка) префикса нет.
 */
const activationCookieName = (req) => (isSecureRequest(req) ? `__Secure-${ACTIVATION_COOKIE}` : ACTIVATION_COOKIE);
const ACTIVATION_PATH = '/api/auth/activation';
const MAX_BODY_BYTES = 4 * 1024;

const ROUTES = new Map([
  ['/api/auth/access-link', { POST: 'request' }],
  ['/api/auth/activation', { GET: 'context' }],
  ['/api/auth/activation/peek', { POST: 'peek' }],
  ['/api/auth/activation/start', { POST: 'start' }],
  ['/api/auth/activation/complete', { POST: 'complete' }],
]);

export const ACTIVATION_PATHS = Object.freeze([...ROUTES.keys()]);

/*
 * Лимиты: 30 запросов к ссылкам за 15 минут с адреса (токен — 256 бит,
 * перебор бессмыслен, но и пробовать незачем); запрос ссылки на почту —
 * 5 за 15 минут с адреса и 3 в час на один email.
 */
const defaultActivationLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 30, maxPerInstance: Number.POSITIVE_INFINITY });
const defaultRequestLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 5, maxPerInstance: Number.POSITIVE_INFINITY });

/** Счётчик запросов ссылки по email — одинаковый для существующих и несуществующих адресов. */
export const createEmailWindow = ({ windowMs = 60 * 60 * 1000, max = 3, maxTracked = 10_000, now = () => Date.now() } = {}) => {
  const hits = new Map();
  return (key) => {
    const stamp = now();
    const fresh = (hits.get(key) || []).filter((at) => stamp - at < windowMs);
    if (fresh.length >= max) {
      hits.set(key, fresh);
      return false;
    }
    fresh.push(stamp);
    hits.set(key, fresh);
    if (hits.size > maxTracked) hits.delete(hits.keys().next().value);
    return true;
  };
};
const defaultEmailWindow = createEmailWindow();

const REQUEST_ACCEPTED = 'Если для этого адреса есть аккаунт, мы отправили на него ссылку для входа. Письмо приходит в течение пары минут; проверьте и папку «Спам».';

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.getContext контекст аккаунтов (accountContext.js) или null
 */
export const createActivationHandler = ({
  getContext = getAccountContext,
  activationLimit = defaultActivationLimit,
  requestLimit = defaultRequestLimit,
  emailWindow = defaultEmailWindow,
} = {}) =>
  async function activationHandler(req, res) {
    const route = ROUTES.get(pathOf(req.originalUrl || req.url));
    const operation = route?.[req.method];
    if (!route || !operation) {
      res.setHeader('Allow', route ? Object.keys(route).join(', ') : 'POST');
      respondJson(res, route ? 405 : 404, { error: route ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }

    const limit = (operation === 'request' ? requestLimit : activationLimit)(getClientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много попыток. Подождите немного.', code: 'rate_limited' });
      return;
    }
    if (req.method !== 'GET' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
      return;
    }

    const context = await getContext();
    if (!context) {
      respondJson(res, 503, { error: 'Вход сейчас недоступен.', code: 'accounts_unavailable' });
      return;
    }
    const { invitations, accounts } = context;
    const cookieName = activationCookieName(req);
    const contextCookie = (value, maxAgeSeconds) => cookie(req, cookieName, value, maxAgeSeconds, { path: ACTIVATION_PATH, sameSite: 'Strict' });
    // Две cookie контекста сразу — одну подбросили (например, с более узким Path):
    // не угадываем, какая настоящая, — контекста нет, ссылку нужно открыть заново.
    const currentContext = () => (cookieCount(req.headers.cookie, cookieName) === 1 ? parseCookies(req.headers.cookie)[cookieName] : null);

    try {
      const body = req.method === 'GET' ? {} : await readJsonObject(req, MAX_BODY_BYTES);
      switch (operation) {
        case 'request': {
          // Почта не настроена — это свойство сервера, а не адреса: ответ одинаков для всех.
          if (!invitations.emailEnabled) {
            respondJson(res, 409, { error: 'Ссылку для входа выдаёт администратор: напишите ему, и он пришлёт новую.', code: 'mail_disabled' });
            return;
          }
          const address = normalizeEmail(body.email).slice(0, 254);
          if (!address) {
            respondJson(res, 400, { error: 'Укажите email.', code: 'bad_email' });
            return;
          }
          // Ответ — сразу и одинаковый; вся работа (поиск аккаунта, запись ссылки,
          // письмо) — только после того, как ответ ушёл: по времени ответа нельзя
          // понять, есть ли такой аккаунт.
          const allowed = emailWindow(address);
          metrics.increment('auth.access_link_requested');
          respondJson(res, 202, { ok: true, message: REQUEST_ACCEPTED });
          if (allowed) {
            setImmediate(() => {
              invitations.requestLink(address).catch((error) => logger.error('account.access_link_failed', error));
            });
          }
          return;
        }
        case 'peek': {
          respondJson(res, 200, { link: invitations.peek(body.token) });
          return;
        }
        case 'start': {
          const started = invitations.start(body.token, { contextToken: currentContext(), ...clientContext(req) });
          const expiresIn = (Date.parse(started.context.expiresAt) - Date.now()) / 1000;
          res.setHeader('Set-Cookie', contextCookie(started.contextToken, expiresIn));
          logger.event('account.activation', { status: 'opened', action: started.context.purpose });
          respondJson(res, 200, { context: started.context });
          return;
        }
        case 'context': {
          const found = invitations.context(currentContext());
          if (!found) {
            if (cookieCount(req.headers.cookie, cookieName) > 0) res.setHeader('Set-Cookie', contextCookie('', 0));
            respondJson(res, 404, { error: 'Откройте ссылку из приглашения ещё раз.', code: 'no_context' });
            return;
          }
          respondJson(res, 200, { context: found });
          return;
        }
        case 'complete': {
          const result = await invitations.complete(currentContext(), body.password, clientContext(req));
          // В этом браузере мог быть вход в другой аккаунт — та сессия завершается.
          const previous = tokenOf(req);
          if (previous) accounts.logout(previous);
          res.setHeader('Set-Cookie', [sessionCookie(req, result.session.token, result.session.expiresAt), contextCookie('', 0)]);
          logger.event('account.activation', { status: 'completed', action: result.purpose });
          metrics.increment('auth.activation', { status: result.purpose });
          respondJson(res, 200, { user: result.user, favorites: result.favorites, purpose: result.purpose });
          return;
        }
        default:
          respondJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      if (error instanceof AccountError && ['activation_expired', 'link_used', 'link_revoked', 'link_expired'].includes(error.code) && operation === 'complete') {
        res.setHeader('Set-Cookie', contextCookie('', 0));
      }
      sendError(res, error, 'account.activation_failed');
    }
  };

export default createActivationHandler();
