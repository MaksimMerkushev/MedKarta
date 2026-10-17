/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Граница сети: единственный модуль сервера, отправляющий запросы к модели.
 * Контракт — generate(request: SanitizedPlannerRequest), сигнатуры со строкой
 * нет; такой запрос создаёт только privacy/gateway.js, так что сырой ввод сюда
 * не попадает.
 *
 * Перед fetch пользовательская часть запроса ещё раз проходит детекторы и
 * закрытый словарь; при любой находке запрос не отправляется. Так данные
 * уходят наружу, только если одновременно ошиблись Gateway и эта проверка.
 */

import { isSanitizedPlannerRequest } from '../privacy/models.js';
import { detectEntities } from '../privacy/detectors.js';
import { checkClosedVocabulary, isKnownPlace, isStreetMention } from '../privacy/vocabulary.js';
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
 * Выходной предохранитель: пустой список — необходимое условие отправки.
 * Плейсхолдеры (@DOCTOR_A) детекторы сущностями не считают.
 *
 * @param {string} serialized проверяемый текст запроса (без системного промпта)
 * @returns {string[]} виды найденных сущностей
 */
export const assertOutboundSafe = (serialized) => {
  const { spans } = detectEntities(serialized);
  // Улица «на Ямашева» — не человек; то же правило, что и в gateway.
  const real = spans.filter((span) => !isStreetMention(serialized, span) && !isKnownPlace(serialized.slice(span.start, span.end)));
  return [...new Set(real.map((span) => span.kind))];
};

/*
 * План — несколько сотен байт JSON. Ответ читается потоком с потолком, а не
 * целиком через response.json(): иначе огромный ответ раздувает память процесса.
 */
export const MAX_RESPONSE_BYTES = 256 * 1024;

const readJsonLimited = async (response, limit) => {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new PlannerError('upstream response too large', PLANNER_ERROR.UPSTREAM);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    // Нестандартный fetch (тесты): у него нет потока, только json().
    return response.json();
  }

  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new PlannerError('upstream response too large', PLANNER_ERROR.UPSTREAM);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    throw new PlannerError('upstream response is not JSON', PLANNER_ERROR.UPSTREAM);
  }
};

/**
 * Реализации принимают SanitizedPlannerRequest и возвращают { raw, usage };
 * разбор и валидация — отдельно.
 */
export class PlannerClient {
  // eslint-disable-next-line no-unused-vars
  async generate(request) {
    throw new PlannerError('not implemented', PLANNER_ERROR.NOT_CONFIGURED);
  }
}

/**
 * Ключ уходит только по HTTPS. Обычный HTTP допускается лишь для модели,
 * запущенной на этой же машине (localhost).
 */
export const isAllowedUpstreamUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
};

/*
 * OpenRouter: reasoning.effort. Не задано — параметр не отправляется:
 * другие OpenAI-совместимые API могут его не знать.
 */
export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high']);

/**
 * Тело запроса к модели. Одно на ассистента и на проверки (npm run ai:check),
 * чтобы проверка проверяла ровно то, что отправляет ассистент.
 */
export const buildPlannerBody = ({ model, messages, reasoningEffort = null }) => {
  const body = {
    model,
    messages,
    response_format: { type: 'json_schema', json_schema: PLAN_JSON_SCHEMA },
    temperature: 0,
    max_tokens: 700,
  };
  if (REASONING_EFFORTS.includes(reasoningEffort)) body.reasoning = { effort: reasoningEffort };
  return body;
};

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
  reasoningEffort = null,
} = {}) => {
  const name = 'external';

  const generate = async (request) => {
    if (!isSanitizedPlannerRequest(request)) {
      // Отказ, а не предупреждение: это ошибка в коде вызывающего.
      throw new PlannerError(
        'Внешний планировщик принимает только SanitizedPlannerRequest',
        PLANNER_ERROR.NOT_SANITIZED,
      );
    }

    if (!apiKey || !url || !model || !isAllowedUpstreamUrl(url)) {
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

    const body = buildPlannerBody({ model, messages, reasoningEffort });

    const serialized = JSON.stringify(body);

    // Проверяем только пользовательскую часть: системный промпт содержит
    // слова «телефон», «адрес» и примеры формата, но не данные.
    const payloadUnderTest = JSON.stringify(
      request.toWireMessages().map((message) => message.content).join('\n') + '\n' + hintBlock,
    );
    const leaked = assertOutboundSafe(payloadUnderTest);
    // Закрытый словарь: детекторы ищут известное опасное, словарь пропускает
    // только известное безопасное. Повтор проверки Gateway — независимо от
    // того, каким путём собран текст.
    const tokens = request.placeholders.map((item) => item.token);
    for (const texts of [request.toWireMessages().map((message) => message.content), [hintBlock]]) {
      const vocabulary = checkClosedVocabulary(texts, tokens);
      if (!vocabulary.ok) leaked.push(`vocabulary:${vocabulary.reason}`);
    }
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
        // Без редиректов: на 307 fetch повторил бы POST с телом и ключом на другой хост.
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: serialized,
      });

      if (!response.ok) {
        // Тело ошибки не логируется и не пересылается: провайдеры часто
        // возвращают в нём фрагмент запроса.
        logger?.event('planner.upstream_error', { status: response.status, provider: name });
        // Непрочитанное тело держит сокет: после серии 429 копятся соединения.
        try {
          await response.body?.cancel();
        } catch {
          // тело уже закрыто
        }
        throw new PlannerError(`upstream ${response.status}`, PLANNER_ERROR.UPSTREAM);
      }

      const payload = await readJsonLimited(response, MAX_RESPONSE_BYTES);
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
      // Код транспорта (proxy_auth, proxy_timeout, tls…) — без сообщения: в нём бывают адреса.
      const code = typeof error?.code === 'string' && /^[a-z_]{2,32}$/i.test(error.code) ? error.code : 'unknown';
      logger?.event('planner.transport_error', { provider: name, code });
      throw new PlannerError('planner transport error', PLANNER_ERROR.UPSTREAM);
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({ name, generate });
};

/**
 * Все провайдеры цепочки получают один и тот же SanitizedPlannerRequest:
 * повтора с исходным текстом нет по построению.
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
