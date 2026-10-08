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

import { validateChatMessages } from '../../shared/contract.js';
import { readBody, respondJson, verifyOrigin } from '../http/request.js';
import { chatCpuLimiter, checkRateLimit, getClientIp, heavyWork, takeExternalBudget } from '../http/rateLimit.js';
import { getDefaultPipeline } from '../pipeline.js';
import { logger } from '../observability/safeLogger.js';
import { metrics } from '../observability/metrics.js';

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

/*
 * Очередь на процессор.
 *
 * Разбор реплик идёт синхронно, и у сервера одно ядро: двадцать тяжёлых
 * запросов, начатых одновременно, выполнялись цепочками микрозадач и не
 * давали ответить даже на /api/config (8–10 с). Теперь разбор и исполнение
 * идут по одному (CHAT_MAX_CONCURRENCY), остальные ждут в короткой очереди,
 * а ожидание ответа внешней модели в очередь не входит — это не работа
 * процессора.
 */
const MAX_ACTIVE = Math.max(1, Number.parseInt(process.env.CHAT_MAX_CONCURRENCY ?? '', 10) || 1);
const MAX_QUEUE = 16;
const QUEUE_WAIT_MS = 8_000;

export const createCpuQueue = ({ maxActive = MAX_ACTIVE, maxQueue = MAX_QUEUE, waitMs = QUEUE_WAIT_MS } = {}) => {
  let active = 0;
  const queue = [];

  const release = () => {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();
    } else {
      active -= 1;
    }
  };

  const acquire = () =>
    new Promise((resolve, reject) => {
      if (active < maxActive) {
        active += 1;
        resolve();
        return;
      }
      if (queue.length >= maxQueue) {
        reject(Object.assign(new Error('busy'), { code: 'busy' }));
        return;
      }
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const index = queue.indexOf(entry);
        if (index !== -1) queue.splice(index, 1);
        reject(Object.assign(new Error('busy'), { code: 'busy' }));
      }, waitMs);
      queue.push(entry);
    });

  return Object.freeze({
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    get pending() {
      return queue.length;
    },
  });
};

const cpuQueue = createCpuQueue();

const respondBusy = (res) => {
  res.setHeader('Retry-After', String(heavyWork.retryAfterSeconds));
  respondJson(res, 503, { error: 'Ассистент сейчас перегружен. Попробуйте через минуту.', code: 'busy' });
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
    respondJson(res, 405, { error: 'Метод не поддерживается.' });
    return;
  }

  if (!verifyOrigin(req)) {
    respondJson(res, 403, { error: 'Запрос отклонён.' });
    return;
  }

  const clientIp = getClientIp(req);
  const limit = checkRateLimit(clientIp);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds));
    respondJson(res, 429, {
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
    respondJson(res, error.status || 400, { error: error.message || 'Некорректный запрос.' });
    return;
  }

  const cpu = chatCpuLimiter.check(clientIp);
  if (!cpu.allowed) {
    res.setHeader('Retry-After', String(cpu.retryAfterSeconds));
    respondJson(res, 429, {
      error: 'Слишком много запросов. Попробуйте через минуту.',
      retryAfter: cpu.retryAfterSeconds,
    });
    return;
  }
  if (!heavyWork.allows()) {
    metrics.increment('api.chat.shed');
    respondBusy(res);
    return;
  }

  try {
    const pipeline = await getDefaultPipeline();
    const { action, diagnostics } = await pipeline.handle({
      messages,
      sessionId,
      origin,
      takeExternalBudget,
      runExclusive: cpuQueue.run,
    });
    const spent = Number(diagnostics?.cpuMs) || 0;
    chatCpuLimiter.charge(clientIp, spent);
    heavyWork.record(spent);

    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
    respondJson(res, 200, action);
  } catch (error) {
    if (error?.code === 'busy') {
      metrics.increment('api.chat.busy');
      respondBusy(res);
      return;
    }
    /*
     * Ни error.message, ни стек в лог не попадают: и то, и другое регулярно
     * содержит фрагменты входных данных. Логируется только код ошибки.
     * Пользователю не показываются ни SQL, ни схема, ни внутренние id.
     */
    metrics.increment('api.chat.error', { code: error?.code || 'unknown' });
    logger.error('api.chat.failed', error);
    respondJson(res, 502, { error: 'Не удалось обработать запрос. Попробуйте ещё раз.' });
  }
}

// maxDuration и memory заданы в vercel.json; ограничение размера тела
// реализовано внутри readBody, чтобы работать и в dev-режиме Vite.
