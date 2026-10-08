/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Фильтр «не дольше N минут»: обход с потолком и эндпоинт /api/travel-times.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSearch } from '../backend/routing/astar.js';
import { createGraph } from '../backend/routing/graph.js';
import { createRoutingEngine } from '../backend/routing/engine.js';
import { decodeGraph, encodeGraph } from '../backend/routing/format.js';
import { createTravelTimesHandler, parseTravelRequest, TRAVEL_LIMITS } from '../backend/api/travelTimes.js';
import { buildGridGraph, GRID, nodeIndex } from './fixtures/roadGraph.js';

const graph = createGraph(decodeGraph(encodeGraph(buildGridGraph())));
const engine = createRoutingEngine({ graph });
const at = (row, col) => ({ lat: GRID.originLat + row * GRID.step, lng: GRID.originLon + col * GRID.step });

const makeReq = (body, headers = {}) => ({
  method: 'POST',
  body,
  headers: { host: 'medkarta.test', ...headers },
  socket: { remoteAddress: '203.0.113.9' },
});

const makeRes = () => ({
  statusCode: 200,
  headers: {},
  body: null,
  writableEnded: false,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  end(chunk) { this.body = chunk ? JSON.parse(chunk) : null; this.writableEnded = true; },
});

const freeLimiter = { check: () => ({ allowed: true }), charge: () => {} };

describe('Обход с потолком времени', () => {
  const search = createSearch(graph);

  it('с потолком даёт те же времена для близких целей и обходит меньше узлов', () => {
    const source = nodeIndex(0, 0);
    const goals = [nodeIndex(2, 2), nodeIndex(39, 39)];
    const full = search.runOneToMany({ source, targets: goals, profile: 'foot' });
    const nearLimit = full.durations[0] + 1;
    const bounded = search.runOneToMany({ source, targets: goals, profile: 'foot', maxCost: nearLimit });

    assert.ok(Math.abs(bounded.durations[0] - full.durations[0]) < 1e-6);
    assert.equal(bounded.durations[1], Infinity, 'дальняя цель за потолком не должна считаться');
    assert.ok(bounded.expanded < full.expanded / 10, `обход не остановился: ${bounded.expanded} из ${full.expanded}`);
  });

  it('движок возвращает null для целей дальше потолка', async () => {
    const all = await engine.travelTimes(at(0, 0), [at(1, 1), at(30, 30)], 'foot');
    const limit = Math.ceil(all[0].durationSeconds) + 5;
    const bounded = await engine.travelTimes(at(0, 0), [at(1, 1), at(30, 30)], 'foot', { maxSeconds: limit });

    assert.equal(bounded[0].durationSeconds, all[0].durationSeconds);
    assert.equal(bounded[1].durationSeconds, null);
  });
});

describe('Разбор запроса времени в пути', () => {
  const valid = { origin: at(0, 0), mode: 'foot', maxMinutes: 20, points: [[at(1, 1).lat, at(1, 1).lng]] };

  it('принимает корректный запрос', () => {
    const parsed = parseTravelRequest(valid);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.destinations.length, 1);
  });

  it('отвергает некорректные поля', () => {
    assert.equal(parseTravelRequest({ ...valid, origin: { lat: '55.7', lng: 49.1 } }).error, 'bad_origin');
    assert.equal(parseTravelRequest({ ...valid, origin: { lat: 40, lng: 30 } }).error, 'outside_region');
    assert.equal(parseTravelRequest({ ...valid, mode: 'plane' }).error, 'bad_mode');
    assert.equal(parseTravelRequest({ ...valid, maxMinutes: 2 }).error, 'bad_limit');
    assert.equal(parseTravelRequest({ ...valid, maxMinutes: 20.5 }).error, 'bad_limit');
    assert.equal(parseTravelRequest({ ...valid, points: [] }).error, 'bad_points');
    assert.equal(parseTravelRequest({ ...valid, points: [['55.7', 49.1]] }).error, 'bad_points');
    const tooMany = Array.from({ length: TRAVEL_LIMITS.MAX_POINTS + 1 }, () => [55.79, 49.12]);
    assert.equal(parseTravelRequest({ ...valid, points: tooMany }).error, 'bad_points');
  });

  it('точка вне региона не ломает запрос — для неё просто нет времени', () => {
    const parsed = parseTravelRequest({ ...valid, points: [[55.79, 49.12], [40, 30]] });
    assert.equal(parsed.destinations[1], null);
  });
});

describe('Эндпоинт /api/travel-times', () => {
  const handler = createTravelTimesHandler({
    getEngine: async () => engine,
    rateLimit: () => ({ allowed: true }),
    cpuLimiter: freeLimiter,
  });

  it('возвращает времена в порядке точек и null за потолком', async () => {
    const near = at(1, 1);
    const far = at(39, 39);
    const res = makeRes();
    await handler(makeReq({ origin: at(0, 0), mode: 'foot', maxMinutes: 5, points: [[near.lat, near.lng], [far.lat, far.lng], [40, 30]] }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.durations.length, 3);
    assert.ok(res.body.durations[0] > 0 && res.body.durations[0] <= 300);
    assert.equal(res.body.durations[1], null);
    assert.equal(res.body.durations[2], null);
  });

  it('без графа отвечает 503, а не выдумывает время', async () => {
    const noGraph = createTravelTimesHandler({ getEngine: async () => null, rateLimit: () => ({ allowed: true }), cpuLimiter: freeLimiter });
    const res = makeRes();
    await noGraph(makeReq({ origin: at(0, 0), mode: 'foot', maxMinutes: 10, points: [[55.79, 49.12]] }), res);
    assert.equal(res.statusCode, 503);
  });

  it('проверяет метод, источник, лимиты и тело', async () => {
    const get = makeRes();
    await handler({ ...makeReq({}), method: 'GET' }, get);
    assert.equal(get.statusCode, 405);

    const foreign = makeRes();
    await handler(makeReq({ origin: at(0, 0), maxMinutes: 10, points: [[55.79, 49.12]] }, { origin: 'https://evil.example' }), foreign);
    assert.equal(foreign.statusCode, 403);

    const bad = makeRes();
    await handler(makeReq({ origin: at(0, 0), maxMinutes: 500, points: [[55.79, 49.12]] }), bad);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.code, 'bad_limit');

    const busy = createTravelTimesHandler({
      getEngine: async () => engine,
      rateLimit: () => ({ allowed: true }),
      cpuLimiter: { check: () => ({ allowed: false, retryAfterSeconds: 3 }), charge: () => {} },
    });
    const limited = makeRes();
    await busy(makeReq({ origin: at(0, 0), maxMinutes: 10, points: [[55.79, 49.12]] }), limited);
    assert.equal(limited.statusCode, 429);
  });
});
