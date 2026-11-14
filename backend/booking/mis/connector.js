/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Коннектор МИС — реализация общего контракта (connectors/contract.js) поверх
 * адаптера конкретной МИС и журнала операций (mis/ledger.js).
 *
 * Главное правило: пациенту не сообщается «запись подтверждена», пока МИС
 * этого не подтвердила. Поэтому:
 *   — у каждой записи наш ключ запроса (idempotencyKey) и операция в журнале;
 *     повтор с тем же ключом — та же операция, второй записи в МИС нет;
 *   — активная операция на слот одна (частичный индекс): два одновременных
 *     запроса на один слот не уходят в МИС оба;
 *   — перед записью слот перечитывается в МИС: устаревшее расписание не
 *     превращается в запись;
 *   — отказ, после которого записи точно нет (слот занят, неверный запрос),
 *     — failed; исход неизвестен (тайм-аут, обрыв, непонятный ответ) —
 *     pending_reconciliation: «статус уточняется», и запись выясняется сверкой
 *     (поиск по нашему requestId или по внешнему id), а не повтором вслепую.
 *     Повтор записи допустим, только если МИС объявила idempotentBook.
 *
 * Удержание: если МИС умеет — настоящее (hold/release). Если нет —
 * «виртуальное»: слот перечитывается и выдаётся подписанный токен, но в МИС
 * время за пациентом не держится — перед записью свежесть проверяется снова.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { defineConnector } from '../connectors/contract.js';
import { BookingError } from '../errors.js';
import { moscowParts } from '../../demo/time.js';
import { MisError, publicStatus, STATE_TEXT, toBookingError } from './core.js';
import { MIS_NUMBER } from './ledger.js';
import { normalizeBookingStatus, normalizeSlots } from './normalize.js';

const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,80}$/;
const SLOT_PREFIX = 'mis.';
const VIRTUAL_HOLD_MS = 5 * 60 * 1000;
const RECONCILE_DELAY_MS = 30 * 1000;
const RECONCILE_ATTEMPTS = 4;

/* Ссылка на слот: интеграция + внешний слот, врач, филиал, услуга и время. Подделанная ссылка не проходит перечитывание в МИС. */
export const encodeSlotId = (integrationId, ref) => `${SLOT_PREFIX}${integrationId}.${Buffer.from(JSON.stringify(ref)).toString('base64url')}`;
export const decodeSlotId = (slotId) => {
  if (typeof slotId !== 'string' || !slotId.startsWith(SLOT_PREFIX) || slotId.length > 600) return null;
  const rest = slotId.slice(SLOT_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 2) return null;
  try {
    const ref = JSON.parse(Buffer.from(rest.slice(dot + 1), 'base64url').toString('utf8'));
    if (!ref || typeof ref.e !== 'string' || typeof ref.d !== 'string' || typeof ref.b !== 'string' || !Number.isFinite(ref.s) || !Number.isFinite(ref.x)) return null;
    return { integrationId: rest.slice(0, dot), ref };
  } catch {
    return null;
  }
};
export const isMisSlotId = (slotId) => typeof slotId === 'string' && slotId.startsWith(SLOT_PREFIX);
export const isMisNumber = (number) => typeof number === 'string' && MIS_NUMBER.test(number);

/**
 * @param {object} deps
 * @param {object} deps.integration запись интеграции из журнала
 * @param {object} deps.adapter адаптер МИС (defineMisAdapter)
 * @param {object} deps.ledger журнал (createMisLedger)
 * @param {() => number} [deps.now]
 * @param {string} deps.holdSecret секрет подписи виртуального удержания
 */
export const createMisConnector = ({ integration, adapter, ledger, now = () => Date.now(), holdSecret, logger = null }) => {
  const id = integration.id;
  const event = (level, code, detail) => {
    try {
      ledger.event(id, level, code, detail);
    } catch (error) {
      logger?.error?.('mis.event_failed', error);
    }
  };

  const ownsBranch = (branchId) => ledger.toExternal(id, 'branch', branchId) !== null;

  /* ------------------------------- Слоты ------------------------------- */

  const toSlot = (slot, at) => {
    const doctorId = ledger.toInternal(id, 'doctor', slot.doctorId);
    const branchId = ledger.toInternal(id, 'branch', slot.branchId);
    const serviceId = slot.serviceId ? ledger.toInternal(id, 'service', slot.serviceId) : (integration.config.defaultService?.[doctorId] ?? null);
    if (!doctorId || !branchId) return { reason: 'unmapped_doctor_or_branch' };
    if (!serviceId) return { reason: 'unmapped_service' };
    const startAt = Date.parse(slot.startAt);
    const endAt = Date.parse(slot.endAt);
    const start = moscowParts(startAt);
    return {
      value: {
        id: encodeSlotId(id, { e: slot.externalId, d: slot.doctorId, b: slot.branchId, v: slot.serviceId, s: startAt, x: endAt }),
        clinicId: integration.clinicId, branchId, doctorId, serviceId,
        day: start.day, start: start.time, end: moscowParts(endAt).time,
        startAt: new Date(startAt).toISOString(), endAt: new Date(endAt).toISOString(),
        status: slot.free ? 'FREE' : 'BOOKED', bookable: slot.free && startAt > at, past: startAt <= at,
        updatedAt: new Date(at).toISOString(), source: 'mis', integrationId: id,
      },
    };
  };

  const fetchSlots = async ({ doctorIds, branchIds, from, to, at }) => {
    const raw = await adapter.listSlots({ doctorIds, branchIds, from, to });
    const { valid, rejected } = normalizeSlots(raw, { window: { from: from - 60_000, to: to + 60_000 }, now: at });
    if (rejected.length) event('warn', 'invalid_slots', `${rejected.length}: ${[...new Set(rejected.map((item) => item.reason))].join(', ')}`);
    return valid;
  };

  const listSlots = async ({ pairs, fromDay, toDay, at = now() }) => {
    const mapped = pairs.map((pair) => ({ pair, doctor: ledger.toExternal(id, 'doctor', pair.doctorId), branch: ledger.toExternal(id, 'branch', pair.branchId) }))
      .filter((item) => item.doctor && item.branch);
    if (!mapped.length) return [];
    const from = Date.parse(`${fromDay}T00:00:00+03:00`);
    const to = Date.parse(`${toDay}T23:59:59+03:00`);
    const wanted = new Set(mapped.map((item) => `${item.pair.doctorId}|${item.pair.branchId}`));
    const slots = await fetchSlots({ doctorIds: [...new Set(mapped.map((item) => item.doctor))], branchIds: [...new Set(mapped.map((item) => item.branch))], from, to, at });
    const out = [];
    const skipped = {};
    for (const slot of slots) {
      if (!slot.free) continue;
      const result = toSlot(slot, at);
      if (result.reason) {
        skipped[result.reason] = (skipped[result.reason] || 0) + 1;
        continue;
      }
      if (wanted.has(`${result.value.doctorId}|${result.value.branchId}`) && result.value.bookable) out.push(result.value);
    }
    for (const [reason, count] of Object.entries(skipped)) event('warn', reason, `слотов пропущено: ${count}`);
    return out;
  };

  /** Слот перечитывается в МИС; нет его или занят — null. */
  const freshSlot = async (slotId, at) => {
    const decoded = decodeSlotId(slotId);
    if (!decoded || decoded.integrationId !== id) return null;
    const { ref } = decoded;
    const slots = await fetchSlots({ doctorIds: [ref.d], branchIds: [ref.b], from: ref.s - 60_000, to: ref.s + 60_000, at });
    const found = slots.find((slot) => slot.externalId === ref.e);
    if (!found || Date.parse(found.startAt) !== ref.s) return null;
    const result = toSlot(found, at);
    return result.value && result.value.bookable ? { slot: result.value, ref } : null;
  };

  const checkSlot = async ({ slotId, at = now() }) => {
    try {
      return (await freshSlot(slotId, at))?.slot ?? null;
    } catch (error) {
      event('warn', 'check_slot_failed', error.code || 'error');
      return null;
    }
  };

  /* ----------------------------- Удержание ----------------------------- */

  const signHold = (payload) => createHmac('sha256', holdSecret).update(payload).digest('base64url');
  const virtualToken = (slotId, expiresAt) => {
    const payload = `${Buffer.from(slotId).toString('base64url')}.${expiresAt}`;
    return `v.${payload}.${signHold(payload)}`;
  };
  const virtualTokenValid = (token, slotId, at) => {
    const [kind, slotPart, expires, mac] = String(token || '').split('.');
    if (kind !== 'v' || !slotPart || !expires || !mac) return false;
    const expected = Buffer.from(signHold(`${slotPart}.${expires}`));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given) && Buffer.from(slotPart, 'base64url').toString() === slotId && Number(expires) > at;
  };

  const hold = async ({ slotId, at = now() }) => {
    let fresh;
    try {
      fresh = await freshSlot(slotId, at);
    } catch (error) {
      throw toBookingError(error);
    }
    if (!fresh) throw new BookingError('slot_taken', 'Это время уже занято.');
    if (!adapter.can.hold) {
      const expiresAt = at + VIRTUAL_HOLD_MS;
      return { holdToken: virtualToken(slotId, expiresAt), expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: VIRTUAL_HOLD_MS / 1000, slot: fresh.slot, guaranteed: false };
    }
    try {
      const result = await adapter.hold({ externalSlotId: fresh.ref.e, doctorId: fresh.ref.d, branchId: fresh.ref.b });
      const expiresAt = Math.min(Date.parse(result.expiresAt) || at + VIRTUAL_HOLD_MS, at + 15 * 60 * 1000);
      const holdToken = `h.${Buffer.from(String(result.holdRef)).toString('base64url')}.${signHold(`${slotId}|${result.holdRef}`)}`;
      return { holdToken, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: Math.round((expiresAt - at) / 1000), slot: fresh.slot, guaranteed: true };
    } catch (error) {
      event(error.outcome === 'definite' ? 'info' : 'warn', `hold_${error.code || 'error'}`, error.detail);
      throw toBookingError(error);
    }
  };
  const holdRefOf = (token, slotId) => {
    const [kind, ref, mac] = String(token || '').split('.');
    if (kind !== 'h' || !ref || !mac) return null;
    const holdRef = Buffer.from(ref, 'base64url').toString();
    const expected = Buffer.from(signHold(`${slotId}|${holdRef}`));
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given) ? holdRef : null;
  };
  const release = async ({ slotId, holdToken }) => {
    const holdRef = holdRefOf(holdToken, slotId);
    if (!holdRef || !adapter.can.hold) return false;
    try {
      await adapter.release({ holdRef });
      return true;
    } catch (error) {
      event('warn', 'release_failed', error.code || 'error');
      return false;
    }
  };

  /* ------------------------------- Вид записи ------------------------------- */

  const view = (op, extra = {}) => {
    const start = moscowParts(op.startAt);
    return {
      number: op.number,
      status: publicStatus(op.state),
      state: op.state,
      stateText: STATE_TEXT[op.state],
      createdAt: new Date(op.createdAt).toISOString(),
      cancelledAt: op.cancelledAt ? new Date(op.cancelledAt).toISOString() : null,
      planId: null,
      source: 'mis',
      simulator: adapter.simulator,
      slot: {
        id: op.slotId, clinicId: op.clinicId, branchId: op.branchId, doctorId: op.doctorId, serviceId: op.serviceId,
        day: start.day, start: start.time, end: moscowParts(op.endAt).time,
        startAt: new Date(op.startAt).toISOString(), endAt: new Date(op.endAt).toISOString(),
        status: op.state === 'confirmed' ? 'BOOKED' : 'UNKNOWN', bookable: false, past: op.startAt <= now(),
      },
      ...extra,
    };
  };

  /* -------------------------------- Сверка -------------------------------- */

  /** Выяснить исход операции с неизвестным результатом. Возвращает актуальную операцию. */
  const reconcile = async (op, { force = false } = {}) => {
    if (!['pending_reconciliation', 'cancel_pending'].includes(op.state)) return op;
    if (!force && op.reconcileAfter && op.reconcileAfter > now()) return op;
    let booking = null;
    try {
      if (op.externalBookingId && adapter.can.status) booking = await adapter.getBooking({ externalBookingId: op.externalBookingId });
      else if (adapter.can.findByRequest) booking = await adapter.findBookingByRequest({ requestId: op.id });
      else {
        event('warn', 'manual_reconciliation_required', op.number);
        ledger.deferReconcile(op.id, now() + RECONCILE_DELAY_MS * 10);
        return ledger.getOp(op.id);
      }
    } catch (error) {
      if (error instanceof MisError && error.code === 'not_found') booking = null;
      else {
        ledger.deferReconcile(op.id, now() + RECONCILE_DELAY_MS);
        event('warn', 'reconcile_failed', error.code || 'error');
        return ledger.getOp(op.id);
      }
    }
    const status = booking ? normalizeBookingStatus(booking.status) : null;
    if (op.state === 'pending_reconciliation') {
      if (status === 'confirmed' || status === 'completed') return ledger.transition(op.id, 'confirmed', { reason: 'reconciled', externalBookingId: booking.externalBookingId });
      if (status === 'cancelled') return ledger.transition(op.id, 'failed', { reason: 'reconciled_cancelled', externalBookingId: booking.externalBookingId });
      if (!booking && op.attempts + 1 >= RECONCILE_ATTEMPTS) {
        event('warn', 'reconcile_not_found', op.number);
        return ledger.transition(op.id, 'failed', { reason: 'not_found_after_reconcile' });
      }
      ledger.deferReconcile(op.id, now() + RECONCILE_DELAY_MS);
      return ledger.getOp(op.id);
    }
    // cancel_pending: отменена — cancelled; ещё активна — повторяем отмену (она идемпотентна по смыслу).
    if (status === 'cancelled' || (!booking && op.externalBookingId)) return ledger.transition(op.id, 'cancelled', { reason: 'reconciled' });
    if (status === 'confirmed') {
      try {
        await adapter.cancel({ externalBookingId: op.externalBookingId, requestId: `c-${op.id}` });
        return ledger.transition(op.id, 'cancelled', { reason: 'cancel_retried' });
      } catch {
        ledger.deferReconcile(op.id, now() + RECONCILE_DELAY_MS);
      }
    }
    return ledger.getOp(op.id);
  };

  /* -------------------------------- Запись -------------------------------- */

  const sendBooking = async (op, { holdRef = null, patient = null }) => {
    try {
      const result = await adapter.book({ externalSlotId: op.externalSlotId, requestId: op.id, holdRef, patient });
      const status = normalizeBookingStatus(result?.status);
      if (!result?.externalBookingId) throw new MisError('invalid_response', 'no_booking_id');
      if (status === 'confirmed') return ledger.transition(op.id, 'confirmed', { reason: 'mis_confirmed', externalBookingId: result.externalBookingId, attempt: true });
      // МИС приняла, но не подтвердила (например, запись ждёт клинику) — уточняем, а не обещаем.
      return ledger.transition(op.id, 'pending_reconciliation', { reason: `mis_status_${status || 'unknown'}`, externalBookingId: result.externalBookingId, attempt: true, reconcileAfter: now() + RECONCILE_DELAY_MS });
    } catch (error) {
      const misError = error instanceof MisError ? error : new MisError('unknown', error?.code || 'error');
      if (misError.outcome === 'definite') {
        ledger.transition(op.id, 'failed', { reason: misError.code, error: misError.code, attempt: true });
        event(misError.code === 'slot_taken' ? 'info' : 'warn', `book_${misError.code}`, misError.detail);
        throw toBookingError(misError);
      }
      event('warn', `book_${misError.code}`, 'исход неизвестен — сверка');
      return ledger.transition(op.id, 'pending_reconciliation', { reason: misError.code, error: misError.code, attempt: true, reconcileAfter: now() });
    }
  };

  const book = async ({ slotId, holdToken = null, idempotencyKey, accountId = null, at = now(), patient = null }) => {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY.test(idempotencyKey)) throw new BookingError('bad_request', 'Нужен ключ запроса (idempotencyKey).');
    const decoded = decodeSlotId(slotId);
    if (!decoded || decoded.integrationId !== id) throw new BookingError('bad_request', 'Неверный слот.');
    const existing = ledger.opByRequest(idempotencyKey);
    if (existing) {
      if (existing.slotId !== slotId) throw new BookingError('idempotency_conflict', 'Этот ключ запроса уже использован для другой записи.');
      const current = await reconcile(existing);
      return view(current, { cancelToken: ledger.cancelTokenFor(current.id), repeated: true, owned: Boolean(accountId && current.accountId === accountId) });
    }
    const holdRef = adapter.can.hold ? holdRefOf(holdToken, slotId) : null;
    if (!holdRef && !(holdToken && virtualTokenValid(holdToken, slotId, at)) && holdToken) throw new BookingError('slot_held', 'Удержание истекло — выберите время заново.');
    // Свежесть: слот перечитывается в МИС; с настоящим удержанием время держит сама МИС.
    if (!holdRef) {
      let fresh;
      try {
        fresh = await freshSlot(slotId, at);
      } catch (error) {
        throw toBookingError(error);
      }
      if (!fresh) throw new BookingError('slot_taken', 'Это время уже занято.');
    }
    const { ref } = decoded;
    const doctorId = ledger.toInternal(id, 'doctor', ref.d);
    const branchId = ledger.toInternal(id, 'branch', ref.b);
    if (!doctorId || !branchId) throw new BookingError('slot_not_found', 'Врач или филиал не сопоставлены с МедКартой.');
    const serviceId = ref.v ? ledger.toInternal(id, 'service', ref.v) : (integration.config.defaultService?.[doctorId] ?? null);
    const { op, existing: raced } = ledger.createOp({
      requestId: idempotencyKey, integrationId: id, slotId, externalSlotId: ref.e, doctorId, branchId,
      clinicId: integration.clinicId, serviceId, startAt: ref.s, endAt: ref.x, state: 'booking_pending', accountId,
    });
    if (raced) return view(await reconcile(op), { cancelToken: ledger.cancelTokenFor(op.id), repeated: true, owned: Boolean(accountId && op.accountId === accountId) });
    let current = await sendBooking(op, { holdRef, patient });
    if (current.state === 'pending_reconciliation') {
      current = await reconcile(current, { force: true });
      // Повтор той же записи безопасен только при идемпотентном API МИС, и только один раз.
      if (current.state === 'pending_reconciliation' && adapter.can.idempotentBook) {
        current = ledger.transition(current.id, 'booking_pending', { reason: 'idempotent_retry' });
        current = await sendBooking(current, { holdRef, patient });
      }
    }
    return view(current, { cancelToken: ledger.cancelTokenFor(current.id), repeated: false, owned: Boolean(accountId) });
  };

  /* -------------------------------- Отмена -------------------------------- */

  const cancel = async ({ number, cancelToken }) => {
    let op = isMisNumber(number) ? ledger.opByNumber(number) : null;
    if (!op || op.integrationId !== id || !ledger.tokenMatches(op.id, cancelToken)) throw new BookingError('booking_not_found', 'Запись не найдена.');
    op = await reconcile(op);
    if (op.state === 'cancelled' || op.state === 'failed') return { ...view(op), alreadyCancelled: true, slotReleased: false, slot: view(op).slot };
    if (op.state === 'pending_reconciliation' || op.state === 'booking_pending') throw new BookingError('booking_pending', 'Статус записи ещё уточняется — отменить можно после подтверждения.');
    if (!adapter.can.cancel) throw new BookingError('not_supported', 'Отменить эту запись онлайн нельзя — позвоните в клинику.');
    if (op.state === 'confirmed') op = ledger.transition(op.id, 'cancel_pending', { reason: 'user_cancel' });
    try {
      await adapter.cancel({ externalBookingId: op.externalBookingId, requestId: `c-${op.id}` });
      op = ledger.transition(op.id, 'cancelled', { reason: 'mis_cancelled' });
    } catch (error) {
      if (error instanceof MisError && error.code === 'not_found') op = ledger.transition(op.id, 'cancelled', { reason: 'mis_not_found' });
      else if (error instanceof MisError && error.outcome === 'definite') {
        op = ledger.transition(op.id, 'confirmed', { reason: `cancel_${error.code}` });
        throw toBookingError(error);
      } else {
        ledger.deferReconcile(op.id, now() + RECONCILE_DELAY_MS);
        event('warn', `cancel_${error.code || 'error'}`, 'исход неизвестен — сверка');
        op = ledger.getOp(op.id);
      }
    }
    const result = view(op);
    return { ...result, alreadyCancelled: false, slotReleased: op.state === 'cancelled', slot: result.slot };
  };

  /* --------------------------- Статус и кабинет --------------------------- */

  const status = async ({ items }) => Promise.all((items || []).slice(0, 20).map(async ({ number, cancelToken }) => {
    const op = isMisNumber(number) ? ledger.opByNumber(number) : null;
    if (!op || op.integrationId !== id || !ledger.tokenMatches(op.id, cancelToken)) return { number: typeof number === 'string' ? number : null, found: false };
    return view(await reconcile(op), { found: true });
  }));

  const listForAccount = ({ accountId }) => (accountId ? ledger.opsByAccount(accountId).filter((op) => op.integrationId === id && op.state !== 'failed')
    .map((op) => view(op, { cancelToken: ledger.cancelTokenFor(op.id), owned: true })) : []);

  /** Все операции с неизвестным исходом — при синхронизации (mis/runtime.js), без ожидания отсрочки. */
  const reconcileAll = async () => {
    const counts = { checked: 0, confirmed: 0, failed: 0, cancelled: 0, pending: 0 };
    for (const op of ledger.opsForReconcile(Number.MAX_SAFE_INTEGER, 200)) {
      if (op.integrationId !== id) continue;
      counts.checked += 1;
      const next = await reconcile(op, { force: true });
      if (next.state === 'confirmed') counts.confirmed += 1;
      else if (next.state === 'failed') counts.failed += 1;
      else if (next.state === 'cancelled') counts.cancelled += 1;
      else counts.pending += 1;
    }
    return counts;
  };

  const connector = defineConnector({
    id: `mis-${id}`,
    can: { slots: true, hold: true, book: true, cancel: adapter.can.cancel, status: true },
    listSlots, checkSlot, hold, release, book, ...(adapter.can.cancel ? { cancel } : {}), status, listForAccount,
  });
  return Object.freeze({ ...connector, integrationId: id, ownsBranch, reconcile, reconcileAll, adapter });
};
