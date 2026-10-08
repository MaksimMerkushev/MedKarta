/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Покрытие графа дорог и его обновление без перезапуска сервера.
 *
 * Регрессия: маршрут к ФАП на ул. Красавина не строился («точка слишком
 * далеко от дорог»). Учреждение стояло в 100 м от трассы М-7, но рамка графа
 * была подобрана по Казани «на глаз» и обрывалась в полутора километрах
 * западнее — вместе с мостом через Волгу. Теперь рамка выводится из
 * справочника, и тесты ниже не дают ей снова разойтись с данными.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CITY_BBOX,
  coverageBbox,
  coversPoint,
  directoryPoints,
  MARGIN_KM,
} from '../backend/routing/coverage.js';
import {
  __expireRoutingReloadCheck,
  __pendingRoutingReload,
  __resetRoutingEngine,
  createRoutingEngine,
  getDefaultRoutingEngine,
  ROUTING_ERROR,
} from '../backend/routing/engine.js';
import { encodeGraph, PROFILE_NAMES } from '../backend/routing/format.js';
import { loadGraph } from '../backend/routing/graph.js';
import { buildGridGraph } from './fixtures/roadGraph.js';

const REAL_GRAPH = fileURLToPath(new URL('../data/graph/kazan.graph', import.meta.url));
const HAS_REAL_GRAPH = existsSync(REAL_GRAPH);

/** ФАП, ул. Красавина, 4А — точка, на которой проявился дефект. */
const KRASAVINA = { lat: 55.7651, lng: 48.8515 };
/** Центр Казани, стартовая точка интерфейса по умолчанию. */
const KAZAN_CENTER = { lat: 55.7963, lng: 49.1088 };

describe('Рамка графа выводится из справочника', () => {
  it('покрывает каждую точку справочника с запасом', async () => {
    const points = await directoryPoints();
    assert.ok(points.length > 400, `в справочнике подозрительно мало точек: ${points.length}`);

    const bbox = coverageBbox(points);
    const uncovered = points.filter((point) => !coversPoint(bbox, point, MARGIN_KM - 0.01));
    assert.deepEqual(uncovered, [], 'точки у края или за краем рамки');
  });

  it('не меньше самой Казани', async () => {
    const bbox = coverageBbox(await directoryPoints());
    assert.ok(bbox[0] <= CITY_BBOX[0] && bbox[1] <= CITY_BBOX[1]);
    assert.ok(bbox[2] >= CITY_BBOX[2] && bbox[3] >= CITY_BBOX[3]);
  });

  it('старая рамка «на глаз» не покрывала ФАП на Красавина — новая покрывает', async () => {
    const oldBbox = [55.65, 48.85, 55.98, 49.42];
    assert.equal(coversPoint(oldBbox, KRASAVINA), false);
    assert.equal(coversPoint(coverageBbox(await directoryPoints()), KRASAVINA), true);
  });
});

describe('Движок называет точку, которая не встала на дорогу', () => {
  it('в отказе есть номер точки', async () => {
    const graph = await (async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'medkarta-graph-'));
      const file = path.join(dir, 'g.graph');
      await writeFile(file, encodeGraph(buildGridGraph()));
      const loaded = await loadGraph(file);
      await rm(dir, { recursive: true, force: true });
      return loaded;
    })();
    const engine = createRoutingEngine({ graph });
    const [lat, lng] = graph.coordsOf(0);

    const result = engine.route({ waypoints: [{ lat, lng }, { lat, lng }, { lat: 10, lng: 10 }] });
    assert.equal(result.error, ROUTING_ERROR.OFF_NETWORK);
    assert.equal(result.index, 2);
  });
});

describe('Граф обновляется без перезапуска сервера', () => {
  let dir;

  after(async () => {
    __resetRoutingEngine();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('подхватывает пересобранный файл и не роняет запросы во время загрузки', async () => {
    __resetRoutingEngine();
    dir = await mkdtemp(path.join(os.tmpdir(), 'medkarta-reload-'));
    const file = path.join(dir, 'kazan.graph');

    // Файла ещё нет: движка нет, но и ошибки нет.
    assert.equal(await getDefaultRoutingEngine(file), null);

    // Файл появился — подхватывается при следующей проверке.
    await writeFile(file, encodeGraph(buildGridGraph()));
    __expireRoutingReloadCheck();
    await getDefaultRoutingEngine(file);
    await __pendingRoutingReload();
    const first = await getDefaultRoutingEngine(file);
    assert.ok(first, 'граф не подхвачен после появления файла');
    const firstNodes = first.stats().nodes;

    // Пересборка: атомарная замена файла другим графом.
    await writeFile(`${file}.tmp`, encodeGraph(buildGridGraph({ island: true })));
    await rename(`${file}.tmp`, file);
    const future = new Date(Date.now() + 60_000);
    await utimes(file, future, future);

    __expireRoutingReloadCheck();
    const during = await getDefaultRoutingEngine(file);
    assert.equal(during, first, 'пока новый граф грузится, работает старый');
    await __pendingRoutingReload();

    const second = await getDefaultRoutingEngine(file);
    assert.notEqual(second, first);
    assert.equal(second.stats().nodes, firstNodes + 2);
  });

  it('повреждённый новый файл не заменяет рабочий граф', async () => {
    const file = path.join(dir, 'kazan.graph');
    const working = await getDefaultRoutingEngine(file);

    await writeFile(file, Buffer.from('это не граф'));
    const future = new Date(Date.now() + 120_000);
    await utimes(file, future, future);

    __expireRoutingReloadCheck();
    await getDefaultRoutingEngine(file);
    await __pendingRoutingReload();
    assert.equal(await getDefaultRoutingEngine(file), working);
  });
});

/*
 * Проверки на настоящем графе Казани. Файл графа в git не хранится,
 * поэтому без него тесты пропускаются; на машине разработчика и на сервере
 * они обязательны — именно они поймали бы дефект с ФАП на Красавина.
 */
describe('Настоящий граф Казани', { skip: !HAS_REAL_GRAPH && 'нет data/graph/kazan.graph' }, () => {
  const load = (() => {
    let cached;
    return async () => {
      cached ||= loadGraph(REAL_GRAPH);
      return cached;
    };
  })();

  const uniquePoints = async () => {
    const seen = new Map();
    for (const point of await directoryPoints()) {
      seen.set(`${point.lat.toFixed(4)},${point.lng.toFixed(4)}`, point);
    }
    return [...seen.values()];
  };

  it('к каждой точке справочника есть дорога для каждого вида транспорта', async () => {
    const graph = await load();
    const missing = [];
    for (const point of await uniquePoints()) {
      for (const profile of PROFILE_NAMES) {
        if (!graph.snapToRoad(point.lat, point.lng, profile)) {
          missing.push(`${profile} ${point.lat},${point.lng} ${point.label || ''}`);
        }
      }
    }
    assert.deepEqual(missing, [], 'пересоберите граф: npm run build:graph');
  });

  it('от центра Казани строится маршрут до каждой точки справочника', async () => {
    const engine = createRoutingEngine({ graph: await load() });
    const failed = [];
    for (const point of await uniquePoints()) {
      for (const profile of ['driving', 'foot']) {
        const result = engine.route({ waypoints: [KAZAN_CENTER, point], profile });
        if (!result.ok) failed.push(`${profile} ${result.error} ${point.lat},${point.lng} ${point.label || ''}`);
      }
    }
    assert.deepEqual(failed, []);
  });
});
