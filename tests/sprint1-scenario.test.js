/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сценарий «найти врача сейчас»: «У ребёнка болит ухо, после 18:00,
 * максимум 20 минут от дома». Проверяется цепочка, которую строит сервер:
 * детский профиль, время приёма и потолок времени в пути доходят до
 * интерфейса, а опасные симптомы уводят к 103/112 вместо списка врачей.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildCatalog } from '../backend/privacy/catalog.js';
import { extractConstraints, extractMaxTravelMinutes } from '../backend/privacy/gateway.js';
import { classifySymptoms } from '../backend/privacy/symptoms.js';
import { validatePlan } from '../backend/planner/validator.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { PLANNER_ERROR } from '../backend/planner/client.js';
import { FIXTURE_CLINICS, FIXTURE_DOCTORS } from './fixtures/catalog.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const EVENING = { mon: '08:00-20:00', tue: '08:00-20:00', wed: '08:00-20:00', thu: '08:00-20:00', fri: '08:00-20:00', sat: 'Выходной', sun: 'Выходной' };

const catalogWithLor = () =>
  buildCatalog({
    doctors: [
      ...FIXTURE_DOCTORS,
      {
        id: 'fx-doc-ivanova-lor-child',
        name: 'Иванова Мария Петровна',
        specialty: 'Детский ЛОР',
        clinic: 'Клиника «Тестовая» на Гагарина',
        district: 'Советский',
        ownership: 'Государственная',
        lat: 55.8,
        lng: 49.13,
        schedule: EVENING,
        services: ['Детский ЛОР'],
        features: {},
      },
      {
        id: 'fx-doc-orlov-lor-adult',
        name: 'Орлов Игорь Семёнович',
        specialty: 'ЛОР',
        clinic: 'Клиника «Тестовая» на Гагарина',
        district: 'Советский',
        ownership: 'Государственная',
        rating: 5,
        experience: 30,
        lat: 55.8,
        lng: 49.13,
        schedule: EVENING,
        services: ['ЛОР'],
        features: {},
      },
    ],
    clinics: FIXTURE_CLINICS,
  });

const TARGET_QUERY = 'У ребёнка болит ухо, можем сегодня после 18:00, максимум 20 минут от дома';

describe('Потолок времени в пути из текста', () => {
  it('извлекается и не путается с часами приёма', () => {
    assert.deepEqual(extractConstraints(TARGET_QUERY), { availableAfter: '18:00', maxTravelMinutes: 20 });
    assert.deepEqual(extractConstraints('терапевт до 30 минут езды'), { maxTravelMinutes: 30 });
    // «до 20» без минут — по-прежнему время работы.
    assert.deepEqual(extractConstraints('приём до 20'), { availableBefore: '20:00' });
  });

  it('распознаёт разговорные формы и игнорирует «через 20 минут»', () => {
    assert.equal(extractMaxTravelMinutes('в пределах получаса'), 30);
    assert.equal(extractMaxTravelMinutes('не дольше 15 мин пешком'), 15);
    assert.equal(extractMaxTravelMinutes('в пределах часа'), 60);
    assert.equal(extractMaxTravelMinutes('20 минут от работы'), 20);
    assert.equal(extractMaxTravelMinutes('запишите через 20 минут'), null);
    assert.equal(extractMaxTravelMinutes('максимум 500 минут'), null);
  });

  it('валидатор принимает только целые минуты от 5 до 120', () => {
    const plan = (value) => ({ action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'lor', selection: 'nearest' }], constraints: { max_travel_minutes: value }, reply_hint: 'doctors_found' });
    assert.equal(validatePlan(JSON.stringify(plan(20)), { allowedTokens: [] }).ok, true);
    for (const bad of [0, 4, 121, 20.5, '20']) {
      assert.equal(validatePlan(JSON.stringify(plan(bad)), { allowedTokens: [] }).ok, false, `пропущено ${bad}`);
    }
  });

  it('контракт интерфейса пропускает только допустимое значение', () => {
    assert.equal(sanitizeAiAction({ maxTravelMinutes: 20 }).maxTravelMinutes, 20);
    assert.equal(sanitizeAiAction({ maxTravelMinutes: 0 }).maxTravelMinutes, null);
    assert.equal(sanitizeAiAction({ maxTravelMinutes: '20' }).maxTravelMinutes, null);
    assert.equal(sanitizeAiAction({}).maxTravelMinutes, null);
  });
});

describe('Детский приём по профилю', () => {
  it('«Детский ЛОР» получает признак детского приёма в каталоге', () => {
    const catalog = catalogWithLor();
    const child = catalog.doctors.find((doctor) => doctor.id === 'fx-doc-ivanova-lor-child');
    const adult = catalog.doctors.find((doctor) => doctor.id === 'fx-doc-orlov-lor-adult');
    assert.equal(child.features.children, true);
    assert.equal(adult.features.children, false);
  });
});

describe('Целевой запрос через конвейер', () => {
  const externalPlan = {
    action: 'FIND_DOCTOR',
    steps: [{ type: 'specialty', specialty: 'lor', selection: 'nearest' }],
    constraints: { children: true, available_after: '18:00', max_travel_minutes: 20 },
    reply_hint: 'doctors_found',
  };

  it('внешний план: детский ЛОР, потолок 20 минут, выдача не сужена до одной фамилии', async () => {
    const { pipeline } = makeTestPipeline({ catalog: catalogWithLor(), respond: externalPlan });
    const { action } = await pipeline.handle({ messages: [{ role: 'user', content: TARGET_QUERY }], sessionId: TEST_SESSION });

    assert.equal(action.maxTravelMinutes, 20);
    assert.equal(action.isChild, true);
    assert.equal(action.specialty, 'Детский ЛОР', 'выбран взрослый ЛОР вместо детского');
    assert.equal(action.searchQuery, null, 'выдача сужена до одного врача, и фильтр по времени мог её обнулить');
    assert.match(action.replyText, /не дольше 20 мин/);
    assert.doesNotMatch(action.replyText, /Иванова|Орлов/);
  });

  it('локальный план (модель недоступна) сохраняет те же ограничения', async () => {
    const { pipeline } = makeTestPipeline({
      catalog: catalogWithLor(),
      respond: Object.assign(new Error('upstream down'), { code: PLANNER_ERROR.UPSTREAM }),
    });
    const { action } = await pipeline.handle({ messages: [{ role: 'user', content: TARGET_QUERY }], sessionId: TEST_SESSION });

    assert.equal(action.maxTravelMinutes, 20);
    assert.equal(action.isChild, true);
    // «от дома» — точка отсчёта, а не цель: раньше план сводился к поиску учреждений.
    assert.equal(action.specialty, 'Детский ЛОР');
    assert.doesNotMatch(action.replyText, /учреждений не нашлось/);
  });

  it('названный врач остаётся в выдаче по фамилии даже с потолком времени', async () => {
    const { pipeline } = makeTestPipeline({
      catalog: catalogWithLor(),
      respond: (request) => ({
        action: 'FIND_DOCTOR',
        steps: [{ type: 'specific_doctor', token: request.placeholders.find((item) => item.kind === 'DOCTOR')?.token }],
        constraints: { max_travel_minutes: 15 },
        reply_hint: 'doctors_found',
      }),
    });
    const { action } = await pipeline.handle({
      messages: [{ role: 'user', content: 'к Петровой, не дольше 15 минут от дома' }],
      sessionId: TEST_SESSION,
    });
    assert.equal(action.maxTravelMinutes, 15);
    assert.match(action.searchQuery || '', /Петрова/);
  });
});

describe('Красные флаги', () => {
  const urgent = [
    'У грудничка температура 38,5',
    'Температура 40 не сбивается у сына',
    'Ребёнок ударился головой, его рвёт',
    'Сыпь не исчезает при надавливании',
    'Сильная боль в животе справа',
    'Сын проглотил батарейку',
    'Отекли губы и опух язык',
    'Ребёнок не просыпается',
  ];
  const ordinary = [
    TARGET_QUERY,
    'болит живот',
    'температура 37,5 и насморк',
    'Ребёнок ударился головой, шишка',
    'нужен педиатр для грудничка',
  ];

  it('опасные состояния распознаются', () => {
    for (const text of urgent) {
      assert.ok(classifySymptoms(text).emergency, `не распознано: ${text}`);
    }
  });

  it('обычные жалобы не пугают звонком в 103', () => {
    for (const text of ordinary) {
      assert.equal(classifySymptoms(text).emergency, null, `ложная тревога: ${text}`);
    }
  });

  it('конвейер отвечает про 103/112 и не меняет фильтры', async () => {
    const { pipeline, sent } = makeTestPipeline({ catalog: catalogWithLor() });
    const { action } = await pipeline.handle({ messages: [{ role: 'user', content: 'У грудничка температура 39' }], sessionId: TEST_SESSION });
    assert.match(action.replyText, /103/);
    assert.equal(action.buildRoute, false);
    assert.equal(action.maxTravelMinutes, null);
    assert.equal(sent.length, 0, 'при красном флаге запрос не должен уходить к модели');
  });
});
