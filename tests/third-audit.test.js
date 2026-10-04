/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Третий аудит (октябрь 2026): отказ в обслуживании на одном ядре,
 * пропуски неотложных состояний, утечки мимо закрытого словаря и
 * недоверенные данные со страниц клиник в сборщике.
 *
 * Каждый тест закрепляет найденную проблему: если он падает, уязвимость
 * вернулась.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { detectEntities } from '../backend/privacy/detectors.js';
import { classifySymptoms } from '../backend/privacy/symptoms.js';
import { checkClosedVocabulary } from '../backend/privacy/vocabulary.js';
import {
  createCostLimiter,
  createExternalBudget,
  createLoadShedder,
  createRateLimiter,
  getClientIp,
  validateTrustProxy,
} from '../backend/http/rateLimit.js';
import { createCpuQueue } from '../backend/api/chat.js';
import { createDailyEventQuota } from '../backend/api/events.js';
import { createEventStore } from '../backend/analytics/eventStore.js';
import { createExternalPlanner, isAllowedUpstreamUrl } from '../backend/planner/client.js';
import { validatePlan } from '../backend/planner/validator.js';
import { applyChanges, classifyChange, collectSource, describeChange, extractRecords, isMassChange } from '../tools/data/collector.js';
import { createFetcher, isPrivateHost } from '../tools/data/fetchSource.js';
import { cleanText, decodeEntities, htmlToText, parsePriceTables } from '../tools/data/html.js';
import { createMemoryStore } from '../tools/data/store.js';
import { buildCatalogFromSnapshots } from '../tools/data/buildCatalog.js';
import { validatePrivateCatalog } from '../shared/privateCatalog.js';
import { normalizePrice } from '../shared/services.js';
import { makeGateway, makeTestPipeline, TEST_SESSION } from './helpers.js';

const timed = (fn) => {
  const started = performance.now();
  fn();
  return performance.now() - started;
};

describe('Третий аудит: регулярные выражения не перебирают', () => {
  it('враждебный ввод в 1000 символов разбирается быстро', () => {
    // До исправления: 'улиц'×250 — 1,7 с, 'aat'×334 — 0,9 с на одну реплику.
    for (const unit of ['улиц', 'проспект', 'aat', 'at', 'д.А', '1улиц', 'aat1-']) {
      const text = unit.repeat(Math.ceil(1000 / unit.length)).slice(0, 1000);
      const ms = timed(() => detectEntities(text));
      assert.ok(ms < 300, `${unit}: ${ms.toFixed(0)} мс`);
    }
  });

  it('склейка двенадцати реплик (12 000 символов) не квадратична', () => {
    const text = 'ул.'.repeat(4000);
    assert.ok(timed(() => detectEntities(text)) < 600);
  });

  it('почта словами и в скобках по-прежнему находится', () => {
    for (const text of ['пишите на ivan собака mail точка ru', 'ivan (at) mail (dot) ru', 'ivan.petrov at yandex dot ru']) {
      assert.ok(detectEntities(text).spans.some((span) => span.kind === 'EMAIL'), text);
    }
  });

  it('номер дома не забирает первую букву следующего слова', () => {
    const text = 'построй маршрут от Пушкина 7 до терапевта';
    const span = detectEntities(text).spans.find((item) => item.kind === 'ADDRESS');
    assert.equal(text.slice(span.start, span.end), 'от Пушкина 7');
    const lettered = 'от Пушкина 7а до терапевта';
    const second = detectEntities(lettered).spans.find((item) => item.kind === 'ADDRESS');
    assert.equal(lettered.slice(second.start, second.end), 'от Пушкина 7а');
  });
});

describe('Третий аудит: неотложные состояния', () => {
  const urgent = [
    'болит сердце, отдает в левую руку', 'укусила оса, опухло горло, трудно дышать', 'боль за грудиной, отдает в челюсть',
    'ребёнок не дышит', 'не хочу больше жить', 'у папы инфаркт', 'тяжело дышать', 'задыхается', 'посинел',
    'потеряла сознание', 'лицо перекосило', 'кровь не останавливается', 'покончить с жизнью', 'наглоталась таблеток',
    'передозировка', 'У мамы инсульт', 'у сына судороги', 'отнялась рука', 'жжение за грудиной',
  ];
  const ordinary = [
    'реабилитация после инсульта', 'у мамы был инсульт три года назад', 'кардиолог после инфаркта',
    'перенёс инфаркт, нужен кардиолог', 'судороги в ногах по ночам', 'трудно дышать носом, насморк', 'болит сердце',
    'профилактика инсульта', 'нужен педиатр для грудничка',
  ];

  it('распознаются в любом порядке слов и роде', () => {
    for (const text of urgent) assert.ok(classifySymptoms(text).emergency, `не распознано: ${text}`);
  });

  it('прошлое и профилактика не пугают звонком в 103', () => {
    for (const text of ordinary) assert.equal(classifySymptoms(text).emergency, null, `ложная тревога: ${text}`);
  });

  it('«Инсульт» с заглавной не теряется из-за маскировки имён', async () => {
    const { pipeline, sent } = makeTestPipeline();
    for (const content of ['У мамы Инсульт', 'У сына Судороги']) {
      const { action } = await pipeline.handle({ messages: [{ role: 'user', content }], sessionId: TEST_SESSION });
      assert.match(action.replyText, /103/, content);
    }
    assert.equal(sent.length, 0);
  });
});

describe('Третий аудит: закрытый словарь', () => {
  it('имена, строчные фамилии, номера словами и эмодзи-цифры не проходят', () => {
    for (const text of [
      'запишите Любу к урологу рядом', 'Женя, нужен педиатр рядом', 'мой врач малышев, нужен терапевт рядом',
      'быстров', 'крупнов', 'рублев', 'восемь девять один семь, потом один два три, потом четыре пять шесть',
      'построй маршрут от Пушкина семь до терапевта', 'с Баумана десять до стоматолога', '🕗🕘🕐🕖 терапевт',
      'терапевт ́́',
    ]) {
      assert.equal(checkClosedVocabulary([text]).ok, false, text);
    }
  });

  it('обычные запросы проходят', () => {
    for (const text of ['Покажи стоматологов в Вахитовском районе', 'нужен женский врач рядом', 'любой терапевт рядом', 'жене нужен гинеколог', 'терапевт 🙂🙂🙂🙂']) {
      assert.equal(checkClosedVocabulary([text]).ok, true, text);
    }
  });
});

describe('Третий аудит: ограничения нагрузки', () => {
  it('переполнение карты адресов вытесняет давних, а не обнуляет всех', () => {
    const limit = createRateLimiter({ maxPerIp: 2, maxTrackedIps: 3, maxPerInstance: Number.POSITIVE_INFINITY });
    const now = 1_000_000;
    limit('10.0.0.1', now);
    limit('10.0.0.1', now);
    assert.equal(limit('10.0.0.1', now).allowed, false);
    limit('10.0.0.2', now);
    assert.equal(limit('10.0.0.1', now).allowed, false);
    limit('10.0.0.3', now);
    limit('10.0.0.4', now);
    // Раньше переполнение карты (больше maxTrackedIps адресов) обнуляло всех,
    // и заблокированный адрес снова получал полный лимит.
    assert.equal(limit('10.0.0.1', now).allowed, false);
  });

  it('ведро стоимости тоже вытесняет по давности', () => {
    const limiter = createCostLimiter({ capacityMs: 100, refillMsPerSecond: 1, maxTrackedIps: 2 });
    limiter.charge('10.0.0.1', 500, 0);
    limiter.charge('10.0.0.2', 1, 0);
    limiter.charge('10.0.0.1', 1, 0);
    limiter.charge('10.0.0.3', 1, 0);
    assert.equal(limiter.check('10.0.0.1', 0).allowed, false);
  });

  it('предохранитель нагрузки: ассистент отключается раньше маршрутов', () => {
    const shed = createLoadShedder({ windowMs: 10_000, maxShare: 0.6 });
    shed.record(6_500, 0);
    assert.equal(shed.allows(1), false);
    assert.equal(shed.allows(1, 0.85), true);
    assert.equal(shed.allows(10_001), true);
  });

  it('очередь разбора: по одному, лишние получают «занято»', async () => {
    const queue = createCpuQueue({ maxActive: 1, maxQueue: 1, waitMs: 1_000 });
    let running = 0;
    let peak = 0;
    const task = () => queue.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return 'ok';
    });
    const results = await Promise.allSettled([task(), task(), task()]);
    assert.equal(peak, 1);
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled', 'rejected']);
    assert.equal(results[2].reason.code, 'busy');
  });

  it('суточный потолок обращений к модели', () => {
    const budget = createExternalBudget({ dailyLimit: () => 2 });
    assert.deepEqual([budget(0), budget(1), budget(2)], [true, true, false]);
    assert.equal(budget(24 * 3600 * 1000 + 5), true);
  });

  it('суточная квота событий аналитики на адрес', () => {
    const quota = createDailyEventQuota({ maxPerIp: 5, now: () => 0 });
    assert.equal(quota('10.0.0.1', 3), 3);
    assert.equal(quota('10.0.0.1', 3), 2);
    assert.equal(quota('10.0.0.1', 3), 0);
    assert.equal(quota('10.0.0.2', 3), 3);
  });

  it('журнал аналитики держит каталог в пределах потолка', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'medkarta-events-'));
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      await fs.writeFile(path.join(dir, `events-${day}.jsonl`), 'x'.repeat(1000));
    }
    const store = createEventStore({ dir, maxTotalBytes: 2_500, now: () => new Date('2026-09-03T12:00:00Z') });
    await store.prune(new Date('2026-09-03T12:00:00Z'));
    assert.deepEqual((await fs.readdir(dir)).sort(), ['events-2026-09-02.jsonl', 'events-2026-09-03.jsonl']);
  });
});

describe('Третий аудит: адрес клиента и прокси', () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

  it('TRUST_PROXY: только целое число', () => {
    const previous = process.env.TRUST_PROXY;
    try {
      for (const value of ['true', 'yes', '-1', '10']) {
        process.env.TRUST_PROXY = value;
        assert.throws(() => validateTrustProxy(), /TRUST_PROXY/);
      }
      process.env.TRUST_PROXY = '1';
      assert.equal(validateTrustProxy(), 1);
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = previous;
    }
  });

  it('X-Forwarded-For — только от своего прокси, X-Real-IP — никогда', () => {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    try {
      assert.equal(getClientIp(request('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 5.5.5.5' })), '5.5.5.5');
      assert.equal(getClientIp(request('203.0.113.9', { 'x-forwarded-for': '6.6.6.6' })), '203.0.113.9');
      assert.equal(getClientIp(request('127.0.0.1', { 'x-real-ip': '6.6.6.6' })), '127.0.0.1');
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY;
      else process.env.TRUST_PROXY = previous;
    }
  });
});

describe('Третий аудит: внешний планировщик', () => {
  it('ключ уходит только по HTTPS', () => {
    assert.equal(isAllowedUpstreamUrl('https://openrouter.ai/api/v1/chat/completions'), true);
    assert.equal(isAllowedUpstreamUrl('http://127.0.0.1:8080/v1'), true);
    assert.equal(isAllowedUpstreamUrl('http://modelhub.example/v1'), false);
    assert.equal(isAllowedUpstreamUrl('file:///etc/passwd'), false);
  });

  it('за редиректом не следует, тело ошибки закрывает', async () => {
    let init = null;
    let cancelled = false;
    const fetchImpl = async (_url, options) => {
      init = options;
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 429 });
    };
    const planner = createExternalPlanner({ apiKey: 'k', url: 'https://planner.invalid/v1', model: 'm', fetchImpl });
    const gate = await makeGateway().gateway.process({ messages: [{ role: 'user', content: 'Покажи стоматологов в Вахитовском районе' }], sessionId: TEST_SESSION });
    assert.ok(gate.request, 'запрос должен быть разрешён к отправке');
    await assert.rejects(() => planner.generate(gate.request));
    assert.equal(init.redirect, 'error');
    assert.equal(cancelled, true);
  });

  it('расстояние меньше 300 м — не ограничение, а обнуление выдачи', () => {
    const plan = (km) => ({ action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'dentist', constraints: {} }], constraints: { max_distance_km: km } });
    const options = { allowedTokens: new Set(), allowedDistricts: [] };
    assert.equal(validatePlan(plan(1e-300), options).ok, false);
    assert.equal(validatePlan(plan(3), options).ok, true);
  });
});

describe('Третий аудит: разбор страниц клиник', () => {
  it('сущности вне Юникода не роняют разбор', () => {
    assert.equal(decodeEntities('A&#x110000;B&#99999999;C&#x1F600;'), 'A�B�C😀');
  });

  it('враждебный HTML разбирается за линейное время', () => {
    for (const html of ['<'.repeat(300_000), '<script type="application/ld+json" '.repeat(10_000), 'a' + '\r'.repeat(300_000)]) {
      assert.ok(timed(() => htmlToText(html)) < 1_500);
    }
    assert.ok(timed(() => parsePriceTables(`<table><tr>${'<td>x'.repeat(60_000)}</tr></table>`)) < 1_500);
  });

  it('управляющие символы со страницы не попадают в вывод', () => {
    assert.equal(cleanText('Мошенников, 13\u001b[2K\r ? клиника‮'), 'Мошенников, 13 [2K ? клиника');
    const text = describeChange({ kind: 'doctor', change: 'added', after: { name: 'Иванова\u001b[2K', specialty: 'Терапевт' } });
    assert.ok(!/\p{Cc}/u.test(text));
  });

  it('ячейки th и td — в порядке документа', () => {
    const rows = parsePriceTables('<table><tr><th>Приём терапевта первичный</th><td>1500 руб</td></tr></table>');
    assert.equal(rows[0].serviceId, 'consult.therapist.first');
  });

  it('цена меньше 10 ₽ — ошибка разбора, а не самая дешёвая услуга', () => {
    assert.equal(normalizePrice(0.4), null);
    assert.equal(normalizePrice('0,4'), null);
  });
});

describe('Третий аудит: сборщик не верит странице', () => {
  it('дрейф цены считается от одобренной человеком', () => {
    const change = { kind: 'price', change: 'changed', before: { min: 1190, max: 1190 }, after: { min: 1416, max: 1416 }, baseline: { min: 1000, max: 1000 } };
    assert.equal(classifyChange(change).decision, 'review');
    const records = { clinic: null, doctors: [], prices: [{ serviceId: 's', price: { min: 1000, max: 1000 }, approved: { min: 1000, max: 1000 } }], unmatched: [] };
    const auto = applyChanges(records, [{ kind: 'price', key: 's', change: 'changed', after: { min: 1190, max: 1190 } }]);
    assert.equal(auto.prices[0].approved.min, 1000, 'автоматическое изменение не сдвигает точку отсчёта');
    const reviewed = applyChanges(auto, [{ kind: 'price', key: 's', change: 'changed', after: { min: 1416, max: 1416 } }], { reviewed: true });
    assert.equal(reviewed.prices[0].approved.min, 1416);
  });

  it('массовые добавления — на проверку целиком', () => {
    const previous = { doctors: [{ name: 'А Б' }, { name: 'В Г' }, { name: 'Д Е' }, { name: 'Ж З' }], prices: [] };
    const changes = Array.from({ length: 12 }, (_, index) => ({ kind: 'doctor', change: 'added', key: `x${index}` }));
    assert.equal(isMassChange(previous, changes), true);
  });

  it('дубль имени ниже по странице не подменяет врача', () => {
    const page = `<script type="application/ld+json">{"@type":"MedicalClinic","name":"К","employee":[
      {"@type":"Physician","name":"Иванова Мария","medicalSpecialty":"Терапевт"},
      {"@type":"Physician","name":"ИВАНОВА  мария","medicalSpecialty":"Онколог"}]}</script>`;
    const { doctors } = extractRecords(page);
    assert.equal(doctors.length, 1);
    assert.equal(doctors[0].specialty, 'Терапевт');
  });

  it('страница с тысячами записей ничего не применяет', async () => {
    const letters = 'абвгдежзиклмнопрстуф';
    const unique = (index) => [...String(index).padStart(3, '0')].map((digit) => letters[Number(digit)]).join('');
    const people = Array.from({ length: 450 }, (_, index) => `{"@type":"Physician","name":"Врач${unique(index)} Тест","medicalSpecialty":"Терапевт"}`).join(',');
    const body = `<script type="application/ld+json">{"@type":"MedicalClinic","name":"К","employee":[${people}]}</script>`;
    const store = createMemoryStore();
    const fetcher = { fetchSource: async () => ({ status: 'ok', body }) };
    const report = await collectSource({ source: { id: 'big-site', type: 'http', url: 'https://clinic.example/' }, fetcher, store });
    assert.equal(report.status, 'too_many_records');
    assert.equal(await store.readSnapshot('big-site'), null);
  });

  it('сайт клиники — только того же домена; координаты источника главнее', () => {
    const source = { id: 's1', kind: 'clinic-site', url: 'https://clinic.example/about', clinicId: 'c1', branchId: 'b1', geo: { lat: 55.79, lng: 49.12 } };
    const snapshot = {
      sourceId: 's1',
      approved: true,
      verifiedAt: '2026-10-01',
      records: {
        clinic: { name: 'К', address: 'Казань, ул. Пример, 1', phone: '+7 843 000-00-00', hours: '', website: 'https://evil.example/phish', lat: 0, lng: 1e308 },
        doctors: [
          { name: 'Иванова Мария', specialty: 'Терапевт' },
          { name: 'Иванова-Мария', specialty: 'Терапевт' },
        ],
        prices: [],
        unmatched: [],
      },
    };
    const { catalog, errors } = buildCatalogFromSnapshots([source], [snapshot]);
    assert.deepEqual(errors, []);
    assert.equal(catalog.clinics[0].website, 'https://clinic.example');
    assert.deepEqual([catalog.clinics[0].branches[0].lat, catalog.clinics[0].branches[0].lng], [55.79, 49.12]);
    const ids = catalog.doctors.map((doctor) => doctor.id);
    assert.equal(new Set(ids).size, 2, `id совпали: ${ids}`);
  });

  it('проверка справочника отсекает чужие схемы ссылок и мусорные значения', () => {
    const catalog = {
      meta: { source: 'collected' },
      clinics: [{
        id: 'c1', name: 'К', website: 'vbscript:alert(1)', branches: [
          { id: 'b1', address: 'адрес', lat: 0, lng: 0, phone: 'javascript:alert(1)', bookingUrl: 'data:text/html,x' },
        ],
      }],
      doctors: [{ id: 'd1', name: 'И', specialty: 'Терапевт', branchIds: ['b1', 'b1'], experienceYears: 1e9 }],
      prices: [],
    };
    const errors = validatePrivateCatalog(catalog).join('\n');
    for (const fragment of ['ссылка не http', 'вне Татарстана', 'неверный телефон', 'неверный стаж', 'филиал указан дважды']) {
      assert.ok(errors.includes(fragment), `нет ошибки «${fragment}»:\n${errors}`);
    }
  });
});

describe('Третий аудит: загрузка страниц', () => {
  const quiet = { sleep: async () => {} };

  it('локальные и внутренние адреса — запрещены', async () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '[::1]', 'printer.local']) {
      assert.equal(isPrivateHost(host), true, host);
    }
    assert.equal(isPrivateHost('clinic.example'), false);
    const fetcher = createFetcher({ fetchImpl: async () => { throw new Error('не должно вызываться'); }, ...quiet });
    assert.equal((await fetcher.fetchSource({ type: 'http', url: 'http://127.0.0.1:8080/admin' })).code, 'private_address');
  });

  it('редирект на другой сайт или во внутреннюю сеть не выполняется', async () => {
    const fetchImpl = async (url) => {
      if (url.endsWith('/robots.txt')) return new Response(null, { status: 404 });
      if (url === 'https://clinic.example/page') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
      if (url === 'https://clinic.example/moved') return new Response(null, { status: 301, headers: { location: 'https://www.clinic.example/new' } });
      if (url === 'https://www.clinic.example/new') return new Response('<p>ok</p>', { status: 200 });
      throw new Error(`неожиданный запрос ${url}`);
    };
    const fetcher = createFetcher({ fetchImpl, ...quiet });
    assert.equal((await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/page' })).code, 'redirect_offsite');
    const moved = await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/moved' });
    assert.equal(moved.status, 'ok');
    assert.equal(moved.body, '<p>ok</p>');
  });

  it('тело читается с потолком по байтам, без Content-Length тоже', async () => {
    let produced = 0;
    const endless = new ReadableStream({
      pull(controller) {
        produced += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024).fill(97));
      },
    });
    const fetchImpl = async (url) => (url.endsWith('/robots.txt') ? new Response(null, { status: 404 }) : new Response(endless, { status: 200 }));
    const fetcher = createFetcher({ fetchImpl, ...quiet });
    const result = await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/huge' });
    assert.equal(result.code, 'too_large');
    assert.ok(produced < 4 * 1024 * 1024, `прочитано ${produced} байт`);
  });

  it('обрыв тела — ошибка источника, а не исключение', async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error('slow'), { name: 'TimeoutError' }));
      },
    });
    const fetchImpl = async (url) => (url.endsWith('/robots.txt') ? new Response(null, { status: 404 }) : new Response(broken, { status: 200 }));
    const fetcher = createFetcher({ fetchImpl, ...quiet });
    assert.deepEqual(await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/slow' }), { status: 'error', code: 'timeout' });
  });

  it('страница в windows-1251 читается по-русски', async () => {
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xb8, 0xec]); // «Приём»
    const fetchImpl = async (url) => (url.endsWith('/robots.txt')
      ? new Response(null, { status: 404 })
      : new Response(cp1251, { status: 200, headers: { 'content-type': 'text/html; charset=windows-1251' } }));
    const fetcher = createFetcher({ fetchImpl, ...quiet });
    assert.equal((await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/cp' })).body, 'Приём');
  });
});
