/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Продуктовая аналитика без персональных данных.
 *
 * Что отправляется: только события из закрытого словаря shared/analytics.js
 * (тип, перечислимые значения, ограниченные числа) и случайный
 * идентификатор вкладки. Текст поиска, координаты и что-либо о человеке
 * сюда не попадают: событие с лишним полем отбрасывается целиком ещё
 * в браузере, а потом повторно на сервере.
 *
 * Do Not Track и Global Privacy Control уважаются: если браузер просит не
 * отслеживать, события не отправляются вовсе.
 *
 * Отправка — пачками раз в несколько секунд и при уходе со страницы
 * (sendBeacon), чтобы не дёргать сеть на каждое действие.
 */

import { ANALYTICS_LIMITS, sanitizeEvent } from '@shared/analytics.js';

const ENDPOINT = '/api/events';
const STORAGE_KEY = 'medkarta.analytics.sid';
const FLUSH_DELAY_MS = 4000;
const MAX_QUEUE = 100;

let queue = [];
let timer = null;
let listenersAttached = false;
let cachedSid = null;

const optedOut = () => {
  if (typeof navigator === 'undefined') return true;
  return navigator.globalPrivacyControl === true
    || navigator.doNotTrack === '1'
    || (typeof window !== 'undefined' && window.doNotTrack === '1');
};

/** Случайный идентификатор вкладки: не связан ни с человеком, ни с диалогом ассистента. */
const sessionId = () => {
  if (cachedSid) return cachedSid;
  const fresh = () =>
    (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) {
      cachedSid = stored;
      return cachedSid;
    }
    cachedSid = fresh();
    sessionStorage.setItem(STORAGE_KEY, cachedSid);
  } catch {
    cachedSid = fresh();
  }
  return cachedSid;
};

const send = (events, { beacon = false } = {}) => {
  if (events.length === 0) return;
  const body = JSON.stringify({ events });
  if (body.length > ANALYTICS_LIMITS.MAX_BODY_BYTES) {
    // Пачка не влезла — делим пополам; одно событие всегда меньше лимита.
    const middle = Math.ceil(events.length / 2);
    send(events.slice(0, middle), { beacon });
    send(events.slice(middle), { beacon });
    return;
  }
  try {
    if (beacon && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body,
    }).catch(() => {});
  } catch {
    // Аналитика никогда не ломает интерфейс.
  }
};

export const flushAnalytics = ({ beacon = false } = {}) => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  while (queue.length > 0) {
    send(queue.splice(0, ANALYTICS_LIMITS.MAX_BATCH), { beacon });
  }
};

const attachListeners = () => {
  if (listenersAttached || typeof document === 'undefined') return;
  listenersAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAnalytics({ beacon: true });
  });
  window.addEventListener('pagehide', () => flushAnalytics({ beacon: true }));
};

/**
 * Ставит событие в очередь. Невалидное событие молча отбрасывается:
 * ошибка в разметке не должна превращаться в утечку или в падение.
 *
 * @param {string} type тип из EVENT_TYPES
 * @param {object} [fields] поля события
 * @returns {boolean} принято ли событие
 */
export const track = (type, fields = {}) => {
  if (optedOut()) return false;
  const event = sanitizeEvent({ type, sid: sessionId(), ...fields });
  if (!event) {
    if (import.meta.env?.DEV) console.warn('[analytics] событие отброшено', type, fields);
    return false;
  }
  attachListeners();
  // v ставит сервер — клиент шлёт только содержимое.
  const { v: _version, ...payload } = event;
  queue.push(payload);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= ANALYTICS_LIMITS.MAX_BATCH) {
    flushAnalytics();
  } else if (!timer) {
    timer = setTimeout(() => flushAnalytics(), FLUSH_DELAY_MS);
  }
  return true;
};
