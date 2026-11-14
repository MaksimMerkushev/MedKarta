/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Симулятор МИС для разработки и тестов. Его API ВЫМЫШЛЕН («MIS Simulator API
 * v1») и не повторяет API ни одной реальной МИС — по нему нельзя судить, как
 * устроены Инфоклиника, МЕДИАЛОГ, 1С:Медицина, IDENT и другие. Он нужен,
 * чтобы проверить общий слой МедКарты на типовых ситуациях:
 *
 *   GET  /v1/branches | /v1/doctors | /v1/services
 *   GET  /v1/slots?doctorId=&branchId=&from=&to=        (from/to — ISO)
 *   POST /v1/holds {slotId}                → {holdId, expiresAt} | 409
 *   DELETE /v1/holds/:holdId
 *   POST /v1/appointments {slotId, requestId, holdId?, patient?}
 *        → 201 {id, status} | тот же requestId → 200 та же запись | 409 занято
 *   GET  /v1/appointments/:id | GET /v1/appointments?requestId=
 *   POST /v1/appointments/:id/cancel       → {id, status: 'cancelled'} | 404
 *   Авторизация: Authorization: Bearer <token>.
 *
 * Сбои (sim.fail(operation, mode, {times})): timeout — ответ позже тайм-аута
 * клиента; lost_response — операция выполнена, соединение оборвано без ответа;
 * unavailable — 503; auth_error — 401; invalid_json — не JSON; slot_taken — 409.
 * Данные (sim.state) меняются из тестов: занять слот «другим пациентом»,
 * сдвинуть расписание, сменить статус записи, отправить подписанный webhook.
 * Только синтетические данные; запускать в production нельзя.
 */

import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 65536) req.destroy(); });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : {});
    } catch {
      resolve(null);
    }
  });
});

/**
 * @param {object} options
 * @param {object[]} options.branches [{id, name, address}]
 * @param {object[]} options.doctors [{id, name, specialty, branchIds, serviceId}]
 * @param {object[]} options.services [{id, name, price, durationMinutes}]
 * @param {string} options.token токен авторизации
 * @param {() => number} [options.now]
 * @param {string[]} [options.days] дни расписания (YYYY-MM-DD, по Москве)
 * @param {string[]} [options.times] время приёма в день (HH:MM)
 */
export const createMisSimulator = ({ branches, doctors, services, token, now = () => Date.now(), days = [], times = ['09:00', '10:00', '11:00', '15:00', '18:30'], delayMs = 0 }) => {
  const state = {
    branches: structuredClone(branches),
    doctors: structuredClone(doctors),
    services: structuredClone(services),
    slots: new Map(),
    holds: new Map(),
    appointments: new Map(),
    requests: [],
  };
  for (const doctor of state.doctors) {
    for (const branchId of doctor.branchIds) {
      for (const day of days) {
        for (const time of times) {
          const start = Date.parse(`${day}T${time}:00+03:00`);
          const id = `S-${doctor.id}-${branchId}-${day.replace(/-/g, '')}${time.replace(':', '')}`;
          state.slots.set(id, { id, doctorId: doctor.id, branchId, serviceId: doctor.serviceId, startAt: new Date(start).toISOString(), endAt: new Date(start + 30 * 60_000).toISOString(), status: 'free' });
        }
      }
    }
  }
  const faults = new Map();
  const fail = (operation, mode, { times: count = 1 } = {}) => faults.set(operation, { mode, left: count });
  const takeFault = (operation) => {
    const fault = faults.get(operation);
    if (!fault) return null;
    fault.left -= 1;
    if (fault.left <= 0) faults.delete(operation);
    return fault.mode;
  };
  let clientTimeoutMs = 1000;

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://simulator');
    const route = `${req.method} ${url.pathname.replace(/\/[HA]-[A-Za-z0-9]+(?=\/|$)/g, '/:id')}`;
    state.requests.push({ route, at: now() });
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: 'unauthorized' });
    const operation = {
      'GET /v1/branches': 'branches', 'GET /v1/doctors': 'doctors', 'GET /v1/services': 'services', 'GET /v1/slots': 'slots',
      'POST /v1/holds': 'hold', 'DELETE /v1/holds/:id': 'release', 'POST /v1/appointments': 'book', 'GET /v1/appointments/:id': 'get',
      'GET /v1/appointments': 'find', 'POST /v1/appointments/:id/cancel': 'cancel',
    }[route];
    if (!operation) return json(res, 404, { error: 'not_found' });
    const fault = takeFault(operation);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (fault === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, clientTimeoutMs * 2));
      return res.destroy();
    }
    if (fault === 'unavailable') return json(res, 503, { error: 'maintenance' });
    if (fault === 'auth_error') return json(res, 401, { error: 'token expired' });
    if (fault === 'invalid_json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"broken":');
    }
    const body = ['POST', 'DELETE'].includes(req.method) ? await readBody(req) : null;
    if (body === null && req.method === 'POST') return json(res, 400, { error: 'bad_json' });
    const id = url.pathname.split('/')[3];

    switch (operation) {
      case 'branches': return json(res, 200, state.branches);
      case 'doctors': return json(res, 200, state.doctors.map((doctor) => ({ id: doctor.id, name: doctor.name, specialty: doctor.specialty, branchIds: doctor.branchIds })));
      case 'services': return json(res, 200, state.services);
      case 'slots': {
        const doctorIds = (url.searchParams.get('doctorId') || '').split(',').filter(Boolean);
        const branchIds = (url.searchParams.get('branchId') || '').split(',').filter(Boolean);
        const from = Date.parse(url.searchParams.get('from'));
        const to = Date.parse(url.searchParams.get('to'));
        const list = [...state.slots.values()].filter((slot) => (!doctorIds.length || doctorIds.includes(slot.doctorId)) && (!branchIds.length || branchIds.includes(slot.branchId))
          && Date.parse(slot.startAt) >= from && Date.parse(slot.startAt) <= to)
          .map((slot) => ({ ...slot, status: slot.status === 'free' && !holdOf(slot.id) ? 'free' : 'busy' }));
        return json(res, 200, list);
      }
      case 'hold': {
        const slot = state.slots.get(body.slotId);
        if (!slot) return json(res, 404, { error: 'slot_not_found' });
        if (fault === 'slot_taken' || slot.status !== 'free' || holdOf(slot.id)) return json(res, 409, { error: 'slot_taken' });
        const holdId = `H-${randomBytes(6).toString('hex')}`;
        state.holds.set(holdId, { slotId: slot.id, expiresAt: now() + 10 * 60_000 });
        return json(res, 201, { holdId, expiresAt: new Date(now() + 10 * 60_000).toISOString() });
      }
      case 'release': {
        state.holds.delete(id);
        return json(res, 200, { ok: true });
      }
      case 'book': {
        const existing = [...state.appointments.values()].find((item) => item.requestId === body.requestId);
        if (existing) return json(res, 200, publicAppointment(existing));
        const slot = state.slots.get(body.slotId);
        if (!slot) return json(res, 404, { error: 'slot_not_found' });
        const held = holdOf(slot.id);
        if (fault === 'slot_taken' || slot.status !== 'free' || (held && held.holdId !== body.holdId)) return json(res, 409, { error: 'slot_taken' });
        if (held) state.holds.delete(held.holdId);
        slot.status = 'busy';
        const appointment = { id: `A-${randomBytes(6).toString('hex')}`, requestId: body.requestId, slotId: slot.id, status: 'confirmed', patient: body.patient ? { ref: String(body.patient.ref || '').slice(0, 40) } : null };
        state.appointments.set(appointment.id, appointment);
        if (fault === 'lost_response') return res.destroy();
        return json(res, 201, publicAppointment(appointment));
      }
      case 'get': {
        const appointment = state.appointments.get(id);
        return appointment ? json(res, 200, publicAppointment(appointment)) : json(res, 404, { error: 'not_found' });
      }
      case 'find': {
        const requestId = url.searchParams.get('requestId');
        return json(res, 200, [...state.appointments.values()].filter((item) => item.requestId === requestId).map(publicAppointment));
      }
      case 'cancel': {
        const appointment = state.appointments.get(id);
        if (!appointment) return json(res, 404, { error: 'not_found' });
        if (appointment.status !== 'cancelled') {
          appointment.status = 'cancelled';
          const slot = state.slots.get(appointment.slotId);
          if (slot) slot.status = 'free';
        }
        if (fault === 'lost_response') return res.destroy();
        return json(res, 200, publicAppointment(appointment));
      }
      default: return json(res, 404, { error: 'not_found' });
    }
  };
  const holdOf = (slotId) => {
    for (const [holdId, hold] of state.holds) {
      if (hold.expiresAt <= now()) state.holds.delete(holdId);
      else if (hold.slotId === slotId) return { holdId, ...hold };
    }
    return null;
  };
  const publicAppointment = (item) => ({ id: item.id, requestId: item.requestId, slotId: item.slotId, status: item.status });

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => json(res, 500, { error: 'internal' }));
  });

  /** Подписанный webhook (схема симулятора: HMAC-SHA256 от «<время>.<тело>»). */
  const signWebhook = (secret, body, timestamp = Math.floor(now() / 1000)) => {
    const raw = JSON.stringify(body);
    return { raw, headers: { 'Content-Type': 'application/json', 'X-Sim-Timestamp': String(timestamp), 'X-Sim-Event-Id': `E-${randomBytes(6).toString('hex')}`, 'X-Sim-Signature': `sha256=${createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')}` } };
  };

  return {
    server, state, fail, signWebhook,
    setClientTimeout: (ms) => { clientTimeoutMs = ms; },
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    /* Действия «в клинике», мимо МедКарты. */
    takeSlotByOther: (slotId) => { const slot = state.slots.get(slotId); if (slot) slot.status = 'busy'; },
    moveSlot: (slotId, minutes) => { const slot = state.slots.get(slotId); if (slot) { slot.startAt = new Date(Date.parse(slot.startAt) + minutes * 60_000).toISOString(); slot.endAt = new Date(Date.parse(slot.endAt) + minutes * 60_000).toISOString(); } },
    setAppointmentStatus: (appointmentId, status) => { const item = state.appointments.get(appointmentId); if (item) item.status = status; },
    appointmentByRequest: (requestId) => [...state.appointments.values()].find((item) => item.requestId === requestId) || null,
  };
};
