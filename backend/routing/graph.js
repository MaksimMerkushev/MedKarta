/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Загрузка графа и привязка координат к дорожной сети.
 *
 * Индекс привязки — равномерная сетка, тоже в CSR: массив смещений по ячейкам
 * плюс плоский массив узлов. Дерево (k-d или R) дало бы миллионы мелких
 * объектов и работу сборщику мусора; сетка укладывается в два типизированных
 * массива и на городском масштабе быстрее, потому что узлы распределены
 * достаточно равномерно.
 */

import { readFile } from 'node:fs/promises';

import { COORD_SCALE, decodeGraph } from './format.js';

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;

/** Целевой размер ячейки сетки, метры. */
const CELL_SIZE_M = 250;

/** Сколько колец сетки просматривать, прежде чем признать точку вне графа. */
const MAX_SNAP_RINGS = 24;

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

/**
 * Строит сеточный индекс узлов.
 * Вызывается один раз при загрузке графа.
 */
const buildGrid = (lat, lon, nodeCount) => {
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

  const midLat = (minLat + maxLat) / 2;
  // Градус широты — всегда ~111 км; градус долготы сжимается к полюсам.
  const latStep = Math.round((CELL_SIZE_M / 111_320) * COORD_SCALE);
  const lonStep = Math.round(
    (CELL_SIZE_M / (111_320 * Math.max(0.1, Math.cos((midLat / COORD_SCALE) * DEG_TO_RAD)))) * COORD_SCALE,
  );

  const cols = Math.max(1, Math.ceil((maxLon - minLon + 1) / lonStep));
  const rows = Math.max(1, Math.ceil((maxLat - minLat + 1) / latStep));
  const cellCount = cols * rows;

  const cellOf = (nodeLat, nodeLon) => {
    const col = Math.min(cols - 1, Math.max(0, Math.floor((nodeLon - minLon) / lonStep)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((nodeLat - minLat) / latStep)));
    return row * cols + col;
  };

  // Два прохода: сначала считаем размеры ячеек, потом раскладываем узлы.
  const counts = new Uint32Array(cellCount + 1);
  for (let i = 0; i < nodeCount; i += 1) {
    counts[cellOf(lat[i], lon[i]) + 1] += 1;
  }
  for (let c = 0; c < cellCount; c += 1) {
    counts[c + 1] += counts[c];
  }

  const cellOffsets = counts;
  const cellNodes = new Uint32Array(nodeCount);
  const cursor = new Uint32Array(cellCount);
  for (let i = 0; i < nodeCount; i += 1) {
    const cell = cellOf(lat[i], lon[i]);
    cellNodes[cellOffsets[cell] + cursor[cell]] = i;
    cursor[cell] += 1;
  }

  return { minLat, minLon, latStep, lonStep, cols, rows, cellOffsets, cellNodes };
};

/**
 * @param {object} decoded результат decodeGraph
 */
export const createGraph = (decoded) => {
  const { lat, lon, nodeCount } = decoded;
  const grid = buildGrid(lat, lon, nodeCount);

  /**
   * Ближайший узел графа к произвольной точке.
   *
   * Просматриваются кольца ячеек вокруг исходной. Поиск не прекращается
   * на первом найденном узле: ближайший может лежать в соседнем кольце,
   * поэтому после первой находки досматривается ещё одно кольцо.
   *
   * @returns {{node: number, distance: number}|null}
   */
  const snap = (latDeg, lonDeg, maxDistanceM = 2000) => {
    const targetLat = Math.round(latDeg * COORD_SCALE);
    const targetLon = Math.round(lonDeg * COORD_SCALE);

    const col0 = Math.min(
      grid.cols - 1,
      Math.max(0, Math.floor((targetLon - grid.minLon) / grid.lonStep)),
    );
    const row0 = Math.min(
      grid.rows - 1,
      Math.max(0, Math.floor((targetLat - grid.minLat) / grid.latStep)),
    );

    let best = -1;
    let bestDistance = Infinity;
    let ringsAfterHit = -1;

    for (let ring = 0; ring < MAX_SNAP_RINGS; ring += 1) {
      const rowFrom = Math.max(0, row0 - ring);
      const rowTo = Math.min(grid.rows - 1, row0 + ring);
      const colFrom = Math.max(0, col0 - ring);
      const colTo = Math.min(grid.cols - 1, col0 + ring);

      for (let row = rowFrom; row <= rowTo; row += 1) {
        const onRowEdge = row === row0 - ring || row === row0 + ring;
        for (let col = colFrom; col <= colTo; col += 1) {
          // Внутренние ячейки уже просмотрены на предыдущих кольцах.
          if (!onRowEdge && col !== col0 - ring && col !== col0 + ring) continue;

          const cell = row * grid.cols + col;
          const from = grid.cellOffsets[cell];
          const to = grid.cellOffsets[cell + 1];
          for (let k = from; k < to; k += 1) {
            const node = grid.cellNodes[k];
            const distance = distanceMeters(targetLat, targetLon, lat[node], lon[node]);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = node;
            }
          }
        }
      }

      if (best >= 0) {
        if (ringsAfterHit < 0) ringsAfterHit = ring;
        // Одно дополнительное кольцо — страховка от «почти на границе ячейки».
        if (ring > ringsAfterHit) break;
      }
      if (ring * CELL_SIZE_M > maxDistanceM) break;
    }

    if (best < 0 || bestDistance > maxDistanceM) {
      return null;
    }
    return { node: best, distance: bestDistance };
  };

  return Object.freeze({
    ...decoded,
    snap,
    /** Координаты узла в градусах — для сборки геометрии ответа. */
    coordsOf: (node) => [lat[node] / COORD_SCALE, lon[node] / COORD_SCALE],
    /** Оценка занимаемой памяти, байты. */
    memoryBytes:
      decoded.byteLength + grid.cellOffsets.byteLength + grid.cellNodes.byteLength,
  });
};

/** Загружает граф с диска. */
export const loadGraph = async (filePath) => createGraph(decodeGraph(await readFile(filePath)));
