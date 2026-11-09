/* GET /api/health: только статус, без служебных сведений. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createHealthHandler } from '../backend/api/health.js';

const call = async (handler, method = 'GET') => {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body; },
  };
  await handler({ method, headers: {} }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

describe('Проверка работоспособности', () => {
  it('всё в порядке — 200 и только статус', async () => {
    const { status, body } = await call(createHealthHandler({ check: async () => true }));
    assert.equal(status, 200);
    assert.deepEqual(body, { status: 'ok' });
  });

  it('база недоступна или проверка упала — 503 без подробностей', async () => {
    assert.deepEqual(await call(createHealthHandler({ check: async () => false })), { status: 503, body: { status: 'degraded' } });
    const failing = createHealthHandler({ check: async () => { throw new Error('секрет в тексте ошибки'); } });
    assert.deepEqual(await call(failing), { status: 503, body: { status: 'degraded' } });
  });

  it('только GET и HEAD; частые запросы не нагружают базу', async () => {
    let t = 0;
    let checks = 0;
    const handler = createHealthHandler({ check: async () => { checks += 1; return true; }, now: () => t });
    assert.equal((await call(handler, 'POST')).status, 405);
    await call(handler);
    await call(handler);
    assert.equal(checks, 1);
    t += 6_000;
    await call(handler);
    assert.equal(checks, 2);
  });
});
