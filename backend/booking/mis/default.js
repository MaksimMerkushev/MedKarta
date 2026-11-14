/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общий экземпляр интеграций с МИС для сервера: журнал в
 * INTEGRATIONS_DB_PATH (по умолчанию var/integrations/integrations.sqlite) и
 * среда выполнения (mis/runtime.js). Без MIS_INTEGRATIONS=on — null: сервер
 * работает как раньше, только с демо-записью.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlite } from '../../demo/bookingStore.js';
import { logger } from '../../observability/safeLogger.js';
import { createMisLedger } from './ledger.js';
import { createMisRuntime, misFlags } from './runtime.js';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
let runtime;

export const integrationsDbPath = (env = process.env) => env.INTEGRATIONS_DB_PATH || path.join(ROOT, 'var', 'integrations', 'integrations.sqlite');

/** { ledger, runtime } или null, если интеграции выключены. */
export const getDefaultMisRuntime = () => {
  if (runtime === undefined) {
    runtime = (async () => {
      if (!misFlags().enabled) return null;
      const DatabaseSync = await loadSqlite();
      if (!DatabaseSync) return null;
      const ledger = createMisLedger({ DatabaseSync, file: integrationsDbPath() });
      const instance = createMisRuntime({ ledger, logger });
      logger.event('mis.ready', { status: 'enabled', count: instance.connectors().length });
      return { ledger, runtime: instance };
    })().catch((error) => {
      logger.error('mis.failed', error);
      runtime = undefined;
      return null;
    });
  }
  return runtime;
};

/** Только для тестов. */
export const __resetMisRuntime = () => {
  runtime = undefined;
};
