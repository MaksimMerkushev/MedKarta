/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-запись: строгий подбор, расписание врача, удержание слота, запись,
 * отмена. Работает только при DEMO_DATA=on.
 *
 *   POST /api/demo/search            — строгий подбор по условиям
 *   GET  /api/demo/slots             — расписание врача с состояниями слотов
 *   POST /api/demo/hold              — удержать слот на время подтверждения
 *   POST /api/demo/release           — снять своё удержание
 *   POST /api/demo/bookings          — записаться (идемпотентно)
 *   POST /api/demo/bookings/cancel   — отменить запись
 *   POST /api/demo/bookings/lookup   — состояние своих записей по номерам и токенам
 *   GET  /api/demo/bookings/mine     — записи вошедшего пользователя
 *
 * Это симуляция: ничего не уходит в МИС, клиники, страховые и уведомления.
 * Персональных данных пациента нет ни в запросах, ни в базе. Запись, сделанная
 * из личного кабинета, привязана к его id: её видит только этот аккаунт, а у
 * гостя записи живут в браузере. Точку отправления сервер получает так же,
 * как /api/route, и не пишет её никуда.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BookingError, createBookingStore, loadSqlite } from '../demo/bookingStore.js';
import { getDemoCatalog } from '../demo/catalog.js';
import { createDemoSearch } from '../demo/search.js';
import { addDays, demoNow, isDay, moscowDay, moscowParts } from '../demo/time.js';
import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { currentAccountUser } from './account.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { logger } from '../observability/safeLogger.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAX_BODY_BYTES = 16 * 1024;

/* Подбор считает время в пути — дороже чтения; запись — реже всего. */
const defaultSearchLimit = createRateLimiter({ maxPerIp: 120, maxPerInstance: Number.POSITIVE_INFINITY });
const defaultReadLimit = createRateLimiter({ maxPerIp: 600, maxPerInstance: Number.POSITIVE_INFINITY });
const defaultWriteLimit = createRateLimiter({ maxPerIp: 60, maxPerInstance: Number.POSITIVE_INFINITY });

const ROUTES = new Map([
  ['/api/demo/search', { POST: 'search' }],
  ['/api/demo/slots', { GET: 'slots' }],
  ['/api/demo/hold', { POST: 'hold' }],
  ['/api/demo/release', { POST: 'release' }],
  ['/api/demo/bookings', { POST: 'book' }],
  ['/api/demo/bookings/cancel', { POST: 'cancel' }],
  ['/api/demo/bookings/lookup', { POST: 'lookup' }],
  ['/api/demo/bookings/mine', { GET: 'mine' }],
]);
export const DEMO_BOOKING_PATHS = Object.freeze([...ROUTES.keys()]);

const ERROR_STATUS = Object.freeze({
  bad_request: 400,
  slot_not_found: 404,
  booking_not_found: 404,
  slot_taken: 409,
  slot_held: 409,
  slot_unavailable: 409,
  slot_past: 409,
  slot_conflict: 409,
  idempotency_conflict: 409,
});

const pathOf = (url) => {
  const raw = String(url || '');
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
};

/* Та же защита от подделки запроса, что у кабинета: JSON, свой Origin, Sec-Fetch-Site. */
const isTrustedWrite = (req) => {
  if (!verifyOrigin(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  return /^application\/json\b/i.test(String(req.headers['content-type'] || ''));
};

export const createDemoBookingService = ({ index, store, getEngine, now }) => {
  const search = createDemoSearch({ index, store, getEngine, now });

  /** Запись с подробностями: врач, клиника, услуга, цена, покрытие. */
  const describe = (view) => {
    if (!view?.slot) return view;
    const doctor = index.doctors.get(view.slot.doctorId);
    const { clinic, branch } = index.branches.get(view.slot.branchId);
    const service = index.services.get(view.slot.serviceId);
    const patient = doctor.ageGroups.length === 1 ? doctor.ageGroups[0] : 'adult';
    const coverage = view.planId
      ? search.coverageOf(view.planId, { doctor, branchId: branch.id, serviceId: service.id, patient, today: view.slot.day })
      : null;
    return {
      ...view,
      demo: true,
      doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty },
      clinic: { id: clinic.id, name: clinic.name, branchId: branch.id, branchName: branch.name, address: branch.address, lat: branch.lat, lng: branch.lng, phone: branch.phone || null, real: Boolean(clinic.real) },
      service: { id: service.id, name: service.name, durationMinutes: service.durationMinutes },
      price: index.priceOf(branch.id, service.id),
      coverage,
    };
  };

  return Object.freeze({ index, store, search, describe, now });
};

let defaultService;

/** Сервис по умолчанию: включён при DEMO_DATA=on, DEMO_BOOKING≠off и наличии node:sqlite. */
export const getDefaultDemoBookingService = () => {
  if (defaultService === undefined) {
    defaultService = (async () => {
      if (process.env.DEMO_DATA !== 'on' || process.env.DEMO_BOOKING === 'off') return null;
      const DatabaseSync = await loadSqlite();
      if (!DatabaseSync) {
        logger.warn('demo.booking_unavailable', { status: 'node:sqlite missing (Node 22.13+ required)' });
        return null;
      }
      const index = await getDemoCatalog();
      const file = process.env.DEMO_BOOKING_DB_PATH || path.join(ROOT, 'var', 'demo', 'booking.sqlite');
      const now = () => demoNow();
      const store = createBookingStore({ DatabaseSync, file, index, now });
      const { getDefaultRoutingEngine } = await import('../routing/engine.js');
      const getEngine = async () => {
        try {
          return await getDefaultRoutingEngine();
        } catch {
          return null;
        }
      };
      logger.event('demo.booking_ready', { status: 'enabled', count: index.catalog.doctors.length });
      return createDemoBookingService({ index, store, getEngine, now });
    })().catch((error) => {
      logger.error('demo.booking_failed', error);
      defaultService = undefined;
      return null;
    });
  }
  return defaultService;
};

export const createDemoBookingHandler = ({
  getService = getDefaultDemoBookingService,
  searchLimit = defaultSearchLimit,
  readLimit = defaultReadLimit,
  writeLimit = defaultWriteLimit,
  getAccountUser = currentAccountUser,
} = {}) =>
  async function demoBookingHandler(req, res) {
    const url = req.originalUrl || req.url;
    const route = ROUTES.get(pathOf(url));
    const operation = route?.[req.method];
    if (!route || !operation) {
      res.setHeader('Allow', route ? Object.keys(route).join(', ') : 'GET');
      respondJson(res, 405, { error: 'Метод не поддерживается.' });
      return;
    }

    const limiter = operation === 'search' ? searchLimit : ['slots', 'lookup', 'mine'].includes(operation) ? readLimit : writeLimit;
    const limit = limiter(getClientIp(req));
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов. Подождите немного.' });
      return;
    }
    if (req.method !== 'GET' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.' });
      return;
    }

    const service = await getService();
    if (!service) {
      respondJson(res, 404, { error: 'Демо-запись выключена.', code: 'demo_disabled' });
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

    const at = service.now();
    // Кабинет недоступен или сломан — запись работает как у гостя.
    const accountUser = async () => {
      try {
        return await getAccountUser(req);
      } catch (error) {
        logger.error('demo.account_lookup_failed', error);
        return null;
      }
    };
    try {
      switch (operation) {
        case 'search': {
          const result = await service.search.search(body.request || body);
          logger.event('demo.search', { status: result.status, count: result.total || 0 });
          respondJson(res, 200, result);
          return;
        }
        case 'slots': {
          const params = new URL(url, 'http://localhost').searchParams;
          const doctorId = params.get('doctorId') || '';
          const doctor = service.index.doctors.get(doctorId);
          if (!doctor) {
            respondJson(res, 404, { error: 'Врач не найден.', code: 'doctor_not_found' });
            return;
          }
          const branchId = params.get('branchId');
          if (branchId && !doctor.branchIds.includes(branchId)) {
            respondJson(res, 404, { error: 'Врач не принимает в этом филиале.', code: 'branch_not_found' });
            return;
          }
          const today = moscowDay(at);
          const from = isDay(params.get('from')) && params.get('from') >= today ? params.get('from') : today;
          const days = Math.min(Math.max(Number(params.get('days')) || 7, 1), 14);
          const schedule = service.store.doctorSchedule({ doctorId, branchId, fromDay: from, toDay: addDays(from, days - 1), at });
          const branch = branchId || doctor.branchIds[0];
          // Покрытие ДМС — по выбранной программе, для каждой услуги врача в этом филиале.
          const planId = service.index.plans.has(params.get('planId')) ? params.get('planId') : null;
          const patient = params.get('patient') === 'child' && doctor.ageGroups.includes('child')
            ? 'child'
            : doctor.ageGroups.includes('adult') ? 'adult' : 'child';
          respondJson(res, 200, {
            demo: true,
            timezone: 'Europe/Moscow',
            now: { day: today, time: moscowParts(at).time },
            doctor: { id: doctor.id, name: doctor.name, specialty: doctor.specialty, ageGroups: doctor.ageGroups, branchIds: doctor.branchIds, hoursByBranch: doctor.hoursByBranch },
            services: doctor.serviceIds.map((id) => service.index.services.get(id)),
            prices: Object.fromEntries(doctor.serviceIds.map((id) => [id, service.index.priceOf(branch, id)])),
            coverage: planId
              ? Object.fromEntries(doctor.serviceIds.map((id) => [id, service.search.coverageOf(planId, { doctor, branchId: branch, serviceId: id, patient, today })]))
              : null,
            ...schedule,
          });
          return;
        }
        case 'hold': {
          const result = service.store.hold({ slotId: body.slotId, at });
          logger.event('demo.hold', { status: 'ok' });
          respondJson(res, 200, result);
          return;
        }
        case 'release': {
          respondJson(res, 200, { released: service.store.release({ slotId: body.slotId, holdToken: body.holdToken, at }) });
          return;
        }
        case 'book': {
          const planId = typeof body.planId === 'string' && service.index.plans.has(body.planId) ? body.planId : null;
          const owner = await accountUser();
          const booking = service.store.book({ slotId: body.slotId, holdToken: body.holdToken || null, idempotencyKey: body.idempotencyKey, planId, accountId: owner?.id || null, at });
          logger.event('demo.booking', { status: booking.repeated ? 'repeated' : 'created' });
          // owned — запись привязана к кабинету; иначе номер и код отмены хранит браузер.
          respondJson(res, booking.repeated ? 200 : 201, { booking: service.describe(booking) });
          return;
        }
        case 'cancel': {
          const result = service.store.cancel({ number: body.number, cancelToken: body.cancelToken, at });
          logger.event('demo.cancel', { status: result.alreadyCancelled ? 'repeated' : 'cancelled' });
          respondJson(res, 200, { booking: service.describe(result), slotReleased: result.slotReleased, alreadyCancelled: result.alreadyCancelled });
          return;
        }
        case 'lookup': {
          const items = Array.isArray(body.items) ? body.items : [];
          respondJson(res, 200, { bookings: service.store.lookup({ items, at }).map((item) => (item.found ? service.describe(item) : item)) });
          return;
        }
        case 'mine': {
          const owner = await accountUser();
          if (!owner) {
            respondJson(res, 401, { error: 'Войдите в личный кабинет.' });
            return;
          }
          respondJson(res, 200, { bookings: service.store.listForAccount({ accountId: owner.id, at }).map(service.describe) });
          return;
        }
        default:
          respondJson(res, 405, { error: 'Метод не поддерживается.' });
      }
    } catch (error) {
      if (error instanceof BookingError) {
        logger.event('demo.booking_rejected', { code: error.code });
        respondJson(res, ERROR_STATUS[error.code] || 400, { error: error.message, code: error.code });
        return;
      }
      logger.error('demo.booking_error', error);
      respondJson(res, 500, { error: 'Не получилось. Попробуйте ещё раз.' });
    }
  };

const demoBookingHandler = createDemoBookingHandler();
export default demoBookingHandler;
