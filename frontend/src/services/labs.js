/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории: каталог, подбор корзины, расписание и демо-запись (/api/labs/*).
 * Точку отправления добавляет браузер — в /api/chat она не уходит. Гостевые записи
 * (номер и код отмены) хранятся в этом браузере, записи из кабинета — на сервере.
 */

const TIMEOUT_MS = 15_000;
const STORAGE_KEY = 'medkarta.lab-bookings';
const CART_KEY = 'medkarta.lab-cart';
const MAX_STORED = 20;

export class LabsError extends Error {
  constructor(message, { code = 'error', status = 0 } = {}) {
    super(message);
    this.name = 'LabsError';
    this.code = code;
    this.status = status;
  }
}

const request = async (path, { method = 'GET', body, signal } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let response;
    try {
      response = await fetch(path, {
        method,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new LabsError('Нет связи с сервером. Попробуйте ещё раз.', { code: 'network' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new LabsError(payload?.error || 'Не получилось. Попробуйте ещё раз.', {
        code: payload?.code || (response.status === 429 ? 'rate_limit' : 'error'),
        status: response.status,
      });
    }
    return payload;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};

const roundOrigin = (origin) => {
  if (Array.isArray(origin) && Number.isFinite(origin[0]) && Number.isFinite(origin[1])) return { lat: Number(origin[0].toFixed(5)), lng: Number(origin[1].toFixed(5)) };
  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lng)) return { lat: Number(origin.lat.toFixed(5)), lng: Number(origin.lng.toFixed(5)) };
  return null;
};

export const fetchLabCatalog = ({ signal } = {}) => request('/api/labs/catalog', { signal });
export const fetchLabTest = (code, { signal } = {}) => request(`/api/labs/tests/${encodeURIComponent(code)}`, { signal });
export const fetchLab = (id, { signal } = {}) => request(`/api/labs/labs/${encodeURIComponent(id)}`, { signal });

/** Подбор: полная стоимость корзины по филиалам. Названное место в запросе важнее точки из браузера. */
export const quoteLabs = (labRequest, { origin = null, signal } = {}) => request('/api/labs/quote', {
  method: 'POST',
  signal,
  body: { request: { ...labRequest, origin: labRequest?.originPlace ? null : roundOrigin(origin) } },
});

export const fetchLabSlots = ({ branchId, from = null, days = 7, tests = [], signal }) => {
  const params = new URLSearchParams({ branchId, days: String(days) });
  if (from) params.set('from', from);
  if (tests.length) params.set('tests', tests.join(','));
  return request(`/api/labs/slots?${params}`, { signal });
};

export const createLabBooking = ({ branchId, slotId, tests, idempotencyKey, expectedTotal }) =>
  request('/api/labs/bookings', { method: 'POST', body: { branchId, slotId, tests, idempotencyKey, expectedTotal } });

export const cancelLabBooking = ({ number, cancelToken }) => request('/api/labs/bookings/cancel', { method: 'POST', body: { number, cancelToken } });
export const lookupLabBookings = (items) => request('/api/labs/bookings/lookup', { method: 'POST', body: { items } });
export const fetchAccountLabBookings = ({ signal } = {}) => request('/api/labs/bookings/mine', { signal });

export const newIdempotencyKey = () => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const readJson = (key, fallback) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key, value) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Хранилище недоступно (приватный режим) — запись работает, но не запомнится.
  }
};

/** Гостевые записи в этом браузере: номер и код отмены. */
export const readLabBookings = () => {
  const list = readJson(STORAGE_KEY, []);
  return Array.isArray(list) ? list.filter((item) => item && typeof item.number === 'string' && typeof item.cancelToken === 'string').slice(0, MAX_STORED) : [];
};
export const rememberLabBooking = (booking) => {
  if (!booking?.number || !booking?.cancelToken) return;
  const list = readLabBookings().filter((item) => item.number !== booking.number);
  writeJson(STORAGE_KEY, [{ number: booking.number, cancelToken: booking.cancelToken }, ...list].slice(0, MAX_STORED));
};
export const forgetLabBooking = (number) => writeJson(STORAGE_KEY, readLabBookings().filter((item) => item.number !== number));

/** Корзина анализов раздела «Лаборатории» — только в этом браузере. */
export const readLabCart = () => {
  const list = readJson(CART_KEY, []);
  return Array.isArray(list) ? list.filter((code) => typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)).slice(0, 25) : [];
};
export const writeLabCart = (codes) => writeJson(CART_KEY, codes.slice(0, 25));

export const formatRub = (value) => (Number.isFinite(value) ? `${value.toLocaleString('ru-RU')} ₽` : '—');

const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** «вт, 10 ноября» для дня ГГГГ-ММ-ДД. */
export const formatLabDay = (day) => {
  if (typeof day !== 'string') return '';
  const date = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};
export const formatReadyAt = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date);
  return parts;
};
