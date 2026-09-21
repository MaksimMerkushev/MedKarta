/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Общая обвязка тестов: конвейер на фикстуре, без сети и без реальной базы.
 */

import { createPipeline } from '../backend/pipeline.js';
import { createEntityResolver } from '../backend/privacy/entityResolver.js';
import { createPrivacyGateway } from '../backend/privacy/gateway.js';
import { createMemoryStore, createTokenVault } from '../backend/storage/tokenVault.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';
import { fixtureCatalog } from './fixtures/catalog.js';

export const TEST_SECRET = 'test-secret-0123456789abcdef';
export const TEST_SESSION = 'test-session-000001';

export const makeVault = (options = {}) =>
  createTokenVault({ store: createMemoryStore(), secret: TEST_SECRET, ...options });

export const makeGateway = (options = {}) => {
  const catalog = options.catalog || fixtureCatalog();
  const vault = options.vault || makeVault();
  return {
    catalog,
    vault,
    gateway: createPrivacyGateway({ resolver: createEntityResolver(catalog), vault }),
  };
};

/**
 * Планировщик-заглушка. Записывает всё, что ушло бы в сеть, — именно эти
 * записи проверяют тесты на утечку.
 */
export const makeRecordingPlanner = (respond) => {
  const sent = [];
  return {
    sent,
    planner: {
      name: 'test',
      async generate(request) {
        sent.push({
          messages: request.toWireMessages(),
          hints: request.hints,
          placeholders: request.placeholders,
          serialized: JSON.stringify(request.toWireMessages()),
        });
        const response = typeof respond === 'function' ? respond(request) : respond;
        if (response instanceof Error) throw response;
        return { raw: typeof response === 'string' ? response : JSON.stringify(response), provider: 'test' };
      },
    },
  };
};

export const makeTestPipeline = ({ respond = null, catalog = null, vault = null } = {}) => {
  const resolvedCatalog = catalog || fixtureCatalog();
  const resolvedVault = vault || makeVault();
  const { planner, sent } = makeRecordingPlanner(
    respond || { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' },
  );
  const logger = createSafeLogger({ enabled: false });
  const metrics = createMetrics();

  return {
    catalog: resolvedCatalog,
    vault: resolvedVault,
    sent,
    logger,
    metrics,
    pipeline: createPipeline({
      catalog: resolvedCatalog,
      vault: resolvedVault,
      planner,
      routing: createHaversineRoutingProvider(),
      logger,
      metrics,
    }),
  };
};
