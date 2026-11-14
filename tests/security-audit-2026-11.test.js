/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Регрессии проверки безопасности от 10.11.2026.
 *
 * 1. Зависание ассистента. Два регулярных выражения разбора реплик работали
 *    за квадратичное время на одном длинном слове: запрос из 15 реплик по
 *    1000 букв (он проходит лимит тела в 32 КБ) занимал процессор на 2,5 с,
 *    и всё это время сервер с одним ядром не отвечал никому. Выражения
 *    переписаны так, чтобы находить то же самое за линейное время, — тесты
 *    сверяют их с прежними на случайных строках и проверяют время на входе,
 *    на котором прежние работали бы десятки секунд.
 * 2. ALLOWED_HOSTS. Без него API отвечает на запросы с любым заголовком
 *    Host. Запуск не прерывается, но в production это видно в журнале и в
 *    разделе «Система» админ-панели.
 * 3. Версия Node. На Node без node:sqlite (до 22.13) кабинет выключается, а
 *    вместе с ним ассистент; такие версии в engines больше не заявлены.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import { hostCheckComponent } from '../backend/api/systemInfo.js';
import { allowedHostsFromEnv, verifyOrigin } from '../backend/http/request.js';
import { detectObfuscation, hasBrokenWord, trailingWord } from '../backend/privacy/detectors.js';
import { LIMITS } from '../shared/contract.js';
import { makeGateway, TEST_SESSION } from './helpers.js';

/* Прежние выражения — эталон для сверки. На длинных словах их не запускаем: они и были ошибкой. */
const OLD_BROKEN_WORD = /\p{L}{2,}\p{Extended_Pictographic}+\p{L}{2,}|\p{Lu}\p{Ll}{2,}[/|\\]\p{Ll}{2,}/u;
const OLD_TRAILING_WORD = /(\p{L}{2,})\s*$/u;

/** Детерминированный генератор (mulberry32): тест воспроизводим. */
const prng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Буквы обоих регистров, эмодзи (в том числе составные и «буква-эмодзи» ℹ), косые черты, пробелы, цифры, знаки.
const ALPHABET = ['а', 'б', 'я', 'ё', 'А', 'К', 'Ё', 'a', 'z', 'Q', '🙂', '👍', '🏽', '❤', '️', '‍', 'ℹ', '©', '/', '|', '\\', ' ', ' ', '\n', '\t', '1', '9', '-', '.', ',', '«'];

const randomText = (random, maxLength) => {
  const length = Math.floor(random() * maxLength);
  let text = '';
  for (let index = 0; index < length; index += 1) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return text;
};

const elapsedMs = (work) => {
  const started = process.hrtime.bigint();
  work();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

describe('Аудит 11.2026: разбор реплик не зависает на длинном слове', () => {
  it('«слово разорвано эмодзи или косой чертой» — те же ответы, что у прежнего выражения', () => {
    const random = prng(20261110);
    let positives = 0;
    for (let index = 0; index < 30_000; index += 1) {
      const text = randomText(random, 24);
      const expected = OLD_BROKEN_WORD.test(text);
      if (expected) positives += 1;
      assert.equal(hasBrokenWord(text), expected, `расхождение на ${JSON.stringify(text)}`);
    }
    // Иначе сверка ничего не доказывает: совпали бы и два выражения, которые не находят ничего.
    assert.ok(positives > 300, `среди случайных строк мало совпадений (${positives})`);
  });

  it('разорванные слова из прежних тестов находятся, обычный текст — нет', () => {
    for (const text of ['Кондрат🙂ьеву', 'к Кондрат🙂🙂ьеву на приём', 'Кондра/шову', 'Кондра|шову', 'Кондра\\шову']) {
      assert.equal(hasBrokenWord(text), true, text);
      assert.equal(detectObfuscation(text).suspicious, true, text);
    }
    for (const text of ['спасибо 🙂', 'терапевт 🙂 или лор', 'ок👍', '👍да', 'и/или', 'ЛОР/терапевт', 'пн/ср/пт', 'обычный запрос про терапевта', '']) {
      assert.equal(hasBrokenWord(text), false, text);
    }
  });

  it('«последнее слово реплики» — те же ответы, что у прежнего выражения', () => {
    const random = prng(1110);
    let found = 0;
    for (let index = 0; index < 30_000; index += 1) {
      const text = randomText(random, 20);
      const expected = text.match(OLD_TRAILING_WORD)?.[1] || null;
      if (expected) found += 1;
      assert.equal(trailingWord(text), expected, `расхождение на ${JSON.stringify(text)}`);
    }
    assert.ok(found > 3000, `среди случайных строк мало совпадений (${found})`);
    assert.equal(trailingWord('пациентки Кондра'), 'Кондра');
    assert.equal(trailingWord('пациентки Кондра  \n'), 'Кондра');
    assert.equal(trailingWord('запишите к врачу.'), null);
    assert.equal(trailingWord('я'), null);
    assert.equal(trailingWord(''), null);
    assert.equal(trailingWord(null), null);
  });

  it('слово из 100 000 букв разбирается за миллисекунды, а не за минуты', () => {
    // Прежним выражениям на таком входе нужны были бы минуты (время росло как квадрат длины);
    // порог в 400 мс — с большим запасом для медленной машины.
    for (const word of ['а'.repeat(100_000), 'иванов'.repeat(16_667), 'Aa'.repeat(50_000)]) {
      assert.ok(elapsedMs(() => hasBrokenWord(word)) < 400, 'hasBrokenWord: одно длинное слово');
      assert.ok(elapsedMs(() => hasBrokenWord(`${word} терапевт`)) < 400, 'hasBrokenWord: длинное слово и обычное');
      assert.ok(elapsedMs(() => trailingWord(`${word} терапевт`)) < 400, 'trailingWord: длинное слово посреди реплики');
      assert.ok(elapsedMs(() => trailingWord(`${word}🙂`)) < 400, 'trailingWord: длинное слово перед знаком');
      assert.ok(elapsedMs(() => detectObfuscation(word)) < 400, 'detectObfuscation');
    }
    assert.equal(trailingWord(`${'а'.repeat(100_000)} терапевт`), 'терапевт');
    assert.equal(trailingWord('а'.repeat(100_000)), 'а'.repeat(100_000));
  });

  it('самый тяжёлый запрос, который проходит лимит тела, не занимает процессор на секунды', async () => {
    const { gateway } = makeGateway();
    // Сколько реплик по 1000 букв одним словом помещается в 32 КБ — столько и шлём, как настоящий клиент.
    const build = (text) => {
      let fitted = [];
      for (let turns = 1; turns <= LIMITS.MAX_USER_TURNS; turns += 1) {
        const messages = [];
        for (let index = 0; index < turns; index += 1) {
          if (index > 0) messages.push({ role: 'assistant', content: 'Ок' });
          messages.push({ role: 'user', content: text });
        }
        if (Buffer.byteLength(JSON.stringify({ messages })) > LIMITS.MAX_BODY_BYTES) break;
        fitted = messages;
      }
      return fitted;
    };
    await gateway.process({ messages: [{ role: 'user', content: 'терапевт рядом' }], sessionId: TEST_SESSION });
    const word = 'а'.repeat(LIMITS.MAX_MESSAGE_CHARS);
    for (const text of [word, `${word.slice(0, -9)} терапевт`, `терапевт ${word.slice(0, -9)}`]) {
      const messages = build(text);
      assert.ok(messages.filter((message) => message.role === 'user').length >= 10, 'в лимит тела помещается не меньше 10 таких реплик');
      const started = process.hrtime.bigint();
      const result = await gateway.process({ messages, sessionId: TEST_SESSION });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(result.decision, 'конвейер ответил решением');
      // До исправления — 2,5 с на этом же входе; после — 0,2–0,4 с. Порог с запасом для медленной машины.
      assert.ok(ms < 2000, `разбор занял ${Math.round(ms)} мс`);
    }
  });

  it('время разбора растёт с длиной слова линейно: 16 000 букв — доли секунды', async () => {
    // Через HTTP такое слово не пройдёт (реплика — до 1000 знаков); здесь оно нужно, чтобы
    // квадратичный рост нельзя было не заметить: прежнему коду на этот вход требовалось больше 20 с.
    const { gateway } = makeGateway();
    await gateway.process({ messages: [{ role: 'user', content: 'терапевт рядом' }], sessionId: TEST_SESSION });
    for (const text of ['а'.repeat(16_000), `${'а'.repeat(16_000)} терапевт`]) {
      const started = process.hrtime.bigint();
      await gateway.process({
        messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'Ок' }, { role: 'user', content: 'нужен терапевт' }],
        sessionId: TEST_SESSION,
      });
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 3000, `разбор занял ${Math.round(ms)} мс`);
    }
  });

  it('фамилия, разрезанная между репликами, по-прежнему считается сокрытием', async () => {
    const { gateway } = makeGateway();
    const split = await gateway.process({
      messages: [
        { role: 'user', content: 'запишите пациентки Кондра' },
        { role: 'assistant', content: 'Уточните, пожалуйста.' },
        { role: 'user', content: 'шкина, нужен терапевт' },
      ],
      sessionId: TEST_SESSION,
    });
    const plain = await gateway.process({
      messages: [
        { role: 'user', content: 'нужен терапевт' },
        { role: 'assistant', content: 'Уточните, пожалуйста.' },
        { role: 'user', content: 'завтра вечером' },
      ],
      sessionId: TEST_SESSION,
    });
    assert.equal(split.request, null, 'разрезанная фамилия наружу не уходит');
    assert.notEqual(plain.reason, split.reason, 'обычный диалог не попадает под то же правило');
  });
});

describe('Аудит 11.2026: проверка имени сайта (ALLOWED_HOSTS)', () => {
  it('список имён читается из окружения без пробелов и регистра', () => {
    assert.deepEqual(allowedHostsFromEnv({}), []);
    assert.deepEqual(allowedHostsFromEnv({ ALLOWED_HOSTS: ' , ' }), []);
    assert.deepEqual(allowedHostsFromEnv({ ALLOWED_HOSTS: 'MedKarta.example, www.medkarta.example ,' }), ['medkarta.example', 'www.medkarta.example']);
  });

  it('в production без ALLOWED_HOSTS раздел «Система» показывает ошибку', () => {
    const missing = hostCheckComponent({ NODE_ENV: 'production' });
    assert.equal(missing.key, 'hosts');
    assert.equal(missing.status, 'error');
    assert.match(missing.detail, /ALLOWED_HOSTS/);
    assert.equal(hostCheckComponent({ APP_ENV: 'production' }).status, 'error');
    // Вне production это не ошибка: локальная разработка идёт на localhost.
    assert.equal(hostCheckComponent({ NODE_ENV: 'development' }).status, 'off');
    assert.equal(hostCheckComponent({}).status, 'off');
  });

  it('с ALLOWED_HOSTS компонент в порядке и не раскрывает сами имена', () => {
    const set = hostCheckComponent({ NODE_ENV: 'production', ALLOWED_HOSTS: 'medkarta.example,www.medkarta.example' });
    assert.equal(set.status, 'ok');
    assert.match(set.detail, /2/);
    assert.doesNotMatch(JSON.stringify(set), /medkarta\.example/);
  });

  it('с ALLOWED_HOSTS запрос с чужим Host отклоняется, со своим — проходит', () => {
    const previous = process.env.ALLOWED_HOSTS;
    process.env.ALLOWED_HOSTS = 'medkarta.example';
    try {
      const request = (host, origin) => ({ headers: { host, ...(origin ? { origin } : {}) }, socket: { remoteAddress: '203.0.113.5' } });
      assert.equal(verifyOrigin(request('medkarta.example', 'https://medkarta.example')), true);
      assert.equal(verifyOrigin(request('medkarta.example')), true);
      // Чужой домен, направленный на наш адрес: Host и Origin совпадают между собой, но имя не наше.
      assert.equal(verifyOrigin(request('evil.example', 'http://evil.example')), false);
      assert.equal(verifyOrigin(request('evil.example')), false);
      assert.equal(verifyOrigin(request(undefined, 'https://medkarta.example')), false);
    } finally {
      if (previous === undefined) delete process.env.ALLOWED_HOSTS;
      else process.env.ALLOWED_HOSTS = previous;
    }
  });
});

describe('Аудит 11.2026: заявленная версия Node', () => {
  const readJson = (file) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

  it('engines не обещает работу на Node без node:sqlite', () => {
    const { engines } = readJson('package.json');
    // Кабинет (а с ним и ассистент) работает с Node 22.13: 20.x и 22.12 заявлять нельзя.
    assert.equal(engines.node, '>=22.13.0');
    assert.equal(readJson('package-lock.json').packages[''].engines.node, engines.node, 'package-lock.json расходится с package.json');
  });

  it('.nvmrc указывает на версию, которая подходит под engines', () => {
    const major = Number(fs.readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim().replace(/^v/, '').split('.')[0]);
    assert.ok(major >= 22, `.nvmrc: ${major}`);
  });
});
