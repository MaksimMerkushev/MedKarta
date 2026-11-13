/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Мониторинг: исходы вызовов внешней модели (без текста), раздел «Система»
 * (модель на деле, свежесть копий), проверка готовности для внешнего
 * мониторинга — только статусы и только с токеном.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aiHealth, createAiHealth } from '../backend/observability/aiHealth.js';
import { buildPlannerBody, requestCompletion } from '../backend/planner/client.js';
import { aiComponent, backupComponent } from '../backend/api/systemInfo.js';
import { createReadyHandler } from '../backend/api/health.js';

const response = () => {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.writeHead = (code, headers = {}) => { res.statusCode = code; Object.assign(res.headers, headers); };
  res.end = (body = '') => { res.body += body; };
  res.write = (chunk) => { res.body += chunk; };
  return res;
};

describe('Мониторинг: исходы вызовов модели', () => {
  it('сводка: idle, ok, failing по серии и по отсутствию успехов; текста нет', () => {
    let clock = 1_000_000;
    const health = createAiHealth({ now: () => clock });
    assert.equal(health.snapshot().status, 'idle');
    health.record({ ok: true, ms: 800, promptTokens: 1700, completionTokens: 30 });
    health.record({ ok: false, code: 'proxy_timeout', ms: 10_000 });
    let snap = health.snapshot();
    assert.equal(snap.status, 'ok');
    assert.deepEqual(snap.errors, { proxy_timeout: 1 });
    assert.equal(snap.tokens, 1730);
    health.record({ ok: false, code: 'proxy_timeout' });
    health.record({ ok: false, code: 'timeout' });
    assert.equal(health.snapshot().status, 'failing');
    clock += 2 * 3_600_000;
    health.record({ ok: false, code: 'http_502' });
    snap = health.snapshot();
    assert.equal(snap.status, 'failing');
    assert.equal(snap.calls, 1);
    health.record({ ok: false, code: 'Сюда не пройдёт текст' });
    assert.equal(health.snapshot().lastErrorCode, 'unknown');
  });

  describe('requestCompletion записывает исход', () => {
    beforeEach(() => aiHealth.reset());
    const call = (fetchImpl, timeoutMs = 2000) => requestCompletion({ url: 'https://openrouter.ai/api/v1/chat/completions', apiKey: 'k', body: buildPlannerBody({ model: 'test-model', messages: [{ role: 'user', content: 'Запрос: подобрать врача.' }] }), fetchImpl, timeoutMs, inspect: { schemas: [buildPlannerBody({ model: 'x', messages: [] }).response_format.json_schema] } });

    it('успех — с задержкой и токенами', async () => {
      await call(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 }));
      const snap = aiHealth.snapshot();
      assert.equal(snap.ok, 1);
      assert.equal(snap.tokens, 12);
    });

    it('HTTP 502, таймаут, сбой прокси — коды ошибок', async () => {
      await assert.rejects(call(async () => new Response('fail', { status: 502 })));
      await assert.rejects(call((url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), 50));
      await assert.rejects(call(async () => { throw Object.assign(new Error('Прокси 1.2.3.4 не ответил'), { code: 'proxy_timeout' }); }));
      const snap = aiHealth.snapshot();
      assert.deepEqual(snap.errors, { http_502: 1, timeout: 1, proxy_timeout: 1 });
      assert.equal(snap.status, 'failing');
      assert.doesNotMatch(JSON.stringify(snap), /1\.2\.3\.4|Прокси/u);
    });
  });
});

describe('Мониторинг: раздел «Система»', () => {
  it('модель: не настроена — off; не отвечает — error; без вызовов — off', () => {
    assert.equal(aiComponent({}).status, 'off');
    const health = createAiHealth();
    for (let index = 0; index < 3; index += 1) health.record({ ok: false, code: 'proxy_timeout' });
    const failing = aiComponent({ OPENROUTER_API_KEY: 'x' }, health);
    assert.equal(failing.status, 'error');
    assert.match(failing.detail, /proxy_timeout ×3/u);
    assert.equal(aiComponent({ OPENROUTER_API_KEY: 'x' }, createAiHealth()).status, 'off');
  });

  it('резервные копии: без BACKUP_DIR — off; свежая — ok; старая или нет — error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-mon-'));
    assert.equal(backupComponent({}).status, 'off');
    assert.equal(backupComponent({ BACKUP_DIR: dir }).status, 'error');
    const at = Date.now();
    fs.writeFileSync(path.join(dir, 'LATEST.json'), JSON.stringify({ createdAt: new Date(at - 3_600_000).toISOString() }));
    assert.equal(backupComponent({ BACKUP_DIR: dir }, at).status, 'ok');
    assert.equal(backupComponent({ BACKUP_DIR: dir }, at + 30 * 3_600_000).status, 'error');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Мониторинг: проверка готовности', () => {
  const components = (overrides = {}) => async () => ({ components: [
    { key: 'backend', status: 'ok', detail: 'работает 5 мин' },
    { key: 'accounts', status: 'ok', detail: 'аккаунтов: 3' },
    { key: 'ai', status: 'off', detail: 'не настроена' },
    ...Object.entries(overrides).map(([key, status]) => ({ key, status, detail: 'подробность' })),
  ] });

  it('без MONITOR_TOKEN адреса нет; без верного токена — 401', async () => {
    const off = createReadyHandler({ collect: components(), token: () => '' });
    let res = response();
    await off({ method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 404);
    const on = createReadyHandler({ collect: components(), token: () => 'secret-token' });
    res = response();
    await on({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, res);
    assert.equal(res.statusCode, 401);
  });

  it('верный токен — только статусы; ошибка важного компонента — 503 degraded', async () => {
    let res = response();
    await createReadyHandler({ collect: components(), token: () => 'secret-token' })({ method: 'GET', headers: { authorization: 'Bearer secret-token' } }, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body, { status: 'ok', components: { backend: 'ok', accounts: 'ok', ai: 'off' } });
    assert.doesNotMatch(res.body, /аккаунтов|подробность/u);
    res = response();
    await createReadyHandler({ collect: components({ ai: 'error' }), token: () => 'secret-token' })({ method: 'GET', headers: { authorization: 'Bearer secret-token' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).status, 'degraded');
  });
});
