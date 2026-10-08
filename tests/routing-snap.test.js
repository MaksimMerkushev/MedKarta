/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Привязка точек к дороге и маршруты «от точки на отрезке до точки на отрезке».
 *
 * Регрессия, ради которой написан файл: на реальном графе Казани 40 %
 * автомобильных маршрутов между учреждениями не строились. Ближайшим к зданию
 * оказывался узел тротуара или изолированного двора, поиск отвечал «пути
 * нет», а интерфейс рисовал прямую через дома и реку. Каждый тест ниже
 * воспроизводит одну из причин на маленьком графе.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGraph, distanceMeters, markMainComponents } from '../backend/routing/graph.js';
import { createRoutingEngine, ROUTING_ERROR } from '../backend/routing/engine.js';
import { ACCESS, COORD_SCALE, decodeGraph, encodeGraph, PROFILES } from '../backend/routing/format.js';
import { wayAccess } from '../backend/routing/osm.js';
import { buildGridGraph, GRID, nodeIndex } from './fixtures/roadGraph.js';

const ALL = ACCESS.CAR | ACCESS.FOOT | ACCESS.BIKE;
const materialize = (raw) => createGraph(decodeGraph(encodeGraph(raw)));

/**
 * Маленький граф из списка узлов и рёбер.
 * edges: [from, to, access, speed, oneway]
 */
const buildGraph = (points, edges) => {
  const nodeCount = points.length;
  const lat = Int32Array.from(points, ([la]) => Math.round(la * COORD_SCALE));
  const lon = Int32Array.from(points, ([, lo]) => Math.round(lo * COORD_SCALE));
  const adjacency = Array.from({ length: nodeCount }, () => []);

  for (const [a, b, mask = ALL, speed = 50, oneway = false] of edges) {
    const metres = Math.max(1, Math.round(distanceMeters(lat[a], lon[a], lat[b], lon[b])));
    adjacency[a].push({ target: b, length: metres, speed, access: mask });
    if (!oneway) adjacency[b].push({ target: a, length: metres, speed, access: mask });
  }

  const edgeCount = adjacency.reduce((sum, list) => sum + list.length, 0);
  const raw = {
    lat,
    lon,
    offsets: new Uint32Array(nodeCount + 1),
    targets: new Uint32Array(edgeCount),
    lengths: new Uint32Array(edgeCount),
    speeds: new Uint8Array(edgeCount),
    access: new Uint8Array(edgeCount),
  };
  let cursor = 0;
  adjacency.forEach((list, node) => {
    raw.offsets[node] = cursor;
    for (const edge of list) {
      raw.targets[cursor] = edge.target;
      raw.lengths[cursor] = edge.length;
      raw.speeds[cursor] = edge.speed;
      raw.access[cursor] = edge.access;
      cursor += 1;
    }
  });
  raw.offsets[nodeCount] = cursor;
  return raw;
};

const pointOf = (graph, node) => {
  const [lat, lng] = graph.coordsOf(node);
  return { lat, lng };
};

describe('Главная компонента связности', () => {
  it('тупик с односторонним въездом не входит в автомобильную компоненту, но входит в пешеходную', () => {
    // Квадрат 0-1-2-3 плюс узел 4, куда машина может только въехать.
    const raw = buildGraph(
      [[55.79, 49.1], [55.79, 49.102], [55.792, 49.102], [55.792, 49.1], [55.793, 49.103]],
      [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4, ALL, 30, true], [4, 2, ACCESS.FOOT | ACCESS.BIKE, 30, true]],
    );
    const membership = markMainComponents(decodeGraph(encodeGraph(raw)));

    assert.equal(membership[4] & ACCESS.CAR, 0, 'машина застрянет в тупике — узел не должен быть в компоненте');
    assert.ok(membership[4] & ACCESS.FOOT, 'пешеход выйдет из тупика — узел в компоненте');
    for (const node of [0, 1, 2, 3]) assert.ok(membership[node] & ACCESS.CAR);
  });

  it('острова не входят ни в одну главную компоненту', () => {
    const raw = buildGridGraph({ island: true });
    const membership = markMainComponents(decodeGraph(encodeGraph(raw)));
    const island = GRID.rows * GRID.cols;

    for (const mask of [ACCESS.CAR, ACCESS.FOOT, ACCESS.BIKE]) {
      assert.equal(membership[island] & mask, 0);
      assert.ok(membership[nodeIndex(5, 5)] & mask);
    }
  });
});

describe('Привязка к дороге с учётом транспорта', () => {
  it('машина не привязывается к тротуару, даже если он ближе всего', () => {
    // Все четыре ребра узла (10,10) — только для пешеходов и велосипедов.
    const footOnlyEdges = new Set(['10,9->10,10', '10,10->10,11', '9,10->10,10', '10,10->11,10']);
    const graph = materialize(buildGridGraph({ footOnlyEdges }));
    const blocked = nodeIndex(10, 10);
    const point = pointOf(graph, blocked);

    const byCar = graph.snapToRoad(point.lat, point.lng, 'driving');
    assert.ok(byCar);
    assert.notEqual(byCar.from, blocked);
    assert.notEqual(byCar.to, blocked);

    const onFoot = graph.snapToRoad(point.lat, point.lng, 'foot');
    assert.ok(onFoot.distance < 1, 'пешеход стоит прямо на тротуаре');

    // Раньше этот маршрут возвращал «пути нет», и на карте рисовалась прямая.
    const engine = createRoutingEngine({ graph });
    const result = engine.route({ waypoints: [point, pointOf(graph, nodeIndex(0, 0))], profile: 'driving' });
    assert.equal(result.ok, true, `маршрут не построен: ${result.error}`);
  });

  it('обрывок дороги рядом с точкой не перехватывает привязку', () => {
    // Сеть — квадрат; внутри него короткий отрезок, ни с чем не связанный.
    // Точка стоит прямо на обрывке, но маршрут обязан начаться с сети.
    const raw = buildGraph(
      [[55.79, 49.1], [55.79, 49.104], [55.794, 49.104], [55.794, 49.1], [55.792, 49.1015], [55.792, 49.1025]],
      [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5]],
    );
    const graph = materialize(raw);
    const hit = graph.snapToRoad(55.792, 49.102, 'driving');

    assert.ok(hit);
    assert.ok(![4, 5].includes(hit.from) && ![4, 5].includes(hit.to), 'привязка к изолированному обрывку');

    const engine = createRoutingEngine({ graph });
    const result = engine.route({ waypoints: [{ lat: 55.792, lng: 49.102 }, pointOf(graph, 2)], profile: 'driving' });
    assert.equal(result.ok, true);
  });

  it('точка у середины длинного отрезка встаёт на отрезок, а не на далёкий узел', () => {
    // Отрезок ~1 км без промежуточных узлов — как мост или проспект.
    const graph = materialize(buildGraph([[55.79, 49.1], [55.799, 49.1]], [[0, 1]]));
    const hit = graph.snapToRoad(55.7945, 49.10008, 'driving');

    assert.ok(hit);
    assert.ok(hit.distance < 10, `до дороги ${hit.distance} м`);
    assert.ok(Math.abs(hit.t - 0.5) < 0.01, `t = ${hit.t}`);
  });

  it('при прочих равных предпочитает улицу магистрали', () => {
    // Магистраль (90 км/ч) в 20 м от точки, обычная улица — в 60 м.
    const raw = buildGraph(
      [[55.79, 49.1], [55.79, 49.11], [55.7908, 49.1], [55.7908, 49.11]],
      [[0, 1, ACCESS.CAR, 90], [2, 3, ALL, 40], [0, 2], [1, 3]],
    );
    const graph = materialize(raw);
    const hit = graph.snapToRoad(55.79018, 49.105, 'driving');
    assert.equal(Math.min(hit.from, hit.to), 2, 'привязка к магистрали при соседней улице');
  });

  it('точка далеко от любой дороги не привязывается', () => {
    const graph = materialize(buildGridGraph());
    assert.equal(graph.snapToRoad(GRID.originLat + 1, GRID.originLon + 1, 'driving'), null);
    assert.equal(graph.snapToRoad(0, 0, 'foot'), null);
    assert.equal(graph.snapToRoad(Number.NaN, 49, 'foot'), null);
  });
});

describe('Маршрут от точки на отрезке', () => {
  it('две точки на одном отрезке — прямо по нему', () => {
    const graph = materialize(buildGraph([[55.79, 49.1], [55.799, 49.1]], [[0, 1]]));
    const engine = createRoutingEngine({ graph });
    const result = engine.route({
      waypoints: [{ lat: 55.792, lng: 49.1 }, { lat: 55.796, lng: 49.1 }],
      profile: 'foot',
    });

    assert.equal(result.ok, true);
    assert.ok(Math.abs(result.distanceM - 445) < 5, `длина ${result.distanceM}`);
    assert.equal(result.geometry.length, 2);
  });

  it('против одностороннего движения машина объезжает квартал, пешеход идёт напрямую', () => {
    // Кольцо с односторонним движением 0→1→2→3→0, стороны ~110 м и ~125 м.
    const raw = buildGraph(
      [[55.79, 49.1], [55.791, 49.1], [55.791, 49.102], [55.79, 49.102]],
      [[0, 1, ALL, 40, true], [1, 2, ALL, 40, true], [2, 3, ALL, 40, true], [3, 0, ALL, 40, true],
        [1, 0, ACCESS.FOOT, 40, true], [2, 1, ACCESS.FOOT, 40, true], [3, 2, ACCESS.FOOT, 40, true], [0, 3, ACCESS.FOOT, 40, true]],
    );
    const graph = materialize(raw);
    const engine = createRoutingEngine({ graph });
    // Старт ближе к узлу 1, финиш ближе к узлу 0: на отрезке 0→1 это «назад».
    const waypoints = [{ lat: 55.7907, lng: 49.1 }, { lat: 55.7903, lng: 49.1 }];

    const onFoot = engine.route({ waypoints, profile: 'foot' });
    const byCar = engine.route({ waypoints, profile: 'driving' });

    assert.equal(onFoot.ok, true);
    assert.equal(byCar.ok, true);
    assert.ok(Math.abs(onFoot.distanceM - 44) < 3, `пешком ${onFoot.distanceM}`);
    assert.ok(byCar.distanceM > 400, `машина проехала против движения: ${byCar.distanceM} м`);
    assert.ok(byCar.geometry.length >= 6, 'объезд должен пройти через все углы квартала');
  });

  it('время совпадает с эталоном на графе, где точки вставлены как узлы', () => {
    const raw = buildGridGraph({
      slowEdges: new Set(['10,0->10,1', '10,1->10,2', '5,5->6,5', '20,20->20,21', '15,15->15,16']),
    });
    const graph = materialize(raw);
    const engine = createRoutingEngine({ graph });
    const settings = PROFILES.driving;

    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const randomPoint = () => ({
      lat: GRID.originLat + random() * (GRID.rows - 1) * GRID.step,
      lng: GRID.originLon + random() * (GRID.cols - 1) * GRID.step,
    });

    /*
     * Эталон строится независимо от движка: отрезки привязки разрезаются
     * виртуальными узлами, и по получившемуся графу идёт наивный Дейкстра.
     */
    const reference = (a, b) => {
      const adjacency = Array.from({ length: raw.nodeCount + 2 }, () => []);
      for (let from = 0; from < raw.nodeCount; from += 1) {
        for (let edge = raw.offsets[from]; edge < raw.offsets[from + 1]; edge += 1) {
          if (!(raw.access[edge] & settings.access)) continue;
          adjacency[from].push([raw.targets[edge], raw.lengths[edge] / (raw.speeds[edge] / 3.6)]);
        }
      }
      const split = (hit, virtual) => {
        const time = (fraction, edge) => (raw.lengths[edge] * fraction) / (raw.speeds[edge] / 3.6);
        if (hit.forward) {
          adjacency[hit.from].push([virtual, time(hit.t, hit.edge)]);
          adjacency[virtual].push([hit.to, time(1 - hit.t, hit.edge)]);
        }
        if (hit.reverseEdge >= 0) {
          adjacency[hit.to].push([virtual, time(1 - hit.t, hit.reverseEdge)]);
          adjacency[virtual].push([hit.from, time(hit.t, hit.reverseEdge)]);
        }
      };
      const source = raw.nodeCount;
      const target = raw.nodeCount + 1;
      split(a, source);
      split(b, target);

      const dist = new Array(adjacency.length).fill(Infinity);
      const done = new Array(adjacency.length).fill(false);
      dist[source] = 0;
      for (;;) {
        let current = -1;
        for (let node = 0; node < adjacency.length; node += 1) {
          if (!done[node] && (current === -1 || dist[node] < dist[current])) current = node;
        }
        if (current === -1 || dist[current] === Infinity || current === target) break;
        done[current] = true;
        for (const [next, cost] of adjacency[current]) {
          if (dist[current] + cost < dist[next]) dist[next] = dist[current] + cost;
        }
      }
      return dist[target];
    };

    let compared = 0;
    while (compared < 25) {
      const from = randomPoint();
      const to = randomPoint();
      const a = graph.snapToRoad(from.lat, from.lng, 'driving');
      const b = graph.snapToRoad(to.lat, to.lng, 'driving');
      if (a.edge === b.edge) continue;

      const result = engine.route({ waypoints: [from, to], profile: 'driving' });
      assert.equal(result.ok, true);
      const expected = reference(a, b);
      assert.ok(
        Math.abs(result.durationS - expected) <= 1,
        `пара ${compared}: движок ${result.durationS} с, эталон ${expected.toFixed(2)} с`,
      );
      compared += 1;
    }
  });

  it('геометрия начинается и кончается на дороге, а подводка сообщается отдельно', () => {
    const graph = materialize(buildGridGraph());
    const engine = createRoutingEngine({ graph });
    // Точки в середине кварталов — как здания между улицами.
    const from = { lat: GRID.originLat + 2.5 * GRID.step, lng: GRID.originLon + 2.5 * GRID.step };
    const to = { lat: GRID.originLat + 12.5 * GRID.step, lng: GRID.originLon + 20.5 * GRID.step };
    const result = engine.route({ waypoints: [from, to], profile: 'driving' });

    assert.equal(result.ok, true);
    assert.equal(result.snaps.length, 2);
    assert.deepEqual(result.geometry[0], [result.snaps[0].lat, result.snaps[0].lng]);
    assert.deepEqual(result.geometry.at(-1), [result.snaps[1].lat, result.snaps[1].lng]);
    assert.ok(result.snaps[0].distanceM > 20 && result.snaps[0].distanceM < 60);
  });

  it('матрица времён согласована с маршрутом', async () => {
    const graph = materialize(buildGridGraph({ slowEdges: new Set(['10,0->10,1']) }));
    const engine = createRoutingEngine({ graph });
    const origin = { lat: GRID.originLat + 1.3 * GRID.step, lng: GRID.originLon + 0.2 * GRID.step };
    const targets = [
      { lat: GRID.originLat + 20.4 * GRID.step, lng: GRID.originLon + 11 * GRID.step },
      { lat: GRID.originLat + 1.6 * GRID.step, lng: GRID.originLon + 0.2 * GRID.step },
      { lat: GRID.originLat + 33 * GRID.step, lng: GRID.originLon + 30.5 * GRID.step },
    ];

    const matrix = await engine.travelTimes(origin, targets, 'driving');
    targets.forEach((target, index) => {
      const single = engine.route({ waypoints: [origin, target], profile: 'driving' });
      assert.equal(single.ok, true);
      assert.ok(
        Math.abs(matrix[index].durationSeconds - single.durationS) <= 1,
        `цель ${index}: матрица ${matrix[index].durationSeconds}, маршрут ${single.durationS}`,
      );
    });
  });

  it('точка вне сети по-прежнему даёт понятный отказ', () => {
    const graph = materialize(buildGridGraph());
    const engine = createRoutingEngine({ graph });
    const result = engine.route({ waypoints: [pointOf(graph, 0), { lat: 10, lng: 10 }] });
    assert.equal(result.error, ROUTING_ERROR.OFF_NETWORK);
  });
});

describe('Правила доступа OSM', () => {
  it('кольцевая развязка односторонняя без тега oneway', () => {
    const ring = wayAccess({ highway: 'primary', junction: 'roundabout' });
    assert.ok(ring.forward & ACCESS.CAR);
    assert.equal(ring.backward & ACCESS.CAR, 0, 'машина едет по кольцу против движения');
    assert.equal(ring.backward & ACCESS.BIKE, 0, 'велосипед едет по кольцу против движения');
    assert.ok(ring.backward & ACCESS.FOOT, 'пешеходу кольцо не одностороннее');

    const explicit = wayAccess({ highway: 'primary', junction: 'roundabout', oneway: 'no' });
    assert.ok(explicit.backward & ACCESS.CAR);
  });

  it('автомагистраль односторонняя по умолчанию', () => {
    assert.equal(wayAccess({ highway: 'motorway' }).backward & ACCESS.CAR, 0);
  });

  it('явное разрешение сильнее общего запрета', () => {
    const zone = wayAccess({ highway: 'service', access: 'no', foot: 'yes' });
    assert.ok(zone, 'пешеходная зона выброшена целиком');
    assert.ok(zone.forward & ACCESS.FOOT);
    assert.equal(zone.forward & ACCESS.CAR, 0);
  });

  it('городской проспект проходим пешком, загородная трасса — нет', () => {
    assert.ok(wayAccess({ highway: 'trunk' }).forward & ACCESS.FOOT);
    const road = wayAccess({ highway: 'trunk', motorroad: 'yes' });
    assert.equal(road.forward & ACCESS.FOOT, 0);
    assert.ok(road.forward & ACCESS.CAR);
    assert.equal(wayAccess({ highway: 'residential', motorcar: 'no' }).forward & ACCESS.CAR, 0);
  });
});
