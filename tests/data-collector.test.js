/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сборщик данных: разбор страниц, вежливая загрузка, сравнение снимков,
 * очередь проверки, сборка справочника и проверка госврачей.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { findPersonOnPage, htmlToText, parseJsonLd, parsePriceTables } from '../tools/data/html.js';
import { createFetcher, parseRobots } from '../tools/data/fetchSource.js';
import {
  classifyChange, collectSource, describeChange, diffRecords, extractRecords, verifyDoctorsOnPages,
} from '../tools/data/collector.js';
import { createFileStore, createMemoryStore } from '../tools/data/store.js';
import { buildCatalogFromSnapshots, slugify } from '../tools/data/buildCatalog.js';
import { flattenPrivateCatalog } from '../shared/privateCatalog.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCES = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'sources.json'), 'utf8')).sources;
const ZDOROVIE = SOURCES.find((source) => source.id === 'demo-zdorovie-center-site');
const MALYSH = SOURCES.find((source) => source.id === 'demo-malysh-gorki-site');
const V1 = await fs.readFile(path.join(ROOT, 'data/demo/sites/demo-zdorovie/v1.html'), 'utf8');

const NOW = new Date('2026-10-01T09:00:00Z');
const fileFetcher = createFetcher({ root: ROOT });

/** Поддельный fetch: таблица «адрес → ответ», запоминает запросы. */
const fakeFetch = (routes) => {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const value = typeof route === 'function' ? route(init) : route;
    const status = value.status ?? 200;
    // У 204/304 тела быть не может — Response бросил бы исключение.
    return new Response([204, 304].includes(status) ? null : value.body ?? '', { status, headers: value.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
};

describe('Разбор страниц', () => {
  it('JSON-LD: клиника, часы, координаты и врачи', () => {
    const { clinic, doctors } = parseJsonLd(V1);
    assert.equal(clinic.name, 'Демо-Здоровье');
    assert.equal(clinic.phone, '+7 (843) 000-01-01');
    assert.equal(clinic.hours, 'Mo-Fr 08:00-21:00; Sa 09:00-17:00; Su 10:00-15:00');
    assert.deepEqual([clinic.lat, clinic.lng], [55.7887, 49.1221]);
    assert.equal(doctors.length, 4);
    assert.deepEqual(doctors[1], { name: 'Гарифуллин Рустем Ильдарович', specialty: 'ЛОР', hours: 'Mo,We,Fr 16:00-21:00; Sa 10:00-14:00' });
  });

  it('JSON-LD: массив, employee, jobTitle и битый соседний блок', async () => {
    const html = await fs.readFile(path.join(ROOT, 'data/demo/sites/demo-malysh/v1.html'), 'utf8');
    const { clinic, doctors } = parseJsonLd(html);
    assert.equal(clinic.address, 'Казань, ул. Рихарда Зорге, 999 (демо-адрес)');
    assert.deepEqual(doctors.map((doctor) => doctor.specialty), ['Педиатр', 'Детский ЛОР']);
  });

  it('прайс: цены, &nbsp;, заголовки разделов и сопоставление с услугами', () => {
    const rows = parsePriceTables(V1);
    assert.equal(rows.length, 8, 'строка-заголовок «Терапия» без цены пропущена');
    assert.deepEqual(rows[0], { name: 'Приём (осмотр, консультация) врача-терапевта первичный', price: { min: 1900, max: 1900 }, serviceId: 'consult.therapist.first' });
    assert.equal(rows.find((row) => row.name === 'ОАК').serviceId, 'lab.cbc');
  });

  it('текст страницы без скриптов и тегов', () => {
    const text = htmlToText('<p>Иванова&nbsp;Мария</p><script>var x = "Петров";</script><style>.a{}</style><div>Петрова&#160;Анна</div>');
    assert.match(text, /Иванова Мария/);
    assert.match(text, /Петрова Анна/);
    assert.doesNotMatch(text, /var x/);
  });

  it('врач на странице: фамилия + имя, а не одна фамилия', () => {
    const page = 'Отделение: Иванова Мария Петровна — ЛОР; Сидоров П. А. — хирург; Петрова — медсестра';
    assert.equal(findPersonOnPage(page, 'Иванова Мария Петровна'), true);
    assert.equal(findPersonOnPage(page, 'Сидоров Павел Андреевич'), true, 'инициалы');
    assert.equal(findPersonOnPage(page, 'Петрова Анна Сергеевна'), false, 'однофамилица');
    assert.equal(findPersonOnPage(page, 'Иванова'), false, 'одной фамилии мало');
  });
});

describe('Вежливая загрузка', () => {
  it('robots.txt: своя группа главнее «*», самое длинное правило побеждает', () => {
    const allowed = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: MedKartaBot\nDisallow: /private/\nAllow: /private/doctors/\n');
    assert.equal(allowed('/doctors/'), true);
    assert.equal(allowed('/private/x'), false);
    assert.equal(allowed('/private/doctors/list'), true);
    const strict = parseRobots('User-agent: *\nDisallow: /');
    assert.equal(strict('/anything'), false);
  });

  it('не идёт туда, куда запрещено', async () => {
    const fetchImpl = fakeFetch({
      'https://clinic.example/robots.txt': { body: 'User-agent: *\nDisallow: /secret' },
      'https://clinic.example/secret/page': { body: '<html></html>' },
    });
    const fetcher = createFetcher({ fetchImpl, sleep: async () => {} });
    const result = await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/secret/page' });
    assert.equal(result.status, 'blocked');
    assert.ok(!fetchImpl.calls.some((call) => call.url.endsWith('/secret/page')));
  });

  it('условный запрос: 304 без тела, представляется своим User-Agent', async () => {
    const fetchImpl = fakeFetch({
      'https://clinic.example/robots.txt': { status: 404 },
      'https://clinic.example/page': (init) => (init.headers['If-None-Match'] === '"v1"' ? { status: 304 } : { body: 'x', headers: { etag: '"v1"' } }),
    });
    const fetcher = createFetcher({ fetchImpl, sleep: async () => {} });
    const first = await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/page' });
    assert.equal(first.etag, '"v1"');
    const second = await fetcher.fetchSource({ type: 'http', url: 'https://clinic.example/page' }, { etag: '"v1"' });
    assert.equal(second.status, 'not_modified');
    assert.match(fetchImpl.calls.at(-1).headers['User-Agent'], /^MedKartaBot\//);
  });

  it('файл-источник не выходит за корень проекта', async () => {
    const result = await fileFetcher.fetchSource({ type: 'file', path: '../../etc/passwd' });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'path_outside_root');
  });
});

describe('Сравнение и классификация', () => {
  const v1 = extractRecords(V1);

  it('изменения цен: до 20% — само, больше — на проверку', () => {
    const small = classifyChange({ kind: 'price', change: 'changed', before: { min: 1900, max: 1900 }, after: { min: 1995, max: 1995 } });
    const big = classifyChange({ kind: 'price', change: 'changed', before: { min: 2200, max: 2200 }, after: { min: 3000, max: 3000 } });
    assert.equal(small.decision, 'auto');
    assert.equal(big.decision, 'review');
    assert.match(big.reason, /36%/);
  });

  it('часы — сами; телефон, сайт, адрес, исчезновение врача и специальность — человеку', () => {
    assert.equal(classifyChange({ kind: 'clinic', change: 'changed', field: 'hours' }).decision, 'auto');
    assert.equal(classifyChange({ kind: 'clinic', change: 'changed', field: 'phone' }).decision, 'review');
    assert.equal(classifyChange({ kind: 'clinic', change: 'changed', field: 'website' }).decision, 'review');
    assert.equal(classifyChange({ kind: 'clinic', change: 'changed', field: 'address' }).decision, 'review');
    assert.equal(classifyChange({ kind: 'doctor', change: 'removed', before: { name: 'X' } }).decision, 'review');
    assert.equal(classifyChange({ kind: 'doctor', change: 'changed', field: 'specialty' }).decision, 'review');
    assert.equal(classifyChange({ kind: 'doctor', change: 'changed', field: 'hours' }).decision, 'auto');
  });

  it('одинаковые снимки — без изменений', () => {
    assert.deepEqual(diffRecords(v1, extractRecords(V1)), []);
  });

  it('описания изменений читаются человеком', () => {
    const text = describeChange({ kind: 'price', key: 'consult.lor.first', change: 'changed', before: { min: 2200, max: 2200 }, after: { min: 3000, max: 3000 } });
    assert.equal(text, 'цена «Приём оториноларинголога (ЛОР) первичный»: 2200 ₽ → 3000 ₽');
  });
});

describe('Прогон по источнику', () => {
  it('первый прогон заводит снимок, повторный — только обновляет дату', async () => {
    const store = createMemoryStore();
    const first = await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW });
    assert.equal(first.status, 'created');
    // Единственный пункт — подтвердить новый источник.
    assert.deepEqual(first.review.map((item) => `${item.kind}:${item.change}`), ['source:added']);
    const snapshot = await store.readSnapshot(ZDOROVIE.id);
    assert.equal(snapshot.approved, false);
    assert.equal(snapshot.records.doctors.length, 4);
    assert.equal(snapshot.verifiedAt, '2026-10-01');

    const later = new Date('2026-10-08T09:00:00Z');
    const second = await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: later });
    assert.equal(second.status, 'unchanged');
    assert.equal((await store.readSnapshot(ZDOROVIE.id)).verifiedAt, '2026-10-08');
  });

  it('новая версия страницы: безопасное применяется, рискованное ждёт человека', async () => {
    const store = createMemoryStore();
    await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW });
    const report = await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW, vars: { version: 'v2' } });

    assert.equal(report.status, 'updated');
    const auto = report.auto.map(describeChange);
    assert.ok(auto.some((line) => line.includes('часы работы')));
    assert.ok(auto.some((line) => line.includes('Романова Полина Игоревна')));
    assert.ok(auto.some((line) => line.includes('1900 ₽ → 1995 ₽')));
    assert.deepEqual(report.review.map((item) => item.kind).sort(), ['clinic', 'doctor', 'price', 'unmatched_price']);
    assert.ok(report.review.some((item) => item.kind === 'clinic' && item.field === 'phone'), 'телефон меняет только человек');

    const snapshot = await store.readSnapshot(ZDOROVIE.id);
    assert.equal(snapshot.records.clinic.phone, '+7 (843) 000-01-01');
    assert.ok(snapshot.records.doctors.some((doctor) => doctor.name === 'Соколов Глеб Аркадьевич'), 'пропавший врач остаётся до решения человека');
    assert.equal(snapshot.records.prices.find((price) => price.serviceId === 'consult.lor.first').price.min, 2200, 'резкая цена не применена');
  });

  it('принять и отклонить; отклонённое больше не предлагается', async () => {
    const store = createMemoryStore();
    await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW });
    const report = await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW, vars: { version: 'v2' } });
    const lor = report.review.find((item) => item.kind === 'price');
    const sokolov = report.review.find((item) => item.kind === 'doctor');
    const phone = report.review.find((item) => item.kind === 'clinic');
    const approval = (await store.readPending()).find((item) => item.kind === 'source');

    await store.accept(approval.id);
    await store.accept(lor.id);
    await store.accept(sokolov.id);
    await store.accept(phone.id);
    const snapshot = await store.readSnapshot(ZDOROVIE.id);
    assert.equal(snapshot.approved, true);
    assert.equal(snapshot.records.clinic.phone, '+7 (843) 000-01-11');
    assert.equal(snapshot.records.prices.find((price) => price.serviceId === 'consult.lor.first').price.min, 3000);
    assert.ok(!snapshot.records.doctors.some((doctor) => doctor.name === 'Соколов Глеб Аркадьевич'));

    const unmatched = report.review.find((item) => item.kind === 'unmatched_price');
    await store.reject(unmatched.id);
    // Тот же источник ещё раз «как новый»: отклонённое не возвращается в очередь.
    const fresh = await store.readSnapshot(ZDOROVIE.id);
    fresh.contentHash = 'stale';
    fresh.records.unmatched = [];
    await store.saveSnapshot(fresh);
    const rerun = await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW, vars: { version: 'v2' } });
    assert.ok(!rerun.review.some((item) => item.id === unmatched.id));
    assert.deepEqual(await store.readPending(), []);
  });

  it('массовое исчезновение — всё на проверку, ничего не применяется', async () => {
    const store = createMemoryStore();
    await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW });
    const broken = { ...ZDOROVIE, type: 'file', path: 'tests/fixtures/sites/zdorovie-redesign.html' };
    await fs.mkdir(path.join(ROOT, 'tests/fixtures/sites'), { recursive: true });
    const report = await collectSource({ source: broken, fetcher: fileFetcher, store, now: NOW });
    assert.equal(report.status, 'mass_change');
    assert.equal(report.auto.length, 0);
    assert.ok(report.review.every((item) => /слишком много/.test(item.reason)));
    assert.equal((await store.readSnapshot(ZDOROVIE.id)).records.doctors.length, 4);
  });

  it('страница без разметки — сигнал «сменилась вёрстка», снимок не трогается', async () => {
    const store = createMemoryStore();
    await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW });
    const empty = { ...ZDOROVIE, path: 'tests/fixtures/sites/empty.html' };
    const report = await collectSource({ source: empty, fetcher: fileFetcher, store, now: NOW });
    assert.equal(report.status, 'parse_empty');
    assert.equal((await store.readSnapshot(ZDOROVIE.id)).records.doctors.length, 4);
  });

  it('пробный прогон ничего не записывает', async () => {
    const store = createMemoryStore();
    const report = await collectSource({ source: MALYSH, fetcher: fileFetcher, store, now: NOW, dryRun: true });
    assert.equal(report.status, 'created');
    assert.equal(await store.readSnapshot(MALYSH.id), null);
    assert.deepEqual(await store.readPending(), []);
  });

  it('файловое хранилище: снимок и очередь на диске', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'medkarta-collect-'));
    await fs.mkdir(path.join(root, 'data/demo/sites'), { recursive: true });
    await fs.cp(path.join(ROOT, 'data/demo/sites'), path.join(root, 'data/demo/sites'), { recursive: true });
    const store = createFileStore({ root });
    const fetcher = createFetcher({ root });
    await collectSource({ source: MALYSH, fetcher, store, now: NOW });
    const saved = JSON.parse(await fs.readFile(path.join(root, 'data/collected', `${MALYSH.id}.json`), 'utf8'));
    assert.equal(saved.records.doctors.length, 2);
    const pending = JSON.parse(await fs.readFile(path.join(root, 'data/review/pending.json'), 'utf8'));
    assert.deepEqual(
      pending.map((item) => item.kind),
      ['source', 'unmatched_price'],
      'подтверждение источника и «Приём педиатра на дому» — не приём в клинике',
    );
    await store.accept(pending[0].id);
    assert.equal((await store.readSnapshot(MALYSH.id)).approved, true);
    assert.throws(() => store.readSnapshot('../escape'), /недопустимый id/);
  });
});

describe('Сборка справочника из снимков', () => {
  it('собирает проверенный справочник; демо-источники — только по флагу', async () => {
    const store = createMemoryStore();
    await collectSource({ source: ZDOROVIE, fetcher: fileFetcher, store, now: NOW });
    await collectSource({ source: MALYSH, fetcher: fileFetcher, store, now: NOW });

    const unapproved = buildCatalogFromSnapshots(SOURCES, await store.listSnapshots(), { includeDemo: true });
    assert.equal(unapproved.catalog.clinics.length, 0, 'неподтверждённый источник в справочник не попадает');
    assert.ok(unapproved.skipped.every((line) => /не подтверждён/.test(line)));

    for (const item of await store.readPending()) {
      if (item.kind === 'source') await store.accept(item.id);
    }
    const snapshots = await store.listSnapshots();

    const plain = buildCatalogFromSnapshots(SOURCES, snapshots);
    assert.equal(plain.catalog.clinics.length, 0, 'демо не попадает в обычную сборку');

    const { catalog, errors, skipped } = buildCatalogFromSnapshots(SOURCES, snapshots, { includeDemo: true });
    assert.deepEqual(errors, []);
    assert.deepEqual(skipped, []);
    assert.equal(catalog.clinics.length, 2);
    assert.equal(catalog.meta.verifiedAt, '2026-10-01');
    const items = flattenPrivateCatalog(catalog);
    const lor = items.find((item) => item.name === 'Фаткуллин Ильназ Рамилевич');
    assert.equal(lor.features.children, true);
    assert.equal(lor.consultPrice, 2100);
    assert.equal(lor.sourceUrl, null);
  });

  it('без координат источник пропускается с понятной причиной', async () => {
    const store = createMemoryStore();
    const noGeo = { ...MALYSH, geo: undefined };
    await collectSource({ source: noGeo, fetcher: fileFetcher, store, now: NOW });
    for (const item of await store.readPending()) {
      if (item.kind === 'source') await store.accept(item.id);
    }
    const { skipped } = buildCatalogFromSnapshots([noGeo], await store.listSnapshots(), { includeDemo: true });
    assert.match(skipped[0], /нет координат/);
  });

  it('транслитерация id врача', () => {
    assert.equal(slugify('Фаткуллин Ильназ Рамилевич'), 'fatkullin-ilnaz-ramilevich');
    assert.equal(slugify('Щукина Юлия'), 'schukina-yuliya');
  });
});

describe('Проверка госврачей на страницах учреждений', () => {
  it('одна загрузка на страницу; на месте / не найден / недоступна', async () => {
    const fetchImpl = fakeFetch({
      'https://hospital.example/robots.txt': { status: 404 },
      'https://hospital.example/lor': { body: '<h2>ЛОР-отделение</h2><p>Иванова Мария Петровна, врач-оториноларинголог</p>' },
      'https://down.example/robots.txt': { status: 404 },
    });
    const fetcher = createFetcher({ fetchImpl, sleep: async () => {} });
    const results = await verifyDoctorsOnPages({
      now: NOW,
      fetcher,
      doctors: [
        { id: 'd1', name: 'Иванова Мария Петровна', sourceUrl: 'https://hospital.example/lor' },
        { id: 'd2', name: 'Петров Олег Ильич', sourceUrl: 'https://hospital.example/lor' },
        { id: 'd3', name: 'Сидорова Анна', sourceUrl: 'https://down.example/page' },
        { id: 'd4', name: 'Без ссылки', sourceUrl: null },
      ],
    });
    assert.deepEqual(results.d1, { status: 'present', checkedAt: '2026-10-01', verifiedAt: '2026-10-01' });
    assert.equal(results.d2.status, 'missing');
    assert.equal(results.d3.status, 'unreachable');
    assert.equal(results.d4, undefined);
    assert.equal(fetchImpl.calls.filter((call) => call.url === 'https://hospital.example/lor').length, 1);
  });
});
