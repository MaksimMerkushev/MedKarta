/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сквозные сценарии демо-записи: свободный текст → ассистент (конвейер
 * приватности, локальный или «внешний» план) → запрос строгого подбора →
 * сервер подбора → слот → запись → состояние слота.
 *
 * Время заморожено: «сейчас» — понедельник 12.10.2026, 12:00 МСК
 * (вторник 13.10 — «завтра»). Набор — фиксированный (seed демо).
 * Проверяются результаты сервера, а не тексты интерфейса.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { createDemoSearch } from '../backend/demo/search.js';
import { moscowMoment, moscowParts } from '../backend/demo/time.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { createRoutingEngine } from '../backend/routing/engine.js';
import { loadGraph } from '../backend/routing/graph.js';
import { PLANNER_ERROR } from '../backend/planner/client.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const TODAY = '2026-10-12';
const TOMORROW = '2026-10-13';
const AFTER_TOMORROW = '2026-10-14';
const CENTER = { lat: 55.7963, lng: 49.1088 };
const REAL_GRAPH = fileURLToPath(new URL('../data/graph/kazan.graph', import.meta.url));
const HAS_REAL_GRAPH = fs.existsSync(REAL_GRAPH);
const KEY = (suffix) => `scenario-key-${String(suffix).padStart(6, '0')}`;

const PLANNER_DOWN = Object.assign(new Error('upstream down'), { code: PLANNER_ERROR.UPSTREAM });

let catalog;
let index;
let store;
let engine = null;
let clock = NOW;

const searchWith = (getEngine) => createDemoSearch({ index, store, getEngine, now: () => clock });

/** Ответ ассистента на реплики пользователя (по умолчанию модель недоступна → локальный план). */
const chat = async (texts, { respond = PLANNER_DOWN } = {}) => {
  const { pipeline } = makeTestPipeline({ catalog, respond, booking: { enabled: true, now: () => clock } });
  const messages = (Array.isArray(texts) ? texts : [texts]).map((content) => ({ role: 'user', content }));
  const { action } = await pipeline.handle({ messages, sessionId: TEST_SESSION });
  // Интерфейс видит ответ после той же нормализации, что и браузер.
  return sanitizeAiAction(JSON.parse(JSON.stringify(action)));
};

/** Как интерфейс: запрос из ответа + точка отправления и программа ДМС. */
const run = async (action, { origin = null, planId = null, patch = {}, getEngine = async () => engine } = {}) => {
  assert.ok(action.booking, `ответ без запроса подбора: ${action.replyText}`);
  const request = { ...action.booking.request, ...patch, origin, dms: { ...action.booking.request.dms, planId } };
  return searchWith(getEngine).search(request);
};

const allSlots = (result) => result.options.flatMap((option) => option.slots.map((slot) => ({ ...slot, option })));

before(async () => {
  process.env.DEMO_DATA = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
  catalog = await loadCatalog();
  index = await getDemoCatalog();
  if (DatabaseSync) store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => clock });
  if (HAS_REAL_GRAPH) engine = createRoutingEngine({ graph: await loadGraph(REAL_GRAPH) });
});

after(() => {
  store?.close();
  __resetCatalogCache();
});

const needsSqlite = { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' };
const needsGraph = { skip: (!DatabaseSync && 'нужен Node 22.13+') || (!HAS_REAL_GRAPH && 'нет data/graph/kazan.graph') };

describe('Демо-сценарии: строгий подбор', needsSqlite, () => {
  it('1. «ЛОР завтра после 18:00» — только ЛОР, только завтра, не раньше 18:00', async () => {
    const action = await chat('Нужен ЛОР завтра после 18:00');
    assert.equal(action.booking.request.specialty, 'lor');
    assert.deepEqual(action.booking.request.date, { kind: 'tomorrow' });
    assert.equal(action.booking.request.timeFrom, '18:00');
    const result = await run(action);
    assert.equal(result.status, 'ok');
    const slots = allSlots(result);
    assert.ok(slots.length > 0);
    for (const slot of slots) {
      assert.equal(slot.day, TOMORROW);
      assert.ok(slot.start >= '18:00', slot.start);
      assert.equal(slot.status, 'FREE');
      assert.equal(slot.option.doctor.specialtyKey, 'lor');
    }
  });

  it('2. «педиатр для ребёнка» — только врачи с детским приёмом', async () => {
    const action = await chat('Нужен педиатр для ребёнка');
    assert.equal(action.booking.request.patient, 'child');
    const result = await run(action);
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => option.doctor.ageGroups.includes('child') && option.doctor.specialtyKey === 'pediatrician'));
    // Детский ЛОР — тоже только детским врачам.
    const lor = await run(await chat('ребёнку нужен лор'));
    assert.ok(lor.options.every((option) => option.doctor.ageGroups.includes('child')));
    const adultOnly = index.catalog.doctors.filter((doctor) => doctor.specialtyKey === 'lor' && !doctor.ageGroups.includes('child')).map((doctor) => doctor.id);
    assert.ok(!lor.options.some((option) => adultOnly.includes(option.doctor.id)));
  });

  it('3. «дерматолог до 3000 ₽» — ни одного варианта дороже; слишком низкий потолок — честное «нет»', async () => {
    const action = await chat('дерматолог до 3000 ₽');
    assert.equal(action.booking.request.maxPrice, 3000);
    const result = await run(action);
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => option.price <= 3000));
    const cheap = await run(await chat('дерматолог не дороже 900 рублей'));
    assert.equal(cheap.status, 'empty');
    assert.equal(cheap.blocking.key, 'price');
    assert.equal(cheap.options, undefined);
    assert.ok(cheap.relax.some((item) => item.key === 'price' && item.count > 0));
  });

  it('4. Demo Basic: только покрытое программой, процедуры не выдаются за покрытые', async () => {
    const action = await chat('нужен лор по ДМС');
    assert.equal(action.booking.request.dms.required, true);
    const result = await run(action, { planId: 'demo-basic' });
    assert.equal(result.status, 'ok');
    const basicClinics = new Set(['demo-beresta', 'demo-semya', 'demo-travma']);
    for (const option of result.options) {
      assert.equal(option.coverage.status, 'covered');
      assert.equal(option.coverage.planId, 'demo-basic');
      assert.ok(basicClinics.has(option.clinic.id), option.clinic.id);
    }
    // Без «по ДМС» те же варианты показываются с честной отметкой о покрытии.
    const paid = await run(await chat('нужен лор'), { planId: 'demo-basic' });
    assert.ok(paid.options.some((option) => option.coverage.status === 'not_covered'));
    assert.ok(paid.options.every((option) => option.coverage.status !== 'covered' || basicClinics.has(option.clinic.id)));
  });

  it('7. Свободных слотов нет — честный ответ, условия не ослаблены, послабления только как предложение', async () => {
    const action = await chat('нужен кардиолог сегодня после 20:45');
    const result = await run(action);
    assert.equal(result.status, 'empty');
    assert.equal(result.options, undefined);
    assert.match(result.message, /Условия я не ослаблял/);
    assert.ok(result.relax.length > 0);
    assert.ok(result.relax.every((item) => item.patch && Number.isInteger(item.count)));
  });

  it('13. Неизвестная или не выбранная программа ДМС — вопрос, а не догадка', async () => {
    const action = await chat('нужен терапевт по ДМС');
    const noPlan = await run(action);
    assert.equal(noPlan.status, 'needs');
    assert.deepEqual(noPlan.needs, ['dms_plan']);
    assert.deepEqual(noPlan.plans.map((plan) => plan.id), ['demo-basic', 'demo-standard', 'demo-premium']);
    const unknown = await run(action, { planId: 'sogaz-gold' });
    assert.equal(unknown.status, 'needs');
    assert.deepEqual(unknown.needs, ['dms_plan']);
  });

  it('14. Смена условий в диалоге: последняя реплика важнее, снятое условие снимается', async () => {
    const first = await chat('Нужен ЛОР завтра после 18:00 по ДМС');
    assert.equal(first.booking.request.dms.required, true);
    const changed = await chat(['Нужен ЛОР завтра после 18:00 по ДМС', 'а лучше послезавтра и без ДМС']);
    assert.deepEqual(changed.booking.request.date, { kind: 'after_tomorrow' });
    assert.equal(changed.booking.request.timeFrom, '18:00');
    assert.equal(changed.booking.request.dms.required, false);
    const result = await run(changed);
    assert.ok(allSlots(result).every((slot) => slot.day === AFTER_TOMORROW && slot.start >= '18:00'));
    const doctor = await chat(['Нужен ЛОР завтра после 18:00', 'нет, лучше к дерматологу']);
    assert.equal(doctor.booking.request.specialty, 'dermatologist');
    const timeAny = await chat(['Нужен ЛОР завтра после 18:00', 'в любое время']);
    assert.equal(timeAny.booking.request.timeFrom, null);
  });

  it('15. Модель недоступна — подбор работает на локальном плане с теми же условиями', async () => {
    const action = await chat('Нужен ЛОР завтра после 18:00, по моей программе ДМС, максимум 25 минут на машине', { respond: PLANNER_DOWN });
    const { request } = action.booking;
    assert.equal(request.specialty, 'lor');
    assert.deepEqual(request.date, { kind: 'tomorrow' });
    assert.equal(request.timeFrom, '18:00');
    assert.equal(request.dms.required, true);
    assert.equal(request.travel.maxMinutes, 25);
    assert.equal(request.travel.mode, 'driving');
  });

  it('Модель не может ослабить условия: план без ограничений не отменяет «завтра после 18:00 по ДМС»', async () => {
    const lax = { action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'lor', selection: 'any', constraints: {} }], constraints: {}, reply_hint: 'doctors_found' };
    const action = await chat('Нужен ЛОР завтра после 18:00 по ДМС', { respond: lax });
    assert.deepEqual(action.booking.request.date, { kind: 'tomorrow' });
    assert.equal(action.booking.request.timeFrom, '18:00');
    assert.equal(action.booking.request.dms.required, true);
  });

  it('16. Нет геолокации при ограничении по времени в пути — просьба указать точку', async () => {
    const result = await run(await chat('нужен терапевт, не дольше 20 минут на машине'), { origin: null });
    assert.equal(result.status, 'needs');
    assert.deepEqual(result.needs, ['origin']);
    const nearby = await run(await chat('терапевт рядом'), { origin: null });
    assert.equal(nearby.status, 'needs');
    assert.deepEqual(nearby.needs, ['origin']);
  });

  it('17. «Сегодня после 18:00» вечером — ни одного прошедшего слота', async () => {
    clock = moscowMoment(TODAY, '19:10');
    try {
      const action = await chat('терапевт сегодня после 18:00');
      const result = await run(action);
      for (const slot of result.status === 'ok' ? allSlots(result) : []) {
        assert.equal(slot.day, TODAY);
        assert.ok(slot.start >= '19:10', `прошедший слот ${slot.start}`);
        assert.equal(slot.past, false);
      }
      if (result.status === 'empty') assert.match(result.message, /Подходящих вариантов нет/);
    } finally {
      clock = NOW;
    }
  });

  it('18. Демо никогда не выдаётся за реальное', async () => {
    const action = await chat('Нужен ЛОР завтра после 18:00');
    assert.match(action.replyText, /демонстрационная/i);
    const result = await run(action);
    assert.equal(result.demo, true);
    for (const option of result.options) {
      assert.equal(option.demo, true);
      assert.match(option.clinic.name, /демо/i);
      assert.match(option.clinic.address, /демо-адрес/);
      assert.match(option.doctor.id, /^demo-doc-/);
    }
  });

  it('Город вне покрытия (Иннополис) — честно, без молчаливой подмены Казанью', async () => {
    const result = await run(await chat('нужен терапевт в Иннополисе'));
    assert.equal(result.status, 'out_of_coverage');
    assert.match(result.message, /Иннополис/);
    assert.equal(result.options, undefined);
    assert.deepEqual(result.relax.map((item) => item.key), ['city']);
  });

  it('Без профиля врача — вопрос о специальности, а не догадка', async () => {
    const action = await chat('хочу записаться к врачу завтра');
    assert.equal(action.booking.request.specialty, null);
    const result = await run(action);
    assert.equal(result.status, 'needs');
    assert.deepEqual(result.needs, ['specialty']);
  });

  it('Профиль по жалобе — без диагноза; маршрут из нескольких врачей — не запись', async () => {
    const ear = await chat('У меня болит ухо, хочу попасть к врачу завтра вечером, желательно рядом');
    assert.equal(ear.booking.request.specialty, 'lor');
    assert.equal(ear.booking.request.evening, true);
    assert.equal(ear.booking.request.travel.nearest, true);
    assert.match(ear.replyText, /не диагноз/);
    const multi = await chat('сначала к терапевту, потом к стоматологу');
    assert.equal(multi.booking, null);
  });
});

describe('Демо-сценарии: приватность', () => {
  it('условия записи (день, цена, город) не уходят во внешнюю модель', async () => {
    const plan = { action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'lor', selection: 'any', constraints: {} }], constraints: {}, reply_hint: 'doctors_found' };
    const { pipeline, sent } = makeTestPipeline({ catalog, respond: plan, outboundMode: 'structured', booking: { enabled: true, now: () => clock } });
    const { action } = await pipeline.handle({
      messages: [{ role: 'user', content: 'Нужен ЛОР послезавтра после 18:00 до 2500 ₽ в Иннополисе, болит ухо' }],
      sessionId: TEST_SESSION,
    });
    assert.equal(sent.length, 1);
    const outbound = sent[0].serialized + JSON.stringify(sent[0].hints);
    for (const leaked of ['2500', 'Иннополис', 'innopolis', 'after_tomorrow', 'послезавтра', 'maxPrice', 'болит', 'ухо']) {
      assert.ok(!outbound.includes(leaked), `во внешний запрос попало «${leaked}»`);
    }
    assert.equal(action.booking.request.maxPrice, 2500);
    assert.equal(action.booking.request.city, 'innopolis');
  });
});

describe('Демо-сценарии: время в пути по графу дорог', needsGraph, () => {
  it('5. «Не дольше 20 минут на машине» — у каждого варианта ≤ 20 мин по дорогам', async () => {
    const action = await chat('нужен терапевт, не дольше 20 минут на машине');
    assert.equal(action.booking.request.travel.maxMinutes, 20);
    const result = await run(action, { origin: CENTER });
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => option.travel && option.travel.minutes <= 20 && option.travel.mode === 'driving'));
    // Пешком за 5 минут — честное «нет» по этапу «время в пути».
    const foot = await run(await chat('нужен кардиолог, не дольше 5 минут пешком'), { origin: CENTER });
    assert.equal(foot.status, 'empty');
    assert.equal(foot.blocking.key, 'travel');
  });

  it('6. «Рядом» — сначала ближайшие по времени в пути', async () => {
    const result = await run(await chat('терапевт рядом'), { origin: CENTER });
    assert.equal(result.status, 'ok');
    const minutes = result.options.map((option) => option.travel.minutes);
    assert.deepEqual(minutes, [...minutes].sort((left, right) => left - right));
  });

  it('Главный пример: «ЛОР завтра после 18:00, по моей программе ДМС, максимум 25 минут на машине»', async () => {
    const action = await chat('Нужен ЛОР завтра после 18:00, по моей программе ДМС, максимум 25 минут на машине');
    const result = await run(action, { origin: CENTER, planId: 'demo-standard' });
    assert.equal(result.status, 'ok');
    for (const option of result.options) {
      assert.equal(option.doctor.specialtyKey, 'lor');
      assert.equal(option.coverage.status, 'covered');
      assert.ok(option.travel.minutes <= 25);
      assert.ok(option.slots.every((slot) => slot.day === TOMORROW && slot.start >= '18:00'));
    }
  });

  it('Точка вне графа — честно, без оценки по прямой', async () => {
    const moscow = { lat: 55.7558, lng: 37.6173 };
    const result = await run(await chat('терапевт рядом'), { origin: moscow });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'origin_off_network');
  });

  it('Граф недоступен — ограничение по времени не подменяется прямой', async () => {
    const result = await run(await chat('терапевт, не дольше 20 минут на машине'), { origin: CENTER, getEngine: async () => null });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'routing_unavailable');
    assert.equal(result.options, undefined);
  });
});

describe('Демо-сценарии: запись', needsSqlite, () => {
  it('8–11. Запись на 18:30 → BOOKED; повтор отклонён; гонка — одна запись; отмена освобождает', async () => {
    const result = await run(await chat('Нужен ЛОР завтра после 18:00'));
    const target = allSlots(result).find((slot) => slot.start === '18:30') || allSlots(result)[0];
    const booking = store.book({ slotId: target.id, idempotencyKey: KEY(1) });
    assert.equal(booking.status, 'CONFIRMED');
    assert.equal(store.getSlot(target.id).status, 'BOOKED');
    assert.equal(moscowParts(Date.parse(booking.slot.startAt)).time, target.start);

    // 9. Повторная запись на то же время — отказ.
    assert.throws(() => store.book({ slotId: target.id, idempotencyKey: KEY(2) }), (error) => error.code === 'slot_taken');
    // Занятое время больше не предлагается.
    const after = await run(await chat('Нужен ЛОР завтра после 18:00'));
    assert.ok(!allSlots(after).some((slot) => slot.id === target.id));

    // 10. Две попытки «одновременно» на свободный слот — проходит одна.
    const other = allSlots(after)[0];
    const outcomes = [KEY(3), KEY(4)].map((key) => {
      try {
        return store.book({ slotId: other.id, idempotencyKey: key }).status;
      } catch (error) {
        return error.code;
      }
    });
    assert.deepEqual(outcomes.sort(), ['CONFIRMED', 'slot_taken']);

    // 11. Отмена освобождает слот, и он снова в подборе.
    const cancelled = store.cancel({ number: booking.number, cancelToken: booking.cancelToken });
    assert.equal(cancelled.slotReleased, true);
    const again = await run(await chat('Нужен ЛОР завтра после 18:00'));
    assert.ok(allSlots(again).some((slot) => slot.id === target.id) || again.options.some((option) => option.doctor.id === target.doctorId));
    assert.equal(store.getSlot(target.id).status, 'FREE');
  });

  it('12. После перезапуска запись на месте (см. demo-booking.test.js: «переживает перезапуск»)', () => {
    // Сам перезапуск проверяется на файле базы в demo-booking.test.js; здесь —
    // что подбор и запись используют одно хранилище, а не память процесса.
    assert.equal(typeof store.close, 'function');
    assert.equal(store.kind, 'sqlite');
  });
});
