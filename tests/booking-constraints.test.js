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
    ['не раньше 17:00', {}],
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
    ['в Московском районе', { districts: ['Московский'] }],
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
    // Несколько дней сразу — все, а не последний.
    ['во вторник или среду', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 2 }, { kind: 'weekday', weekday: 3 }] } }],
    ['сегодня или завтра', { date: { kind: 'any_of', options: [{ kind: 'today' }, { kind: 'tomorrow' }] } }],
    ['в понедельник, среду или пятницу', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 1 }, { kind: 'weekday', weekday: 3 }, { kind: 'weekday', weekday: 5 }] } }],
    ['на 15 или 16 октября', { date: { kind: 'any_of', options: [{ kind: 'date', month: 10, dayOfMonth: 15 }, { kind: 'date', month: 10, dayOfMonth: 16 }] } }],
    ['не в понедельник, а во вторник', { date: { kind: 'weekday', weekday: 2 }, excludeWeekdays: [1] }],
    ['только не в понедельник', { excludeWeekdays: [1] }],
    ['кроме пятницы и субботы', { excludeWeekdays: [5, 6], suppressWeekend: true }],
    ['гинеколог, желательно женщина', { preferGender: 'female' }],
    ['запишите на 17:30', { timeExact: '17:30' }],
    ['около 18:00', { timeAround: '18:00' }],
    ['лор в субботу 16 октября', { date: { kind: 'date', month: 10, dayOfMonth: 16, expectWeekday: 6 } }],
    ['педиатр бесплатно по ОМС', { unsupported: ['oms'] }],
    ['онлайн-консультация не нужна', {}],
    // Часы словами и с частью суток.
    ['после шести вечера', { spokenAfter: '18:00' }],
    ['в 2 часа дня', { timeExact: '14:00' }],
    ['с 9 утра до 2 дня', { spokenAfter: '09:00', spokenBefore: '14:00' }],
    ['около семи вечера', { timeAround: '19:00' }],
    ['в два раза дешевле', {}],
    ['уролог после работы', { afterWork: true }],
    ['в пн или ср', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 1 }, { kind: 'weekday', weekday: 3 }] } }],
    ['через 2 дня', { date: { kind: 'in_days', days: 2 } }],
    ['через 2 часа', {}],
    ['в районе Горок', { originHint: 'place', nearPlace: true }],
    ['в будни', { workdays: true }],
    // Район — только со словом «район»; «Московский проспект» — улица.
    ['в Вахитовском или Приволжском районе, но не в Советском районе', { districts: ['Вахитовский', 'Приволжский'], excludeDistricts: ['Советский'] }],
    ['кроме Советского района', { excludeDistricts: ['Советский'] }],
    ['на Московском проспекте', {}],
    ['в центре', { districts: ['Вахитовский'] }],
    ['в медицинском центре', {}],
    // Пол — только о враче.
    ['врач-женщина', { doctorGender: 'female' }],
    ['чтобы врач был мужчина', { doctorGender: 'male' }],
    ['нужен гинеколог женщина', { doctorGender: 'female' }],
    ['гинеколог женщине 30 лет', {}],
    ['я женщина, нужен терапевт', {}],
    // Стаж: «больше 15» — строго больше.
    ['с опытом больше 15 лет', { minExperience: 16 }],
    ['стаж от 10 лет', { minExperience: 10 }],
    ['мне 40 лет', {}],
    // Чего в демо нет — помечается, а не теряется.
    ['вызвать врача на дом', { unsupported: ['home_visit'] }],
    ['онлайн-консультация', { unsupported: ['online'] }],
    ['запишите онлайн', {}],
    ['лучший лор с отзывами', { unsupported: ['rating'] }],
    // Программа ДМС по названию; «Кама Премиум» — клиника, а не программа.
    ['по программе Demo Premium', { planId: 'demo-premium', dms: true }],
    ['в клинику Кама Премиум', {}],
    // Точка отправления словами — только рядом со словами о дороге.
    ['не дальше 20 минут от дома', { originHint: 'home' }],
    ['рядом с Кремлём', { originHint: 'place' }],
    ['что-нибудь от кашля', {}],
    ['рядом со мной', {}],
  ];
  for (const [text, expected] of cases) {
    it(`«${text}»`, () => {
      assert.deepEqual(extractBookingConstraints(text), expected);
    });
  }

  it('цена не принимается за время приёма: «до 3 000 ₽» — не «до 03:00»', () => {
    for (const text of ['до 3 000 рублей', 'до 3 тысяч', 'до 2к', 'с 3 000', 'до 2 дней', 'до 5 лет']) {
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

  it('слияние: будни и выходные сменяют друг друга; район, пол, стаж держатся до отмены', () => {
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    const weekdays = merge(['терапевт в выходные', 'нет, лучше в будни']);
    assert.equal(weekdays.workdays, true);
    assert.equal(weekdays.weekend, false);
    const back = merge(['терапевт в будни', 'а можно в субботу']);
    assert.equal(back.workdays, false);
    const kept = merge(['лор в Вахитовском районе, врач-женщина, стаж от 10 лет', 'а завтра?']);
    assert.deepEqual(kept.districts, ['Вахитовский']);
    assert.equal(kept.doctorGender, 'female');
    assert.equal(kept.minExperience, 10);
    const cleared = merge(['лор в Вахитовском районе, врач-женщина', 'район не важен, пол врача не важен']);
    assert.deepEqual(cleared.districts, []);
    assert.equal(cleared.doctorGender, null);
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
