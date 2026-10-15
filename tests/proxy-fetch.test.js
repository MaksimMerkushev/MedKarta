/*
 * Запросы к модели через прокси (AI_PROXY_URL): разбор адреса прокси,
 * туннель HTTP CONNECT и SOCKS5, TLS до провайдера, ошибки и таймауты.
 * Прокси и «модель» поднимаются локально.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';

import { createExternalPlanner } from '../backend/planner/client.js';
import { createProxyFetch, describeProxy, parseProxyUrl, ProxyFetchError } from '../backend/planner/proxyFetch.js';
import { plannerTransportFromEnv } from '../backend/pipeline.js';
import { makeGateway, TEST_SESSION } from './helpers.js';

const USER = 'medkarta';
const PASS = 'p@ss:w0rd-секрет';

/*
 * Сервер в тесте закрывается вместе со всеми соединениями: недочитанный или
 * оборванный на рукопожатии TLS сокет иначе держит server.close() вечно.
 */
const listen = (server, host = '127.0.0.1') => {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.destroyConnections = () => {
    for (const socket of sockets) socket.destroy();
  };
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
};
const close = (server) => new Promise((resolve) => {
  server.close(() => resolve());
  server.destroyConnections?.();
});

/* «Модель»: отвечает эхом запроса или по сценарию из пути. */
const upstreamHandler = (req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(64 * 1024, 'a'));
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => res.end('{}'), 3_000).unref();
      return;
    }
    if (req.url === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync(JSON.stringify({ zipped: true })));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'dentist', constraints: {} }], constraints: {} }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization || null, host: req.headers.host, body }));
  });
};

/* HTTP-прокси с CONNECT и Basic-авторизацией. Запоминает, что видел. */
const createConnectProxy = ({ refuse = false, stallFirst = false } = {}) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, client, head) => {
    seen.push({ authority: req.url, auth: req.headers['proxy-authorization'] || null, headers: Object.keys(req.headers) });
    // Первое подключение «зависает»: прокси принял CONNECT и молчит.
    if (stallFirst && seen.length === 1) {
      client.on('error', () => {});
      return;
    }
    const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
    if (req.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
      return;
    }
    if (refuse) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(/:(?=\d+$)/);
    const upstream = net.connect(Number(port), host.replace(/^\[|\]$/g, ''), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { server, seen };
};

/* Минимальный SOCKS5 (RFC 1928 + вход по логину RFC 1929). */
const createSocksProxy = () => {
  const seen = [];
  const server = net.createServer((client) => {
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    client.on('error', () => {});
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        const methods = [...buffer.subarray(2, 2 + buffer[1])];
        buffer = buffer.subarray(2 + buffer[1]);
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth' && buffer.length >= 2) {
        const ulen = buffer[1];
        if (buffer.length < 3 + ulen) return;
        const plen = buffer[2 + ulen];
        if (buffer.length < 3 + ulen + plen) return;
        const user = buffer.subarray(2, 2 + ulen).toString('utf8');
        const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        buffer = buffer.subarray(3 + ulen + plen);
        if (user !== USER || pass !== PASS) {
          client.end(Buffer.from([1, 1]));
          return;
        }
        client.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request' && buffer.length >= 5) {
        const type = buffer[3];
        let host;
        let offset;
        if (type === 3) {
          if (buffer.length < 5 + buffer[4] + 2) return;
          host = buffer.subarray(5, 5 + buffer[4]).toString('utf8');
          offset = 5 + buffer[4];
        } else if (type === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else {
          client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        seen.push({ host, port, type });
        client.off('data', onData);
        stage = 'tunnel';
        const upstream = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    };
    client.on('data', onData);
  });
  return { server, seen };
};

describe('Прокси для модели: адрес прокси', () => {
  it('понимает форматы продавцов прокси', () => {
    assert.deepEqual({ ...parseProxyUrl('user:secret@203.0.113.7:8000') }, { protocol: 'http', host: '203.0.113.7', port: 8000, username: 'user', password: 'secret' });
    assert.deepEqual({ ...parseProxyUrl('203.0.113.7:8000:user:sec:ret') }, { protocol: 'http', host: '203.0.113.7', port: 8000, username: 'user', password: 'sec:ret' });
    assert.deepEqual({ ...parseProxyUrl('203.0.113.7:3128') }, { protocol: 'http', host: '203.0.113.7', port: 3128, username: '', password: '' });
    assert.deepEqual({ ...parseProxyUrl('socks5://user:p%40ss@proxy.example.net:1080') }, { protocol: 'socks5', host: 'proxy.example.net', port: 1080, username: 'user', password: 'p@ss' });
    assert.equal(parseProxyUrl('socks5h://u:p@203.0.113.7:1080').protocol, 'socks5');
    assert.equal(parseProxyUrl(' http://u:p@203.0.113.7:8080 ').port, 8080);
    // Пароль с @ и : в «сыром» формате: делится по последнему @.
    assert.equal(parseProxyUrl('user:a@b:c@203.0.113.7:8000').password, 'a@b:c');
  });

  it('ошибки понятные и без пароля в тексте', () => {
    for (const bad of ['', 'user:secret@203.0.113.7', 'user:secret@203.0.113.7:99999', 'ftp://user:secret@203.0.113.7:21', 'http://user:secret@203.0.113.7:8080/path', 'user:secret@bad host:80', 'просто текст']) {
      assert.throws(() => parseProxyUrl(bad), (error) => error instanceof ProxyFetchError && error.code === 'proxy_config' && !error.message.includes('secret'), bad);
    }
  });

  it('в журнал и проверку — только схема, хост и порт', () => {
    const text = describeProxy(parseProxyUrl('user:secret@203.0.113.7:8000'));
    assert.equal(text, 'http://203.0.113.7:8000');
  });
});

describe('Прокси для модели: туннель', () => {
  let upstream;
  let upstreamPort;
  let connect;
  let connectPort;
  let socks;
  let socksPort;

  before(async () => {
    upstream = http.createServer(upstreamHandler);
    upstreamPort = await listen(upstream);
    connect = createConnectProxy();
    connectPort = await listen(connect.server);
    socks = createSocksProxy();
    socksPort = await listen(socks.server);
  });
  after(async () => {
    await Promise.all([close(upstream), close(connect.server), close(socks.server)]);
  });

  it('HTTP CONNECT: запрос, ключ модели и тело проходят туннель, прокси видит только адрес', async () => {
    const proxyFetch = createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${connectPort}` });
    const response = await proxyFetch(`http://127.0.0.1:${upstreamPort}/v1/echo?x=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer model-key' },
      body: JSON.stringify({ hello: 'мир' }),
    });
    assert.equal(response.status, 201);
    assert.equal(response.ok, true);
    assert.equal(response.headers.get('x-upstream'), 'yes');
    const payload = await response.json();
    assert.equal(payload.method, 'POST');
    assert.equal(payload.url, '/v1/echo?x=1');
    assert.equal(payload.authorization, 'Bearer model-key');
    assert.deepEqual(JSON.parse(payload.body), { hello: 'мир' });
    const last = connect.seen.at(-1);
    assert.equal(last.authority, `127.0.0.1:${upstreamPort}`);
    assert.ok(!last.headers.includes('authorization'), 'ключ модели не должен попадать в заголовки CONNECT');
  });

  it('SOCKS5: вход по логину, имя хоста резолвит прокси', async () => {
    const proxyFetch = createProxyFetch({ proxy: `socks5://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:${socksPort}` });
    const response = await proxyFetch(`http://localhost:${upstreamPort}/socks`, { method: 'GET' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).url, '/socks');
    assert.deepEqual(socks.seen.at(-1), { host: 'localhost', port: upstreamPort, type: 3 });
  });

  it('неверный пароль прокси — proxy_auth, пароль в ошибке не виден', async () => {
    for (const proxy of [`${USER}:wrong@127.0.0.1:${connectPort}`, `socks5://${USER}:wrong@127.0.0.1:${socksPort}`]) {
      await assert.rejects(
        createProxyFetch({ proxy })(`http://127.0.0.1:${upstreamPort}/`),
        (error) => error.code === 'proxy_auth' && !error.message.includes('wrong'),
        proxy,
      );
    }
  });

  it('прокси отказал в CONNECT — proxy_refused', async () => {
    const refusing = createConnectProxy({ refuse: true });
    const port = await listen(refusing.server);
    await assert.rejects(createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${port}` })(`http://127.0.0.1:${upstreamPort}/`), (error) => error.code === 'proxy_refused');
    // Отказ — это ответ прокси, а не сбой связи: не повторяется.
    assert.equal(refusing.seen.length, 1);
    await close(refusing.server);
  });

  it('зависшее подключение к прокси повторяется один раз', async () => {
    const flaky = createConnectProxy({ stallFirst: true });
    const port = await listen(flaky.server);
    const response = await createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${port}`, connectTimeoutMs: 300 })(`http://127.0.0.1:${upstreamPort}/ok`);
    assert.equal(response.status, 201);
    // Первый CONNECT остался без ответа — до «модели» дошёл только второй.
    assert.equal(flaky.seen.length, 2);
    await close(flaky.server);
  });

  it('повторов не больше заданного: молчащий прокси — два подключения, затем proxy_timeout', async () => {
    let connections = 0;
    const silent = net.createServer((socket) => {
      connections += 1;
      socket.on('error', () => {});
      socket.resume();
    });
    const port = await listen(silent);
    await assert.rejects(createProxyFetch({ proxy: `127.0.0.1:${port}`, connectTimeoutMs: 200 })(`http://127.0.0.1:${upstreamPort}/`), (error) => error.code === 'proxy_timeout');
    assert.equal(connections, 2);
    connections = 0;
    await assert.rejects(createProxyFetch({ proxy: `127.0.0.1:${port}`, connectTimeoutMs: 200, connectRetries: 0 })(`http://127.0.0.1:${upstreamPort}/`), (error) => error.code === 'proxy_timeout');
    assert.equal(connections, 1);
    await close(silent);
  });

  it('прокси недоступен — proxy_connect; молчит — proxy_timeout', async () => {
    const closed = net.createServer();
    const closedPort = await listen(closed);
    await close(closed);
    await assert.rejects(createProxyFetch({ proxy: `127.0.0.1:${closedPort}` })(`http://127.0.0.1:${upstreamPort}/`), (error) => error.code === 'proxy_connect');

    // Прокси принимает соединение и молчит (данные читает, чтобы сокет мог закрыться).
    const silent = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.resume();
    });
    const silentPort = await listen(silent);
    const started = Date.now();
    await assert.rejects(createProxyFetch({ proxy: `127.0.0.1:${silentPort}`, connectTimeoutMs: 300 })(`http://127.0.0.1:${upstreamPort}/`), (error) => error.code === 'proxy_timeout');
    assert.ok(Date.now() - started < 2_000);
    await close(silent);
  });

  it('отмена запроса (таймаут клиента) — AbortError, как у fetch', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(
      createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${connectPort}` })(`http://127.0.0.1:${upstreamPort}/slow`, { signal: controller.signal }),
      (error) => error.name === 'AbortError',
    );
  });

  it('потолок размера ответа и распаковка gzip', async () => {
    const proxyFetch = createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${connectPort}`, maxResponseBytes: 16 * 1024 });
    await assert.rejects(proxyFetch(`http://127.0.0.1:${upstreamPort}/big`), (error) => error.code === 'upstream_too_large');
    const zipped = await proxyFetch(`http://127.0.0.1:${upstreamPort}/gzip`);
    assert.deepEqual(await zipped.json(), { zipped: true });
    assert.equal(zipped.headers.get('content-encoding'), null);
  });

  it('ошибка прокси видна в журнале кодом, без адреса и пароля', async () => {
    const events = [];
    const planner = createExternalPlanner({
      apiKey: 'model-key',
      url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      model: 'openai/gpt-5.4-mini',
      fetchImpl: createProxyFetch({ proxy: `${USER}:wrong-secret@127.0.0.1:${connectPort}` }),
      logger: { event: (event, fields) => events.push({ event, fields }) },
    });
    const gate = await makeGateway().gateway.process({ messages: [{ role: 'user', content: 'Покажи стоматологов в Вахитовском районе' }], sessionId: TEST_SESSION });
    await assert.rejects(planner.generate(gate.request), (error) => error.code === 'planner_upstream_error');
    assert.deepEqual(events.at(-1), { event: 'planner.transport_error', fields: { provider: 'external', code: 'proxy_auth' } });
    assert.ok(!JSON.stringify(events).includes('wrong-secret'));
  });

  it('планировщик ходит к модели через прокси', async () => {
    const before = connect.seen.length;
    const planner = createExternalPlanner({
      apiKey: 'model-key',
      url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
      model: 'openai/gpt-5.4-mini',
      fetchImpl: createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${connectPort}` }),
    });
    const gate = await makeGateway().gateway.process({ messages: [{ role: 'user', content: 'Покажи стоматологов в Вахитовском районе' }], sessionId: TEST_SESSION });
    const result = await planner.generate(gate.request);
    assert.match(result.raw, /FIND_DOCTOR/);
    assert.equal(connect.seen.length, before + 1, 'запрос к модели прошёл через прокси');
  });
});

describe('Прокси для модели: TLS до провайдера', () => {
  let dir = null;
  let secure;
  let securePort;
  let connect;
  let connectPort;
  let cert;

  before(async () => {
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-proxy-tls-'));
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost',
        '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
      ], { stdio: 'ignore' });
      cert = fs.readFileSync(path.join(dir, 'cert.pem'));
    } catch {
      cert = null;
      return;
    }
    secure = https.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert }, upstreamHandler);
    securePort = await listen(secure);
    connect = createConnectProxy();
    connectPort = await listen(connect.server);
  });
  after(async () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (!cert) return;
    await Promise.all([close(secure), close(connect.server)]);
  });

  it('TLS внутри туннеля: сертификат проверяется, без доверия — отказ', async (t) => {
    if (!cert) {
      t.skip('нет openssl — сертификат для теста не создать');
      return;
    }
    const trusted = createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${connectPort}`, tlsOptions: { ca: cert } });
    const response = await trusted(`https://localhost:${securePort}/tls`, { method: 'POST', headers: { Authorization: 'Bearer model-key' }, body: '{}' });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.authorization, 'Bearer model-key');
    assert.equal(payload.host, `localhost:${securePort}`);
    assert.equal(connect.seen.at(-1).authority, `localhost:${securePort}`);

    const untrusted = createProxyFetch({ proxy: `${USER}:${PASS}@127.0.0.1:${connectPort}` });
    await assert.rejects(untrusted(`https://localhost:${securePort}/tls`), (error) => error.code === 'tls');
  });
});

describe('Модель: глубина рассуждений', () => {
  const capture = async (reasoningEffort) => {
    let sent = null;
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const planner = createExternalPlanner({ apiKey: 'k', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-5.4-mini', fetchImpl, reasoningEffort });
    const gate = await makeGateway().gateway.process({ messages: [{ role: 'user', content: 'Покажи стоматологов в Вахитовском районе' }], sessionId: TEST_SESSION });
    await planner.generate(gate.request);
    return sent;
  };

  it('AI_REASONING_EFFORT=low уходит как reasoning.effort; без настройки параметра нет', async () => {
    assert.deepEqual((await capture('low')).reasoning, { effort: 'low' });
    assert.equal('reasoning' in (await capture(null)), false);
    assert.equal('reasoning' in (await capture('turbo')), false, 'неизвестное значение не отправляется');
  });
});

describe('Прокси для модели: настройка из окружения', () => {
  const makeLogger = () => {
    const records = [];
    return { records, event: (event, fields) => records.push({ level: 'info', event, fields }), warn: (event, fields) => records.push({ level: 'warn', event, fields }) };
  };

  it('без AI_PROXY_URL — обычный fetch', () => {
    const transport = plannerTransportFromEnv({ OPENROUTER_API_KEY: 'k' }, makeLogger());
    assert.equal(transport.apiKey, 'k');
    assert.equal(transport.fetchImpl, fetch);
  });

  it('с прокси — свой транспорт; в журнале нет ни адреса, ни пароля', () => {
    const logger = makeLogger();
    const transport = plannerTransportFromEnv({ OPENROUTER_API_KEY: 'k', AI_PROXY_URL: 'user:secret@203.0.113.7:8000' }, logger);
    assert.equal(transport.apiKey, 'k');
    assert.notEqual(transport.fetchImpl, fetch);
    const logged = JSON.stringify(logger.records);
    assert.ok(!logged.includes('secret') && !logged.includes('203.0.113.7'), logged);
  });

  it('прокси задан с ошибкой — внешняя модель выключается, а не идёт напрямую', () => {
    const logger = makeLogger();
    const transport = plannerTransportFromEnv({ OPENROUTER_API_KEY: 'k', AI_PROXY_URL: 'user:secret@203.0.113.7' }, logger);
    assert.equal(transport.apiKey, undefined);
    assert.equal(logger.records.at(-1).event, 'planner.proxy_invalid');
    assert.ok(!JSON.stringify(logger.records).includes('secret'));
  });
});
