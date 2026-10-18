/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Свой профиль (страница /profile). Только свои данные: id пользователя из
 * запроса не берётся — только из сессии.
 *
 *   GET    /api/me                         — профиль
 *   PATCH  /api/me                         — имя и фамилия
 *   POST   /api/me/password                — смена пароля (с текущим)
 *   GET    /api/me/sessions                — свои активные сессии
 *   DELETE /api/me/sessions/:id            — завершить сессию
 *   POST   /api/me/sessions/revoke-others  — завершить все, кроме текущей
 *   GET    /api/me/logins                  — последние входы
 *   GET    /api/me/avatar                  — аватар
 *   PUT    /api/me/avatar                  — загрузить аватар ({image: data:URL})
 *   DELETE /api/me/avatar                  — убрать аватар
 *
 * Пока временный пароль не сменён, доступны профиль, смена пароля, аватар
 * для чтения и выход — остальное отвечает 403 password_change_required.
 */

import { hashToken } from '../accounts/service.js';
import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { createRouter } from '../http/router.js';
import { getDefaultAccountService } from './accountContext.js';
import {
  clientContext, isTrustedWrite, pathOf, queryOf, readJsonObject, requireSession, sendError, sessionCookie, tokenOf,
} from './accountHttp.js';

const MAX_BODY_BYTES = 16 * 1024;
// Аватар до 256 КБ в base64 — с запасом на кодирование.
const MAX_AVATAR_BODY_BYTES = 400 * 1024;

const defaultApiLimit = createRateLimiter({ maxPerIp: 300, maxPerInstance: Number.POSITIVE_INFINITY });
// Смена пароля проверяет текущий — это тот же подбор, что и вход.
const defaultPasswordLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 10, maxPerInstance: Number.POSITIVE_INFINITY });

const route = createRouter([
  ['GET', '/api/me', 'profile'],
  ['PATCH', '/api/me', 'update'],
  ['POST', '/api/me/password', 'password'],
  ['GET', '/api/me/sessions', 'sessions'],
  ['DELETE', '/api/me/sessions/:id', 'revokeSession'],
  ['POST', '/api/me/sessions/revoke-others', 'revokeOthers'],
  ['GET', '/api/me/logins', 'logins'],
  ['GET', '/api/me/avatar', 'avatar'],
  ['PUT', '/api/me/avatar', 'setAvatar'],
  ['DELETE', '/api/me/avatar', 'deleteAvatar'],
]);

const ALLOWED_WHILE_PASSWORD_CHANGE = new Set(['profile', 'password', 'avatar']);

/** Картинка с заголовками, которые не дают выполнить её как документ. */
export const sendImage = (req, res, image, { versioned = false } = {}) => {
  const etag = `"${image.etag}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', versioned ? 'private, max-age=86400, immutable' : 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', image.mime);
  res.setHeader('Content-Length', String(image.data.length));
  res.end(image.data);
};

export const createMeHandler = ({ getService = getDefaultAccountService, apiLimit = defaultApiLimit, passwordLimit = defaultPasswordLimit } = {}) =>
  async function meHandler(req, res) {
    const url = req.originalUrl || req.url;
    const match = route(req.method, pathOf(url));
    if (!match.operation) {
      if (match.allow) res.setHeader('Allow', match.allow.join(', '));
      respondJson(res, match.status, { error: match.status === 405 ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }
    const { operation, params } = match;

    const limit = (operation === 'password' ? passwordLimit : apiLimit)(getClientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов. Подождите немного.', code: 'rate_limited' });
      return;
    }
    if (req.method !== 'GET' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
      return;
    }

    const service = await getService();
    if (!service) {
      respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен.', code: 'accounts_unavailable' });
      return;
    }
    const auth = requireSession(req, res, service, { allowWhilePasswordChange: ALLOWED_WHILE_PASSWORD_CHANGE.has(operation) });
    if (!auth) return;
    const { user, session } = auth;

    try {
      let body = {};
      if (['update', 'password', 'setAvatar'].includes(operation)) {
        body = await readJsonObject(req, operation === 'setAvatar' ? MAX_AVATAR_BODY_BYTES : MAX_BODY_BYTES);
      }
      switch (operation) {
        case 'profile':
          respondJson(res, 200, { ...service.snapshot(user), session: { id: session.publicId } });
          return;
        case 'update': {
          const extra = Object.keys(body).filter((key) => !['firstName', 'lastName'].includes(key));
          if (extra.length > 0) {
            respondJson(res, 400, { error: `Недопустимые поля: ${extra.slice(0, 5).join(', ')}.`, code: 'unexpected_field' });
            return;
          }
          respondJson(res, 200, service.updateProfile(user, { firstName: body.firstName ?? user.firstName, lastName: body.lastName ?? user.lastName }));
          return;
        }
        case 'password': {
          const result = await service.changePassword(user, { currentPassword: body.currentPassword, newPassword: body.newPassword }, clientContext(req));
          // Новая сессия вместо всех прежних: старый токен (и украденный тоже) больше не действует.
          res.setHeader('Set-Cookie', sessionCookie(req, result.session.token, result.session.expiresAt));
          respondJson(res, 200, { user: result.user });
          return;
        }
        case 'sessions':
          respondJson(res, 200, { items: service.listOwnSessions(user, session.tokenHash) });
          return;
        case 'revokeSession': {
          const result = service.revokeOwnSession(user, params.id);
          if (params.id === session.publicId) res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
          respondJson(res, 200, { ...result, current: params.id === session.publicId });
          return;
        }
        case 'revokeOthers':
          respondJson(res, 200, service.revokeOtherSessions(user, hashToken(tokenOf(req))));
          return;
        case 'logins': {
          const query = queryOf(url);
          respondJson(res, 200, { items: service.ownLogins(user, { limit: Number(query.limit) || 20 }) });
          return;
        }
        case 'avatar': {
          const image = service.getAvatar(user.id);
          if (!image) {
            respondJson(res, 404, { error: 'Аватара нет.', code: 'not_found' });
            return;
          }
          sendImage(req, res, image, { versioned: Boolean(queryOf(url).v) });
          return;
        }
        case 'setAvatar': {
          const extra = Object.keys(body).filter((key) => key !== 'image');
          if (extra.length > 0) {
            respondJson(res, 400, { error: 'Ожидается только поле image.', code: 'unexpected_field' });
            return;
          }
          respondJson(res, 200, service.setAvatar(user, body.image));
          return;
        }
        case 'deleteAvatar':
          respondJson(res, 200, service.deleteAvatar(user));
          return;
        default:
          respondJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      sendError(res, error, 'me.request_failed');
    }
  };

export const ME_PREFIX = '/api/me';
export default createMeHandler();
