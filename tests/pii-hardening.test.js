/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Усиление Privacy Gateway по итогам red-team (13.11.2026): нормализация входа,
 * распознаватели ПДн РФ, медицинский словарь, номера документов, стабильные метки,
 * неуверенность ML-слоя, финальная проверка свободного текста. Данные вымышленные.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUserText } from '../backend/privacy/inputNormalize.js';
import { recognizePii } from '../backend/privacy/ruRecognizers.js';
import { isMedicalPhrase, isMedicalWord } from '../backend/privacy/medicalLexicon.js';
import { deidentifyComplaint, hasDocumentNumber } from '../backend/privacy/deidentify.js';
import { applySpans, createLabelState } from '../backend/privacy/spanMask.js';
import { createNerLayer, splitByConfidence } from '../backend/privacy/nerLayer.js';
import { detectEntities } from '../backend/privacy/detectors.js';
import { inspectOutbound } from '../backend/planner/outboundInspector.js';
import { TRIAGE_JSON_SCHEMA, TRIAGE_SYSTEM_PROMPT } from '../backend/planner/triage.js';

const types = (text) => recognizePii(text).map((s) => `${s.type}:${text.slice(s.start, s.end)}`);

describe('Нормализация входа', () => {
  it('невидимые символы, двойники букв, широкие цифры, разметка', () => {
    assert.equal(normalizeUserText('Гуль​нара Хай​руллина'), 'Гульнара Хайруллина');
    assert.equal(normalizeUserText('Гульнaрa Xaйруллинa'), 'Гульнара Хайруллина');
    assert.equal(normalizeUserText('８９１７５５５１２３４'), '89175551234');
    assert.equal(normalizeUserText('<b>Тимур</b> &amp; **Сафин**'), 'Тимур & Сафин');
    assert.equal(normalizeUserText('школа №39'), 'школа №39');
  });

  it('латинская раскладка переводится, английский текст и технические строки — нет', () => {
    assert.equal(normalizeUserText('Vtyz pjden Uekmyfhf'), 'Меня зовут Гульнара');
    assert.equal(normalizeUserText("'nj F[vtnjd Fhcty"), 'это Ахметов Арсен');
    assert.equal(normalizeUserText('Hello, I am fine. Thanks, doc'), 'Hello, I am fine. Thanks, doc');
    assert.equal(normalizeUserText('Упомянуты: @WORK. availableAfter=18:00.'), 'Упомянуты: @WORK. availableAfter=18:00.');
  });

  it('медицинский текст не меняется', () => {
    const text = 'давление 160/100, Метформин 1000 мг, температура 38.5, ТТГ 6.2';
    assert.equal(normalizeUserText(text), text);
  });
});

describe('Распознаватели ПДн РФ', () => {
  it('имена строчными и по отчеству, организации после «работаю в», аббревиатура с окончанием', () => {
    assert.deepEqual(types('меня зовут ильнур петров, болит горло'), ['PERSON:ильнур петров']);
    assert.deepEqual(types('Петровна сказала, что надо к врачу'), ['PERSON:Петровна']);
    assert.deepEqual(types('я из сбере, давление 160/100'), ['ORG:сбере']);
    assert.deepEqual(types('Наблюдаюсь в КАМАЗе, кашель').filter((t) => t.startsWith('ORG')), ['ORG:КАМАЗе']);
  });

  it('обычная работа и медицинские слова не маскируются', () => {
    assert.deepEqual(types('работаю на заводе с химией, кашель не проходит'), []);
    assert.deepEqual(types('Я учитель, постоянно срываю голос'), []);
    assert.deepEqual(types('По утрам першит горло, Последние несколько дней'), []);
    assert.deepEqual(types('Метформин 1000 мг утром, проба Манту'), []);
  });

  it('телефон словами, почта с заменами, ники, закодированные строки, координаты, адреса', () => {
    assert.deepEqual(types('телефон восемь девять один семь пять пять пять один два три четыре').map((t) => t.split(':')[0]), ['PHONE']);
    assert.deepEqual(types('пишите gulnara(at)mail(dot)ru').map((t) => t.split(':')[0]), ['EMAIL']);
    assert.deepEqual(types('мой ник телеграм elvira_kzn и t.me/timur.safin').map((t) => t.split(':')[0]), ['URL', 'URL']);
    assert.ok(types('вот: 0JPRg9C70YzQvdCw0YDQsCA4OTE3').some((t) => t.startsWith('SECRET')));
    assert.ok(types('код %D0%93%D1%83%D0%BB%D1%8C').some((t) => t.startsWith('SECRET')));
    assert.deepEqual(types('я тут: 55.796127, 49.106405').map((t) => t.split(':')[0]), ['LOC']);
    assert.deepEqual(types('адрес: ул. Ершова, 1, кв. 5').map((t) => t.split(':')[0]), ['ADDRESS']);
  });

  it('метки шлюза не принимаются за ники', () => {
    assert.deepEqual(types('Упомянуты сущности: @CURRENT_LOCATION. Признаки: route.'), []);
  });

  it('длинный ввод — без квадратичного перебора', () => {
    for (const value of ['1'.repeat(20_000), 'a'.repeat(20_000), 'a.'.repeat(10_000), 'аб-'.repeat(7_000), 'ул. А'.repeat(4_000)]) {
      const started = performance.now();
      recognizePii(value);
      assert.ok(performance.now() - started < 300, `${Math.round(performance.now() - started)} мс`);
    }
  });
});

describe('Медицинский словарь', () => {
  it('лекарства, анализы, эпонимы — медицинские; похожая фамилия — нет', () => {
    for (const w of ['Метформин', 'Кагоцел', 'ТТГ', 'Бехтерева', 'Нечипоренко', 'Манту', 'Паркинсона']) assert.equal(isMedicalWord(w), true, w);
    for (const w of ['Кашлев', 'Петров', 'Гульнара']) assert.equal(isMedicalWord(w), false, w);
    assert.equal(isMedicalPhrase('Метформин 1000'), true);
  });

  it('детекторы шлюза не считают лекарство и эпоним именем', () => {
    for (const t of ['Метформин 1000 мг утром', 'подозревают болезнь Бехтерева', 'анализ по Нечипоренко']) assert.deepEqual(detectEntities(t).spans.filter((s) => s.kind === 'PERSON'), [], t);
  });

  it('обезличивание сохраняет препараты, анализы и эпонимы', () => {
    const text = 'ТТГ 6.2, Метформин 1000 мг, проба Манту, Кагоцел не помог';
    assert.equal(deidentifyComplaint(text).text, text);
  });
});

describe('Номера документов и редкие обстоятельства', () => {
  it('звёздочки, цифры словами, свидетельство о рождении, загранпаспорт — блокировка', () => {
    for (const t of ['загранпаспорт 34 *3**900', 'свидетельство о рождении VI-ТР 723057', 'полис омс восемь четыре девять девять один три семь один', 'дмс номер 48*-КЛ-*68421']) assert.equal(hasDocumentNumber(t), true, t);
  });

  it('суммы, годы и дозировки рядом с ДМС — не номер', () => {
    for (const t of ['по ДМС до 3000 рублей', 'по ДМС в 2024 году', 'полис есть, пью 1000 мг']) assert.equal(hasDocumentNumber(t), false, t);
  });

  it('тройня, аварийная посадка, член сборной, возраст 100+ — не отправляются', () => {
    for (const t of ['родила тройню три недели назад', 'вчера была аварийная посадка', 'я член сборной России', 'мне 104 года']) assert.equal(deidentifyComplaint(t).blocked, true, t);
  });

  it('«глава района», «судья», «капитан команды» — должность', () => {
    assert.match(deidentifyComplaint('мой отец — глава Высокогорского района, кашель').text, /^мой отец — \[должность\], кашель$/u);
    assert.doesNotMatch(deidentifyComplaint('я капитан хоккейной команды, болит колено').text, /капитан/u);
  });
});

describe('Метки и неуверенность ML-слоя', () => {
  it('одна и та же сущность получает одну метку во всём диалоге', () => {
    const state = createLabelState();
    const a = applySpans('Гульнара пишет', [{ type: 'PERSON', start: 0, end: 8 }], { state }).text;
    const b = applySpans('звоните Тимуру и Гульнара', [{ type: 'PERSON', start: 8, end: 14 }, { type: 'PERSON', start: 17, end: 25 }], { state }).text;
    assert.equal(a, '[имя_1] пишет');
    assert.equal(b, 'звоните [имя_2] и [имя_1]');
  });

  it('сомнительная находка останавливает отправку, уверенная — маскируется', async () => {
    const text = 'Ринат болит горло';
    assert.equal(splitByConfidence(text, [{ type: 'PERSON', start: 0, end: 5, score: 0.5 }]).doubtful.length, 1);
    assert.equal(splitByConfidence(text, [{ type: 'PERSON', start: 0, end: 5, score: 0.2 }]).doubtful.length, 0);
    const doubtful = createNerLayer({ client: { entities: async () => [{ type: 'PERSON', start: 0, end: 5, score: 0.5 }] } });
    await assert.rejects(doubtful.maskTurns([text]), { code: 'ner_uncertain' });
    const sure = createNerLayer({ client: { entities: async () => [{ type: 'PERSON', start: 0, end: 5, score: 0.95 }] } });
    assert.deepEqual(await sure.maskTurns([text]), ['[имя_1] болит горло']);
  });

  it('ошибка любой из нескольких моделей — отправки нет', async () => {
    const layer = createNerLayer({ clients: [{ entities: async () => [] }, { entities: async () => { throw Object.assign(new Error('x'), { code: 'ner_timeout' }); } }] });
    await assert.rejects(layer.maskTurns(['болит горло']), { code: 'ner_timeout' });
  });
});

describe('Финальная проверка свободного текста', () => {
  const body = (user) => ({ model: 'm', messages: [{ role: 'system', content: TRIAGE_SYSTEM_PROMPT }, { role: 'user', content: `Реплики пользователя:\n1. ${user}` }], response_format: { type: 'json_schema', json_schema: TRIAGE_JSON_SCHEMA }, temperature: 0, max_tokens: 600 });
  const inspect = { schemas: [TRIAGE_JSON_SCHEMA], staticSystem: new Set([TRIAGE_SYSTEM_PROMPT]), freeText: true };
  it('имя строчными, ник, закодированная строка, невидимые символы — отказ', async () => {
    for (const user of ['меня зовут ильнур петров, болит горло', 'мой ник телеграм elvira_kzn', 'данные 0JPRg9C70YzQvdCw0YDQsCA4OTE3', 'Гуль​нара, болит']) assert.notDeepEqual(await inspectOutbound(body(user), inspect), [], user);
  });

  it('обычная жалоба с метками и медицинскими числами проходит', async () => {
    assert.deepEqual(await inspectOutbound(body('Меня зовут [имя], давление 160/100, Метформин 1000 мг, ТТГ 6.2'), inspect), []);
  });
});
