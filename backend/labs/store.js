/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории: каталог исследований, филиалы, цены, расписание и демо-запись.
 * SQLite (node:sqlite), один файл, по образцу демо-записи к врачам
 * (demo/bookingStore.js).
 *
 * Гарантии:
 *   — в слоте не больше записей, чем его вместимость: проверка и увеличение
 *     счётчика — один условный UPDATE внутри BEGIN IMMEDIATE, а ограничение
 *     CHECK в самой таблице не даст превысить вместимость, даже если код выше
 *     ошибётся;
 *   — состав и цена записи сохраняются построчно (исследования и процедуры
 *     взятия) на момент записи: итог восстанавливается из строк, а поздние
 *     правки цен его не меняют;
 *   — повтор запроса с тем же ключом идемпотентности возвращает ту же запись;
 *   — отмена освобождает место в слоте, если время ещё не прошло;
 *   — прошедший слот не записывается.
 *
 * Персональных данных пациента здесь нет: запись — номер, слот, состав и секрет
 * для отмены. Запись из личного кабинета помечена случайным id аккаунта.
 * Всё — демонстрация: в лаборатории ничего не уходит.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createRandom } from '../demo/random.js';
import { addDays, isDay, minutesOf, moscowDay, moscowMoment, moscowParts, timeOf, weekdayOf } from '../demo/time.js';
import { BIOMATERIAL_KINDS, BIOMATERIALS, buildLabSeed, CATEGORY_IDS, DEMO_RESULTS, LAB_CATALOG_VERSION, TESTS } from './catalog.js';

export const LAB_WINDOW_DAYS = 30;
export const LAB_OWNER_RETENTION_DAYS = 30;

export class LabError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'LabError';
    this.code = code;
    this.status = status;
  }
}

const SCHEMA_VERSION = 1;
const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE laboratories (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    logo        TEXT,
    phone       TEXT,
    website     TEXT,
    email       TEXT,
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    demo        INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0, 1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE lab_branches (
    id              TEXT PRIMARY KEY,
    lab_id          TEXT NOT NULL REFERENCES laboratories(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    address         TEXT NOT NULL,
    district        TEXT,
    lat             REAL NOT NULL CHECK (lat BETWEEN 55.5 AND 56.1),
    lng             REAL NOT NULL CHECK (lng BETWEEN 48.6 AND 49.6),
    phone           TEXT,
    hours_json      TEXT NOT NULL,
    collection_json TEXT NOT NULL,
    slot_minutes    INTEGER NOT NULL DEFAULT 10 CHECK (slot_minutes BETWEEN 5 AND 60),
    slot_capacity   INTEGER NOT NULL DEFAULT 2 CHECK (slot_capacity BETWEEN 1 AND 10),
    booking_modes   TEXT NOT NULL DEFAULT 'online,walk_in',
    active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    demo            INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0, 1)),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    version         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX lab_branches_lab ON lab_branches(lab_id);
  CREATE TABLE lab_tests (
    id               TEXT PRIMARY KEY,
    code             TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 2 AND 40),
    name             TEXT NOT NULL,
    category         TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    biomaterial      TEXT NOT NULL CHECK (biomaterial IN ('venous_blood', 'capillary_blood', 'urine', 'feces', 'swab')),
    unit             TEXT,
    preparation      TEXT NOT NULL DEFAULT '',
    turnaround_hours INTEGER NOT NULL CHECK (turnaround_hours > 0),
    requires_booking INTEGER NOT NULL DEFAULT 0 CHECK (requires_booking IN (0, 1)),
    fasting          INTEGER NOT NULL DEFAULT 0 CHECK (fasting IN (0, 1)),
    components_json  TEXT NOT NULL DEFAULT '[]',
    active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    version          INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX lab_tests_category ON lab_tests(category);
  CREATE TABLE lab_test_synonyms (
    test_id    TEXT NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
    synonym    TEXT NOT NULL,
    normalized TEXT NOT NULL,
    PRIMARY KEY (test_id, normalized)
  );
  CREATE INDEX lab_test_synonyms_normalized ON lab_test_synonyms(normalized);
  CREATE TABLE lab_offerings (
    id               TEXT PRIMARY KEY,
    branch_id        TEXT NOT NULL REFERENCES lab_branches(id) ON DELETE CASCADE,
    test_id          TEXT NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
    price            INTEGER NOT NULL CHECK (price >= 0),
    currency         TEXT NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    available        INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
    turnaround_hours INTEGER NOT NULL CHECK (turnaround_hours > 0),
    conditions       TEXT,
    price_date       TEXT NOT NULL,
    demo             INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0, 1)),
    updated_at       INTEGER NOT NULL,
    UNIQUE (branch_id, test_id)
  );
  CREATE INDEX lab_offerings_test ON lab_offerings(test_id, available);
  CREATE TABLE lab_fees (
    branch_id TEXT NOT NULL REFERENCES lab_branches(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('venous_blood', 'capillary_blood', 'urine', 'feces', 'swab')),
    name      TEXT NOT NULL,
    price     INTEGER NOT NULL CHECK (price >= 0),
    PRIMARY KEY (branch_id, kind)
  );
  CREATE TABLE lab_days (
    branch_id    TEXT NOT NULL REFERENCES lab_branches(id) ON DELETE CASCADE,
    day          TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    PRIMARY KEY (branch_id, day)
  );
  CREATE TABLE lab_slots (
    id         TEXT PRIMARY KEY,
    branch_id  TEXT NOT NULL REFERENCES lab_branches(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    start_at   INTEGER NOT NULL,
    end_at     INTEGER NOT NULL,
    capacity   INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 10),
    taken      INTEGER NOT NULL DEFAULT 0 CHECK (taken >= 0),
    booked     INTEGER NOT NULL DEFAULT 0 CHECK (booked >= 0),
    blocked    INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
    updated_at INTEGER NOT NULL,
    CHECK (end_at > start_at),
    CHECK (taken + booked <= capacity),
    UNIQUE (branch_id, start_at)
  );
  CREATE INDEX lab_slots_branch_day ON lab_slots(branch_id, day);
  CREATE TABLE lab_bookings (
    id              TEXT PRIMARY KEY,
    number          TEXT NOT NULL UNIQUE,
    branch_id       TEXT NOT NULL REFERENCES lab_branches(id),
    slot_id         TEXT NOT NULL REFERENCES lab_slots(id),
    status          TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    total           INTEGER NOT NULL CHECK (total >= 0),
    currency        TEXT NOT NULL DEFAULT 'RUB',
    idempotency_key TEXT UNIQUE,
    account_id      TEXT,
    demo            INTEGER NOT NULL DEFAULT 1 CHECK (demo IN (0, 1)),
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    cancelled_at    INTEGER,
    cancelled_by    TEXT CHECK (cancelled_by IN ('user', 'admin'))
  );
  CREATE INDEX lab_bookings_account ON lab_bookings(account_id, created_at) WHERE account_id IS NOT NULL;
  CREATE INDEX lab_bookings_created ON lab_bookings(created_at);
  CREATE TABLE lab_booking_items (
    booking_id       TEXT NOT NULL REFERENCES lab_bookings(id) ON DELETE CASCADE,
    line             INTEGER NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('test', 'fee')),
    test_code        TEXT,
    fee_kind         TEXT,
    name             TEXT NOT NULL,
    price            INTEGER NOT NULL CHECK (price >= 0),
    turnaround_hours INTEGER,
    PRIMARY KEY (booking_id, line)
  );
  CREATE TABLE lab_demo_results (
    id         TEXT PRIMARY KEY,
    test_id    TEXT NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
];

const NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const CODE = /^[A-Z0-9_]{2,40}$/;
const SLOT_ID = /^[a-z0-9-]{1,140}$/;
const NUMBER = /^LAB-\d{6}-[A-Z0-9]{5}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,80}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ACCOUNT_BOOKINGS = 50;
const MAX_TESTS_PER_BOOKING = 25;

/** Текст для сравнения названий: нижний регистр, «ё» → «е», без знаков и лишних пробелов. */
export const normalizeLabText = (value) => String(value || '').toLowerCase().replace(/ё/gu, 'е')
  .replace(/[«»"'()]/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/gu, ' ').trim();

const makeNumber = (at) => {
  const suffix = [...randomBytes(5)].map((byte) => NUMBER_ALPHABET[byte % NUMBER_ALPHABET.length]).join('');
  const [year, month, day] = moscowDay(at).split('-');
  return `LAB-${day}${month}${year.slice(2)}-${suffix}`;
};

const cleanText = (value, max, { required = false, field = 'value' } = {}) => {
  if (value === null || value === undefined || value === '') {
    if (required) throw new LabError('validation', `Поле «${field}» обязательно.`);
    return null;
  }
  if (typeof value !== 'string') throw new LabError('validation', `Поле «${field}» должно быть строкой.`);
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (required && !text) throw new LabError('validation', `Поле «${field}» обязательно.`);
  if (text.length > max) throw new LabError('validation', `Поле «${field}» длиннее ${max} символов.`);
  return text || null;
};

const cleanInt = (value, { min, max, field }) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new LabError('validation', `Поле «${field}»: целое число от ${min} до ${max}.`);
  return number;
};

/** Недельное расписание: {1: [["07:00","12:00"]], …, 7: []}. */
export const normalizeWeekly = (value, field = 'расписание') => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LabError('validation', `Неверное ${field}.`);
  const result = {};
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const list = value[weekday] ?? value[String(weekday)] ?? [];
    if (!Array.isArray(list) || list.length > 4) throw new LabError('validation', `Неверное ${field}: день ${weekday}.`);
    result[weekday] = list.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2 || !TIME.test(pair[0]) || !TIME.test(pair[1]) || minutesOf(pair[0]) >= minutesOf(pair[1])) {
        throw new LabError('validation', `Неверный интервал в ${field}: день ${weekday}.`);
      }
      return [pair[0], pair[1]];
    }).sort((a, b) => minutesOf(a[0]) - minutesOf(b[0]));
  }
  return result;
};

/**
 * @param {object} options
 * @param {Function} options.DatabaseSync конструктор из node:sqlite
 * @param {string} options.file путь к базе или ':memory:'
 * @param {Function} [options.now] текущее время, мс
 */
export const createLabStore = ({ DatabaseSync, file, now = () => Date.now(), seed = 'medkarta-labs-v1', windowSize = LAB_WINDOW_DAYS }) => {
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

  const meta = {
    get: db.prepare('SELECT value FROM meta WHERE key = ?'),
    set: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };
  let secret = meta.get.get('secret')?.value;
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    meta.set.run('secret', secret);
  }
  const cancelTokenFor = (bookingId) => createHmac('sha256', secret).update(`lab-cancel|${bookingId}`).digest('base64url');
  const tokenMatches = (bookingId, token) => {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return false;
    const expected = Buffer.from(cancelTokenFor(bookingId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  const insertTest = db.prepare(`INSERT INTO lab_tests (id, code, name, category, description, biomaterial, unit, preparation, turnaround_hours, requires_booking, fasting, components_json, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const insertSynonym = db.prepare('INSERT OR IGNORE INTO lab_test_synonyms (test_id, synonym, normalized) VALUES (?, ?, ?)');
  const insertLab = db.prepare(`INSERT INTO laboratories (id, name, description, logo, phone, website, email, active, demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
  const insertBranch = db.prepare(`INSERT INTO lab_branches (id, lab_id, name, address, district, lat, lng, phone, hours_json, collection_json, slot_minutes, slot_capacity, booking_modes, active, demo, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`);
  const insertFee = db.prepare('INSERT INTO lab_fees (branch_id, kind, name, price) VALUES (?, ?, ?, ?) ON CONFLICT(branch_id, kind) DO UPDATE SET name = excluded.name, price = excluded.price');
  const upsertOfferingStmt = db.prepare(`INSERT INTO lab_offerings (id, branch_id, test_id, price, currency, available, turnaround_hours, conditions, price_date, demo, updated_at)
    VALUES (?, ?, ?, ?, 'RUB', ?, ?, ?, ?, 1, ?)
    ON CONFLICT(branch_id, test_id) DO UPDATE SET price = excluded.price, available = excluded.available, turnaround_hours = excluded.turnaround_hours,
      conditions = excluded.conditions, price_date = excluded.price_date, updated_at = excluded.updated_at`);
  const insertResult = db.prepare('INSERT INTO lab_demo_results (id, test_id, title, payload, created_at) VALUES (?, ?, ?, ?, ?)');

  const testIdOf = (code) => `test-${code.toLowerCase().replace(/_/gu, '-')}`;

  /** Исходный набор: каталог, лаборатории, филиалы, цены. Только в пустую базу. */
  const seedDemo = (at) => {
    const data = buildLabSeed({ seed });
    for (const test of TESTS) {
      const id = testIdOf(test.code);
      insertTest.run(id, test.code, test.name, test.category, test.description, test.biomaterial, test.unit, test.preparation, test.hours,
        test.requiresBooking ? 1 : 0, test.fasting ? 1 : 0, JSON.stringify(test.components), at, at);
      for (const synonym of [test.name, ...test.synonyms]) insertSynonym.run(id, synonym, normalizeLabText(synonym));
    }
    for (const lab of data.labs) insertLab.run(lab.id, lab.name, lab.description, lab.logo, lab.phone, lab.website, lab.email, at, at);
    for (const branch of data.branches) {
      insertBranch.run(branch.id, branch.labId, branch.name, branch.address, branch.district, branch.lat, branch.lng, branch.phone,
        JSON.stringify(branch.hours), JSON.stringify(branch.collection), branch.slotMinutes, branch.slotCapacity, branch.bookingModes.join(','), at, at);
    }
    for (const fee of data.fees) insertFee.run(fee.branchId, fee.kind, fee.name, fee.price);
    for (const offering of data.offerings) {
      upsertOfferingStmt.run(`off-${offering.branchId}-${offering.testCode.toLowerCase()}`, offering.branchId, testIdOf(offering.testCode), offering.price,
        offering.available ? 1 : 0, offering.hours, offering.conditions, offering.priceDate, at);
    }
    for (const result of DEMO_RESULTS) {
      insertResult.run(result.id, testIdOf(result.testCode), result.title, JSON.stringify({ rows: result.rows, disclaimer: result.disclaimer }), at);
    }
    meta.set.run('catalog_version', String(LAB_CATALOG_VERSION));
  };

  if (!db.prepare('SELECT 1 AS found FROM lab_tests LIMIT 1').get()) immediate(() => seedDemo(now()));

  /*
   * База, заполненная прежней версией каталога: названия и адреса демо-филиалов
   * обновляются из текущей (только строки demo = 1; цены, записи и свои филиалы
   * администратора не трогаются).
   */
  const storedVersion = Number(meta.get.get('catalog_version')?.value || 0);
  if (storedVersion > 0 && storedVersion < LAB_CATALOG_VERSION) {
    immediate(() => {
      const at = now();
      const update = db.prepare('UPDATE lab_branches SET name = ?, address = ?, updated_at = ? WHERE id = ? AND demo = 1');
      for (const branch of buildLabSeed({ seed }).branches) update.run(branch.name, branch.address, at, branch.id);
      meta.set.run('catalog_version', String(LAB_CATALOG_VERSION));
    });
  }

  /* ------------------------------ Чтение ------------------------------ */

  const statements = {
    labs: db.prepare('SELECT * FROM laboratories ORDER BY name'),
    lab: db.prepare('SELECT * FROM laboratories WHERE id = ?'),
    branches: db.prepare('SELECT * FROM lab_branches ORDER BY lab_id, name'),
    branchesOfLab: db.prepare('SELECT * FROM lab_branches WHERE lab_id = ? ORDER BY name'),
    branch: db.prepare('SELECT * FROM lab_branches WHERE id = ?'),
    tests: db.prepare('SELECT * FROM lab_tests ORDER BY category, name'),
    testByCode: db.prepare('SELECT * FROM lab_tests WHERE code = ?'),
    testById: db.prepare('SELECT * FROM lab_tests WHERE id = ?'),
    synonyms: db.prepare('SELECT s.synonym, s.normalized, t.code FROM lab_test_synonyms s JOIN lab_tests t ON t.id = s.test_id WHERE t.active = 1'),
    synonymsOf: db.prepare('SELECT synonym FROM lab_test_synonyms WHERE test_id = ? ORDER BY synonym'),
    offeringsOfBranch: db.prepare(`SELECT o.*, t.code, t.name AS test_name, t.biomaterial, t.fasting, t.category FROM lab_offerings o JOIN lab_tests t ON t.id = o.test_id
      WHERE o.branch_id = ? ORDER BY t.category, t.name`),
    offeringsOfTest: db.prepare(`SELECT o.*, b.lab_id, b.name AS branch_name FROM lab_offerings o JOIN lab_branches b ON b.id = o.branch_id
      WHERE o.test_id = ? ORDER BY o.price`),
    feesOfBranch: db.prepare('SELECT * FROM lab_fees WHERE branch_id = ? ORDER BY kind'),
    allFees: db.prepare('SELECT * FROM lab_fees'),
    allOfferings: db.prepare('SELECT o.*, t.code FROM lab_offerings o JOIN lab_tests t ON t.id = o.test_id'),
    demoResults: db.prepare('SELECT r.*, t.code FROM lab_demo_results r JOIN lab_tests t ON t.id = r.test_id WHERE t.code = ?'),
    hasDay: db.prepare('SELECT 1 AS found FROM lab_days WHERE branch_id = ? AND day = ?'),
    addDay: db.prepare('INSERT OR IGNORE INTO lab_days (branch_id, day, generated_at) VALUES (?, ?, ?)'),
    insertSlot: db.prepare(`INSERT OR IGNORE INTO lab_slots (id, branch_id, day, start_at, end_at, capacity, taken, booked, blocked, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`),
    slot: db.prepare('SELECT * FROM lab_slots WHERE id = ?'),
    slotsOfBranch: db.prepare('SELECT * FROM lab_slots WHERE branch_id = ? AND day >= ? AND day <= ? ORDER BY start_at'),
    takeSlot: db.prepare(`UPDATE lab_slots SET booked = booked + 1, updated_at = ?
      WHERE id = ? AND branch_id = ? AND blocked = 0 AND start_at > ? AND taken + booked < capacity`),
    freeSlotPlace: db.prepare('UPDATE lab_slots SET booked = booked - 1, updated_at = ? WHERE id = ? AND booked > 0'),
    bookingByKey: db.prepare('SELECT * FROM lab_bookings WHERE idempotency_key = ?'),
    bookingByNumber: db.prepare('SELECT * FROM lab_bookings WHERE number = ?'),
    bookingById: db.prepare('SELECT * FROM lab_bookings WHERE id = ?'),
    numberTaken: db.prepare('SELECT 1 AS found FROM lab_bookings WHERE number = ?'),
    insertBooking: db.prepare(`INSERT INTO lab_bookings (id, number, branch_id, slot_id, status, total, currency, idempotency_key, account_id, demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'CONFIRMED', ?, 'RUB', ?, ?, 1, ?, ?)`),
    insertItem: db.prepare('INSERT INTO lab_booking_items (booking_id, line, kind, test_code, fee_kind, name, price, turnaround_hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    itemsOf: db.prepare('SELECT * FROM lab_booking_items WHERE booking_id = ? ORDER BY line'),
    cancelBooking: db.prepare("UPDATE lab_bookings SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, updated_at = ? WHERE id = ? AND status = 'CONFIRMED'"),
    bookingsOfAccount: db.prepare('SELECT * FROM lab_bookings WHERE account_id = ? ORDER BY created_at DESC LIMIT ?'),
    forgetAccount: db.prepare('UPDATE lab_bookings SET account_id = NULL WHERE account_id = ?'),
    forgetPastOwners: db.prepare('UPDATE lab_bookings SET account_id = NULL WHERE account_id IS NOT NULL AND slot_id IN (SELECT id FROM lab_slots WHERE day < ?)'),
    purgeOldSlots: db.prepare('DELETE FROM lab_slots WHERE day < ? AND id NOT IN (SELECT slot_id FROM lab_bookings)'),
    purgeOldDays: db.prepare('DELETE FROM lab_days WHERE day < ?'),
  };

  const parseJson = (text, fallback) => {
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  };

  const labView = (row) => row && ({
    id: row.id, name: row.name, description: row.description, logo: row.logo, phone: row.phone, website: row.website, email: row.email,
    active: row.active === 1, demo: row.demo === 1, updatedAt: new Date(row.updated_at).toISOString(), version: row.version,
  });
  const branchView = (row) => row && ({
    id: row.id, labId: row.lab_id, name: row.name, address: row.address, district: row.district, lat: row.lat, lng: row.lng, phone: row.phone,
    hours: parseJson(row.hours_json, {}), collection: parseJson(row.collection_json, {}), slotMinutes: row.slot_minutes, slotCapacity: row.slot_capacity,
    bookingModes: row.booking_modes.split(',').filter(Boolean), active: row.active === 1, demo: row.demo === 1, version: row.version,
  });
  const testView = (row, { synonyms = false } = {}) => row && ({
    id: row.id, code: row.code, name: row.name, category: row.category, description: row.description, biomaterial: row.biomaterial,
    biomaterialName: BIOMATERIALS[row.biomaterial]?.name || row.biomaterial, unit: row.unit, preparation: row.preparation,
    turnaroundHours: row.turnaround_hours, requiresBooking: row.requires_booking === 1, fasting: row.fasting === 1,
    components: parseJson(row.components_json, []), active: row.active === 1, version: row.version,
    ...(synonyms ? { synonyms: statements.synonymsOf.all(row.id).map((item) => item.synonym).filter((item) => item !== row.name) } : {}),
  });
  const offeringView = (row) => ({
    branchId: row.branch_id, testCode: row.code, testName: row.test_name, price: row.price, currency: row.currency, available: row.available === 1,
    turnaroundHours: row.turnaround_hours, conditions: row.conditions, priceDate: row.price_date, demo: row.demo === 1,
    ...(row.biomaterial ? { biomaterial: row.biomaterial, fasting: row.fasting === 1, category: row.category } : {}),
  });
  const feeView = (row) => ({ branchId: row.branch_id, kind: row.kind, name: row.name, price: row.price });

  const listLabs = ({ includeInactive = false } = {}) => statements.labs.all().filter((row) => includeInactive || row.active === 1).map(labView);
  const getLab = (id) => labView(statements.lab.get(id));
  const listBranches = ({ labId = null, includeInactive = false } = {}) => (labId ? statements.branchesOfLab.all(labId) : statements.branches.all())
    .filter((row) => includeInactive || row.active === 1).map(branchView);
  const getBranch = (id) => branchView(statements.branch.get(id));
  const listTests = ({ includeInactive = false, synonyms = false } = {}) => statements.tests.all()
    .filter((row) => includeInactive || row.active === 1).map((row) => testView(row, { synonyms }));
  const getTest = (code) => testView(statements.testByCode.get(code), { synonyms: true });
  const synonymIndex = () => statements.synonyms.all().map((row) => ({ code: row.code, synonym: row.synonym, normalized: row.normalized }));
  const branchOfferings = (branchId) => statements.offeringsOfBranch.all(branchId).map(offeringView);
  const testOfferings = (code) => {
    const test = statements.testByCode.get(code);
    return test ? statements.offeringsOfTest.all(test.id).map((row) => ({ ...offeringView({ ...row, code }), labId: row.lab_id, branchName: row.branch_name })) : [];
  };
  const branchFees = (branchId) => statements.feesOfBranch.all(branchId).map(feeView);
  /** Всё для подбора одним проходом: активные филиалы, их цены и процедуры. */
  const snapshot = () => {
    const labs = new Map(listLabs().map((lab) => [lab.id, lab]));
    const branches = listBranches().filter((branch) => labs.has(branch.labId));
    const offerings = new Map();
    for (const row of statements.allOfferings.all()) {
      if (!offerings.has(row.branch_id)) offerings.set(row.branch_id, new Map());
      offerings.get(row.branch_id).set(row.code, offeringView(row));
    }
    const fees = new Map();
    for (const row of statements.allFees.all()) {
      if (!fees.has(row.branch_id)) fees.set(row.branch_id, new Map());
      fees.get(row.branch_id).set(row.kind, feeView(row));
    }
    const tests = new Map(listTests().map((test) => [test.code, test]));
    return { labs, branches, offerings, fees, tests };
  };
  const demoResults = (code) => statements.demoResults.all(code).map((row) => ({ id: row.id, testCode: row.code, title: row.title, ...parseJson(row.payload, {}) }));

  /* ---------------------------- Расписание ---------------------------- */

  const generateBranchDay = (branchRow, day, at) => {
    const collection = parseJson(branchRow.collection_json, {});
    const windows = collection[weekdayOf(day)] || collection[String(weekdayOf(day))] || [];
    const random = createRandom(seed, `${branchRow.id}|${day}`);
    for (const [from, to] of windows) {
      for (let minute = minutesOf(from); minute + branchRow.slot_minutes <= minutesOf(to); minute += branchRow.slot_minutes) {
        const start = timeOf(minute);
        const startAt = moscowMoment(day, start);
        // Часть мест уже занята другими пациентами исходного набора: утро загружено сильнее.
        const busy = minute < 600 ? 0.45 : 0.25;
        const taken = Math.min(branchRow.slot_capacity, [...Array(branchRow.slot_capacity)].filter(() => random.chance(busy)).length);
        statements.insertSlot.run(`${branchRow.id}-${day.replace(/-/gu, '')}-${start.replace(':', '')}`, branchRow.id, day, startAt,
          startAt + branchRow.slot_minutes * 60_000, branchRow.slot_capacity, taken, at);
      }
    }
    statements.addDay.run(branchRow.id, day, at);
  };

  /** Достраивает окно расписания на windowSize дней от «сегодня» по Москве. */
  const ensureWindow = (at = now()) => {
    const today = moscowDay(at);
    const days = Array.from({ length: windowSize }, (_, offset) => addDays(today, offset));
    const rows = statements.branches.all().filter((row) => row.active === 1);
    for (const day of days) {
      const missing = rows.filter((row) => !statements.hasDay.get(row.id, day));
      if (missing.length === 0) continue;
      immediate(() => {
        for (const row of missing) if (!statements.hasDay.get(row.id, day)) generateBranchDay(row, day, at);
      });
    }
    const cutoff = addDays(today, -7);
    statements.purgeOldSlots.run(cutoff);
    statements.purgeOldDays.run(cutoff);
    statements.forgetPastOwners.run(addDays(today, -LAB_OWNER_RETENTION_DAYS));
  };

  const slotView = (row, at) => {
    const free = Math.max(0, row.capacity - row.taken - row.booked);
    const past = row.start_at <= at;
    return {
      id: row.id, branchId: row.branch_id, day: row.day, start: moscowParts(row.start_at).time, end: moscowParts(row.end_at).time,
      startAt: new Date(row.start_at).toISOString(), endAt: new Date(row.end_at).toISOString(), capacity: row.capacity, free,
      bookable: free > 0 && !past && row.blocked === 0, past,
    };
  };

  /**
   * Свободные места филиалов на дни и в окне времени.
   * @returns {Map<string, object[]>} филиал → слоты по времени
   */
  const freeSlots = ({ branchIds, days, fromTime = null, toTime = null, at = now(), limitPerBranch = 200 }) => {
    ensureWindow(at);
    const result = new Map();
    if (!branchIds.length || !days.length) return result;
    const from = fromTime ? minutesOf(fromTime) : 0;
    const to = toTime ? minutesOf(toTime) : 24 * 60;
    const rows = db.prepare(`SELECT * FROM lab_slots WHERE branch_id IN (${branchIds.map(() => '?').join(',')})
      AND day IN (${days.map(() => '?').join(',')}) AND start_at > ? AND blocked = 0 AND taken + booked < capacity ORDER BY start_at`)
      .all(...branchIds, ...days, at);
    for (const row of rows) {
      const minute = minutesOf(moscowParts(row.start_at).time);
      if (minute < from || minute >= to) continue;
      if (!result.has(row.branch_id)) result.set(row.branch_id, []);
      const list = result.get(row.branch_id);
      if (list.length < limitPerBranch) list.push(slotView(row, at));
    }
    return result;
  };

  /** Расписание филиала по дням: все слоты с числом свободных мест. */
  const branchSchedule = ({ branchId, fromDay, toDay, at = now() }) => {
    ensureWindow(at);
    return statements.slotsOfBranch.all(branchId, fromDay, toDay).map((row) => slotView(row, at));
  };

  const getSlot = (slotId, at = now()) => {
    const row = statements.slot.get(slotId);
    return row ? slotView(row, at) : null;
  };

  /* ------------------------------ Запись ------------------------------ */

  const bookingView = (booking, at = now()) => {
    const slot = statements.slot.get(booking.slot_id);
    const branch = statements.branch.get(booking.branch_id);
    const lab = branch ? statements.lab.get(branch.lab_id) : null;
    const items = statements.itemsOf.all(booking.id);
    return {
      number: booking.number,
      status: booking.status,
      demo: booking.demo === 1,
      total: booking.total,
      currency: booking.currency,
      createdAt: new Date(booking.created_at).toISOString(),
      cancelledAt: booking.cancelled_at ? new Date(booking.cancelled_at).toISOString() : null,
      cancelledBy: booking.cancelled_by || null,
      slot: slot ? slotView(slot, at) : null,
      branch: branch ? { id: branch.id, name: branch.name, address: branch.address, lat: branch.lat, lng: branch.lng, phone: branch.phone } : null,
      lab: lab ? { id: lab.id, name: lab.name } : null,
      tests: items.filter((item) => item.kind === 'test').map((item) => ({ code: item.test_code, name: item.name, price: item.price, turnaroundHours: item.turnaround_hours })),
      fees: items.filter((item) => item.kind === 'fee').map((item) => ({ kind: item.fee_kind, name: item.name, price: item.price })),
      readyInHours: Math.max(0, ...items.filter((item) => item.kind === 'test').map((item) => item.turnaround_hours || 0)),
    };
  };

  /** Строки цены корзины в филиале: исследования и процедуры взятия (по одной на вид биоматериала). */
  const priceLines = (branchId, codes) => {
    const offerings = new Map(statements.offeringsOfBranch.all(branchId).map((row) => [row.code, row]));
    const fees = new Map(statements.feesOfBranch.all(branchId).map((row) => [row.kind, row]));
    const missing = [];
    const lines = [];
    const kinds = new Set();
    for (const code of codes) {
      const offering = offerings.get(code);
      const test = statements.testByCode.get(code);
      if (!offering || offering.available !== 1 || !test || test.active !== 1) {
        missing.push(code);
        continue;
      }
      lines.push({ kind: 'test', testCode: code, name: test.name, price: offering.price, turnaroundHours: offering.turnaround_hours });
      kinds.add(test.biomaterial);
    }
    for (const kind of BIOMATERIAL_KINDS) {
      if (!kinds.has(kind)) continue;
      const fee = fees.get(kind);
      if (!fee) {
        missing.push(`fee:${kind}`);
        continue;
      }
      lines.push({ kind: 'fee', feeKind: kind, name: fee.name, price: fee.price });
    }
    return { lines, missing, total: lines.reduce((sum, line) => sum + line.price, 0) };
  };

  const cleanCodes = (testCodes) => {
    if (!Array.isArray(testCodes) || testCodes.length === 0) throw new LabError('bad_request', 'Выберите хотя бы одно исследование.');
    if (testCodes.length > MAX_TESTS_PER_BOOKING) throw new LabError('bad_request', `Не больше ${MAX_TESTS_PER_BOOKING} исследований в одной записи.`);
    const codes = [...new Set(testCodes)];
    if (!codes.every((code) => typeof code === 'string' && CODE.test(code))) throw new LabError('bad_request', 'Неверный код исследования.');
    return codes;
  };

  /**
   * Запись: проверка состава в филиале, место в слоте и сохранение строк цены —
   * одна транзакция BEGIN IMMEDIATE. expectedTotal — сумма, которую видел
   * человек: если цена изменилась, запись не создаётся.
   */
  const book = ({ branchId, slotId, testCodes, idempotencyKey, accountId = null, expectedTotal = null, at = now() }) => {
    if (typeof branchId !== 'string' || !ID.test(branchId)) throw new LabError('bad_request', 'Неверный филиал.');
    if (typeof slotId !== 'string' || !SLOT_ID.test(slotId)) throw new LabError('bad_request', 'Неверное время.');
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY.test(idempotencyKey)) throw new LabError('bad_request', 'Нужен ключ запроса (idempotencyKey).');
    const codes = cleanCodes(testCodes);
    const owner = typeof accountId === 'string' && ACCOUNT_ID.test(accountId) ? accountId : null;
    return immediate(() => {
      const existing = statements.bookingByKey.get(idempotencyKey);
      if (existing) {
        if (existing.slot_id !== slotId || existing.branch_id !== branchId) throw new LabError('idempotency_conflict', 'Этот ключ запроса уже использован для другой записи.', 409);
        return { ...bookingView(existing, at), cancelToken: cancelTokenFor(existing.id), repeated: true, owned: owner !== null && existing.account_id === owner };
      }
      const branch = statements.branch.get(branchId);
      if (!branch || branch.active !== 1 || statements.lab.get(branch.lab_id)?.active !== 1) throw new LabError('branch_not_found', 'Филиал недоступен.', 404);
      const slot = statements.slot.get(slotId);
      if (!slot || slot.branch_id !== branchId) throw new LabError('slot_not_found', 'Такого времени в расписании нет.', 404);
      if (slot.start_at <= at) throw new LabError('slot_past', 'Это время уже прошло.', 409);
      const { lines, missing, total } = priceLines(branchId, codes);
      if (missing.some((item) => !item.startsWith('fee:'))) {
        throw new LabError('test_unavailable', 'В этом филиале нет части исследований. Выберите другой филиал или уберите их из корзины.', 409);
      }
      if (missing.length > 0) throw new LabError('test_unavailable', 'Этот биоматериал в филиале не принимают.', 409);
      if (Number.isInteger(expectedTotal) && expectedTotal !== total) {
        throw new LabError('price_changed', `Стоимость изменилась: теперь ${total} ₽. Проверьте состав и подтвердите ещё раз.`, 409);
      }
      if (statements.takeSlot.run(at, slotId, branchId, at).changes !== 1) throw new LabError('slot_full', 'На это время мест больше нет. Выберите другое.', 409);
      let number = makeNumber(at);
      while (statements.numberTaken.get(number)) number = makeNumber(at);
      const id = randomUUID();
      statements.insertBooking.run(id, number, branchId, slotId, total, idempotencyKey, owner, at, at);
      lines.forEach((line, index) => statements.insertItem.run(id, index + 1, line.kind, line.testCode || null, line.feeKind || null, line.name, line.price, line.turnaroundHours ?? null));
      return { ...bookingView(statements.bookingById.get(id), at), cancelToken: cancelTokenFor(id), repeated: false, owned: owner !== null };
    });
  };

  const cancelRow = (booking, by, at) => {
    if (booking.status === 'CANCELLED') return { ...bookingView(booking, at), alreadyCancelled: true, slotReleased: false };
    statements.cancelBooking.run(at, by, at, booking.id);
    const slot = statements.slot.get(booking.slot_id);
    // Прошедшее время свободным не становится.
    const slotReleased = Boolean(slot && slot.start_at > at && statements.freeSlotPlace.run(at, slot.id).changes === 1);
    return { ...bookingView(statements.bookingById.get(booking.id), at), alreadyCancelled: false, slotReleased };
  };

  /** Отмена по номеру и токену (пользователь). */
  const cancel = ({ number, cancelToken, at = now() }) => {
    if (typeof number !== 'string' || !NUMBER.test(number)) throw new LabError('bad_request', 'Неверный номер записи.');
    return immediate(() => {
      const booking = statements.bookingByNumber.get(number);
      if (!booking || !tokenMatches(booking.id, cancelToken)) throw new LabError('booking_not_found', 'Запись не найдена.', 404);
      return cancelRow(booking, 'user', at);
    });
  };

  /** Отмена администратором — без токена, право проверяет админ-панель. */
  const adminCancel = ({ number, at = now() }) => {
    if (typeof number !== 'string' || !NUMBER.test(number)) throw new LabError('bad_request', 'Неверный номер записи.');
    return immediate(() => {
      const booking = statements.bookingByNumber.get(number);
      if (!booking) throw new LabError('booking_not_found', 'Запись не найдена.', 404);
      return cancelRow(booking, 'admin', at);
    });
  };

  const lookup = ({ items, at = now() }) => (Array.isArray(items) ? items : []).slice(0, 20).map(({ number, cancelToken } = {}) => {
    if (typeof number !== 'string' || !NUMBER.test(number)) return { number: null, found: false };
    const booking = statements.bookingByNumber.get(number);
    if (!booking || !tokenMatches(booking.id, cancelToken)) return { number, found: false };
    return { found: true, ...bookingView(booking, at) };
  });

  const listForAccount = ({ accountId, at = now() }) => {
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return [];
    return statements.bookingsOfAccount.all(accountId, MAX_ACCOUNT_BOOKINGS).map((booking) => ({ ...bookingView(booking, at), cancelToken: cancelTokenFor(booking.id), owned: true }));
  };

  const accountBookings = (accountId, at = now()) => {
    if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) return [];
    return statements.bookingsOfAccount.all(accountId, MAX_ACCOUNT_BOOKINGS).map((booking) => bookingView(booking, at));
  };

  const forgetAccount = (accountId) => (typeof accountId === 'string' && ACCOUNT_ID.test(accountId) ? statements.forgetAccount.run(accountId).changes : 0);

  /** Записи для админ-панели: фильтр по статусу, лаборатории, дате приёма. Без аккаунтов и токенов. */
  const listBookings = ({ status = null, labId = null, fromDay = null, toDay = null, limit = 100, offset = 0, at = now() } = {}) => {
    const where = [];
    const args = [];
    if (status === 'CONFIRMED' || status === 'CANCELLED') {
      where.push('b.status = ?');
      args.push(status);
    }
    if (typeof labId === 'string' && ID.test(labId)) {
      where.push('br.lab_id = ?');
      args.push(labId);
    }
    if (isDay(fromDay)) {
      where.push('s.day >= ?');
      args.push(fromDay);
    }
    if (isDay(toDay)) {
      where.push('s.day <= ?');
      args.push(toDay);
    }
    const sql = `FROM lab_bookings b JOIN lab_slots s ON s.id = b.slot_id JOIN lab_branches br ON br.id = b.branch_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const total = db.prepare(`SELECT COUNT(*) AS count ${sql}`).get(...args).count;
    const rows = db.prepare(`SELECT b.* ${sql} ORDER BY s.start_at DESC LIMIT ? OFFSET ?`).all(...args, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
    return { total, items: rows.map((row) => bookingView(row, at)) };
  };

  /* --------------------------- Админ-панель --------------------------- */

  const bump = (table, id, version) => {
    const row = db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id);
    if (!row) throw new LabError('not_found', 'Запись не найдена.', 404);
    if (Number.isInteger(version) && version !== row.version) throw new LabError('version_conflict', 'Данные изменил кто-то другой. Обновите страницу.', 409);
  };

  const labFields = (input, { partial }) => {
    const fields = {};
    if (!partial || 'name' in input) fields.name = cleanText(input.name, 80, { required: true, field: 'Название' });
    if (!partial || 'description' in input) fields.description = cleanText(input.description, 600, { field: 'Описание' }) || '';
    for (const [key, max] of [['logo', 300], ['phone', 40], ['website', 200], ['email', 120]]) {
      if (!partial || key in input) fields[key] = cleanText(input[key], max, { field: key });
    }
    if ('active' in input) fields.active = input.active ? 1 : 0;
    return fields;
  };

  const createLab = (input, at = now()) => {
    const fields = labFields(input || {}, { partial: false });
    const id = typeof input?.id === 'string' && ID.test(input.id) ? input.id : `lab-${randomBytes(4).toString('hex')}`;
    return immediate(() => {
      if (statements.lab.get(id)) throw new LabError('conflict', 'Лаборатория с таким id уже есть.', 409);
      try {
        insertLab.run(id, fields.name, fields.description, fields.logo, fields.phone, fields.website, fields.email, at, at);
      } catch (error) {
        if (/UNIQUE/u.test(String(error?.message))) throw new LabError('conflict', 'Лаборатория с таким названием уже есть.', 409);
        throw error;
      }
      if (fields.active === 0) db.prepare('UPDATE laboratories SET active = 0 WHERE id = ?').run(id);
      return getLab(id);
    });
  };

  const updateTable = (table, id, fields, at) => {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    db.prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`)
      .run(...keys.map((key) => fields[key]), at, id);
  };

  const updateLab = (id, input, at = now()) => {
    const fields = labFields(input || {}, { partial: true });
    return immediate(() => {
      bump('laboratories', id, input?.version);
      try {
        updateTable('laboratories', id, fields, at);
      } catch (error) {
        if (/UNIQUE/u.test(String(error?.message))) throw new LabError('conflict', 'Лаборатория с таким названием уже есть.', 409);
        throw error;
      }
      return getLab(id);
    });
  };

  const branchFields = (input, { partial }) => {
    const fields = {};
    if (!partial || 'name' in input) fields.name = cleanText(input.name, 120, { required: true, field: 'Название' });
    if (!partial || 'address' in input) fields.address = cleanText(input.address, 200, { required: true, field: 'Адрес' });
    if (!partial || 'district' in input) fields.district = cleanText(input.district, 60, { field: 'Район' });
    if (!partial || 'phone' in input) fields.phone = cleanText(input.phone, 40, { field: 'Телефон' });
    if (!partial || 'lat' in input || 'lng' in input) {
      const lat = Number(input.lat);
      const lng = Number(input.lng);
      if (!(lat >= 55.5 && lat <= 56.1 && lng >= 48.6 && lng <= 49.6)) throw new LabError('validation', 'Координаты должны быть в пределах Казани.');
      fields.lat = lat;
      fields.lng = lng;
    }
    if (!partial || 'hours' in input) fields.hours_json = JSON.stringify(normalizeWeekly(input.hours, 'часы работы'));
    if (!partial || 'collection' in input) fields.collection_json = JSON.stringify(normalizeWeekly(input.collection, 'часы приёма биоматериала'));
    if (!partial || 'slotMinutes' in input) fields.slot_minutes = cleanInt(input.slotMinutes ?? 10, { min: 5, max: 60, field: 'Длительность слота' });
    if (!partial || 'slotCapacity' in input) fields.slot_capacity = cleanInt(input.slotCapacity ?? 2, { min: 1, max: 10, field: 'Мест в слоте' });
    if (!partial || 'bookingModes' in input) {
      const modes = Array.isArray(input.bookingModes) ? input.bookingModes.filter((mode) => ['online', 'walk_in', 'phone'].includes(mode)) : ['online', 'walk_in'];
      fields.booking_modes = (modes.length ? [...new Set(modes)] : ['online']).join(',');
    }
    if ('active' in input) fields.active = input.active ? 1 : 0;
    return fields;
  };

  /** Новое расписание: будущие слоты без записей пересоздаются, слоты с записями остаются. */
  const rebuildBranchSchedule = (branchId, at) => {
    const today = moscowDay(at);
    db.prepare('DELETE FROM lab_slots WHERE branch_id = ? AND day >= ? AND booked = 0 AND id NOT IN (SELECT slot_id FROM lab_bookings)').run(branchId, today);
    db.prepare('DELETE FROM lab_days WHERE branch_id = ? AND day >= ?').run(branchId, today);
  };

  const createBranch = (input, at = now()) => {
    const labId = input?.labId;
    if (typeof labId !== 'string' || !statements.lab.get(labId)) throw new LabError('validation', 'Укажите лабораторию.');
    const fields = branchFields(input, { partial: false });
    const id = typeof input?.id === 'string' && ID.test(input.id) ? input.id : `${labId}-${randomBytes(3).toString('hex')}`;
    return immediate(() => {
      if (statements.branch.get(id)) throw new LabError('conflict', 'Филиал с таким id уже есть.', 409);
      insertBranch.run(id, labId, fields.name, fields.address, fields.district, fields.lat, fields.lng, fields.phone, fields.hours_json, fields.collection_json,
        fields.slot_minutes, fields.slot_capacity, fields.booking_modes, at, at);
      if (fields.active === 0) db.prepare('UPDATE lab_branches SET active = 0 WHERE id = ?').run(id);
      return getBranch(id);
    });
  };

  const updateBranch = (id, input, at = now()) => {
    const fields = branchFields(input || {}, { partial: true });
    return immediate(() => {
      bump('lab_branches', id, input?.version);
      updateTable('lab_branches', id, fields, at);
      if ('collection_json' in fields || 'slot_minutes' in fields || 'slot_capacity' in fields) rebuildBranchSchedule(id, at);
      return getBranch(id);
    });
  };

  const testFields = (input, { partial }) => {
    const fields = {};
    if (!partial || 'name' in input) fields.name = cleanText(input.name, 160, { required: true, field: 'Название' });
    if (!partial || 'category' in input) {
      if (!CATEGORY_IDS.includes(input.category)) throw new LabError('validation', 'Неизвестная категория.');
      fields.category = input.category;
    }
    if (!partial || 'description' in input) fields.description = cleanText(input.description, 800, { field: 'Описание' }) || '';
    if (!partial || 'biomaterial' in input) {
      if (!BIOMATERIAL_KINDS.includes(input.biomaterial)) throw new LabError('validation', 'Неизвестный биоматериал.');
      fields.biomaterial = input.biomaterial;
    }
    if (!partial || 'unit' in input) fields.unit = cleanText(input.unit, 30, { field: 'Единица' });
    if (!partial || 'preparation' in input) fields.preparation = cleanText(input.preparation, 1200, { field: 'Подготовка' }) || '';
    if (!partial || 'turnaroundHours' in input) fields.turnaround_hours = cleanInt(input.turnaroundHours ?? 24, { min: 1, max: 720, field: 'Срок, ч' });
    if ('requiresBooking' in input) fields.requires_booking = input.requiresBooking ? 1 : 0;
    if ('fasting' in input) fields.fasting = input.fasting ? 1 : 0;
    if ('components' in input) {
      const list = Array.isArray(input.components) ? input.components.map((item) => cleanText(item, 80, { field: 'Состав' })).filter(Boolean).slice(0, 30) : [];
      fields.components_json = JSON.stringify(list);
    }
    if ('active' in input) fields.active = input.active ? 1 : 0;
    return fields;
  };

  const writeSynonyms = (testId, synonyms, name) => {
    if (!Array.isArray(synonyms)) return;
    const list = synonyms.map((item) => cleanText(item, 80, { field: 'Синоним' })).filter(Boolean).slice(0, 40);
    db.prepare('DELETE FROM lab_test_synonyms WHERE test_id = ?').run(testId);
    for (const synonym of [name, ...list]) insertSynonym.run(testId, synonym, normalizeLabText(synonym));
  };

  const createTest = (input, at = now()) => {
    const code = typeof input?.code === 'string' ? input.code.trim().toUpperCase() : '';
    if (!CODE.test(code)) throw new LabError('validation', 'Код: латинские заглавные буквы, цифры и «_», от 2 до 40 символов.');
    const fields = testFields(input, { partial: false });
    return immediate(() => {
      if (statements.testByCode.get(code)) throw new LabError('conflict', 'Исследование с таким кодом уже есть.', 409);
      const id = testIdOf(code);
      insertTest.run(id, code, fields.name, fields.category, fields.description, fields.biomaterial, fields.unit, fields.preparation, fields.turnaround_hours,
        fields.requires_booking || 0, fields.fasting || 0, fields.components_json || '[]', at, at);
      if (fields.active === 0) db.prepare('UPDATE lab_tests SET active = 0 WHERE id = ?').run(id);
      writeSynonyms(id, input.synonyms || [], fields.name);
      return getTest(code);
    });
  };

  const updateTest = (code, input, at = now()) => {
    const row = statements.testByCode.get(code);
    if (!row) throw new LabError('not_found', 'Исследование не найдено.', 404);
    const fields = testFields(input || {}, { partial: true });
    return immediate(() => {
      bump('lab_tests', row.id, input?.version);
      updateTable('lab_tests', row.id, fields, at);
      if ('synonyms' in (input || {}) || 'name' in fields) writeSynonyms(row.id, input.synonyms ?? statements.synonymsOf.all(row.id).map((item) => item.synonym), fields.name || row.name);
      return getTest(code);
    });
  };

  /** Цена и доступность исследования в филиале. */
  const upsertOffering = ({ branchId, testCode, price, available = true, turnaroundHours, conditions = null, priceDate = null }, at = now()) => {
    const branch = statements.branch.get(branchId);
    const test = statements.testByCode.get(testCode);
    if (!branch) throw new LabError('not_found', 'Филиал не найден.', 404);
    if (!test) throw new LabError('not_found', 'Исследование не найдено.', 404);
    const cleanPrice = cleanInt(price, { min: 0, max: 200_000, field: 'Цена' });
    const hours = cleanInt(turnaroundHours ?? test.turnaround_hours, { min: 1, max: 720, field: 'Срок, ч' });
    const date = priceDate === null ? moscowDay(at) : priceDate;
    if (!isDay(date)) throw new LabError('validation', 'Дата цены: ГГГГ-ММ-ДД.');
    immediate(() => upsertOfferingStmt.run(`off-${branchId}-${testCode.toLowerCase()}`, branchId, test.id, cleanPrice, available ? 1 : 0, hours,
      cleanText(conditions, 200, { field: 'Условия' }), date, at));
    return branchOfferings(branchId).find((item) => item.testCode === testCode);
  };

  const deleteOffering = ({ branchId, testCode }) => {
    const test = statements.testByCode.get(testCode);
    if (!test) throw new LabError('not_found', 'Исследование не найдено.', 404);
    return immediate(() => db.prepare('DELETE FROM lab_offerings WHERE branch_id = ? AND test_id = ?').run(branchId, test.id).changes === 1);
  };

  /** Стоимость процедуры взятия; null — филиал этот биоматериал не принимает. */
  const setFee = ({ branchId, kind, price }) => {
    if (!statements.branch.get(branchId)) throw new LabError('not_found', 'Филиал не найден.', 404);
    if (!BIOMATERIAL_KINDS.includes(kind)) throw new LabError('validation', 'Неизвестный биоматериал.');
    return immediate(() => {
      if (price === null) {
        db.prepare('DELETE FROM lab_fees WHERE branch_id = ? AND kind = ?').run(branchId, kind);
        return null;
      }
      insertFee.run(branchId, kind, BIOMATERIALS[kind].fee, cleanInt(price, { min: 0, max: 20_000, field: 'Стоимость процедуры' }));
      return branchFees(branchId).find((item) => item.kind === kind);
    });
  };

  /** Сброс демо: удаляет всё и заполняет исходным набором. */
  const reset = (at = now()) => {
    immediate(() => {
      db.exec(`DELETE FROM lab_booking_items; DELETE FROM lab_bookings; DELETE FROM lab_slots; DELETE FROM lab_days; DELETE FROM lab_demo_results;
        DELETE FROM lab_offerings; DELETE FROM lab_fees; DELETE FROM lab_branches; DELETE FROM laboratories; DELETE FROM lab_test_synonyms; DELETE FROM lab_tests;`);
      seedDemo(at);
    });
    ensureWindow(at);
  };

  const stats = () => ({
    labs: db.prepare('SELECT COUNT(*) AS count FROM laboratories').get().count,
    branches: db.prepare('SELECT COUNT(*) AS count FROM lab_branches').get().count,
    tests: db.prepare('SELECT COUNT(*) AS count FROM lab_tests').get().count,
    offerings: db.prepare('SELECT COUNT(*) AS count FROM lab_offerings').get().count,
    slots: db.prepare('SELECT COUNT(*) AS count FROM lab_slots').get().count,
    bookings: db.prepare("SELECT COUNT(*) AS count FROM lab_bookings WHERE status = 'CONFIRMED'").get().count,
  });

  return Object.freeze({
    kind: 'sqlite',
    listLabs, getLab, listBranches, getBranch, listTests, getTest, synonymIndex, branchOfferings, testOfferings, branchFees, snapshot, demoResults,
    ensureWindow, freeSlots, branchSchedule, getSlot, priceLines,
    book, cancel, adminCancel, lookup, listForAccount, accountBookings, forgetAccount, listBookings,
    createLab, updateLab, createBranch, updateBranch, createTest, updateTest, upsertOffering, deleteOffering, setFee,
    reset, stats,
    close: () => db.close(),
  });
};
