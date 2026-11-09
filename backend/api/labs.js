/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории: каталог, подбор корзины, расписание и демо-запись.
 *
 *   GET  /api/labs/catalog               — исследования, категории, лаборатории, филиалы
 *   GET  /api/labs/tests/:code           — исследование: подготовка, где сделать, пример бланка
 *   GET  /api/labs/labs                  — лаборатории с филиалами
 *   GET  /api/labs/labs/:id              — лаборатория: филиалы, часы, цены
 *   GET  /api/labs/branches/:id          — филиал: цены и процедуры
 *   POST /api/labs/quote                 — подбор: полная стоимость корзины по филиалам
 *   GET  /api/labs/slots?branchId=…      — расписание филиала (и стоимость корзины в нём: tests=…)
 *   POST /api/labs/bookings              — записаться (идемпотентно)
 *   POST /api/labs/bookings/cancel       — отменить запись
 *   POST /api/labs/bookings/lookup       — состояние своих записей по номерам и токенам
 *   GET  /api/labs/bookings/mine         — записи вошедшего пользователя
 *
 * Всё — демонстрация: в лаборатории ничего не уходит. Персональных данных нет ни в
 * запросах, ни в базе: запись — номер, слот, состав и код отмены. Точка
 * отправления для подбора — как у /api/booking/search: только в памяти на время ответа.
 */

import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { createRouter } from '../http/router.js';
import { logger } from '../observability/safeLogger.js';
import { getDefaultLabService } from '../labs/service.js';
import { LabError } from '../labs/store.js';
import { currentAccountUser } from './account.js';

const MAX_BODY_BYTES = 16 * 1024;

// Те же пределы, что у записи к врачам: гость не займёт всё расписание демо.
const defaultReadLimit = createRateLimiter({ maxPerIp: 600, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });
const defaultQuoteLimit = createRateLimiter({ maxPerIp: 120, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });
const defaultWriteLimit = createRateLimiter({ maxPerIp: 60, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });
const defaultBookLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, maxPerIp: 10, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });

const route = createRouter([
  ['GET', '/api/labs/catalog', 'catalog'],
  ['GET', '/api/labs/tests/:code', 'test'],
  ['GET', '/api/labs/labs', 'labs'],
  ['GET', '/api/labs/labs/:id', 'lab'],
  ['GET', '/api/labs/branches/:id', 'branch'],
  ['POST', '/api/labs/quote', 'quote'],
  ['GET', '/api/labs/slots', 'slots'],
  ['POST', '/api/labs/bookings', 'book'],
  ['POST', '/api/labs/bookings/cancel', 'cancel'],
  ['POST', '/api/labs/bookings/lookup', 'lookup'],
  ['GET', '/api/labs/bookings/mine', 'mine'],
]);
export const LABS_PREFIX = '/api/labs';

const ERROR_STATUS = Object.freeze({ bad_request: 400, validation: 400 });

const pathOf = (url) => {
  const raw = String(url || '');
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
};

/* Как у кабинета и записи к врачам: JSON, свой Origin, Sec-Fetch-Site. */
const isTrustedWrite = (req) => {
  if (!verifyOrigin(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
};

export const createLabsHandler = ({
  getService = getDefaultLabService,
  readLimit = defaultReadLimit,
  quoteLimit = defaultQuoteLimit,
  writeLimit = defaultWriteLimit,
  bookLimit = writeLimit === defaultWriteLimit ? defaultBookLimit : writeLimit,
  getAccountUser = currentAccountUser,
} = {}) =>
  async function labsHandler(req, res) {
    const url = req.originalUrl || req.url;
    const match = route(req.method, pathOf(url));
    if (!match.operation) {
      if (match.allow) res.setHeader('Allow', match.allow.join(', '));
      respondJson(res, match.status, { error: match.status === 405 ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }
    const { operation, params } = match;
    const limiter = operation === 'quote' ? quoteLimit : operation === 'book' ? bookLimit : ['cancel', 'lookup'].includes(operation) ? writeLimit : readLimit;
    const limit = limiter(getClientIp(req));
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
      respondJson(res, 404, { error: 'Раздел лабораторий выключен.', code: 'labs_disabled' });
      return;
    }
    let body = {};
    if (req.method === 'POST') {
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        respondJson(res, error.status || 400, { error: 'Некорректный запрос.' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        respondJson(res, 400, { error: 'Некорректный запрос.' });
        return;
      }
    }
    const query = new URL(url, 'http://localhost').searchParams;
    const accountUser = async () => {
      try {
        return await getAccountUser(req);
      } catch (error) {
        logger.error('labs.account_lookup_failed', error);
        return null;
      }
    };
    try {
      switch (operation) {
        case 'catalog': respondJson(res, 200, service.catalog()); return;
        case 'test': respondJson(res, 200, service.test(params.code)); return;
        case 'labs': respondJson(res, 200, service.labs()); return;
        case 'lab': respondJson(res, 200, service.lab(params.id)); return;
        case 'branch': respondJson(res, 200, service.branch(params.id)); return;
        case 'quote': {
          const result = await service.quote(body.request || body);
          logger.event('labs.quote', { status: result.status, count: result.total || 0 });
          respondJson(res, result.status === 'invalid' ? 400 : 200, result);
          return;
        }
        case 'slots': {
          const tests = (query.get('tests') || '').split(',').filter(Boolean);
          respondJson(res, 200, service.schedule({ branchId: query.get('branchId') || '', from: query.get('from'), days: query.get('days'), tests }));
          return;
        }
        case 'book': {
          const owner = await accountUser();
          const booking = service.book({
            branchId: body.branchId, slotId: body.slotId, testCodes: body.tests, idempotencyKey: body.idempotencyKey,
            expectedTotal: Number.isInteger(body.expectedTotal) ? body.expectedTotal : null, accountId: owner?.id || null,
          });
          logger.event('labs.booking', { status: booking.repeated ? 'repeated' : 'created' });
          respondJson(res, booking.repeated ? 200 : 201, { booking });
          return;
        }
        case 'cancel': {
          const result = service.cancel({ number: body.number, cancelToken: body.cancelToken });
          logger.event('labs.cancel', { status: result.alreadyCancelled ? 'repeated' : 'cancelled' });
          respondJson(res, 200, { booking: result, slotReleased: result.slotReleased, alreadyCancelled: result.alreadyCancelled });
          return;
        }
        case 'lookup': respondJson(res, 200, { bookings: service.lookup({ items: Array.isArray(body.items) ? body.items : [] }) }); return;
        case 'mine': {
          const owner = await accountUser();
          if (!owner) {
            respondJson(res, 401, { error: 'Войдите в личный кабинет.' });
            return;
          }
          respondJson(res, 200, { bookings: service.listForAccount({ accountId: owner.id }) });
          return;
        }
        default:
          respondJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      if (error instanceof LabError) {
        logger.event('labs.rejected', { code: error.code });
        respondJson(res, error.status || ERROR_STATUS[error.code] || 400, { error: error.message, code: error.code });
        return;
      }
      logger.error('labs.error', error);
      respondJson(res, 500, { error: 'Не получилось. Попробуйте ещё раз.' });
    }
  };

export default createLabsHandler();
