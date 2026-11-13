/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный сервис NER (services/pii-ner/server.mjs): только ответы о сущностях, лимиты,
 * очередь, текст не попадает в журнал. Модель — подставная: проверяется сам сервис.
 * Отдельный блок с настоящей моделью выполняется, только если она загружена
 * (node services/pii-ner/fetch-model.mjs) — в CI его нет.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createNerServer, LIMITS } from '../services/pii-ner/server.mjs';
import { basicTokenize } from '../services/pii-ner/ner.mjs';

const call = (socketPath, { method = 'POST', url = '/v1/entities', body = '' } = {}) => new Promise((resolve, reject) => {
  const request = http.request({ socketPath, method, path: url, agent: false, headers: { 'Content-Type': 'application/json' } }, (response) => {
    let raw = '';
    response.on('data', (chunk) => { raw += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
  });
  request.on('error', reject);
  request.end(body);
});

describe('Сервис NER: протокол и лимиты', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ner-svc-'));
  const socketPath = path.join(dir, 's.sock');
  let server;
  let release = null;
  const fakeNer = {
    entities: async (text) => {
      if (text === 'медленно') await new Promise((resolve) => { release = resolve; });
      const start = text.indexOf('Гульнара');
      return start >= 0 ? [{ type: 'PER', start, end: start + 8, score: 0.9 }] : [];
    },
  };
  const written = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  before(async () => {
    process.stdout.write = (chunk, ...rest) => { written.push(String(chunk)); return originalWrite(chunk, ...rest); };
    ({ server } = await createNerServer({ ner: fakeNer, limits: { ...LIMITS, MAX_QUEUE: 2, QUEUE_WAIT_MS: 200 } }));
    await new Promise((resolve) => server.listen({ path: socketPath }, resolve));
  });
  after(() => {
    process.stdout.write = originalWrite;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('возвращает только тип, позицию, уверенность и сведения о модели — без текста', async () => {
    const { status, body } = await call(socketPath, { body: JSON.stringify({ text: 'Меня зовут Гульнара, болит горло' }) });
    assert.equal(status, 200);
    assert.deepEqual(body.entities, [{ type: 'PER', start: 11, end: 19, score: 0.9 }]);
    assert.deepEqual(Object.keys(body).sort(), ['entities', 'model', 'ms', 'revision']);
    assert.doesNotMatch(JSON.stringify(body), /Гульнара|горло/u);
  });

  it('длинный текст, большое тело, не JSON, нет поля text, неизвестный путь', async () => {
    assert.equal((await call(socketPath, { body: JSON.stringify({ text: 'а'.repeat(LIMITS.MAX_TEXT_CHARS + 1) }) })).status, 413);
    assert.equal((await call(socketPath, { body: 'x'.repeat(LIMITS.MAX_BODY_BYTES + 10) }).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await call(socketPath, { body: 'не json' })).status, 400);
    assert.equal((await call(socketPath, { body: JSON.stringify({ input: 'x' }) })).status, 400);
    assert.equal((await call(socketPath, { url: '/v1/rewrite', body: '{}' })).status, 404);
  });

  it('одна обработка за раз; переполненная очередь — 503, а не перегрузка процессора', async () => {
    const slow = call(socketPath, { body: JSON.stringify({ text: 'медленно' }) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const queued = call(socketPath, { body: JSON.stringify({ text: 'второй' }) });
    const rejected = await call(socketPath, { body: JSON.stringify({ text: 'третий' }) });
    assert.equal(rejected.status, 503);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    assert.equal((await slow).status, 200);
    assert.equal((await queued).status, 503, 'ждал дольше QUEUE_WAIT_MS — отказ, а не поздний ответ');
  });

  it('текст запросов не пишется в журнал сервиса', () => {
    assert.doesNotMatch(written.join(''), /Гульнара|горло|медленно/u);
  });

  it('токенизация: позиции в UTF-16, пунктуация — отдельно', () => {
    const text = '😷 Гульнара,болит';
    const tokens = basicTokenize(text);
    assert.deepEqual(tokens.map((t) => text.slice(t.start, t.end)), ['😷', 'Гульнара', ',', 'болит']);
  });
});

const modelDir = path.resolve('services/pii-ner/model');
let ortAvailable = false;
try {
  createRequire(path.resolve('services/pii-ner/package.json')).resolve('onnxruntime-node');
  ortAvailable = true;
} catch {
  ortAvailable = false;
}
describe('Сервис NER с настоящей моделью', { skip: !(fs.existsSync(modelDir) && ortAvailable) && 'модель не загружена' }, () => {
  it('находит имя в склонении и двойную фамилию; файлы модели сверены по SHA-256', async () => {
    const { server } = await createNerServer({ modelDir });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-ner-real-'));
    const socketPath = path.join(dir, 's.sock');
    await new Promise((resolve) => server.listen({ path: socketPath }, resolve));
    try {
      const text = 'Звонила доктору Эльвире Нурисламовой-Вандербильт, болит колено';
      const { body } = await call(socketPath, { body: JSON.stringify({ text }) });
      const names = body.entities.filter((e) => e.type === 'PER').map((e) => text.slice(e.start, e.end)).join(' ');
      assert.match(names, /Эльвире/u);
      assert.match(names, /Вандербильт/u);
      assert.doesNotMatch(names, /колено/u);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
