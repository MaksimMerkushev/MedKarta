/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный ML-слой Privacy Gateway (PII_NER): объединение с правилами, строгая
 * проверка ответа сервиса и fail closed — при любом сбое модели жалоба наружу не уходит.
 * Сервис здесь подставной (Unix-сокет во временном каталоге), настоящая модель не нужна.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createExternalTriage } from '../backend/planner/triage.js';
import { createNerClient, nerConfigFromEnv, NER_ERROR, validateEntities } from '../backend/privacy/nerClient.js';
import { applyEntities, createNerLayer } from '../backend/privacy/nerLayer.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const span = (text, value, type = 'PER') => {
  const start = text.indexOf(value);
  assert.ok(start >= 0, `нет «${value}» в «${text}»`);
  return { type, start, end: start + value.length, score: 0.9 };
};

describe('ML-слой: маскирование поверх правил', () => {
  it('найденное моделью заменяется меткой, метки правил не трогаются', () => {
    const text = 'я петрова лейсан, [телефон], болит горло';
    assert.equal(applyEntities(text, [span(text, 'петрова лейсан')]).text, 'я [имя], [телефон], болит горло');
    const inside = 'Меня зовут [имя], болит горло';
    assert.equal(applyEntities(inside, [span(inside, 'имя')]).masked, 0);
    assert.equal(applyEntities(inside, [span(inside, 'имя')]).text, inside);
  });

  it('диапазон, задевший метку, поглощает её; соседние части имени — одна метка', () => {
    const text = 'Меня зовут [имя]-Вандербильт, болит колено';
    assert.equal(applyEntities(text, [span(text, 'Вандербильт')]).text, 'Меня зовут [имя], болит колено');
    const glued = 'был у [имя] Сафина, колено';
    assert.equal(applyEntities(glued, [span(glued, '[имя] Сафина')]).text, 'был у [имя], колено');
  });

  it('края без букв обрезаются, организация маскируется целиком', () => {
    const text = 'работаю в ООО «Казаньоргсинтез», кашель';
    const result = applyEntities(text, [span(text, 'ООО «', 'ORG'), span(text, 'Казаньоргсинтез', 'ORG')]).text;
    assert.equal(result, 'работаю в [организация]», кашель');
    assert.doesNotMatch(result, /ООО|Казаньоргсинтез/u);
  });

  it('местоимения, слова жалобы и медицинские эпонимы не маскируются', () => {
    for (const [text, value] of [['Это Сафин, болит горло', 'Это'], ['Меня зовут [имя]', 'Меня зовут'], ['Болит поясница уже неделю', 'Болит'], ['подозревают болезнь Бехтерева', 'Бехтерева'], ['у папы болезнь Паркинсона', 'Паркинсона'], ['сдала анализ по Нечипоренко', 'Нечипоренко']]) {
      assert.equal(applyEntities(text, [span(text, value)]).masked, 0, value);
    }
    const surname = 'я Кашлев Олег, кашель';
    assert.equal(applyEntities(surname, [span(surname, 'Кашлев Олег')]).text, 'я [имя], кашель');
  });

  it('позиции в UTF-16: эмодзи перед именем не сдвигают маску', () => {
    const text = '😷🤒 Гульнара, температура 39';
    assert.equal(applyEntities(text, [span(text, 'Гульнара')]).text, '😷🤒 [имя], температура 39');
  });
});

describe('ML-слой: строгая проверка ответа сервиса', () => {
  const text = 'Гульнара, болит горло';
  it('принимается только известный тип и диапазон внутри текста', () => {
    assert.deepEqual(validateEntities({ entities: [{ type: 'PER', start: 0, end: 8, score: 0.9 }] }, text), [{ type: 'PER', start: 0, end: 8, score: 0.9 }]);
    for (const bad of [
      { entities: [{ type: 'CREDIT_CARD', start: 0, end: 8 }] },
      { entities: [{ type: 'PER', start: 0, end: 999 }] },
      { entities: [{ type: 'PER', start: 5, end: 5 }] },
      { entities: [{ type: 'PER', start: 0.5, end: 8 }] },
      { entities: [{ type: 'PER', start: 0, end: 8, score: 7 }] },
      { entities: Array.from({ length: 201 }, () => ({ type: 'PER', start: 0, end: 1 })) },
      { entities: 'PER' },
      { text: 'переписанный моделью текст' },
    ]) {
      assert.equal(validateEntities(bad, text), null, JSON.stringify(bad).slice(0, 80));
    }
  });

  it('флаг выключен по умолчанию; адрес — только сокет или порт на 127.0.0.1', () => {
    assert.equal(nerConfigFromEnv({}).enabled, false);
    assert.equal(nerConfigFromEnv({ PII_NER: 'ON' }).enabled, true);
    assert.equal(nerConfigFromEnv({ PII_NER_PORT: '99999' }).port, null);
    assert.equal(nerConfigFromEnv({ PII_NER_TIMEOUT_MS: '1' }).timeoutMs, 50);
    assert.equal(nerConfigFromEnv({ PII_NER_TIMEOUT_MS: '60000' }).timeoutMs, 5000);
  });
});

describe('ML-слой: отказы сервиса — fail closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ner-'));
  const socketPath = path.join(dir, 'ner.sock');
  let mode = 'ok';
  let server;
  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const text = JSON.parse(raw).text;
        const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
        if (mode === 'ok') { const start = text.indexOf('лейсан'); reply(200, { entities: start >= 0 ? [{ type: 'PER', start: start - 8, end: start + 6, score: 0.8 }] : [] }); return; }
        if (mode === 'overloaded') { reply(503, { error: 'busy' }); return; }
        if (mode === 'error') { reply(500, { error: 'x' }); return; }
        if (mode === 'too_long') { reply(413, { error: 'text_too_long' }); return; }
        if (mode === 'garbage') { reply(200, '<html>'); return; }
        if (mode === 'out_of_range') { reply(200, { entities: [{ type: 'PER', start: 0, end: 100000 }] }); return; }
        if (mode === 'huge') { reply(200, { entities: [], pad: 'x'.repeat(70 * 1024) }); return; }
        if (mode === 'slow') { setTimeout(() => reply(200, { entities: [] }), 500); return; }
        if (mode === 'residual') { reply(200, { entities: text.includes('Реплики') ? [{ type: 'ORG', start: text.indexOf('глаза'), end: text.indexOf('глаза') + 5 }] : [] }); }
      });
    });
    await new Promise((resolve) => server.listen({ path: socketPath }, resolve));
  });
  after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = () => createNerClient({ socketPath, timeoutMs: 200 });

  it('нормальный ответ — сущности', async () => {
    mode = 'ok';
    assert.deepEqual(await client().entities('я петрова лейсан'), [{ type: 'PER', start: 2, end: 16, score: 0.8 }]);
  });

  for (const [name, code] of [['overloaded', NER_ERROR.OVERLOADED], ['error', NER_ERROR.UNAVAILABLE], ['too_long', NER_ERROR.TOO_LONG], ['garbage', NER_ERROR.INVALID], ['out_of_range', NER_ERROR.INVALID], ['huge', NER_ERROR.INVALID], ['slow', NER_ERROR.TIMEOUT]]) {
    it(`${name} → ${code}`, async () => {
      mode = name;
      await assert.rejects(client().entities('болит горло'), { code });
    });
  }

  it('нет сервиса, нет адреса, слишком длинный текст — ошибка без попытки отправить', async () => {
    await assert.rejects(createNerClient({ socketPath: path.join(dir, 'missing.sock') }).entities('текст'), { code: NER_ERROR.UNAVAILABLE });
    await assert.rejects(createNerClient({}).entities('текст'), { code: NER_ERROR.MISCONFIGURED });
    await assert.rejects(client().entities('а'.repeat(4001)), { code: NER_ERROR.TOO_LONG });
  });

  describe('в pipeline', () => {
    const NOW = moscowMoment('2026-10-12', '12:00');
    const PAD = ', уже неделю плохо вижу вдаль, перед глазами мушки, к вечеру сильно устают глаза';
    let catalog;
    before(async () => {
      process.env.DEMO_DATA = 'on';
      delete process.env.PUBLIC_CLINICS;
      __resetCatalogCache();
      catalog = await loadCatalog();
    });

    const run = async (content, ner) => {
      const sent = [];
      const fetchImpl = async (url, init) => {
        const body = JSON.parse(init.body);
        sent.push(body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'));
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'specialist', specialties: ['ophthalmologist'], question: null, options: null }) } }], usage: {} }) };
      };
      const triage = createExternalTriage({ apiKey: 'k', url: 'https://llm.example.test/v1/chat/completions', model: 'm', fetchImpl, ner });
      const { pipeline } = makeTestPipeline({ catalog, triage, ner, booking: { enabled: true, now: () => NOW } });
      const result = await pipeline.handle({ messages: [{ role: 'user', content: `${content}${PAD}` }], sessionId: TEST_SESSION });
      return { sent, result };
    };

    it('модель закрывает то, что пропустили правила: имя строчными не уходит', async () => {
      mode = 'ok';
      // Правила теперь сами ловят такие имена (ruRecognizers.js); модель — второй рубеж.
      const without = await run('я петрова лейсан, болит голова', null);
      assert.doesNotMatch(without.sent.join('\n'), /петрова|лейсан/u);
      const withNer = await run('я петрова лейсан, болит голова', createNerLayer({ client: client() }));
      assert.equal(withNer.sent.length, 1);
      assert.doesNotMatch(withNer.sent[0], /петрова|лейсан/u);
      assert.match(withNer.sent[0], /\[имя\]/u);
    });

    for (const name of ['overloaded', 'slow', 'garbage', 'error']) {
      it(`сервис ${name}: внешнего запроса нет, пользователь получает локальный ответ`, async () => {
        mode = name;
        const { sent, result } = await run('я петрова лейсан, болит голова', createNerLayer({ client: client() }));
        assert.equal(sent.length, 0);
        assert.ok(result.action, 'ответ всё равно есть');
      });
    }

    it('сервис недоступен (нет сокета): внешнего запроса нет', async () => {
      const { sent } = await run('болит голова', createNerLayer({ client: createNerClient({ socketPath: path.join(dir, 'missing.sock'), timeoutMs: 200 }) }));
      assert.equal(sent.length, 0);
    });

    it('финальная проверка тела: модель увидела сущность в итоговом тексте — отправки нет', async () => {
      mode = 'residual';
      const { sent } = await run('болит голова', createNerLayer({ client: client() }));
      assert.equal(sent.length, 0);
    });
  });
});
