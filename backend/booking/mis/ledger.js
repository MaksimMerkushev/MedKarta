/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Журнал интеграций с МИС (SQLite, var/integrations/integrations.sqlite):
 *   integrations   — подключённые клиники: тип МИС, несекретная конфигурация,
 *                    имя переменной окружения с секретом (сам секрет — только
 *                    в окружении сервера, не в базе и не в git);
 *   mappings       — соответствие внешних id (врач, филиал, услуга,
 *                    специальность) id МедКарты; вручную или скриптом,
 *                    никогда — по совпадению ФИО;
 *   catalog        — последний снимок справочников МИС (без данных пациентов);
 *   booking_ops    — операции записи: наш ключ запроса (уникален), слот,
 *                    состояние жизненного цикла, внешний id записи в МИС;
 *                    активная операция на слот — одна (частичный индекс);
 *   booking_events — история переходов состояний (аудит);
 *   sync_runs, tech_events — синхронизации и технический журнал (коды, без ПДн);
 *   webhook_events — id принятых webhook-событий (повтор не применяется дважды).
 * Данные пациента (ФИО, телефон) здесь не хранятся: они уходят только в МИС.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BookingError } from '../errors.js';
import { ACTIVE_STATES, BOOKING_STATES, canTransition } from './core.js';

const SCHEMA_VERSION = 1;
export const INTEGRATION_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const MIS_NUMBER = /^MK-\d{6}-[A-Z0-9]{5}$/;
const NUMBER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAPPING_KINDS = Object.freeze(['branch', 'doctor', 'service', 'specialty']);
const SAFE_DETAIL = (value) => String(value ?? '').replace(/[^\p{L}\p{N}\s.,:_()×/-]/gu, '').slice(0, 160);

export const createMisLedger = ({ DatabaseSync, file, now = () => Date.now() }) => {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    const states = BOOKING_STATES.map((state) => `'${state}'`).join(',');
    const active = ACTIVE_STATES.map((state) => `'${state}'`).join(',');
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE integrations (
        id TEXT PRIMARY KEY, clinic_id TEXT NOT NULL, mis_type TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', secret_env TEXT,
        status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE mappings (
        integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('branch','doctor','service','specialty')),
        external_id TEXT NOT NULL, medkarta_id TEXT NOT NULL,
        PRIMARY KEY (integration_id, kind, external_id)
      );
      CREATE INDEX mappings_by_internal ON mappings (integration_id, kind, medkarta_id);
      CREATE TABLE catalog (
        integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, external_id TEXT NOT NULL, data_json TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (integration_id, kind, external_id)
      );
      CREATE TABLE booking_ops (
        id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL UNIQUE,
        integration_id TEXT NOT NULL REFERENCES integrations(id),
        slot_id TEXT NOT NULL, external_slot_id TEXT NOT NULL,
        doctor_id TEXT NOT NULL, branch_id TEXT NOT NULL, clinic_id TEXT NOT NULL, service_id TEXT,
        start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN (${states})),
        external_booking_id TEXT, hold_ref TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        account_id TEXT, reconcile_after INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, confirmed_at INTEGER, cancelled_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX booking_ops_active_slot ON booking_ops (integration_id, external_slot_id) WHERE state IN (${active});
      CREATE INDEX booking_ops_by_state ON booking_ops (state, reconcile_after);
      CREATE INDEX booking_ops_by_account ON booking_ops (account_id);
      CREATE TABLE booking_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL REFERENCES booking_ops(id),
        at INTEGER NOT NULL, from_state TEXT, to_state TEXT NOT NULL, reason TEXT
      );
      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, integration_id TEXT NOT NULL, kind TEXT NOT NULL,
        started_at INTEGER NOT NULL, finished_at INTEGER, ok INTEGER, counts_json TEXT, error_code TEXT
      );
      CREATE TABLE tech_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, integration_id TEXT NOT NULL, at INTEGER NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('info','warn','error')), code TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX tech_events_recent ON tech_events (integration_id, at);
      CREATE TABLE webhook_events (
        integration_id TEXT NOT NULL, event_id TEXT NOT NULL, received_at INTEGER NOT NULL,
        PRIMARY KEY (integration_id, event_id)
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }
  let secret = db.prepare("SELECT value FROM meta WHERE key = 'token_secret'").get()?.value;
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    db.prepare("INSERT INTO meta (key, value) VALUES ('token_secret', ?)").run(secret);
  }

  const immediate = (work) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  /* ---------------------------- Интеграции ---------------------------- */

  const integrationView = (row) => row && ({
    id: row.id, clinicId: row.clinic_id, misType: row.mis_type, title: row.title, enabled: row.enabled === 1,
    config: JSON.parse(row.config_json), secretEnv: row.secret_env || null, status: row.status,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  });

  const upsertIntegration = ({ id, clinicId, misType, title = '', enabled = false, config = {}, secretEnv = null }) => {
    if (!INTEGRATION_ID.test(String(id))) throw new TypeError('Интеграция: неверный id.');
    if (secretEnv !== null && !/^MIS_[A-Z0-9_]{2,60}$/.test(String(secretEnv))) throw new TypeError('Интеграция: имя переменной секрета — MIS_…');
    const serialized = JSON.stringify(config);
    if (/password|secret|token|apikey|api_key/i.test(Object.keys(config).join(' '))) throw new TypeError('Интеграция: секреты не хранятся в конфигурации — только имя переменной окружения.');
    const at = now();
    db.prepare(`INSERT INTO integrations (id, clinic_id, mis_type, title, enabled, config_json, secret_env, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET clinic_id = excluded.clinic_id, mis_type = excluded.mis_type, title = excluded.title,
        enabled = excluded.enabled, config_json = excluded.config_json, secret_env = excluded.secret_env, updated_at = excluded.updated_at`)
      .run(id, clinicId, misType, title, enabled ? 1 : 0, serialized, secretEnv, at, at);
    return getIntegration(id);
  };
  const getIntegration = (id) => integrationView(db.prepare('SELECT * FROM integrations WHERE id = ?').get(id));
  const listIntegrations = () => db.prepare('SELECT * FROM integrations ORDER BY id').all().map(integrationView);
  const setIntegrationStatus = (id, status) => db.prepare('UPDATE integrations SET status = ?, updated_at = ? WHERE id = ?').run(String(status).slice(0, 32), now(), id);

  /* --------------------------- Соответствия --------------------------- */

  const setMapping = (integrationId, kind, externalId, medkartaId) => {
    if (!MAPPING_KINDS.includes(kind)) throw new TypeError(`Соответствие: неизвестный вид ${kind}.`);
    db.prepare(`INSERT INTO mappings (integration_id, kind, external_id, medkarta_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(integration_id, kind, external_id) DO UPDATE SET medkarta_id = excluded.medkarta_id`).run(integrationId, kind, String(externalId), String(medkartaId));
  };
  const toInternal = (integrationId, kind, externalId) => db.prepare('SELECT medkarta_id FROM mappings WHERE integration_id = ? AND kind = ? AND external_id = ?').get(integrationId, kind, String(externalId))?.medkarta_id ?? null;
  const toExternal = (integrationId, kind, medkartaId) => db.prepare('SELECT external_id FROM mappings WHERE integration_id = ? AND kind = ? AND medkarta_id = ?').get(integrationId, kind, String(medkartaId))?.external_id ?? null;
  const mappingsOf = (integrationId) => db.prepare('SELECT kind, external_id, medkarta_id FROM mappings WHERE integration_id = ? ORDER BY kind, external_id').all(integrationId)
    .map((row) => ({ kind: row.kind, externalId: row.external_id, medkartaId: row.medkarta_id }));

  /* ------------------------------ Справочники ------------------------------ */

  const replaceCatalog = (integrationId, kind, items) => immediate(() => {
    db.prepare('DELETE FROM catalog WHERE integration_id = ? AND kind = ?').run(integrationId, kind);
    const insert = db.prepare('INSERT INTO catalog (integration_id, kind, external_id, data_json, seen_at) VALUES (?, ?, ?, ?, ?)');
    const at = now();
    for (const item of items) insert.run(integrationId, kind, item.externalId, JSON.stringify(item), at);
  });
  const catalogOf = (integrationId, kind) => db.prepare('SELECT data_json FROM catalog WHERE integration_id = ? AND kind = ? ORDER BY external_id').all(integrationId, kind).map((row) => JSON.parse(row.data_json));

  /* ------------------------------ Операции ------------------------------ */

  const opView = (row) => row && ({
    id: row.id, number: row.number, requestId: row.request_id, integrationId: row.integration_id,
    slotId: row.slot_id, externalSlotId: row.external_slot_id, doctorId: row.doctor_id, branchId: row.branch_id,
    clinicId: row.clinic_id, serviceId: row.service_id, startAt: row.start_at, endAt: row.end_at,
    state: row.state, externalBookingId: row.external_booking_id, holdRef: row.hold_ref, attempts: row.attempts,
    lastError: row.last_error, accountId: row.account_id, reconcileAfter: row.reconcile_after,
    createdAt: row.created_at, updatedAt: row.updated_at, confirmedAt: row.confirmed_at, cancelledAt: row.cancelled_at, version: row.version,
  });
  const getOp = (id) => opView(db.prepare('SELECT * FROM booking_ops WHERE id = ?').get(id));
  const opByRequest = (requestId) => opView(db.prepare('SELECT * FROM booking_ops WHERE request_id = ?').get(requestId));
  const opByNumber = (number) => opView(db.prepare('SELECT * FROM booking_ops WHERE number = ?').get(number));
  const opByExternalBooking = (integrationId, externalBookingId) => opView(db.prepare('SELECT * FROM booking_ops WHERE integration_id = ? AND external_booking_id = ?').get(integrationId, String(externalBookingId)));
  const opsForReconcile = (at = now(), limit = 50) => db.prepare("SELECT * FROM booking_ops WHERE state IN ('pending_reconciliation','cancel_pending') AND (reconcile_after IS NULL OR reconcile_after <= ?) ORDER BY updated_at LIMIT ?").all(at, limit).map(opView);
  const opsByAccount = (accountId) => db.prepare('SELECT * FROM booking_ops WHERE account_id = ? ORDER BY created_at DESC LIMIT 50').all(accountId).map(opView);
  const eventsOf = (opId) => db.prepare('SELECT at, from_state, to_state, reason FROM booking_events WHERE op_id = ? ORDER BY id').all(opId)
    .map((row) => ({ at: new Date(row.at).toISOString(), from: row.from_state, to: row.to_state, reason: row.reason }));

  const newNumber = (at) => {
    const day = new Date(at).toISOString().slice(2, 10).replace(/-/g, '');
    const tail = Array.from(randomBytes(5), (byte) => NUMBER_ALPHABET[byte % NUMBER_ALPHABET.length]).join('');
    return `MK-${day}-${tail}`;
  };

  /**
   * Новая операция. Тот же requestId — та же операция (existing: true).
   * Активная операция на этот слот уже есть — slot_taken без обращения к МИС.
   */
  const createOp = ({ requestId, integrationId, slotId, externalSlotId, doctorId, branchId, clinicId, serviceId = null, startAt, endAt, state, accountId = null }) => immediate(() => {
    const existing = opByRequest(requestId);
    if (existing) return { op: existing, existing: true };
    const at = now();
    const id = randomBytes(12).toString('base64url');
    try {
      db.prepare(`INSERT INTO booking_ops (id, number, request_id, integration_id, slot_id, external_slot_id, doctor_id, branch_id, clinic_id, service_id,
        start_at, end_at, state, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, newNumber(at), requestId, integrationId, slotId, externalSlotId, doctorId, branchId, clinicId, serviceId, startAt, endAt, state, accountId, at, at);
    } catch (error) {
      if (/UNIQUE constraint failed: booking_ops\.integration_id, booking_ops\.external_slot_id/.test(error.message)) {
        throw new BookingError('slot_taken', 'Это время уже занято.');
      }
      throw error;
    }
    db.prepare('INSERT INTO booking_events (op_id, at, from_state, to_state, reason) VALUES (?, ?, NULL, ?, ?)').run(id, at, state, 'created');
    return { op: getOp(id), existing: false };
  });

  /** Переход состояния. Недопустимый переход — ошибка программы; гонка версий — conflict. */
  const transition = (opId, to, { reason = null, externalBookingId, holdRef, error, attempt = false, reconcileAfter } = {}) => immediate(() => {
    const op = getOp(opId);
    if (!op) throw new BookingError('booking_not_found', 'Запись не найдена.');
    if (op.state === to) return op;
    if (!canTransition(op.state, to)) throw new Error(`Недопустимый переход ${op.state} → ${to}`);
    const at = now();
    const changed = db.prepare(`UPDATE booking_ops SET state = ?, updated_at = ?, version = version + 1,
        external_booking_id = COALESCE(?, external_booking_id), hold_ref = CASE WHEN ? THEN ? ELSE hold_ref END,
        last_error = ?, attempts = attempts + ?, reconcile_after = ?,
        confirmed_at = CASE WHEN ? = 'confirmed' THEN ? ELSE confirmed_at END,
        cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END
      WHERE id = ? AND version = ?`).run(
      to, at, externalBookingId ?? null, holdRef !== undefined ? 1 : 0, holdRef ?? null, error ?? null, attempt ? 1 : 0,
      reconcileAfter ?? null, to, at, to, at, opId, op.version,
    ).changes;
    if (changed !== 1) throw new BookingError('slot_conflict', 'Запись изменилась одновременно — повторите.');
    db.prepare('INSERT INTO booking_events (op_id, at, from_state, to_state, reason) VALUES (?, ?, ?, ?, ?)').run(opId, at, op.state, to, reason ? SAFE_DETAIL(reason) : null);
    return getOp(opId);
  });
  const deferReconcile = (opId, reconcileAfter) => db.prepare('UPDATE booking_ops SET reconcile_after = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?').run(reconcileAfter, now(), opId);

  const cancelTokenFor = (opId) => createHmac('sha256', secret).update(`cancel:${opId}`).digest('base64url');
  const tokenMatches = (opId, token) => {
    if (typeof token !== 'string') return false;
    const expected = Buffer.from(cancelTokenFor(opId));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  /* ---------------------- Синхронизация и журнал ---------------------- */

  const startRun = (integrationId, kind) => Number(db.prepare('INSERT INTO sync_runs (integration_id, kind, started_at) VALUES (?, ?, ?)').run(integrationId, kind, now()).lastInsertRowid);
  const finishRun = (runId, { ok, counts = {}, errorCode = null }) => db.prepare('UPDATE sync_runs SET finished_at = ?, ok = ?, counts_json = ?, error_code = ? WHERE id = ?')
    .run(now(), ok ? 1 : 0, JSON.stringify(counts), errorCode, runId);
  const lastRuns = (integrationId, limit = 10) => db.prepare('SELECT * FROM sync_runs WHERE integration_id = ? ORDER BY id DESC LIMIT ?').all(integrationId, limit)
    .map((row) => ({ kind: row.kind, startedAt: new Date(row.started_at).toISOString(), finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null, ok: row.ok === 1, counts: row.counts_json ? JSON.parse(row.counts_json) : null, errorCode: row.error_code }));
  const lastSuccess = (integrationId) => db.prepare('SELECT finished_at FROM sync_runs WHERE integration_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(integrationId)?.finished_at ?? null;

  /** Технический журнал: код и безопасная подробность (без ФИО, телефонов, текста МИС). */
  const event = (integrationId, level, code, detail = '') => db.prepare('INSERT INTO tech_events (integration_id, at, level, code, detail) VALUES (?, ?, ?, ?, ?)')
    .run(integrationId, now(), level, String(code).replace(/[^a-z0-9_.]/gi, '').slice(0, 48), SAFE_DETAIL(detail));
  const recentEvents = (integrationId, limit = 50) => db.prepare('SELECT at, level, code, detail FROM tech_events WHERE integration_id = ? ORDER BY id DESC LIMIT ?').all(integrationId, limit)
    .map((row) => ({ at: new Date(row.at).toISOString(), level: row.level, code: row.code, detail: row.detail }));
  const rememberWebhook = (integrationId, eventId) => {
    try {
      db.prepare('INSERT INTO webhook_events (integration_id, event_id, received_at) VALUES (?, ?, ?)').run(integrationId, eventId, now());
      return true;
    } catch {
      return false;
    }
  };

  const stats = (integrationId) => ({
    ops: Object.fromEntries(db.prepare('SELECT state, COUNT(*) AS n FROM booking_ops WHERE integration_id = ? GROUP BY state').all(integrationId).map((row) => [row.state, row.n])),
    mappings: Object.fromEntries(db.prepare('SELECT kind, COUNT(*) AS n FROM mappings WHERE integration_id = ? GROUP BY kind').all(integrationId).map((row) => [row.kind, row.n])),
    errors24h: db.prepare("SELECT COUNT(*) AS n FROM tech_events WHERE integration_id = ? AND level = 'error' AND at >= ?").get(integrationId, now() - 86_400_000).n,
  });

  return Object.freeze({
    upsertIntegration, getIntegration, listIntegrations, setIntegrationStatus,
    setMapping, toInternal, toExternal, mappingsOf, replaceCatalog, catalogOf,
    createOp, transition, deferReconcile, getOp, opByRequest, opByNumber, opByExternalBooking, opsForReconcile, opsByAccount, eventsOf,
    cancelTokenFor, tokenMatches, startRun, finishRun, lastRuns, lastSuccess, event, recentEvents, rememberWebhook, stats,
    close: () => db.close(),
  });
};
