/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Локальный движок маршрутизации: корректность и границы.
 *
 * Главная проверка — согласие A* с независимо написанным Дейкстрой на сотнях
 * пар точек. Оптимизированный поиск легко «почти работает»: возвращает путь,
 * который выглядит правдоподобно, но не кратчайший. Заметить это глазами
 * невозможно, поэтому сравнение с эталоном обязательно.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSearch, SEARCH_RESULT } from '../backend/routing/astar.js';
import { createGraph } from '../backend/routing/graph.js';
import { createRoutingEngine, ROUTING_ERROR } from '../backend/routing/engine.js';
import { ACCESS, decodeGraph, encodeGraph, PROFILES } from '../backend/routing/format.js';
import {
  buildOverpassQuery,
  osmToGraph,
  parseMaxSpeed,
  ROUTABLE_HIGHWAY_TYPES,
  wayAccess,
} from '../backend/routing/osm.js';
import { buildGridGraph, GRID, nodeIndex, referenceDijkstra } from './fixtures/roadGraph.js';

const materialize = (raw) => createGraph(decodeGraph(encodeGraph(raw)));

const CAR = { access: ACCESS.CAR, fallbackMps: PROFILES.driving.fallbackSpeedKmh / 3.6, useEdgeSpeed: true };
const FOOT = { access: ACCESS.FOOT, fallbackMps: PROFILES.foot.fallbackSpeedKmh / 3.6, useEdgeSpeed: false };

describe('Бинарный формат графа', () => {
  it('переживает запись и чтение без потерь', () => {
    const raw = buildGridGraph();
    const decoded = decodeGraph(encodeGraph(raw));

    assert.equal(decoded.nodeCount, raw.nodeCount);
    assert.equal(decoded.edgeCount, raw.edgeCount);
    assert.deepEqual(Array.from(decoded.lat.slice(0, 50)), Array.from(raw.lat.slice(0, 50)));
    assert.deepEqual(Array.from(decoded.targets.slice(0, 200)), Array.from(raw.targets.slice(0, 200)));
    assert.deepEqual(Array.from(decoded.offsets), Array.from(raw.offsets));
  });

  it('отвергает чужой и повреждённый файл', () => {
    assert.throws(() => decodeGraph(Buffer.alloc(8)), /truncated/);
    const alien = Buffer.alloc(128);
    alien.writeUInt32LE(0xdeadbeef, 0);
    assert.throws(() => decodeGraph(alien), /not a MedКарта graph/);
  });

  it('не копирует данные при разборе', () => {
    const buffer = encodeGraph(buildGridGraph());
    const decoded = decodeGraph(buffer);
    // Типизированные представления смотрят в тот же буфер: для графа
    // в десятки мегабайт копия удвоила бы расход памяти.
    assert.equal(decoded.lat.buffer, buffer.buffer);
  });
});

describe('Привязка координат к дорожной сети', () => {
  const graph = materialize(buildGridGraph());

  it('находит ближайший узел', () => {
    const target = nodeIndex(10, 15);
    const [lat, lon] = graph.coordsOf(target);
    // Смещаем точку на треть шага сетки — ближайшим обязан остаться тот же узел.
    const hit = graph.snap(lat + GRID.step / 3, lon - GRID.step / 3);

    assert.ok(hit, 'узел не найден');
    assert.equal(hit.node, target);
    assert.ok(hit.distance < 100, `слишком далеко: ${hit.distance}`);
  });

  it('перебирает все узлы сетки без промаха', () => {
    for (let row = 0; row < GRID.rows; row += 7) {
      for (let col = 0; col < GRID.cols; col += 7) {
        const expected = nodeIndex(row, col);
        const [lat, lon] = graph.coordsOf(expected);
        assert.equal(graph.snap(lat, lon).node, expected, `промах на ${row},${col}`);
      }
    }
  });

  it('возвращает null для точки вдали от дорог', () => {
    assert.equal(graph.snap(0, 0), null);
    assert.equal(graph.snap(GRID.originLat + 5, GRID.originLon + 5), null);
  });
});

describe('A* согласен с эталонным Дейкстрой', () => {
  const raw = buildGridGraph({
    // Медленные участки делают кратчайший по ВРЕМЕНИ путь непохожим
    // на кратчайший по расстоянию — иначе тест не поймал бы подмену метрики.
    slowEdges: new Set(['10,0->10,1', '10,1->10,2', '10,2->10,3', '5,5->6,5', '20,20->20,21']),
  });
  const graph = materialize(raw);
  const search = createSearch(graph);

  it('совпадает по времени поездки на выборке пар', () => {
    let checked = 0;
    for (let row = 0; row < GRID.rows; row += 9) {
      for (let col = 0; col < GRID.cols; col += 9) {
        const source = nodeIndex(0, 0);
        const target = nodeIndex(row, col);
        if (source === target) continue;

        const actual = search.run({ source, target, profile: 'driving' });
        const expected = referenceDijkstra(raw, source, target, CAR);

        assert.equal(actual.status, SEARCH_RESULT.FOUND, `путь не найден до ${row},${col}`);
        assert.ok(
          Math.abs(actual.durationS - expected) < 1e-6,
          `до ${row},${col}: A* дал ${actual.durationS}, эталон ${expected}`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 20, `проверено слишком мало пар: ${checked}`);
  });

  it('совпадает и для пешего профиля, где скорость рёбер игнорируется', () => {
    const source = nodeIndex(3, 3);
    const target = nodeIndex(30, 28);

    const actual = search.run({ source, target, profile: 'foot' });
    const expected = referenceDijkstra(raw, source, target, FOOT);

    assert.equal(actual.status, SEARCH_RESULT.FOUND);
    assert.ok(Math.abs(actual.durationS - expected) < 1e-6);
  });

  it('обходит медленный участок, если это быстрее', () => {
    // Прямой путь по строке 10 проходит через три медленных ребра.
    const direct = search.run({ source: nodeIndex(10, 0), target: nodeIndex(10, 3), profile: 'driving' });
    assert.equal(direct.status, SEARCH_RESULT.FOUND);

    const path = Array.from(direct.path);
    const stayedOnRow = path.every((node) => Math.floor(node / GRID.cols) === 10);
    assert.ok(!stayedOnRow, 'маршрут пошёл напрямую через медленные рёбра — оптимизируется не время');
  });

  it('путь связен: каждый следующий узел — сосед предыдущего', () => {
    const result = search.run({ source: nodeIndex(0, 0), target: nodeIndex(25, 30), profile: 'driving' });
    assert.equal(result.status, SEARCH_RESULT.FOUND);

    for (let i = 0; i + 1 < result.path.length; i += 1) {
      const from = result.path[i];
      const to = result.path[i + 1];
      let connected = false;
      for (let edge = graph.offsets[from]; edge < graph.offsets[from + 1]; edge += 1) {
        if (graph.targets[edge] === to) { connected = true; break; }
      }
      assert.ok(connected, `узлы ${from} и ${to} не соединены ребром`);
    }
  });
});

describe('Профили и границы поиска', () => {
  it('автомобиль не едет по пешеходной улице', () => {
    const raw = buildGridGraph({
      // Полностью перерезаем колонку 1 для автомобиля.
      footOnlyEdges: new Set(
        Array.from({ length: GRID.rows }, (_, row) => `${row},0->${row},1`),
      ),
    });
    const graph = materialize(raw);
    const search = createSearch(graph);

    const source = nodeIndex(20, 0);
    const target = nodeIndex(20, 2);

    const onFoot = search.run({ source, target, profile: 'foot' });
    assert.equal(onFoot.status, SEARCH_RESULT.FOUND);

    const byCar = search.run({ source, target, profile: 'driving' });
    // Объехать нельзя — колонка перерезана целиком.
    assert.equal(byCar.status, SEARCH_RESULT.UNREACHABLE, 'автомобиль проехал по пешеходной улице');
  });

  it('возвращает отказ для несвязного компонента', () => {
    const graph = materialize(buildGridGraph({ island: true }));
    const search = createSearch(graph);

    const result = search.run({ source: nodeIndex(0, 0), target: GRID.rows * GRID.cols, profile: 'driving' });
    assert.equal(result.status, SEARCH_RESULT.UNREACHABLE);
  });

  it('упирается в потолок раскрытых узлов, а не занимает ядро', () => {
    const graph = materialize(buildGridGraph());
    const search = createSearch(graph);

    const result = search.run({
      source: nodeIndex(0, 0),
      target: nodeIndex(GRID.rows - 1, GRID.cols - 1),
      profile: 'driving',
      maxExpansions: 5,
    });

    assert.equal(result.status, SEARCH_RESULT.BUDGET_EXCEEDED);
    assert.ok(result.expanded <= 6);
  });

  it('состояние поиска переиспользуется между запросами', () => {
    const graph = materialize(buildGridGraph());
    const search = createSearch(graph);

    const first = search.run({ source: nodeIndex(0, 0), target: nodeIndex(5, 5), profile: 'driving' });
    const second = search.run({ source: nodeIndex(0, 0), target: nodeIndex(5, 5), profile: 'driving' });
    const third = search.run({ source: nodeIndex(5, 5), target: nodeIndex(0, 0), profile: 'driving' });

    // Если бы метки поколений не сбрасывали состояние, второй поиск
    // унаследовал бы чужие расстояния и дал другой ответ.
    assert.equal(first.durationS, second.durationS);
    assert.ok(Math.abs(first.durationS - third.durationS) < 1e-6, 'граф симметричен, время должно совпасть');
  });
});

describe('Движок маршрутизации', () => {
  const graph = materialize(buildGridGraph());
  const engine = createRoutingEngine({ graph });
  const at = (row, col) => {
    const [lat, lng] = graph.coordsOf(nodeIndex(row, col));
    return { lat, lng };
  };

  it('строит маршрут через несколько точек', () => {
    const result = engine.route({ waypoints: [at(0, 0), at(10, 10), at(20, 5)], profile: 'driving' });

    assert.equal(result.ok, true);
    assert.equal(result.legs.length, 2);
    assert.ok(result.distanceM > 0);
    assert.ok(result.durationS > 0);
    assert.ok(result.geometry.length > 10);
  });

  it('геометрия непрерывна и не дублирует стыки участков', () => {
    const result = engine.route({ waypoints: [at(0, 0), at(5, 5), at(10, 0)], profile: 'driving' });
    assert.equal(result.ok, true);

    for (let i = 0; i + 1 < result.geometry.length; i += 1) {
      const [latA, lonA] = result.geometry[i];
      const [latB, lonB] = result.geometry[i + 1];
      assert.ok(
        Math.abs(latA - latB) > 1e-9 || Math.abs(lonA - lonB) > 1e-9,
        `точка ${i} продублирована на стыке участков`,
      );
    }
  });

  it('отказывает для точки вне дорожной сети', () => {
    const result = engine.route({ waypoints: [at(0, 0), { lat: 0, lng: 0 }] });
    assert.equal(result.ok, false);
    assert.equal(result.error, ROUTING_ERROR.OFF_NETWORK);
  });

  it('отвергает некорректный запрос', () => {
    assert.equal(engine.route({ waypoints: [at(0, 0)] }).error, ROUTING_ERROR.BAD_REQUEST);
    assert.equal(engine.route({ waypoints: [] }).error, ROUTING_ERROR.BAD_REQUEST);
    assert.equal(
      engine.route({ waypoints: [at(0, 0), { lat: 'юг', lng: null }] }).error,
      ROUTING_ERROR.OFF_NETWORK,
    );
  });

  it('матрица времён совместима с контрактом исполнителя', async () => {
    const times = await engine.travelTimes(at(0, 0), [at(1, 1), at(20, 20), { lat: 0, lng: 0 }], 'driving');

    assert.equal(times.length, 3);
    assert.ok(times[0].durationSeconds < times[1].durationSeconds, 'ближняя точка должна быть быстрее дальней');
    assert.equal(times[0].approximate, false);
    // Точка вне сети не роняет матрицу — возвращается пустая оценка.
    assert.equal(times[2].durationSeconds, null);
    assert.equal(times[2].approximate, true);
  });

  it('кеш не растёт бесконечно', () => {
    for (let i = 0; i < 400; i += 1) {
      engine.route({ waypoints: [at(0, 0), at(i % GRID.rows, (i * 7) % GRID.cols)] });
    }
    assert.ok(engine.stats().cacheEntries <= 256, `кеш разросся: ${engine.stats().cacheEntries}`);
  });
});

describe('Матрица «один ко многим»', () => {
  const raw = buildGridGraph({ slowEdges: new Set(['10,0->10,1', '5,5->6,5']) });
  const graph = materialize(raw);
  const search = createSearch(graph);

  it('совпадает с отдельными поисками до каждой цели', () => {
    const source = nodeIndex(2, 2);
    const goals = [nodeIndex(20, 20), nodeIndex(5, 30), nodeIndex(35, 4), nodeIndex(10, 3)];

    const matrix = search.runOneToMany({ source, targets: goals, profile: 'driving' });

    goals.forEach((goal, index) => {
      const single = search.run({ source, target: goal, profile: 'driving' });
      assert.equal(single.status, SEARCH_RESULT.FOUND);
      assert.ok(
        Math.abs(matrix.durations[index] - single.durationS) < 1e-6,
        `цель ${index}: матрица ${matrix.durations[index]}, отдельный поиск ${single.durationS}`,
      );
    });
  });

  it('обходит граф один раз, а не по разу на цель', () => {
    const source = nodeIndex(2, 2);
    const goals = [nodeIndex(20, 20), nodeIndex(21, 20), nodeIndex(20, 21), nodeIndex(19, 20)];

    const matrix = search.runOneToMany({ source, targets: goals, profile: 'driving' });
    const singleSum = goals.reduce(
      (sum, goal) => sum + search.run({ source, target: goal, profile: 'driving' }).expanded,
      0,
    );

    assert.ok(
      matrix.expanded < singleSum,
      `матрица раскрыла ${matrix.expanded}, отдельные поиски ${singleSum} — экономии нет`,
    );
  });

  it('две цели на одном узле получают одинаковый ответ', () => {
    const source = nodeIndex(0, 0);
    const shared = nodeIndex(12, 12);
    const matrix = search.runOneToMany({ source, targets: [shared, shared], profile: 'driving' });

    assert.equal(matrix.durations[0], matrix.durations[1]);
    assert.ok(Number.isFinite(matrix.durations[0]));
  });

  it('недостижимая цель остаётся бесконечностью, не ломая остальные', () => {
    const islandGraph = materialize(buildGridGraph({ island: true }));
    const islandSearch = createSearch(islandGraph);
    const island = GRID.rows * GRID.cols;

    const matrix = islandSearch.runOneToMany({
      source: nodeIndex(0, 0),
      targets: [nodeIndex(4, 4), island],
      profile: 'driving',
    });

    assert.ok(Number.isFinite(matrix.durations[0]));
    assert.equal(matrix.durations[1], Infinity);
  });
});

describe('Разбор выгрузки OpenStreetMap', () => {
  it('разбирает maxspeed во всех встречающихся формах', () => {
    assert.equal(parseMaxSpeed('60'), 60);
    assert.equal(parseMaxSpeed('60 km/h'), 60);
    assert.equal(parseMaxSpeed('RU:urban'), 60);
    assert.equal(parseMaxSpeed('RU:living_street'), 20);
    assert.equal(parseMaxSpeed('30 mph'), 48);
    assert.equal(parseMaxSpeed('walk'), null);
    assert.equal(parseMaxSpeed('999'), null, 'нереальная скорость должна отвергаться');
    assert.equal(parseMaxSpeed(undefined), null);
  });

  it('односторонняя улица закрыта для авто назад, но открыта пешеходу', () => {
    const access = wayAccess({ highway: 'residential', oneway: 'yes' });
    assert.ok(access.forward & ACCESS.CAR);
    assert.ok(!(access.backward & ACCESS.CAR), 'автомобиль поехал против одностороннего');
    assert.ok(access.backward & ACCESS.FOOT, 'пешеходу перекрыли тротуар');
  });

  it('oneway=-1 разворачивает ограничение', () => {
    const access = wayAccess({ highway: 'residential', oneway: '-1' });
    assert.ok(!(access.forward & ACCESS.CAR));
    assert.ok(access.backward & ACCESS.CAR);
  });

  it('автомагистраль закрыта для пешехода и велосипеда', () => {
    const access = wayAccess({ highway: 'motorway' });
    assert.ok(access.forward & ACCESS.CAR);
    assert.ok(!(access.forward & ACCESS.FOOT));
    assert.ok(!(access.forward & ACCESS.BIKE));
  });

  it('тротуар и лестница закрыты для автомобиля', () => {
    assert.ok(!(wayAccess({ highway: 'footway' }).forward & ACCESS.CAR));
    assert.ok(wayAccess({ highway: 'steps' }).forward & ACCESS.FOOT);
  });

  it('частный проезд и закрытый доступ отбрасываются', () => {
    assert.equal(wayAccess({ highway: 'service', access: 'private' }), null);
    assert.equal(wayAccess({ highway: 'unknown_kind' }), null);
    assert.ok(!(wayAccess({ highway: 'residential', motor_vehicle: 'no' }).forward & ACCESS.CAR));
  });

  it('собирает связный граф из выгрузки', () => {
    const elements = [
      { type: 'node', id: 1, lat: 55.79, lon: 49.11 },
      { type: 'node', id: 2, lat: 55.791, lon: 49.11 },
      { type: 'node', id: 3, lat: 55.792, lon: 49.11 },
      // Узел с тегом, не лежащий ни на одном пути: в граф попасть не должен.
      { type: 'node', id: 99, lat: 55.8, lon: 49.2, tags: { amenity: 'pharmacy' } },
      { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential', maxspeed: '40' } },
      // Путь без пригодного тега highway.
      { type: 'way', id: 11, nodes: [1, 3], tags: { building: 'yes' } },
    ];

    const { graph, stats } = osmToGraph(elements);

    assert.equal(stats.nodeCount, 3, 'узел-тег попал в граф');
    assert.equal(stats.acceptedWays, 1);
    // Две пары узлов, по ребру в каждую сторону.
    assert.equal(stats.edgeCount, 4);

    const built = materialize(graph);
    const search = createSearch(built);
    const result = search.run({ source: 0, target: 2, profile: 'driving' });

    assert.equal(result.status, SEARCH_RESULT.FOUND);
    assert.ok(result.distanceM > 150 && result.distanceM < 300, `неправдоподобная длина: ${result.distanceM}`);
  });

  it('односторонняя улица в графе действительно односторонняя', () => {
    const elements = [
      { type: 'node', id: 1, lat: 55.79, lon: 49.11 },
      { type: 'node', id: 2, lat: 55.791, lon: 49.11 },
      { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', oneway: 'yes' } },
    ];

    const built = materialize(osmToGraph(elements).graph);
    const search = createSearch(built);

    assert.equal(search.run({ source: 0, target: 1, profile: 'driving' }).status, SEARCH_RESULT.FOUND);
    assert.equal(
      search.run({ source: 1, target: 0, profile: 'driving' }).status,
      SEARCH_RESULT.UNREACHABLE,
      'автомобиль проехал против одностороннего движения',
    );
    assert.equal(
      search.run({ source: 1, target: 0, profile: 'foot' }).status,
      SEARCH_RESULT.FOUND,
      'пешеходу перекрыли путь по односторонней улице',
    );
  });
});

describe('Запрос к Overpass', () => {
  it('просит пути ВМЕСТЕ С ТЕГАМИ, а не только скелет', () => {
    const query = buildOverpassQuery([55.65, 48.85, 55.98, 49.42]);

    // Один «out skel» на всё выглядит правдоподобно — узлы и пути на месте,
    // размер ответа нормальный, — но теги отброшены, и граф выходит пустым.
    // Эта ошибка уже была, поэтому закреплена тестом.
    assert.match(query, /out body;/, 'пути запрошены без тегов');
    assert.match(query, />;/, 'нет рекурсии к узлам путей');
    assert.match(query, /out skel qt;/, 'узлы должны выгружаться без тегов');
    assert.ok(
      query.indexOf('out body;') < query.indexOf('out skel qt;'),
      'порядок операторов неверный: сначала пути с тегами, потом их узлы',
    );
  });

  it('подставляет рамку в правильном порядке', () => {
    const query = buildOverpassQuery([55.1, 48.2, 55.3, 48.4]);
    assert.match(query, /\(55\.1,48\.2,55\.3,48\.4\)/);
  });

  it('выгрузка без тегов не даёт ни одной дороги — сборщик обязан это заметить', () => {
    const skeleton = [
      { type: 'node', id: 1, lat: 55.79, lon: 49.11 },
      { type: 'node', id: 2, lat: 55.791, lon: 49.11 },
      { type: 'way', id: 10, nodes: [1, 2] },
    ];

    const { stats } = osmToGraph(skeleton);
    assert.equal(stats.osmWays, 1);
    assert.equal(stats.acceptedWays, 0, 'путь без тегов не должен приниматься');
    assert.equal(stats.nodeCount, 0);
  });
});

describe('Белый список типов дорог', () => {
  it('запрос и разбор не расходятся', () => {
    const query = buildOverpassQuery([55, 49, 56, 50]);

    // Если запрос просит тип, который разбор не принимает, мы качаем данные
    // и молча их выбрасываем. Если наоборот — теряем дороги. Поэтому список
    // в запросе выводится из той же таблицы, что и права проезда.
    for (const type of ROUTABLE_HIGHWAY_TYPES) {
      assert.ok(query.includes(type), `тип ${type} принимается разбором, но не запрашивается`);
      assert.ok(
        wayAccess({ highway: type }) !== null,
        `тип ${type} запрашивается, но разбором отвергается`,
      );
    }
  });

  it('не запрашивает то, что заведомо не нужно', () => {
    const query = buildOverpassQuery([55, 49, 56, 50]);
    for (const junk of ['proposed', 'construction', 'raceway', 'platform', 'corridor']) {
      assert.ok(!query.includes(junk), `в запрос попал бесполезный тип ${junk}`);
      assert.equal(wayAccess({ highway: junk }), null);
    }
  });
});
