/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Интеграции с МИС на сервере: какие включены, их коннекторы, синхронизация
 * справочников, сверка записей с неизвестным исходом, проверка подключения и
 * приём webhook-событий.
 *
 * Флаги (по умолчанию всё выключено):
 *   MIS_INTEGRATIONS=on — слой интеграций работает (без него — только демо);
 *   MIS_SIMULATOR=on    — разрешён симулятор (вне production);
 *   REAL_BOOKING=on     — разрешены адаптеры настоящих МИС. Их пока нет:
 *                         адаптер добавляется в ADAPTERS только по официальной
 *                         документации МИС и после проверки на её тестовом стенде.
 * Секреты интеграции — в окружении сервера: MIS_<…> (имя — в интеграции),
 * webhook — MIS_<…>_WEBHOOK. Смена секрета — новое значение переменной и
 * перезапуск; в базе и git секретов нет.
 */

import { randomBytes } from 'node:crypto';

import { MisError } from './core.js';
import { createMisConnector } from './connector.js';
import { normalizeBookingStatus, normalizeBranches, normalizeDoctors, normalizeServices } from './normalize.js';
import { createSimulatorAdapter } from './simulator/adapter.js';

export const misFlags = (env = process.env) => {
  const production = env.NODE_ENV === 'production' || env.APP_ENV === 'production';
  return {
    enabled: env.MIS_INTEGRATIONS === 'on',
    simulator: env.MIS_SIMULATOR === 'on' && !production,
    realBooking: env.REAL_BOOKING === 'on',
    production,
  };
};

/* Фабрики адаптеров по типу МИС. Настоящих пока нет — см. начало файла. */
export const ADAPTERS = Object.freeze({
  'mis-simulator': ({ integration, env }) => createSimulatorAdapter({
    baseUrl: integration.config.baseUrl,
    token: integration.secretEnv ? env[integration.secretEnv] : null,
    webhookSecret: integration.secretEnv ? env[`${integration.secretEnv}_WEBHOOK`] ?? null : null,
    ...(integration.config.capabilities ? { can: integration.config.capabilities } : {}),
    ...(integration.config.timeoutMs ? { timeoutMs: integration.config.timeoutMs } : {}),
  }),
});
const SIMULATOR_TYPES = new Set(['mis-simulator']);

/**
 * @param {object} deps
 * @param {object} deps.ledger журнал (createMisLedger)
 * @param {object} [deps.env]
 * @param {object} [deps.adapters] фабрики (для тестов)
 */
export const createMisRuntime = ({ ledger, env = process.env, adapters = ADAPTERS, now = () => Date.now(), logger = null }) => {
  const flags = misFlags(env);
  const holdSecret = randomBytes(32).toString('base64url');
  const entries = new Map();
  let onScheduleChanged = () => {};

  for (const integration of ledger.listIntegrations()) {
    if (!integration.enabled) continue;
    const factory = adapters[integration.misType];
    const simulator = SIMULATOR_TYPES.has(integration.misType);
    let problem = null;
    if (!factory) problem = 'no_adapter';
    else if (simulator && !flags.simulator) problem = 'simulator_not_allowed';
    else if (!simulator && !flags.realBooking) problem = 'real_booking_off';
    else if (integration.secretEnv && !env[integration.secretEnv]) problem = 'secret_missing';
    if (problem) {
      ledger.setIntegrationStatus(integration.id, problem);
      ledger.event(integration.id, 'warn', 'not_started', problem);
      continue;
    }
    try {
      const adapter = factory({ integration, env });
      const connector = createMisConnector({ integration, adapter, ledger, now, holdSecret, logger });
      entries.set(integration.id, { integration, adapter, connector });
    } catch (error) {
      ledger.setIntegrationStatus(integration.id, 'config_error');
      ledger.event(integration.id, 'error', 'config_error', error.message);
    }
  }

  /** Справочники МИС: снимок, сверка соответствий, отбракованные записи; затем сверка записей. */
  const syncIntegration = async (id) => {
    const entry = entries.get(id);
    if (!entry) throw new MisError('invalid_request', 'not_running');
    const { adapter, connector } = entry;
    const run = ledger.startRun(id, 'catalog');
    const counts = {};
    try {
      const kinds = [['branch', 'branches', normalizeBranches, 'listBranches'], ['doctor', 'doctors', normalizeDoctors, 'listDoctors'], ['service', 'services', normalizeServices, 'listServices']];
      for (const [kind, capability, normalize, method] of kinds) {
        if (!adapter.can[capability]) continue;
        const { valid, rejected } = normalize(await adapter[method]());
        ledger.replaceCatalog(id, kind, valid);
        counts[capability] = valid.length;
        if (rejected.length) {
          counts[`${capability}Rejected`] = rejected.length;
          const reasons = [...new Set(rejected.map((item) => item.reason))].join(', ');
          ledger.event(id, 'warn', `${kind}_rejected`, `${rejected.length}: ${reasons}`);
        }
        const mapped = new Set(ledger.mappingsOf(id).filter((item) => item.kind === kind).map((item) => item.externalId));
        const external = new Set(valid.map((item) => item.externalId));
        const unmapped = [...external].filter((value) => !mapped.has(value)).length;
        const stale = [...mapped].filter((value) => !external.has(value)).length;
        if (unmapped) ledger.event(id, 'info', `${kind}_unmapped`, `без соответствия в МедКарте: ${unmapped}`);
        if (stale) ledger.event(id, 'warn', `${kind}_mapping_stale`, `соответствие есть, в МИС больше нет: ${stale}`);
        counts[`${capability}Unmapped`] = unmapped;
        counts[`${capability}Stale`] = stale;
      }
      counts.reconcile = await connector.reconcileAll();
      ledger.finishRun(run, { ok: true, counts });
      ledger.setIntegrationStatus(id, 'ok');
      onScheduleChanged(id);
      return { ok: true, counts };
    } catch (error) {
      const code = error instanceof MisError ? error.code : 'unknown';
      ledger.finishRun(run, { ok: false, counts, errorCode: code });
      ledger.setIntegrationStatus(id, 'error');
      ledger.event(id, 'error', `sync_${code}`, error instanceof MisError ? error.detail : '');
      return { ok: false, errorCode: code, counts };
    }
  };

  /** Проверка подключения: лёгкий запрос к МИС, только код результата и время. */
  const testConnection = async (id) => {
    const entry = entries.get(id);
    if (!entry) return { ok: false, errorCode: ledger.getIntegration(id)?.status || 'not_found' };
    const started = now();
    try {
      if (entry.adapter.can.branches) await entry.adapter.listBranches();
      else await entry.adapter.listSlots({ doctorIds: [], branchIds: [], from: started, to: started + 3_600_000 });
      ledger.event(id, 'info', 'test_ok', `${now() - started} мс`);
      return { ok: true, ms: now() - started };
    } catch (error) {
      const code = error instanceof MisError ? error.code : 'unknown';
      ledger.event(id, 'warn', `test_${code}`, error instanceof MisError ? error.detail : '');
      return { ok: false, errorCode: code, ms: now() - started };
    }
  };

  /**
   * Webhook: подпись проверяет адаптер (схема — поставщика МИС), повтор события
   * не применяется, неизвестное событие — отказ без изменений.
   */
  const handleWebhook = async (id, { headers, rawBody }) => {
    const entry = entries.get(id);
    if (!entry || !entry.adapter.can.webhooks) return { status: 404 };
    const verified = entry.adapter.verifyWebhook({ headers, rawBody });
    if (!verified.ok) {
      ledger.event(id, 'warn', 'webhook_rejected', verified.reason);
      return { status: 401 };
    }
    if (!ledger.rememberWebhook(id, verified.eventId)) return { status: 200, duplicate: true };
    let events;
    try {
      events = entry.adapter.parseWebhook(JSON.parse(rawBody));
    } catch {
      ledger.event(id, 'warn', 'webhook_invalid', '');
      return { status: 400 };
    }
    for (const item of events) {
      if (item.type === 'schedule_changed') onScheduleChanged(id);
      if (item.type === 'booking_status') {
        const op = ledger.opByExternalBooking(id, item.externalBookingId);
        const status = normalizeBookingStatus(item.status);
        if (!op || !status) {
          ledger.event(id, 'info', 'webhook_unknown_booking', '');
          continue;
        }
        const next = status === 'cancelled' && ['confirmed', 'cancel_pending', 'pending_reconciliation'].includes(op.state) ? (op.state === 'pending_reconciliation' ? 'failed' : 'cancelled')
          : status === 'completed' && op.state === 'confirmed' ? 'completed'
            : status === 'confirmed' && op.state === 'pending_reconciliation' ? 'confirmed' : null;
        if (next) ledger.transition(op.id, next, { reason: 'mis_webhook' });
        onScheduleChanged(id);
      }
    }
    return { status: 200 };
  };

  let timer = null;
  const syncAll = async () => {
    for (const id of entries.keys()) {
      try {
        await syncIntegration(id);
      } catch (error) {
        logger?.error?.('mis.sync_failed', error);
      }
    }
  };

  return Object.freeze({
    flags,
    connectors: () => [...entries.values()].map((entry) => entry.connector),
    running: (id) => entries.has(id),
    syncIntegration, syncAll, testConnection, handleWebhook,
    setScheduleListener: (listener) => { onScheduleChanged = listener; },
    startLoop: (intervalMs = 10 * 60 * 1000) => {
      if (timer || !entries.size) return;
      timer = setInterval(() => { syncAll(); }, intervalMs);
      timer.unref?.();
    },
    stop: () => { if (timer) clearInterval(timer); timer = null; },
  });
};
