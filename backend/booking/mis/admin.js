/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Админ-панель → «Интеграции с МИС»: подключённые клиники, тип МИС,
 * состояние, последняя синхронизация, ошибки, справочники и соответствия,
 * технический журнал (без персональных данных); проверка подключения и ручная
 * синхронизация. Права: integrations.view (просмотр), integrations.manage
 * (проверка и синхронизация). Секреты не показываются — только «задан / нет».
 */

import { getDefaultMisRuntime } from './default.js';
import { misFlags } from './runtime.js';

export class MisAdminError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'MisAdminError';
    this.code = code;
    this.status = status;
  }
}

export const MIS_ADMIN_PERMISSIONS = Object.freeze({
  integrationsList: 'integrations.view',
  integrationsDetail: 'integrations.view',
  integrationsTest: 'integrations.manage',
  integrationsSync: 'integrations.manage',
});

export const MIS_ADMIN_ROUTES = Object.freeze([
  ['GET', '/api/admin/integrations', 'integrationsList'],
  ['POST', '/api/admin/integrations/:id/test', 'integrationsTest'],
  ['POST', '/api/admin/integrations/:id/sync', 'integrationsSync'],
  ['GET', '/api/admin/integrations/:id', 'integrationsDetail'],
]);
export const MIS_ADMIN_WITH_BODY = Object.freeze(['integrationsTest', 'integrationsSync']);

/**
 * @param {object} deps
 * @param {() => Promise<{ledger, runtime}|null>} [deps.getRuntime]
 * @param {(actor, action, fields) => void} deps.audit
 */
export const createMisAdmin = ({ getRuntime = getDefaultMisRuntime, audit, env = process.env }) => {
  const summary = (ledger, runtime, integration) => ({
    id: integration.id,
    clinicId: integration.clinicId,
    misType: integration.misType,
    title: integration.title,
    enabled: integration.enabled,
    status: integration.status,
    running: runtime.running(integration.id),
    secretSet: integration.secretEnv ? Boolean(env[integration.secretEnv]) : null,
    lastSyncAt: ledger.lastSuccess(integration.id) ? new Date(ledger.lastSuccess(integration.id)).toISOString() : null,
    stats: ledger.stats(integration.id),
  });

  const run = async (actor, operation, { params = {} } = {}) => {
    const permission = MIS_ADMIN_PERMISSIONS[operation];
    if (!permission) throw new MisAdminError('not_found', 'Not found', 404);
    if (!actor?.permissions?.includes(permission)) {
      if (permission !== 'integrations.view') audit(actor, `integrations.${operation}`, { result: 'denied', details: { code: 'forbidden' } });
      throw new MisAdminError('forbidden', 'Недостаточно прав.', 403);
    }
    const flags = misFlags(env);
    const mis = await getRuntime();
    if (operation === 'integrationsList') {
      if (!mis) return { enabled: false, flags, integrations: [] };
      return { enabled: true, flags, integrations: mis.ledger.listIntegrations().map((item) => summary(mis.ledger, mis.runtime, item)) };
    }
    if (!mis) throw new MisAdminError('disabled', 'Интеграции выключены (MIS_INTEGRATIONS≠on).', 404);
    const integration = mis.ledger.getIntegration(params.id);
    if (!integration) throw new MisAdminError('not_found', 'Интеграция не найдена.', 404);
    const target = { targetId: integration.id, targetLabel: integration.title || integration.id };
    switch (operation) {
      case 'integrationsDetail': {
        const catalog = Object.fromEntries(['branch', 'doctor', 'service'].map((kind) => [kind, mis.ledger.catalogOf(integration.id, kind).length]));
        return {
          ...summary(mis.ledger, mis.runtime, integration),
          config: { baseUrl: integration.config.baseUrl ? new URL(integration.config.baseUrl).origin : null, capabilities: integration.config.capabilities || null },
          catalog,
          runs: mis.ledger.lastRuns(integration.id, 10),
          events: mis.ledger.recentEvents(integration.id, 50),
        };
      }
      case 'integrationsTest': {
        const result = await mis.runtime.testConnection(integration.id);
        audit(actor, 'integrations.test', { ...target, result: result.ok ? 'ok' : 'failed', details: { code: result.errorCode || null } });
        return result;
      }
      case 'integrationsSync': {
        if (!mis.runtime.running(integration.id)) throw new MisAdminError('not_running', `Интеграция не запущена: ${integration.status}.`, 409);
        const result = await mis.runtime.syncIntegration(integration.id);
        audit(actor, 'integrations.sync', { ...target, result: result.ok ? 'ok' : 'failed', details: { code: result.errorCode || null } });
        return result;
      }
      default:
        throw new MisAdminError('not_found', 'Not found', 404);
    }
  };

  return Object.freeze({ run });
};
