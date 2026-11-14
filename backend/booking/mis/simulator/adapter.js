/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Адаптер симулятора МИС (mis/simulator/server.js). Образец того, как
 * выглядит адаптер: HTTP через защищённый клиент (mis/httpClient.js), ответы —
 * в общий вид, отказы — в MisError. Настоящий адаптер конкретной МИС пишется
 * по её официальной документации и проверяется на её тестовом стенде.
 *
 * can — можно урезать (например, без hold или findByRequest), чтобы проверить
 * поведение МедКарты с МИС, которая этого не умеет.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { defineMisAdapter, MisError } from '../core.js';
import { createMisHttpClient } from '../httpClient.js';

const FULL = Object.freeze({ branches: true, doctors: true, services: true, slots: true, hold: true, book: true, cancel: true, status: true, webhooks: true, idempotentBook: true, findByRequest: true });
const WEBHOOK_TOLERANCE_S = 300;

const list = (response) => {
  if (!Array.isArray(response.json)) throw new MisError('invalid_response', 'not_a_list');
  return response.json;
};
const appointment = (body) => {
  if (!body || typeof body.id !== 'string' || typeof body.status !== 'string') throw new MisError('invalid_response', 'appointment_shape');
  return { externalBookingId: body.id, status: body.status, externalSlotId: body.slotId ?? null };
};
const failOn = (response) => {
  if (response.status === 404) throw new MisError('not_found');
  if (response.status === 409) throw new MisError('slot_taken');
  if (response.status === 400 || response.status === 422) throw new MisError('invalid_request', `http_${response.status}`);
  if (response.status >= 300) throw new MisError('unknown', `http_${response.status}`);
  return response;
};

/**
 * @param {object} options
 * @param {string} options.baseUrl адрес симулятора
 * @param {string} options.token токен (из окружения: MIS_<ИНТЕГРАЦИЯ>_TOKEN)
 * @param {string} [options.webhookSecret]
 * @param {object} [options.can] урезанные возможности
 */
export const createSimulatorAdapter = ({ baseUrl, token, webhookSecret = null, can = FULL, timeoutMs = 3000, fetchImpl, now = () => Date.now(), production }) => {
  const http = createMisHttpClient({
    baseUrl, allowedHosts: [new URL(baseUrl).hostname], allowPrivate: true, timeoutMs, fetchImpl,
    authorization: () => (token ? `Bearer ${token}` : null), ...(production !== undefined ? { production } : {}),
  });
  const iso = (ms) => new Date(ms).toISOString();

  return defineMisAdapter({
    type: 'mis-simulator',
    simulator: true,
    can,
    listBranches: async () => list(failOn(await http.request('GET', '/v1/branches'))),
    listDoctors: async () => list(failOn(await http.request('GET', '/v1/doctors'))),
    listServices: async () => list(failOn(await http.request('GET', '/v1/services'))),
    listSlots: async ({ doctorIds, branchIds, from, to }) => list(failOn(await http.request('GET', '/v1/slots', { query: { doctorId: doctorIds.join(','), branchId: branchIds.join(','), from: iso(from), to: iso(to) } }))),
    hold: async ({ externalSlotId }) => {
      const response = failOn(await http.request('POST', '/v1/holds', { body: { slotId: externalSlotId } }));
      if (typeof response.json?.holdId !== 'string') throw new MisError('invalid_response', 'hold_shape');
      return { holdRef: response.json.holdId, expiresAt: response.json.expiresAt };
    },
    release: async ({ holdRef }) => {
      failOn(await http.request('DELETE', `/v1/holds/${encodeURIComponent(holdRef)}`, { body: {} }));
      return true;
    },
    book: async ({ externalSlotId, requestId, holdRef, patient }) => appointment(failOn(await http.request('POST', '/v1/appointments', {
      // Симулятору — только непрозрачная ссылка на пациента, без ФИО и телефона.
      body: { slotId: externalSlotId, requestId, ...(holdRef ? { holdId: holdRef } : {}), ...(patient?.ref ? { patient: { ref: patient.ref } } : {}) },
    })).json),
    getBooking: async ({ externalBookingId }) => appointment(failOn(await http.request('GET', `/v1/appointments/${encodeURIComponent(externalBookingId)}`)).json),
    findBookingByRequest: async ({ requestId }) => {
      const found = list(failOn(await http.request('GET', '/v1/appointments', { query: { requestId } })));
      return found.length ? appointment(found[0]) : null;
    },
    cancel: async ({ externalBookingId }) => appointment(failOn(await http.request('POST', `/v1/appointments/${encodeURIComponent(externalBookingId)}/cancel`, { body: {} })).json),

    /* Webhook симулятора: подпись HMAC-SHA256 от «<время>.<тело>», окно 5 минут. Схема — симулятора, не поставщика. */
    verifyWebhook: ({ headers, rawBody }) => {
      if (!webhookSecret) return { ok: false, reason: 'no_secret' };
      const timestamp = Number(headers['x-sim-timestamp']);
      const eventId = String(headers['x-sim-event-id'] || '');
      const signature = String(headers['x-sim-signature'] || '');
      if (!Number.isFinite(timestamp) || Math.abs(now() / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return { ok: false, reason: 'stale' };
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(eventId)) return { ok: false, reason: 'event_id' };
      const expected = Buffer.from(`sha256=${createHmac('sha256', webhookSecret).update(`${timestamp}.${rawBody}`).digest('hex')}`);
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'signature' };
      return { ok: true, eventId };
    },
    parseWebhook: (body) => {
      if (body?.type === 'schedule.changed') return [{ type: 'schedule_changed' }];
      if (body?.type === 'appointment.status' && typeof body.appointmentId === 'string' && typeof body.status === 'string') {
        return [{ type: 'booking_status', externalBookingId: body.appointmentId, status: body.status }];
      }
      throw new MisError('invalid_request', 'unknown_event');
    },
  });
};
