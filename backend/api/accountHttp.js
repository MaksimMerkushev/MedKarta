/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общая HTTP-обвязка кабинета, профиля и админ-панели: cookie, защита от
 * CSRF, чтение тела, проверка сессии и единый формат ошибок. Правила одни
 * для всех маршрутов — расхождение между ними и было бы дырой.
 *
 * Cookie сессии по HTTPS — __Host-mk_sid: Secure, Path=/, без Domain —
 * браузер не примет такую cookie с поддомена или по HTTP, её нельзя
 * подбросить (cookie tossing, фиксация сессии). HttpOnly — скрипт страницы
 * её не видит; SameSite=Lax. По HTTP (локальная разработка) — mk_sid.
 * Прежняя cookie mk_session (Path=/api) больше не читается и стирается.
 */

import { randomBytes } from 'node:crypto';

import { AccountError } from '../accounts/service.js';
import { describeClient, networkPrefix } from '../accounts/clientInfo.js';
import { ipKeyOf } from '../accounts/throttle.js';
import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { getClientIp, isFromTrustedProxy } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';

/** Имя cookie сессии без префикса (по HTTP); по HTTPS — с __Host-. */
export const SESSION_COOKIE = 'mk_sid';
export const LEGACY_SESSION_COOKIE = 'mk_session';
export const DEVICE_COOKIE = 'mk_device';
export const MFA_COOKIE = 'mk_mfa';
const DEVICE_MAX_AGE_S = 180 * 24 * 60 * 60;

/** Сколько раз cookie с этим именем пришла в заголовке (подброшенная с поддомена — вторая). */
export const cookieCount = (header, name) => String(header || '').split(';')
  .filter((part) => part.slice(0, part.indexOf('=')).trim() === name).length;

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
export const isSecureRequest = (req) => {
  if (process.env.COOKIE_SECURE === 'on') return true;
  if (process.env.COOKIE_SECURE === 'off') return false;
  if (process.env.NODE_ENV === 'production') return true;
  if (req.socket?.encrypted) return true;
  return isFromTrustedProxy(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
};

export const cookie = (req, name, value, maxAgeSeconds, { path = '/api', sameSite = 'Lax' } = {}) => {
  const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
};

/** Имя cookie с префиксом __Host- по HTTPS (Secure, Path=/, без Domain). */
export const hostCookieName = (req, name) => (isSecureRequest(req) ? `__Host-${name}` : name);
export const sessionCookieName = (req) => hostCookieName(req, SESSION_COOKIE);

export const sessionCookie = (req, token, expiresAt) =>
  cookie(req, sessionCookieName(req), token, token ? (expiresAt - Date.now()) / 1000 : 0, { path: '/' });

/** Стереть прежнюю cookie сессии (до обновления: mk_session, Path=/api). */
export const legacyCookieClear = (req) => (String(req.headers.cookie || '').includes(`${LEGACY_SESSION_COOKIE}=`)
  ? [cookie(req, LEGACY_SESSION_COOKIE, '', 0, { path: '/api' })]
  : []);

/** Cookie второго шага входа: только на 5 минут и только для своих запросов (Strict). */
export const mfaCookie = (req, token, maxAgeSeconds) =>
  cookie(req, hostCookieName(req, MFA_COOKIE), token, token ? maxAgeSeconds : 0, { path: '/', sameSite: 'Strict' });
export const mfaTokenOf = (req) => {
  const name = hostCookieName(req, MFA_COOKIE);
  return cookieCount(req.headers.cookie, name) === 1 ? parseCookies(req.headers.cookie)[name] || '' : '';
};

/*
 * Cookie устройства: случайный токен, по которому сервер узнаёт браузер,
 * где пользователь уже входил (throttle.js). Это не учётные данные: войти по
 * ней нельзя, она только избавляет владельца от блокировки, вызванной чужими
 * неудачными попытками.
 */
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const deviceTokenOf = (req) => {
  const name = hostCookieName(req, DEVICE_COOKIE);
  const value = cookieCount(req.headers.cookie, name) === 1 ? parseCookies(req.headers.cookie)[name] : '';
  return DEVICE_TOKEN.test(value || '') ? value : '';
};
/** Токен устройства для этого запроса: существующий или новый (и cookie, чтобы его запомнить). */
export const ensureDevice = (req) => {
  const existing = deviceTokenOf(req);
  if (existing) return { token: existing, setCookie: null };
  const token = randomBytes(32).toString('base64url');
  return { token, setCookie: cookie(req, hostCookieName(req, DEVICE_COOKIE), token, DEVICE_MAX_AGE_S, { path: '/', sameSite: 'Lax' }) };
};

/*
 * CSRF — в три слоя: SameSite=Lax у cookie, обязательный Content-Type:
 * application/json (с чужого сайта такой запрос требует предварительного
 * разрешения, которого мы не даём) и проверка Origin / Sec-Fetch-Site.
 */
export const isTrustedWrite = (req) => {
  if (!verifyOrigin(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
};

/*
 * Адрес приложения, с которого пришёл запрос администратора, — для ссылки,
 * которую он передаст сам, если APP_URL не задан. Origin к этому моменту уже
 * проверен (isTrustedWrite); в письма такой адрес не попадает никогда.
 */
export const requestOrigin = (req) => {
  try {
    const origin = req.headers.origin ? new URL(req.headers.origin) : null;
    if (origin && ['http:', 'https:'].includes(origin.protocol)) return origin.origin;
  } catch {
    // Некорректный Origin — ниже Host.
  }
  const host = String(req.headers.host || '').trim();
  if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) return null;
  return `${isSecureRequest(req) ? 'https' : 'http'}://${host}`;
};

export const pathOf = (url) => {
  const raw = String(url || '');
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
};

export const queryOf = (url) => Object.fromEntries(new URL(String(url || '/'), 'http://localhost').searchParams);

/** «Chrome 129 · macOS» и сеть /24 — для истории входов и списка сессий; ключ адреса и устройства — для лимитов. */
export const clientContext = (req, { deviceToken = null } = {}) => {
  const ip = getClientIp(req);
  return {
    client: describeClient(req.headers['user-agent']),
    ipPrefix: networkPrefix(ip),
    ipKey: ipKeyOf(ip),
    deviceToken: deviceToken || deviceTokenOf(req),
  };
};

/** JSON-объект из тела или AccountError 400/413. */
export const readJsonObject = async (req, maxBytes) => {
  let body;
  try {
    body = await readBody(req, maxBytes);
  } catch (error) {
    throw new AccountError(error.status === 413 ? 'too_large' : 'bad_request', error.status || 400, error.status === 413 ? 'Тело запроса слишком большое.' : 'Некорректный запрос.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountError('bad_request', 400, 'Некорректный запрос.');
  return body;
};

/** Ошибка сервиса — в ответ с её статусом и кодом; остальное — 500 без подробностей. */
export const sendError = (res, error, event = 'account.request_failed') => {
  if (error instanceof AccountError) {
    if (error.status === 429 && error.extra?.retryAfterSeconds) res.setHeader('Retry-After', String(error.extra.retryAfterSeconds));
    respondJson(res, error.status, { error: error.message, code: error.code, ...(error.extra || {}) });
    return;
  }
  if (error?.name === 'MfaError') {
    respondJson(res, error.code === 'not_found' ? 404 : 400, { error: error.message, code: error.code });
    return;
  }
  logger.error(event, error);
  respondJson(res, 500, { error: 'Не получилось. Попробуйте ещё раз.' });
};

/** Токен сессии из cookie. Две cookie с этим именем — одну подбросили: не угадываем, сессии нет. */
export const tokenOf = (req) => {
  const name = sessionCookieName(req);
  return cookieCount(req.headers.cookie, name) === 1 ? parseCookies(req.headers.cookie)[name] || '' : '';
};

/**
 * Сессия запроса: {user, session, permissions} или ответ 401/403.
 * Пока пользователь не сменил временный пароль, ему доступно только то, что
 * перечислено в allowWhilePasswordChange.
 */
export const requireSession = (req, res, service, { allowWhilePasswordChange = false } = {}) => {
  const token = tokenOf(req);
  const auth = token ? service.authenticate(token) : null;
  if (!auth) {
    const clears = [...(token ? [sessionCookie(req, '', 0)] : []), ...legacyCookieClear(req)];
    if (clears.length > 0) res.setHeader('Set-Cookie', clears);
    respondJson(res, 401, { error: 'Войдите в личный кабинет.', code: 'unauthenticated' });
    return null;
  }
  if (auth.user.mustChangePassword && !allowWhilePasswordChange) {
    respondJson(res, 403, { error: 'Сначала смените временный пароль.', code: 'password_change_required' });
    return null;
  }
  return auth;
};

/**
 * Критическое действие: нужно свежее подтверждение личности (пароль и,
 * если включена, MFA — не старше auth.reauthMinutes). Иначе 403
 * reauth_required — интерфейс попросит подтвердить и повторит запрос.
 */
export const requireFresh = (res, auth, service) => {
  if (service.isFresh(auth.session)) return true;
  respondJson(res, 403, {
    error: 'Подтвердите, что это вы: введите пароль' + (auth.security?.mfaEnabled ? ' и код второго фактора.' : '.'),
    code: 'reauth_required',
    mfa: Boolean(auth.security?.mfaEnabled),
  });
  return false;
};
