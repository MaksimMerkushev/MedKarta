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
 * ТОЧКИ ЛЕЖАТ НА ДОРОГЕ, А НЕ В УЗЛЕ. Клиника и дом привязываются к
 * ближайшему отрезку дороги, открытому для выбранного транспорта (см.
 * graph.js). Маршрут начинается в точке проекции, проходит по рёбрам графа
 * и заканчивается в проекции финиша; «хвосты» внутри крайних отрезков
 * входят и во время, и в расстояние.
 *
 * Если файла графа нет, движок не поднимается, и маршрут на карте не
 * рисуется вовсе: прямая через дома и реку хуже, чем честное «не удалось».
 */

import { createSearch, DEFAULT_MAX_EXPANSIONS, edgeSpeedMps, SEARCH_RESULT } from './astar.js';
import { stat } from 'node:fs/promises';

import { loadGraph } from './graph.js';
import { COORD_SCALE, PROFILE_NAMES, PROFILES } from './format.js';
import { logger } from '../observability/safeLogger.js';

export const ROUTING_ERROR = Object.freeze({
  NO_GRAPH: 'routing_graph_unavailable',
  OFF_NETWORK: 'point_far_from_road_network',
  UNREACHABLE: 'no_route_between_points',
  TOO_COMPLEX: 'route_too_complex',
  BAD_REQUEST: 'bad_routing_request',
});

/** Дальше этого расстояния от дороги точка считается вне сети. */
const MAX_SNAP_DISTANCE_M = 2000;

/** Сколько результатов держать в кеше. Запись — путь в Uint32Array, килобайты. */
const CACHE_LIMIT = 256;

const EMPTY_ESTIMATE = Object.freeze({ distanceKm: null, durationSeconds: null, approximate: true });

/**
 * @param {object} params
 * @param {object} params.graph результат createGraph
 * @param {number} [params.maxExpansions]
 */
export const createRoutingEngine = ({ graph, maxExpansions = DEFAULT_MAX_EXPANSIONS }) => {
  const search = createSearch(graph);
  const { lengths, speeds } = graph;

  /*
   * Кеш «первым пришёл — первым вышел»: LRU здесь не окупается.
   * Ключ — отрезок привязки и положение на нём с точностью до тысячной
   * доли, а не сырые координаты: дрожание геолокации в пределах пары
   * метров не промахивается мимо кеша.
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

  const snapPoint = (point, profile) => {
    if (
      !point ||
      typeof point.lat !== 'number' ||
      typeof point.lng !== 'number' ||
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lng) ||
      Math.abs(point.lat) > 90 ||
      Math.abs(point.lng) > 180
    ) {
      return null;
    }
    return graph.snapToRoad(point.lat, point.lng, profile, MAX_SNAP_DISTANCE_M);
  };

  /** Цена и длина части отрезка привязки. */
  const partial = (edge, fraction, settings) => {
    const metres = lengths[edge] * fraction;
    return { metres, cost: metres / edgeSpeedMps(settings, speeds[edge]) };
  };

  /** Куда можно попасть с точки привязки: узлы и стоимость пути до них. */
  const departures = (hit, settings) => {
    const out = [];
    if (hit.forward) out.push({ node: hit.to, ...partial(hit.edge, 1 - hit.t, settings) });
    if (hit.reverseEdge >= 0) out.push({ node: hit.from, ...partial(hit.reverseEdge, hit.t, settings) });
    return out;
  };

  /** Откуда можно попасть в точку привязки: узлы и стоимость «хвоста». */
  const arrivals = (hit, settings) => {
    const out = [];
    if (hit.forward) out.push({ node: hit.from, ...partial(hit.edge, hit.t, settings) });
    if (hit.reverseEdge >= 0) out.push({ node: hit.to, ...partial(hit.reverseEdge, 1 - hit.t, settings) });
    return out;
  };

  /**
   * Обе точки на одном отрезке: ехать прямо по нему, если направление
   * разрешено. Объезд квартала не может быть быстрее.
   */
  const directAlong = (a, b, settings) => {
    if (a.edge !== b.edge) return null;

    let best = null;
    if (a.forward && b.t >= a.t) best = partial(a.edge, b.t - a.t, settings);
    if (a.reverseEdge >= 0 && b.t <= a.t) {
      const back = partial(a.reverseEdge, a.t - b.t, settings);
      if (!best || back.cost < best.cost) best = back;
    }
    return best;
  };

  const legKey = (a, b, profile) =>
    `${profile}|${a.edge}|${Math.round(a.t * 1000)}|${b.edge}|${Math.round(b.t * 1000)}`;

  /** Один участок маршрута между двумя точками привязки. */
  const leg = (a, b, profile) =>
    cached(legKey(a, b, profile), () => {
      const settings = PROFILES[profile];
      const direct = directAlong(a, b, settings);
      if (direct) {
        return { status: SEARCH_RESULT.FOUND, durationS: direct.cost, distanceM: direct.metres, path: null };
      }

      return search.run({
        sources: departures(a, settings),
        goals: arrivals(b, settings),
        goalPoint: [Math.round(b.lat * COORD_SCALE), Math.round(b.lon * COORD_SCALE)],
        profile,
        maxExpansions,
      });
    });

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
     * @returns {{ok: true, geometry: number[][], distanceM: number, durationS: number,
     *            legs: object[], snaps: object[]} | {ok: false, error: string}}
     */
    route({ waypoints, profile = 'driving' }) {
      if (!Array.isArray(waypoints) || waypoints.length < 2) {
        return { ok: false, error: ROUTING_ERROR.BAD_REQUEST };
      }
      const name = PROFILES[profile] ? profile : 'driving';

      const snapped = [];
      for (const [index, point] of waypoints.entries()) {
        const hit = snapPoint(point, name);
        if (!hit) {
          // Номер точки — чтобы интерфейс назвал её, а не писал «где-то».
          return { ok: false, error: ROUTING_ERROR.OFF_NETWORK, index };
        }
        snapped.push(hit);
      }

      const geometry = [];
      const push = (latDeg, lonDeg) => {
        const last = geometry[geometry.length - 1];
        // Стык участков и узел, совпавший с точкой привязки, не дублируются.
        if (last && Math.abs(last[0] - latDeg) < 1e-7 && Math.abs(last[1] - lonDeg) < 1e-7) return;
        geometry.push([latDeg, lonDeg]);
      };

      const legs = [];
      let distanceM = 0;
      let durationS = 0;

      for (let i = 0; i + 1 < snapped.length; i += 1) {
        const a = snapped[i];
        const b = snapped[i + 1];
        const result = leg(a, b, name);

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
          snapDistanceM: Math.round(a.distance),
        });

        push(a.lat, a.lon);
        if (result.path) {
          for (const node of result.path) {
            const [nodeLat, nodeLon] = graph.coordsOf(node);
            push(nodeLat, nodeLon);
          }
        }
        push(b.lat, b.lon);
      }

      return {
        ok: true,
        profile: name,
        geometry,
        distanceM: Math.round(distanceM),
        durationS: Math.round(durationS),
        legs,
        // Где каждая точка встала на дорогу: интерфейс дорисует короткую
        // пунктирную «подводку» от здания до улицы.
        snaps: snapped.map((hit) => ({ lat: hit.lat, lng: hit.lon, distanceM: Math.round(hit.distance) })),
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
      const settings = PROFILES[profile];
      const from = snapPoint(origin, profile);

      if (!from) {
        return destinations.map(() => ({ ...EMPTY_ESTIMATE }));
      }

      /*
       * Один обход на всех кандидатов вместо отдельного поиска на каждого:
       * десять клиник в одном районе — это одна и та же окрестность, обходить
       * её десять раз незачем. На слабом сервере это основная экономия.
       */
      const hits = destinations.map((destination) => snapPoint(destination, profile));
      if (!hits.some(Boolean)) {
        return destinations.map(() => ({ ...EMPTY_ESTIMATE }));
      }

      const matrix = search.runOneToMany({
        sources: departures(from, settings),
        goals: hits.map((hit) => (hit ? arrivals(hit, settings) : null)),
        profile,
        maxExpansions,
      });

      return hits.map((hit, index) => {
        if (!hit) return { ...EMPTY_ESTIMATE };

        let duration = matrix.durations[index];
        let distance = matrix.distances[index];
        const direct = directAlong(from, hit, settings);
        if (direct && direct.cost < duration) {
          duration = direct.cost;
          distance = direct.metres;
        }

        if (!Number.isFinite(duration)) return { ...EMPTY_ESTIMATE };

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

const defaultGraphPath = () =>
  process.env.ROUTING_GRAPH_PATH || new URL('../../data/graph/kazan.graph', import.meta.url);

/** Как часто проверять, не пересобран ли файл графа. */
const RELOAD_CHECK_MS = 30_000;

/** Время изменения файла или null, если его нет. */
const modifiedAt = async (filePath) => {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Загружает граф и пишет в журнал результат. Причина отказа — кодом, без
 * пути к файлу и без текста исключения; раньше она глоталась молча, и понять,
 * почему маршруты не строятся, было нельзя.
 */
const loadEngine = async (filePath, event) => {
  const started = Date.now();
  try {
    const graph = await loadGraph(filePath);
    const engine = createRoutingEngine({ graph });
    const stats = engine.stats();
    logger.event(event, {
      status: 'ready',
      provider: 'local',
      nodes: stats.nodes,
      edges: stats.edges,
      memory_mb: Math.round(((stats.graphBytes + stats.searchStateBytes) / 1e6) * 10) / 10,
      latency_ms: Date.now() - started,
    });
    return engine;
  } catch (error) {
    logger.warn('routing.graph_unavailable', {
      status: 'failed',
      provider: 'local',
      // ENOENT — файла нет (соберите: npm run build:graph); иначе — повреждён.
      reason: error?.code === 'ENOENT' ? 'graph_file_missing' : 'graph_file_invalid',
    });
    return null;
  }
};

let current = null;

/**
 * Движок по умолчанию. Граф грузится один раз и переиспользуется.
 *
 * Возвращает null, если графа нет или он не читается.
 *
 * ПЕРЕСБОРКА БЕЗ ПЕРЕЗАПУСКА. Раз в полминуты движок сверяет время изменения
 * файла графа. Если граф пересобран (npm run build:graph кладёт его атомарно),
 * новый загружается в фоне, а запросы до конца загрузки обслуживает старый.
 * На слабом сервере это значит: обновить карту дорог можно, не роняя сайт.
 * Если новый файл не читается, остаётся старый граф.
 */
export const getDefaultRoutingEngine = async (filePath = defaultGraphPath()) => {
  const key = String(filePath);

  if (!current || current.key !== key) {
    const mtimeMs = await modifiedAt(filePath);
    current = {
      key,
      mtimeMs,
      checkedAt: Date.now(),
      reloading: null,
      promise: loadEngine(filePath, 'routing.graph_loaded'),
    };
    return current.promise;
  }

  const state = current;
  if (!state.reloading && Date.now() - state.checkedAt >= RELOAD_CHECK_MS) {
    state.checkedAt = Date.now();
    state.reloading = (async () => {
      const mtimeMs = await modifiedAt(filePath);
      if (mtimeMs !== null && mtimeMs !== state.mtimeMs) {
        const fresh = await loadEngine(filePath, 'routing.graph_reloaded');
        if (fresh) {
          state.promise = Promise.resolve(fresh);
          state.mtimeMs = mtimeMs;
        }
      }
      state.reloading = null;
    })();
  }

  return state.promise;
};

/** Дождаться фоновой перезагрузки графа, если она идёт. Для тестов и диагностики. */
export const __pendingRoutingReload = () => current?.reloading || Promise.resolve();

/** Только для тестов: сдвинуть момент последней проверки файла в прошлое. */
export const __expireRoutingReloadCheck = () => {
  if (current) current.checkedAt = 0;
};

/** Только для тестов. */
export const __resetRoutingEngine = () => {
  current = null;
};
