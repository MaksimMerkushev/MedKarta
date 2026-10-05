/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Регрессия обезличивания на размеченном наборе (tools/privacy-eval).
 *
 * Полный прогон — `npm run eval:privacy` (≈11 тыс. примеров, около минуты).
 * Здесь — ручной набор целиком и десятая часть сгенерированного: этого
 * хватает, чтобы правка детектора или словаря, вернувшая утечку или
 * потерю смысла, ломала `npm test`.
 */

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { buildCatalog, loadCatalog } from '../backend/privacy/catalog.js';
import { createEntityResolver } from '../backend/privacy/entityResolver.js';
import { createPipeline } from '../backend/pipeline.js';
import { createPrivacyGateway, describeOrder, extractConstraints } from '../backend/privacy/gateway.js';
import { findStreetMentions } from '../backend/privacy/vocabulary.js';
import { createMemoryStore, createTokenVault } from '../backend/storage/tokenVault.js';
import { createExternalPlanner } from '../backend/planner/client.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';
import { generateDataset } from '../tools/privacy-eval/generate.js';
import { HANDWRITTEN } from '../tools/privacy-eval/handwritten.js';
import { createRecordingPipeline, evaluateSamples, handwrittenSamples, summarize } from '../tools/privacy-eval/evaluate.js';
import { FIXTURE_CLINICS, FIXTURE_DOCTORS } from './fixtures/catalog.js';

const modules = { loadCatalog, createPipeline, createMemoryStore, createTokenVault, createExternalPlanner, createHaversineRoutingProvider, createSafeLogger, createMetrics };

const runners = {};
let catalog;
let catalogDoctors;

before(async () => {
  runners.structured = await createRecordingPipeline({ modules, outboundMode: 'structured' });
  runners.hybrid = await createRecordingPipeline({ modules, outboundMode: 'hybrid' });
  catalog = runners.structured.catalog;
  catalogDoctors = catalog.doctors.filter((doctor) => doctor.name && doctor.specialty).map((doctor) => ({ name: doctor.name, specialty: doctor.specialty }));
});

const describeLeaks = (results) => results
  .filter((item) => item.leaks.length > 0)
  .slice(0, 5)
  .map((item) => `${item.messages.join(' || ')} → ${item.leaks.map((leak) => `${leak.kind}:${leak.value}`).join(', ')}`)
  .join('\n');

describe('Набор: ручные примеры', () => {
  for (const mode of ['structured', 'hybrid']) {
    it(`${mode}: ни одной утечки, обычные запросы доходят до модели`, async () => {
      const results = await evaluateSamples(runners[mode], handwrittenSamples(HANDWRITTEN));
      const { overall } = summarize(results);
      assert.equal(overall.leakedSamples, 0, describeLeaks(results));
      assert.equal(overall.benignSentRate, 100);
      assert.equal(overall.catalogTokenRate ?? 100, 100);
      assert.equal(overall.emergencyFalseAlarms, 0);
    });
  }
});

describe('Набор: сгенерированные примеры (10 % проверочной части)', () => {
  let results;
  let overall;

  before(async () => {
    const samples = generateDataset({ split: 'test', scale: 0.1, catalogDoctors });
    results = await evaluateSamples(runners.structured, samples);
    overall = summarize(results).overall;
  });

  it('structured: ни одной утечки', () => {
    assert.ok(overall.piiSamples > 600, `примеров с данными: ${overall.piiSamples}`);
    assert.equal(overall.leakedSamples, 0, describeLeaks(results));
  });

  it('structured: описание шлюза проходит выходной предохранитель', () => {
    const blocked = results.filter((item) => item.decision === 'allow_external' && !item.sent);
    assert.equal(overall.outboundBlocked, 0, blocked.slice(0, 5).map((item) => item.messages.join(' || ')).join('\n'));
  });

  it('structured: обычные запросы доходят до модели, «привет» — нет', () => {
    assert.ok(overall.benignSentRate >= 99, `дошли ${overall.benignSentRate}%`);
    assert.equal(overall.smalltalkSentRate, 0);
    assert.equal(overall.emergencyFalseAlarms, 0);
  });

  it('structured: запросы с данными по-прежнему в основном идут модели', () => {
    // Остаток — документы (отказ по правилу), голые телефоны и почты (нечего планировать).
    assert.ok(overall.piiSentRate >= 80, `ушло ${overall.piiSentRate}%`);
  });

  it('structured: смысл доходит описанием', () => {
    assert.ok(overall.specialtyCoverage >= 99, `профиль ${overall.specialtyCoverage}%`);
    assert.ok(overall.timeCoverage >= 99, `время ${overall.timeCoverage}%`);
    assert.ok(overall.placeCoverage >= 99, `место ${overall.placeCoverage}%`);
    assert.ok(overall.orderCoverage >= 97, `порядок ${overall.orderCoverage}%`);
    // null — в этой десятой части таких примеров нет.
    for (const key of ['experienceCoverage', 'sortCoverage', 'travelCoverage', 'dmsCoverage', 'clinicCoverage']) {
      if (overall[key] !== null) assert.equal(overall[key], 100, key);
    }
  });
});

/** Описание, которое ушло бы модели в режиме structured, или причина локального ответа. */
const describeRequest = async (messages, source = catalog) => {
  const gateway = createPrivacyGateway({
    resolver: createEntityResolver(source),
    vault: createTokenVault({ store: createMemoryStore(), secret: 'privacy-eval-test-secret-0123' }),
    catalog: source,
    outboundMode: 'structured',
  });
  const result = await gateway.process({
    messages: (Array.isArray(messages) ? messages : [messages]).map((content) => ({ role: 'user', content })),
    sessionId: 'privacy-eval-session-01',
  });
  return {
    decision: result.decision,
    reason: result.reason,
    text: result.request ? result.request.toWireMessages().map((message) => message.content).join(' ') : '',
  };
};

describe('Описание вместо текста: что раньше терялось', () => {
  for (const [text, expected] of [
    ['нужен лору рядом', /lor/],
    ['окулисту после работы', /ophthalmologist/],
    ['терапефт рядом', /therapist/],
    ['есть лорр?', /lor/],
    ['нужен детский врач', /pediatrician/],
    ['zapishite mamu k terapevtu', /therapist/],
    ['need dentist', /dentist/],
    ['ближайший травмпункт', /traumatologist/],
  ]) {
    it(`профиль: «${text}»`, async () => {
      assert.match((await describeRequest(text)).text, expected);
    });
  }

  it('«поближе к дому» — это «ближайший»', () => {
    assert.equal(extractConstraints('педиатр поближе к дому').selection, 'nearest');
    assert.equal(extractConstraints('терапевт около дома').selection, 'nearest');
  });

  it('способ передвижения, стаж и сортировка', () => {
    assert.equal(extractConstraints('лор пешком').travelMode, 'foot');
    assert.equal(extractConstraints('на велике до хирурга').travelMode, 'bike');
    assert.equal(extractConstraints('на машине до кардиолога').travelMode, 'driving');
    assert.equal(extractConstraints('на автобусе до кардиолога').travelMode, undefined);
    assert.equal(extractConstraints('хирург с опытом больше 10 лет').minExperience, 10);
    assert.equal(extractConstraints('покажи кардиологов по рейтингу').sortMode, 'rating');
    assert.equal(extractConstraints('отсортируй по стажу').sortMode, 'experience');
  });

  it('«добрый вечер» — приветствие, а не время приёма', () => {
    assert.equal(extractConstraints('добрый вечер, нужен терапевт').evening, undefined);
    assert.equal(extractConstraints('нужен терапевт вечером').evening, true);
  });

  it('условия из ранних реплик не теряются', async () => {
    const { text } = await describeRequest(['нужен лор для сына рядом', 'его зовут Тимур']);
    assert.match(text, /lor/);
    assert.match(text, /Приём детский/);
    assert.match(text, /selection=nearest/);
    assert.doesNotMatch(text, /Тимур/);
  });

  it('аббревиатуры и номера больниц становятся метками клиник', async () => {
    assert.match((await describeRequest('маршрут до ДРКБ')).text, /@CLINIC_/);
    assert.match((await describeRequest('поликлиника 21 часы работы')).text, /@CLINIC_/);
  });

  it('место из справочника не блокирует отправку', async () => {
    const result = await describeRequest('педиатр в Азино');
    assert.equal(result.decision, 'allow_external');
    assert.match(result.text, /Места: Азино/);
  });

  it('улица без номера дома уходит названием из списка, с номером — нет', async () => {
    assert.deepEqual(findStreetMentions('стоматология на Ямашева'), ['улица Ямашева']);
    assert.deepEqual(findStreetMentions('на чистопольской рядом'), ['улица Чистопольская']);
    assert.deepEqual(findStreetMentions('живу на Баумана 44'), []);
    assert.deepEqual(findStreetMentions('от дома 5 корпус 2 на Чистопольской'), []);
    assert.doesNotMatch((await describeRequest('живу на Чистопольской дом пять, нужен терапевт')).text, /Чистопольск/);
  });

  it('время после улицы — не номер дома, номер без «ул.» — адрес', async () => {
    const { detectEntities } = await import('../backend/privacy/detectors.js');
    const { checkClosedVocabulary, findKnownPlaces } = await import('../backend/privacy/vocabulary.js');
    for (const text of ['нужен невролог на Дубравной после 18:00', 'дерматолог на проспекте Победы к 9 утра']) {
      assert.deepEqual(detectEntities(text).spans.map((span) => span.kind), [], text);
    }
    assert.equal(checkClosedVocabulary(['адрес: Дубравная 21. нужен хирург']).reason, 'address');
    assert.deepEqual(findKnownPlaces('адрес: Дубравная 21'), []);
    assert.doesNotMatch((await describeRequest('адрес: Дубравная 21. нужен хирург')).text, /Дубравн/);
  });

  it('порядок шагов маршрута доходит до модели', async () => {
    const { text } = await describeRequest('сначала к кардиологу Галявичу, потом к ближайшему стоматологу после 18:00, а потом домой');
    assert.match(text, /Порядок в запросе: @DOCTOR_[A-Z]+ \(cardiologist\), затем dentist, затем @HOME\./);
    assert.doesNotMatch(text, /Галявич/);
  });

  it('порядок собирается только из меток и ключей', () => {
    assert.equal(describeOrder([
      { kind: 'SPECIALTY', specialty: 'therapist' },
      { kind: 'DOCTOR', token: '@DOCTOR_A' },
      { kind: 'PERSON', token: '@PERSON_A' },
      { kind: 'SPECIALTY', specialty: 'dentist' },
      { kind: 'LOCATION', token: '@HOME' },
    ]), '@DOCTOR_A (therapist), затем dentist, затем @HOME');
    assert.equal(describeOrder([{ kind: 'SPECIALTY', specialty: 'therapist' }]), '');
    assert.equal(describeOrder([{ kind: 'SPECIALTY', specialty: 'not-a-key' }, { kind: 'LOCATION', token: '@HOME' }]), '');
  });
});

/*
 * Тёзки врачей. Полного справочника в git нет (data/doctors.full.js), поэтому
 * врачи-тёзки заданы здесь; имена вымышлены.
 */
const namesake = (id, name, specialty) => ({ ...FIXTURE_DOCTORS[0], id, name, specialty, services: [specialty] });
const namesakeCatalog = () => buildCatalog({
  doctors: [
    ...FIXTURE_DOCTORS,
    namesake('fx-doc-zinnatullina', 'Зиннатуллина Регина Фаритовна', 'Уролог'),
    namesake('fx-doc-kadyrova', 'Кадырова Лилия Ринатовна', 'Дерматолог'),
    namesake('fx-doc-mukhametov', 'Мухаметов Марат Ринатович', 'Кардиолог'),
    namesake('fx-doc-sabitov', 'Сабитов Ильдар Ренатович', 'Невролог'),
  ],
  clinics: [...FIXTURE_CLINICS, { ...FIXTURE_CLINICS[0], clinic_id: 'fx-clinic-sabitova', name: 'Клиника доктора Сабитовой' }],
  facilities: [],
});

describe('Описание вместо текста: кто есть кто', () => {
  it('тёзки есть в справочнике и находятся как врачи', async () => {
    for (const text of ['к врачу Зиннатуллиной', 'к Кадыровой', 'к Мухаметову Марату Ринатовичу']) {
      assert.match((await describeRequest(text, namesakeCatalog())).text, /@DOCTOR_/, text);
    }
  });

  for (const text of [
    'ФИО: ЗИННАТУЛЛИНА РЕГИНА ФАРИТОВНА. НУЖЕН УРОЛОГ',
    'Добрый день, меня зовут Алсу Кадырова, ищу дерматолога',
    'добрый вечер Марат Ринатович беспокоит нужен кардиолог',
  ]) {
    it(`представившийся пользователь — не врач справочника: «${text.slice(0, 40)}»`, async () => {
      const result = await describeRequest(text, namesakeCatalog());
      assert.equal(result.decision, 'allow_external');
      assert.match(result.text, /@PERSON_/);
      assert.doesNotMatch(result.text, /@DOCTOR_/);
      assert.doesNotMatch(result.text, /evening/);
    });
  }

  it('«к доктору Сабитову» — врач, «клиника доктора Сабитовой» — клиника', async () => {
    assert.match((await describeRequest('сначала к доктору Сабитову, затем к неврологу', namesakeCatalog())).text, /@DOCTOR_/);
    assert.match((await describeRequest('маршрут до клиники доктора Сабитовой', namesakeCatalog())).text, /@CLINIC_/);
  });

  it('запрос без цели отвечается локально', async () => {
    for (const text of ['привет', 'спасибо', '.....', 'а ты кто', 'перезвоните мне 89171234567']) {
      const result = await describeRequest(text);
      assert.equal(result.decision, 'local_only', text);
      assert.equal(result.reason, 'nothing_to_plan', text);
    }
  });

  it('врач, которого нет в справочнике, — отдельный ответ', async () => {
    const result = await describeRequest('хочу к доктору Пупкину');
    assert.equal(result.reason, 'doctor_not_in_catalog');
  });
});
