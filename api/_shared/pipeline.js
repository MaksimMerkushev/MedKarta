/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сборка конвейера.
 *
 *   USER → API → PRIVACY GATEWAY → SANITIZED REQUEST → EXTERNAL LLM (planner)
 *        → SCHEMA VALIDATOR → POLICY ENGINE → EXECUTOR → справочник/маршруты
 *        → RESULT BUILDER → USER
 *
 * Здесь же реализована деградация: на каждом шаге после Gateway отказ ведёт
 * к локальному детерминированному плану, а не к попытке «спросить ещё раз,
 * но попроще». Исходного текста на этом уровне уже нет — передать его
 * куда-либо физически нечем.
 */

import { GATEWAY_DECISION } from './privacy/models.js';
import { loadCatalog } from './privacy/catalog.js';
import { createEntityResolver } from './privacy/entityResolver.js';
import { createPrivacyGateway } from './privacy/gateway.js';
import { createStoreFromEnv, createTokenVault } from './storage/tokenVault.js';
import { createExternalPlanner, PLANNER_ERROR } from './planner/client.js';
import { validatePlan } from './planner/validator.js';
import { planLocally } from './planner/localPlanner.js';
import { createCatalogRepository } from './executor/catalogRepository.js';
import { createPolicyEngine } from './executor/policyEngine.js';
import { createExecutor } from './executor/actions.js';
import { createRoutingProviderFromEnv } from './executor/routing.js';
import { buildEmergencyAction, buildUiAction } from './executor/resultBuilder.js';
import { logger as defaultLogger } from './observability/safeLogger.js';
import { metrics as defaultMetrics } from './observability/metrics.js';

/**
 * @param {object} deps все зависимости инъектируются: это то, что позволяет
 *   тестам подставить фикстуру справочника и фальшивый планировщик, не трогая
 *   ни сети, ни реальной базы.
 */
export const createPipeline = ({
  catalog,
  vault,
  planner,
  routing,
  logger = defaultLogger,
  metrics = defaultMetrics,
}) => {
  const resolver = createEntityResolver(catalog);
  const repository = createCatalogRepository(catalog);
  const gateway = createPrivacyGateway({ resolver, vault });
  const policyEngine = createPolicyEngine({ vault, repository });
  const executor = createExecutor({ repository, routing });

  /** Запрашивает план у внешней модели и валидирует ответ. */
  const planExternally = async (request) => {
    const started = Date.now();
    const completion = await planner.generate(request);
    metrics.observe('planner.latency_ms', Date.now() - started, { provider: completion.provider });

    const validated = validatePlan(completion.raw, {
      allowedTokens: request.allowedTokens,
      allowedDistricts: catalog.districts,
    });

    if (!validated.ok) {
      metrics.increment('planner.invalid_plan', { code: validated.error.code });
      logger.warn('planner.invalid_plan', {
        request_id: request.requestId,
        code: validated.error.code,
      });
      return null;
    }

    metrics.increment('planner.usage', { provider: completion.provider });
    logger.event('planner.usage', {
      request_id: request.requestId,
      provider: completion.provider,
      prompt_tokens: completion.usage?.promptTokens,
      completion_tokens: completion.usage?.completionTokens,
    });

    return { ...validated.value, source: 'external' };
  };

  return Object.freeze({
    /**
     * @param {object} params
     * @param {Array<{role: string, content: string}>} params.messages
     * @param {string} [params.sessionId]
     * @param {{lat: number, lng: number}|null} [params.origin] огрублённая точка
     * @returns {Promise<{action: object, diagnostics: object}>}
     */
    async handle({ messages, sessionId, origin = null }) {
      const started = Date.now();
      const gate = await gateway.process({ messages, sessionId });

      metrics.increment('gateway.decision', { decision: gate.decision });
      logger.event('gateway.decision', {
        request_id: gate.requestId,
        decision: gate.decision,
        reason: gate.reason,
        policy_version: gateway.policyVersion,
        pii_detected: gate.context.metrics.entitiesDetected > 0,
        redacted_entities: gate.context.metrics.entitiesDetected,
        placeholders: gate.context.metrics.placeholders,
        redaction_ratio: gate.context.metrics.redactionRatio,
        medical_text: gate.context.metrics.medicalText,
      });

      if (gate.decision === GATEWAY_DECISION.EMERGENCY) {
        metrics.increment('gateway.emergency');
        return {
          action: buildEmergencyAction(),
          diagnostics: { requestId: gate.requestId, decision: gate.decision, planSource: 'none' },
        };
      }

      let plan = null;
      let planSource = 'local';

      if (gate.decision === GATEWAY_DECISION.ALLOW_EXTERNAL && gate.request) {
        try {
          plan = await planExternally(gate.request);
          if (plan) planSource = 'external';
        } catch (error) {
          metrics.increment('planner.error', { code: error?.code || 'unknown' });
          logger.error('planner.error', error, { request_id: gate.requestId });
          /*
           * Резервного пути «отправить оригинал другому провайдеру» нет.
           * Падаем в локальный план — он строится из уже извлечённых структур.
           */
          if (error?.code === PLANNER_ERROR.OUTBOUND_ASSERTION) {
            metrics.increment('gateway.outbound_blocked');
          }
        }
      }

      if (!plan) {
        plan = planLocally(gate.context);
        planSource = 'local';
        metrics.increment('planner.local_fallback', { reason: gate.reason || 'planner_failed' });
      }

      let authorized = await policyEngine.authorize({ plan, sessionId: gate.sessionId });

      if (!authorized.ok) {
        metrics.increment('policy.rejected', { code: authorized.error.code });
        logger.warn('policy.rejected', {
          request_id: gate.requestId,
          code: authorized.error.code,
          plan_source: planSource,
        });

        // Отклонённый внешний план заменяется локальным ровно один раз.
        if (planSource === 'external') {
          plan = planLocally(gate.context);
          planSource = 'local_after_rejection';
          authorized = await policyEngine.authorize({ plan, sessionId: gate.sessionId });
        }
      }

      if (!authorized.ok) {
        metrics.increment('policy.rejected_final', { code: authorized.error.code });
        return {
          action: buildUiAction(
            {
              action: 'CLARIFY',
              stops: [],
              constraints: {},
              services: null,
              notes: { relaxed: [], missingSpecialties: [], ambiguous: [], approximate: false },
            },
            { clarifyPrompt: clarifyTextFor(gate.reason) },
          ),
          diagnostics: {
            requestId: gate.requestId,
            decision: gate.decision,
            planSource,
            rejected: authorized.error.code,
          },
        };
      }

      const execution = await executor.run({ plan: authorized.value, origin });
      const action = buildUiAction(execution, { clarifyPrompt: clarifyTextFor(gate.reason) });

      metrics.observe('pipeline.latency_ms', Date.now() - started, { plan_source: planSource });
      logger.event('pipeline.done', {
        request_id: gate.requestId,
        action: execution.action,
        plan_source: planSource,
        stops: execution.stops.length,
        relaxed: execution.notes.relaxed,
        missing_specialties: execution.notes.missingSpecialties,
        latency_ms: Date.now() - started,
      });

      return {
        action,
        diagnostics: {
          requestId: gate.requestId,
          decision: gate.decision,
          reason: gate.reason,
          planSource,
          stops: execution.stops.length,
        },
      };
    },
  });
};

/**
 * Уточняющий вопрос под причину fail-closed.
 * Пользователю не сообщается техническая причина, но формулировка направляет
 * его к безопасному переформулированию.
 */
const clarifyTextFor = (reason) => {
  switch (reason) {
    case 'hard_identifier_present':
      return (
        'Пожалуйста, не присылайте номера документов — СНИЛС, полис ОМС, паспорт: ' +
        'для поиска врача они не нужны. Напишите, какой специалист или клиника вам нужны.'
      );
    case 'symptom_classifier_uncertain':
      return (
        'Чтобы не гадать с профилем врача, уточните, пожалуйста: что беспокоит или ' +
        'к какому специалисту хотите записаться? Диагнозов я не ставлю — только помогаю найти врача.'
      );
    case 'residual_unredacted_risk':
    case 'redaction_ratio_too_high':
      return 'Уточните запрос покороче — например, «терапевт рядом» или «стоматология в Вахитовском районе».';
    default:
      return 'Уточните, пожалуйста, какой специалист или клиника нужны — и я найду и построю маршрут.';
  }
};

let cached = null;

/** Ленивая сборка конвейера по умолчанию для serverless-функции. */
export const getDefaultPipeline = async () => {
  if (cached) return cached;

  const catalog = await loadCatalog();
  const vault = createTokenVault({ store: createStoreFromEnv() });
  const planner = createExternalPlanner({
    apiKey: process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY,
    url: process.env.AI_UPSTREAM_URL || 'https://modelhub.my/v1/chat/completions',
    model: process.env.AI_MODEL || 'gpt-5.4-mini',
    logger: defaultLogger,
  });

  cached = createPipeline({
    catalog,
    vault,
    planner,
    routing: createRoutingProviderFromEnv(),
  });

  return cached;
};

/** Только для тестов. */
export const __resetPipelineCache = () => {
  cached = null;
};
