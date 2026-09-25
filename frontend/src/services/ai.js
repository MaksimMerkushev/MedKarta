/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Этот код является интеллектуальной собственностью автора.
 *
 * Клиент ходит только в собственный эндпоинт /api/chat.
 * Ключа API здесь нет и быть не может — он живёт в окружении serverless-функции.
 */
import { LIMITS, sanitizeAiAction } from '@shared/contract.js';

const CHAT_ENDPOINT = '/api/chat';
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_STORAGE_KEY = 'medkarta.ai.session';

/**
 * Непрозрачный идентификатор диалога.
 *
 * Нужен серверу, чтобы плейсхолдеры (@DOCTOR_A) одной вкладки нельзя было
 * разыменовать в другой сессии. Он случайный, не связан с пользователем,
 * живёт только в sessionStorage и исчезает вместе с вкладкой. Если хранилище
 * недоступно (приватный режим, отключённые куки), идентификатор генерируется
 * на каждый запрос — тогда плейсхолдеры просто не переживают перезагрузку.
 */
const getSessionId = () => {
  const fresh = () =>
    (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

  try {
    const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (stored && /^[A-Za-z0-9_-]{12,64}$/.test(stored)) {
      return stored;
    }
    const created = fresh();
    sessionStorage.setItem(SESSION_STORAGE_KEY, created);
    return created;
  } catch {
    return fresh();
  }
};

export class AiError extends Error {
  constructor(message, { code = 'unknown', status = 0 } = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * История, уходящая на сервер: только последние сообщения и обрезанный текст.
 * Это ограничивает и стоимость запроса, и объём, который можно закинуть в модель.
 */
const packMessages = (chatMessages) =>
  (Array.isArray(chatMessages) ? chatMessages : [])
    .filter((message) => message && typeof message.content === 'string')
    .slice(-LIMITS.MAX_MESSAGES)
    .map((message) => ({
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content.slice(0, LIMITS.MAX_MESSAGE_CHARS),
    }));

export const analyzeSymptoms = async (chatMessages, { signal } = {}) => {
  const messages = packMessages(chatMessages);
  if (messages.length === 0) {
    throw new AiError('Пустой запрос.', { code: 'empty' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  /*
   * Таймер и отмена действуют до конца чтения ТЕЛА, а не только до прихода
   * заголовков: сервер, приславший заголовки и зависший на теле, раньше
   * оставлял «Думаю...» и заблокированное поле ввода навсегда.
   */
  let response;
  let payload = null;
  let bodyUnreadable = false;
  try {
    response = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
      body: JSON.stringify({ messages, sessionId: getSessionId() }),
    });
    try {
      payload = await response.json();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      bodyUnreadable = true;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new AiError('Превышено время ожидания.', { code: 'timeout' });
    }
    throw new AiError('Нет связи с сервером.', { code: 'network' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  // Ответ 200 без JSON — не «готово»: раньше пользователь видел
  // «я применил подходящие фильтры», хотя ничего не применялось.
  if (response.ok && (bodyUnreadable || !payload || typeof payload !== 'object')) {
    throw new AiError('Некорректный ответ сервера.', { code: 'server', status: response.status });
  }

  if (!response.ok) {
    const code = response.status === 429 ? 'rate_limit' : response.status === 503 ? 'unavailable' : 'server';
    throw new AiError(payload?.error || 'Ошибка при обращении к ИИ.', {
      code,
      status: response.status,
    });
  }

  // Сервер уже нормализовал ответ, но повторяем проверку на клиенте:
  // состояние UI не должно зависеть от того, что вернула сеть.
  return sanitizeAiAction(payload);
};
// [GitHub Actions] Simulated thematic bounds enforcement
