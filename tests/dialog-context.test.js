/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Уточняющие вопросы и контекст диалога. Реплики ассистента сервер не
 * учитывает, поэтому короткий ответ («вечера», «первое», «я дома») понимается
 * только по прежним репликам пользователя — и одинаково при любом ответе модели.
 *
 * Время заморожено: понедельник 12.10.2026, 12:00 МСК.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { createDemoSearch } from '../backend/demo/search.js';
import { moscowMoment } from '../backend/demo/time.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { PLANNER_ERROR } from '../backend/planner/client.js';
import { normalizeSearchRequest } from '../shared/demoSearch.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const DOWN = Object.assign(new Error('upstream down'), { code: PLANNER_ERROR.UPSTREAM });
const step = (key) => ({ type: 'specialty', specialty: key, selection: 'nearest' });
const clarify = (hint = 'need_clarification') => ({ action: 'CLARIFY', steps: [], constraints: {}, reply_hint: hint });
const tokenOf = (request, prefix) => request.placeholders.map((item) => item.token).find((token) => token.startsWith(prefix));

/* Как могла бы ответить внешняя модель на описание запроса. */
const MODELS = {
  'модель недоступна': () => DOWN,
  'модель переспрашивает': () => clarify(),
  'модель: вне темы': () => clarify('out_of_scope'),
  'модель ищет врача': (request) => {
    const doctor = tokenOf(request, '@DOCTOR');
    if (doctor) return { action: 'FIND_DOCTOR', steps: [{ type: 'specific_doctor', token: doctor, selection: 'nearest' }], constraints: {}, reply_hint: 'doctors_found' };
    const keys = request.hints.specialties || [];
    return keys.length ? { action: 'FIND_DOCTOR', steps: [step(keys[0])], constraints: {}, reply_hint: 'doctors_found' } : clarify();
  },
  // Буквальная модель: несколько профилей в описании — маршрут через все.
  'модель строит маршрут по профилям': (request) => {
    const keys = request.hints.specialties || [];
    return keys.length > 1 ? { action: 'BUILD_ROUTE', steps: keys.slice(0, 3).map(step), constraints: {}, reply_hint: 'route_built' }
      : keys.length ? { action: 'FIND_DOCTOR', steps: [step(keys[0])], constraints: {}, reply_hint: 'doctors_found' } : clarify();
  },
  'модель ищет клинику': (request) => {
    const clinic = tokenOf(request, '@CLINIC');
    return { action: 'FIND_CLINIC', steps: clinic ? [{ type: 'specific_clinic', token: clinic, selection: 'any' }] : [], constraints: {}, reply_hint: 'clinics_found' };
  },
  'модель строит маршрут «врач → дом»': (request) => {
    const keys = request.hints.specialties || [];
    return keys.length ? { action: 'BUILD_ROUTE', steps: [step(keys[0]), { type: 'location', token: '@HOME' }], constraints: {}, reply_hint: 'route_built' } : clarify();
  },
  'модель отвечает мусором': () => '{"action":"DROP_TABLE"}',
};

let catalog;
let index;
let store;
let search;

before(async () => {
  process.env.DEMO_DATA = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
  catalog = await loadCatalog();
  index = await getDemoCatalog();
  if (DatabaseSync) {
    store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
    search = createDemoSearch({ index, store, getEngine: async () => null, now: () => NOW });
  }
});

after(() => {
  store?.close();
  __resetCatalogCache();
});

const needsSqlite = { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' };

/** Ответ ассистента на реплики пользователя — после той же нормализации, что в браузере. */
const chat = async (turns, respond = MODELS['модель недоступна'], { outboundMode } = {}) => {
  const { pipeline, sent } = makeTestPipeline({ catalog, respond, outboundMode, booking: { enabled: true, now: () => NOW } });
  const messages = (Array.isArray(turns) ? turns : [turns]).map((content) => ({ role: 'user', content }));
  const { action } = await pipeline.handle({ messages, sessionId: TEST_SESSION });
  return { action: sanitizeAiAction(JSON.parse(JSON.stringify(action))), sent };
};
const requestOf = async (turns, respond) => (await chat(turns, respond)).action.booking?.request || null;

/* Только то, что задаёт подбор: сравнение запросов без служебных полей. */
const essence = (request) => (request ? {
  specialty: request.specialty,
  specialtyAny: request.specialtyAny,
  doctorIds: request.doctorIds,
  patient: request.patient,
  date: request.date,
  timeFrom: request.timeFrom,
  timeTo: request.timeTo,
  timeChoice: request.timeChoice,
  timeWindows: request.timeWindows,
  evening: request.evening,
  maxPrice: request.maxPrice,
  dms: request.dms,
  doctorGender: request.doctorGender,
  minExperience: request.minExperience,
  districts: request.districts,
  branchIds: request.branchIds,
  excludeBranchIds: request.excludeBranchIds,
  unsupported: request.unsupported,
  fallbacks: request.fallbacks,
  originHint: request.originHint,
  originConfirmed: request.originConfirmed,
  travel: request.travel,
} : null);

/*
 * Ответы на уточняющие вопросы. [реплики, ожидаемые поля запроса].
 * «Сейчас» — понедельник 12.10, «завтра» — вторник 13.10.
 */
const ANSWERS = [
  // «Утра или вечера?»
  [['Нужен ЛОР завтра после 7', 'вечера'], { timeFrom: '19:00', timeTo: null }],
  [['Нужен ЛОР завтра после 7', 'утра'], { timeFrom: '07:00' }],
  [['Нужен ЛОР завтра после 7', 'вечера, и чтобы женщина'], { timeFrom: '19:00', doctorGender: 'female', evening: false }],
  [['Нужен ЛОР завтра после 7', 'вечера. И чтобы врач женщина'], { timeFrom: '19:00', doctorGender: 'female' }],
  [['Нужен ЛОР завтра после 7', 'вечера, до 3000'], { timeFrom: '19:00', maxPrice: 3000 }],
  [['Нужен ЛОР завтра после 7', 'не утра, а вечера'], { timeFrom: '19:00' }],
  [['Нужен ЛОР завтра после 7', 'не утра'], { timeFrom: '19:00' }],
  [['Нужен ЛОР завтра после 7', 'вечернее'], { timeFrom: '19:00' }],
  [['Нужен ЛОР завтра после 7', 'утреннее'], { timeFrom: '07:00' }],
  [['Нужен ЛОР завтра после 7', '19'], { timeFrom: '19:00', timeTo: null }],
  [['Нужен ЛОР завтра после 7', 'в 19'], { timeFrom: '19:00', timeTo: null }],
  [['Нужен ЛОР завтра после 7', '19:00'], { timeFrom: '19:00', timeTo: null }],
  [['Нужен ЛОР завтра после 7', 'первое'], { timeFrom: '07:00' }],
  [['Нужен ЛОР завтра после 7', 'второе'], { timeFrom: '19:00' }],
  [['Нужен ЛОР завтра после 7', 'неважно'], { timeFrom: null, timeTo: null, timeChoice: [] }],
  [['Нужен ЛОР завтра после 7', 'без разницы'], { timeFrom: null, timeTo: null, timeChoice: [] }],
  [['Нужен ЛОР завтра после 7', 'а в пятницу вечером?'], { timeFrom: '19:00', date: { kind: 'weekday', weekday: 5 } }],
  [['Нужен ЛОР завтра после 7', 'а можно женщину?', 'вечера'], { timeFrom: '19:00', doctorGender: 'female' }],
  [['Нужен ЛОР завтра после 7', 'вечера', 'а в пятницу?'], { timeFrom: '19:00', date: { kind: 'weekday', weekday: 5 } }],
  [['кардиолог в 8'], { timeChoice: [{ from: '08:00', to: '08:01' }, { from: '20:00', to: '20:01' }] }],
  [['кардиолог в 8', 'утра'], { timeFrom: '08:00', timeTo: '08:01', timeChoice: [] }],
  [['кардиолог к 9', 'вечера'], { timeFrom: '21:00', timeTo: '21:01' }],
  [['кардиолог с 7 до 9', 'вечера'], { timeFrom: '19:00', timeTo: '21:00' }],
  // «Ближайшую или через неделю?»
  [['невролог в следующую пятницу', 'ближайшую'], { date: { kind: 'weekday', weekday: 5, week: 'this' } }],
  [['невролог в следующую пятницу', 'через неделю'], { date: { kind: 'weekday', weekday: 5, week: 'next' } }],
  [['невролог в следующую пятницу', 'не эту, а следующую'], { date: { kind: 'weekday', weekday: 5, week: 'next' } }],
  [['невролог в следующую пятницу', 'первое'], { date: { kind: 'weekday', weekday: 5, week: 'this' } }],
  [['невролог в следующую пятницу', 'ближайшую, и после 18'], { date: { kind: 'weekday', weekday: 5, week: 'this' }, timeFrom: '18:00', travel: { maxMinutes: null, mode: 'driving', nearest: false } }],
  [['невролог в следующую пятницу', 'через неделю, после 18'], { date: { kind: 'weekday', weekday: 5, week: 'next' }, timeFrom: '18:00' }],
  [['невролог в следующую пятницу', 'любую'], { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 5, week: 'this' }, { kind: 'weekday', weekday: 5, week: 'next' }] } }],
  [['невролог в следующую пятницу после 7', 'ближайшую вечером'], { date: { kind: 'weekday', weekday: 5, week: 'this' }, timeFrom: '19:00' }],
  // «В понедельник», сказанное в понедельник: сегодня или через неделю?
  [['ЛОР в понедельник'], { date: { kind: 'weekday', weekday: 1, week: 'next', askWeek: true } }],
  [['ЛОР в понедельник', 'сегодня'], { date: { kind: 'today' } }],
  [['ЛОР в понедельник', 'через неделю'], { date: { kind: 'weekday', weekday: 1, week: 'next' } }],
  // Точка отправления, названная словами.
  [['кардиолог поближе к дому', 'да'], { originHint: 'home', originConfirmed: true }],
  [['кардиолог поближе к дому', 'я дома'], { originHint: 'home', originConfirmed: true }],
  [['кардиолог поближе к дому', 'да, я дома'], { originHint: 'home', originConfirmed: true }],
  [['кардиолог не дальше 20 минут от работы', 'я на работе'], { originHint: 'work', originConfirmed: true }],
  [['кардиолог поближе к дому', 'расстояние не важно'], { originHint: null, travel: { maxMinutes: null, mode: 'driving', nearest: false } }],
  // Программа ДМС.
  [['кардиолог по ДМС', 'премиум'], { dms: { required: true, planId: 'demo-premium', prefer: false } }],
  [['кардиолог по ДМС', 'стандарт, и завтра'], { dms: { required: true, planId: 'demo-standard', prefer: false }, date: { kind: 'tomorrow' } }],
  [['кардиолог по ДМС', 'стандартная программа'], { dms: { required: true, planId: 'demo-standard', prefer: false } }],
  // Условие, которого в демо нет: «да» — согласие на то, что есть.
  [['кардиолог на дом', 'да'], { unsupported: [], fallbacks: ['home_visit'] }],
  [['кардиолог на дом', 'ок'], { unsupported: [], fallbacks: ['home_visit'] }],
  [['кардиолог на дом', 'согласен'], { unsupported: [], fallbacks: ['home_visit'] }],
  [['кардиолог с хорошими отзывами', 'да'], { unsupported: [], fallbacks: ['rating'] }],
  [['кардиолог по ОМС', 'давайте'], { unsupported: [], fallbacks: ['oms'] }],
  // «К кому записаться?» — профиль, о котором спросили.
  [['болит голова и живот', 'первый'], { specialty: 'gastroenterologist' }],
  [['болит голова и живот', 'к первому'], { specialty: 'gastroenterologist' }],
  [['болит голова и живот', 'второго'], { specialty: 'neurologist' }],
  [['болит голова и живот', 'к неврологу'], { specialty: 'neurologist' }],
  [['болит голова и живот', 'не знаю, кого посоветуете?'], { specialty: 'therapist' }],
  [['болит голова и живот', 'не знаю', 'а завтра после 18?'], { specialty: 'therapist', date: { kind: 'tomorrow' }, timeFrom: '18:00' }],
  [['запишите на завтра после 18', 'к лору'], { specialty: 'lor', date: { kind: 'tomorrow' }, timeFrom: '18:00' }],
  // Однофамильцы: уточнение именем, профилем или полом.
  [['к Ефимова', 'Тимуру'], { doctorIds: ['demo-doc-efimov-timur'] }],
  [['к Ефимова', 'Марии'], { doctorIds: ['demo-doc-efimova-mariya'] }],
  [['к Ефимова', 'к лору'], { doctorIds: ['demo-doc-efimov-timur'], specialty: 'lor' }],
  [['к Ефимова', 'женщине'], { doctorIds: ['demo-doc-efimova-mariya'], doctorGender: 'female' }],
];

describe('Ответы на уточняющие вопросы понимаются по прежним репликам', () => {
  for (const [turns, expected] of ANSWERS) {
    it(turns.map((text) => `«${text}»`).join(' → '), async () => {
      const request = await requestOf(turns);
      assert.ok(request, 'нет запроса подбора');
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(request[key], value, key);
    });
  }
});

/* Диалоги, где модель могла бы ответить по-разному. */
const INVARIANT_DIALOGS = [
  ...ANSWERS.map(([turns]) => turns),
  ['Нужен ЛОР завтра после 18:00'],
  ['ЛОР', 'завтра', 'после 18', 'до 3000', 'женщина'],
  ['болит голова и живот', 'к неврологу'],
  ['болит голова и живот'],
  ['педиатр для сына', 'а теперь мне к терапевту'],
  ['у ребёнка болит ухо', 'завтра утром'],
  ['горло болит третий день', 'а есть кто-то после 18?'],
  ['дерматолог в Разумеде', 'а в любой клинике?'],
  ['в Айболит на Максимова к лору'],
  ['кардиолог в Ситидок или Разумед'],
  ['терапевт, только не в Айболите'],
  ['невролог или терапевт завтра'],
  ['подбор очков'],
  ['ЭКГ завтра'],
  ['ЛОР не дальше 15 минут от дома'],
  ['записаться в Кузляр к окулисту на пятницу'],
  ['гинеколог по ДМС Demo Standard в Вахитовском районе со стажем от 10 лет'],
  ['уролог на этой неделе', 'тогда в четверг'],
  ['ЛОР завтра после 18', 'нет, не после 18, а до 12'],
  ['ЛОР завтра после 18', 'и ещё мне нужен кардиолог'],
];

describe('Условия записи не зависят от ответа модели', () => {
  it(`${INVARIANT_DIALOGS.length} диалогов × ${Object.keys(MODELS).length} поведений модели — один и тот же запрос подбора`, async () => {
    for (const turns of INVARIANT_DIALOGS) {
      const label = turns.map((text) => `«${text}»`).join(' → ');
      const reference = essence(await requestOf(turns));
      for (const [name, respond] of Object.entries(MODELS)) {
        assert.deepEqual(essence(await requestOf(turns, respond)), reference, `${label}: ${name}`);
      }
    }
  });

  it('буквальная модель не превращает выбор профиля в маршрут через все профили диалога', async () => {
    const literal = MODELS['модель строит маршрут по профилям'];
    for (const turns of [['болит голова и живот', 'к неврологу'], ['педиатр для сына', 'а теперь мне к терапевту'], ['ЛОР завтра', 'а лучше дерматолог']]) {
      const { action } = await chat(turns, literal);
      assert.ok(action.booking, turns.join(' → '));
      assert.notEqual(action.buildRoute, true, turns.join(' → '));
    }
  });

  it('маршрут, о котором просили, остаётся маршрутом — в том числе из нескольких реплик', async () => {
    for (const respond of [MODELS['модель недоступна'], MODELS['модель строит маршрут по профилям']]) {
      for (const turns of [['сначала к терапевту', 'а потом к стоматологу'], ['маршрут к терапевту', 'и ещё к стоматологу'], ['ЛОР и кардиолог']]) {
        const { action } = await chat(turns, respond);
        assert.ok(!action.booking, turns.join(' → '));
        assert.equal(action.buildRoute, true, turns.join(' → '));
        assert.ok(action.targetStops.length >= 2, turns.join(' → '));
      }
    }
    const { action } = await chat(['маршрут к терапевту', 'и ещё к стоматологу', 'а потом домой']);
    assert.deepEqual(action.targetStops.map((stop) => stop.specialty || stop.kind).slice(0, 2), ['Терапевт', 'Стоматолог']);
  });
});

describe('Модель видит текущее состояние разговора, а не сумму реплик', () => {
  // Описание вместо текста — режим по умолчанию (structured); в hybrid модель видит и сами реплики.
  const seen = async (turns) => (await chat(turns, MODELS['модель переспрашивает'], { outboundMode: 'structured' })).sent[0];

  it('сменённый профиль и пациент: «педиатр для сына» → «а теперь мне к терапевту»', async () => {
    const request = await seen(['педиатр для сына', 'а теперь мне к терапевту']);
    assert.deepEqual(request.hints.specialties, ['therapist']);
    assert.equal(request.hints.isChild, false);
    assert.doesNotMatch(request.serialized, /pediatrician|Приём детский/);
  });

  it('выбор после вопроса «к кому?»: только выбранный профиль', async () => {
    const request = await seen(['болит голова и живот', 'к неврологу']);
    assert.deepEqual(request.hints.specialties, ['neurologist']);
  });

  it('уточнение без нового профиля сохраняет прежний: «горло болит» → «а после 18?»', async () => {
    const request = await seen(['горло болит третий день', 'а есть кто-то после 18?']);
    assert.ok(request.hints.specialties.includes('lor'));
    assert.match(request.serialized, /availableAfter=18:00/);
  });

  it('маршрут из нескольких реплик: порядок остановок виден модели', async () => {
    const request = await seen(['маршрут к терапевту', 'и ещё к стоматологу', 'а потом домой']);
    assert.match(request.serialized, /therapist, затем dentist, затем @HOME/);
  });

  it('локальный план не помечает взрослый приём детским после «а теперь мне»', async () => {
    const { action } = await chat(['педиатр для сына', 'а теперь мне к терапевту']);
    assert.notEqual(action.isChild, true);
    assert.equal(action.booking.request.patient, 'adult');
  });
});

describe('Контекст: сброс, вопросы не по теме, длинный диалог', () => {
  it('«забудь», «заново» — новый запрос без прежних условий', async () => {
    for (const reset of ['забудь', 'заново', 'давай заново', 'новый запрос']) {
      const request = await requestOf(['ЛОР завтра после 18 до 3000', reset, 'кардиолог']);
      assert.equal(request.specialty, 'cardiologist', reset);
      assert.deepEqual(request.date, { kind: 'any' }, reset);
      assert.equal(request.timeFrom, null, reset);
      assert.equal(request.maxPrice, null, reset);
    }
  });

  it('вопрос не по теме не меняет условий и получает честный ответ', async () => {
    const { action } = await chat(['ЛОР завтра после 18', 'какая погода в субботу?']);
    assert.deepEqual(action.booking.request.date, { kind: 'tomorrow' });
    assert.match(action.replyText, /С этим не подскажу/);
    assert.match(action.replyText, /Прежний запрос помню: ЛОР, завтра, после 18:00/);
    const next = await requestOf(['ЛОР завтра после 18', 'какая погода в субботу?', 'а в пятницу?']);
    assert.deepEqual(next.date, { kind: 'weekday', weekday: 5 });
    assert.equal(next.timeFrom, '18:00');
    const alone = await chat('расскажи анекдот');
    assert.ok(!alone.action.booking);
    assert.match(alone.action.replyText, /С этим не подскажу/);
    // Жалоба с «кино» — не вопрос не по теме.
    assert.equal((await requestOf('после кино заболела голова')).specialty, 'neurologist');
  });

  it('вопросы о найденном — ответ про подбор, а не повтор «ищу»', async () => {
    assert.match((await chat(['ЛОР завтра после 18', 'а сколько стоит приём?'])).action.replyText, /^Цена приёма указана/);
    assert.match((await chat(['ЛОР завтра после 18', 'а где это?'])).action.replyText, /^Адрес — в карточке/);
    assert.match((await chat(['ЛОР завтра после 18', 'как записаться?'])).action.replyText, /^Выберите время/);
    assert.match((await chat('хочу к врачу')).action.replyText, /^К какому врачу записать\?/);
  });

  it('«ок» после вопроса — согласие, после подбора — прощание', async () => {
    assert.match((await chat(['кардиолог на дом', 'ок'])).action.replyText, /^Ищу свободное время/);
    assert.match((await chat(['ЛОР завтра', 'ок'])).action.replyText, /^Хорошо\./);
  });

  it('«и ещё мне нужен кардиолог»: новый подбор, прежний — в прошлом ответе', async () => {
    const { action } = await chat(['ЛОР завтра после 18', 'и ещё мне нужен кардиолог']);
    assert.equal(action.booking.request.specialty, 'cardiologist');
    assert.match(action.replyText, /Подбор к врачу «ЛОР» остался в прошлом ответе/);
  });

  it('двадцать реплик — условия первой не забыты', async () => {
    const turns = ['Нужен ЛОР', 'завтра', 'после 18', 'до 3000', 'чтобы женщина', 'стаж от 10 лет', 'а можно в Вахитовском районе', 'хотя район не важен',
      'а лучше послезавтра', 'спасибо', 'а сколько стоит?', 'какая погода?', 'ок', 'и без ограничения по цене', 'хорошо', 'понятно', 'а где это?', 'ясно', 'спасибо', 'а после 19?'];
    assert.equal(turns.length, 20);
    const request = await requestOf(turns);
    assert.equal(request.specialty, 'lor');
    assert.deepEqual(request.date, { kind: 'after_tomorrow' });
    assert.equal(request.timeFrom, '19:00');
    assert.equal(request.doctorGender, 'female');
    assert.equal(request.minExperience, 10);
    assert.equal(request.maxPrice, null);
    assert.deepEqual(request.districts, []);
  });
});

describe('«К другому врачу»', () => {
  it('после названного врача — тот же профиль без него, без переспроса «какой специалист?»', async () => {
    const { action } = await chat(['Болит горло, нужен ЛОР сегодня после 18:00', 'Хочу к Зариповой', 'А можно к другому врачу?']);
    const request = action.booking?.request;
    assert.ok(request, action.replyText);
    assert.equal(request.specialty, 'lor');
    assert.deepEqual(request.doctorIds, []);
    assert.ok(request.excludeDoctorIds.includes('demo-doc-zaripova-irina'));
    assert.doesNotMatch(action.replyText, /какой специалист нужен/u);
  });

  it('после списка, где врача не называли, — спрашивает, кого исключить, а не повторяет список молча', async () => {
    const { action } = await chat(['Нужен терапевт завтра утром', 'А можно к другому врачу?']);
    assert.equal(action.booking?.request.specialty, 'therapist');
    assert.match(action.replyText, /К какому врачу не записывать/u);
    const next = await chat(['Нужен терапевт завтра утром', 'А можно к другому врачу?', 'а в четверг?']);
    assert.doesNotMatch(next.action.replyText, /К какому врачу не записывать/u, 'вопрос — только на ту реплику');
  });
});

describe('«Покажи три наиболее подходящих варианта»', () => {
  it('после подбора — показываем три, прежние условия на месте, ответ говорит, сколько и в каком порядке', async () => {
    const { action } = await chat(['Болит горло, нужен ЛОР сегодня после 18:00', 'Покажи три наиболее подходящих варианта']);
    const request = action.booking?.request;
    assert.ok(request, action.replyText);
    assert.equal(request.limit, 3);
    assert.equal(request.specialty, 'lor');
    assert.equal(request.timeFrom, '18:00');
    assert.match(action.replyText, /Покажу не больше трёх вариантов/u);
    const next = await chat(['Болит горло, нужен ЛОР сегодня после 18:00', 'Покажи три наиболее подходящих варианта', 'а после 19?']);
    assert.equal(next.action.booking.request.limit, 3);
    assert.doesNotMatch(next.action.replyText, /Покажу не больше/u, 'о числе — только в ответ на саму просьбу');
    assert.doesNotMatch(action.replyText, /Записать вас сам по тексту/u, '«три первых» — не выбор варианта');
  });

  it('число держится в разговоре, «покажи все» возвращает обычный подбор; больше пяти — честно говорим', async () => {
    assert.equal((await requestOf(['Нужен терапевт завтра утром', 'топ-3', 'А можно к другому врачу?'])).limit, 3);
    const all = await requestOf(['Нужен терапевт завтра утром', 'топ-3', 'покажи все варианты']);
    assert.equal(all.limit, 5);
    const many = await chat(['Нужен терапевт завтра утром', 'покажи 10 вариантов']);
    assert.equal(many.action.booking.request.limit, 5);
    assert.match(many.action.replyText, /Больше 5 вариантов за раз не показываю/u);
  });

  it('«нужны два врача» — не просьба показать два варианта', async () => {
    const request = await requestOf(['Нужны два врача: лор и терапевт, завтра']);
    assert.notEqual(request?.limit, 2);
  });
});

describe('Кнопка под подбором — та же реплика, что и словами', needsSqlite, () => {
  /*
   * Для каждой кнопки подбора: фраза say, отправленная в чат следующей
   * репликой, даёт тот же результат подбора, что и patch кнопки. Так выбор
   * кнопкой остаётся в истории диалога, и следующая реплика его не теряет.
   */
  const DIALOGS = [
    ['Нужен ЛОР завтра после 7'],
    ['кардиолог в 8'],
    ['невролог в следующую пятницу'],
    ['ЛОР в понедельник'],
    ['кардиолог на дом'],
    ['кардиолог с хорошими отзывами'],
    ['ЛОР на 31 ноября'],
    ['дерматолог в субботу 16 октября'],
    ['ЛОР после 18 до 10 утра'],
    ['дерматолог не дороже 900 рублей'],
    ['нужен кардиолог сегодня после 20:45'],
    ['психиатр-мужчина со стажем от 30 лет'],
    ['ЛОР в Иннополисе'],
    ['кардиолог поближе к дому'],
    ['гинеколог-мужчина в Советском районе завтра до 9 утра'],
    ['детский невролог по ДМС Demo Basic в субботу'],
    ['уролог-женщина со стажем от 25 лет до 1500 рублей'],
    ['офтальмолог в Кузляр в воскресенье'],
    ['ЛОР с доступной средой и парковкой в Авиастроительном районе'],
  ];
  const signature = (result) => ({
    status: result.status,
    needs: result.needs || null,
    options: (result.options || []).map((option) => option.id),
    relax: (result.relax || []).map((item) => item.key),
  });

  it(`${DIALOGS.length} диалогов: каждая кнопка (say) ≡ её patch`, async () => {
    let checked = 0;
    for (const turns of DIALOGS) {
      const request = await requestOf(turns);
      assert.ok(request, turns.join(' → '));
      const result = await search.search(request);
      for (const item of result.relax || []) {
        const label = `${turns.join(' → ')} → кнопка «${item.label}»`;
        assert.ok(item.say, `${label}: нет фразы для чата`);
        const patched = { ...request, ...item.patch };
        if (item.patch.travel) patched.travel = { ...request.travel, ...item.patch.travel };
        if (item.patch.dms) patched.dms = { ...request.dms, ...item.patch.dms };
        const byButton = await search.search(normalizeSearchRequest(patched).request);
        const said = await requestOf([...turns, item.say]);
        assert.ok(said, `${label}: после «${item.say}» нет подбора`);
        assert.deepEqual(signature(await search.search(said)), signature(byButton), `${label}: «${item.say}»`);
        checked += 1;
      }
    }
    assert.ok(checked >= 25, `проверено кнопок: ${checked}`);
  });

  it('выбор кнопкой переживает следующую реплику', async () => {
    const request = await requestOf(['Нужен ЛОР завтра после 7', 'вечера', 'а можно женщину?']);
    assert.equal(request.timeFrom, '19:00');
    assert.deepEqual(request.timeChoice, []);
    assert.equal(request.doctorGender, 'female');
    const relaxed = await requestOf(['дерматолог не дороже 900 рублей', 'цена не важна', 'а завтра?']);
    assert.equal(relaxed.maxPrice, null);
    assert.deepEqual(relaxed.date, { kind: 'tomorrow' });
  });
});

describe('Часы, которые раньше терялись молча', () => {
  const CASES = [
    ['ЛОР после 18 часов', { timeFrom: '18:00', timeTo: null }],
    ['ЛОР до 12 часов', { timeFrom: null, timeTo: '12:00' }],
    ['ЛОР в 19 часов', { timeFrom: '19:00', timeTo: '19:01' }],
    ['ЛОР около 18', { timeFrom: '17:30', timeTo: '18:31' }],
    ['ЛОР с 10 до 12 часов', { timeFrom: '10:00', timeTo: '12:00' }],
    ['ЛОР в 15', { timeFrom: '15:00', timeTo: '15:01' }],
    ['ЛОР в 3', { timeFrom: '15:00', timeTo: '15:01' }],
    ['ЛОР в 10 в пятницу', { timeFrom: '10:00', date: { kind: 'weekday', weekday: 5 } }],
    ['ЛОР не после 18', { timeFrom: null, timeTo: '18:00' }],
    ['ЛОР не до 12, а после 15', { timeFrom: '15:00', timeTo: null }],
    ['лор завтро после 18', { date: { kind: 'tomorrow' }, timeFrom: '18:00' }],
    ['лор седня', { date: { kind: 'today' } }],
    // Не время.
    ['ЛОР до 2 часов езды', { timeFrom: null, timeTo: null }],
    ['ЛОР в 15 октября', { timeFrom: null, date: { kind: 'date', day: '2026-10-15' } }],
    ['ЛОР в 2 клиники', { timeFrom: null, timeTo: null }],
  ];
  for (const [text, expected] of CASES) {
    it(`«${text}»`, async () => {
      const request = await requestOf(text);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(request[key], value, key);
    });
  }

  it('«нет, не после 18, а до 12» следующей репликой — исправление, а не «с 18 до 12»', async () => {
    const request = await requestOf(['ЛОР завтра после 18', 'нет, не после 18, а до 12']);
    assert.equal(request.timeFrom, null);
    assert.equal(request.timeTo, '12:00');
  });
});

/* Генеративная проверка: вопрос × форма ответа × лишнее условие в той же реплике. */
describe('Генеративная проверка ответов на уточнения', () => {
  const QUESTIONS = [
    { ask: 'ЛОР завтра после 7', answers: [['вечера', { timeFrom: '19:00' }], ['утра', { timeFrom: '07:00' }], ['давайте вечера', { timeFrom: '19:00' }], ['второе', { timeFrom: '19:00' }], ['19', { timeFrom: '19:00' }]] },
    { ask: 'кардиолог до 9', answers: [['утра', { timeTo: '09:00' }], ['вечера', { timeTo: '21:00' }], ['первое', { timeTo: '09:00' }], ['21', { timeTo: '21:00' }]] },
    { ask: 'невролог в следующую пятницу', answers: [['ближайшую', { date: { kind: 'weekday', weekday: 5, week: 'this' } }], ['через неделю', { date: { kind: 'weekday', weekday: 5, week: 'next' } }], ['эту', { date: { kind: 'weekday', weekday: 5, week: 'this' } }], ['второе', { date: { kind: 'weekday', weekday: 5, week: 'next' } }]] },
    { ask: 'терапевт по ДМС', answers: [['премиум', { dms: { required: true, planId: 'demo-premium', prefer: false } }], ['у меня стандарт', { dms: { required: true, planId: 'demo-standard', prefer: false } }], ['базовая программа', { dms: { required: true, planId: 'demo-basic', prefer: false } }]] },
  ];
  const EXTRAS = [
    ['', {}], [', и чтобы женщина', { doctorGender: 'female' }], [', до 3000', { maxPrice: 3000 }], [', стаж от 10 лет', { minExperience: 10 }],
    ['. И в Вахитовском районе', { districts: ['Вахитовский'] }], [', без ДМС', null],
  ];

  it(`${QUESTIONS.reduce((sum, item) => sum + item.answers.length, 0) * EXTRAS.length} сочетаний`, async () => {
    for (const { ask, answers } of QUESTIONS) {
      for (const [answer, expected] of answers) {
        for (const [extra, extraExpected] of EXTRAS) {
          if (extraExpected === null && expected.dms) continue;
          const turns = [ask, `${answer}${extra}`];
          const request = await requestOf(turns);
          const label = turns.map((text) => `«${text}»`).join(' → ');
          assert.ok(request, label);
          for (const [key, value] of Object.entries({ ...expected, ...(extraExpected || {}) })) assert.deepEqual(request[key], value, `${label}: ${key}`);
          assert.deepEqual(request.timeChoice, [], `${label}: вопрос о времени остался`);
          assert.notEqual(request.date.askWeek, true, `${label}: вопрос о неделе остался`);
        }
      }
    }
  });
});

/*
 * Сверхсложные запросы одной репликой и длинные диалоги: каждое условие
 * понято, ничего не додумано, ответ не зависит от модели.
 */
describe('Сверхсложные запросы', () => {
  const HARD = [
    ['Здравствуйте! Нужен детский лор для сына 6 лет, у него третий день болит ухо и температура 37.5. Можно в четверг после 16:00 или в пятницу до обеда, но только не в Айболите на Курской. По ДМС Demo Standard, если не входит — то платно, но не дороже 2500. И чтобы ехать не дольше 20 минут от дома, я сейчас дома.', {
      specialty: 'lor', patient: 'child', maxPrice: 2500, excludeBranchIds: ['demo-real-aibolit-kurskaya'], originHint: 'home', originConfirmed: true,
      date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 4, from: '16:00', to: null }, { kind: 'weekday', weekday: 5, from: null, to: '12:00' }] },
      dms: { required: false, planId: 'demo-standard', prefer: true },
    }],
    // «Рядом парковка» — не «врач поближе»; «если такого нет — любой» — согласие без отзывов и возраста.
    ['Запишите маму к кардиологу, ей 70 лет, она плохо ходит — нужен пандус или лифт, и чтобы рядом была парковка. Удобно послезавтра с 10 до 13 или в субботу утром. Врач не моложе 50 лет и с хорошими отзывами, но если такого нет — то любой с большим стажем.', {
      specialty: 'cardiologist', patient: 'adult', wheelchair: true, parking: true, preferExperience: true, unsupported: [], fallbacks: ['rating', 'doctor_age'],
      travel: { maxMinutes: null, mode: 'driving', nearest: false },
      date: { kind: 'any_of', options: [{ kind: 'after_tomorrow', from: '10:00', to: '13:00' }, { kind: 'weekday', weekday: 6, from: null, to: '12:00' }] },
    }],
    ['мне бы к лору... или к неврологу... не знаю, голова кружится и в ушах шумит, давно уже. Можно ближе к вечеру в будни', { specialty: null, specialtyAny: ['lor', 'neurologist'], workdays: true, evening: true }],
    ['к Ефимовой или Валееву, в любой день кроме выходных, после 16, но не позже 19', { doctorIds: ['demo-doc-efimova-mariya', 'demo-doc-valeev-vadim'], timeFrom: '16:00', timeTo: '19:00', workdays: true }],
    ['запишите меня и мужа к терапевту на одно время в пятницу', { specialty: 'therapist', unsupported: ['multi_patient'] }],
    ['мне нужно к врачу, который лечит щитовидку, в четверг или пятницу после обеда', { specialty: 'endocrinologist', timeFrom: '13:00' }],
    ['дерматолог-женщина или мужчина — неважно, но стаж минимум 20 лет, и чтобы не в Советском районе, на этой неделе, после 18, до 3500', { doctorGender: null, minExperience: 20, excludeDistricts: ['Советский'], timeFrom: '18:00', maxPrice: 3500 }],
    // Часы работы, а не часы приёма: прийти можно в остальное время.
    ['Здравствуйте, я работаю посменно: в понедельник и среду до 15, во вторник и четверг после 14, пятница свободна весь день. Нужен хирург на этой неделе, и не дороже 2500.', {
      specialty: 'surgeon', maxPrice: 2500,
      date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 1, from: '15:00', to: null }, { kind: 'weekday', weekday: 3, from: '15:00', to: null }, { kind: 'weekday', weekday: 2, from: null, to: '14:00' }, { kind: 'weekday', weekday: 4, from: null, to: '14:00' }] },
    }],
    // «Желательно до 12» — пожелание, а не условие.
    ['Посоветуйте невролога для дочки 14 лет, в Разумед или в Кузляр, в выходные, желательно до 12, по ДМС премиум', { patient: 'child', timeTo: null, preferWindow: { from: null, to: '12:00' } }],
    ['ЛОР на 1 января 2030', { date: { kind: 'date', day: '2030-01-01' } }],
    ['ЛОР вчера', { date: { kind: 'past' } }],
    ['ЛОР через 3 недели', { date: { kind: 'date', day: '2026-11-02' } }],
    // «Завтра после 7» — двусмысленно только для завтра: вопрос о нём, четверг — как сказано.
    ['детский лор, завтра после 7 или в четверг до обеда', { timeChoice: [{ from: '07:00', to: null }, { from: '19:00', to: null }], date: { kind: 'any_of', options: [{ kind: 'tomorrow' }, { kind: 'weekday', weekday: 4, from: null, to: '12:00' }] } }],
    ['лор с 10 до 12 или после 7', { timeChoice: [{ from: '07:00', to: null }, { from: '19:00', to: null }] }],
  ];
  for (const [text, expected] of HARD) {
    it(`«${text.slice(0, 70)}${text.length > 70 ? '…' : ''}»`, async () => {
      const request = await requestOf(text);
      assert.ok(request, 'нет подбора');
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(request[key], value, key);
      for (const respond of Object.values(MODELS)) assert.deepEqual(essence(await requestOf(text, respond)), essence(request));
    });
  }

  it('ответ о времени одного дня меняет только этот день', async () => {
    const request = await requestOf(['детский лор, завтра после 7 или в четверг до обеда', 'вечера']);
    assert.deepEqual(request.date.options, [{ kind: 'tomorrow', from: '19:00', to: null }, { kind: 'weekday', weekday: 4, from: null, to: '12:00' }]);
    assert.deepEqual(request.timeChoice, []);
    const windows = await requestOf(['лор с 10 до 12 или после 7', 'вечера']);
    assert.deepEqual(windows.timeWindows, [{ from: '10:00', to: '12:00' }, { from: '19:00', to: null }]);
  });

  it('ответы честно говорят о прошедшем дне и о расписании дальше двух недель', async () => {
    assert.match((await chat('ЛОР вчера')).action.replyText, /уже прошёл/);
    assert.match((await chat('ЛОР через 3 недели')).action.replyText, /на две недели вперёд/);
    assert.match((await chat('Need ENT doctor tomorrow after 6pm')).action.replyText, /на русском языке/);
    assert.equal((await search.search(await requestOf('ЛОР вчера'))).status, 'needs');
  });
});

describe('Сложные диалоги: контекст через 10+ реплик', () => {
  it('исправления, уточнения, вопрос о цене, «всё же завтра, остальное оставьте»', async () => {
    const turns = ['нужен стоматолог завтра', 'ой нет, не стоматолог, а лор, и не завтра, а в четверг', 'после 7', 'вечера', 'и чтобы мужчина, стаж от 10',
      'а если в четверг нет, можно в пятницу', 'по ДМС', 'стандарт', 'и не в Айболите', 'спасибо, а сколько стоит?', 'ладно, давайте всё же завтра, но всё остальное оставьте'];
    const request = await requestOf(turns.slice(0, 6));
    assert.deepEqual(request.date, { kind: 'any_of', options: [{ kind: 'weekday', weekday: 4 }, { kind: 'weekday', weekday: 5 }] });
    const final = await requestOf(turns);
    assert.equal(final.specialty, 'lor');
    assert.deepEqual(final.date, { kind: 'tomorrow' });
    // «Не завтра» из второй реплики снято: завтра названо снова.
    assert.deepEqual(final.excludeDates, []);
    assert.equal(final.timeFrom, '19:00');
    assert.equal(final.doctorGender, 'male');
    assert.equal(final.minExperience, 10);
    assert.deepEqual(final.dms, { required: true, planId: 'demo-standard', prefer: false });
    assert.deepEqual(final.excludeBranchIds, ['demo-real-aibolit-maksimova', 'demo-real-aibolit-kurskaya']);
  });

  it('неделя, дни и исключения: «на следующей неделе» → «в пн или вт» → «кроме понедельника»', async () => {
    const request = await requestOf(['запишите на следующей неделе', 'к лору', 'в понедельник или вторник', 'кроме понедельника']);
    assert.deepEqual(request.date, { kind: 'weekday', weekday: 2, week: 'next' });
  });

  it('районы через «или» добавляются; прежний подбор — по профилю записи, а не по вариантам жалобы', async () => {
    assert.deepEqual((await requestOf(['терапевт в Советском районе', 'а в Приволжском?', 'или в Вахитовском'])).districts, ['Приволжский', 'Вахитовский']);
    const { action } = await chat(['у дочки 5 лет болит ухо', 'а мне заодно к терапевту, тоже завтра']);
    assert.match(action.replyText, /Подбор к врачу «ЛОР» остался/);
    assert.doesNotMatch(action.replyText, /Педиатр/);
  });

  it('«я на работе до 17» — расписание, а не «я сейчас на работе»', async () => {
    const request = await requestOf('Терапевт не дальше 15 минут пешком от работы, я на работе до 17, так что после 17:30');
    assert.equal(request.originConfirmed, false);
    assert.equal(request.timeFrom, '17:30');
  });

  it('номер документа — одно предупреждение, а не два одинаковых', async () => {
    const { action } = await chat('1234567890');
    assert.equal(action.replyText.split('не присылайте номера документов').length, 2);
  });
});

describe('Лимит чата под диалог с уточнениями', () => {
  it('40 реплик за 5 минут с адреса — кнопки уточнений тоже реплики', async () => {
    const { checkRateLimit, CHAT_MAX_PER_IP } = await import('../backend/http/rateLimit.js');
    assert.equal(CHAT_MAX_PER_IP, 40);
    const ip = '203.0.113.77';
    const results = Array.from({ length: 41 }, () => checkRateLimit(ip).allowed);
    assert.equal(results.filter(Boolean).length, 40);
    assert.equal(results[40], false);
  });
});
