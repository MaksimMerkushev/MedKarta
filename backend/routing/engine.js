/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Локальный движок маршрутизации. Расчёт идёт внутри доверенного контура:
 * координаты пользователя и точек не уходят внешнему сервису маршрутов, с
 * которым нет договора, — иначе подмена адреса на @HOME для внешней модели
 * теряет смысл.
 *
 * Сервер — одно ядро и 2 ГБ, поэтому:
 *   - граф загружается один раз (сервер — при старте) и переиспользуется;
 *   - состояние поиска выделяется один раз;
 *   - результаты кешируются по точкам привязки;
 *   - есть потолок раскрытых узлов, после которого возвращается отказ.
 *
 * Точки привязываются не к узлу, а к ближайшему отрезку дороги, открытому для
 * профиля (см. graph.js); «хвосты» внутри крайних отрезков входят и во время,
 * и в расстояние.
 *
 * Без файла графа движок не поднимается и маршрут не рисуется: прямая через
 * дома и реку хуже, чем честное «не удалось».
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

/*
 * Фильтр «не дольше N минут» каждый раз присылает одни и те же ~500 адресов
 * клиник; без кеша их привязка — половина времени запроса. Размер — с запасом
 * на весь справочник.
 */
const SNAP_CACHE_LIMIT = 4096;

/*
 * Потолок раскрытий на один запрос, суммарно по всем участкам: потолок на
 * участок (400 тыс.) больше самого графа и многоточечный маршрут не
 * ограничивает. Миллион — с запасом для любого маршрута по городу (типичный
 * участок — 30–150 тыс.), около 0,4 с в худшем случае.
 */
export const MAX_REQUEST_EXPANSIONS = 1_000_000;

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
   * FIFO: LRU здесь не окупается. Ключ — отрезок привязки и положение на нём
   * до тысячной доли, а не сырые координаты: дрожание геолокации на пару
   * метров не промахивается мимо кеша.
   */
  const cache = new Map();

  const cached = (key, compute) => {
    const hit = cache.get(key);
    if (hit) return { ...hit, expanded: 0 };

    const value = compute();
    // Отказ по бюджету зависит от остатка бюджета запроса — его не кешируем.
    if (value.status === SEARCH_RESULT.BUDGET_EXCEEDED) return value;
    if (cache.size >= CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, value);
    return value;
  };

  const snapCache = new Map();

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
    const key = `${profile}|${point.lat}|${point.lng}`;
    if (snapCache.has(key)) return snapCache.get(key);
    const hit = graph.snapToRoad(point.lat, point.lng, profile, MAX_SNAP_DISTANCE_M);
    if (snapCache.size >= SNAP_CACHE_LIMIT) {
      snapCache.delete(snapCache.keys().next().value);
    }
    snapCache.set(key, hit);
    return hit;
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

  /*
   * Для точек на одном отрезке в ключ входит направление: после округления
   * до тысячной P→Q и Q→P на длинном одностороннем отрезке дают один ключ,
   * и обратный маршрут из кеша шёл бы против движения.
   */
  const legKey = (a, b, profile) =>
    `${profile}|${a.edge}|${Math.round(a.t * 1000)}|${b.edge}|${Math.round(b.t * 1000)}`
    + (a.edge === b.edge ? `|${a.t <= b.t ? 'f' : 'r'}` : '');

  const leg = (a, b, profile, budget = maxExpansions) =>
    cached(legKey(a, b, profile), () => {
      const settings = PROFILES[profile];
      const direct = directAlong(a, b, settings);

      const found = search.run({
        sources: departures(a, settings),
        goals: arrivals(b, settings),
        goalPoint: [Math.round(b.lat * COORD_SCALE), Math.round(b.lon * COORD_SCALE)],
        profile,
        maxExpansions: Math.min(maxExpansions, budget),
      });

      /*
       * Прямо по отрезку — не всегда быстрее: 700 м по двору на 20 км/ч
       * дольше объезда по улицам. Поиск нужен и здесь, иначе route()
       * расходится с travelTimes().
       */
      if (direct && (found.status !== SEARCH_RESULT.FOUND || direct.cost <= found.durationS)) {
        return {
          status: SEARCH_RESULT.FOUND,
          durationS: direct.cost,
          distanceM: direct.metres,
          path: null,
          expanded: found.expanded || 0,
        };
      }
      return found;
    });

  return Object.freeze({
    name: 'local',
    approximate: false,
    profiles: PROFILE_NAMES,

    /**
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
      let budget = MAX_REQUEST_EXPANSIONS;

      for (let i = 0; i + 1 < snapped.length; i += 1) {
        const a = snapped[i];
        const b = snapped[i + 1];
        const result = leg(a, b, name, budget);
        budget -= result.expanded || 0;

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
     * Времена от одной точки до многих. Контракт — RoutingProvider из
     * executor/routing.js, поэтому выбор ближайшего кандидата работает без
     * изменений выше по стеку.
     */
    async travelTimes(origin, destinations, mode = 'driving', { maxSeconds = Number.POSITIVE_INFINITY } = {}) {
      const profile = PROFILE_NAMES.includes(mode) ? mode : 'driving';
      const settings = PROFILES[profile];
      const from = snapPoint(origin, profile);

      if (!from) {
        return destinations.map(() => ({ ...EMPTY_ESTIMATE }));
      }

      /*
       * Один обход на всех кандидатов вместо поиска на каждого: клиники одного
       * района — одна окрестность. На слабом сервере это основная экономия.
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
        maxCost: maxSeconds,
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

        // Хвост от узла до здания добавляется после обхода и может вывести
        // цель за потолок — такая цель за потолком и считается.
        if (!Number.isFinite(duration) || duration > maxSeconds) return { ...EMPTY_ESTIMATE };

        return {
          distanceKm: Number((distance / 1000).toFixed(3)),
          durationSeconds: Math.round(duration),
          approximate: false,
        };
      });
    },

    /**
     * Лежит ли точка у дороги (не дальше MAX_SNAP_DISTANCE_M). Нужна, чтобы
     * отличить «точка вне карты» от «все цели дальше потолка времени».
     */
    snapsToNetwork(point, mode = 'driving') {
      const profile = PROFILE_NAMES.includes(mode) ? mode : 'driving';
      return Boolean(point && Number.isFinite(point.lat) && Number.isFinite(point.lng) && snapPoint(point, profile));
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

/** Причина отказа пишется в журнал кодом, без пути к файлу и текста исключения. */
const loadEngine = async (filePath, event, failureEvent = 'routing.graph_unavailable') => {
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
    logger.warn(failureEvent, {
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
 * Движок по умолчанию; null, если графа нет или он не читается.
 *
 * Раз в RELOAD_CHECK_MS сверяется время изменения файла графа. Пересобранный
 * граф (npm run build:graph кладёт его атомарно) загружается в фоне, запросы
 * до конца загрузки обслуживает старый — карту дорог можно обновить без
 * перезапуска. Если новый файл не читается, остаётся старый граф.
 */
export const getDefaultRoutingEngine = async (filePath = defaultGraphPath()) => {
  const key = String(filePath);

  if (!current || current.key !== key) {
    // Состояние создаётся до первого await: иначе одновременные первые
    // запросы запускают каждый свою загрузку графа.
    const state = { key, mtimeMs: null, checkedAt: Date.now(), reloading: null, promise: null };
    current = state;
    state.promise = (async () => {
      state.mtimeMs = await modifiedAt(filePath);
      return loadEngine(filePath, 'routing.graph_loaded');
    })();
    return state.promise;
  }

  const state = current;
  if (!state.reloading && Date.now() - state.checkedAt >= RELOAD_CHECK_MS) {
    state.checkedAt = Date.now();
    state.reloading = (async () => {
      const mtimeMs = await modifiedAt(filePath);
      if (mtimeMs !== null && mtimeMs !== state.mtimeMs) {
        // Неудача перезагрузки — не «маршрутизация недоступна»: старый граф работает.
        const fresh = await loadEngine(filePath, 'routing.graph_reloaded', 'routing.graph_reload_failed');
        if (fresh) {
          state.promise = Promise.resolve(fresh);
        }
        // Время запоминается и при неудаче: испорченный файл не перечитывается
        // (и не журналируется) при каждой проверке, пока его не заменят.
        state.mtimeMs = mtimeMs;
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
