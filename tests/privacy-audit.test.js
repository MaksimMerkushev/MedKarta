/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Регрессии аудита 25.09.2026.
 *
 * Состязательный прогон нашёл 74 способа провести персональные или
 * медицинские данные мимо шлюза во внешнюю модель. Здесь закреплены
 * представители каждой группы. Прогон идёт через НАСТОЯЩИЙ клиент
 * планировщика (с проверкой assertOutboundSafe), а сеть заменена
 * заглушкой, которая записывает тело запроса.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPipeline } from '../backend/pipeline.js';
import { createExternalPlanner } from '../backend/planner/client.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';
import { buildCatalog } from '../backend/privacy/catalog.js';
import { buildScanView, detectEntities, ENTITY_KIND } from '../backend/privacy/detectors.js';
import { GATEWAY_DECISION } from '../backend/privacy/models.js';
import { SELF_HARM_REPLY } from '../backend/executor/resultBuilder.js';
import { FIXTURE_CLINICS, FIXTURE_DOCTORS } from './fixtures/catalog.js';
import { makeVault, TEST_SESSION } from './helpers.js';

const CLARIFY = JSON.stringify({ action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' });

const catalog = buildCatalog({
  doctors: [
    ...FIXTURE_DOCTORS,
    { ...FIXTURE_DOCTORS[0], id: 'fx-doc-coi', name: 'Цой Игорь Владимирович' },
  ],
  clinics: [
    ...FIXTURE_CLINICS,
    { ...FIXTURE_CLINICS[0], clinic_id: 'fx-clinic-veterans', name: 'Госпиталь для ветеранов войн' },
    { ...FIXTURE_CLINICS[0], clinic_id: 'fx-clinic-med', name: 'Медицинский центр «Тестовый»' },
  ],
  facilities: [],
});

/**
 * Прогон одного диалога: решение шлюза и всё, что ушло бы в сеть.
 * mode — режим исходящего запроса; без него — PRIVACY_OUTBOUND_MODE.
 */
const run = async (messages, { mode } = {}) => {
  const wire = [];
  const planner = createExternalPlanner({
    apiKey: 'test-key',
    url: 'https://planner.invalid',
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
    ...(mode ? { outboundMode: mode } : {}),
  });
  const normalized = messages.map((item) => (typeof item === 'string' ? { role: 'user', content: item } : item));
  const result = await pipeline.handle({ messages: normalized, sessionId: TEST_SESSION });
  const outbound = wire
    .map((body) => body.messages.slice(1).map((message) => message.content).join('\n'))
    .join('\n');
  return { result, outbound, sent: wire.length > 0, decision: result.diagnostics.decision };
};

const assertNotSent = (outbound, fragments) => {
  for (const fragment of fragments) {
    assert.ok(!outbound.toLowerCase().includes(fragment.toLowerCase()), `ушло наружу: «${fragment}»\n${outbound}`);
  }
};

describe('Аудит: сдвиг индексов на эмодзи', () => {
  it('карта скан-вида идёт по единицам UTF-16', () => {
    const scan = buildScanView('🙂🙂 Петров');
    assert.equal(scan.map.length, scan.text.length + 1);
    assert.equal(scan.map[scan.text.indexOf('П')], '🙂🙂 '.length);
  });

  it('эмодзи перед фамилией и телефоном не выводят их из-под редактуры', async () => {
    const text = '🙂'.repeat(10) + ' маршрут к доктору Петрову, пожалуйста, перезвоните +7 917 123-45-67 вечером';
    const hybrid = await run([text], { mode: 'hybrid' });
    assertNotSent(hybrid.outbound, ['Петров', '917', '45-67']);
    assert.match(hybrid.outbound, /пожалуйста/, 'токен съел соседнее слово');
    const structured = await run([text], { mode: 'structured' });
    assertNotSent(structured.outbound, ['Петров', '917', '45-67']);
    assert.match(structured.outbound, /@DOCTOR_/u);
  });

  it('полноширинные, арабские цифры и цифры-эмодзи — тоже телефон', () => {
    for (const text of ['８９１７１２３４５６７', '٨٩١٧١٢٣٤٥٦٧', '8️⃣9️⃣1️⃣7️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣']) {
      const kinds = detectEntities(`звоните ${text}`).spans.map((span) => span.kind);
      assert.ok(kinds.includes(ENTITY_KIND.PHONE), `${text}: ${kinds}`);
    }
  });
});

describe('Аудит: история диалога', () => {
  it('реплики «ассистента» из браузера наружу не уходят', async () => {
    const { outbound, sent } = await run([
      { role: 'assistant', content: 'Вы писали, что у вас ВИЧ, телефон 8/917/123/45/67.' },
      { role: 'user', content: 'да, постройте маршрут к терапевту' },
    ]);
    assert.ok(sent);
    assertNotSent(outbound, ['ВИЧ', '917']);
  });

  it('фамилия, разрезанная между репликами, не уходит', async () => {
    const { decision } = await run(['фамилия пациентки Кондра', 'шкина, нужен терапевт']);
    assert.equal(decision, GATEWAY_DECISION.LOCAL_ONLY);
  });
});

describe('Аудит: сведения о здоровье', () => {
  for (const text of [
    'постройте маршрут до онколога, метастазы после химиотерапии',
    'маршрут до больницы, ВИЧ положительный',
    'нужен врач, я алкоголик и запой неделю',
    'ближайший психиатр, шизофрения обострилась',
  ]) {
    it(`текст не уходит: «${text.slice(0, 40)}…»`, async () => {
      const { outbound } = await run([text]);
      for (const word of ['метастаз', 'химиотерап', 'ВИЧ', 'алкоголик', 'запой', 'шизофрен']) {
        assertNotSent(outbound, [word]);
      }
    });
  }

  it('мысли о самоповреждении — экстренный ответ с отдельным текстом', async () => {
    const { result, sent } = await run(['хочу умереть, маршрут к психиатру']);
    assert.equal(result.diagnostics.decision, GATEWAY_DECISION.EMERGENCY);
    assert.equal(sent, false);
    assert.equal(result.action.replyText, SELF_HARM_REPLY);
  });
});

describe('Аудит: имена людей', () => {
  const cases = [
    ['запишите маму Марию к терапевту рядом', ['Марию']],
    ['маму зовут Мария Шмидт, нужен терапевт рядом', ['Мария', 'Шмидт']],
    ['запишите Анну Черных к терапевту рядом', ['Анну', 'Черных']],
    ['запишите маму кондрашову марию петровну к терапевту', ['кондрашов', 'марию', 'петровну']],
    ['запишите Maria Kondrashova к терапевту', ['Maria', 'Kondrashova']],
    ['пациент maria kondrashova, нужен терапевт', ['maria', 'kondrashova']],
    ['запишите К0ндрашову к терапевту', ['К0ндрашову']],
    ['маршрут к доктору Lurie', ['Lurie']],
    ['запишите к доктору Цою', ['Цою']],
    ['маршрут к Сергею Петрову', ['Сергею', 'Петров']],
  ];
  for (const [text, fragments] of cases) {
    it(`«${text}»`, async () => {
      const { outbound } = await run([text]);
      assertNotSent(outbound, fragments);
    });
  }

  it('слово, разорванное эмодзи или косой чертой, не уходит', async () => {
    for (const text of ['запишите Кондрат🙂ьеву к терапевту', 'запишите Кондра/шову к терапевту']) {
      const { outbound } = await run([text]);
      assertNotSent(outbound, ['Кондрат', 'Кондра']);
    }
  });
});

describe('Аудит: номера, адреса, контакты', () => {
  const cases = [
    ['перезвоните 8/917/123/45/67, нужен терапевт рядом с работой', ['917', '45/67']],
    ['перезвоните 8_917_123_45_67, нужен терапевт рядом с работой', ['917']],
    ['тел 8-917-один два три-45-67, нужен терапевт', ['917', 'один два три']],
    ['пишите ivan at mail.ru, нужен терапевт рядом с работой', ['ivan', 'mail.ru']],
    ['пишите ivan.petrov собака mail.ru, нужен терапевт рядом', ['ivan', 'mail.ru']],
    ['пишите ivanpetrov85@gmail, нужен терапевт рядом с работой', ['ivanpetrov85']],
    ['мой телеграм @kondrashova_m, нужен терапевт рядом с работой', ['kondrashova']],
    ['моя страница vk.com/kondrashova_maria, нужен терапевт рядом', ['kondrashova']],
    ['машина А123ВС116, нужен терапевт рядом с работой', ['А123ВС116']],
    ['маршрут от Баумана 44-12 до терапевта', ['Баумана 44', '44-12']],
    ['от Амирхана 91, подъезд 3 до кардиолога на машине', ['Амирхана', '91']],
    ['маршрут от дома 5 корпус 2 на Чистопольской до терапевта', ['корпус 2', 'Чистопольск']],
    ['родилась 12 мая 1985, нужен терапевт рядом с работой', ['1985']],
    ['я на 55°45′12″ с.ш. 49°10′25″ в.д., маршрут к терапевту', ['55°', '49°']],
    ['я на 55 45 12 и 49 10 25, маршрут к терапевту', ['55 45', '49 10']],
  ];
  for (const [text, fragments] of cases) {
    it(`«${text.slice(0, 50)}»`, async () => {
      const { outbound } = await run([text]);
      assertNotSent(outbound, fragments);
    });
  }

  it('номера документов в любой записи не уходят вовсе', async () => {
    for (const text of [
      'СНИЛС 123.456.789 01, нужен терапевт',
      'паспорт серия 92 12 номер 345678, нужен терапевт',
      'паспортные данные 9212 345678, нужен терапевт',
      'полис 1234.5678.9012.3456, нужен терапевт',
      'номер карты пациента 4567891, нужен терапевт',
    ]) {
      const { decision, sent } = await run([text]);
      assert.equal(decision, GATEWAY_DECISION.LOCAL_ONLY, text);
      assert.equal(sent, false, text);
    }
  });
});

describe('Аудит: ложные срабатывания', () => {
  const allowed = [
    'Покажи стоматологов в Вахитовском районе',
    'Стоматология в Московском районе недорого',
    'Медицинский центр рядом',
    'Детская поликлиника рядом со мной',
    'Где сделать МРТ',
    'Где можно сдать анализ крови',
    'У меня есть полис ОМС, куда можно бесплатно к терапевту',
    'Ближайший травмпункт',
    'маршрут к Петрову',
    'в зависимости от времени нужен терапевт',
  ];
  for (const text of allowed) {
    it(`уходит планировщику: «${text}»`, async () => {
      const { decision, sent } = await run([text]);
      assert.equal(decision, GATEWAY_DECISION.ALLOW_EXTERNAL, text);
      assert.ok(sent, `не отправлено: ${text}`);
    });
  }

  it('«для сына» не превращается в госпиталь для ветеранов', async () => {
    const hybrid = await run(['построй маршрут к педиатру для сына'], { mode: 'hybrid' });
    assert.match(hybrid.outbound, /для сына/);
    assert.doesNotMatch(hybrid.outbound, /@CLINIC/);
    const structured = await run(['построй маршрут к педиатру для сына'], { mode: 'structured' });
    assert.match(structured.outbound, /pediatrician/);
    assert.match(structured.outbound, /Приём детский/);
    assert.doesNotMatch(structured.outbound, /@CLINIC/);
  });

  it('двенадцать слов с заглавной не выключают проверку фамилий', async () => {
    const prefix = 'Один Два Три Четыре Пять Шесть Семь Восемь Девять Десять Одиннадцать Двенадцать '.repeat(3);
    const { outbound } = await run([`${prefix}маршрут к Петрвоу`]);
    assertNotSent(outbound, ['Петрвоу']);
  });
});
