/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общий слой интеграций с МИС клиник: ошибки, возможности адаптера и
 * жизненный цикл записи.
 *
 *   МедКарта → сервис записи → контракт коннектора (connectors/contract.js)
 *            → коннектор МИС (mis/connector.js) → адаптер МИС → API клиники
 *
 * Адаптер — единственное место, которое знает API конкретной МИС. Он
 * переводит её ответы в общий вид и её отказы — в MisError с общим кодом.
 * Конкретный адаптер пишется только по официальной документации и
 * проверяется на тестовом стенде поставщика; здесь есть только симулятор
 * (mis/simulator), API которого вымышлен и ни одной реальной МИС не повторяет.
 */

import { BookingError } from '../errors.js';

/* ----------------------------- Ошибки МИС ----------------------------- */

/*
 * Коды. definite — МИС точно не создала запись (можно сказать «не удалось»);
 * unknown — исход неизвестен (запрос мог дойти): только сверка, без повтора вслепую.
 */
export const MIS_ERRORS = Object.freeze({
  slot_taken: { outcome: 'definite', booking: 'slot_taken', message: 'Это время уже занято.' },
  not_found: { outcome: 'definite', booking: 'slot_not_found', message: 'Не найдено в расписании клиники.' },
  invalid_request: { outcome: 'definite', booking: 'integration_error', message: 'Клиника не приняла запрос.' },
  auth_failed: { outcome: 'definite', booking: 'integration_unavailable', message: 'Запись в эту клинику временно недоступна.' },
  rate_limited: { outcome: 'definite', booking: 'integration_unavailable', message: 'Запись в эту клинику временно недоступна.' },
  invalid_response: { outcome: 'unknown', booking: 'integration_error', message: 'Клиника ответила непонятно.' },
  timeout: { outcome: 'unknown', booking: 'integration_unavailable', message: 'Клиника не ответила вовремя.' },
  unavailable: { outcome: 'unknown', booking: 'integration_unavailable', message: 'Запись в эту клинику временно недоступна.' },
  unknown: { outcome: 'unknown', booking: 'integration_error', message: 'Запись в эту клинику временно недоступна.' },
});

export class MisError extends Error {
  /**
   * @param {keyof MIS_ERRORS} code
   * @param {string} [detail] технический код без персональных данных (для журнала)
   */
  constructor(code, detail = '') {
    const known = Object.hasOwn(MIS_ERRORS, code) ? code : 'unknown';
    super(MIS_ERRORS[known].message);
    this.name = 'MisError';
    this.code = known;
    this.detail = String(detail || '').replace(/[^\w.:-]/g, '').slice(0, 64);
  }

  get outcome() {
    return MIS_ERRORS[this.code].outcome;
  }
}

/** Отказ МИС → отказ записи МедКарты: пациент видит понятный текст, а не ответ МИС. */
export const toBookingError = (error) => {
  if (error instanceof BookingError) return error;
  const code = error instanceof MisError ? error.code : 'unknown';
  return new BookingError(MIS_ERRORS[code].booking, MIS_ERRORS[code].message);
};

/* ------------------------- Возможности адаптера ------------------------ */

/*
 * Не каждая МИС умеет всё. Адаптер объявляет, что умеет; слой МедКарты не
 * требует остального. idempotentBook — МИС сама не создаст вторую запись на
 * тот же requestId (тогда повтор после тайм-аута безопасен); findByRequest —
 * запись можно найти по нашему requestId (сверка после потерянного ответа).
 */
export const MIS_CAPABILITIES = Object.freeze([
  'branches', 'doctors', 'services', 'slots', 'hold', 'book', 'cancel', 'status', 'webhooks', 'idempotentBook', 'findByRequest',
]);
const MIS_METHODS = Object.freeze({
  branches: ['listBranches'], doctors: ['listDoctors'], services: ['listServices'], slots: ['listSlots'],
  hold: ['hold', 'release'], book: ['book'], cancel: ['cancel'], status: ['getBooking'], webhooks: ['verifyWebhook', 'parseWebhook'],
  idempotentBook: [], findByRequest: ['findBookingByRequest'],
});

export const defineMisAdapter = (adapter) => {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('Адаптер МИС: нужен объект.');
  if (typeof adapter.type !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(adapter.type)) throw new TypeError(`Адаптер МИС: неверный type «${adapter.type}».`);
  const can = adapter.can || {};
  const unknown = Object.keys(can).filter((key) => !MIS_CAPABILITIES.includes(key));
  if (unknown.length) throw new TypeError(`Адаптер ${adapter.type}: неизвестные возможности ${unknown.join(', ')}.`);
  const flags = Object.fromEntries(MIS_CAPABILITIES.map((key) => [key, can[key] === true]));
  for (const key of MIS_CAPABILITIES) {
    const missing = flags[key] ? MIS_METHODS[key].filter((name) => typeof adapter[name] !== 'function') : [];
    if (missing.length) throw new TypeError(`Адаптер ${adapter.type}: для ${key} нужны ${missing.join(', ')}.`);
  }
  if (!flags.slots || !flags.book) throw new TypeError(`Адаптер ${adapter.type}: без слотов и записи подключать нечего.`);
  return Object.freeze({ ...adapter, can: Object.freeze(flags), simulator: adapter.simulator === true });
};

/* ------------------------- Жизненный цикл записи ----------------------- */

export const BOOKING_STATES = Object.freeze([
  'hold_pending', 'held', 'booking_pending', 'confirmed', 'pending_reconciliation', 'failed', 'cancel_pending', 'cancelled', 'completed',
]);

/* Куда можно перейти. Всё остальное — ошибка программы, а не МИС. */
const TRANSITIONS = Object.freeze({
  hold_pending: ['held', 'failed', 'booking_pending'],
  held: ['booking_pending', 'cancelled', 'failed'],
  booking_pending: ['confirmed', 'failed', 'pending_reconciliation'],
  pending_reconciliation: ['confirmed', 'failed', 'cancelled', 'booking_pending'],
  confirmed: ['cancel_pending', 'cancelled', 'completed'],
  cancel_pending: ['cancelled', 'confirmed', 'pending_reconciliation'],
  cancelled: [],
  failed: [],
  completed: [],
});

export const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) === true;

/* Активные записи занимают слот: второй такой операции на тот же слот быть не может. */
export const ACTIVE_STATES = Object.freeze(['hold_pending', 'held', 'booking_pending', 'confirmed', 'pending_reconciliation', 'cancel_pending']);

/* Что видит пациент. Технических подробностей МИС здесь нет. */
export const STATE_TEXT = Object.freeze({
  hold_pending: 'Проверяем доступность',
  held: 'Время удерживается за вами',
  booking_pending: 'Отправляем запись в клинику',
  confirmed: 'Запись подтверждена',
  pending_reconciliation: 'Статус уточняется',
  failed: 'Не удалось подтвердить запись',
  cancel_pending: 'Отменяем запись',
  cancelled: 'Запись отменена',
  completed: 'Приём состоялся',
});

/* Статус записи в общем виде (как у демо-записи: confirmed | cancelled). */
export const publicStatus = (state) => (state === 'cancelled' ? 'cancelled' : state === 'confirmed' || state === 'completed' || state === 'cancel_pending' ? 'confirmed' : state === 'failed' ? 'failed' : 'pending');
