/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Длинный ввод не останавливает сервер (аудит 11.11.2026): разбор реплик
 * синхронный, поэтому в него идут только последние реплики пользователя в
 * пределах MAX_HISTORY_CHARS, а регулярные выражения разбора работают за
 * линейное время (tests/security-audit-2026-11.test.js).
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { limitHistory, MAX_HISTORY_CHARS } from '../backend/pipeline.js';
import { KIN_BEFORE } from '../backend/privacy/gateway.js';
import { DISTRICT_PHRASE } from '../backend/understanding/turnRoles.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const user = (content) => ({ role: 'user', content });
const assistant = (content) => ({ role: 'assistant', content });

describe('Длинный ввод: ограничение истории', () => {
  it('обычный диалог не обрезается', () => {
    const dialog = [user('болит горло'), assistant('Подойдёт лор.'), user('а завтра после 18?'), assistant('Ищу.'), user('до 2500')];
    assert.equal(limitHistory(dialog), dialog);
  });

  it('длинная история: последние реплики в пределах бюджета, свежая — всегда', () => {
    const long = Array.from({ length: 40 }, (_, index) => (index % 2 ? assistant('ответ') : user('а'.repeat(1000))));
    const kept = limitHistory(long);
    const userChars = kept.filter((message) => message.role === 'user').reduce((sum, message) => sum + message.content.length, 0);
    assert.ok(userChars <= MAX_HISTORY_CHARS, `${userChars} символов`);
    assert.equal(kept.at(-1), long.at(-1));
    assert.ok(kept.filter((message) => message.role === 'user').length >= 1);
    // Хвост истории сохраняется подряд, без пропусков.
    assert.deepEqual(kept, long.slice(long.length - kept.length));
  });

  it('одна реплика длиннее бюджета остаётся (её длину ограничивает контракт)', () => {
    const kept = limitHistory([user('старое'), user('б'.repeat(MAX_HISTORY_CHARS + 10))]);
    assert.equal(kept.length, 1);
  });

  it('не массив — пустая история', () => {
    assert.deepEqual(limitHistory(null), []);
  });
});

describe('Длинный ввод: весь путь запроса', () => {
  let pipeline;
  before(async () => {
    for (const name of ['OPENROUTER_API_KEY', 'AI_API_KEY', 'AI_UPSTREAM_URL', 'AI_PROXY_URL']) delete process.env[name];
    __resetCatalogCache();
    ({ pipeline } = makeTestPipeline({ catalog: await loadCatalog() }));
    await pipeline.handle({ messages: [user('болит горло')], sessionId: TEST_SESSION });
  });

  for (const [label, unit] of [['одно слово', 'а'], ['слово с точками', 'а.'], ['эмодзи в слове', 'аа🙂'], ['заглавные слова', 'Иван ']]) {
    it(`40 сообщений по 1000 символов («${label}») — меньше 3 с и ответ без ошибки`, async () => {
      const content = unit.repeat(Math.ceil(1000 / unit.length)).slice(0, 1000);
      const messages = Array.from({ length: 40 }, (_, index) => (index % 2 ? assistant('ответ') : user(content)));
      const started = performance.now();
      const { action } = await pipeline.handle({ messages, sessionId: `${TEST_SESSION}-${label}` });
      const ms = performance.now() - started;
      // До исправлений «одно слово» занимало больше секунды и росло квадратично; запас — на медленный CI.
      assert.ok(ms < 3000, `${Math.round(ms)} мс`);
      assert.equal(typeof action.replyText, 'string');
    });
  }

  it('старая жалоба за пределами бюджета не влияет на ответ: свежая реплика решает', async () => {
    const messages = [user('болит колено'), assistant('Подойдёт ортопед.'), ...Array.from({ length: 12 }, () => user('ж'.repeat(1000))), user('болит горло, нужен лор')];
    const { action } = await pipeline.handle({ messages, sessionId: `${TEST_SESSION}-old` });
    assert.doesNotMatch(action.replyText, /ортопед/u);
  });
});

describe('Длинный ввод: выражения, найденные статическим поиском 12.11.2026', () => {
  const OLD_KIN_BEFORE = /(\p{L}+)\s+(?:\p{Lu}\p{Ll}+\s+){0,2}$/u;
  const OLD_DISTRICT_PHRASE = /\p{L}+(?:ом|ем|ой|ий|ый)\s+район\p{L}*/gu;
  const ALPHABET = ['а', 'б', 'о', 'м', 'й', 'Г', 'Х', ' ', ' ', 'район', 'ом ', 'ой ', '-', '.'];
  let seed = 20261112;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const text = (length) => Array.from({ length }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join('');

  it('находят то же самое, что прежние, на 3000 случайных строках', () => {
    for (let index = 0; index < 3000; index += 1) {
      const sample = text(1 + Math.floor(random() * 30));
      assert.deepEqual(sample.match(KIN_BEFORE)?.slice(0, 2) ?? null, sample.match(OLD_KIN_BEFORE)?.slice(0, 2) ?? null, sample);
      assert.equal(sample.replace(DISTRICT_PHRASE, ' '), sample.replace(OLD_DISTRICT_PHRASE, ' '), sample);
    }
    assert.equal('моя мама Гульнара '.match(KIN_BEFORE)[1], 'мама');
    assert.equal('в советском районе'.replace(DISTRICT_PHRASE, '|'), 'в |');
  });

  it('линейное время на слове из 20 000 букв (прежние — квадратичное)', () => {
    const word = 'а'.repeat(20000);
    const started = performance.now();
    KIN_BEFORE.test(word);
    word.replace(DISTRICT_PHRASE, ' ');
    const ms = performance.now() - started;
    // Прежние выражения на таком слове работали бы около 6 с каждое.
    assert.ok(ms < 200, `${Math.round(ms)} мс`);
  });
});
