/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Проверка и приведение данных МИС к общему виду. Адаптер отдаёт то, что
 * ответила МИС, а здесь решается, чему можно верить: запись без внешнего
 * идентификатора, цена вне разумных пределов, слот, у которого конец раньше
 * начала, — отбрасываются с причиной (код, без персональных данных).
 *
 * Сопоставление с МедКартой — по таблице соответствий (mis/ledger.js):
 * внешний id врача → id врача МедКарты и т. д. Совпадение по ФИО не
 * используется никогда: однофамильцы и опечатки дали бы запись не к тому врачу.
 */

const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,80}$/;
export const MAX_PRICE_RUB = 1_000_000;
const MIN_SLOT_MINUTES = 5;
const MAX_SLOT_MINUTES = 240;

const text = (value, max = 160) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const externalId = (value) => (typeof value === 'string' || typeof value === 'number') && EXTERNAL_ID.test(String(value)) ? String(value) : null;

/** Результат: valid — принятые записи, rejected — [{ externalId|null, reason }]. */
const collect = (items, normalizeOne) => {
  const valid = [];
  const rejected = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const result = normalizeOne(item);
    if (result.reason) rejected.push({ externalId: result.externalId ?? null, reason: result.reason });
    else if (seen.has(result.value.externalId)) rejected.push({ externalId: result.value.externalId, reason: 'duplicate_id' });
    else {
      seen.add(result.value.externalId);
      valid.push(result.value);
    }
  }
  if (!Array.isArray(items)) rejected.push({ externalId: null, reason: 'not_a_list' });
  return { valid, rejected };
};

export const normalizeBranches = (items) => collect(items, (item) => {
  const id = externalId(item?.id);
  if (!id) return { reason: 'missing_id' };
  const name = text(item.name);
  if (!name) return { externalId: id, reason: 'missing_name' };
  return { value: { externalId: id, name, address: text(item.address, 240) || null } };
});

export const normalizeDoctors = (items) => collect(items, (item) => {
  const id = externalId(item?.id);
  if (!id) return { reason: 'missing_id' };
  const specialty = text(item.specialty, 80);
  if (!specialty) return { externalId: id, reason: 'missing_specialty' };
  const branchIds = (Array.isArray(item.branchIds) ? item.branchIds : []).map(externalId).filter(Boolean);
  if (!branchIds.length) return { externalId: id, reason: 'missing_branch' };
  return { value: { externalId: id, name: text(item.name) || null, specialty, branchIds: [...new Set(branchIds)] } };
});

export const normalizeServices = (items) => collect(items, (item) => {
  const id = externalId(item?.id);
  if (!id) return { reason: 'missing_id' };
  const price = item.price;
  if (price !== null && price !== undefined && !(Number.isInteger(price) && price >= 0 && price <= MAX_PRICE_RUB)) return { externalId: id, reason: 'invalid_price' };
  const minutes = item.durationMinutes;
  if (minutes !== undefined && !(Number.isInteger(minutes) && minutes >= MIN_SLOT_MINUTES && minutes <= MAX_SLOT_MINUTES)) return { externalId: id, reason: 'invalid_duration' };
  return { value: { externalId: id, name: text(item.name) || null, price: price ?? null, durationMinutes: minutes ?? null } };
});

/**
 * Слоты. window — {from, to} (мс): слот вне окна — ошибка МИС или устаревший
 * ответ, такой не показываем.
 */
export const normalizeSlots = (items, { window, now }) => collect(items, (item) => {
  const id = externalId(item?.id);
  if (!id) return { reason: 'missing_id' };
  const doctorId = externalId(item.doctorId);
  const branchId = externalId(item.branchId);
  if (!doctorId || !branchId) return { externalId: id, reason: 'missing_reference' };
  const start = Date.parse(item.startAt);
  const end = Date.parse(item.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { externalId: id, reason: 'invalid_time' };
  const minutes = (end - start) / 60_000;
  if (minutes < MIN_SLOT_MINUTES || minutes > MAX_SLOT_MINUTES) return { externalId: id, reason: 'invalid_duration' };
  if (window && (start < window.from || start > window.to)) return { externalId: id, reason: 'outside_window' };
  const state = item.status === undefined ? 'free' : String(item.status);
  if (!['free', 'busy'].includes(state)) return { externalId: id, reason: 'invalid_status' };
  return {
    value: {
      externalId: id, doctorId, branchId, serviceId: externalId(item.serviceId),
      startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
      free: state === 'free' && start > now,
    },
  };
});

/* Статус записи в МИС → состояние МедКарты. Неизвестный статус — не «подтверждено». */
const BOOKING_STATUS = Object.freeze({ confirmed: 'confirmed', booked: 'confirmed', cancelled: 'cancelled', canceled: 'cancelled', completed: 'completed', visited: 'completed', no_show: 'completed' });
export const normalizeBookingStatus = (value) => BOOKING_STATUS[String(value || '').toLowerCase()] || null;
