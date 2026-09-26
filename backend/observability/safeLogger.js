/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Логирование, из которого нельзя случайно уронить персональные данные.
 *
 * ПОЧЕМУ ЭТО КРИТИЧНО. Идеальный Privacy Gateway бессмыслен, если исходный
 * текст затем уходит в Sentry, в APM или в логи функции. Типичные каналы
 * утечки в этом проекте были такими:
 *   - console.error('[api/chat]', error) — объект ошибки печатается целиком,
 *     вместе с телом запроса, если оно попало в свойства;
 *   - логирование тела ошибки апстрима: провайдеры часто возвращают в ней
 *     фрагмент присланного промпта;
 *   - «временный» debug-вывод, который остаётся в проде.
 *
 * Здесь принят обратный подход: логгер принимает ТОЛЬКО белый список полей,
 * а каждое строковое значение дополнительно проверяется детекторами.
 * Нельзя «передать объект и надеяться», потому что произвольные объекты
 * отбрасываются.
 *
 * ОТДЕЛЬНЫЙ ЗАПРЕТ: соответствия токенов (@DOCTOR_A → id) не логируются
 * никогда и ни на каком уровне.
 */

import { detectEntities } from '../privacy/detectors.js';

/** Поля, разрешённые в структурированном логе. */
export const ALLOWED_FIELDS = new Set([
  'request_id', 'requestId', 'session_ref', 'event', 'level', 'ts',
  'decision', 'reason', 'intent', 'action', 'policy_version', 'policyVersion',
  'pii_detected', 'piiDetected', 'redacted_entities', 'redactedEntities',
  'placeholders', 'redaction_ratio', 'redactionRatio', 'medical_text', 'medicalText',
  'emergency', 'status', 'code', 'provider', 'kinds', 'error_code', 'errorCode',
  'latency_ms', 'latencyMs', 'planner_ms', 'plannerMs', 'stops', 'candidates',
  'relaxed', 'ambiguous', 'missing_specialties', 'missingSpecialties',
  'prompt_tokens', 'promptTokens', 'completion_tokens', 'completionTokens',
  'plan_source', 'planSource', 'rejected', 'rejected_reason', 'rejectedReason',
  'vault_backend', 'vaultBackend', 'routing_provider', 'routingProvider',
  'specialties', 'constraint_keys', 'constraintKeys', 'steps', 'count',
  // Размер графа дорог: числа, к пользователю отношения не имеют.
  'nodes', 'edges', 'memory_mb',
]);

/**
 * Поля, куда нельзя писать никогда — даже если кто-то добавит их
 * в ALLOWED_FIELDS. Явный «чёрный список поверх белого» на случай
 * невнимательного расширения.
 */
const FORBIDDEN_FIELDS = new Set([
  'prompt', 'message', 'messages', 'content', 'text', 'input', 'query',
  'name', 'doctor', 'doctor_name', 'patient', 'phone', 'email', 'address',
  'lat', 'lng', 'coords', 'location', 'token', 'tokens', 'mapping', 'vault',
  'session_id', 'sessionId', 'ip', 'user_agent', 'userAgent', 'body', 'stack',
]);

const MAX_STRING = 120;

/*
 * Служебные поля строгого формата. Детекторы принимали UUID запроса за
 * идентификатор, а версию политики «2026-09-25.1» — за дату рождения, и в
 * логах вместо них стоял «[redacted]»: связать события одного запроса было
 * нельзя. Значение, совпавшее с форматом, ничего пользовательского нести
 * не может; несовпавшее проверяется детекторами как обычно.
 */
const TRUSTED_FORMATS = {
  request_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  requestId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  policy_version: /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/,
  policyVersion: /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/,
};

/** Сколько последних записей держать в памяти (для тестов и отладки). */
const MAX_RECORDS = 500;

/** Ограничивает значение безопасным примитивом либо отбрасывает его. */
const sanitizeValue = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value) || typeof value !== 'number' ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.slice(0, MAX_STRING);
    // Строка со следами чувствительных данных в лог не попадает.
    if (detectEntities(trimmed).spans.length > 0) {
      return '[redacted]';
    }
    return trimmed;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map(sanitizeValue).filter((item) => item !== undefined);
  }

  // Объекты произвольной формы не логируются: именно так утекают тела запросов.
  return undefined;
};

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {(line: string) => void} [options.sink]
 */
export const createSafeLogger = ({
  enabled = process.env.NODE_ENV !== 'test',
  sink = (line) => process.stdout.write(`${line}\n`),
  errorSink = (line) => process.stderr.write(`${line}\n`),
} = {}) => {
  const records = [];

  const write = (level, event, fields) => {
    const payload = { ts: new Date().toISOString(), level, event };

    for (const [key, value] of Object.entries(fields || {})) {
      if (FORBIDDEN_FIELDS.has(key) || !ALLOWED_FIELDS.has(key)) {
        continue;
      }
      const safe = typeof value === 'string' && TRUSTED_FORMATS[key]?.test(value) ? value : sanitizeValue(value);
      if (safe !== undefined) {
        payload[key] = safe;
      }
    }

    /*
     * Раньше сюда складывалась каждая запись за всё время жизни процесса —
     * около килобайта на запрос, без ограничения. На VPS с 2 ГБ это медленная
     * утечка памяти. Теперь — кольцо из последних записей.
     */
    records.push(payload);
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
    if (!enabled) {
      return payload;
    }

    const line = JSON.stringify(payload);
    if (level === 'error') {
      errorSink(line);
    } else {
      sink(line);
    }
    return payload;
  };

  return Object.freeze({
    event: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    /**
     * Ошибки логируются ТОЛЬКО кодом и именем класса. Ни message, ни stack:
     * и то, и другое регулярно содержит фрагменты входных данных.
     */
    error: (event, error, fields = {}) =>
      write('error', event, {
        ...fields,
        error_code: error?.code || error?.name || 'unknown',
      }),
    /** Только для тестов: всё, что логгер записал за время жизни. */
    __records: records,
  });
};

/** Логгер по умолчанию для серверных модулей. */
export const logger = createSafeLogger();
