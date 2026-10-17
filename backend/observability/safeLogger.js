/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Журнал, в который нельзя случайно записать персональные данные: Privacy
 * Gateway бесполезен, если исходный текст уходит в журнал, Sentry или APM
 * (объект ошибки целиком, тело ошибки апстрима с фрагментом промпта).
 *
 * Принимается только белый список полей, каждая строка дополнительно
 * проверяется детекторами, произвольные объекты отбрасываются.
 * Соответствия токенов (@DOCTOR_A → id) не логируются ни на каком уровне.
 */

import { detectEntities } from '../privacy/detectors.js';

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
  // Время в пути и аналитика: профиль, потолок, число отброшенных событий.
  'profile', 'max_minutes', 'dropped',
]);

// Чёрный список поверх белого: эти поля не пишутся, даже если их по ошибке
// добавят в ALLOWED_FIELDS.
const FORBIDDEN_FIELDS = new Set([
  'prompt', 'message', 'messages', 'content', 'text', 'input', 'query',
  'name', 'doctor', 'doctor_name', 'patient', 'phone', 'email', 'address',
  'lat', 'lng', 'coords', 'location', 'token', 'tokens', 'mapping', 'vault',
  'session_id', 'sessionId', 'ip', 'user_agent', 'userAgent', 'body', 'stack',
]);

const MAX_STRING = 120;

/*
 * Служебные поля строгого формата минуют детекторы: те принимают UUID запроса
 * за идентификатор, а версию политики «2026-09-25.1» — за дату рождения.
 * Значение, совпавшее с форматом, пользовательских данных нести не может;
 * несовпавшее проверяется как обычно.
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

    // Только последние MAX_RECORDS: без ограничения это ~1 КБ на запрос,
    // то есть медленная утечка памяти на VPS с 2 ГБ.
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
     * Ошибка пишется только кодом или именем класса, без message и stack:
     * в них регулярно попадают фрагменты входных данных.
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

export const logger = createSafeLogger();
