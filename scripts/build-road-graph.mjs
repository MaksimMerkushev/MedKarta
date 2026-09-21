#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Разовая сборка дорожного графа из OpenStreetMap.
 *
 * Запускается НЕ на боевом сервере: выгрузка требует сети и памяти, которых
 * на слабой машине лучше не занимать. Собранный файл кладётся рядом с
 * приложением и загружается за десятки миллисекунд.
 *
 *   node scripts/build-road-graph.mjs                      # Казань по умолчанию
 *   node scripts/build-road-graph.mjs --tiles 4            # мельче тайлы, если Overpass отваливается
 *   node scripts/build-road-graph.mjs --input dump.json    # из готовой выгрузки, без сети
 *   node scripts/build-road-graph.mjs --bbox 55.7,49.0,55.9,49.3 --out data/graph/kazan.graph
 *
 * Данные OpenStreetMap — ODbL. В приложении требуется указание авторства:
 * «© участники OpenStreetMap».
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGraph } from '../backend/routing/format.js';
import { osmToGraph } from '../backend/routing/osm.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Казань с пригородами. */
const DEFAULT_BBOX = [55.65, 48.85, 55.98, 49.42];
const DEFAULT_OUT = 'data/graph/kazan.graph';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const parseArgs = (argv) => {
  const args = { tiles: 3, out: DEFAULT_OUT, bbox: DEFAULT_BBOX, input: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (key === '--bbox') { args.bbox = value.split(',').map(Number); if (!inline) i += 1; }
    else if (key === '--tiles') { args.tiles = Math.max(1, Number(value)); if (!inline) i += 1; }
    else if (key === '--out') { args.out = value; if (!inline) i += 1; }
    else if (key === '--input') { args.input = value; if (!inline) i += 1; }
  }
  if (args.bbox.length !== 4 || args.bbox.some((n) => !Number.isFinite(n))) {
    throw new Error('--bbox ожидает четыре числа: south,west,north,east');
  }
  return args;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Запрос к Overpass с повторами.
 *
 * Публичные серверы Overpass — общий ресурс волонтёрского проекта. Между
 * тайлами выдерживается пауза, при отказе — увеличенная задержка и смена
 * зеркала. Выгрузка делается один раз, спешить некуда.
 */
const fetchTile = async (bbox, attempt = 0) => {
  const [south, west, north, east] = bbox;
  const query = `[out:json][timeout:180];
way["highway"]["highway"!~"^(proposed|construction|raceway|bus_guideway|escape|elevator|platform|corridor)$"](${south},${west},${north},${east});
(._;>;);
out skel qt;`;

  const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!response.ok) {
    if (attempt >= 5) {
      throw new Error(`Overpass ответил ${response.status} после ${attempt + 1} попыток`);
    }
    const wait = 15_000 * (attempt + 1);
    process.stdout.write(`    ответ ${response.status}, повтор через ${wait / 1000} c\n`);
    await sleep(wait);
    return fetchTile(bbox, attempt + 1);
  }

  const payload = await response.json();
  return payload.elements || [];
};

const splitBbox = ([south, west, north, east], tiles) => {
  const latStep = (north - south) / tiles;
  const lonStep = (east - west) / tiles;
  const parts = [];
  for (let row = 0; row < tiles; row += 1) {
    for (let col = 0; col < tiles; col += 1) {
      parts.push([
        south + row * latStep,
        west + col * lonStep,
        row === tiles - 1 ? north : south + (row + 1) * latStep,
        col === tiles - 1 ? east : west + (col + 1) * lonStep,
      ]);
    }
  }
  return parts;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  let elements = [];

  if (args.input) {
    process.stdout.write(`Читаю выгрузку из ${args.input}\n`);
    const payload = JSON.parse(await readFile(path.resolve(ROOT, args.input), 'utf8'));
    elements = payload.elements || payload;
  } else {
    const parts = splitBbox(args.bbox, args.tiles);
    process.stdout.write(`Выгружаю ${parts.length} тайл(ов) из Overpass. Это занимает минуты.\n`);

    // Элементы дедуплицируются по id: тайлы перекрываются по границам,
    // и один и тот же узел приходит несколько раз.
    const seen = new Map();
    for (const [index, part] of parts.entries()) {
      process.stdout.write(`  тайл ${index + 1}/${parts.length}…`);
      const tile = await fetchTile(part);
      for (const element of tile) {
        seen.set(`${element.type}/${element.id}`, element);
      }
      process.stdout.write(` +${tile.length.toLocaleString('ru')} элементов\n`);
      if (index + 1 < parts.length) await sleep(3000);
    }
    elements = [...seen.values()];
  }

  process.stdout.write(`\nСобираю граф из ${elements.length.toLocaleString('ru')} элементов…\n`);
  const { graph, stats } = osmToGraph(elements);

  if (stats.nodeCount === 0) {
    throw new Error('в выгрузке не оказалось ни одной пригодной дороги');
  }

  const buffer = encodeGraph(graph);
  const outPath = path.resolve(ROOT, args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);

  const mib = (bytes) => (bytes / 1048576).toFixed(1);
  process.stdout.write(
    `\nГотово: ${args.out}\n` +
    `  узлов:  ${stats.nodeCount.toLocaleString('ru')}\n` +
    `  рёбер:  ${stats.edgeCount.toLocaleString('ru')}\n` +
    `  дорог:  ${stats.acceptedWays.toLocaleString('ru')} из ${stats.osmWays.toLocaleString('ru')}\n` +
    `  файл:   ${mib(buffer.byteLength)} МБ\n` +
    `  в памяти сервера: примерно ${mib(buffer.byteLength + stats.nodeCount * 20)} МБ\n\n` +
    'Данные © участники OpenStreetMap, лицензия ODbL.\n',
  );
};

main().catch((error) => {
  process.stderr.write(`\nОшибка сборки: ${error.message}\n`);
  process.exitCode = 1;
});
