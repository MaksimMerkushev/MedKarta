/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Условия записи из текста: день, цена, город, ДМС и их снятие в диалоге.
 * И флаги демо-режима: скрытие госучреждений, /api/config, нормализация
 * запроса подбора в контракте интерфейса.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractBookingConstraints, mergeBookingTurns } from '../backend/privacy/bookingConstraints.js';
import { extractConstraints } from '../backend/privacy/gateway.js';
import { bookingModeFromEnv, isPublicClinicRecord, publicClinicsHidden } from '../backend/demo/flags.js';
import { sanitizeAiAction } from '../shared/contract.js';
import configHandler from '../backend/api/config.js';
import { __resetCatalogCache, loadCatalog } from '../backend/privacy/catalog.js';

describe('Условия записи из текста', () => {
  const cases = [
    ['Нужен ЛОР завтра после 18:00', { date: { kind: 'tomorrow' } }],
    ['не сегодня, а завтра', { date: { kind: 'tomorrow' } }],
    ['послезавтра вечером', { date: { kind: 'after_tomorrow' } }],
    ['сегодня', { date: { kind: 'today' } }],
    ['в пятницу', { date: { kind: 'weekday', weekday: 5 } }],
    ['во вторник', { date: { kind: 'weekday', weekday: 2 } }],
    ['на 15 октября', { date: { kind: 'date', month: 10, dayOfMonth: 15 } }],
    ['на 15.10', { date: { kind: 'date', month: 10, dayOfMonth: 15 } }],
    ['в любой день', { date: null }],
    ['дерматолог до 3000 ₽', { maxPrice: 3000 }],
    ['до 3 000 рублей', { maxPrice: 3000 }],
    ['не дороже 2,5 тыс', { maxPrice: 2500 }],
    ['не дороже 2500', { maxPrice: 2500 }],
    ['до трёх тысяч', { maxPrice: 3000 }],
    ['до 2к', { maxPrice: 2000 }],
    ['цена не важна', { maxPrice: null }],
    ['в Иннополисе', { city: 'innopolis' }],
    ['я из Москвы', { city: 'moscow' }],
    ['в Казани', { city: 'kazan' }],
    ['в Московском районе', {}],
    ['на Нижнекамской улице', {}],
    ['по ДМС', { dms: true }],
    ['по страховке', { dms: true }],
    ['без ДМС', { dms: false }],
    ['платно', { dms: false }],
    ['повторный приём', { visit: 'repeat' }],
    ['в любое время', { timeAny: true }],
    ['добрый вечер, нужен педиатр', {}],
    ['до 18', {}],
    ['до 20 минут', {}],
    ['педиатр в понедельник утром', { date: { kind: 'weekday', weekday: 1 }, timeOfDay: 'morning' }],
    ['терапевт до обеда', { timeOfDay: 'morning' }],
    ['невролог после обеда', { timeOfDay: 'afternoon' }],
    ['днём в среду', { date: { kind: 'weekday', weekday: 3 }, timeOfDay: 'daytime' }],
    ['доброе утро, нужен терапевт', {}],
    ['на этой неделе', { date: { kind: 'this_week' } }],
    ['на следующей неделе', { date: { kind: 'next_week' } }],
    ['подбор очков', { serviceId: 'proc.ophthalmologist.glasses', procedureSpecialty: 'ophthalmologist' }],
    ['сделать ЭКГ', { serviceId: 'diag.ecg', procedureSpecialty: 'cardiologist' }],
    ['профессиональная чистка зубов', { serviceId: 'proc.dentist.hygiene', procedureSpecialty: 'dentist' }],
    ['к гинекологу на УЗИ', { serviceId: 'proc.gynecologist.ultrasound', procedureSpecialty: 'gynecologist' }],
    ['УЗИ брюшной полости', {}],
  ];
  for (const [text, expected] of cases) {
    it(`«${text}»`, () => {
      assert.deepEqual(extractBookingConstraints(text), expected);
    });
  }

  it('цена не принимается за время приёма: «до 3 000 ₽» — не «до 03:00»', () => {
    for (const text of ['до 3 000 рублей', 'до 3 тысяч', 'до 2к', 'с 3 000']) {
      const constraints = extractConstraints(text);
      assert.equal(constraints.availableBefore, undefined, text);
      assert.equal(constraints.availableAfter, undefined, text);
    }
    assert.equal(extractConstraints('до 18:30').availableBefore, '18:30');
  });

  it('время суток заменяет прежнее условие на время, а не складывается с ним', () => {
    const turns = ['ЛОР вечером', 'нет, лучше утром']
      .map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) }));
    const merged = mergeBookingTurns(turns);
    assert.equal(merged.evening, false);
    assert.equal(merged.timeFrom, null);
    assert.equal(merged.timeTo, '12:00');
  });

  it('слияние реплик: поздняя важнее, снятие обнуляет', () => {
    const turns = ['ЛОР завтра после 18:00 по ДМС до 3000 ₽', 'а лучше послезавтра', 'без ДМС, цена не важна, в любое время']
      .map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) }));
    const step1 = mergeBookingTurns(turns.slice(0, 1));
    assert.deepEqual(step1.date, { kind: 'tomorrow' });
    assert.equal(step1.timeFrom, '18:00');
    assert.equal(step1.dms, true);
    assert.equal(step1.maxPrice, 3000);
    const step2 = mergeBookingTurns(turns.slice(0, 2));
    assert.deepEqual(step2.date, { kind: 'after_tomorrow' });
    assert.equal(step2.timeFrom, '18:00');
    const step3 = mergeBookingTurns(turns);
    assert.equal(step3.dms, false);
    assert.equal(step3.maxPrice, null);
    assert.equal(step3.timeFrom, null);
    assert.deepEqual(step3.date, { kind: 'after_tomorrow' });
  });
});

describe('Флаги демо-режима', () => {
  it('госучреждения скрыты только в демо и возвращаются PUBLIC_CLINICS=on', () => {
    assert.equal(publicClinicsHidden({}), false);
    assert.equal(publicClinicsHidden({ DEMO_DATA: 'on' }), true);
    assert.equal(publicClinicsHidden({ DEMO_DATA: 'on', PUBLIC_CLINICS: 'on' }), false);
    assert.equal(isPublicClinicRecord({ ownership: 'Государственная' }), true);
    assert.equal(isPublicClinicRecord({ ownership: 'Частная' }), false);
  });

  it('запись — только в демо и выключается DEMO_BOOKING=off', () => {
    assert.equal(bookingModeFromEnv({}), false);
    assert.equal(bookingModeFromEnv({ DEMO_DATA: 'on' }), true);
    assert.equal(bookingModeFromEnv({ DEMO_DATA: 'on', DEMO_BOOKING: 'off' }), false);
  });

  it('справочник ассистента в демо — без госучреждений; PUBLIC_CLINICS=on — с ними; данные не удаляются', async () => {
    const saved = { DEMO_DATA: process.env.DEMO_DATA, PUBLIC_CLINICS: process.env.PUBLIC_CLINICS };
    try {
      process.env.DEMO_DATA = 'on';
      delete process.env.PUBLIC_CLINICS;
      __resetCatalogCache();
      const hidden = await loadCatalog();
      const publicCount = (catalog) => [...catalog.doctors, ...catalog.clinics].filter(isPublicClinicRecord).length;
      assert.equal(publicCount(hidden), 0);
      assert.ok(hidden.doctors.some((doctor) => String(doctor.id).startsWith('demo-doc-')));
      process.env.PUBLIC_CLINICS = 'on';
      __resetCatalogCache();
      const shown = await loadCatalog();
      assert.ok(publicCount(shown) > 0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __resetCatalogCache();
    }
  });

  it('/api/config отдаёт флаги', async () => {
    const saved = { DEMO_DATA: process.env.DEMO_DATA, PUBLIC_CLINICS: process.env.PUBLIC_CLINICS };
    process.env.DEMO_DATA = 'on';
    delete process.env.PUBLIC_CLINICS;
    try {
      let body = '';
      const res = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(chunk) { body = chunk; } };
      await configHandler({ method: 'GET', headers: {} }, res);
      const payload = JSON.parse(body);
      assert.equal(payload.demo, true);
      assert.equal(payload.publicClinics, false);
      assert.equal(typeof payload.booking, 'boolean');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('Контракт: запрос подбора в ответе ассистента', () => {
  it('неизвестные поля и строки вне списков отбрасываются', () => {
    const action = sanitizeAiAction({
      booking: {
        request: { specialty: 'lor', date: { kind: 'yesterday' }, timeFrom: '25:00', maxPrice: 3000, city: 'atlantis', injected: '<script>', dms: { required: 'yes' } },
        summary: ['ЛОР', 'x'.repeat(500), 42],
      },
    });
    assert.equal(action.booking.request.specialty, 'lor');
    assert.deepEqual(action.booking.request.date, { kind: 'any' });
    assert.equal(action.booking.request.timeFrom, null);
    assert.equal(action.booking.request.city, null);
    assert.equal(action.booking.request.dms.required, false);
    assert.equal(action.booking.request.injected, undefined);
    assert.equal(action.booking.summary[1].length, 80);
    assert.equal(action.booking.summary.length, 2);
    assert.equal(sanitizeAiAction({}).booking, null);
  });
});
