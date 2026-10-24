/*
 * © 2026 МедКарта Казань. Все права защищены.
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
  // Программа, названная в тексте («по программе Demo Premium»), важнее выбранной в интерфейсе — как в DemoOffers.
  const request = { ...action.booking.request, ...patch, origin, dms: { ...action.booking.request.dms, planId: action.booking.request.dms.planId || planId } };
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
    const basicClinics = new Set(['demo-beresta', 'demo-semya', 'demo-travma', 'demo-real-aibolit']);
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
      assert.match(option.doctor.id, /^demo-doc-/);
      if (option.clinic.real) {
        // Реальная клиника: адрес настоящий, телефона нет — запись туда не уходит.
        assert.equal(option.clinic.phone, null);
        assert.ok(index.branches.get(option.clinic.branchId).clinic.real);
      } else {
        assert.match(option.clinic.name, /демо/i);
        assert.match(option.clinic.address, /демо-адрес/);
      }
    }
  });

  it('Время суток и неделя: «утром», «после обеда», «на этой неделе» не теряются', async () => {
    const morning = await run(await chat('терапевт во вторник утром'));
    assert.equal(morning.request.timeTo, '12:00');
    assert.ok(allSlots(morning).length > 0 && allSlots(morning).every((slot) => slot.day === TOMORROW && slot.start < '12:00'));
    const afternoon = await run(await chat('невролог после обеда'));
    assert.ok(allSlots(afternoon).every((slot) => slot.start >= '13:00'));
    const week = await run(await chat('лор на этой неделе вечером'));
    assert.ok(allSlots(week).length > 0 && allSlots(week).every((slot) => slot.day >= TODAY && slot.day <= '2026-10-18' && slot.start >= '17:00'));
  });

  it('Процедура — запись именно на неё, а не на первичный приём', async () => {
    const action = await chat('нужен подбор очков');
    assert.equal(action.booking.request.specialty, 'ophthalmologist');
    assert.equal(action.booking.request.serviceId, 'proc.ophthalmologist.glasses');
    const result = await run(action);
    assert.equal(result.status, 'ok');
    for (const slot of allSlots(result)) {
      assert.equal(slot.serviceId, 'proc.ophthalmologist.glasses');
      assert.equal(slot.option.service.durationMinutes, 30);
    }
    // У терапевта ЭКГ нет — честное «эти врачи не оказывают», а не другой врач.
    const ecg = await run(await chat('ЭКГ у терапевта'));
    assert.equal(ecg.status, 'empty');
    assert.equal(ecg.blocking.key, 'service');
  });

  it('Город вне покрытия (Иннополис) — честно, без молчаливой подмены Казанью', async () => {
    const action = await chat('нужен терапевт в Иннополисе');
    assert.match(action.replyText, /Иннополис — вне покрытия/);
    assert.doesNotMatch(action.replyText, /подбор ниже/);
    const result = await run(action);
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

  it('новые условия (пол, стаж, программа, исключения, «на дом») тоже не уходят наружу', async () => {
    const plan = { action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'gynecologist', selection: 'any', constraints: {} }], constraints: {}, reply_hint: 'doctors_found' };
    const { pipeline, sent } = makeTestPipeline({ catalog, respond: plan, outboundMode: 'structured', booking: { enabled: true, now: () => clock } });
    const { action } = await pipeline.handle({
      messages: [{ role: 'user', content: 'Гинеколог-женщина со стажем больше 15 лет, не в Ясене, по программе Demo Premium, кроме понедельника, лучше на дом' }],
      sessionId: TEST_SESSION,
    });
    const outbound = sent[0].serialized + JSON.stringify(sent[0].hints);
    // Стаж как числовой фильтр (minExperience=15) планировщику передаётся — это не данные о человеке.
    for (const leaked of ['female', 'женщин', 'Premium', 'premium', '16', 'excludeWeekdays', 'понедельник', 'home_visit', 'на дом', 'demo-yasen', 'Ясен']) {
      assert.ok(!outbound.includes(leaked), `во внешний запрос попало «${leaked}»`);
    }
    const { request } = action.booking;
    assert.equal(request.doctorGender, 'female');
    assert.equal(request.minExperience, 16);
    assert.equal(request.dms.planId, 'demo-premium');
    assert.deepEqual(request.excludeWeekdays, [1]);
    assert.deepEqual(request.unsupported, ['home_visit']);
    assert.ok(request.excludeBranchIds.includes('demo-yasen-centr'));
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

describe('Демо-сценарии: сложные условия — без поблажек', needsSqlite, () => {
  const branchOf = (option) => index.branches.get(option.clinic.branchId);

  it('«во вторник или среду после 18:00» — оба дня, и только они', async () => {
    const action = await chat('нужен гинеколог во вторник или среду после 18:00');
    assert.deepEqual(action.booking.request.date, { kind: 'any_of', options: [{ kind: 'weekday', weekday: 2 }, { kind: 'weekday', weekday: 3 }] });
    assert.match(action.replyText, /во вторник или в среду/);
    const result = await run(action);
    assert.equal(result.status, 'ok');
    const slots = allSlots(result);
    assert.ok(slots.every((slot) => [TOMORROW, AFTER_TOMORROW].includes(slot.day) && slot.start >= '18:00'));
  });

  it('«в будни вечером» — ни субботы, ни воскресенья', async () => {
    const result = await run(await chat('терапевт в будни вечером'));
    assert.equal(result.status, 'ok');
    const days = allSlots(result).map((slot) => new Date(`${slot.day}T12:00:00Z`).getUTCDay());
    assert.ok(days.length > 0 && days.every((day) => day >= 1 && day <= 5));
  });

  it('район: «в Вахитовском районе» — только он; «не в Советском» — ни одного Советского и ни одного с неизвестным районом', async () => {
    const inside = await run(await chat('лор в Вахитовском районе'));
    assert.equal(inside.status, 'ok');
    assert.ok(inside.options.every((option) => branchOf(option).branch.district === 'Вахитовский'));
    const outside = await run(await chat('терапевт, только не в Советском районе'));
    assert.equal(outside.status, 'ok');
    assert.ok(outside.options.every((option) => branchOf(option).branch.district && branchOf(option).branch.district !== 'Советский'));
  });

  it('«врач-женщина», «с опытом больше 15 лет» — строго', async () => {
    const female = await run(await chat('нужен уролог, врач-женщина'));
    // Урологов-женщин может не быть: тогда честное «нет» с предложением, а не мужчина-уролог.
    if (female.status === 'ok') assert.ok(female.options.every((option) => option.doctor.gender === 'female'));
    else {
      assert.equal(female.status, 'empty');
      assert.equal(female.blocking.key, 'gender');
      assert.ok(female.relax.some((item) => item.key === 'gender'));
    }
    const senior = await run(await chat('невролог с опытом больше 15 лет'));
    assert.equal(senior.request.minExperience, 16);
    assert.equal(senior.status, 'ok');
    assert.ok(senior.options.every((option) => option.doctor.experienceYears >= 16));
  });

  it('ни одно условие по отдельности не помогает — предложение снять сразу оба, с названиями', async () => {
    const result = await run(await chat('нужен психиатр, только чтобы врач был мужчина и со стажем не менее 20 лет'));
    assert.equal(result.status, 'empty');
    assert.equal(result.options, undefined);
    const combined = result.relax.find((item) => item.key === 'combined');
    if (combined) {
      assert.match(combined.label, /пол/);
      assert.match(combined.label, /стаж/);
      assert.ok(combined.count > 0);
    } else {
      assert.ok(result.relax.length > 0, 'хотя бы одно предложение');
    }
  });

  it('выезд на дом, онлайн, отзывы — «не могу», а не молча обычный приём', async () => {
    for (const text of ['терапевт на дом завтра', 'онлайн-консультация невролога', 'лучший лор с хорошими отзывами']) {
      const action = await chat(text);
      assert.ok(action.booking.request.unsupported.length > 0, text);
      // Ответ не обещает «подбор ниже» по условию, которое не проверить.
      assert.match(action.replyText, /проверить не могу/);
      assert.doesNotMatch(action.replyText, /подбор ниже/);
      const result = await run(action);
      assert.equal(result.status, 'empty', text);
      assert.equal(result.blocking.key, 'unsupported');
      assert.equal(result.options, undefined);
      const relax = result.relax.find((item) => item.key === 'unsupported');
      assert.ok(relax && Number.isInteger(relax.count) && relax.count > 0, text);
      // Согласие — снять только это условие.
      const accepted = await run(action, { patch: relax.patch });
      assert.equal(accepted.status, 'ok', text);
    }
  });

  it('программа из текста: «по программе Demo Premium» — она, а не сохранённая в интерфейсе', async () => {
    const action = await chat('лор по программе Demo Premium');
    assert.equal(action.booking.request.dms.required, true);
    assert.equal(action.booking.request.dms.planId, 'demo-premium');
    const result = await run(action, { planId: 'demo-basic' });
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => option.coverage.planId === 'demo-premium' && option.coverage.status === 'covered'));
  });

  it('однофамильцы: «к Ефимовой» — Ефимова, «к Ефимову» — Ефимов (падеж после «к»); без предлога «Ефимову» — оба', async () => {
    const female = await chat('запишите к Ефимовой');
    assert.deepEqual(female.booking.request.doctorIds, ['demo-doc-efimova-mariya']);
    const result = await run(female);
    assert.ok(result.options.length > 0 && result.options.every((option) => option.doctor.id === 'demo-doc-efimova-mariya'));
    const male = await chat('запишите к Ефимову');
    assert.deepEqual(male.booking.request.doctorIds, ['demo-doc-efimov-timur']);
    // «Запишите Ефимову» — винительный падеж женской фамилии или дательный мужской: выбирать за пользователя нельзя.
    const both = await chat('запишите Ефимову на завтра');
    assert.deepEqual([...both.booking.request.doctorIds].sort(), ['demo-doc-efimov-timur', 'demo-doc-efimova-mariya']);
  });

  it('названная клиника: только её филиалы; нет нужного врача — честно и с предложением', async () => {
    const yasen = await run(await chat('лор в клинике Ясень'));
    assert.equal(yasen.status, 'ok');
    assert.ok(yasen.options.every((option) => option.clinic.id === 'demo-yasen'));
    const none = await run(await chat('дерматолог в Разумеде'));
    assert.equal(none.status, 'empty');
    assert.equal(none.blocking.key, 'clinic');
    assert.ok(none.relax.some((item) => item.key === 'clinic' && item.count > 0));
  });

  it('педиатр — детский приём, даже если ребёнок не упомянут', async () => {
    const action = await chat('нужен педиатр завтра');
    assert.equal(action.booking.request.patient, 'child');
  });

  it('«от дома» — точку не подменяет геолокация: сначала вопрос, после подтверждения — подбор', async () => {
    const action = await chat('лор не дальше 15 минут на машине от дома');
    assert.equal(action.booking.request.originHint, 'home');
    const asked = await run(action, { origin: CENTER });
    assert.equal(asked.status, 'needs');
    assert.deepEqual(asked.needs, ['origin_place']);
    if (HAS_REAL_GRAPH) {
      const confirmed = await run(action, { origin: CENTER, patch: { originConfirmed: true } });
      assert.ok(['ok', 'empty'].includes(confirmed.status));
      for (const option of confirmed.options || []) assert.ok(option.travel.minutes <= 15);
    }
  });
});

describe('Демо-сценарии: противоречия и чего в демо нет — вопрос, а не выбор за пользователя', needsSqlite, () => {
  it('«в субботу 16 октября» (это пятница) — спрашивает, какой день', async () => {
    const action = await chat('лор в субботу 16 октября');
    assert.match(action.replyText, /16\.10\.2026 \(вы указали субботу\)/);
    assert.match(action.replyText, /не совпадают/);
    const result = await run(action);
    assert.equal(result.status, 'needs');
    assert.deepEqual(result.needs, ['date_conflict']);
    assert.match(result.message, /пятница, а не суббота/);
    assert.deepEqual(result.relax.map((item) => item.key), ['date_exact', 'date_weekday']);
    assert.equal(result.options, undefined);
  });

  it('«31 ноября» — такой даты нет, соседний день не подставляется', async () => {
    const action = await chat('эндокринолог 31 ноября');
    assert.equal(action.booking.request.date.kind, 'invalid');
    const result = await run(action);
    assert.deepEqual(result.needs, ['date_invalid']);
  });

  it('«после 18 до 10 утра» — пустой промежуток, вопрос', async () => {
    const result = await run(await chat('терапевт завтра после 18 до 10 утра'));
    assert.deepEqual(result.needs, ['time_conflict']);
  });

  it('«бесплатно по ОМС» — в демо только частные клиники: «нет» и предложение платного приёма', async () => {
    const result = await run(await chat('педиатр рядом, сегодня или завтра, бесплатно по ОМС'), { origin: CENTER });
    assert.equal(result.status, 'empty');
    assert.equal(result.blocking.key, 'unsupported');
    assert.match(result.relax[0].label, /Платный приём/);
  });

  it('«в Ситидок или Разумед» — выбор клиники, а не маршрут через обе', async () => {
    const action = await chat('кардиолог в Ситидок или Разумед завтра');
    assert.ok(action.booking, action.replyText);
    const result = await run(action);
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => ['demo-real-citidoc', 'demo-real-razumed'].includes(option.clinic.id)));
    assert.ok(result.options.every((option) => option.slots.every((slot) => slot.day === TOMORROW)));
  });
});

describe('Демо-сценарии: тонкости языка — не наоборот и не мимо', needsSqlite, () => {
  it('«не раньше 17:00» — это после 17:00, а не до', async () => {
    const result = await run(await chat('гинеколог в четверг не раньше 17:00'));
    assert.equal(result.request.timeFrom, '17:00');
    assert.equal(result.request.timeTo, null);
    assert.ok(allSlots(result).every((slot) => slot.start >= '17:00'));
  });

  it('«к Ефимову Тимуру» — имя снимает неоднозначность фамилии; «но не Ефимов» — исключение', async () => {
    const named = await chat('запишите к Ефимову Тимуру в среду');
    assert.deepEqual(named.booking.request.doctorIds, ['demo-doc-efimov-timur']);
    const without = await chat('нужен лор, но не Ефимов');
    assert.deepEqual(without.booking.request.doctorIds, []);
    assert.deepEqual(without.booking.request.excludeDoctorIds, ['demo-doc-efimov-timur']);
    const result = await run(without);
    assert.ok(result.options.length > 0 && result.options.every((option) => option.doctor.id !== 'demo-doc-efimov-timur'));
  });

  it('«в Айболит на Максимова» — только этот филиал', async () => {
    const action = await chat('педиатр в Айболит на Максимова');
    assert.deepEqual(action.booking.request.branchIds, ['demo-real-aibolit-maksimova']);
  });

  it('«желательно женщина» — женщины первыми, мужчины не выброшены', async () => {
    const result = await run(await chat('гинеколог, желательно женщина'));
    assert.equal(result.request.preferGender, 'female');
    assert.equal(result.request.doctorGender, null);
    const genders = result.options.map((option) => option.doctor.gender);
    assert.deepEqual(genders, [...genders].sort((left, right) => Number(right === 'female') - Number(left === 'female')));
  });

  it('«на 17:30» — ровно это время; «кроме пятницы» — без пятниц', async () => {
    const exact = await run(await chat('терапевт завтра на 17:30'));
    assert.ok(['ok', 'empty'].includes(exact.status));
    assert.ok(allSlots(exact).every((slot) => slot.start === '17:30'));
    const noFriday = await run(await chat('терапевт кроме пятницы'));
    assert.ok(allSlots(noFriday).every((slot) => new Date(`${slot.day}T12:00:00Z`).getUTCDay() !== 5));
  });

  it('«после шести вечера» — с 18:00; «в 2 часа дня» — ровно 14:00; «через 2 дня» — 14.10', async () => {
    const evening = await chat('лор завтра после шести вечера');
    assert.equal(evening.booking.request.timeFrom, '18:00');
    const exact = await chat('терапевт в 2 часа дня');
    assert.equal(exact.booking.request.timeFrom, '14:00');
    assert.match(exact.replyText, /ровно в 14:00/);
    const later = await chat('лор через 2 дня');
    assert.deepEqual(later.booking.request.date, { kind: 'date', day: AFTER_TOMORROW });
  });

  it('«не в клинике Разумед» — подбор без неё, и карта не фильтрует по ней', async () => {
    const action = await chat('хочу к кардиологу не в клинике Разумед');
    assert.ok(action.booking.request.excludeBranchIds.every((id) => id.startsWith('demo-real-razumed')));
    assert.ok(action.booking.request.excludeBranchIds.length > 0);
    assert.equal(action.clinic, null);
    assert.equal(action.searchQuery, null);
    const result = await run(action);
    assert.ok(result.options.every((option) => option.clinic.id !== 'demo-real-razumed'));
  });

  it('«ЛОР не дальше 15 минут от дома» — без маршрута «ЛОР → дом» на карте', async () => {
    const action = await chat('лор не дальше 15 минут на машине от дома');
    assert.ok(action.booking);
    assert.equal(action.buildRoute, false);
    assert.deepEqual(action.targetStops, []);
  });

  it('«Построй маршрут до ближайшего терапевта на завтра после 18:00» — сначала свободное время, маршрут — к найденному', async () => {
    const action = await chat('Построй маршрут до ближайшего терапевта на завтра после 18:00');
    assert.ok(action.booking, action.replyText);
    assert.equal(action.booking.request.specialty, 'therapist');
    assert.equal(action.booking.request.timeFrom, '18:00');
    assert.equal(action.booking.request.travel.nearest, true);
    // Маршрут планировщика (к врачу, который завтра может не принимать) не строится — интерфейс проложит его к варианту.
    assert.equal(action.booking.route, true);
    assert.equal(action.buildRoute, false);
    assert.deepEqual(action.targetStops, []);
    assert.match(action.replyText, /Маршрут проложу к первому подходящему варианту/);
    // «Ближайший» считается по графу дорог; без графа проверяем само расписание.
    const result = await run(action, { patch: { travel: { ...action.booking.request.travel, nearest: false } } });
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => option.doctor.specialtyKey === 'therapist'));
    assert.ok(allSlots(result).every((slot) => slot.day === TOMORROW && slot.start >= '18:00'));

    // Без дня и часов — по-прежнему просто маршрут, а запрос записи без слова «маршрут» — без маршрута.
    const plain = await chat('Построй маршрут до ближайшего терапевта');
    assert.equal(plain.booking, null);
    assert.equal(plain.buildRoute, true);
    const booking = await chat('Запиши к ближайшему терапевту на завтра после 18:00');
    assert.equal(booking.booking.route, false);
  });

  it('«невролог или терапевт» — выбор профиля, а не маршрут через двоих', async () => {
    const action = await chat('нужен невролог или терапевт сегодня вечером');
    assert.ok(action.booking, action.replyText);
    assert.deepEqual([...action.booking.request.specialtyAny].sort(), ['neurologist', 'therapist']);
    assert.equal(action.buildRoute, false);
    const result = await run(action);
    assert.ok(result.options.every((option) => ['neurologist', 'therapist'].includes(option.doctor.specialtyKey)));
  });

  it('«Разумед не надо», «Кузляр не предлагай», «не в Айболите и не в Мать и дитя» — исключения, в т. ч. вместо маршрута', async () => {
    const after = await chat('мне надо к урологу, и в Разумед не надо');
    assert.ok(after.booking.request.excludeBranchIds.every((id) => id.startsWith('demo-real-razumed')) && after.booking.request.excludeBranchIds.length > 0);
    assert.deepEqual(after.booking.request.branchIds, []);
    const two = await chat('лор, но не в Айболите и не в Мать и дитя, в будни до обеда');
    assert.ok(two.booking, two.replyText);
    assert.equal(two.buildRoute, false);
    const result = await run(two);
    assert.ok(result.options.every((option) => !['demo-real-aibolit', 'demo-real-mamadeti'].includes(option.clinic.id)));
  });

  it('«на следующей неделе в понедельник или вторник» — дни следующей недели', async () => {
    const action = await chat('на следующей неделе в понедельник или вторник к лору');
    const result = await run(action);
    assert.ok(allSlots(result).every((slot) => ['2026-10-19', '2026-10-20'].includes(slot.day)), allSlots(result).map((slot) => slot.day).join());
  });

  it('доступная среда и парковка — только там, где они точно есть; у реальных клиник — не обещаем', async () => {
    const result = await run(await chat('лор, нужна клиника с пандусом и парковкой'));
    for (const option of result.options || []) {
      const { branch, clinic } = index.branches.get(option.clinic.branchId);
      assert.equal(branch.features.wheelchair, true);
      assert.equal(branch.features.parking, true);
      assert.ok(!clinic.real);
    }
  });

  it('диалог: «в любой день» снимает и «в будни», и «в субботу»', async () => {
    const action = await chat(['хирург', 'а можно в субботу?', 'тогда в будни после 18', 'в любой день, но до 2500']);
    const { request } = action.booking;
    assert.deepEqual(request.date, { kind: 'any' });
    assert.equal(request.workdays, false);
    assert.equal(request.weekend, false);
    assert.equal(request.timeFrom, '18:00');
    assert.equal(request.maxPrice, 2500);
  });
});

describe('Демо-сценарии: длинные реплики, самоисправления и согласие заранее', needsSqlite, () => {
  const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

  it('рассказ о себе («работаю в центре до 18:00, живу на Азино») — не район и не точка; ДМС с потолком для платного', async () => {
    const action = await chat('Привет! Короче, третий день заложен нос. Работаю в центре до 18:00, живу на Азино. Можно к ухогорлоносу на этой неделе, но не в пятницу, вечером, и чтобы по моей страховке Demo Standard, а если не входит — то не дороже 2000?');
    const { request } = action.booking;
    assert.equal(request.specialty, 'lor');
    assert.deepEqual(request.districts, []);
    assert.equal(request.originHint, null);
    assert.equal(request.travel.nearest, false);
    assert.equal(request.timeFrom, '18:00');
    assert.deepEqual(request.excludeWeekdays, [5]);
    assert.equal(request.dms.prefer, true);
    assert.equal(request.maxPrice, 2000);
    const result = await run(action);
    assert.equal(result.status, 'ok');
    for (const option of result.options) {
      // Покрытое программой — любой цены; платное — не дороже 2000.
      assert.ok(option.coverage.status === 'covered' || option.price <= 2000, `${option.doctor.name}: ${option.price}`);
      for (const slot of option.slots) {
        assert.ok(slot.start >= '18:00' && slot.day <= '2026-10-18' && weekdayOf(slot.day) !== 5, `${slot.day} ${slot.start}`);
      }
    }
  });

  it('«хочу к эндокринологу. не, к гинекологу… Ясень или Береста» — гинеколог в одной из двух клиник, без маршрута', async () => {
    const action = await chat('хочу к эндокринологу. не, к гинекологу. в среду или четверг. после 16. Ясень или Береста. ДМС не нужен');
    assert.ok(action.booking, action.replyText);
    assert.equal(action.buildRoute, false);
    const { request } = action.booking;
    assert.equal(request.specialty, 'gynecologist');
    assert.equal(request.timeFrom, '16:00');
    assert.ok(request.branchIds.some((id) => id.startsWith('demo-yasen')) && request.branchIds.some((id) => id.startsWith('demo-beresta')));
    const result = await run(action);
    for (const option of result.options || []) {
      assert.equal(option.doctor.specialtyKey, 'gynecologist');
      assert.ok(['demo-yasen', 'demo-beresta'].includes(option.clinic.id));
    }
  });

  it('«не раньше чем через час» — сегодня с 13:00 (сейчас 12:00), а не с текущей минуты', async () => {
    const action = await chat('к терапевту на сегодня, но не раньше чем через час');
    assert.equal(action.booking.request.timeFrom, '13:00');
    const result = await run(action);
    assert.ok(allSlots(result).length > 0 && allSlots(result).every((slot) => slot.day === TODAY && slot.start >= '13:00'));
  });

  it('«лор, гинеколог или уролог — кто угодно из них» — выбор одного из трёх профилей', async () => {
    const action = await chat('лор, гинеколог или уролог — кто угодно из них, завтра до обеда');
    assert.ok(action.booking, action.replyText);
    assert.deepEqual([...action.booking.request.specialtyAny].sort(), ['gynecologist', 'lor', 'urologist']);
    assert.equal(action.buildRoute, false);
  });

  it('возраст врача и анонимность — «не могу проверить», а не молчаливый подбор', async () => {
    const age = await run(await chat('Можно хирурга, которому больше 50 лет?'));
    assert.equal(age.status, 'empty');
    assert.equal(age.blocking.key, 'unsupported');
    assert.ok(age.relax[0].count > 0);
    const anonymous = await run(await chat('Нужен психиатр, анонимно, вечером'));
    assert.equal(anonymous.blocking.key, 'unsupported');
    // Возраст пациента — не о враче.
    const mother = await chat('кардиолог для мамы, ей 67 лет');
    assert.deepEqual(mother.booking.request.unsupported, []);
  });

  it('«Записаться в Кузляр к окулисту …» — запись, а не маршрут; пусто — сначала по два условия, а не «снять всё»', async () => {
    const action = await chat('Записаться в Кузляр к окулисту, ребёнку 10 лет, подбор очков, в пн или вт до 14:00, можно по ДМС Demo Standard');
    assert.ok(action.booking, action.replyText);
    assert.equal(action.buildRoute, false);
    const { request } = action.booking;
    assert.ok(request.branchIds.length > 0 && request.branchIds.every((id) => id.startsWith('demo-real-kuzlyar')));
    assert.equal(request.serviceId, 'proc.ophthalmologist.glasses');
    assert.equal(request.patient, 'child');
    const result = await run(action);
    if (result.status === 'empty' && result.relax.length > 0) {
      assert.ok(result.relax.every((item) => item.key !== 'combined' || /^Снять два условия/.test(item.label)), result.relax.map((item) => item.label).join(' | '));
    }
  });

  it('«дерматолог» → «нет, лучше косметолог»: честное «такого врача нет», дерматологи не подбираются молча', async () => {
    const action = await chat(['дерматолог', 'нет, лучше косметолог']);
    assert.ok(!action.booking);
    assert.match(action.replyText, /косметолог/);
    assert.match(action.replyText, /нет/);
    assert.equal(action.specialty, null);
    assert.equal(action.searchQuery, null);
    const manual = await chat('мануальный терапевт завтра');
    assert.ok(!manual.booking);
    assert.match(manual.replyText, /мануальный терапевт/);
    const both = await chat('косметолог или дерматолог завтра');
    assert.equal(both.booking.request.specialty, 'dermatologist');
    assert.match(both.replyText, /косметолог/);
  });

  it('«32 октября» — «такой даты нет», а не подбор на любой день', async () => {
    const result = await run(await chat('Записаться к лору 32 октября'));
    assert.equal(result.status, 'needs');
    assert.deepEqual(result.needs, ['date_invalid']);
  });

  it('«у кого стаж побольше» — опытные первыми, остальные условия в силе', async () => {
    const result = await run(await chat('эндокринолог, у кого стаж побольше, неважно где, в пределах 3 тысяч'));
    const years = result.options.map((option) => option.doctor.experienceYears);
    assert.deepEqual(years, [...years].sort((left, right) => right - left));
    assert.ok(result.options.every((option) => option.price <= 3000));
  });

  it('«по ОМС, а если нельзя — то платно» — согласие уже дано: платный подбор, и это видно в условиях', async () => {
    const action = await chat('ЛОР по ОМС бесплатно завтра, а если нельзя — то платно');
    assert.deepEqual(action.booking.request.unsupported, []);
    assert.deepEqual(action.booking.request.fallbacks, ['oms']);
    assert.ok(action.booking.summary.some((part) => /приёма по ОМС в демо нет/.test(part)));
    const result = await run(action);
    assert.equal(result.status, 'ok');
    assert.ok(allSlots(result).every((slot) => slot.day === TOMORROW));
    // Без согласия — по-прежнему вопрос.
    const asked = await run(await chat('ЛОР по ОМС бесплатно завтра'));
    assert.equal(asked.blocking.key, 'unsupported');
  });

  it('«в пятницу или следующий понедельник» — 16.10 и 19.10, а не сегодняшний понедельник', async () => {
    const result = await run(await chat('гастроэнтеролог на пятницу или следующий понедельник после 15:30'));
    assert.ok(allSlots(result).length > 0);
    assert.ok(allSlots(result).every((slot) => ['2026-10-16', '2026-10-19'].includes(slot.day)), allSlots(result).map((slot) => slot.day).join());
  });
});

describe('Демо-сценарии: окна времени, диапазоны дат, исключения и запасные варианты', needsSqlite, () => {
  const inWindows = (request, start) => request.timeWindows.some((item) => (!item.from || start >= item.from) && (!item.to || start < item.to));

  it('длинная реплика: «только не утром — я до 11 сплю», «не дороже трёх тысяч», «не дальше получаса»', async () => {
    const action = await chat('Добрый вечер! Мне бы к неврологу, спина совсем замучила. Желательно завтра или послезавтра, но только не утром — я до 11 сплю после ночной смены. Клиника любая, лишь бы не дороже трёх тысяч и не дальше получаса на машине.');
    const { request } = action.booking;
    assert.equal(request.timeFrom, '12:00');
    assert.equal(request.timeTo, null);
    assert.equal(request.maxPrice, 3000);
    assert.equal(request.travel.maxMinutes, 30);
    assert.equal(request.evening, false);
    // Время в пути проверяется в сценариях с графом дорог; здесь — день, часы и цена.
    const result = await run(action, { patch: { travel: { ...request.travel, maxMinutes: null } } });
    assert.ok(allSlots(result).length > 0);
    for (const slot of allSlots(result)) {
      assert.ok([TOMORROW, AFTER_TOMORROW].includes(slot.day) && slot.start >= '12:00', `${slot.day} ${slot.start}`);
      assert.ok(slot.option.price <= 3000);
    }
  });

  it('«к женщине, но если женщин нет — можно и к мужчине» — женщины первыми, а не «врач-мужчина»', async () => {
    const result = await run(await chat('Нужна запись к гинекологу на ближайшую субботу, с утра, к женщине, но если женщин нет — можно и к мужчине'));
    assert.equal(result.request.doctorGender, null);
    assert.equal(result.request.preferGender, 'female');
  });

  it('«с 10 до 12 или после 18» и «в 18:00 или в 19:00» — оба окна, а не одно', async () => {
    const result = await run(await chat('гинеколог в чт, пт или сб с 10 до 12 или после 18'));
    assert.equal(result.request.timeWindows.length, 2);
    assert.ok(allSlots(result).length > 0);
    assert.ok(allSlots(result).every((slot) => inWindows(result.request, slot.start)), allSlots(result).map((slot) => slot.start).join());
    assert.ok(result.applied.some((part) => part === 'с 10:00 до 12:00 или после 18:00'));
    const exact = await run(await chat('лор на завтра в 18:00 или в 19:00'));
    assert.ok(allSlots(exact).every((slot) => slot.day === TOMORROW && ['18:00', '19:00'].includes(slot.start)));
  });

  it('«только не завтра», «до 20 октября», «с 15 по 17 октября», «в ближайшие 3 дня» — даты, а не часы', async () => {
    const notTomorrow = await run(await chat('Уролог, но только не завтра'));
    assert.ok(allSlots(notTomorrow).length > 0 && allSlots(notTomorrow).every((slot) => slot.day !== TOMORROW));
    const until = await run(await chat('дерматолог до 20 октября'));
    assert.equal(until.request.timeTo, null);
    assert.ok(allSlots(until).every((slot) => slot.day <= '2026-10-19'));
    const range = await run(await chat('кардиолог с 15 по 17 октября'));
    assert.equal(range.request.timeFrom, null);
    assert.ok(allSlots(range).length > 0 && allSlots(range).every((slot) => slot.day >= '2026-10-15' && slot.day <= '2026-10-17'));
    const soon = await run(await chat('детский невролог, ребенку 2 года, в ближайшие 3 дня'));
    assert.ok(allSlots(soon).every((slot) => slot.day >= TODAY && slot.day <= AFTER_TOMORROW));
  });

  it('«в пятницу 16 октября, если нельзя — то в субботу 17-го» — оба дня; суббота не превращается в «только выходные»', async () => {
    const result = await run(await chat('хирург в пятницу 16 октября, если нельзя в пятницу, то в субботу 17-го'));
    assert.equal(result.request.weekend, false);
    assert.ok(allSlots(result).length > 0);
    assert.ok(allSlots(result).every((slot) => ['2026-10-16', '2026-10-17'].includes(slot.day)));
    assert.ok(allSlots(result).some((slot) => slot.day === '2026-10-16'));
  });

  it('«не в Айболит на Курской» — без одного филиала; «а в другой клинике?» — без прежней клиники', async () => {
    const street = await chat('Педиатр, но не в Айболит на Курской, после 16, в любой день этой недели');
    assert.deepEqual(street.booking.request.excludeBranchIds, ['demo-real-aibolit-kurskaya']);
    assert.deepEqual(street.booking.request.branchIds, []);
    assert.equal(street.booking.request.date.kind, 'this_week');
    const other = await chat(['невролог в Разумеде', 'а в другой клинике?']);
    assert.deepEqual(other.booking.request.branchIds, []);
    assert.ok(other.booking.request.excludeBranchIds.length > 0 && other.booking.request.excludeBranchIds.every((id) => id.startsWith('demo-real-razumed')));
    const result = await run(other);
    assert.ok(result.options.every((option) => option.clinic.id !== 'demo-real-razumed'));
  });

  it('«не старше 40 лет» о враче — «не могу проверить»; «по женским делам» — гинеколог; «на после завтра» — послезавтра', async () => {
    const age = await run(await chat('гастроэнтеролог, желательно мужчина, не старше 40 лет'));
    assert.equal(age.blocking.key, 'unsupported');
    const female = await chat('мне надо к врачу по женским делам в выходные');
    assert.equal(female.booking.request.specialty, 'gynecologist');
    const typo = await chat('запишите меня к лору на после завтра');
    assert.deepEqual(typo.booking.request.date, { kind: 'after_tomorrow' });
  });
});

describe('Демо-сценарии: своё время у каждого дня, запасной район, пожелания вместо условий', needsSqlite, () => {
  const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

  it('«в среду не можем, в четверг после 15:30, а в пятницу только до обеда» — у каждого дня своё окно', async () => {
    const action = await chat('Здрасьте. Ребёнку 9 лет нужен лор: в среду не можем — кружок, в четверг после 15:30, а в пятницу только до обеда. По ДМС Demo Premium, если не покрывает — до 3000.');
    const { request } = action.booking;
    assert.equal(request.patient, 'child');
    assert.equal(request.timeFrom, null);
    assert.equal(request.timeTo, null);
    assert.equal(request.dms.prefer, true);
    const result = await run(action);
    assert.ok(allSlots(result).length > 0);
    for (const slot of allSlots(result)) {
      const weekday = weekdayOf(slot.day);
      assert.ok((weekday === 4 && slot.start >= '15:30') || (weekday === 5 && slot.start < '12:00'), `${slot.day} ${slot.start}`);
    }
  });

  it('«в пт после 19 или в сб до 12», «сегодня, а если никого — завтра с утра, но не раньше девяти»', async () => {
    const result = await run(await chat('стоматолог в пт после 19 или в сб до 12'));
    for (const slot of allSlots(result)) {
      const weekday = weekdayOf(slot.day);
      assert.ok((weekday === 5 && slot.start >= '19:00') || (weekday === 6 && slot.start < '12:00'), `${slot.day} ${slot.start}`);
    }
    const fallback = await run(await chat('Дерматолог сегодня? Если сегодня никого — давайте завтра с утра, но не раньше девяти'));
    assert.ok(allSlots(fallback).length > 0);
    for (const slot of allSlots(fallback)) {
      assert.ok(slot.day === TODAY || (slot.day === TOMORROW && slot.start >= '09:00' && slot.start < '12:00'), `${slot.day} ${slot.start}`);
    }
    assert.ok(allSlots(fallback).some((slot) => slot.day === TODAY && slot.start >= '12:00'));
  });

  it('«в Советском, а если там никого — можно Приволжский» — оба района, Советский первым', async () => {
    const result = await run(await chat('гинеколог-женщина, не дороже 2000, в Советском районе, но если там нет никого — можно Приволжский'));
    assert.deepEqual(result.request.districts, ['Советский', 'Приволжский']);
    const districts = result.options.map((option) => option.clinic.district);
    assert.ok(districts.every((name) => ['Советский', 'Приволжский'].includes(name)));
    assert.deepEqual(districts, [...districts].sort((left, right) => Number(right === 'Советский') - Number(left === 'Советский')));
  });

  it('«лучше по ДМС», «готов заплатить» — пожелание; «не детский, а взрослый» — взрослый приём; двойня и справка — честное «нет»', async () => {
    const soft = await chat('нужен ЛОР, у меня Demo Basic, но если что я готов заплатить');
    assert.equal(soft.booking.request.dms.required, false);
    assert.equal(soft.booking.request.dms.prefer, true);
    const adult = await chat('нужен хирург, но не детский, а взрослый, в Айболите');
    assert.equal(adult.booking.request.patient, 'adult');
    const twins = await run(await chat('Педиатр для двойни 3 лет, нужно два слота подряд'));
    assert.equal(twins.blocking.key, 'unsupported');
    const certificate = await run(await chat('ортопед, нужна справка для бассейна, завтра'));
    assert.equal(certificate.blocking.key, 'unsupported');
  });
});

describe('Демо-сценарии: уточняющие вопросы и контекст диалога', needsSqlite, () => {
  it('«после 7» — вопрос «утра или вечера?» с двумя кнопками; ответ «вечера» в чате — после 19:00', async () => {
    const asked = await chat('терапевт после 7');
    assert.match(asked.replyText, /утра.*вечера/);
    const question = await run(asked);
    assert.equal(question.status, 'needs');
    assert.deepEqual(question.needs, ['time_choice']);
    assert.deepEqual(question.relax.map((item) => item.patch.timeFrom), ['07:00', '19:00']);
    const answered = await run(await chat(['терапевт после 7', 'вечера']));
    assert.equal(answered.request.timeFrom, '19:00');
    assert.ok(allSlots(answered).length > 0 && allSlots(answered).every((slot) => slot.start >= '19:00'));
    // Кнопка делает то же, что ответ.
    const pressed = await run(asked, { patch: question.relax[1].patch });
    assert.equal(pressed.status, 'ok');
  });

  it('«в следующую пятницу» (сегодня понедельник) — вопрос «ближайшую или через неделю?»; «ближайшую» — 16.10', async () => {
    const asked = await run(await chat('кардиолог в следующую пятницу'));
    assert.deepEqual(asked.needs, ['date_choice']);
    const nearest = await run(await chat(['кардиолог в следующую пятницу', 'ближайшую']));
    assert.ok(allSlots(nearest).length > 0 && allSlots(nearest).every((slot) => slot.day === '2026-10-16'));
    assert.equal(nearest.request.travel.nearest, false);
    const later = await run(await chat(['кардиолог в следующую пятницу', 'через неделю']));
    assert.ok(allSlots(later).every((slot) => slot.day === '2026-10-23'));
    // «Следующий понедельник» в понедельник — однозначно через неделю, вопроса нет.
    const monday = await run(await chat('кардиолог в следующий понедельник'));
    assert.notEqual(monday.status, 'needs');
  });

  it('контекст держится: длинный диалог дополняет запрос, а «давай заново» начинает новый', async () => {
    const dialog = ['Нужен ЛОР по ДМС Demo Standard', 'для дочки 6 лет', 'лучше на этой неделе', 'после 16', 'не в Советском районе', 'а женщина есть?', 'не дороже 3000', 'и не в Айболите'];
    const { request } = (await chat(dialog)).booking;
    assert.equal(request.specialty, 'lor');
    assert.equal(request.patient, 'child');
    assert.equal(request.dms.planId, 'demo-standard');
    assert.equal(request.date.kind, 'this_week');
    assert.equal(request.timeFrom, '16:00');
    assert.deepEqual(request.excludeDistricts, ['Советский']);
    assert.equal(request.doctorGender, 'female');
    assert.equal(request.maxPrice, 3000);
    assert.ok(request.excludeBranchIds.length > 0);
    const fresh = (await chat([...dialog, 'давай заново: кардиолог на завтра'])).booking.request;
    assert.equal(fresh.specialty, 'cardiologist');
    assert.equal(fresh.patient, 'adult');
    assert.equal(fresh.maxPrice, null);
    assert.equal(fresh.doctorGender, null);
    assert.deepEqual(fresh.excludeDistricts, []);
    assert.deepEqual(fresh.date, { kind: 'tomorrow' });
    assert.equal((await chat(['педиатр для сына в субботу', 'а теперь мне к терапевту'])).booking.request.patient, 'adult');
  });

  it('контекст: «а на Ленинградской?» — другой филиал; «а Ефимов?» — другой врач без прежнего профиля; «а просто консультация?» — без процедуры', async () => {
    const street = await chat(['лор', 'в Разумед на Пушкина', 'а на Ленинградской?']);
    assert.deepEqual(street.booking.request.branchIds, ['demo-real-razumed-leningradskaya']);
    const doctor = await chat(['невролог Ефимова', 'а Ефимов?']);
    assert.deepEqual(doctor.booking.request.doctorIds, ['demo-doc-efimov-timur']);
    assert.equal(doctor.booking.request.specialty, null);
    assert.equal((await run(doctor)).status, 'ok');
    const plain = await chat(['дерматолог, дерматоскопия', 'а просто консультация?']);
    assert.equal(plain.booking.request.specialty, 'dermatologist');
    assert.equal(plain.booking.request.serviceId, null);
    const weekend = await run(await chat(['хочу записаться к неврологу', 'вот только я работаю до 19', 'и в выходные тоже можно']));
    assert.ok(allSlots(weekend).length > 0);
    for (const slot of allSlots(weekend)) {
      const weekday = new Date(`${slot.day}T12:00:00Z`).getUTCDay() || 7;
      assert.ok(weekday >= 6 || slot.start >= '19:00', `${slot.day} ${slot.start}`);
    }
  });

  it('модель ответила поиском клиник («а в любой клинике?») — это всё равно запись к названному врачу', async () => {
    const clinics = { action: 'FIND_CLINIC', steps: [{ type: 'specialty', specialty: 'neurologist', selection: 'any', constraints: {} }], constraints: {}, reply_hint: 'doctors_found' };
    const action = await chat(['невролог в Разумеде', 'а в Ситидок?', 'а в любой клинике?'], { respond: clinics });
    assert.ok(action.booking, action.replyText);
    assert.equal(action.booking.request.specialty, 'neurologist');
    assert.deepEqual(action.booking.request.branchIds, []);
  });

  it('модель переспросила, хотя профиль назван словами, — запись; профиль только из жалобы — её вопрос остаётся', async () => {
    const clarify = { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' };
    const named = await chat(['невролог в Разумеде', 'а в любой клинике?'], { respond: clarify });
    assert.ok(named.booking, named.replyText);
    assert.equal(named.booking.request.specialty, 'neurologist');
    // «Голова и живот» — два профиля поровну: вопрос «к кому записаться?», а не выбор за пользователя.
    const vague = await chat('у меня что-то болит голова и живот, хочу на завтра', { respond: clarify });
    assert.match(vague.replyText, /К кому записаться/);
    assert.equal(vague.booking.request.specialty, null);
    assert.deepEqual(vague.booking.request.date, { kind: 'tomorrow' });
    const answered = await chat(['у меня что-то болит голова и живот, хочу на завтра', 'к неврологу']);
    assert.equal(answered.booking.request.specialty, 'neurologist');
    assert.deepEqual(answered.booking.request.date, { kind: 'tomorrow' });
  });

  it('однофамильцы — показываю обоих и спрашиваю; «спасибо» — не новый поиск; «запиши к первому» — объясняю, как записаться', async () => {
    const namesakes = await chat('хочу к Ефимова');
    if (namesakes.booking?.request.doctorIds.length > 1) assert.match(namesakes.replyText, /нескольких врачей с такой фамилией/);
    const thanks = await chat(['кардиолог завтра', 'спасибо']);
    assert.match(thanks.replyText, /^Пожалуйста!/);
    assert.equal(thanks.booking.request.specialty, 'cardiologist');
    const pick = await chat(['кардиолог завтра', 'запиши меня к первому']);
    assert.match(pick.replyText, /нажмите «Записаться»/);
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
