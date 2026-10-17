/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Демо-расписание и демо-записи: SQLite (node:sqlite), один файл.
 *
 * Симуляция записи: наружу ничего не уходит — ни в МИС, ни в клиники, ни в
 * страховые, ни в уведомления. Персональных данных пациента здесь нет:
 * запись — это номер, слот и секрет для отмены.
 *
 * Статусы слота:
 *   FREE    — свободен;
 *   HELD    — временно удержан на время подтверждения (истекает по TTL);
 *   BOOKED  — записан пациент (в том числе «другие пациенты» исходного набора);
 *   BLOCKED — недоступен (служебное время клиники).
 *
 * Гарантии:
 *   — слот не бывает одновременно свободным и занятым: статус — одно поле,
 *     переходы — условные UPDATE, составные — внутри BEGIN IMMEDIATE;
 *   — на слот не больше одной активной записи: частичный уникальный индекс
 *     в самой базе, даже если код выше ошибётся;
 *   — повтор запроса с тем же ключом идемпотентности возвращает ту же
 *     запись, а не создаёт вторую;
 *   — удержание истекает само: истёкший HELD читается как FREE;
 *   — прошедший слот не записывается и не «освобождается» отменой;
 *   — состояние переживает перезапуск сервера (файл на диске).
 *
 * Окно расписания — 14 дней от «сегодня» по Москве. Новые дни достраиваются
 * при обращении детерминированно (seed, врач, дата), поэтому сброс демо даёт
 * одно и то же исходное расписание.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEMO_VERSION, generateDaySlots, SLOT_WINDOW_DAYS, windowDays } from './generator.js';
import { addDays, moscowDay, moscowMoment, moscowParts } from './time.js';

export const SLOT_STATUS = Object.freeze({ FREE: 'FREE', HELD: 'HELD', BOOKED: 'BOOKED', BLOCKED: 'BLOCKED' });
export const HOLD_TTL_MS = 5 * 60 * 1000;

export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}

const SCHEMA_VERSION = 1;
const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE days (day TEXT PRIMARY KEY, generated_at INTEGER NOT NULL);
  CREATE TABLE absences (doctor_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (doctor_id, day));
  CREATE TABLE slots (
    id              TEXT PRIMARY KEY,
    clinic_id       TEXT NOT NULL,
    branch_id       TEXT NOT NULL,
    doctor_id       TEXT NOT NULL,
    service_id      TEXT NOT NULL,
    day             TEXT NOT NULL,
    start_at        INTEGER NOT NULL,
    end_at          INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('FREE', 'HELD', 'BOOKED', 'BLOCKED')),
    hold_token_hash TEXT,
    hold_expires_at INTEGER,
    updated_at      INTEGER NOT NULL,
    version         INTEGER NOT NULL DEFAULT 0,
    CHECK (end_at > start_at)
  );
  CREATE UNIQUE INDEX slots_doctor_start ON slots(doctor_id, start_at);
  CREATE INDEX slots_day ON slots(day);
  CREATE TABLE bookings (
    id              TEXT PRIMARY KEY,
    number          TEXT NOT NULL UNIQUE,
    slot_id         TEXT NOT NULL REFERENCES slots(id),
    status          TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    idempotency_key TEXT UNIQUE,
    plan_id         TEXT,
    created_at      INTEGER NOT NULL,
    cancelled_at    INTEGER
  );
  CREATE UNIQUE INDEX bookings_one_active_per_slot ON bookings(slot_id) WHERE status = 'CONFIRMED';
  `,
];

const sha256 = (value) => createHmac('sha256', 'medkarta-demo-hold').update(String(value)).digest('base64url');
const NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Номер записи для человека: DEMO-ГГММДД-XXXXX. */
const makeNumber = (now) => {
  const bytes = randomBytes(5);
  const suffix = [...bytes].map((byte) => NUMBER_ALPHABET[byte % NUMBER_ALPHABET.length]).join('');
  return `DEMO-${moscowDay(now).slice(2).replace(/-/g, '')}-${suffix}`;
};

const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,80}$/;
const SLOT_ID = /^[a-z0-9-]{1,120}$/;
const NUMBER = /^DEMO-\d{6}-[A-Z0-9]{5}$/;

/**
 * @param {object} options
 * @param {Function} options.DatabaseSync конструктор из node:sqlite
 * @param {string} options.file путь к базе или ':memory:'
 * @param {object} options.index индекс демо-набора (indexDemoCatalog)
 * @param {Function} [options.now] текущее время, мс
 */
export const createBookingStore = ({ DatabaseSync, file, index, now = () => Date.now(), windowSize = SLOT_WINDOW_DAYS }) => {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Том без прав доступа — не повод падать.
    }
  }
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const { catalog } = index;
  const seed = catalog.meta.seed;
  const fingerprint = `${DEMO_VERSION}|${seed}|${catalog.doctors.length}|${catalog.services.length}`;

  const statements = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    hasDay: db.prepare('SELECT 1 AS found FROM days WHERE day = ?'),
    addDay: db.prepare('INSERT OR IGNORE INTO days (day, generated_at) VALUES (?, ?)'),
    addAbsence: db.prepare('INSERT OR IGNORE INTO absences (doctor_id, day, kind) VALUES (?, ?, ?)'),
    absences: db.prepare('SELECT doctor_id, day, kind FROM absences WHERE doctor_id = ? AND day >= ? AND day <= ?'),
    insertSlot: db.prepare(`INSERT OR IGNORE INTO slots (id, clinic_id, branch_id, doctor_id, service_id, day, start_at, end_at, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    slotById: db.prepare('SELECT * FROM slots WHERE id = ?'),
    slotsForDoctor: db.prepare('SELECT * FROM slots WHERE doctor_id = ? AND day >= ? AND day <= ? ORDER BY start_at'),
    hold: db.prepare(`UPDATE slots SET status = 'HELD', hold_token_hash = ?, hold_expires_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND start_at > ? AND (status = 'FREE' OR (status = 'HELD' AND hold_expires_at <= ?))`),
    release: db.prepare(`UPDATE slots SET status = 'FREE', hold_token_hash = NULL, hold_expires_at = NULL, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'HELD' AND hold_token_hash = ?`),
    markBooked: db.prepare(`UPDATE slots SET status = 'BOOKED', hold_token_hash = NULL, hold_expires_at = NULL, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?`),
    markFree: db.prepare(`UPDATE slots SET status = 'FREE', hold_token_hash = NULL, hold_expires_at = NULL, updated_at = ?, version = version + 1
      WHERE id = ? AND status = 'BOOKED'`),
    bookingByKey: db.prepare('SELECT * FROM bookings WHERE idempotency_key = ?'),
    bookingByNumber: db.prepare('SELECT * FROM bookings WHERE number = ?'),
    numberTaken: db.prepare('SELECT 1 AS found FROM bookings WHERE number = ?'),
    insertBooking: db.prepare(`INSERT INTO bookings (id, number, slot_id, status, idempotency_key, plan_id, created_at)
      VALUES (?, ?, ?, 'CONFIRMED', ?, ?, ?)`),
    cancelBooking: db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ? WHERE id = ? AND status = 'CONFIRMED'"),
    activeBookingForSlot: db.prepare("SELECT 1 AS found FROM bookings WHERE slot_id = ? AND status = 'CONFIRMED'"),
    purgeOldSlots: db.prepare('DELETE FROM slots WHERE day < ? AND id NOT IN (SELECT slot_id FROM bookings)'),
    purgeOldDays: db.prepare('DELETE FROM days WHERE day < ?'),
    countByStatus: db.prepare('SELECT status, COUNT(*) AS count FROM slots GROUP BY status'),
  };

  const immediate = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // транзакция уже закрыта
      }
      throw error;
    }
  };

  /*
   * Секрет для токенов отмены — свой у каждой базы. Токен выводится из id
   * записи: повтор запроса с тем же ключом отдаёт тот же токен, а в базе
   * токены не хранятся.
   */
  let secret = statements.getMeta.get('secret')?.value;
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    statements.setMeta.run('secret', secret);
  }
  const cancelTokenFor = (bookingId) => createHmac('sha256', secret).update(`cancel|${bookingId}`).digest('base64url');
  const tokenMatches = (bookingId, token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return false;
    const expected = Buffer.from(cancelTokenFor(bookingId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  const generateDay = (day, generatedAt) => {
    for (const doctor of catalog.doctors) {
      const { absence, slots } = generateDaySlots(catalog, doctor, day, { seed });
      if (absence) statements.addAbsence.run(doctor.id, day, absence);
      for (const slot of slots) {
        statements.insertSlot.run(
          slot.id, slot.clinicId, slot.branchId, slot.doctorId, slot.serviceId, day,
          moscowMoment(day, slot.start), moscowMoment(day, slot.end), slot.status, generatedAt,
        );
      }
    }
    statements.addDay.run(day, generatedAt);
  };

  /** Достраивает окно расписания от «сегодня» и убирает старые дни. */
  const ensureWindow = (at = now()) => {
    const today = moscowDay(at);
    for (const day of windowDays(today, windowSize)) {
      if (statements.hasDay.get(day)) continue;
      immediate(() => {
        if (!statements.hasDay.get(day)) generateDay(day, at);
      });
    }
    // Слоты старше недели не нужны, кроме тех, на которые есть записи.
    const cutoff = addDays(today, -7);
    statements.purgeOldSlots.run(cutoff);
    statements.purgeOldDays.run(cutoff);
  };

  /** Сброс демо: все записи и состояния — к исходным. */
  const reset = (at = now()) => {
    immediate(() => {
      db.exec('DELETE FROM bookings; DELETE FROM slots; DELETE FROM days; DELETE FROM absences;');
      statements.setMeta.run('fingerprint', fingerprint);
    });
    ensureWindow(at);
  };

  // Набор поменялся (новая генерация) — старые слоты к нему не подходят.
  if (statements.getMeta.get('fingerprint')?.value !== fingerprint) reset(now());

  /** Статус слота с учётом истёкшего удержания и прошедшего времени. */
  const effective = (row, at) => {
    const status = row.status === 'HELD' && row.hold_expires_at <= at ? 'FREE' : row.status;
    return { status, past: row.start_at <= at };
  };

  const publicSlot = (row, at) => {
    const { status, past } = effective(row, at);
    const start = moscowParts(row.start_at);
    const end = moscowParts(row.end_at);
    return {
      id: row.id,
      clinicId: row.clinic_id,
      branchId: row.branch_id,
      doctorId: row.doctor_id,
      serviceId: row.service_id,
      day: row.day,
      start: start.time,
      end: end.time,
      startAt: new Date(row.start_at).toISOString(),
      endAt: new Date(row.end_at).toISOString(),
      status,
      bookable: status === 'FREE' && !past,
      past,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  };

  /**
   * Свободные слоты для набора «врач × филиал» — для поиска.
   * @param {object} query
   * @param {Array<{doctorId:string, branchId:string}>} query.pairs
   * @param {string} query.fromDay
   * @param {string} query.toDay
   * @returns {Map<string, object[]>} ключ «врач|филиал» → слоты по времени
   */
  const freeSlots = ({ pairs, fromDay, toDay, at = now() }) => {
    ensureWindow(at);
    const wanted = new Set(pairs.map((pair) => `${pair.doctorId}|${pair.branchId}`));
    const doctors = [...new Set(pairs.map((pair) => pair.doctorId))];
    const result = new Map();
    if (doctors.length === 0) return result;
    const rows = db.prepare(`SELECT * FROM slots WHERE doctor_id IN (${doctors.map(() => '?').join(',')})
      AND day >= ? AND day <= ? AND start_at > ?
      AND (status = 'FREE' OR (status = 'HELD' AND hold_expires_at <= ?))
      ORDER BY start_at`).all(...doctors, fromDay, toDay, at, at);
    for (const row of rows) {
      const key = `${row.doctor_id}|${row.branch_id}`;
      if (!wanted.has(key)) continue;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(publicSlot(row, at));
    }
    return result;
  };

  /** Расписание врача: все слоты по дням с состояниями и отсутствия. */
  const doctorSchedule = ({ doctorId, branchId = null, fromDay, toDay, at = now() }) => {
    ensureWindow(at);
    const rows = statements.slotsForDoctor.all(doctorId, fromDay, toDay).filter((row) => !branchId || row.branch_id === branchId);
    const absences = statements.absences.all(doctorId, fromDay, toDay);
    return {
      slots: rows.map((row) => publicSlot(row, at)),
      absences: absences.map((row) => ({ day: row.day, kind: row.kind })),
    };
  };

  const getSlot = (slotId, at = now()) => {
    const row = statements.slotById.get(slotId);
    return row ? publicSlot(row, at) : null;
  };

  const explainUnavailable = (row, at) => {
    if (!row) return new BookingError('slot_not_found', 'Такого времени в расписании нет.');
    const { status, past } = effective(row, at);
    if (past) return new BookingError('slot_past', 'Это время уже прошло.');
    if (status === 'BOOKED') return new BookingError('slot_taken', 'Это время уже занято.');
    if (status === 'BLOCKED') return new BookingError('slot_unavailable', 'На это время запись закрыта.');
    if (status === 'HELD') return new BookingError('slot_held', 'Это время сейчас подтверждает другой пользователь. Попробуйте через несколько минут или выберите другое.');
    return new BookingError('slot_conflict', 'Не удалось удержать время.');
  };

  const hold = ({ slotId, ttlMs = HOLD_TTL_MS, at = now() }) => {
    if (typeof slotId !== 'string' || !SLOT_ID.test(slotId)) throw new BookingError('bad_request', 'Неверный слот.');
    const token = randomBytes(18).toString('base64url');
    const expiresAt = at + ttlMs;
    const changed = immediate(() => statements.hold.run(sha256(token), expiresAt, at, slotId, at, at).changes);
    if (changed !== 1) throw explainUnavailable(statements.slotById.get(slotId), at);
    return { holdToken: token, expiresAt: new Date(expiresAt).toISOString(), ttlSeconds: Math.round(ttlMs / 1000), slot: getSlot(slotId, at) };
  };

  /** Снимает своё удержание (пользователь передумал). */
  const release = ({ slotId, holdToken, at = now() }) => {
    if (typeof holdToken !== 'string') return false;
    return statements.release.run(at, slotId, sha256(holdToken)).changes === 1;
  };

  const bookingView = (booking, at = now()) => {
    const slot = statements.slotById.get(booking.slot_id);
    return {
      number: booking.number,
      status: booking.status,
      createdAt: new Date(booking.created_at).toISOString(),
      cancelledAt: booking.cancelled_at ? new Date(booking.cancelled_at).toISOString() : null,
      planId: booking.plan_id || null,
      slot: slot ? publicSlot(slot, at) : null,
    };
  };

  /**
   * Запись на слот. Атомарно: проверка, перевод в BOOKED и создание записи —
   * одна транзакция BEGIN IMMEDIATE.
   */
  const book = ({ slotId, holdToken = null, idempotencyKey, planId = null, at = now() }) => {
    if (typeof slotId !== 'string' || !SLOT_ID.test(slotId)) throw new BookingError('bad_request', 'Неверный слот.');
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY.test(idempotencyKey)) {
      throw new BookingError('bad_request', 'Нужен ключ запроса (idempotencyKey).');
    }
    return immediate(() => {
      const existing = statements.bookingByKey.get(idempotencyKey);
      if (existing) {
        if (existing.slot_id !== slotId) throw new BookingError('idempotency_conflict', 'Этот ключ запроса уже использован для другой записи.');
        return { ...bookingView(existing, at), cancelToken: cancelTokenFor(existing.id), repeated: true };
      }

      const row = statements.slotById.get(slotId);
      if (!row) throw explainUnavailable(null, at);
      const { status, past } = effective(row, at);
      const ownHold = row.status === 'HELD' && row.hold_expires_at > at && typeof holdToken === 'string' && row.hold_token_hash === sha256(holdToken);
      if (past || !(status === 'FREE' || ownHold)) throw explainUnavailable(row, at);
      if (statements.activeBookingForSlot.get(slotId)) throw new BookingError('slot_taken', 'Это время уже занято.');

      if (statements.markBooked.run(at, slotId, row.version).changes !== 1) {
        throw new BookingError('slot_taken', 'Это время только что заняли.');
      }
      let number = makeNumber(at);
      while (statements.numberTaken.get(number)) number = makeNumber(at);
      const id = randomUUID();
      statements.insertBooking.run(id, number, slotId, idempotencyKey, planId, at);
      return { ...bookingView(statements.bookingByNumber.get(number), at), cancelToken: cancelTokenFor(id), repeated: false };
    });
  };

  /** Отмена записи. Слот освобождается, если время ещё не прошло. */
  const cancel = ({ number, cancelToken, at = now() }) => {
    if (typeof number !== 'string' || !NUMBER.test(number)) throw new BookingError('bad_request', 'Неверный номер записи.');
    return immediate(() => {
      const booking = statements.bookingByNumber.get(number);
      if (!booking || !tokenMatches(booking.id, cancelToken)) throw new BookingError('booking_not_found', 'Запись не найдена.');
      if (booking.status === 'CANCELLED') return { ...bookingView(booking, at), alreadyCancelled: true, slotReleased: false };
      statements.cancelBooking.run(at, booking.id);
      const slot = statements.slotById.get(booking.slot_id);
      // Прошедшее время свободным не становится: «освободить» его некому.
      const slotReleased = Boolean(slot && slot.start_at > at && statements.markFree.run(at, slot.id).changes === 1);
      return { ...bookingView(statements.bookingByNumber.get(number), at), alreadyCancelled: false, slotReleased };
    });
  };

  /** Состояние своих записей по номерам и токенам отмены. */
  const lookup = ({ items, at = now() }) => (items || []).slice(0, 20).map(({ number, cancelToken }) => {
    if (typeof number !== 'string' || !NUMBER.test(number)) return { number: null, found: false };
    const booking = statements.bookingByNumber.get(number);
    if (!booking || !tokenMatches(booking.id, cancelToken)) return { number, found: false };
    return { found: true, ...bookingView(booking, at) };
  });

  const stats = () => Object.fromEntries(statements.countByStatus.all().map((row) => [row.status, row.count]));

  return Object.freeze({
    kind: 'sqlite',
    ensureWindow,
    reset,
    freeSlots,
    doctorSchedule,
    getSlot,
    hold,
    release,
    book,
    cancel,
    lookup,
    stats,
    close: () => db.close(),
  });
};

/** node:sqlite есть с Node 22.5 (без флага — с 22.13). На старом Node демо-запись выключается. */
export const loadSqlite = async () => {
  try {
    const module = await import('node:sqlite');
    return module.DatabaseSync || null;
  } catch {
    return null;
  }
};

export { moscowDay };
