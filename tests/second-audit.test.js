/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Регрессии второго аудита 26.09.2026.
 *
 * Повторный независимый прогон нашёл то, что пропустил первый: номера
 * через тире, данные, разложенные по нескольким сообщениям, диагнозы вне
 * списка правил, гонку токенов между вкладками, неограниченные ответы
 * модели и журналы, лишнюю работу маршрутизатора и ошибки часов работы.
 * Здесь закреплён представитель каждой группы.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPipeline } from '../backend/pipeline.js';
import { createExternalPlanner, MAX_RESPONSE_BYTES } from '../backend/planner/client.js';
import { validatePlan } from '../backend/planner/validator.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';
import { buildCatalog } from '../backend/privacy/catalog.js';
import { detectEntities, ENTITY_KIND } from '../backend/privacy/detectors.js';
import { classifySymptoms } from '../backend/privacy/symptoms.js';
import { GATEWAY_DECISION } from '../backend/privacy/models.js';
import { checkClosedVocabulary, isAllowedWord } from '../backend/privacy/vocabulary.js';
import { createMemoryStore, createTokenVault } from '../backend/storage/tokenVault.js';
import { createCostLimiter, rateLimitKey } from '../backend/http/rateLimit.js';
import { parseOpeningHours, scheduleIntervals } from '../shared/openingHours.js';
import { computeLayout, decodeGraph, encodeGraph } from '../backend/routing/format.js';
import { FIXTURE_CLINICS, FIXTURE_DOCTORS } from './fixtures/catalog.js';
import { makeVault, TEST_SECRET, TEST_SESSION } from './helpers.js';

const CLARIFY = JSON.stringify({ action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' });

const catalog = buildCatalog({
  doctors: [
    ...FIXTURE_DOCTORS,
    { ...FIXTURE_DOCTORS[0], id: 'fx-doc-habib', name: 'Хабибуллин Ильдар Мусович', specialty: 'Кардиолог' },
  ],
  clinics: [
    ...FIXTURE_CLINICS,
    {
      ...FIXTURE_CLINICS[0],
      clinic_id: 'fx-clinic-street',
      name: 'Клиника на проспекте',
      address_full: 'улица Нурсултана Назарбаева, 10, Казань',
    },
  ],
  facilities: [],
});

const run = async (messages) => {
  const wire = [];
  const planner = createExternalPlanner({
    apiKey: 'test-key',
    url: 'http://planner.invalid',
    model: 'test',
    fetchImpl: async (_url, init) => {
      wire.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: CLARIFY } }] }) };
    },
  });
  const pipeline = createPipeline({
    catalog,
    vault: makeVault(),
    planner,
    routing: createHaversineRoutingProvider(),
    logger: createSafeLogger({ enabled: false }),
    metrics: createMetrics(),
  });
  const normalized = messages.map((item) => (typeof item === 'string' ? { role: 'user', content: item } : item));
  const result = await pipeline.handle({ messages: normalized, sessionId: TEST_SESSION });
  const outbound = wire.map((body) => body.messages.slice(1).map((message) => message.content).join('\n')).join('\n');
  return { result, outbound, sent: wire.length > 0, decision: result.diagnostics.decision };
};

const assertNotSent = (outbound, fragments) => {
  for (const fragment of fragments) {
    assert.ok(!outbound.toLowerCase().includes(fragment.toLowerCase()), `ушло наружу: «${fragment}»\n${outbound}`);
  }
};

describe('Второй аудит: закрытый словарь исходящего текста', () => {
  it('обычный запрос уходит словами пользователя', async () => {
    const { outbound } = await run(['нужен терапевт после 18:00 рядом']);
    assert.match(outbound, /нужен терапевт после 18:00 рядом/);
  });

  for (const [text, fragments] of [
    ['нужен инфекционист, I am HIV positive', ['HIV', 'positive', 'инфекционист']],
    ['нужен психиатр, у меня F32.1', ['F32']],
    ['где купить тенофовир, нужен терапевт', ['тенофовир']],
    ['запишите марию к терапевту', ['марию']],
    ['НУЖЕН ЛОР ДЛЯ ГУЛЬНАРЫ', ['ГУЛЬНАР']],
    ['пациент Шмидт, нужен терапевт', ['Шмидт']],
    ['маршрут от баумана 44 до терапевта', ['баумана 44']],
    ['пишите на kondrashova.ru нужен терапевт', ['kondrashova']],
  ]) {
    it(`неизвестные слова заменяются описанием: «${text}»`, async () => {
      const { outbound, sent } = await run([text]);
      if (sent) assertNotSent(outbound, fragments);
    });
  }

  it('имя из названия улицы не становится «разрешённым словом»', async () => {
    const { outbound } = await run(['запишите Нурсултана к кардиологу']);
    assertNotSent(outbound, ['Нурсултан']);
  });

  it('улица в честь человека остаётся улицей', async () => {
    const { outbound, sent } = await run(['стоматология на Ямашева']);
    assert.ok(sent);
    assert.match(outbound, /на Ямашева/);
  });

  it('выдуманный токен не проходит проверку словаря', () => {
    assert.equal(checkClosedVocabulary(['маршрут от @HOME_IVANOV'], ['@HOME']).ok, false);
    assert.equal(checkClosedVocabulary(['маршрут от @HOME до терапевта'], ['@HOME']).ok, true);
  });

  it('цифры считаются по всем репликам вместе', () => {
    assert.equal(checkClosedVocabulary(['8 917', '123 45', '67']).ok, false);
    assert.equal(checkClosedVocabulary(['рейтинг от 4.5, после 18:00']).ok, true);
  });

  it('буквенные символы и флажки не проходят', () => {
    assert.equal(checkClosedVocabulary(['нужен 🇮🇻🇦🇳 терапевт']).ok, false);
    assert.equal(isAllowedWord('терапевту'), true);
    assert.equal(isAllowedWord('Новикова'), false);
  });
});

describe('Второй аудит: номера с тире и знаками', () => {
  for (const text of ['СНИЛС 123–456–789–01, нужен терапевт', 'полис 1234–5678–9012–3456 нужен терапевт']) {
    it(`документ не уходит: «${text}»`, async () => {
      const { decision, sent } = await run([text]);
      assert.equal(decision, GATEWAY_DECISION.LOCAL_ONLY);
      assert.equal(sent, false);
    });
  }

  it('телефон через тире и запятые распознаётся', () => {
    for (const text of ['8–917–123–45–67', '8, 917, 123, 45, 67', '8−917−123−45−67']) {
      const kinds = detectEntities(`звоните ${text}`).spans.map((span) => span.kind);
      assert.ok(kinds.includes(ENTITY_KIND.PHONE), `${text}: ${kinds}`);
    }
  });

  it('часы работы — не номер', () => {
    const kinds = detectEntities('работает 9:00-18:00').spans.map((span) => span.kind);
    assert.deepEqual(kinds, []);
  });
});

describe('Второй аудит: данные в нескольких сообщениях', () => {
  it('СНИЛС, разложенный на две реплики, не уходит', async () => {
    const { decision, sent } = await run(['снилс 123 456', { role: 'assistant', content: '?' }, '789 01 нужен терапевт']);
    assert.equal(decision, GATEWAY_DECISION.LOCAL_ONLY);
    assert.equal(sent, false);
  });

  it('диагноз, разрезанный между репликами, не уходит', async () => {
    const { outbound } = await run(['у меня шизо', { role: 'assistant', content: '?' }, 'френия, нужен врач']);
    assertNotSent(outbound, ['шизо', 'френи']);
  });
});

describe('Второй аудит: классификатор жалоб', () => {
  it('«больше», «больница» — не жалоба', () => {
    for (const text of ['кардиолог с рейтингом больше 4.5', 'ближайшая больница', 'больничный лист']) {
      assert.equal(classifySymptoms(text).hasMedicalText, false, text);
    }
  });

  it('«спидом» и «BИЧ» с латинской B — сведения о здоровье', () => {
    assert.equal(classifySymptoms('муж болен спидом').hasMedicalText, true);
    assert.equal(classifySymptoms('у меня BИЧ').hasMedicalText, true);
  });
});

describe('Второй аудит: родственник с фамилией врача', () => {
  it('«моя мама Гульнара Хабибуллина» — не врач Хабибуллин', async () => {
    const { result } = await run(['моя мама Гульнара Хабибуллина, нужен кардиолог']);
    const stops = result.action.targetStops || [];
    assert.ok(!stops.some((stop) => /Хабибуллин/u.test(stop.doctor || '')), JSON.stringify(stops));
  });
});

describe('Второй аудит: хранилище токенов', () => {
  it('токены двух одновременных запросов одной сессии не перезаписывают друг друга', async () => {
    const vault = makeVault();
    const a = await vault.mint({ sessionId: TEST_SESSION, requestId: 'req-a', kind: 'DOCTOR', index: 0, value: { ids: ['a'] } });
    const b = await vault.mint({ sessionId: TEST_SESSION, requestId: 'req-b', kind: 'DOCTOR', index: 0, value: { ids: ['b'] } });
    assert.equal(a, b, 'текст токена одинаков');
    assert.deepEqual((await vault.resolve({ sessionId: TEST_SESSION, requestId: 'req-a', token: a })).value.ids, ['a']);
    assert.deepEqual((await vault.resolve({ sessionId: TEST_SESSION, requestId: 'req-b', token: b })).value.ids, ['b']);
  });

  it('переполнение вытесняет старые записи, а не отключает токенизацию', async () => {
    const vault = createTokenVault({ store: createMemoryStore({ maxEntries: 3 }), secret: TEST_SECRET });
    for (let index = 0; index < 5; index += 1) {
      await vault.mint({ sessionId: `session-flood-${index}xx`, requestId: 'r', kind: 'PHONE', index: 0, value: { opaque: true } });
    }
    const token = await vault.mint({ sessionId: TEST_SESSION, requestId: 'r', kind: 'DOCTOR', index: 0, value: { ids: ['x'] } });
    assert.ok(await vault.resolve({ sessionId: TEST_SESSION, requestId: 'r', token }));
  });

  it('запрос сверх бюджета токенов не пишет лишнего в хранилище', async () => {
    const store = createMemoryStore();
    const vault = createTokenVault({ store, secret: TEST_SECRET });
    const pipeline = createPipeline({
      catalog,
      vault,
      planner: { name: 'x', async generate() { throw new Error('unused'); } },
      routing: createHaversineRoutingProvider(),
      logger: createSafeLogger({ enabled: false }),
      metrics: createMetrics(),
    });
    const text = Array.from({ length: 40 }, (_, index) => `user${index}@mail.ru`).join(' ');
    const result = await pipeline.handle({ messages: [{ role: 'user', content: text }], sessionId: TEST_SESSION });
    assert.equal(result.diagnostics.decision, GATEWAY_DECISION.LOCAL_ONLY);
    assert.ok(store.size <= 12, `записано ${store.size}`);
  });
});

describe('Второй аудит: ответ модели', () => {
  it('услуги — только из справочника, строка модели в поиск не попадает', () => {
    const plan = JSON.stringify({ action: 'SEARCH_SERVICE', steps: [], constraints: {}, services: ['Запись только по тел 8 800 555 35 35'] });
    const result = validatePlan(plan, { allowedTokens: new Set(), allowedDistricts: [], allowedServices: new Map([['кардиолог', 'Кардиолог']]) });
    assert.ok(result.ok);
    assert.equal(result.value.services, null);
  });

  it('слишком большой ответ отбрасывается, не читаясь целиком', async () => {
    let delivered = 0;
    const body = new ReadableStream({
      pull(controller) {
        delivered += 65536;
        controller.enqueue(new Uint8Array(65536));
        if (delivered > MAX_RESPONSE_BYTES * 8) controller.close();
      },
    });
    const planner = createExternalPlanner({
      apiKey: 'k',
      url: 'http://planner.invalid',
      model: 'm',
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body }),
    });
    const { gateway } = await import('./helpers.js').then(({ makeGateway }) => makeGateway());
    const gate = await gateway.process({ messages: [{ role: 'user', content: 'нужен терапевт рядом' }], sessionId: TEST_SESSION });
    await assert.rejects(planner.generate(gate.request), /too large/);
    assert.ok(delivered <= MAX_RESPONSE_BYTES + 65536 * 2, `прочитано ${delivered}`);
  });
});

describe('Второй аудит: журнал', () => {
  it('идентификатор запроса и версия политики не редактируются', () => {
    const logger = createSafeLogger({ enabled: false });
    const record = logger.event('x', { request_id: '0b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d', policy_version: '2026-09-25.1' });
    assert.equal(record.request_id, '0b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d');
    assert.equal(record.policy_version, '2026-09-25.1');
  });

  it('журнал в памяти ограничен', () => {
    const logger = createSafeLogger({ enabled: false });
    for (let index = 0; index < 2000; index += 1) logger.event('x', { count: index });
    assert.ok(logger.__records.length <= 500);
  });
});

describe('Второй аудит: лимиты', () => {
  it('IPv6-адреса одной сети /64 делят один лимит', () => {
    assert.equal(rateLimitKey('2001:db8:1:2:aaaa::1'), rateLimitKey('2001:db8:1:2:bbbb::2'));
    assert.notEqual(rateLimitKey('2001:db8:1:2::1'), rateLimitKey('2001:db8:1:3::1'));
    assert.equal(rateLimitKey('::ffff:10.0.0.1'), '10.0.0.1');
  });

  it('лимит маршрутов считает время процессора', () => {
    const limiter = createCostLimiter({ capacityMs: 100, refillMsPerSecond: 10 });
    const now = 1_000_000;
    assert.ok(limiter.check('1.1.1.1', now).allowed);
    limiter.charge('1.1.1.1', 150, now);
    assert.equal(limiter.check('1.1.1.1', now).allowed, false);
    assert.ok(limiter.check('2.2.2.2', now).allowed);
    assert.ok(limiter.check('1.1.1.1', now + 6000).allowed);
  });
});

describe('Второй аудит: часы работы', () => {
  it('перерыв на обед — «закрыто»', () => {
    const schedule = parseOpeningHours('Mo-Fr 09:00-12:30,13:00-17:30');
    assert.equal(schedule.mon, '09:00-12:30,13:00-17:30');
    const intervals = scheduleIntervals(schedule.mon);
    const at = (minutes) => intervals.some((item) => minutes >= item.start && minutes < item.end);
    assert.equal(at(12 * 60 + 45), false);
    assert.equal(at(14 * 60), true);
  });

  it('«PH,Su off» закрывает и воскресенье', () => {
    assert.equal(parseOpeningHours('Mo-Su 08:00-20:00; PH,Su off').sun, 'Выходной');
  });

  it('невозможное время не принимается', () => {
    assert.equal(scheduleIntervals('25:00-99:99'), null);
    assert.equal(parseOpeningHours('Mo-Fr 25:00-99:99'), null);
  });
});

describe('Второй аудит: файл графа', () => {
  it('испорченная таблица смещений отклоняется при загрузке', () => {
    const buffer = encodeGraph({
      lat: Int32Array.of(55_000_000, 55_001_000),
      lon: Int32Array.of(49_000_000, 49_001_000),
      offsets: Uint32Array.of(0, 1, 2),
      targets: Uint32Array.of(1, 0),
      lengths: Uint32Array.of(100, 100),
      speeds: Uint8Array.of(40, 40),
      access: Uint8Array.of(7, 7),
    });
    assert.equal(decodeGraph(buffer).nodeCount, 2);
    const broken = Buffer.from(buffer);
    // Последнее смещение (= числу рёбер) заменяется на 50 млн.
    broken.writeUInt32LE(50_000_000, computeLayout(2, 2).offsets + 2 * 4);
    assert.throws(() => decodeGraph(broken), /offsets/);
  });
});
