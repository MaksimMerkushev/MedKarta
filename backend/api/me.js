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
 * Безопасность аккаунта:
 *   GET    /api/me/security                — MFA, резервные коды, уровень сессии, подтверждён ли email
 *   POST   /api/me/reauth/options          — способы подтверждения личности (вызов для ключа доступа)
 *   POST   /api/me/reauth                  — подтвердить личность: пароль (+ второй фактор)
 *   POST   /api/me/mfa/totp                — начать настройку приложения-аутентификатора
 *   POST   /api/me/mfa/totp/confirm        — подтвердить кодом
 *   POST   /api/me/mfa/passkey             — параметры для нового ключа доступа
 *   POST   /api/me/mfa/passkey/finish      — сохранить ключ доступа
 *   PATCH  /api/me/mfa/factors/:id         — переименовать фактор
 *   DELETE /api/me/mfa/factors/:id         — удалить фактор
 *   POST   /api/me/mfa/recovery-codes      — новый набор резервных кодов
 *   POST   /api/me/email                   — сменить email (письмо на новый адрес)
 *   POST   /api/me/email/verify            — подтвердить текущий email (письмо со ссылкой)
 *   POST   /api/me/sessions/revoke-all     — выйти на всех устройствах
 *
 * Критические действия (email, факторы — в том числе первый, коды, пароль
 * при включённой MFA) требуют свежего явного подтверждения личности:
 * 403 reauth_required. Сам вход его не заменяет — украденная сессия не
 * позволит привязать к аккаунту чужой ключ или телефон.
 *
 * Пока временный пароль не сменён, доступны профиль, смена пароля, аватар
 * для чтения и выход — остальное отвечает 403 password_change_required.
 */

import { hashToken, maskEmail, userLabel } from '../accounts/service.js';
import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { createRouter } from '../http/router.js';
import { getAccountContext } from './accountContext.js';
import {
  clientContext, isTrustedWrite, pathOf, queryOf, readJsonObject, requireFresh, requireSession, sendError, sessionCookie, tokenOf,
} from './accountHttp.js';

const MAX_BODY_BYTES = 16 * 1024;
// Аватар до 256 КБ в base64 — с запасом на кодирование.
const MAX_AVATAR_BODY_BYTES = 400 * 1024;

const MFA_BODY_BYTES = 32 * 1024;
const defaultApiLimit = createRateLimiter({ maxPerIp: 300, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });
// Смена пароля и подтверждение личности проверяют пароль — это тот же подбор, что и вход.
const defaultPasswordLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 10, maxPerInstance: Number.POSITIVE_INFINITY });
const PASSWORD_OPERATIONS = new Set(['password', 'reauth', 'totpConfirm', 'email']);

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
  ['GET', '/api/me/security', 'security'],
  ['POST', '/api/me/reauth/options', 'reauthOptions'],
  ['POST', '/api/me/reauth', 'reauth'],
  ['POST', '/api/me/mfa/totp', 'totpStart'],
  ['POST', '/api/me/mfa/totp/confirm', 'totpConfirm'],
  ['POST', '/api/me/mfa/passkey', 'passkeyStart'],
  ['POST', '/api/me/mfa/passkey/finish', 'passkeyFinish'],
  ['PATCH', '/api/me/mfa/factors/:id', 'renameFactor'],
  ['DELETE', '/api/me/mfa/factors/:id', 'removeFactor'],
  ['POST', '/api/me/mfa/recovery-codes', 'recoveryCodes'],
  ['POST', '/api/me/email', 'email'],
  ['POST', '/api/me/email/verify', 'verifyEmail'],
  ['POST', '/api/me/sessions/revoke-all', 'revokeAll'],
]);

const WITH_BODY = new Set(['update', 'password', 'setAvatar', 'reauth', 'totpConfirm', 'passkeyFinish', 'renameFactor', 'email']);
const FACTOR_ID = /^[a-f0-9]{24}$/;

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

export const createMeHandler = ({
  getContext: givenContext = null,
  getService: givenService = null,
  apiLimit = defaultApiLimit,
  passwordLimit = defaultPasswordLimit,
} = {}) => {
  // Передан только сервис (старые тесты) — контекста нет: журналы и смена email недоступны, базу по умолчанию не открываем.
  const getContext = givenContext || (givenService ? async () => null : getAccountContext);
  const getService = givenService || (async () => (await getContext())?.accounts || null);
  return async function meHandler(req, res) {
    const url = req.originalUrl || req.url;
    const match = route(req.method, pathOf(url));
    if (!match.operation) {
      if (match.allow) res.setHeader('Allow', match.allow.join(', '));
      respondJson(res, match.status, { error: match.status === 405 ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }
    const { operation, params } = match;

    const limit = (PASSWORD_OPERATIONS.has(operation) ? passwordLimit : apiLimit)(getClientIp(req));
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
    const context = await getContext().catch(() => null);
    const mfa = service.mfa;
    const store = context?.store || null;

    /** Новая cookie сессии вместо прежней (подтверждение личности, повышение уровня). */
    const replaceCookie = (fresh) => res.setHeader('Set-Cookie', sessionCookie(req, fresh.token, fresh.expiresAt));
    const audit = (action, details = null) => store?.addAudit({ at: Date.now(), action, actorId: user.id, actorLabel: userLabel(user), targetId: user.id, targetLabel: userLabel(user), result: 'ok', details });
    const event = (type, reason = null) => store?.addAuthEvent({ at: Date.now(), type, userId: user.id, sessionId: session.publicId, reason });
    /*
     * Добавить фактор: нужна свежая проверка личности — и для первого тоже:
     * иначе чужой, получивший сессию, привязал бы свой ключ или телефон и
     * закрыл бы владельцу вход.
     */
    const canAddFactor = () => service.isFresh(session);
    // Сотруднику ключ доступа обязан проверять человека (PIN, биометрия).
    const requireUv = Boolean(auth.security.mfaRequired);
    const requireMfaService = () => {
      if (mfa) return true;
      respondJson(res, 503, { error: 'Двухфакторная защита недоступна на этом сервере.', code: 'mfa_unavailable' });
      return false;
    };
    /** После первого фактора: письмо, журнал, а сотруднику — сессия уровня 2 (иначе админ-панель попросит ещё раз). */
    const afterFactorAdded = (result, method) => {
      event('mfa_enabled', method);
      audit('mfa.enable', { method });
      service.__internal.notify(user, 'mfa_enabled', { method: method === 'totp' ? 'приложение-аутентификатор' : 'ключ доступа' });
      if ((session.aal || 1) < 2) replaceCookie(service.elevateAfterSetup(user, session, clientContext(req)));
      return { factor: result.factor, recoveryCodes: result.recoveryCodes, security: service.securityOf(user, { aal: 2 }) };
    };

    try {
      let body = {};
      if (WITH_BODY.has(operation)) {
        body = await readJsonObject(req, operation === 'setAvatar' ? MAX_AVATAR_BODY_BYTES : ['passkeyFinish', 'reauth'].includes(operation) ? MFA_BODY_BYTES : MAX_BODY_BYTES);
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
          // Имя и фамилия — строки; null, число или объект — ошибка, а не «оставить как было» с ответом 200.
          const wrongType = ['firstName', 'lastName'].find((key) => key in body && typeof body[key] !== 'string');
          if (wrongType) {
            respondJson(res, 400, { error: wrongType === 'firstName' ? 'Укажите имя: буквы, пробел, дефис.' : 'Фамилия: буквы, пробел, дефис.', code: 'bad_name' });
            return;
          }
          respondJson(res, 200, service.updateProfile(user, { firstName: body.firstName ?? user.firstName, lastName: body.lastName ?? user.lastName }));
          return;
        }
        case 'password': {
          // Со вторым фактором одного текущего пароля мало: нужна свежая проверка личности.
          if (auth.security.mfaEnabled && !requireFresh(res, auth, service)) return;
          const result = await service.changePassword(user, { currentPassword: body.currentPassword, newPassword: body.newPassword }, clientContext(req), session);
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
        case 'security': {
          const status = mfa ? mfa.status(user.id) : { enabled: false, factors: [], recoveryCodes: { total: 0, unused: 0 }, methods: [], passkeysAvailable: false };
          respondJson(res, 200, {
            ...status,
            mfaRequired: auth.security.mfaRequired,
            sessionLevel: session.aal || 1,
            fresh: service.isFresh(session),
            canAddFactor: canAddFactor(),
            email: user.email,
            emailVerified: Boolean(user.emailVerifiedAt),
            emailChange: Boolean(context?.emailChange?.enabled),
          });
          return;
        }
        case 'reauthOptions':
          respondJson(res, 200, service.reauthOptions(user, session));
          return;
        case 'reauth': {
          const extra = Object.keys(body).filter((key) => !['password', 'method', 'code', 'credential'].includes(key));
          if (extra.length > 0) {
            respondJson(res, 400, { error: 'Некорректный запрос.', code: 'bad_request' });
            return;
          }
          const result = await service.reauthenticate(user, session, body, clientContext(req));
          replaceCookie(result.session);
          respondJson(res, 200, { ok: true, security: result.security, sessionLevel: result.session.aal });
          return;
        }
        case 'totpStart': {
          if (!requireMfaService()) return;
          if (!requireFresh(res, auth, service)) return;
          respondJson(res, 200, mfa.beginTotp(user));
          return;
        }
        case 'totpConfirm': {
          if (!requireMfaService()) return;
          if (!requireFresh(res, auth, service)) return;
          const result = mfa.confirmTotp(user, { factorId: body.factorId, code: body.code, label: body.label });
          respondJson(res, 200, afterFactorAdded(result, 'totp'));
          return;
        }
        case 'passkeyStart': {
          if (!requireMfaService()) return;
          if (!requireFresh(res, auth, service)) return;
          respondJson(res, 200, { publicKey: mfa.beginPasskey(user, { requireUv }) });
          return;
        }
        case 'passkeyFinish': {
          if (!requireMfaService()) return;
          if (!requireFresh(res, auth, service)) return;
          const result = mfa.finishPasskey(user, { credential: body.credential, label: body.label, requireUv });
          respondJson(res, 200, afterFactorAdded(result, 'webauthn'));
          return;
        }
        case 'renameFactor': {
          if (!requireMfaService()) return;
          if (!FACTOR_ID.test(params.id)) {
            respondJson(res, 404, { error: 'Фактор не найден.', code: 'not_found' });
            return;
          }
          respondJson(res, 200, { factor: mfa.rename(user.id, params.id, body.label) });
          return;
        }
        case 'removeFactor': {
          if (!requireMfaService()) return;
          if (!FACTOR_ID.test(params.id)) {
            respondJson(res, 404, { error: 'Фактор не найден.', code: 'not_found' });
            return;
          }
          if (!requireFresh(res, auth, service)) return;
          // Сотруднику (и тем более суперадминистратору) последний фактор не удалить: MFA для него обязательна.
          const result = mfa.remove(user.id, params.id, { keepOne: auth.security.mfaRequired });
          event('mfa_disabled', result.removed.type);
          audit('mfa.disable', { method: result.removed.type, remaining: result.remaining });
          service.__internal.notify(user, 'mfa_disabled', { method: result.removed.typeLabel.toLowerCase(), remaining: result.remaining });
          respondJson(res, 200, { removed: result.removed.id, remaining: result.remaining });
          return;
        }
        case 'recoveryCodes': {
          if (!requireMfaService()) return;
          if (!requireFresh(res, auth, service)) return;
          const codes = mfa.regenerateRecoveryCodes(user.id);
          event('recovery_codes');
          audit('mfa.recovery_codes');
          service.__internal.notify(user, 'recovery_codes');
          respondJson(res, 200, { recoveryCodes: codes });
          return;
        }
        case 'email': {
          if (!context?.emailChange) {
            respondJson(res, 503, { error: 'Смена email недоступна.', code: 'unavailable' });
            return;
          }
          if (!requireFresh(res, auth, service)) return;
          const extra = Object.keys(body).filter((key) => key !== 'newEmail');
          if (extra.length > 0) {
            respondJson(res, 400, { error: 'Ожидается только поле newEmail.', code: 'unexpected_field' });
            return;
          }
          const result = context.emailChange.request(user, body.newEmail, { sourceKey: clientContext(req).ipKey });
          respondJson(res, 202, { ok: true, sentTo: maskEmail(result.sentTo), message: 'Мы отправили письмо на новый адрес. Email изменится после перехода по ссылке из него.' });
          return;
        }
        case 'verifyEmail': {
          if (!context?.emailChange) {
            respondJson(res, 503, { error: 'Подтверждение email недоступно.', code: 'unavailable' });
            return;
          }
          const result = context.emailChange.requestVerification(user, { sourceKey: clientContext(req).ipKey });
          respondJson(res, 202, { ok: true, sentTo: maskEmail(result.sentTo), message: 'Мы отправили письмо со ссылкой для подтверждения на ваш email.' });
          return;
        }
        case 'revokeAll': {
          const result = service.revokeAllSessions(user);
          res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
          respondJson(res, 200, result);
          return;
        }
        default:
          respondJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      sendError(res, error, 'me.request_failed');
    }
  };
};

export const ME_PREFIX = '/api/me';
export default createMeHandler();
