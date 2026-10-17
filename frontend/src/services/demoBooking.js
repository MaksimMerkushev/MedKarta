/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-запись. Логика — на сервере (/api/demo/*); здесь запросы и номера
 * записей гостя в этом браузере (записи кабинета хранит сервер). Симуляция: ничего не уходит в клиники,
 * страховые и МИС; персональных данных пациента в записи нет — только слот
 * и программа ДМС.
 */

const TIMEOUT_MS = 15_000;
const STORAGE_KEY = 'medkarta.demo-bookings';
const MAX_STORED = 20;

export class DemoBookingError extends Error {
  constructor(message, { code = 'error', status = 0 } = {}) {
    super(message);
    this.name = 'DemoBookingError';
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
      throw new DemoBookingError('Нет связи с сервером. Попробуйте ещё раз.', { code: 'network' });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new DemoBookingError(payload?.error || 'Не получилось. Попробуйте ещё раз.', {
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

/** Координаты — с точностью ~1 м: точнее серверу не нужно. */
const roundOrigin = (origin) => {
  if (!Array.isArray(origin) || !Number.isFinite(origin[0]) || !Number.isFinite(origin[1])) return null;
  return { lat: Number(origin[0].toFixed(5)), lng: Number(origin[1].toFixed(5)) };
};

/**
 * Строгий подбор. Точку отправления и программу ДМС добавляет браузер:
 * в /api/chat они не уходят.
 */
export const searchDemo = (searchRequest, { origin = null, planId = null, signal } = {}) =>
  request('/api/demo/search', {
    method: 'POST',
    signal,
    body: {
      request: {
        ...searchRequest,
        origin: roundOrigin(origin),
        // Программа, названная в запросе («по программе Demo Premium»), важнее выбранной в интерфейсе.
        dms: { required: Boolean(searchRequest?.dms?.required), planId: searchRequest?.dms?.planId || planId || null },
      },
    },
  });

export const fetchDoctorSlots = ({ doctorId, branchId, from = null, days = 7, planId = null, patient = null, signal }) => {
  const params = new URLSearchParams({ doctorId, days: String(days) });
  if (branchId) params.set('branchId', branchId);
  if (from) params.set('from', from);
  if (planId) params.set('planId', planId);
  if (patient) params.set('patient', patient);
  return request(`/api/demo/slots?${params}`, { signal });
};

export const holdSlot = (slotId) => request('/api/demo/hold', { method: 'POST', body: { slotId } });

export const releaseSlot = (slotId, holdToken) =>
  request('/api/demo/release', { method: 'POST', body: { slotId, holdToken } }).catch(() => null);

export const createBooking = ({ slotId, holdToken, idempotencyKey, planId }) =>
  request('/api/demo/bookings', { method: 'POST', body: { slotId, holdToken, idempotencyKey, planId: planId || null } });

export const cancelBooking = ({ number, cancelToken }) =>
  request('/api/demo/bookings/cancel', { method: 'POST', body: { number, cancelToken } });

/** Записи вошедшего пользователя (сессия — в cookie). */
export const fetchAccountBookings = ({ signal } = {}) => request('/api/demo/bookings/mine', { signal });

export const lookupBookings = (items) =>
  request('/api/demo/bookings/lookup', {
    method: 'POST',
    body: { items: items.map(({ number, cancelToken }) => ({ number, cancelToken })) },
  });

/** Ключ повтора: один на попытку записи, чтобы повтор не создал вторую запись. */
export const newIdempotencyKey = () => {
  try {
    if (typeof crypto?.randomUUID === 'function') return `bk-${crypto.randomUUID()}`;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `bk-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  }
};

/* ------------------------- Мои записи в браузере ------------------------ */

const NUMBER = /^DEMO-\d{6}-[A-Z0-9]{5}$/;

const sanitizeStored = (item) => {
  if (!item || typeof item !== 'object' || !NUMBER.test(item.number) || typeof item.cancelToken !== 'string') return null;
  const text = (value, max = 120) => (typeof value === 'string' ? value.slice(0, max) : null);
  return {
    number: item.number,
    cancelToken: item.cancelToken.slice(0, 100),
    status: item.status === 'CANCELLED' ? 'CANCELLED' : 'CONFIRMED',
    doctorName: text(item.doctorName),
    specialty: text(item.specialty, 60),
    clinicName: text(item.clinicName),
    address: text(item.address, 160),
    day: text(item.day, 10),
    start: text(item.start, 5),
    end: text(item.end, 5),
    lat: Number.isFinite(item.lat) ? item.lat : null,
    lng: Number.isFinite(item.lng) ? item.lng : null,
    itemId: text(item.itemId, 160),
  };
};

export const readMyBookings = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.map(sanitizeStored).filter(Boolean) : [];
  } catch {
    return [];
  }
};

export const writeMyBookings = (items) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.map(sanitizeStored).filter(Boolean).slice(0, MAX_STORED)));
  } catch {
    // Без хранилища записи живут до перезагрузки страницы.
  }
};

/** Запись из ответа сервера → то, что храним у себя (без лишнего). */
export const toStoredBooking = (booking) => sanitizeStored({
  number: booking.number,
  cancelToken: booking.cancelToken,
  status: booking.status,
  doctorName: booking.doctor?.name,
  specialty: booking.doctor?.specialty,
  clinicName: booking.clinic?.name,
  address: booking.clinic?.address,
  day: booking.slot?.day,
  start: booking.slot?.start,
  end: booking.slot?.end,
  lat: booking.clinic?.lat,
  lng: booking.clinic?.lng,
  itemId: booking.doctor && booking.clinic ? `${booking.doctor.id}--${booking.clinic.branchId}` : null,
});

/* ------------------------------ Подписи -------------------------------- */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

const dayDiff = (day, today) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

/** «Сегодня», «Завтра», «пт, 16 октября». */
export const formatDay = (day, today) => {
  if (!day) return '';
  const diff = today ? dayDiff(day, today) : null;
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === 2) return 'Послезавтра';
  const date = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};

/** «пт, 16 октября 2026» — для подтверждения. */
export const formatFullDate = (day) => {
  if (!day) return '';
  const date = new Date(`${day}T12:00:00Z`);
  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

export const formatPrice = (value) => (Number.isFinite(value) ? `${value.toLocaleString('ru-RU')} ₽` : 'цена не указана');

export const TRAVEL_LABEL = Object.freeze({ driving: 'на машине', foot: 'пешком', bike: 'на велосипеде' });
