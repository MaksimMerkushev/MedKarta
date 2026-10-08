/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Загрузка графа и привязка координат к дорожной сети.
 *
 * ПРИВЯЗКА — К ДОРОГЕ, А НЕ К БЛИЖАЙШЕМУ УЗЛУ.
 *
 * Первая версия брала ближайший узел графа любого типа. На реальной Казани
 * это ломало 40 % автомобильных маршрутов между учреждениями: ближайшим к зданию
 * оказывался узел тротуара, дворового проезда или изолированной парковки,
 * откуда машине никуда не выехать. Поиск честно отвечал «пути нет», а
 * интерфейс рисовал прямую через дома и реку.
 *
 * Теперь точка проецируется на ближайший ОТРЕЗОК дороги, который
 *   1) открыт для выбранного профиля — авто, пешком, велосипед;
 *   2) лежит в главной сильно связной компоненте этого профиля, то есть
 *      из него можно доехать до любой другой такой дороги и вернуться.
 *
 * Второе условие отсекает «острова»: огороженный двор, въезд под запретом
 * с одной стороны, обрывок дороги у края выгрузки. Компоненты считаются
 * один раз при загрузке графа, итеративным алгоритмом Тарьяна: рекурсия на
 * сотнях тысяч узлов переполнила бы стек.
 *
 * ИНДЕКСЫ — равномерные сетки в CSR (массив смещений по ячейкам плюс плоский
 * массив элементов). Дерево (k-d или R) дало бы миллионы мелких объектов и
 * работу сборщику мусора; сетка укладывается в пару типизированных массивов.
 */

import { readFile } from 'node:fs/promises';

import { ACCESS, COORD_SCALE, decodeGraph, PROFILES } from './format.js';

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;
const METRES_PER_DEGREE = 111_320;

/** Целевой размер ячейки сетки, метры. */
const CELL_SIZE_M = 250;

/** Сколько колец сетки просматривать, прежде чем признать точку вне графа. */
const MAX_SNAP_RINGS = 24;

/**
 * Магистрали (motorway, trunk) быстрее этого порога. К ним не привязываемся,
 * если рядом есть обычная улица: клиника у проспекта обслуживается с боковой
 * улицы, и маршрут, начатый «с середины шоссе», водитель повторить не сможет.
 */
const FAST_ROAD_KMH = 80;

/** На сколько дальше магистрали может лежать обычная улица, чтобы её предпочли. */
const FAST_ROAD_DETOUR_M = 150;

/** Расстояние между двумя точками, метры. Аргументы — целые координаты. */
export const distanceMeters = (latA, lonA, latB, lonB) => {
  const lat1 = (latA / COORD_SCALE) * DEG_TO_RAD;
  const lat2 = (latB / COORD_SCALE) * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = ((lonB - lonA) / COORD_SCALE) * DEG_TO_RAD;

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

/** Геометрия сетки по охвату узлов графа. */
const gridGeometry = (lat, lon, nodeCount) => {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (let i = 0; i < nodeCount; i += 1) {
    if (lat[i] < minLat) minLat = lat[i];
    if (lat[i] > maxLat) maxLat = lat[i];
    if (lon[i] < minLon) minLon = lon[i];
    if (lon[i] > maxLon) maxLon = lon[i];
  }
  if (nodeCount === 0) {
    minLat = 0;
    maxLat = 0;
    minLon = 0;
    maxLon = 0;
  }

  const midLat = (minLat + maxLat) / 2;
  // Градус широты — всегда ~111 км; градус долготы сжимается к полюсам.
  const latStep = Math.round((CELL_SIZE_M / METRES_PER_DEGREE) * COORD_SCALE);
  const lonStep = Math.round(
    (CELL_SIZE_M / (METRES_PER_DEGREE * Math.max(0.1, Math.cos((midLat / COORD_SCALE) * DEG_TO_RAD)))) * COORD_SCALE,
  );

  const cols = Math.max(1, Math.ceil((maxLon - minLon + 1) / lonStep));
  const rows = Math.max(1, Math.ceil((maxLat - minLat + 1) / latStep));

  return { minLat, minLon, latStep, lonStep, cols, rows, cellCount: cols * rows };
};

const colOf = (geo, value) => Math.min(geo.cols - 1, Math.max(0, Math.floor((value - geo.minLon) / geo.lonStep)));
const rowOf = (geo, value) => Math.min(geo.rows - 1, Math.max(0, Math.floor((value - geo.minLat) / geo.latStep)));

/** Сеточный индекс узлов. */
const buildNodeGrid = (geo, lat, lon, nodeCount) => {
  const cellOf = (i) => rowOf(geo, lat[i]) * geo.cols + colOf(geo, lon[i]);

  // Два прохода: сначала считаем размеры ячеек, потом раскладываем узлы.
  const cellOffsets = new Uint32Array(geo.cellCount + 1);
  for (let i = 0; i < nodeCount; i += 1) cellOffsets[cellOf(i) + 1] += 1;
  for (let c = 0; c < geo.cellCount; c += 1) cellOffsets[c + 1] += cellOffsets[c];

  const cellNodes = new Uint32Array(nodeCount);
  const cursor = new Uint32Array(geo.cellCount);
  for (let i = 0; i < nodeCount; i += 1) {
    const cell = cellOf(i);
    cellNodes[cellOffsets[cell] + cursor[cell]] = i;
    cursor[cell] += 1;
  }

  return { cellOffsets, cellNodes };
};

/** Ребро to→from, открытое для маски, или -1. */
const findEdge = (offsets, targets, access, from, to, mask) => {
  for (let edge = offsets[from]; edge < offsets[from + 1]; edge += 1) {
    if (targets[edge] === to && (access[edge] & mask) !== 0) return edge;
  }
  return -1;
};

/** Есть ли ребро from→to хоть для кого-то. */
const hasEdge = (offsets, targets, from, to) => {
  for (let edge = offsets[from]; edge < offsets[from + 1]; edge += 1) {
    if (targets[edge] === to) return true;
  }
  return false;
};

/**
 * Сеточный индекс ОТРЕЗКОВ дороги.
 *
 * Двусторонняя улица хранится в графе двумя встречными рёбрами; в индекс
 * попадает одно из них — то, у которого начало имеет меньший номер.
 * Одностороннее ребро попадает всегда. Отрезок записывается во все ячейки,
 * которые задевает его охватывающий прямоугольник: иначе длинный мост,
 * у середины которого стоит точка, был бы невидим из её ячейки.
 */
const buildSegmentGrid = (geo, graph) => {
  const { nodeCount, offsets, targets, lat, lon } = graph;

  const forEachSegment = (visit) => {
    for (let from = 0; from < nodeCount; from += 1) {
      for (let edge = offsets[from]; edge < offsets[from + 1]; edge += 1) {
        const to = targets[edge];
        if (from > to && hasEdge(offsets, targets, to, from)) continue;

        const rowA = rowOf(geo, lat[from]);
        const rowB = rowOf(geo, lat[to]);
        const colA = colOf(geo, lon[from]);
        const colB = colOf(geo, lon[to]);
        for (let row = Math.min(rowA, rowB); row <= Math.max(rowA, rowB); row += 1) {
          for (let col = Math.min(colA, colB); col <= Math.max(colA, colB); col += 1) {
            visit(row * geo.cols + col, edge);
          }
        }
      }
    }
  };

  const cellOffsets = new Uint32Array(geo.cellCount + 1);
  forEachSegment((cell) => {
    cellOffsets[cell + 1] += 1;
  });
  for (let c = 0; c < geo.cellCount; c += 1) cellOffsets[c + 1] += cellOffsets[c];

  const cellEdges = new Uint32Array(cellOffsets[geo.cellCount]);
  const cursor = new Uint32Array(geo.cellCount);
  forEachSegment((cell, edge) => {
    cellEdges[cellOffsets[cell] + cursor[cell]] = edge;
    cursor[cell] += 1;
  });

  return { cellOffsets, cellEdges };
};

/**
 * Для каждого профиля помечает узлы самой большой сильно связной компоненты.
 *
 * Возвращает Uint8Array: бит профиля (ACCESS.*) выставлен, если узел в ней.
 * Временная память — семь массивов по числу узлов, освобождается сразу.
 */
export const markMainComponents = ({ nodeCount, offsets, targets, access }) => {
  const membership = new Uint8Array(nodeCount);
  const index = new Int32Array(nodeCount);
  const low = new Int32Array(nodeCount);
  const component = new Int32Array(nodeCount);
  const stack = new Int32Array(nodeCount);
  const callNode = new Int32Array(nodeCount);
  const callEdge = new Uint32Array(nodeCount);
  const onStack = new Uint8Array(nodeCount);

  const masks = [...new Set(Object.values(PROFILES).map((profile) => profile.access))];

  for (const mask of masks) {
    index.fill(-1);
    onStack.fill(0);

    let counter = 0;
    let sp = 0;
    let componentCount = 0;
    let largest = -1;
    let largestSize = 0;

    for (let root = 0; root < nodeCount; root += 1) {
      if (index[root] !== -1) continue;

      let depth = 1;
      callNode[0] = root;
      callEdge[0] = offsets[root];
      index[root] = counter;
      low[root] = counter;
      counter += 1;
      stack[sp] = root;
      sp += 1;
      onStack[root] = 1;

      while (depth > 0) {
        const node = callNode[depth - 1];
        const end = offsets[node + 1];
        let edge = callEdge[depth - 1];
        let descended = false;

        while (edge < end) {
          const current = edge;
          edge += 1;
          if ((access[current] & mask) === 0) continue;

          const next = targets[current];
          if (index[next] === -1) {
            callEdge[depth - 1] = edge;
            index[next] = counter;
            low[next] = counter;
            counter += 1;
            stack[sp] = next;
            sp += 1;
            onStack[next] = 1;
            callNode[depth] = next;
            callEdge[depth] = offsets[next];
            depth += 1;
            descended = true;
            break;
          }
          if (onStack[next] === 1 && index[next] < low[node]) low[node] = index[next];
        }
        if (descended) continue;

        depth -= 1;
        if (low[node] === index[node]) {
          let size = 0;
          let member;
          do {
            sp -= 1;
            member = stack[sp];
            onStack[member] = 0;
            component[member] = componentCount;
            size += 1;
          } while (member !== node);

          if (size > largestSize) {
            largestSize = size;
            largest = componentCount;
          }
          componentCount += 1;
        }
        if (depth > 0) {
          const caller = callNode[depth - 1];
          if (low[node] < low[caller]) low[caller] = low[node];
        }
      }
    }

    if (largestSize > 1) {
      for (let node = 0; node < nodeCount; node += 1) {
        if (component[node] === largest) membership[node] |= mask;
      }
    }
  }

  return membership;
};

/**
 * @param {object} decoded результат decodeGraph
 */
export const createGraph = (decoded) => {
  const { lat, lon, nodeCount, offsets, targets, speeds, access, lengths } = decoded;
  const geo = gridGeometry(lat, lon, nodeCount);
  const nodeGrid = buildNodeGrid(geo, lat, lon, nodeCount);
  const segmentGrid = buildSegmentGrid(geo, decoded);
  const membership = markMainComponents(decoded);

  /** Узел, из которого выходит ребро: двоичный поиск по массиву смещений. */
  const sourceOf = (edge) => {
    let lo = 0;
    let hi = nodeCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= edge) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /**
   * Обходит ячейки сетки кольцами вокруг точки.
   * visit(cell) возвращает текущую дистанцию, дальше которой искать незачем.
   */
  const scanRings = (targetLat, targetLon, maxDistanceM, visit) => {
    // Номер ячейки считается без обрезки: точка может лежать за краем графа.
    const col0 = Math.floor((targetLon - geo.minLon) / geo.lonStep);
    const row0 = Math.floor((targetLat - geo.minLat) / geo.latStep);

    let limit = maxDistanceM;
    for (let ring = 0; ring <= MAX_SNAP_RINGS; ring += 1) {
      // Любая ячейка этого кольца отстоит от точки минимум на (ring − 1) ячеек.
      if ((ring - 1) * CELL_SIZE_M > limit) break;

      for (let row = row0 - ring; row <= row0 + ring; row += 1) {
        if (row < 0 || row >= geo.rows) continue;
        const onRowEdge = row === row0 - ring || row === row0 + ring;
        for (let col = col0 - ring; col <= col0 + ring; col += 1) {
          if (col < 0 || col >= geo.cols) continue;
          // Внутренние ячейки уже просмотрены на предыдущих кольцах.
          if (!onRowEdge && col !== col0 - ring && col !== col0 + ring) continue;
          limit = Math.min(limit, visit(row * geo.cols + col));
        }
      }
    }
  };

  /**
   * Ближайший узел графа к произвольной точке, без учёта профиля.
   * Оставлен для диагностики и обратной совместимости; маршруты строятся
   * через snapToRoad.
   *
   * @returns {{node: number, distance: number}|null}
   */
  const snap = (latDeg, lonDeg, maxDistanceM = 2000) => {
    const targetLat = Math.round(latDeg * COORD_SCALE);
    const targetLon = Math.round(lonDeg * COORD_SCALE);

    let best = -1;
    let bestDistance = Infinity;

    scanRings(targetLat, targetLon, maxDistanceM, (cell) => {
      for (let k = nodeGrid.cellOffsets[cell]; k < nodeGrid.cellOffsets[cell + 1]; k += 1) {
        const node = nodeGrid.cellNodes[k];
        const distance = distanceMeters(targetLat, targetLon, lat[node], lon[node]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = node;
        }
      }
      return bestDistance;
    });

    if (best < 0 || bestDistance > maxDistanceM) return null;
    return { node: best, distance: bestDistance };
  };

  /**
   * Проекция точки на ближайшую дорогу, пригодную для профиля.
   *
   * Результат описывает отрезок from→to (ребро edge хранится в графе
   * именно в этом направлении) и долю t ∈ [0, 1] от его начала:
   *   forward      — можно ли ехать по отрезку от from к to;
   *   reverseEdge  — встречное ребро to→from, открытое профилю, или -1.
   *
   * @returns {null | {edge: number, reverseEdge: number, forward: boolean,
   *   from: number, to: number, t: number, distance: number, lat: number, lon: number}}
   */
  const snapToRoad = (latDeg, lonDeg, profile = 'driving', maxDistanceM = 2000) => {
    const settings = PROFILES[profile];
    if (!settings || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;

    const mask = settings.access;
    const avoidFast = mask === ACCESS.CAR;
    const targetLat = latDeg * COORD_SCALE;
    const targetLon = lonDeg * COORD_SCALE;

    // Локальная плоская проекция в метрах: на масштабе сотен метров
    // погрешность ниже точности GPS.
    const ky = METRES_PER_DEGREE / COORD_SCALE;
    const kx = ky * Math.cos(latDeg * DEG_TO_RAD);

    const bestAny = { distance: Infinity };
    const bestLocal = { distance: Infinity };

    const consider = (slot, candidate) => {
      if (candidate.distance < slot.distance) Object.assign(slot, candidate);
    };

    scanRings(targetLat, targetLon, maxDistanceM, (cell) => {
      for (let k = segmentGrid.cellOffsets[cell]; k < segmentGrid.cellOffsets[cell + 1]; k += 1) {
        const edge = segmentGrid.cellEdges[k];
        const from = sourceOf(edge);
        const to = targets[edge];

        if ((membership[from] & mask) === 0 || (membership[to] & mask) === 0) continue;

        const forward = (access[edge] & mask) !== 0;
        const reverseEdge = findEdge(offsets, targets, access, to, from, mask);
        if (!forward && reverseEdge < 0) continue;

        const ax = (lon[from] - targetLon) * kx;
        const ay = (lat[from] - targetLat) * ky;
        const dx = (lon[to] - lon[from]) * kx;
        const dy = (lat[to] - lat[from]) * ky;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
        const px = ax + t * dx;
        const py = ay + t * dy;
        const distance = Math.sqrt(px * px + py * py);

        if (distance >= bestAny.distance && distance >= bestLocal.distance) continue;

        const candidate = { edge, reverseEdge, forward, from, to, t, distance };
        consider(bestAny, candidate);

        const speed = speeds[forward ? edge : reverseEdge];
        if (!avoidFast || speed < FAST_ROAD_KMH) consider(bestLocal, candidate);
      }

      // Искать дальше имеет смысл, пока может найтись обычная улица,
      // которую мы предпочтём уже найденной магистрали.
      return Math.min(bestLocal.distance, bestAny.distance + FAST_ROAD_DETOUR_M);
    });

    const chosen = bestLocal.distance <= bestAny.distance + FAST_ROAD_DETOUR_M ? bestLocal : bestAny;
    if (!Number.isFinite(chosen.distance) || chosen.distance > maxDistanceM) return null;

    const { from, to, t } = chosen;
    return {
      ...chosen,
      lat: (lat[from] + t * (lat[to] - lat[from])) / COORD_SCALE,
      lon: (lon[from] + t * (lon[to] - lon[from])) / COORD_SCALE,
      length: lengths[chosen.forward ? chosen.edge : chosen.reverseEdge],
    };
  };

  /** Сколько узлов в главной компоненте каждого профиля. Для диагностики. */
  const mainComponentSizes = () => {
    const sizes = {};
    for (const [name, settings] of Object.entries(PROFILES)) {
      let count = 0;
      for (let node = 0; node < nodeCount; node += 1) {
        if (membership[node] & settings.access) count += 1;
      }
      sizes[name] = count;
    }
    return sizes;
  };

  return Object.freeze({
    ...decoded,
    snap,
    snapToRoad,
    sourceOf,
    mainComponentSizes,
    /** Координаты узла в градусах — для сборки геометрии ответа. */
    coordsOf: (node) => [lat[node] / COORD_SCALE, lon[node] / COORD_SCALE],
    /** Оценка занимаемой памяти, байты. */
    memoryBytes:
      decoded.byteLength +
      nodeGrid.cellOffsets.byteLength +
      nodeGrid.cellNodes.byteLength +
      segmentGrid.cellOffsets.byteLength +
      segmentGrid.cellEdges.byteLength +
      membership.byteLength,
  });
};

/** Загружает граф с диска. */
export const loadGraph = async (filePath) => createGraph(decodeGraph(await readFile(filePath)));
