/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Клиент локального сервиса распознавания персональных данных (services/pii-ner).
 * Соединение — только Unix-сокет или 127.0.0.1: текст жалобы не покидает сервер.
 * Ответ проверяется строго; любая неожиданность — ошибка, и вызывающий не отправляет
 * текст наружу (fail closed).
 */
import http from 'node:http';

export const NER_ERROR = Object.freeze({
  MISCONFIGURED: 'ner_misconfigured',
  UNAVAILABLE: 'ner_unavailable',
  TIMEOUT: 'ner_timeout',
  OVERLOADED: 'ner_overloaded',
  TOO_LONG: 'ner_too_long',
  INVALID: 'ner_invalid_response',
});

export class NerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Метки rubert-tiny (PER, GEOPOLIT, MEDIA) и общий набор типов для других моделей (spanMask.js).
export const NER_TYPES = Object.freeze(['PER', 'ORG', 'LOC', 'GEOPOLIT', 'MEDIA', 'PERSON', 'ADDRESS', 'PHONE', 'EMAIL', 'DOC', 'URL', 'DATE', 'SECRET', 'PROFESSION']);
export const NER_LIMITS = Object.freeze({ MAX_TEXT_CHARS: 4000, MAX_RESPONSE_BYTES: 64 * 1024, MAX_ENTITIES: 200 });

/** PII_NER=on — слой включён; адрес — PII_NER_SOCKET или PII_NER_PORT (только 127.0.0.1). */
export const nerConfigFromEnv = (env = process.env) => {
  const timeout = Number.parseInt(env.PII_NER_TIMEOUT_MS ?? '', 10);
  const port = Number.parseInt(env.PII_NER_PORT ?? '', 10);
  return {
    enabled: String(env.PII_NER || '').trim().toLowerCase() === 'on',
    socketPath: env.PII_NER_SOCKET ? String(env.PII_NER_SOCKET) : null,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    timeoutMs: Number.isFinite(timeout) ? Math.min(5000, Math.max(50, timeout)) : 400,
  };
};

/** Ответ сервиса: только известные типы и диапазоны внутри текста. Иначе — null. */
export const validateEntities = (payload, text) => {
  const list = payload?.entities;
  if (!Array.isArray(list) || list.length > NER_LIMITS.MAX_ENTITIES) return null;
  const result = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') return null;
    const { type, start, end, score } = item;
    if (!NER_TYPES.includes(type)) return null;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || start >= end) return null;
    if (score != null && !(typeof score === 'number' && score >= 0 && score <= 1)) return null;
    result.push({ type, start, end, score: score ?? null });
  }
  return result;
};

export const createNerClient = ({ socketPath = null, port = null, timeoutMs = 400, maxChars = NER_LIMITS.MAX_TEXT_CHARS } = {}) => {
  const target = socketPath ? { socketPath } : port ? { host: '127.0.0.1', port } : null;

  const entities = (text) => new Promise((resolve, reject) => {
    if (!target) { reject(new NerError(NER_ERROR.MISCONFIGURED)); return; }
    const value = String(text ?? '');
    if (value.length > maxChars) { reject(new NerError(NER_ERROR.TOO_LONG)); return; }
    const body = JSON.stringify({ text: value });
    let settled = false;
    const fail = (code) => { if (!settled) { settled = true; reject(new NerError(code)); } };
    const request = http.request({
      ...target,
      method: 'POST',
      path: '/v1/entities',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      agent: false,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > NER_LIMITS.MAX_RESPONSE_BYTES) { request.destroy(); fail(NER_ERROR.INVALID); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode === 503) { fail(NER_ERROR.OVERLOADED); return; }
        if (response.statusCode === 413) { fail(NER_ERROR.TOO_LONG); return; }
        if (response.statusCode !== 200) { fail(NER_ERROR.UNAVAILABLE); return; }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          fail(NER_ERROR.INVALID);
          return;
        }
        const valid = validateEntities(payload, value);
        if (!valid) { fail(NER_ERROR.INVALID); return; }
        settled = true;
        resolve(valid);
      });
      response.on('error', () => fail(NER_ERROR.UNAVAILABLE));
    });
    // Общий срок на весь обмен, а не только на тишину в сокете.
    const timer = setTimeout(() => { request.destroy(); fail(NER_ERROR.TIMEOUT); }, timeoutMs);
    request.on('timeout', () => { request.destroy(); fail(NER_ERROR.TIMEOUT); });
    request.on('error', () => fail(NER_ERROR.UNAVAILABLE));
    request.on('close', () => clearTimeout(timer));
    request.end(body);
  });

  return Object.freeze({ entities, configured: Boolean(target) });
};
