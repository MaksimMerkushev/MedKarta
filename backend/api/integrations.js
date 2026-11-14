/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * POST /api/integrations/<интеграция>/webhook — события от МИС (смена
 * расписания, статус записи). Запрос приходит от сервера МИС, а не из
 * браузера, поэтому вместо проверки Origin — подпись: её проверяет адаптер
 * этой МИС (схема — поставщика). Сырое тело не больше 64 КБ, повтор события
 * не применяется, частота ограничена. Без MIS_INTEGRATIONS=on адреса нет.
 */

import { getDefaultMisRuntime } from '../booking/mis/default.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { respondJson } from '../http/request.js';
import { logger } from '../observability/safeLogger.js';

export const INTEGRATIONS_PREFIX = '/api/integrations';
const MAX_WEBHOOK_BYTES = 64 * 1024;
const PATH = /^\/api\/integrations\/([a-z][a-z0-9-]{1,39})\/webhook$/;

const readRaw = (req, maxBytes) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      reject(Object.assign(new Error('too large'), { status: 413 }));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

export const createIntegrationsHandler = ({
  getRuntime = getDefaultMisRuntime,
  limit = createRateLimiter({ maxPerIp: 120, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true }),
} = {}) => async function integrationsHandler(req, res) {
  const raw = String(req.originalUrl || req.url || '');
  const match = PATH.exec(raw.split(/[?#]/)[0]);
  if (!match) {
    respondJson(res, 404, { error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    respondJson(res, 405, { error: 'Метод не поддерживается.' });
    return;
  }
  if (!limit(getClientIp(req)).allowed) {
    respondJson(res, 429, { error: 'Слишком много запросов.' });
    return;
  }
  const mis = await getRuntime();
  if (!mis) {
    respondJson(res, 404, { error: 'Not found' });
    return;
  }
  let rawBody;
  try {
    rawBody = await readRaw(req, MAX_WEBHOOK_BYTES);
  } catch (error) {
    respondJson(res, error.status || 400, { error: 'Тело запроса не принято.' });
    return;
  }
  try {
    const result = await mis.runtime.handleWebhook(match[1], { headers: req.headers, rawBody });
    logger.event('mis.webhook', { status: String(result.status), action: result.duplicate ? 'duplicate' : 'applied' });
    respondJson(res, result.status, result.status === 200 ? { ok: true, duplicate: Boolean(result.duplicate) } : { error: 'Событие не принято.' });
  } catch (error) {
    logger.error('mis.webhook_failed', error);
    respondJson(res, 500, { error: 'Событие не принято.' });
  }
};

export default createIntegrationsHandler();
