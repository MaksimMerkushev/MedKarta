/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Локальный движок маршрутизации.
 *
 * ЗАЧЕМ ОН ЕСТЬ. Раньше геометрию маршрута строил публичный демо-сервер OSRM,
 * и браузер отправлял ему точные координаты пользователя и всех точек. Получался
 * разрыв: внешней языковой модели мы отдаём @HOME вместо адреса, а координаты
 * тем временем уходят третьей стороне, с которой нет договора. Этот модуль
 * закрывает канал — расчёт идёт внутри доверенного контура.
 *
 * РЕСУРСЫ. Сервер — одно ядро и 2 ГБ, поэтому:
 *   - граф загружается лениво, при первом запросе маршрута;
 *   - состояние поиска выделяется один раз и переиспользуется;
 *   - результаты кешируются по округлённым координатам: повторный выбор той же
 *     клиники не запускает поиск заново;
 *   - есть потолок раскрытых узлов, после которого возвращается отказ.
 *
 * Если файла графа нет, движок не поднимается и вызывающая сторона переходит
 * на оценку по прямой. Отсутствие графа — штатный режим, а не ошибка.
 */

import { createSearch, DEFAULT_MAX_EXPANSIONS, SEARCH_RESULT } from './astar.js';
import { loadGraph } from './graph.js';
import { PROFILE_NAMES } from './format.js';

export const ROUTING_ERROR = Object.freeze({
  NO_GRAPH: 'routing_graph_unavailable',
  OFF_NETWORK: 'point_far_from_road_network',
  UNREACHABLE: 'no_route_between_points',
  TOO_COMPLEX: 'route_too_complex',
  BAD_REQUEST: 'bad_routing_request',
});

/** Дальше этого расстояния от дороги точка считается вне сети. */
const MAX_SNAP_DISTANCE_M = 2000;

/** Сколько результатов держать в кеше. Запись весит сотни байт. */
const CACHE_LIMIT = 256;

/**
 * @param {object} params
 * @param {object} params.graph результат createGraph
 * @param {number} [params.maxExpansions]
 */
export const createRoutingEngine = ({ graph, maxExpansions = DEFAULT_MAX_EXPANSIONS }) => {
  const search = createSearch(graph);

  /*
   * Кеш «первым пришёл — первым вышел»: LRU здесь не окупается.
   * Ключ — пара УЗЛОВ графа, а не координат: две соседние клиники в одном
   * здании привязываются к одному узлу и делят один результат, а дрожание
   * геолокации в пределах квартала не промахивается мимо кеша.
   */
  const cache = new Map();

  const cached = (key, compute) => {
    const hit = cache.get(key);
    if (hit) return hit;

    const value = compute();
    if (cache.size >= CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, value);
    return value;
  };

  const snapPoint = (point) => {
    if (
      !point ||
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lng) ||
      Math.abs(point.lat) > 90 ||
      Math.abs(point.lng) > 180
    ) {
      return null;
    }
    return graph.snap(point.lat, point.lng, MAX_SNAP_DISTANCE_M);
  };

  /** Один участок между двумя узлами графа. */
  const leg = (fromNode, toNode, profile) => {
    const key = `${fromNode}:${toNode}:${profile}`;
    return cached(key, () => search.run({ source: fromNode, target: toNode, profile, maxExpansions }));
  };

  return Object.freeze({
    name: 'local',
    approximate: false,
    profiles: PROFILE_NAMES,

    /**
     * Маршрут через последовательность точек.
     *
     * @param {object} params
     * @param {Array<{lat: number, lng: number}>} params.waypoints минимум две
     * @param {string} [params.profile]
     * @returns {{ok: true, geometry: number[][], distanceM: number, durationS: number, legs: object[]}
     *          | {ok: false, error: string}}
     */
    route({ waypoints, profile = 'driving' }) {
      if (!Array.isArray(waypoints) || waypoints.length < 2) {
        return { ok: false, error: ROUTING_ERROR.BAD_REQUEST };
      }

      const snapped = [];
      for (const point of waypoints) {
        const hit = snapPoint(point);
        if (!hit) {
          return { ok: false, error: ROUTING_ERROR.OFF_NETWORK };
        }
        snapped.push(hit);
      }

      const geometry = [];
      const legs = [];
      let distanceM = 0;
      let durationS = 0;

      for (let i = 0; i + 1 < snapped.length; i += 1) {
        const result = leg(snapped[i].node, snapped[i + 1].node, profile);

        if (result.status === SEARCH_RESULT.BUDGET_EXCEEDED) {
          return { ok: false, error: ROUTING_ERROR.TOO_COMPLEX };
        }
        if (result.status !== SEARCH_RESULT.FOUND) {
          return { ok: false, error: ROUTING_ERROR.UNREACHABLE };
        }

        distanceM += result.distanceM;
        durationS += result.durationS;
        legs.push({
          distanceM: Math.round(result.distanceM),
          durationS: Math.round(result.durationS),
          snapDistanceM: Math.round(snapped[i].distance),
        });

        // Стык участков не дублируется: первый узел повторяет последний узел
        // предыдущего участка.
        for (let k = i === 0 ? 0 : 1; k < result.path.length; k += 1) {
          geometry.push(graph.coordsOf(result.path[k]));
        }
      }

      return {
        ok: true,
        profile,
        geometry,
        distanceM: Math.round(distanceM),
        durationS: Math.round(durationS),
        legs,
      };
    },

    /**
     * Матрица времён от одной точки до многих.
     *
     * Совместима по контракту с RoutingProvider из executor/routing.js,
     * поэтому выбор ближайшего кандидата работает без изменений выше по стеку.
     */
    async travelTimes(origin, destinations, mode = 'driving') {
      const profile = PROFILE_NAMES.includes(mode) ? mode : 'driving';
      const source = snapPoint(origin);

      if (!source) {
        return destinations.map(() => ({ distanceKm: null, durationSeconds: null, approximate: true }));
      }

      /*
       * Один обход на всех кандидатов вместо отдельного поиска на каждого:
       * десять клиник в одном районе — это одна и та же окрестность, обходить
       * её десять раз незачем. На слабом сервере это основная экономия.
       */
      const snappedTargets = destinations.map((destination) => snapPoint(destination));
      const reachable = snappedTargets.filter(Boolean).map((hit) => hit.node);

      if (reachable.length === 0) {
        return destinations.map(() => ({ distanceKm: null, durationSeconds: null, approximate: true }));
      }

      const matrix = search.runOneToMany({ source: source.node, targets: reachable, profile, maxExpansions });

      let cursor = 0;
      return snappedTargets.map((hit) => {
        if (!hit) {
          return { distanceKm: null, durationSeconds: null, approximate: true };
        }

        const duration = matrix.durations[cursor];
        const distance = matrix.distances[cursor];
        cursor += 1;

        if (!Number.isFinite(duration)) {
          return { distanceKm: null, durationSeconds: null, approximate: true };
        }

        return {
          distanceKm: Number((distance / 1000).toFixed(3)),
          durationSeconds: Math.round(duration),
          approximate: false,
        };
      });
    },

    stats() {
      return {
        nodes: graph.nodeCount,
        edges: graph.edgeCount,
        graphBytes: graph.memoryBytes,
        searchStateBytes: search.stateBytes,
        cacheEntries: cache.size,
      };
    },
  });
};

let enginePromise = null;

/**
 * Движок по умолчанию. Граф грузится один раз и переиспользуется.
 * Возвращает null, если файла нет, — это не ошибка, а отсутствие данных.
 */
export const getDefaultRoutingEngine = async (
  filePath = process.env.ROUTING_GRAPH_PATH || new URL('../../data/graph/kazan.graph', import.meta.url),
) => {
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    try {
      const graph = await loadGraph(filePath);
      return createRoutingEngine({ graph });
    } catch {
      // Файла нет или он повреждён: маршрутизация деградирует до оценки
      // по прямой, приложение продолжает работать.
      return null;
    }
  })();

  return enginePromise;
};

/** Только для тестов. */
export const __resetRoutingEngine = () => {
  enginePromise = null;
};
