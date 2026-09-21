/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Поиск кратчайшего по времени пути: A* поверх типизированных массивов.
 *
 * ТРИ РЕШЕНИЯ, ПРОДИКТОВАННЫЕ СЛАБЫМ СЕРВЕРОМ.
 *
 * 1. Состояние поиска выделяется ОДИН раз при создании и переиспользуется.
 *    Очистка массивов между запросами заменена счётчиком поколений: запись
 *    считается своей, только если её метка совпадает с номером текущего
 *    поиска. Обнуление десятка мегабайт на каждый запрос стоило бы дороже
 *    самого поиска.
 *
 * 2. Куча — два плоских массива вместо массива объектов. На одном ядре
 *    сборщик мусора конкурирует с самим алгоритмом за процессор.
 *
 * 3. Число раскрытых узлов ограничено сверху. Запрос через полгорода на
 *    слабой машине должен упереться в предсказуемый потолок и вернуть отказ,
 *    а не занять ядро на неопределённое время.
 *
 * Эвристика — расстояние по прямой, делённое на ВЕРХНЮЮ границу скорости
 * профиля. Она заведомо не переоценивает оставшееся время, поэтому найденный
 * путь оптимален. Взять среднюю скорость было бы соблазнительно (поиск стал
 * бы уже), но тогда алгоритм начал бы возвращать не кратчайшие маршруты.
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
 * @param {object} graph результат createGraph
 */
export const createSearch = (graph) => {
  const { nodeCount, offsets, targets, lengths, speeds, access, lat, lon } = graph;

  // Выделяется один раз на процесс.
  /*
   * Верхняя граница скорости, реально достижимая В ЭТОМ графе.
   *
   * Эвристика обязана не переоценивать оставшееся время, но чем она ближе
   * к истине, тем уже поиск. Брать паспортный максимум профиля (90 км/ч для
   * авто) неверно по существу: если в городе нет ни одной дороги быстрее 60,
   * эвристика занижена в полтора раза и A* вырождается в Дейкстру. На замере
   * маршрут через весь город из-за этого упирался в потолок раскрытых узлов.
   *
   * Для пешехода и велосипеда скорость рёбер вообще не используется, поэтому
   * верхняя граница — это и есть скорость профиля.
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
      ceilings[name] = Math.min(settings.maxSpeedKmh, observed);
    }
    return ceilings;
  })();

  const gScore = new Float64Array(nodeCount);
  const parent = new Int32Array(nodeCount);
  const seen = new Uint32Array(nodeCount);
  const settled = new Uint32Array(nodeCount);
  const heap = createHeap();

  let generation = 0;

  /**
   * @param {object} params
   * @param {number} params.source индекс узла
   * @param {number} params.target индекс узла
   * @param {string} params.profile driving | foot | bike
   * @param {number} [params.maxExpansions]
   * @returns {{status: string, durationS?: number, distanceM?: number, path?: Uint32Array, expanded: number}}
   */
  const run = ({ source, target, profile = 'driving', maxExpansions = DEFAULT_MAX_EXPANSIONS }) => {
    const settings = PROFILES[profile] || PROFILES.driving;
    const maxSpeedMps = (profileCeiling[profile] || settings.maxSpeedKmh) / 3.6;
    const fallbackMps = settings.fallbackSpeedKmh / 3.6;
    const useEdgeSpeed = settings.access === PROFILES.driving.access;

    generation += 1;
    heap.clear();

    if (source === target) {
      return { status: SEARCH_RESULT.FOUND, durationS: 0, distanceM: 0, path: Uint32Array.of(source), expanded: 0 };
    }

    const targetLat = lat[target];
    const targetLon = lon[target];
    const heuristic = (node) =>
      distanceMeters(lat[node], lon[node], targetLat, targetLon) / maxSpeedMps;

    gScore[source] = 0;
    parent[source] = -1;
    seen[source] = generation;
    heap.push(source, heuristic(source));

    let expanded = 0;

    while (heap.size > 0) {
      const current = heap.pop();
      if (settled[current] === generation) continue;
      settled[current] = generation;
      expanded += 1;

      if (current === target) {
        // Восстановление пути от цели к источнику.
        let length = 1;
        for (let node = target; parent[node] !== -1; node = parent[node]) length += 1;

        const path = new Uint32Array(length);
        let cursor = length - 1;
        let distanceM = 0;
        for (let node = target; ; node = parent[node]) {
          path[cursor] = node;
          if (parent[node] === -1) break;
          distanceM += distanceMeters(lat[node], lon[node], lat[parent[node]], lon[parent[node]]);
          cursor -= 1;
        }

        return {
          status: SEARCH_RESULT.FOUND,
          durationS: gScore[target],
          distanceM,
          path,
          expanded,
        };
      }

      if (expanded >= maxExpansions) {
        return { status: SEARCH_RESULT.BUDGET_EXCEEDED, expanded };
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

    return { status: SEARCH_RESULT.UNREACHABLE, expanded };
  };

  /**
   * Один источник — много целей, за ОДИН обход.
   *
   * Так работает выбор ближайшей клиники: кандидатов до десяти, и запускать
   * десять отдельных A* значит десять раз обойти одну и ту же окрестность.
   * Здесь идёт обычный Дейкстра от источника, который останавливается, как
   * только осели все цели. Эвристики нет намеренно — она направлена на одну
   * цель и для веера целей только мешает.
   *
   * @returns {{durations: Float64Array, distances: Float64Array, expanded: number,
   *            resolved: number}} бесконечность в ячейке означает «не достигнуто»
   */
  const runOneToMany = ({ source, targets: goals, profile = 'driving', maxExpansions = DEFAULT_MAX_EXPANSIONS }) => {
    const settings = PROFILES[profile] || PROFILES.driving;
    const fallbackMps = settings.fallbackSpeedKmh / 3.6;
    const useEdgeSpeed = settings.access === PROFILES.driving.access;

    generation += 1;
    heap.clear();

    const durations = new Float64Array(goals.length).fill(Infinity);
    const distances = new Float64Array(goals.length).fill(Infinity);

    // Узел может быть целью несколько раз: две клиники в одном здании
    // привязываются к одному узлу графа.
    const goalSlots = new Map();
    goals.forEach((node, index) => {
      const slots = goalSlots.get(node);
      if (slots) slots.push(index);
      else goalSlots.set(node, [index]);
    });

    gScore[source] = 0;
    parent[source] = -1;
    seen[source] = generation;
    heap.push(source, 0);

    let expanded = 0;
    let resolved = 0;

    while (heap.size > 0 && resolved < goalSlots.size) {
      const current = heap.pop();
      if (settled[current] === generation) continue;
      settled[current] = generation;
      expanded += 1;

      const slots = goalSlots.get(current);
      if (slots) {
        let metres = 0;
        for (let node = current; parent[node] !== -1; node = parent[node]) {
          metres += distanceMeters(lat[node], lon[node], lat[parent[node]], lon[parent[node]]);
        }
        for (const slot of slots) {
          durations[slot] = gScore[current];
          distances[slot] = metres;
        }
        resolved += 1;
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

    return { durations, distances, expanded, resolved };
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
