/*
 * © 2026 МедКарта Казань. Все права защищены.
 * Этот код является интеллектуальной собственностью автора.
 *
 * Клиент ходит только в собственный эндпоинт /api/chat; ключ API хранится
 * в окружении Node.js-сервера (backend), в браузер он не попадает.
 */
import { LIMITS, sanitizeAiAction } from '@shared/contract.js';

const CHAT_ENDPOINT = '/api/chat';
const REQUEST_TIMEOUT_MS = 30_000;
const SESSION_STORAGE_KEY = 'medkarta.ai.session';

/**
 * Непрозрачный идентификатор диалога: плейсхолдеры (@DOCTOR_A) одной вкладки
 * нельзя разыменовать в другой сессии. Случайный, не связан с пользователем,
 * живёт в sessionStorage до закрытия вкладки. Без хранилища (приватный режим)
 * генерируется на каждый запрос, и плейсхолдеры не переживают перезагрузку.
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

/** Новый диалог после входа или выхода: прежний идентификатор не переходит к другому аккаунту. */
export const resetAssistantSession = () => {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Без хранилища идентификатор и так новый на каждый запрос.
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

/*
 * На сервер уходят только реплики пользователя (до MAX_USER_TURNS последних):
 * ответы ассистента сервер не учитывает (их нельзя проверить, см.
 * privacy/gateway.js). Тело ограничено LIMITS.MAX_BODY_BYTES, а кириллица —
 * два байта на символ, поэтому старые реплики отбрасываются, пока история не
 * уложится (иначе 413); последняя остаётся всегда.
 */
const HISTORY_BUDGET_BYTES = LIMITS.MAX_BODY_BYTES - 2048;
const byteLength = (text) => new TextEncoder().encode(text).length;

export const packMessages = (chatMessages) => {
  const turns = (Array.isArray(chatMessages) ? chatMessages : [])
    .filter((message) => message && message.role === 'user' && typeof message.content === 'string')
    .slice(-LIMITS.MAX_USER_TURNS)
    .map((message) => ({
      role: 'user',
      content: message.content.slice(0, LIMITS.MAX_MESSAGE_CHARS),
    }));
  while (turns.length > 1 && byteLength(JSON.stringify(turns)) > HISTORY_BUDGET_BYTES) turns.shift();
  return turns;
};

export const analyzeSymptoms = async (chatMessages, { signal } = {}) => {
  const messages = packMessages(chatMessages);
  if (messages.length === 0) {
    throw new AiError('Пустой запрос.', { code: 'empty' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  // Таймер и отмена действуют до конца чтения тела, а не только заголовков:
  // иначе зависший на теле ответ навсегда блокирует поле ввода.
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

  // Ответ 200 без JSON или без replyText (наш сервер присылает его всегда) —
  // ошибка, а не «фильтры применены».
  if (response.ok && (bodyUnreadable || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.replyText !== 'string' || !payload.replyText.trim())) {
    throw new AiError('Некорректный ответ сервера.', { code: 'server', status: response.status });
  }

  if (!response.ok) {
    // 401 — нет входа в кабинет: ассистент только для вошедших (backend/api/chatAccess.js).
    const code = response.status === 401 ? 'login_required'
      : payload?.code === 'accounts_unavailable' ? 'accounts_unavailable'
        : response.status === 429 ? 'rate_limit' : response.status === 503 ? 'unavailable' : 'server';
    throw new AiError(payload?.error || 'Ошибка при обращении к ИИ.', {
      code,
      status: response.status,
    });
  }

  // Сервер уже нормализовал ответ, но повторяем проверку на клиенте:
  // состояние UI не должно зависеть от того, что вернула сеть.
  return sanitizeAiAction(payload);
};
