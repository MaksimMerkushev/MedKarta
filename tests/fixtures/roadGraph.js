/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Синтетический дорожный граф для тестов маршрутизации.
 *
 * Настоящий граф Казани собирается из OpenStreetMap офлайн и в git не лежит:
 * он весит десятки мегабайт и меняется. Проверять алгоритм на нём нельзя —
 * тесты должны быть детерминированными и не зависеть от того, что сегодня
 * нарисовали в OSM.
 *
 * Сетка выбрана намеренно: на ней легко посчитать эталонный ответ независимой
 * реализацией и сравнить с тем, что вернул A*.
 */

import { COORD_SCALE, ACCESS } from '../../backend/routing/format.js';
import { distanceMeters } from '../../backend/routing/graph.js';

export const GRID = Object.freeze({
  rows: 40,
  cols: 40,
  originLat: 55.75,
  originLon: 49.1,
  // ~110 м между узлами: близко к реальному размеру городского квартала.
  step: 0.001,
});

export const nodeIndex = (row, col) => row * GRID.cols + col;

/**
 * Строит сетчатый граф.
 *
 * @param {object} [options]
 * @param {Set<string>} [options.slowEdges] рёбра «row,col→row,col» с низкой скоростью
 * @param {Set<string>} [options.footOnlyEdges] рёбра, закрытые для автомобиля
 * @param {boolean} [options.island] добавить несвязный компонент
 */
export const buildGridGraph = ({ slowEdges = new Set(), footOnlyEdges = new Set(), island = false } = {}) => {
  const { rows, cols, originLat, originLon, step } = GRID;
  const gridNodes = rows * cols;
  const nodeCount = gridNodes + (island ? 2 : 0);

  const lat = new Int32Array(nodeCount);
  const lon = new Int32Array(nodeCount);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = nodeIndex(row, col);
      lat[index] = Math.round((originLat + row * step) * COORD_SCALE);
      lon[index] = Math.round((originLon + col * step) * COORD_SCALE);
    }
  }

  if (island) {
    // Отдельный компонент далеко в стороне: до него нет ни одной дороги.
    lat[gridNodes] = Math.round((originLat + 0.5) * COORD_SCALE);
    lon[gridNodes] = Math.round((originLon + 0.5) * COORD_SCALE);
    lat[gridNodes + 1] = Math.round((originLat + 0.5011) * COORD_SCALE);
    lon[gridNodes + 1] = Math.round((originLon + 0.5) * COORD_SCALE);
  }

  // Списки смежности собираются обычными массивами, затем уплотняются в CSR.
  const adjacency = Array.from({ length: nodeCount }, () => []);

  const connect = (aRow, aCol, bRow, bCol) => {
    const a = nodeIndex(aRow, aCol);
    const b = nodeIndex(bRow, bCol);
    const metres = Math.max(1, Math.round(distanceMeters(lat[a], lon[a], lat[b], lon[b])));

    const key = `${aRow},${aCol}->${bRow},${bCol}`;
    const reverseKey = `${bRow},${bCol}->${aRow},${aCol}`;
    const slow = slowEdges.has(key) || slowEdges.has(reverseKey);
    const footOnly = footOnlyEdges.has(key) || footOnlyEdges.has(reverseKey);

    const speed = slow ? 15 : 50;
    const mask = footOnly ? ACCESS.FOOT | ACCESS.BIKE : ACCESS.CAR | ACCESS.FOOT | ACCESS.BIKE;

    adjacency[a].push({ target: b, length: metres, speed, access: mask });
    adjacency[b].push({ target: a, length: metres, speed, access: mask });
  };

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (col + 1 < cols) connect(row, col, row, col + 1);
      if (row + 1 < rows) connect(row, col, row + 1, col);
    }
  }

  if (island) {
    const metres = Math.max(1, Math.round(distanceMeters(lat[gridNodes], lon[gridNodes], lat[gridNodes + 1], lon[gridNodes + 1])));
    const mask = ACCESS.CAR | ACCESS.FOOT | ACCESS.BIKE;
    adjacency[gridNodes].push({ target: gridNodes + 1, length: metres, speed: 50, access: mask });
    adjacency[gridNodes + 1].push({ target: gridNodes, length: metres, speed: 50, access: mask });
  }

  const edgeCount = adjacency.reduce((sum, list) => sum + list.length, 0);
  const offsets = new Uint32Array(nodeCount + 1);
  const targets = new Uint32Array(edgeCount);
  const lengths = new Uint32Array(edgeCount);
  const speeds = new Uint8Array(edgeCount);
  const access = new Uint8Array(edgeCount);

  let cursor = 0;
  for (let node = 0; node < nodeCount; node += 1) {
    offsets[node] = cursor;
    for (const edge of adjacency[node]) {
      targets[cursor] = edge.target;
      lengths[cursor] = edge.length;
      speeds[cursor] = edge.speed;
      access[cursor] = edge.access;
      cursor += 1;
    }
  }
  offsets[nodeCount] = cursor;

  return { lat, lon, offsets, targets, lengths, speeds, access, nodeCount, edgeCount, gridNodes };
};

/**
 * Эталонный Дейкстра — независимая реализация на обычных массивах.
 *
 * Специально написан «наивно» и без эвристики: если A* с кучей на
 * типизированных массивах согласен с ним на тысячах пар точек, ошибку
 * в оптимизированной версии это поймает.
 */
export const referenceDijkstra = (graph, source, target, { access: accessMask, fallbackMps, useEdgeSpeed }) => {
  const { nodeCount, offsets, targets, lengths, speeds, access } = graph;
  const dist = new Array(nodeCount).fill(Infinity);
  const done = new Array(nodeCount).fill(false);
  dist[source] = 0;

  for (;;) {
    let current = -1;
    let best = Infinity;
    for (let node = 0; node < nodeCount; node += 1) {
      if (!done[node] && dist[node] < best) {
        best = dist[node];
        current = node;
      }
    }
    if (current === -1 || current === target) break;
    done[current] = true;

    for (let edge = offsets[current]; edge < offsets[current + 1]; edge += 1) {
      if ((access[edge] & accessMask) === 0) continue;
      const speedMps = useEdgeSpeed && speeds[edge] > 0 ? speeds[edge] / 3.6 : fallbackMps;
      const candidate = dist[current] + lengths[edge] / speedMps;
      if (candidate < dist[targets[edge]]) {
        dist[targets[edge]] = candidate;
      }
    }
  }

  return dist[target];
};
