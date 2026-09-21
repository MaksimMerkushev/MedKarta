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
import { buildOverpassQuery, osmToGraph } from '../backend/routing/osm.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Казань с пригородами. */
const DEFAULT_BBOX = [55.65, 48.85, 55.98, 49.42];
const DEFAULT_OUT = 'data/graph/kazan.graph';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

/*
 * Overpass требует осмысленного User-Agent: запросы от безымянного клиента
 * зеркала отклоняют, в том числе кодом 406. Node по умолчанию такого
 * заголовка не ставит.
 */
const USER_AGENT = 'MedKarta-graph-builder/1.0 (https://github.com/MaksimMerkushev/med-navigator)';

const parseArgs = (argv) => {
  const args = { tiles: 2, out: DEFAULT_OUT, bbox: DEFAULT_BBOX, input: null, endpoint: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (key === '--bbox') { args.bbox = value.split(',').map(Number); if (!inline) i += 1; }
    else if (key === '--tiles') { args.tiles = Math.max(1, Number(value)); if (!inline) i += 1; }
    else if (key === '--out') { args.out = value; if (!inline) i += 1; }
    else if (key === '--input') { args.input = value; if (!inline) i += 1; }
    else if (key === '--endpoint') { args.endpoint = value; if (!inline) i += 1; }
  }
  if (args.bbox.length !== 4 || args.bbox.some((n) => !Number.isFinite(n))) {
    throw new Error('--bbox ожидает четыре числа: south,west,north,east');
  }
  return args;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ждёт свободный слот на сервере Overpass.
 *
 * Публичные зеркала выдают квоту слотами и отвечают 429, когда все заняты.
 * Правильнее спросить об этом заранее у /api/status, чем ломиться и получать
 * отказ: это и вежливее к волонтёрскому проекту, и надёжнее.
 */
const waitForSlot = async (endpoint, maxWaitMs = 180_000) => {
  const statusUrl = endpoint.replace(/\/interpreter$/, '/status');
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    let text = '';
    try {
      const response = await fetch(statusUrl, { headers: { 'User-Agent': USER_AGENT } });
      text = await response.text();
    } catch {
      return; // статус недоступен — пробуем запрос как есть
    }

    if (/\d+ slots? available now/i.test(text) || /Rate limit: 0/i.test(text)) {
      return;
    }

    const waits = [...text.matchAll(/in (\d+) seconds/gi)].map((m) => Number(m[1]));
    if (waits.length === 0) return;

    const wait = Math.min(...waits) + 2;
    process.stdout.write(`\n    все слоты заняты, жду ${wait} c…`);
    await sleep(wait * 1000);
  }
};

/**
 * Один запрос к Overpass с повторами.
 *
 * Тело ответа при ошибке ПЕЧАТАЕТСЯ. Раньше наружу шёл только код состояния,
 * и понять, что именно не понравилось серверу, было невозможно.
 */
const fetchTile = async (bbox, endpoints, attempt = 0) => {
  const endpoint = endpoints[attempt % endpoints.length];
  await waitForSlot(endpoint);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    body: `data=${encodeURIComponent(buildOverpassQuery(bbox))}`,
  });

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (attempt >= 6) {
      throw new Error(
        `Overpass отвечает ${response.status} после ${attempt + 1} попыток.\n` +
        `Ответ сервера: ${detail.slice(0, 400)}\n\n` +
        'Обходной путь: откройте https://overpass-turbo.eu, выполните там запрос,\n' +
        'экспортируйте результат в JSON и соберите граф из файла:\n' +
        '  node scripts/build-road-graph.mjs --input путь/к/export.json',
      );
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(120_000, 10_000 * 2 ** attempt);

    process.stdout.write(
      `\n    ответ ${response.status}` +
      (detail ? ` (${detail.slice(0, 120)})` : '') +
      `, повтор через ${Math.round(wait / 1000)} c через другое зеркало\n    `,
    );
    await sleep(wait);
    return fetchTile(bbox, endpoints, attempt + 1);
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
      const tile = await fetchTile(part, args.endpoint ? [args.endpoint] : ENDPOINTS);
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

  if (stats.acceptedWays === 0) {
    throw new Error(
      `в выгрузке ${stats.osmWays} путей, но ни одного пригодного.\n` +
      'Самая частая причина — выгрузка без тегов: оператор `out skel` их отбрасывает,\n' +
      'а без highway, maxspeed и oneway путь для графа бесполезен. Нужен `out body`\n' +
      'для путей и только потом `>; out skel qt;` для их узлов.',
    );
  }
  if (stats.nodeCount === 0) {
    throw new Error('в выгрузке не оказалось ни одного узла дорожной сети');
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
