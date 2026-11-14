/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный сервис распознавания персональных данных для Privacy Gateway.
 * - Слушает только Unix-сокет (PII_NER_SOCKET) или 127.0.0.1 (PII_NER_PORT); внешнего адреса нет.
 * - Модель загружается один раз; файлы сверяются с model.json по SHA-256.
 * - Во время обработки сетевых запросов нет: onnxruntime работает с локальным файлом.
 * - Возвращает только тип, позицию и уверенность. Текст не возвращает и не пишет в журнал.
 * - Один запрос за раз, короткая очередь, предел длины текста и тела, тайм-аут ожидания.
 *
 *   PII_NER_SOCKET=/run/medkarta/pii-ner.sock node services/pii-ner/server.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadNer } from './ner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const LIMITS = Object.freeze({
  MAX_BODY_BYTES: 16 * 1024,
  MAX_TEXT_CHARS: 4000,
  MAX_QUEUE: 8,
  QUEUE_WAIT_MS: 1000,
});

const log = (event, fields = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);

/** Модели из model.json; PII_NER_MODELS — какие загрузить (по умолчанию все, чьи файлы на месте). */
const loadModels = async ({ modelDir, manifest, threads, only, lowMemory = false }) => {
  const ort = require('onnxruntime-node');
  const loaded = [];
  for (const spec of manifest.models) {
    if (only && !only.includes(spec.name)) continue;
    const dir = path.join(modelDir, spec.name);
    if (!only && !fs.existsSync(dir)) continue;
    loaded.push({ spec, ner: await loadNer({ ort, dir, spec, threads, lowMemory }) });
  }
  if (loaded.length === 0) throw new Error('нет ни одной модели: см. README.md');
  // Объединение находок всех моделей: правила слияния — на стороне шлюза (spanMask.js).
  return { entities: async (text) => (await Promise.all(loaded.map((m) => m.ner.entities(text)))).flat(), names: loaded.map((m) => m.spec.name) };
};

export const createNerServer = async ({ modelDir = path.join(here, 'model'), threads = 1, limits = LIMITS, ner: injected = null, only = null, lowMemory = false } = {}) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, 'model.json'), 'utf8'));
  const ner = injected || await loadModels({ modelDir, manifest, threads, only, lowMemory });
  manifest.id = (ner.names || manifest.models.map((m) => m.name)).join('+');
  manifest.revision = manifest.models.filter((m) => !ner.names || ner.names.includes(m.name)).map((m) => `${m.name}@${m.revision.slice(0, 12)}`).join(',');
  let tail = Promise.resolve();
  let queued = 0;

  // Один запрос к модели за раз: на 2 vCPU параллельные прогоны только мешают Node.js.
  const runExclusive = (work) => {
    if (queued >= limits.MAX_QUEUE) return Promise.reject(Object.assign(new Error('busy'), { status: 503 }));
    queued += 1;
    const enqueued = Date.now();
    const result = tail.then(() => {
      if (Date.now() - enqueued > limits.QUEUE_WAIT_MS) throw Object.assign(new Error('timeout'), { status: 503 });
      return work();
    });
    tail = result.catch(() => {}).finally(() => { queued -= 1; });
    return result;
  };

  const send = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
    res.end(payload);
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { status: 'ok', model: manifest.id, revision: manifest.revision, queued, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/entities') { send(res, 404, { error: 'not_found' }); return; }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limits.MAX_BODY_BYTES && !aborted) {
        aborted = true;
        // Соединение закрывается: клиент не должен переиспользовать его для следующего запроса.
        res.setHeader('Connection', 'close');
        send(res, 413, { error: 'too_large' });
        req.destroy();
        return;
      }
      if (!aborted) chunks.push(chunk);
    });
    req.on('end', async () => {
      if (aborted) return;
      let text;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        text = body?.text;
      } catch {
        send(res, 400, { error: 'invalid_json' });
        return;
      }
      if (typeof text !== 'string') { send(res, 400, { error: 'text_required' }); return; }
      if (text.length > limits.MAX_TEXT_CHARS) { send(res, 413, { error: 'text_too_long' }); return; }
      const started = performance.now();
      try {
        const entities = await runExclusive(() => ner.entities(text));
        send(res, 200, { entities, model: manifest.id, revision: manifest.revision, ms: Math.round((performance.now() - started) * 100) / 100 });
      } catch (error) {
        log('pii_ner.error', { status: error.status || 500, code: error.message === 'busy' || error.message === 'timeout' ? error.message : 'inference' });
        send(res, error.status || 500, { error: error.status ? error.message : 'inference_failed' });
      }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  return { server, manifest };
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const socket = process.env.PII_NER_SOCKET;
  const port = Number(process.env.PII_NER_PORT || 0);
  if (!socket && !port) {
    log('pii_ner.config_error', { status: 'нужен PII_NER_SOCKET или PII_NER_PORT' });
    process.exit(1);
  }
  const only = process.env.PII_NER_MODELS ? process.env.PII_NER_MODELS.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const { server, manifest } = await createNerServer({ modelDir: process.env.PII_NER_MODEL_DIR || undefined, threads: Number(process.env.PII_NER_THREADS || 1), only, lowMemory: process.env.PII_NER_LOW_MEMORY === 'on' });
  if (socket) {
    if (fs.existsSync(socket)) fs.unlinkSync(socket);
    server.listen({ path: socket }, () => {
      fs.chmodSync(socket, 0o660);
      log('pii_ner.started', { status: 'unix_socket', model: manifest.id });
    });
  } else {
    // Только петлевой адрес: сервис не должен быть доступен снаружи.
    server.listen(port, '127.0.0.1', () => log('pii_ner.started', { status: `127.0.0.1:${port}`, model: manifest.id }));
  }
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
