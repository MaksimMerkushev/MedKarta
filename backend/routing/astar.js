/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Поиск кратчайшего по времени пути: A* поверх типизированных массивов.
 * Под слабый сервер:
 *
 * 1. Состояние поиска выделяется один раз и переиспользуется. Вместо очистки
 *    массивов — счётчик поколений: запись своя, только если её метка равна
 *    номеру текущего поиска. Обнулять десяток мегабайт на каждый запрос
 *    дороже самого поиска.
 * 2. Куча — два плоских массива, а не массив объектов: на одном ядре сборщик
 *    мусора конкурирует с алгоритмом за процессор.
 * 3. Число раскрытых узлов ограничено: запрос через полгорода упирается в
 *    предсказуемый потолок и получает отказ, а не занимает ядро.
 *
 * Эвристика — расстояние по прямой, делённое на верхнюю границу скорости.
 * Она не переоценивает оставшееся время, поэтому путь оптимален; средняя
 * скорость сузила бы поиск, но маршруты перестали бы быть кратчайшими.
 */

import { distanceMeters } from './graph.js';
import { PROFILES } from './format.js';

export const SEARCH_RESULT = Object.freeze({
  FOUND: 'found',
  UNREACHABLE: 'unreachable',
  BUDGET_EXCEEDED: 'budget_exceeded',
});

/** Потолок раскрытых узлов на один поиск. Подобран по замерам, см. docs. */
export const DEFAULT_MAX_EXPANSIONS = 400_000;

const createHeap = (initialCapacity = 4096) => {
  let nodes = new Uint32Array(initialCapacity);
  let keys = new Float64Array(initialCapacity);
  let size = 0;

  const grow = () => {
    const bigger = new Uint32Array(nodes.length * 2);
    bigger.set(nodes);
    nodes = bigger;
    const biggerKeys = new Float64Array(keys.length * 2);
    biggerKeys.set(keys);
    keys = biggerKeys;
  };

  return {
    get size() {
      return size;
    },
    clear() {
      size = 0;
    },
    /** Ключ вершины кучи без извлечения. */
    peekKey() {
      return size > 0 ? keys[0] : Infinity;
    },
    push(node, key) {
      if (size === nodes.length) grow();
      let index = size;
      size += 1;
      nodes[index] = node;
      keys[index] = key;

      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (keys[parent] <= keys[index]) break;
        const tmpNode = nodes[parent];
        const tmpKey = keys[parent];
        nodes[parent] = nodes[index];
        keys[parent] = keys[index];
        nodes[index] = tmpNode;
        keys[index] = tmpKey;
        index = parent;
      }
    },
    pop() {
      const top = nodes[0];
      size -= 1;
      if (size > 0) {
        nodes[0] = nodes[size];
        keys[0] = keys[size];

        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          if (left >= size) break;
          const right = left + 1;
          const child = right < size && keys[right] < keys[left] ? right : left;
          if (keys[index] <= keys[child]) break;

          const tmpNode = nodes[child];
          const tmpKey = keys[child];
          nodes[child] = nodes[index];
          keys[child] = keys[index];
          nodes[index] = tmpNode;
          keys[index] = tmpKey;
          index = child;
        }
      }
      return top;
    },
  };
};

/**
 * Скорость ребра для профиля, м/с. Та же формула, что в поиске: иначе время
 * «хвостов» у точек привязки разойдётся с тем, что минимизировал алгоритм.
 */
export const edgeSpeedMps = (settings, speedKmh) =>
  settings.access === PROFILES.driving.access && speedKmh > 0
    ? speedKmh / 3.6
    : settings.fallbackSpeedKmh / 3.6;

/**
 * @param {object} graph результат createGraph
 */
export const createSearch = (graph) => {
  const { nodeCount, offsets, targets, lengths, speeds, access, lat, lon } = graph;

  /*
   * Верхняя граница скорости, реально достижимая в этом графе: эвристика не
   * должна переоценивать остаток, но чем она ближе к истине, тем уже поиск.
   * Паспортный maxSpeedKmh не годится: если в городе нет дорог быстрее
   * 60 км/ч, эвристика с 90 занижена в полтора раза и A* вырождается в
   * Дейкстру, а участки на 100 км/ч сделали бы её переоценивающей.
   *
   * Для пешехода и велосипеда скорость рёбер не используется, и граница —
   * скорость профиля.
   */
  const profileCeiling = (() => {
    const ceilings = {};
    for (const [name, settings] of Object.entries(PROFILES)) {
      if (settings.access !== PROFILES.driving.access) {
        ceilings[name] = settings.fallbackSpeedKmh;
        continue;
      }

      let observed = settings.fallbackSpeedKmh;
      for (let edge = 0; edge < speeds.length; edge += 1) {
        if ((access[edge] & settings.access) === 0) continue;
        if (speeds[edge] > observed) observed = speeds[edge];
      }
      ceilings[name] = observed;
    }
    return ceilings;
  })();

  // Выделяется один раз на граф, а не на запрос.
  const gScore = new Float64Array(nodeCount);
  const parent = new Int32Array(nodeCount);
  const seen = new Uint32Array(nodeCount);
  const settled = new Uint32Array(nodeCount);
  const heap = createHeap();

  let generation = 0;

  /** Длина пути от корня до узла по дереву поиска, метры. */
  const treeMetres = (node) => {
    let metres = 0;
    for (let current = node; parent[current] !== -1; current = parent[current]) {
      const previous = parent[current];
      metres += distanceMeters(lat[current], lon[current], lat[previous], lon[previous]);
    }
    return metres;
  };

  const rootOf = (node) => {
    let current = node;
    while (parent[current] !== -1) current = parent[current];
    return current;
  };

  /** Стартовая запись, породившая корень: самая дешёвая с этим узлом. */
  const startFor = (starts, root) => {
    let chosen = null;
    for (const start of starts) {
      if (start.node === root && (!chosen || start.cost < chosen.cost)) chosen = start;
    }
    return chosen;
  };

  const seed = (starts, keyOf) => {
    for (const start of starts) {
      const node = start.node;
      if (seen[node] === generation && gScore[node] <= start.cost) continue;
      gScore[node] = start.cost;
      parent[node] = -1;
      seen[node] = generation;
      heap.push(node, keyOf(node, start.cost));
    }
  };

  /**
   * Кратчайший по времени путь. Две формы вызова:
   *   { source, target }            — от узла до узла;
   *   { sources, goals, goalPoint } — от точки на отрезке до точки на отрезке.
   *
   * Во второй форме старт и финиш лежат внутри рёбер: sources — узлы, до
   * которых можно доехать от стартовой точки, с уже набежавшей стоимостью;
   * goals — узлы, от которых можно доехать до финишной точки, со стоимостью
   * «хвоста». Поиск останавливается не на первом осевшем финишном узле,
   * а когда ни один узел в куче уже не может дать лучшего итога.
   *
   * @param {object} params
   * @param {number} [params.source] индекс узла
   * @param {number} [params.target] индекс узла
   * @param {Array<{node: number, cost: number, metres?: number}>} [params.sources]
   * @param {Array<{node: number, cost: number, metres?: number}>} [params.goals]
   * @param {number[]} [params.goalPoint] [lat, lon] финиша в целых координатах — для эвристики
   * @param {string} params.profile driving | foot | bike
   * @param {number} [params.maxExpansions]
   * @returns {{status: string, durationS?: number, distanceM?: number, path?: Uint32Array,
   *            expanded: number, start?: object, goal?: object}}
   */
  const run = ({
    source,
    target,
    sources,
    goals,
    goalPoint,
    profile = 'driving',
    maxExpansions = DEFAULT_MAX_EXPANSIONS,
  }) => {
    const settings = PROFILES[profile] || PROFILES.driving;
    const maxSpeedMps = (profileCeiling[profile] || settings.maxSpeedKmh) / 3.6;
    const fallbackMps = settings.fallbackSpeedKmh / 3.6;
    const useEdgeSpeed = settings.access === PROFILES.driving.access;

    generation += 1;
    heap.clear();

    const starts = sources || [{ node: source, cost: 0, metres: 0 }];
    const ends = goals || [{ node: target, cost: 0, metres: 0 }];

    if (starts.length === 0 || ends.length === 0) {
      return { status: SEARCH_RESULT.UNREACHABLE, expanded: 0 };
    }

    if (!sources && !goals && source === target) {
      return {
        status: SEARCH_RESULT.FOUND,
        durationS: 0,
        distanceM: 0,
        path: Uint32Array.of(source),
        expanded: 0,
        start: starts[0],
        goal: ends[0],
      };
    }

    const targetLat = goalPoint ? goalPoint[0] : lat[ends[0].node];
    const targetLon = goalPoint ? goalPoint[1] : lon[ends[0].node];
    const heuristic = (node) =>
      distanceMeters(lat[node], lon[node], targetLat, targetLon) / maxSpeedMps;

    seed(starts, (node, cost) => cost + heuristic(node));

    let best = Infinity;
    let bestNode = -1;
    let bestGoal = null;
    let expanded = 0;
    let exhausted = false;

    while (heap.size > 0) {
      // Эвристика не переоценивает остаток, поэтому ключ вершины кучи —
      // нижняя граница любого ещё не найденного маршрута.
      if (heap.peekKey() >= best) break;

      const current = heap.pop();
      if (settled[current] === generation) continue;
      settled[current] = generation;
      expanded += 1;

      for (let i = 0; i < ends.length; i += 1) {
        if (ends[i].node !== current) continue;
        const total = gScore[current] + ends[i].cost;
        if (total < best) {
          best = total;
          bestNode = current;
          bestGoal = ends[i];
        }
      }

      if (expanded >= maxExpansions) {
        exhausted = true;
        break;
      }

      const from = offsets[current];
      const to = offsets[current + 1];
      const baseCost = gScore[current];

      for (let edge = from; edge < to; edge += 1) {
        if ((access[edge] & settings.access) === 0) continue;

        const next = targets[edge];
        if (settled[next] === generation) continue;

        const speedMps = useEdgeSpeed && speeds[edge] > 0 ? speeds[edge] / 3.6 : fallbackMps;
        const tentative = baseCost + lengths[edge] / speedMps;

        if (seen[next] === generation && gScore[next] <= tentative) continue;

        gScore[next] = tentative;
        parent[next] = current;
        seen[next] = generation;
        heap.push(next, tentative + heuristic(next));
      }
    }

    if (bestNode < 0) {
      return {
        status: exhausted ? SEARCH_RESULT.BUDGET_EXCEEDED : SEARCH_RESULT.UNREACHABLE,
        expanded,
      };
    }

    let length = 1;
    for (let node = bestNode; parent[node] !== -1; node = parent[node]) length += 1;

    const path = new Uint32Array(length);
    let cursor = length - 1;
    for (let node = bestNode; ; node = parent[node]) {
      path[cursor] = node;
      if (parent[node] === -1) break;
      cursor -= 1;
    }

    const start = startFor(starts, path[0]);
    return {
      status: SEARCH_RESULT.FOUND,
      durationS: best,
      distanceM: treeMetres(bestNode) + (start?.metres || 0) + (bestGoal.metres || 0),
      path,
      expanded,
      start,
      goal: bestGoal,
    };
  };

  /**
   * Один источник — много целей за один обход (выбор ближайшей клиники):
   * отдельные A* на каждого кандидата обходили бы одну окрестность раз за
   * разом. Это Дейкстра, остановка — когда осели все цели. Без эвристики:
   * она направлена на одну цель и для веера целей только мешает.
   *
   * Формы вызова — как у run: { source, targets } по узлам или
   * { sources, goals } по точкам на отрезках, где goals[i] — список узлов,
   * через которые можно попасть в i-ю цель, или null для недоступной.
   *
   * @returns {{durations: Float64Array, distances: Float64Array, expanded: number,
   *            resolved: number}} бесконечность в ячейке означает «не достигнуто»
   */
  const runOneToMany = ({
    source,
    targets: goalNodes,
    sources,
    goals,
    profile = 'driving',
    maxExpansions = DEFAULT_MAX_EXPANSIONS,
    // Потолок времени, с («не дольше 20 минут»): обход останавливается,
    // когда ближайший неосевший узел дальше потолка — дальние цели всё равно
    // не прошли бы фильтр.
    maxCost = Number.POSITIVE_INFINITY,
  }) => {
    const settings = PROFILES[profile] || PROFILES.driving;
    const fallbackMps = settings.fallbackSpeedKmh / 3.6;
    const useEdgeSpeed = settings.access === PROFILES.driving.access;

    generation += 1;
    heap.clear();

    const starts = sources || [{ node: source, cost: 0, metres: 0 }];
    const goalLists = goals || goalNodes.map((node) => [{ node, cost: 0, metres: 0 }]);

    const durations = new Float64Array(goalLists.length).fill(Infinity);
    const distances = new Float64Array(goalLists.length).fill(Infinity);

    // Узел может вести к нескольким целям: две клиники в одном здании
    // привязываются к одному отрезку.
    const watch = new Map();
    goalLists.forEach((list, index) => {
      for (const entry of list || []) {
        const hits = watch.get(entry.node);
        if (hits) hits.push([index, entry]);
        else watch.set(entry.node, [[index, entry]]);
      }
    });

    seed(starts, (node, cost) => cost);

    let expanded = 0;
    let pending = watch.size;

    while (heap.size > 0 && pending > 0) {
      const current = heap.pop();
      if (settled[current] === generation) continue;
      // Узлы выходят из кучи по возрастанию времени: дальше будет только дольше.
      if (gScore[current] > maxCost) break;
      settled[current] = generation;
      expanded += 1;

      const hits = watch.get(current);
      if (hits) {
        const start = startFor(starts, rootOf(current));
        const metres = treeMetres(current) + (start?.metres || 0);
        for (const [index, entry] of hits) {
          const total = gScore[current] + entry.cost;
          if (total < durations[index]) {
            durations[index] = total;
            distances[index] = metres + (entry.metres || 0);
          }
        }
        pending -= 1;
      }

      if (expanded >= maxExpansions) break;

      const from = offsets[current];
      const to = offsets[current + 1];
      const baseCost = gScore[current];

      for (let edge = from; edge < to; edge += 1) {
        if ((access[edge] & settings.access) === 0) continue;

        const next = targets[edge];
        if (settled[next] === generation) continue;

        const speedMps = useEdgeSpeed && speeds[edge] > 0 ? speeds[edge] / 3.6 : fallbackMps;
        const tentative = baseCost + lengths[edge] / speedMps;

        if (seen[next] === generation && gScore[next] <= tentative) continue;

        gScore[next] = tentative;
        parent[next] = current;
        seen[next] = generation;
        heap.push(next, tentative);
      }
    }

    return { durations, distances, expanded, resolved: watch.size - pending };
  };

  return Object.freeze({
    run,
    runOneToMany,
    /** Верхние границы скорости, выведенные из графа. Для диагностики. */
    profileCeiling,
    /** Память состояния поиска, байты. Не зависит от числа запросов. */
    stateBytes: gScore.byteLength + parent.byteLength + seen.byteLength + settled.byteLength,
  });
};
