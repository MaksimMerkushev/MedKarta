/*
 * Воспроизводимый замер движка маршрутизации для документации
 * (docs/05-routing-engine.md, раздел «Замеры»).
 *
 * Скрипт ничего не меняет: читает граф и справочник учреждений и печатает
 * задержки. Нужен собранный граф (npm run build:graph) — в git его нет.
 *
 *   node docs/tools/bench-routing.mjs
 *   node docs/tools/bench-routing.mjs --graph data/graph/kazan.graph --pairs 1000 --seed 42
 *
 * Пары точек — случайные пары учреждений из data/facilities.js с
 * фиксированным зерном: тот же граф и то же зерно дают те же пары.
 */

import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const graphPath = path.resolve(ROOT, option('--graph', 'data/graph/kazan.graph'));
const pairCount = Number(option('--pairs', '1000'));
const seed = Number(option('--seed', '42'));
// Точка отправления для «один ко многим»: центр Казани (район Кремля).
const ORIGIN = { lat: 55.7963, lng: 49.1088 };

const { loadGraph } = await import(new URL('../../backend/routing/graph.js', import.meta.url));
const { createRoutingEngine } = await import(new URL('../../backend/routing/engine.js', import.meta.url));
const { kazanFacilities } = await import(new URL('../../data/facilities.js', import.meta.url));

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const ms = (value) => (value === null ? '—' : value < 1 ? value.toFixed(2) : value.toFixed(1));

// Линейный конгруэнтный генератор: результат не зависит от версии Node.
let state = seed;
const random = () => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return state / 2147483648;
};

const points = kazanFacilities
  .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng))
  .map((item) => ({ lat: item.lat, lng: item.lng }));
const unique = [...new Map(points.map((point) => [`${point.lat},${point.lng}`, point])).values()];

const loadStarted = performance.now();
const graph = await loadGraph(graphPath);
const engine = createRoutingEngine({ graph });
const loadMs = performance.now() - loadStarted;
const stats = engine.stats();

console.log('# Замер движка маршрутизации МедКарты');
console.log(`node ${process.version}, ${os.platform()}/${os.arch()}, CPU: ${os.cpus().length} × ${os.cpus()[0]?.model || 'unknown'}, RAM ${Math.round(os.totalmem() / 1e9)} ГБ`);
console.log(`граф: ${path.relative(ROOT, graphPath)}; узлов ${stats.nodes}, рёбер ${stats.edges}; граф в памяти ${(stats.graphBytes / 1e6).toFixed(1)} МБ, состояние поиска ${(stats.searchStateBytes / 1e6).toFixed(1)} МБ`);
console.log(`загрузка и подготовка графа: ${loadMs.toFixed(0)} мс`);
console.log(`учреждений с координатами: ${points.length} (уникальных точек ${unique.length}); пар: ${pairCount}; зерно: ${seed}`);

const pairs = [];
for (let i = 0; i < pairCount; i += 1) {
  const a = unique[Math.floor(random() * unique.length)];
  let b = unique[Math.floor(random() * unique.length)];
  if (a === b) b = unique[(unique.indexOf(a) + 1) % unique.length];
  pairs.push([a, b]);
}

console.log('\n## Маршрут между двумя учреждениями (route)');
console.log('| Профиль | Построено | Медиана, мс | p95, мс | Максимум, мс | Отказы по кодам |');
console.log('|---|---:|---:|---:|---:|---|');
for (const profile of ['driving', 'foot', 'bike']) {
  const latencies = [];
  const failures = {};
  let ok = 0;
  for (const [a, b] of pairs) {
    const started = performance.now();
    const result = engine.route({ waypoints: [a, b], profile });
    latencies.push(performance.now() - started);
    if (result.ok) ok += 1;
    else failures[result.error] = (failures[result.error] || 0) + 1;
  }
  const failText = Object.entries(failures).map(([code, count]) => `${code}: ${count}`).join(', ') || '—';
  console.log(`| ${profile} | ${ok}/${pairs.length} (${((ok / pairs.length) * 100).toFixed(1)} %) | ${ms(percentile(latencies, 50))} | ${ms(percentile(latencies, 95))} | ${ms(Math.max(...latencies))} | ${failText} |`);
}

const [firstA, firstB] = pairs[0];
engine.route({ waypoints: [firstA, firstB], profile: 'driving' });
const cachedLatencies = [];
for (let i = 0; i < 200; i += 1) {
  const started = performance.now();
  engine.route({ waypoints: [firstA, firstB], profile: 'driving' });
  cachedLatencies.push(performance.now() - started);
}
console.log(`\nповтор того же маршрута (кеш участков), медиана: ${ms(percentile(cachedLatencies, 50))} мс`);

console.log('\n## Время в пути от одной точки до всех учреждений (travelTimes)');
console.log(`точка отправления: ${ORIGIN.lat}, ${ORIGIN.lng}; целей: ${unique.length}`);
console.log('| Профиль | Потолок, мин | Первый запрос, мс | Повтор, медиана из 20, мс | Достижимо целей |');
console.log('|---|---:|---:|---:|---:|');
for (const profile of ['driving', 'foot']) {
  for (const minutes of [30, 120]) {
    const fresh = createRoutingEngine({ graph });
    const started = performance.now();
    const first = await fresh.travelTimes(ORIGIN, unique, profile, { maxSeconds: minutes * 60 });
    const firstMs = performance.now() - started;
    const repeats = [];
    for (let i = 0; i < 20; i += 1) {
      const again = performance.now();
      await fresh.travelTimes(ORIGIN, unique, profile, { maxSeconds: minutes * 60 });
      repeats.push(performance.now() - again);
    }
    const reached = first.filter((item) => Number.isFinite(item.durationSeconds)).length;
    console.log(`| ${profile} | ${minutes} | ${ms(firstMs)} | ${ms(percentile(repeats, 50))} | ${reached}/${unique.length} |`);
  }
}
