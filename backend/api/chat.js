/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Серверная точка входа ИИ-навигатора.
 *
 * Функция больше НЕ является прокси к модели. Она принимает запрос, отдаёт его
 * конвейеру (backend/pipeline.js) и возвращает готовое действие интерфейса.
 * Прямого обращения к внешней модели здесь нет и быть не должно: единственный
 * исходящий вызов живёт в planner/client.js и принимает только
 * SanitizedPlannerRequest.
 *
 * Что осталось на этом уровне: проверка метода и Origin, ограничение частоты,
 * лимит размера тела, разбор входных данных и безопасное логирование.
 */

import { LIMITS, validateChatMessages } from '../../shared/contract.js';
import { checkRateLimit, getClientIp } from '../http/rateLimit.js';
import { getDefaultPipeline } from '../pipeline.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';

const sendJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      resolve(req.body);
      return;
    }

    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > LIMITS.MAX_BODY_BYTES) {
        const error = new Error('Тело запроса слишком большое.');
        error.status = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Некорректный JSON в теле запроса.');
        error.status = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });

/**
 * Запрос должен приходить с нашей же страницы. Заголовок Origin подделывается
 * только не-браузерным клиентом, поэтому это не «защита», а отсечение
 * тривиального встраивания виджета на чужой сайт за наш счёт.
 */
const isAllowedOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  const allowList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowList.includes(origin)) {
    return true;
  }

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
};

/**
 * Точка отправления.
 *
 * Клиент может её не присылать — и по умолчанию не присылает: расстояния
 * считаются в браузере, координаты не покидают устройство. Если поле всё же
 * пришло, оно немедленно огрубляется до двух знаков (≈1.1 км) и используется
 * ТОЛЬКО для предварительного отбора кандидатов на сервере. Во внешнюю модель
 * координаты не передаются ни в каком виде: планировщик оперирует значением
 * selection="nearest" и токеном @CURRENT_LOCATION.
 */
const readCoarseOrigin = (raw) => {
  if (process.env.ALLOW_COARSE_ORIGIN !== 'on') {
    return null;
  }
  const lat = Number(raw?.lat);
  const lng = Number(raw?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat: Number(lat.toFixed(2)), lng: Number(lng.toFixed(2)) };
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    sendJson(res, 405, { error: 'Метод не поддерживается.' });
    return;
  }

  if (!isAllowedOrigin(req)) {
    sendJson(res, 403, { error: 'Запрос отклонён.' });
    return;
  }

  const limit = checkRateLimit(getClientIp(req));
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    sendJson(res, 429, {
      error: 'Слишком много запросов. Попробуйте через минуту.',
      retryAfter: limit.retryAfterSeconds,
    });
    return;
  }

  let messages;
  let sessionId;
  let origin;
  try {
    const body = await readBody(req);
    messages = validateChatMessages(body?.messages);
    sessionId = typeof body?.sessionId === 'string' ? body.sessionId : undefined;
    origin = readCoarseOrigin(body?.origin);
  } catch (error) {
    // Наружу уходит только формулировка валидатора — она не содержит ввода.
    sendJson(res, error.status || 400, { error: error.message || 'Некорректный запрос.' });
    return;
  }

  try {
    const pipeline = await getDefaultPipeline();
    const { action } = await pipeline.handle({ messages, sessionId, origin });

    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    sendJson(res, 200, action);
  } catch (error) {
    /*
     * Ни error.message, ни стек в лог не попадают: и то, и другое регулярно
     * содержит фрагменты входных данных. Логируется только код ошибки.
     * Пользователю не показываются ни SQL, ни схема, ни внутренние id.
     */
    metrics.increment('api.chat.error', { code: error?.code || 'unknown' });
    logger.error('api.chat.failed', error);
    sendJson(res, 502, { error: 'Не удалось обработать запрос. Попробуйте ещё раз.' });
  }
}

// maxDuration и memory заданы в vercel.json; ограничение размера тела
// реализовано внутри readBody, чтобы работать и в dev-режиме Vite.
