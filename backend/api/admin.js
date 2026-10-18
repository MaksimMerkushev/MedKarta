/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * HTTP-слой админ-панели (/admin). Каждый запрос: действующая сессия, смена
 * временного пароля уже выполнена, разрешение admin.access; конкретное
 * разрешение и ранг проверяет adminService. Изменяющие запросы — только JSON
 * со своего Origin (как у кабинета). id пользователя — только 32 hex-символа.
 *
 *   GET    /api/admin/me                           кто вошёл и что ему можно
 *   GET    /api/admin/dashboard?period=7d          дашборд (24h, 7d, 30d, 90d)
 *   GET    /api/admin/users                        список: q, role, status, kind, sort, dir, page, pageSize
 *   POST   /api/admin/users                        создать (временный пароль — в ответе, один раз)
 *   GET    /api/admin/users/export                 CSV с теми же фильтрами (или ids=…)
 *   POST   /api/admin/users/bulk                   массово заблокировать / разблокировать
 *   GET    /api/admin/users/:id                    карточка
 *   PATCH  /api/admin/users/:id                    имя, фамилия, email (version — защита от гонки)
 *   DELETE /api/admin/users/:id                    удалить ({confirmEmail})
 *   POST   /api/admin/users/:id/role               сменить роль
 *   POST   /api/admin/users/:id/block              заблокировать ({reason, until})
 *   POST   /api/admin/users/:id/unblock            разблокировать
 *   POST   /api/admin/users/:id/archive            в архив
 *   POST   /api/admin/users/:id/restore            из архива
 *   POST   /api/admin/users/:id/password-reset     временный пароль (в ответе, один раз)
 *   POST   /api/admin/users/:id/password-require   потребовать смену пароля
 *   POST   /api/admin/users/:id/sessions/revoke    завершить все сессии
 *   GET    /api/admin/users/:id/sessions|logins|blocks|audit|avatar
 *   GET    /api/admin/sessions                     активные сессии
 *   DELETE /api/admin/sessions/:id                 отозвать сессию
 *   GET    /api/admin/roles                        роли, разрешения, матрица
 *   PUT    /api/admin/roles/:role                  разрешения роли
 *   POST   /api/admin/roles/:role/reset            вернуть разрешения по умолчанию
 *   GET    /api/admin/audit                        журнал действий
 *   GET    /api/admin/system                       состояние приложения
 *   GET    /api/admin/settings, PATCH              настройки
 */

import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { createRouter } from '../http/router.js';
import { logger } from '../observability/safeLogger.js';
import { getAccountContext } from './accountContext.js';
import { isTrustedWrite, pathOf, queryOf, readJsonObject, requireSession, sendError } from './accountHttp.js';
import { sendImage } from './me.js';

const MAX_BODY_BYTES = 32 * 1024;
const defaultLimit = createRateLimiter({ maxPerIp: 600, maxPerInstance: Number.POSITIVE_INFINITY });

const route = createRouter([
  ['GET', '/api/admin/me', 'me'],
  ['GET', '/api/admin/dashboard', 'dashboard'],
  ['GET', '/api/admin/users', 'listUsers'],
  ['POST', '/api/admin/users', 'createUser'],
  ['GET', '/api/admin/users/export', 'exportUsers'],
  ['POST', '/api/admin/users/bulk', 'bulk'],
  ['GET', '/api/admin/users/:id', 'getUser'],
  ['PATCH', '/api/admin/users/:id', 'updateUser'],
  ['DELETE', '/api/admin/users/:id', 'deleteUser'],
  ['POST', '/api/admin/users/:id/role', 'setRole'],
  ['POST', '/api/admin/users/:id/block', 'block'],
  ['POST', '/api/admin/users/:id/unblock', 'unblock'],
  ['POST', '/api/admin/users/:id/archive', 'archive'],
  ['POST', '/api/admin/users/:id/restore', 'restore'],
  ['POST', '/api/admin/users/:id/password-reset', 'resetPassword'],
  ['POST', '/api/admin/users/:id/password-require', 'requirePasswordChange'],
  ['POST', '/api/admin/users/:id/sessions/revoke', 'revokeUserSessions'],
  ['GET', '/api/admin/users/:id/sessions', 'userSessions'],
  ['GET', '/api/admin/users/:id/logins', 'userLogins'],
  ['GET', '/api/admin/users/:id/blocks', 'userBlocks'],
  ['GET', '/api/admin/users/:id/audit', 'userAudit'],
  ['GET', '/api/admin/users/:id/avatar', 'userAvatar'],
  ['GET', '/api/admin/sessions', 'listSessions'],
  ['DELETE', '/api/admin/sessions/:id', 'revokeSession'],
  ['GET', '/api/admin/roles', 'roles'],
  ['PUT', '/api/admin/roles/:role', 'updateRole'],
  ['POST', '/api/admin/roles/:role/reset', 'resetRole'],
  ['GET', '/api/admin/audit', 'audit'],
  ['GET', '/api/admin/system', 'system'],
  ['GET', '/api/admin/settings', 'settings'],
  ['PATCH', '/api/admin/settings', 'updateSettings'],
]);

// Операции с телом запроса: остальные тело не читают.
const WITH_BODY = new Set(['createUser', 'bulk', 'updateUser', 'deleteUser', 'setRole', 'block', 'updateRole', 'updateSettings']);

const collectSystemInfo = async () => (await import('./systemInfo.js')).collectSystemInfo();

export const createAdminHandler = ({ getContext = getAccountContext, limit = defaultLimit, systemInfo = collectSystemInfo } = {}) =>
  async function adminHandler(req, res) {
    const url = req.originalUrl || req.url;
    const match = route(req.method, pathOf(url));
    if (!match.operation) {
      if (match.allow) res.setHeader('Allow', match.allow.join(', '));
      respondJson(res, match.status, { error: match.status === 405 ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }
    const { operation, params } = match;

    const allowed = limit(getClientIp(req));
    if (!allowed.allowed) {
      res.setHeader('Retry-After', String(allowed.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов. Подождите немного.', code: 'rate_limited' });
      return;
    }
    if (req.method !== 'GET' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
      return;
    }

    const context = await getContext();
    if (!context) {
      respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен.', code: 'accounts_unavailable' });
      return;
    }
    const auth = requireSession(req, res, context.accounts);
    if (!auth) return;
    const actor = { ...auth.user, permissions: auth.permissions };
    if (!actor.permissions.includes('admin.access')) {
      respondJson(res, 403, { error: 'Нет доступа к админ-панели.', code: 'forbidden' });
      return;
    }

    const { admin } = context;
    const query = queryOf(url);
    try {
      const body = WITH_BODY.has(operation) ? await readJsonObject(req, MAX_BODY_BYTES) : {};
      let result;
      switch (operation) {
        case 'me': result = admin.me(actor); break;
        case 'dashboard': result = await admin.dashboard(actor, query.period); break;
        case 'listUsers': result = admin.listUsers(actor, query); break;
        case 'createUser': result = await admin.createUser(actor, body); res.statusCode = 201; break;
        case 'exportUsers': {
          const { csv, count } = admin.exportUsers(actor, query);
          const stamp = new Date().toISOString().slice(0, 10);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="medkarta-users-${stamp}.csv"`);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-Export-Count', String(count));
          res.end(csv);
          return;
        }
        case 'bulk': result = admin.bulk(actor, body); break;
        case 'getUser': result = admin.getUser(actor, params.id); break;
        case 'updateUser': result = admin.updateUser(actor, params.id, body); break;
        case 'deleteUser': result = await admin.deleteUser(actor, params.id, body); break;
        case 'setRole': result = admin.setRole(actor, params.id, body); break;
        case 'block': result = admin.block(actor, params.id, body); break;
        case 'unblock': result = admin.unblock(actor, params.id); break;
        case 'archive': result = admin.archive(actor, params.id); break;
        case 'restore': result = admin.restore(actor, params.id); break;
        case 'resetPassword': result = await admin.resetPassword(actor, params.id); break;
        case 'requirePasswordChange': result = admin.requirePasswordChange(actor, params.id); break;
        case 'revokeUserSessions': result = admin.revokeUserSessions(actor, params.id); break;
        case 'userSessions': result = admin.userSessions(actor, params.id); break;
        case 'userLogins': result = admin.userLogins(actor, params.id, query); break;
        case 'userBlocks': result = admin.userBlocks(actor, params.id); break;
        case 'userAudit': result = admin.userAudit(actor, params.id, query); break;
        case 'userAvatar': {
          admin.getUser(actor, params.id);
          const image = context.accounts.getAvatar(params.id);
          if (!image) {
            respondJson(res, 404, { error: 'Аватара нет.', code: 'not_found' });
            return;
          }
          sendImage(req, res, image, { versioned: Boolean(query.v) });
          return;
        }
        case 'listSessions': result = admin.listSessions(actor, query); break;
        case 'revokeSession': result = admin.revokeSession(actor, params.id); break;
        case 'roles': result = admin.roles(actor); break;
        case 'updateRole': result = admin.updateRolePermissions(actor, params.role, body); break;
        case 'resetRole': result = admin.resetRolePermissions(actor, params.role); break;
        case 'audit': result = admin.listAudit(actor, query); break;
        case 'system':
          if (!actor.permissions.includes('system.view')) {
            respondJson(res, 403, { error: 'Недостаточно прав.', code: 'forbidden' });
            return;
          }
          result = await systemInfo();
          break;
        case 'settings': result = admin.settings(actor); break;
        case 'updateSettings': result = admin.updateSettings(actor, body); break;
        default:
          respondJson(res, 404, { error: 'Not found' });
          return;
      }
      if (req.method !== 'GET') logger.event('admin.action', { action: operation, status: 'ok' });
      respondJson(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, result);
    } catch (error) {
      if (req.method !== 'GET') logger.event('admin.action', { action: operation, status: 'failed', code: error?.code || 'error' });
      sendError(res, error, 'admin.request_failed');
    }
  };

export const ADMIN_PREFIX = '/api/admin';
export default createAdminHandler();
