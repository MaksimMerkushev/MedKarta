/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Пропуски обезличивания, найденные аудитом 13.11.2026 перехватом исходящих
 * запросов: номер полиса нестандартного вида, должность из двух слов, вторая
 * часть двойной фамилии. Проверка и на уровне функции, и на том, что физически
 * уходит модели-триажу. Данные вымышленные, модель — подставной fetch.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createExternalTriage } from '../backend/planner/triage.js';
import { deidentifyComplaint, hasDocumentNumber } from '../backend/privacy/deidentify.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const clean = (text) => deidentifyComplaint(text).text;

describe('Обезличивание: номера документов и длинные номера', () => {
  it('номер полиса в любом виде — реплика наружу не уходит', () => {
    for (const phrase of [
      'по полису ДМС Согаз номер 001-ДМС-778899 болит спина',
      'номер полиса AB1234567, болит горло',
      'полис ОМС 1655 4400 1234 5678, температура',
      'паспорт 92 04 123456, болит зуб',
      'по договору № 45-778/2026 лечусь, колено болит',
    ]) {
      const result = deidentifyComplaint(phrase);
      assert.equal(result.blocked, true, phrase);
      assert.equal(result.reason, 'document_number', phrase);
      assert.equal(result.text, '', phrase);
    }
  });

  it('слово «полис» без номера и год рядом с ним реплику не останавливают', () => {
    for (const phrase of ['по полису ДМС, болит спина третий день', 'по полису ДМС в 2024 году лечила спину, сейчас снова болит', 'полис есть, болит горло 3 дня']) {
      assert.equal(hasDocumentNumber(phrase), false, phrase);
      assert.equal(deidentifyComplaint(phrase).blocked, false, phrase);
    }
  });

  it('длинный номер без пояснения заменяется меткой', () => {
    assert.equal(clean('код 778899, болит спина'), 'код [номер], болит спина');
    assert.equal(clean('мне выдали AB1234567, болит горло'), 'мне выдали [номер], болит горло');
    assert.equal(clean('записан под 1655 4400 1234 5678, кашель'), 'записан под [номер], кашель');
  });

  it('медицински значимые числа остаются', () => {
    for (const phrase of [
      'давление 160/100 второй день',
      'температура 38.5 три дня',
      'в 2024г была операция на колене',
      'пью 1000мг парацетамола, голова не проходит',
      'болит с 18:00, до 2000 рублей',
      'ковид-19 был месяц назад, кашель остался',
      'беременность 8 недель, тошнит',
    ]) {
      assert.equal(clean(phrase), phrase, phrase);
    }
  });
});

describe('Обезличивание: должности из двух слов', () => {
  it('«главный врач» и похожие заменяются меткой', () => {
    const text = clean('я главный врач поликлиники Советского района, давление скачет');
    assert.doesNotMatch(text, /главн|врач/iu);
    assert.match(text, /\[должность\]/u);
    assert.match(text, /давление скачет/u);
    for (const phrase of ['работаю заместителем главного врача, болит спина', 'я руководитель отдела в банке, болит голова', 'председатель совета дома, кашель', 'главная медсестра отделения, бессонница']) {
      assert.doesNotMatch(clean(phrase), /главн|заместител|руководител|председател/iu, phrase);
    }
  });

  it('обычная работа и слово «главный» в другом смысле остаются', () => {
    assert.equal(clean('Я учитель, постоянно срываю голос'), 'Я учитель, постоянно срываю голос');
    assert.equal(clean('главная проблема — кашель по ночам'), 'главная проблема — кашель по ночам');
    assert.equal(clean('работаю медсестрой, болит поясница'), 'работаю медсестрой, болит поясница');
  });
});

describe('Обезличивание: двойная фамилия', () => {
  it('часть фамилии через дефис рядом с меткой имени не остаётся', () => {
    assert.equal(clean('Меня зовут @PERSON_A-Вандербильт, болит колено'), 'Меня зовут [имя], болит колено');
    assert.equal(clean('Вандербильт-@PERSON_A, болит колено'), '[имя], болит колено');
    assert.equal(clean('я @PERSON_A-оглы, болит горло'), 'я [имя], болит горло');
  });
});

describe('Новые правила не замедляют разбор длинного ввода', () => {
  for (const [name, text] of [
    ['одно длинное слово', 'а'.repeat(20_000)],
    ['слово и дефис', `${'а'.repeat(20_000)}-`],
    ['длинное число', '1'.repeat(20_000)],
    ['числа через пробел', '12 '.repeat(7_000)],
    ['слова через дефис', 'аб-'.repeat(7_000)],
  ]) {
    it(`${name}: меньше 300 мс`, () => {
      const started = performance.now();
      deidentifyComplaint(text);
      hasDocumentNumber(`полис ${text}`);
      assert.ok(performance.now() - started < 300, `${Math.round(performance.now() - started)} мс`);
    });
  }
});

describe('Что уходит модели-триажу: случаи из аудита 13.11.2026', () => {
  const NOW = moscowMoment('2026-10-12', '12:00');
  const PAD = ', уже неделю плохо вижу вдаль, перед глазами мушки, к вечеру сильно устают глаза и немеют пальцы на правой руке';
  let catalog;
  before(async () => {
    process.env.DEMO_DATA = 'on';
    delete process.env.PUBLIC_CLINICS;
    __resetCatalogCache();
    catalog = await loadCatalog();
  });

  const send = async (content) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n'));
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'specialist', specialties: ['neurologist'], question: null, options: null }) } }], usage: {} }) };
    };
    const triage = createExternalTriage({ apiKey: 'test-key', url: 'https://llm.example.test/v1/chat/completions', model: 'test-model', fetchImpl });
    const { pipeline } = makeTestPipeline({ catalog, triage, booking: { enabled: true, now: () => NOW } });
    await pipeline.handle({ messages: [{ role: 'user', content: `${content}${PAD}` }], sessionId: TEST_SESSION });
    return calls;
  };

  it('контроль: жалоба без идентификаторов доходит до триажа', async () => {
    const calls = await send('болит спина');
    assert.equal(calls.length, 1);
  });

  it('S09: номер полиса ДМС — модели не уходит ничего', async () => {
    const calls = await send('по полису ДМС Согаз номер 001-ДМС-778899 болит спина');
    assert.equal(calls.length, 0, calls.join('\n'));
  });

  it('S14: должность «главный врач» не уходит', async () => {
    const calls = await send('я главный врач поликлиники №7 Советского района, давление скачет');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /главн|советск|№\s*7/iu);
    assert.match(calls[0], /давление скачет/u);
  });

  it('S15: вторая часть двойной фамилии не уходит', async () => {
    const calls = await send('Меня зовут Эльвира Нурисламова-Вандербильт, болит колено');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /эльвир|нурисламов|вандербильт/iu);
    assert.match(calls[0], /болит колено/u);
  });
});
