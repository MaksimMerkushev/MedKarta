/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Продуктовая аналитика: закрытый словарь событий, журнал, приём и отчёт.
 *
 * Главное свойство, которое здесь проверяется: в журнал не может попасть
 * ничего, кроме перечислимых значений. Ни текста запроса, ни координат,
 * ни IP — даже если клиент их пришлёт.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ANALYTICS_LIMITS, ownershipCode, sanitizeEvent } from '../shared/analytics.js';
import { isPediatricRecord, specialtyCode } from '../shared/specialties.js';
import { createEventStore } from '../backend/analytics/eventStore.js';
import { buildReport, formatReport } from '../backend/analytics/report.js';
import { createEventsHandler } from '../backend/api/events.js';

const SID = 'sess_abcdefgh1234';

const search = (extra = {}) => ({
  type: 'search', sid: SID, source: 'filters', filters: ['profile'], results: 12, ...extra,
});

/** Минимальные запрос и ответ для обработчика без поднятия сервера. */
const makeReq = ({ method = 'POST', body, headers = {} } = {}) => ({
  method,
  body,
  headers: { host: 'medkarta.test', ...headers },
  socket: { remoteAddress: '203.0.113.7' },
});

const makeRes = () => {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(chunk) { this.body = chunk ?? null; this.writableEnded = true; },
  };
  return res;
};

const memoryStore = () => {
  const written = [];
  return {
    written,
    async append(events) {
      written.push(...events);
      return { accepted: events.length, dropped: 0 };
    },
  };
};

const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'medkarta-analytics-'));

describe('Словарь событий', () => {
  it('пропускает корректное событие поиска и упорядочивает фильтры', () => {
    const event = sanitizeEvent(search({ filters: ['open', 'children', 'profile'], specialty: 'lor', maxTravel: 20 }));
    assert.deepEqual(event, {
      v: 1,
      type: 'search',
      sid: SID,
      source: 'filters',
      specialty: 'lor',
      filters: ['children', 'open', 'profile'],
      results: 12,
      maxTravel: 20,
    });
  });

  it('отбрасывает событие целиком, если в нём есть лишнее поле', () => {
    // Текст запроса — сведения о здоровье. Его нельзя «обрезать», только не принять.
    assert.equal(sanitizeEvent(search({ query: 'болит ухо у сына' })), null);
    assert.equal(sanitizeEvent(search({ lat: 55.79, lng: 49.12 })), null);
    assert.equal(sanitizeEvent(search({ ip: '203.0.113.7' })), null);
  });

  it('не принимает свободный текст в перечислимых полях', () => {
    assert.equal(sanitizeEvent(search({ specialty: 'психиатр для мамы' })), null);
    assert.equal(sanitizeEvent(search({ source: 'chat: болит голова' })), null);
    assert.equal(sanitizeEvent(search({ filters: ['profile', 'Иванов'] })), null);
    assert.equal(sanitizeEvent(search({ filters: 'profile' })), null);
  });

  it('проверяет границы чисел', () => {
    assert.equal(sanitizeEvent(search({ results: -1 })), null);
    assert.equal(sanitizeEvent(search({ results: 1.5 })), null);
    assert.equal(sanitizeEvent(search({ results: ANALYTICS_LIMITS.MAX_RESULTS + 1 })), null);
    assert.equal(sanitizeEvent(search({ maxTravel: 3 })), null);
    assert.equal(sanitizeEvent(search({ results: '12' })), null);
  });

  it('требует идентификатор сессии нужного формата', () => {
    assert.equal(sanitizeEvent({ ...search(), sid: undefined }), null);
    assert.equal(sanitizeEvent({ ...search(), sid: 'short' }), null);
    assert.equal(sanitizeEvent({ ...search(), sid: 'Иван Петров +79991234567' }), null);
  });

  it('принимает идентификатор места, но не произвольную строку', () => {
    const base = { type: 'contact_click', sid: SID, channel: 'phone', kind: 'doctor' };
    assert.equal(sanitizeEvent({ ...base, placeId: 'verified-mkdc-4' }).placeId, 'verified-mkdc-4');
    assert.equal(sanitizeEvent({ ...base, placeId: 'osm-node-8752578534' }).placeId, 'osm-node-8752578534');
    assert.equal(sanitizeEvent({ ...base, placeId: 'ул. Баумана, 5' }), null);
    assert.equal(sanitizeEvent({ ...base, placeId: 'x'.repeat(81) }), null);
  });

  it('причина бывает только у ответа «нет»', () => {
    const base = { type: 'feedback', sid: SID, context: 'list' };
    assert.ok(sanitizeEvent({ ...base, answer: 'no', reason: 'too_far' }));
    assert.ok(sanitizeEvent({ ...base, answer: 'yes' }));
    assert.equal(sanitizeEvent({ ...base, answer: 'yes', reason: 'too_far' }), null);
    assert.equal(sanitizeEvent({ ...base, answer: 'no', reason: 'врач нахамил' }), null);
  });

  it('сообщение о неверных данных требует место', () => {
    const base = { type: 'data_report', sid: SID, reason: 'wrong_hours', kind: 'facility' };
    assert.equal(sanitizeEvent(base), null);
    assert.ok(sanitizeEvent({ ...base, placeId: 'osm-way-243042805' }));
  });

  it('не принимает неизвестный тип и не-объекты', () => {
    for (const value of [null, 'search', [search()], { ...search(), type: 'page_view' }]) {
      assert.equal(sanitizeEvent(value), null);
    }
  });

  it('код формы собственности', () => {
    assert.equal(ownershipCode('Государственная'), 'state');
    assert.equal(ownershipCode('Частная'), 'private');
    assert.equal(ownershipCode(undefined), 'unknown');
  });
});

describe('Специальности и детский приём', () => {
  it('сводит названия справочника к каноническому коду', () => {
    assert.equal(specialtyCode('Детский ЛОР'), 'lor');
    assert.equal(specialtyCode('ЛОР'), 'lor');
    assert.equal(specialtyCode('Педиатр'), 'pediatrician');
    assert.equal(specialtyCode('Кардиолог'), 'cardiologist');
    assert.equal(specialtyCode('Неонатолог'), 'other');
    assert.equal(specialtyCode('all'), null);
    assert.equal(specialtyCode(''), null);
  });

  it('узкая хирургия не принимается за общую по подстроке', () => {
    // «Кардиохирург» — одно слово: «хирург» внутри него не совпадение.
    assert.equal(specialtyCode('Кардиохирург'), 'other');
    assert.equal(specialtyCode('Сосудистый хирург'), 'surgeon');
  });

  it('распознаёт детский приём по профилю и учреждению', () => {
    assert.equal(isPediatricRecord({ specialty: 'Детский ЛОР' }), true);
    assert.equal(isPediatricRecord({ specialty: 'Педиатр' }), true);
    assert.equal(isPediatricRecord({ specialty: 'Неонатолог' }), true);
    assert.equal(isPediatricRecord({ specialty: 'Кардиолог', clinic: 'ГАУЗ «Детская республиканская клиническая больница»' }), true);
    assert.equal(isPediatricRecord({ specialty: 'Кардиолог', clinic: 'ГАУЗ «Городская больница № 7»' }), false);
    assert.equal(isPediatricRecord({ specialty: 'Терапевт', features: { children: true } }), true);
    assert.equal(isPediatricRecord(null), false);
  });
});

describe('Журнал событий', () => {
  it('пишет по файлу на день, с минутной точностью и без IP', async () => {
    const dir = await tempDir();
    const store = createEventStore({ dir, now: () => new Date('2026-10-01T09:15:42.123Z') });
    await store.append([sanitizeEvent(search())]);

    const text = await fs.readFile(path.join(dir, 'events-2026-10-01.jsonl'), 'utf8');
    const record = JSON.parse(text.trim());
    assert.equal(record.ts, '2026-10-01T09:15Z');
    assert.equal(record.type, 'search');
    assert.ok(!('ip' in record));
  });

  it('день считается по Казани', async () => {
    const dir = await tempDir();
    // 22:30 UTC — это уже 01:30 следующего дня в Казани.
    const store = createEventStore({ dir, now: () => new Date('2026-10-01T22:30:00Z') });
    await store.append([sanitizeEvent(search())]);
    assert.deepEqual(await fs.readdir(dir), ['events-2026-10-02.jsonl']);
  });

  it('соблюдает суточный потолок, в том числе после перезапуска', async () => {
    const dir = await tempDir();
    const now = () => new Date('2026-10-01T09:00:00Z');
    const first = createEventStore({ dir, now, maxEventsPerDay: 5 });
    const events = Array.from({ length: 4 }, () => sanitizeEvent(search()));
    assert.deepEqual(await first.append(events), { accepted: 4, dropped: 0 });

    // Новый экземпляр — как после перезапуска сервера: счётчик читается из файла.
    const second = createEventStore({ dir, now, maxEventsPerDay: 5 });
    assert.deepEqual(await second.append(events), { accepted: 1, dropped: 3 });
    const lines = (await fs.readFile(path.join(dir, 'events-2026-10-01.jsonl'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 5);
  });

  it('параллельные записи не перемешивают строки', async () => {
    const dir = await tempDir();
    const store = createEventStore({ dir });
    await Promise.all(Array.from({ length: 30 }, (_, index) => store.append([sanitizeEvent(search({ results: index }))])));
    const [file] = await fs.readdir(dir);
    const lines = (await fs.readFile(path.join(dir, file), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 30);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });

  it('удаляет только свои старые файлы', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'events-2026-01-01.jsonl'), '');
    await fs.writeFile(path.join(dir, 'events-2026-09-30.jsonl'), '');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'не трогать');
    const store = createEventStore({ dir, retentionDays: 30, now: () => new Date('2026-10-01T09:00:00Z') });
    assert.equal(await store.prune(), 1);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['events-2026-09-30.jsonl', 'notes.txt']);
  });
});

describe('Эндпоинт /api/events', () => {
  it('принимает пачку, пишет только корректные события и отвечает 204', async () => {
    const store = memoryStore();
    const handler = createEventsHandler({ store, rateLimit: () => ({ allowed: true }) });
    const res = makeRes();
    await handler(makeReq({ body: { events: [search(), search({ query: 'болит живот' }), { type: 'route_build', sid: SID, mode: 'foot', stops: 2, outcome: 'ok' }] } }), res);

    assert.equal(res.statusCode, 204);
    assert.equal(store.written.length, 2);
    assert.ok(store.written.every((event) => !JSON.stringify(event).includes('живот')));
  });

  it('принимает одиночное событие', async () => {
    const store = memoryStore();
    const handler = createEventsHandler({ store, rateLimit: () => ({ allowed: true }) });
    const res = makeRes();
    await handler(makeReq({ body: search() }), res);
    assert.equal(res.statusCode, 204);
    assert.equal(store.written.length, 1);
  });

  it('отклоняет слишком большую пачку и пустой запрос', async () => {
    const handler = createEventsHandler({ store: memoryStore(), rateLimit: () => ({ allowed: true }) });
    for (const body of [{ events: Array.from({ length: ANALYTICS_LIMITS.MAX_BATCH + 1 }, () => search()) }, { events: [] }, {}]) {
      const res = makeRes();
      await handler(makeReq({ body }), res);
      assert.equal(res.statusCode, 400);
    }
  });

  it('проверяет метод, источник и лимит', async () => {
    const handler = createEventsHandler({ store: memoryStore(), rateLimit: () => ({ allowed: false, retryAfterSeconds: 9 }) });

    const get = makeRes();
    await handler(makeReq({ method: 'GET' }), get);
    assert.equal(get.statusCode, 405);

    const foreign = makeRes();
    await handler(makeReq({ body: search(), headers: { origin: 'https://evil.example' } }), foreign);
    assert.equal(foreign.statusCode, 403);

    const limited = makeRes();
    await handler(makeReq({ body: search() }), limited);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '9');
  });

  it('ошибка записи не превращается в ошибку для пользователя', async () => {
    const handler = createEventsHandler({
      store: { append: async () => { throw new Error('disk full'); } },
      rateLimit: () => ({ allowed: true }),
    });
    const res = makeRes();
    await handler(makeReq({ body: search() }), res);
    assert.equal(res.statusCode, 204);
  });
});

describe('Отчёт по поискам', () => {
  const events = [
    // Сессия 1: искала ЛОРа, позвонила — успешный поиск.
    { type: 'search', sid: 'session-one-01', source: 'assistant', specialty: 'lor', filters: ['children', 'profile'], results: 4 },
    { type: 'result_open', sid: 'session-one-01', surface: 'list', kind: 'doctor', rank: 1, placeId: 'verified-1' },
    { type: 'contact_click', sid: 'session-one-01', channel: 'phone', kind: 'doctor', placeId: 'verified-1' },
    // Сессия 2: пустая выдача, затем другой поиск без действия, «не нашёл».
    { type: 'search', sid: 'session-two-02', source: 'filters', specialty: 'dermatologist', filters: ['profile', 'weekend'], results: 0 },
    { type: 'search', sid: 'session-two-02', source: 'filters', specialty: 'dermatologist', filters: ['profile'], results: 3 },
    { type: 'feedback', sid: 'session-two-02', context: 'list', answer: 'no', reason: 'too_far' },
    // Сессия 3: только сообщила об ошибке в данных.
    { type: 'data_report', sid: 'session-three3', reason: 'wrong_hours', kind: 'facility', placeId: 'osm-node-1' },
  ];

  it('считает успешные поиски, пустую выдачу и воронку', () => {
    const report = buildReport(events);
    assert.equal(report.searches.total, 3);
    assert.equal(report.searches.successful, 1);
    assert.equal(report.searches.zeroResults, 1);
    assert.equal(report.funnel.sessions, 3);
    assert.equal(report.funnel.searched, 2);
    assert.equal(report.funnel.acted, 1);
    assert.deepEqual(report.zeroResults.byFilter, { profile: 1, weekend: 1 });
    assert.deepEqual(report.feedback.reasons, { too_far: 1 });
    assert.deepEqual(report.contacts.topPlaces, { 'verified-1': 1 });
    assert.deepEqual(report.dataReports.topPlaces, { 'osm-node-1': 1 });

    const lor = report.bySpecialty.find((row) => row.specialty === 'lor');
    assert.equal(lor.successRate, 100);
    const derma = report.bySpecialty.find((row) => row.specialty === 'dermatologist');
    assert.deepEqual([derma.searches, derma.successful, derma.zeroResults], [2, 0, 1]);
  });

  it('пустой журнал не ломает отчёт', () => {
    const report = buildReport([]);
    assert.equal(report.searches.successRate, null);
    assert.match(formatReport(report), /Сессий: 0/);
  });

  it('текстовый отчёт читается человеком', () => {
    const text = formatReport(buildReport(events), { period: '2026-10-01 — 2026-10-07' });
    assert.match(text, /успешных: 1/);
    assert.match(text, /далеко: 1/);
    assert.match(text, /неверные часы: 1/);
  });
});
