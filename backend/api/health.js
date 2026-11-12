/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * GET /api/health — жив ли сервер и его база, для внешней проверки работоспособности.
 * Наружу только статус: без версий, путей и счётчиков. Результат кэшируется на
 * несколько секунд, поэтому частые запросы не нагружают базу.
 */

import { timingSafeEqual } from 'node:crypto';

import { respondJson } from '../http/request.js';
import { logger } from '../observability/safeLogger.js';

const CACHE_MS = 5_000;
const CHECK_TIMEOUT_MS = 3_000;

/* Аккаунты могут быть выключены (ACCOUNTS=off): тогда проверять нечего. */
const defaultCheck = async () => {
  const { getAccountContext } = await import('./accountContext.js');
  const context = await getAccountContext();
  return context?.admin ? context.admin.storageHealth().ok !== false : true;
};

export const createHealthHandler = ({ check = defaultCheck, now = () => Date.now() } = {}) => {
  let cached = null;
  const run = async () => {
    try {
      return await Promise.race([
        check(),
        new Promise((resolve) => { setTimeout(resolve, CHECK_TIMEOUT_MS, false).unref?.(); }),
      ]);
    } catch (error) {
      logger.error('health.check_failed', error);
      return false;
    }
  };
  return async function healthHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      respondJson(res, 405, { error: 'Метод не поддерживается.' });
      return;
    }
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), ok: Boolean(await run()) };
    respondJson(res, cached.ok ? 200 : 503, { status: cached.ok ? 'ok' : 'degraded' });
  };
};

export const healthHandler = createHealthHandler();

/*
 * GET /api/health/ready — готовность для внешнего мониторинга: статусы
 * компонентов (ok / error / off), без подробностей, версий и счётчиков.
 * Только с заголовком «Authorization: Bearer <MONITOR_TOKEN>»; если
 * MONITOR_TOKEN не задан, адреса нет (404). Ответ кэшируется на 30 с.
 * degraded — если ошибка у базы аккаунтов, внешней модели (когда она
 * настроена) или резервных копий (когда задан BACKUP_DIR).
 */
const READY_CACHE_MS = 30_000;
const CRITICAL = new Set(['accounts', 'ai', 'backups', 'booking', 'routing']);

const tokenMatches = (header, token) => {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(String(token));
  return given.length === expected.length && timingSafeEqual(given, expected);
};

export const createReadyHandler = ({
  collect = async () => (await import('./systemInfo.js')).collectComponentHealth(),
  token = () => process.env.MONITOR_TOKEN || '',
  now = () => Date.now(),
} = {}) => {
  let cached = null;
  return async function readyHandler(req, res) {
    const secret = token();
    if (!secret) {
      respondJson(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      respondJson(res, 405, { error: 'Метод не поддерживается.' });
      return;
    }
    if (!tokenMatches(req.headers.authorization, secret)) {
      respondJson(res, 401, { error: 'Нужен токен мониторинга.' });
      return;
    }
    if (!cached || now() - cached.at >= READY_CACHE_MS) {
      let components = [];
      try {
        components = (await collect()).components || [];
      } catch (error) {
        logger.error('health.ready_failed', error);
      }
      const statuses = Object.fromEntries(components.map((item) => [item.key, item.status]));
      const degraded = components.length === 0 || components.some((item) => CRITICAL.has(item.key) && item.status === 'error');
      cached = { at: now(), body: { status: degraded ? 'degraded' : 'ok', components: statuses } };
    }
    respondJson(res, cached.body.status === 'ok' ? 200 : 503, cached.body);
  };
};

export const readyHandler = createReadyHandler();
