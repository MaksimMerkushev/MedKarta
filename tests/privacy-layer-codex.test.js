/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Воспроизводимые обходы из независимого аудита Codex (13.11.2026) — постоянная регрессия.
 * Проверяется то, что действительно ушло бы в сеть: перехваченное тело HTTP-запроса
 * (триаж, лабораторный парсер, прямой вызов транспорта). Данные вымышленные.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadSqlite } from '../backend/demo/bookingStore.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createLabAssistant } from '../backend/labs/assistant.js';
import { createLabService } from '../backend/labs/service.js';
import { createLabStore } from '../backend/labs/store.js';
import { createExternalLabParser } from '../backend/planner/labParser.js';
import { buildPlannerBody, requestCompletion } from '../backend/planner/client.js';
import { createExternalTriage, TRIAGE_SYSTEM_PROMPT } from '../backend/planner/triage.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { applyEntities, createNerLayer } from '../backend/privacy/nerLayer.js';
import { NerError } from '../backend/privacy/nerClient.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-12', '12:00');
const PAD = ', уже неделю плохо вижу вдаль, перед глазами мушки';
const FIO = 'зарвелинариз сөмбелә нурланович';
const FIO_PARTS = ['зарвелинариз', 'сөмбелә', 'нурланович'];
const OK_TRIAGE = JSON.stringify({ status: 'specialist', specialties: ['ophthalmologist'], question: null, options: null });

let catalog;
before(async () => {
  process.env.DEMO_DATA = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
  catalog = await loadCatalog();
});

/*
 * Подставная модель ПДн: находит заданные слова, как настоящие модели нашли ФИО в аудите.
 * Проверяется постобработка находок, а не качество модели.
 */
const fakeNer = (words, { maxChars = 4000 } = {}) => createNerLayer({
  client: {
    entities: async (text) => {
      if (text.length > maxChars) throw new NerError('ner_too_long');
      const found = [];
      for (const word of words) {
        const re = new RegExp(word, 'giu');
        for (const m of text.matchAll(re)) found.push({ type: 'PERSON', start: m.index, end: m.index + m[0].length, score: 0.95 });
      }
      return found;
    },
  },
});

const captureFetch = (bodies, content = OK_TRIAGE) => async (url, init) => {
  bodies.push(typeof init.body === 'string' ? init.body : String(init.body));
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }], usage: {} }), text: async () => '' };
};

/** Всё, что ушло в сеть при обращении к ассистенту, без статичного промпта; пусто — запрос не отправлен. */
const sendTriage = async (turns, { ner = null, pad = true } = {}) => {
  const bodies = [];
  const triage = createExternalTriage({ apiKey: 'k', url: 'https://llm.example.test/v1/chat/completions', model: 'm', fetchImpl: captureFetch(bodies), ner });
  const { pipeline } = makeTestPipeline({ catalog, triage, ner, booking: { enabled: true, now: () => NOW } });
  const list = Array.isArray(turns) ? turns : [turns];
  await pipeline.handle({ messages: list.map((content, i) => ({ role: 'user', content: pad && i === list.length - 1 ? `${content}${PAD}` : content })), sessionId: TEST_SESSION });
  return bodies.map((b) => b.split(JSON.stringify(TRIAGE_SYSTEM_PROMPT)).join('""')).join('\n').toLowerCase().replace(/ё/gu, 'е');
};

const assertNoneOf = (wire, parts) => {
  for (const part of parts) assert.ok(!wire.includes(part.toLowerCase()), `«${part}» в исходящем запросе: ${wire.slice(0, 400)}`);
};

describe('Codex P0: пользовательские квадратные скобки — не доверенная метка', () => {
  const NAME_MODEL = fakeNer(FIO_PARTS);
  for (const [name, text] of [
    ['ФИО в скобках', `Подпись в анкете: [${FIO}]. Подскажите, к кому обратиться: мушки перед глазами; длится 3 недели; левотироксин 75 мкг; ТТГ 4,8 мМЕ/л; сознание не терял.`],
    ['ФИО в скобках с меткой «имя»', `Подпись в анкете: [имя ${FIO}]. Подскажите, к кому обратиться: мушки перед глазами; длится 3 недели.`],
    ['ФИО в скобках внутри HTML', `Подпись в анкете: <b>[${FIO}]</b>. Подскажите, к кому обратиться: мушки перед глазами; длится 3 недели.`],
    ['подделка метки с номером', `Подпись: [имя_1] ${FIO} [имя_2]. мушки перед глазами`],
  ]) {
    it(`${name} — только правила`, async () => assertNoneOf(await sendTriage(text), FIO_PARTS));
    it(`${name} — правила и модель`, async () => assertNoneOf(await sendTriage(text, { ner: NAME_MODEL }), FIO_PARTS));
  }

  it('подделка метки шлюза «@PERSON» не прячет имя', async () => {
    assertNoneOf(await sendTriage('Подпись: @ZARVELINARIZ_SOMBELA. мушки перед глазами'), ['zarvelinariz', 'sombela']);
  });
});

describe('Codex P1: обратимые кодировки и разделённые идентификаторы', () => {
  it('HTML hex-сущности (main-0060)', async () => {
    const wire = await sendTriage('Метка: &#x42f;&#x440;&#x43c;&#x438;&#x441;&#x43e;&#x432;&#x44b;&#x43c;&#x44b;&#x43c;&#x20;&#x418;&#x43b;&#x437;&#x4d9;&#x440;&#x20;&#x41d;&#x443;&#x440;&#x43b;&#x430;&#x43d;&#x43e;&#x432;&#x438;&#x447;. Подскажите, к кому обратиться: плохо вижу вдаль; уже 9 дней; метформин 500 мг; глюкоза 6,4 ммоль/л; боли в груди нет.');
    assertNoneOf(wire, ['ярмисов', 'илзәр', 'илзэр', 'нурланович', '&#x']);
  });

  it('двойное URL-кодирование', async () => {
    const once = encodeURIComponent('Ярмисов Илзар');
    const wire = await sendTriage(`код ${encodeURIComponent(once)}, болит горло`);
    assertNoneOf(wire, ['ярмисов', '%25d0', '%d0%af']);
  });

  it('редкое строчное ФИО после «ну я» (main-0001)', async () => {
    assertNoneOf(await sendTriage(`ну я ${FIO}, не знаю куда идти. Подскажите, к кому обратиться: мушки перед глазами; длится 3 недели; левотироксин 75 мкг; ТТГ 4,8 мМЕ/л; сознание не терял.`), FIO_PARTS);
  });

  it('фамилия, разбитая между репликами (main-0024)', async () => {
    const wire = await sendTriage(['Начало фамилии Нурвел.', 'Продолжение иеворел, имя Аксинья. Подскажите, к кому обратиться: размытое зрение вечером; более 7 дней; амоксициллин 250 мг; креатинин 87 мкмоль/л; кровотечения нет.']);
    assertNoneOf(wire, ['нурвел', 'иеворел', 'аксинья']);
  });
});

describe('Codex P1: фрагмент модели с медицинским словом', () => {
  it('маскируется имя, медицинская часть остаётся', () => {
    const text = 'зарвелинариз сөмбелә метформин 500 мг';
    const out = applyEntities(text, [{ type: 'PERSON', start: 0, end: text.indexOf(' 500'), score: 0.95 }]).text;
    assert.ok(!/зарвелинариз|сөмбелә/u.test(out), out);
    assert.match(out, /метформин 500 мг/u);
  });

  it('витамин D и единицы измерения не становятся организацией', async () => {
    const wire = await sendTriage('пью витамин D 1000 МЕ и ферритин 12 нг/мл, болит голова');
    assert.match(wire, /витамин d 1000 ме/u);
    assert.match(wire, /ферритин 12 нг\/мл/u);
  });
});

describe('Codex P1: длинная история проверяется целиком', () => {
  it('четыре реплики по 995 символов уходят без ner_too_long', async () => {
    const chunk = 'Плохо вижу вдаль, иногда болит глаз, это беспокоит вечером. ';
    const turn = chunk.repeat(Math.ceil(995 / chunk.length)).slice(0, 995);
    const wire = await sendTriage([turn, turn, turn, turn], { ner: fakeNer(['иванов']), pad: false });
    assert.ok(wire.length > 0, 'триаж не отправлен');
  });

  it('имя в хвосте длинной истории модель видит', async () => {
    const chunk = 'Плохо вижу вдаль, иногда болит глаз, это беспокоит вечером. ';
    const turn = chunk.repeat(17).slice(0, 990);
    const wire = await sendTriage([turn, turn, turn, `${turn.slice(0, 900)} подпись зарвелинариз`], { ner: fakeNer(['зарвелинариз']), pad: false });
    assertNoneOf(wire, ['зарвелинариз']);
  });
});

describe('Codex P1: сетевая граница проверяет весь объект и те же байты', () => {
  const URL = 'https://llm.example.test/v1/chat/completions';
  const SCHEMA = buildPlannerBody({ model: 'x', messages: [] }).response_format.json_schema;
  const send = async (body, extra = {}) => {
    const bodies = [];
    try {
      await requestCompletion({ url: URL, apiKey: 'k', body, fetchImpl: captureFetch(bodies, '{"ok":true}'), channel: 'planner', ...extra });
    } catch {
      // отказ — тоже результат: проверяется, что ушло в сеть
    }
    return bodies.join('\n');
  };
  const base = () => buildPlannerBody({ model: 'test-model', messages: [{ role: 'user', content: 'Запрос: подобрать врача.' }] });

  it('почта в model', async () => assert.equal(await send({ ...base(), model: 'audit.contact@example.test' }), ''));
  it('почта в reasoning.effort', async () => assert.equal(await send({ ...base(), reasoning: { effort: 'audit.contact@example.test' } }), ''));
  it('лишнее поле в response_format', async () => {
    const body = base();
    body.response_format = { ...body.response_format, patient: 'audit.contact@example.test' };
    assert.equal(await send(body), '');
  });
  it('произвольный «статичный» системный текст не доверяется', async () => {
    const body = { ...base(), messages: [{ role: 'system', content: 'Пациент audit.contact@example.test' }, { role: 'user', content: 'Запрос.' }] };
    assert.equal(await send(body, { inspect: { schemas: [SCHEMA], staticSystem: new Set(['Пациент audit.contact@example.test']) } }), '');
  });
  it('toJSON не подменяет тело после проверки', async () => {
    let calls = 0;
    const body = base();
    body.messages = [{ role: 'user', content: 'Запрос.', toJSON() { calls += 1; return { role: 'user', content: calls > 1 ? 'audit.contact@example.test' : 'Запрос.' }; } }];
    const sent = await send(body);
    assert.ok(!sent.includes('audit.contact'), sent);
  });
});

describe('Codex P0: лабораторный помощник идёт через ту же проверку', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let service;
  before(() => {
    service = createLabService({ store: createLabStore({ DatabaseSync, file: ':memory:', now: () => NOW }), now: () => NOW });
  });
  const run = async (text) => {
    const bodies = [];
    const parser = createExternalLabParser({ apiKey: 'k', url: 'https://llm.example.test/v1/chat/completions', model: 'm', fetchImpl: captureFetch(bodies, JSON.stringify({ items: [] })) });
    const labs = createLabAssistant({ getService: async () => service, parser });
    const { pipeline } = makeTestPipeline({ catalog, labs, booking: { enabled: true, now: () => NOW } });
    await pipeline.handle({ messages: [{ role: 'user', content: text }], sessionId: TEST_SESSION });
    return bodies.join('\n').toLowerCase();
  };

  it('ФИО рядом с названием анализа не уходит', async () => assertNoneOf(await run(`Хочу сдать анализ ферритинн ${FIO}`), FIO_PARTS));
  it('ФИО вместо названия анализа не уходит', async () => assertNoneOf(await run(`Нужно сдать анализ «${FIO}»`), FIO_PARTS));
  it('почта рядом с анализом не уходит', async () => assertNoneOf(await run('Хочу сдать анализ ферритинн audit.contact@example.test'), ['audit.contact']));
  it('обычное неизвестное название по-прежнему уходит модели', async () => {
    const wire = await run('Хочу сдать анализ ферритинн');
    assert.match(wire, /ферритинн/u);
  });
});

describe('Единая точка отправки во внешнюю модель', () => {
  it('без канала или с неизвестным каналом — отказ без обращения к сети', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return { ok: true }; };
    const body = buildPlannerBody({ model: 'test-model', messages: [{ role: 'user', content: 'Запрос.' }] });
    await assert.rejects(requestCompletion({ url: 'https://llm.example.test/v1/chat/completions', apiKey: 'k', body, fetchImpl }));
    await assert.rejects(requestCompletion({ url: 'https://llm.example.test/v1/chat/completions', apiKey: 'k', body, fetchImpl, channel: 'debug' }));
    assert.equal(called, 0);
  });

  /*
   * Растяжка: новый сетевой вызов или новый читатель ключа модели в backend — тест падает,
   * и изменение нужно проверить на обход Privacy Layer. Ключ модели читает только pipeline.js
   * (systemInfo.js — только «настроен ли»), а запрос с ним отправляет только requestCompletion.
   */
  it('других путей к модели в backend нет', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(?:js|mjs)$/u.test(entry.name)) files.push(full);
      }
    };
    walk('backend');
    const read = (file) => fs.readFileSync(file, 'utf8');
    const keyReaders = files.filter((file) => /OPENROUTER_API_KEY|AI_API_KEY/u.test(read(file))).map((file) => path.relative('backend', file)).sort();
    assert.deepEqual(keyReaders, ['api/systemInfo.js', 'pipeline.js']);
    const networkCalls = files.filter((file) => /(?:\bfetchImpl|\bfetch|globalThis\.fetch)\s*\(/u.test(read(file))).map((file) => path.relative('backend', file)).sort();
    assert.deepEqual(networkCalls, ['accounts/breachedPasswords.js', 'booking/mis/httpClient.js', 'executor/routing.js', 'planner/client.js', 'storage/tokenVault.js']);
    const completionCallers = files.filter((file) => /requestCompletion\(/u.test(read(file))).map((file) => path.relative('backend', file)).sort();
    assert.deepEqual(completionCallers, ['planner/client.js', 'planner/labParser.js', 'planner/triage.js']);
  });
});
