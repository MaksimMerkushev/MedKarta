/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Адаптер внешнего планировщика.
 *
 * ГРАНИЦА СЕТИ. Это единственный модуль проекта, который делает исходящий
 * запрос к модели. Его контракт намеренно узкий:
 *
 *     generate(request: SanitizedPlannerRequest) -> PlanResult
 *
 * Сигнатуры generate(prompt: string) не существует. Передать сюда сырой ввод
 * нельзя: SanitizedPlannerRequest умеет создавать только privacy/gateway.js.
 * Это переносит требование «санитизируй перед отправкой» из документации
 * в систему типов.
 *
 * ВТОРОЙ ПРЕДОХРАНИТЕЛЬ. Прямо перед fetch тело запроса ещё раз прогоняется
 * через детекторы. Если в нём обнаружено хоть что-то чувствительное, запрос
 * НЕ отправляется. Это защищает от ошибки в самом Gateway: два независимых
 * механизма должны отказать одновременно, чтобы данные ушли наружу.
 *
 * ОШИБКИ И FALLBACK. Резервный провайдер получает ТОТ ЖЕ SanitizedPlannerRequest.
 * Сценария «не получилось с санитизированным — отправим оригинал» не существует,
 * потому что оригинала на этом уровне просто нет.
 */

import { isSanitizedPlannerRequest } from '../privacy/models.js';
import { detectEntities } from '../privacy/detectors.js';
import { PLAN_JSON_SCHEMA } from './schema.js';
import { buildHintBlock, PLANNER_SYSTEM_PROMPT } from './prompts.js';

export class PlannerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

export const PLANNER_ERROR = Object.freeze({
  NOT_SANITIZED: 'planner_input_not_sanitized',
  OUTBOUND_ASSERTION: 'planner_outbound_assertion_failed',
  UPSTREAM: 'planner_upstream_error',
  TIMEOUT: 'planner_timeout',
  EMPTY: 'planner_empty_response',
  NOT_CONFIGURED: 'planner_not_configured',
});

/**
 * Выходной предохранитель.
 *
 * Возвращает список видов сущностей, найденных в теле запроса. Пустой список —
 * необходимое условие отправки. Плейсхолдеры (@DOCTOR_A) детекторами не
 * распознаются как сущности, поэтому ложных срабатываний на них нет.
 *
 * @param {string} serialized тело запроса целиком
 * @returns {string[]} виды найденных сущностей
 */
export const assertOutboundSafe = (serialized) => {
  const { spans } = detectEntities(serialized);
  return [...new Set(spans.map((span) => span.kind))];
};

/**
 * Базовый интерфейс. Реализации обязаны принимать SanitizedPlannerRequest
 * и возвращать { raw, usage } — разбор и валидация выполняются отдельно.
 */
export class PlannerClient {
  // eslint-disable-next-line no-unused-vars
  async generate(request) {
    throw new PlannerError('not implemented', PLANNER_ERROR.NOT_CONFIGURED);
  }
}

/**
 * Клиент внешнего провайдера (OpenRouter-совместимый chat/completions).
 *
 * @param {object} config
 * @param {string} config.apiKey
 * @param {string} config.url
 * @param {string} config.model
 * @param {number} [config.timeoutMs]
 * @param {Function} [config.fetchImpl]
 * @param {{event: Function}} [config.logger] безопасный логгер
 */
export const createExternalPlanner = ({
  apiKey,
  url,
  model,
  timeoutMs = 20_000,
  fetchImpl = fetch,
  logger = null,
} = {}) => {
  const name = 'external';

  const generate = async (request) => {
    if (!isSanitizedPlannerRequest(request)) {
      // Не «предупреждение», а отказ: это признак ошибки в коде вызывающего.
      throw new PlannerError(
        'Внешний планировщик принимает только SanitizedPlannerRequest',
        PLANNER_ERROR.NOT_SANITIZED,
      );
    }

    if (!apiKey || !url || !model) {
      throw new PlannerError('planner is not configured', PLANNER_ERROR.NOT_CONFIGURED);
    }

    const hintBlock = buildHintBlock(request.hints);
    const messages = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      ...request.toWireMessages(),
    ];
    if (hintBlock) {
      messages.push({ role: 'system', content: hintBlock });
    }

    const body = {
      model,
      messages,
      response_format: { type: 'json_schema', json_schema: PLAN_JSON_SCHEMA },
      temperature: 0,
      max_tokens: 700,
    };

    const serialized = JSON.stringify(body);

    // Проверяем только пользовательскую часть: системный промпт содержит
    // слова «телефон», «адрес» и примеры формата, но не данные.
    const payloadUnderTest = JSON.stringify(
      request.toWireMessages().map((message) => message.content).join('\n') + '\n' + hintBlock,
    );
    const leaked = assertOutboundSafe(payloadUnderTest);
    if (leaked.length > 0) {
      logger?.event('planner.outbound_blocked', { kinds: leaked });
      throw new PlannerError(
        'Исходящий запрос содержит чувствительные данные — отправка отменена',
        PLANNER_ERROR.OUTBOUND_ASSERTION,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: serialized,
      });

      if (!response.ok) {
        /*
         * Тело ошибки апстрима НЕ логируется и НЕ пересылается.
         * Многие провайдеры возвращают в ошибке фрагмент исходного запроса —
         * запись такого тела в логи свела бы на нет всю работу Gateway.
         */
        logger?.event('planner.upstream_error', { status: response.status, provider: name });
        throw new PlannerError(`upstream ${response.status}`, PLANNER_ERROR.UPSTREAM);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      const raw = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
          : '';

      if (!raw.trim()) {
        throw new PlannerError('empty completion', PLANNER_ERROR.EMPTY);
      }

      return {
        raw: raw.trim(),
        provider: name,
        usage: {
          promptTokens: payload?.usage?.prompt_tokens ?? null,
          completionTokens: payload?.usage?.completion_tokens ?? null,
        },
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new PlannerError('planner timeout', PLANNER_ERROR.TIMEOUT);
      }
      if (error instanceof PlannerError) {
        throw error;
      }
      throw new PlannerError('planner transport error', PLANNER_ERROR.UPSTREAM);
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({ name, generate });
};

/**
 * Цепочка провайдеров с общим входом.
 *
 * Все провайдеры получают ОДИН И ТОТ ЖЕ SanitizedPlannerRequest. Возможности
 * «повторить с исходным текстом» не предусмотрено конструкцией.
 */
export const createFallbackPlanner = (planners, { logger = null } = {}) => ({
  name: 'fallback',
  async generate(request) {
    if (!isSanitizedPlannerRequest(request)) {
      throw new PlannerError('not sanitized', PLANNER_ERROR.NOT_SANITIZED);
    }

    let lastError = null;
    for (const planner of planners) {
      try {
        return await planner.generate(request);
      } catch (error) {
        lastError = error;
        logger?.event('planner.fallback', {
          provider: planner.name,
          code: error?.code || 'unknown',
        });
        if (error?.code === PLANNER_ERROR.OUTBOUND_ASSERTION || error?.code === PLANNER_ERROR.NOT_SANITIZED) {
          // Отказ предохранителя не «лечится» другим провайдером.
          throw error;
        }
      }
    }

    throw lastError || new PlannerError('no planners available', PLANNER_ERROR.NOT_CONFIGURED);
  },
});
