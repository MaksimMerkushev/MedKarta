/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * GET /api/health — жив ли сервер и его база, для внешней проверки работоспособности.
 * Наружу только статус: без версий, путей и счётчиков. Результат кэшируется на
 * несколько секунд, поэтому частые запросы не нагружают базу.
 */

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
