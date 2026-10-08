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
 *   npm run build:graph                                    # Казань и все точки справочника
 *   node scripts/build-road-graph.mjs --tiles 4            # мельче тайлы, если Overpass отваливается
 *   node scripts/build-road-graph.mjs --input dump.json    # из готовой выгрузки, без сети
 *   node scripts/build-road-graph.mjs --print-query        # запрос для overpass-turbo.eu
 *
 * Оборвалась сборка — запустите ту же команду снова: скачанные рамки
 * лежат в data/graph/.overpass-cache и повторно не качаются.
 *   node scripts/build-road-graph.mjs --bbox 55.7,49.0,55.9,49.3 --out data/graph/kazan.graph
 *
 * Данные OpenStreetMap — ODbL. В приложении требуется указание авторства:
 * «© участники OpenStreetMap».
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coverageBbox, directoryPoints } from '../backend/routing/coverage.js';
import { createGraph } from '../backend/routing/graph.js';
import { decodeGraph, encodeGraph, PROFILE_NAMES } from '../backend/routing/format.js';
import { buildOverpassQuery, osmToGraph } from '../backend/routing/osm.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const DEFAULT_OUT = 'data/graph/kazan.graph';

/*
 * Публичные зеркала Overpass. Первым пробуется то, что последним ответило
 * успешно: перегрузка у волонтёрских серверов длится часами, и раз за разом
 * начинать с упавшего зеркала — потеря времени. maps.mail.ru — зеркало
 * в России, для выгрузки по Казани обычно самое быстрое.
 */
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/*
 * Overpass требует осмысленного User-Agent: запросы от безымянного клиента
 * зеркала отклоняют, в том числе кодом 406. Node по умолчанию такого
 * заголовка не ставит.
 */
/** На сколько уровней максимум дробится слишком тяжёлая рамка. */
const MAX_SPLIT_DEPTH = 3;

const USER_AGENT = 'MedKarta-graph-builder/1.0 (https://github.com/MaksimMerkushev/MedKarta)';

const parseArgs = (argv) => {
  const args = {
    tiles: 3, out: DEFAULT_OUT, bbox: null, input: [], endpoint: null, printQuery: false, noCache: false, keepCache: false,
    allowMissing: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (key === '--bbox') { args.bbox = value.split(',').map(Number); if (!inline) i += 1; }
    else if (key === '--tiles') {
      // Целое 1…8: «abc» давало ноль тайлов, «2.5» — тайлы за пределами рамки.
      const tiles = Number(value);
      if (!Number.isInteger(tiles) || tiles < 1 || tiles > 8) throw new Error('--tiles ожидает целое число от 1 до 8');
      args.tiles = tiles;
      if (!inline) i += 1;
    }
    else if (key === '--out') { args.out = value; if (!inline) i += 1; }
    else if (key === '--input') { args.input.push(...value.split(',')); if (!inline) i += 1; }
    else if (key === '--print-query') { args.printQuery = true; }
    else if (key === '--no-cache') { args.noCache = true; }
    else if (key === '--keep-cache') { args.keepCache = true; }
    else if (key === '--allow-missing') { args.allowMissing = true; }
    else if (key === '--endpoint') { args.endpoint = value; if (!inline) i += 1; }
  }
  if (args.bbox && (args.bbox.length !== 4 || args.bbox.some((n) => !Number.isFinite(n)))) {
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

/** Делит рамку на четыре части. */
const quarter = ([south, west, north, east]) => {
  const midLat = (south + north) / 2;
  const midLon = (west + east) / 2;
  return [
    [south, west, midLat, midLon],
    [south, midLon, midLat, east],
    [midLat, west, north, midLon],
    [midLat, midLon, north, east],
  ];
};

const TIMEOUT_CODES = new Set([504, 502, 503]);

/** Сколько раз пробовать одну рамку, перебирая зеркала, прежде чем сдаться. */
const MAX_ATTEMPTS = 16;

/**
 * Отказ 504 быстрее этого порога — сервер перегружен и не взял запрос
 * в работу; медленнее — запрос взят, но не уложился, то есть рамка тяжела.
 * Переменная окружения — только для тестов с имитацией сервера.
 */
const SLOW_RESPONSE_MS = Number(process.env.OVERPASS_SLOW_MS) || 30_000;

/** Потолок ожидания ответа: таймаут самого запроса 180 с плюс запас. */
const REQUEST_TIMEOUT_MS = 200_000;

/*
 * КЕШ ВЫГРУЗКИ. Каждая успешно скачанная рамка сразу пишется на диск.
 * Если сборка оборвалась — сеть, перегруженное зеркало, Ctrl+C, — повторный
 * запуск той же команды не качает скачанное заново, а продолжает с места
 * остановки. Рамки, которые пришлось дробить, помечаются, чтобы при повторе
 * сразу идти к частям. После успешной сборки кеш удаляется.
 */
const CACHE_DIR = path.join(ROOT, 'data/graph/.overpass-cache');

const cacheFile = (bbox) =>
  path.join(CACHE_DIR, `${createHash('sha1').update(buildOverpassQuery(bbox)).digest('hex').slice(0, 20)}.json`);

/* Выгрузка старше недели считается устаревшей: дороги меняются. */
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const readCache = async (bbox) => {
  try {
    const file = cacheFile(bbox);
    if (Date.now() - (await stat(file)).mtimeMs > CACHE_MAX_AGE_MS) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

const writeCache = async (bbox, value) => {
  const file = cacheFile(bbox);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
};

const hostOf = (endpoint) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
};

const fetchQuarters = async (bbox, state, depth) => {
  const collected = [];
  for (const part of quarter(bbox)) {
    collected.push(...(await fetchArea(part, state, depth + 1)));
  }
  return collected;
};

/**
 * Выгружает одну рамку.
 *
 * КАК РЕАГИРОВАТЬ НА ОТКАЗ. Код 504 бывает двух видов, и лечатся они
 * по-разному:
 *   - быстрый 504 (секунды) — сервер перегружен и запрос в работу не взял.
 *     Дробить рамку бессмысленно: 64 маленьких запроса перегруженный сервер
 *     отклонит так же. Нужно другое зеркало или пауза;
 *   - медленный 504 (десятки секунд) — запрос не уложился в таймаут,
 *     рамка тяжела. Её делим на четыре части.
 * Ответ 200 тоже бывает неполным: при нехватке времени или памяти Overpass
 * отдаёт то, что успел, и пишет об этом в поле remark. Такой ответ не
 * принимается — граф с дырами хуже, чем повторный запрос.
 *
 * @param {number[]} bbox
 * @param {{endpoints: string[], preferred: number, useCache: boolean, stats: object}} state
 * @param {number} depth текущая глубина дробления
 */
const fetchArea = async (bbox, state, depth = 0) => {
  if (state.useCache) {
    const cached = await readCache(bbox);
    if (cached?.split) return fetchQuarters(bbox, state, depth);
    if (Array.isArray(cached?.elements)) {
      state.stats.fromCache += 1;
      return cached.elements;
    }
  }

  const split = async (reason) => {
    process.stdout.write(`\n      ${reason}: дроблю рамку на 4 части`);
    if (state.useCache) await writeCache(bbox, { split: true });
    return fetchQuarters(bbox, state, depth);
  };

  let fastFailures = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const endpoint = state.endpoints[(state.preferred + attempt) % state.endpoints.length];
    await waitForSlot(endpoint);

    const started = Date.now();
    let response;
    let failure;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: `data=${encodeURIComponent(buildOverpassQuery(bbox))}`,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      failure = `нет ответа (${error.name === 'TimeoutError' ? 'таймаут' : error.message})`;
    }
    const elapsed = Date.now() - started;

    if (response?.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        failure = 'ответ не JSON';
      }

      if (payload) {
        const remark = String(payload.remark || '');
        if (/runtime error|timed out|out of memory/i.test(remark)) {
          // Данные неполные: сервер не уложился и отдал часть.
          if (depth < MAX_SPLIT_DEPTH) return split('ответ неполный');
          failure = 'ответ неполный';
        } else {
          state.preferred = state.endpoints.indexOf(endpoint);
          const elements = payload.elements || [];
          if (state.useCache) await writeCache(bbox, { elements });
          state.stats.downloaded += 1;
          return elements;
        }
      }
    } else if (response) {
      const detail = (await response.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      failure = `ответ ${response.status}${detail ? ` (${detail.slice(0, 80)})` : ''}`;

      if (TIMEOUT_CODES.has(response.status)) {
        const heavy = elapsed >= SLOW_RESPONSE_MS;
        if (!heavy) fastFailures += 1;
        // Дробим, если рамка тяжела, или если перегружены все зеркала по два раза подряд.
        if (depth < MAX_SPLIT_DEPTH && (heavy || fastFailures >= state.endpoints.length * 2)) {
          return split(`${response.status} за ${Math.round(elapsed / 1000)} c`);
        }
      }

      const retryAfter = Number(response.headers.get('retry-after'));
      if (response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
        await sleep(retryAfter * 1000);
      }
    }

    // Сначала быстро обходим все зеркала, потом паузы удваиваются.
    const wait = Math.min(120_000, 5000 * 2 ** Math.floor(attempt / state.endpoints.length));
    const next = hostOf(state.endpoints[(state.preferred + attempt + 1) % state.endpoints.length]);
    process.stdout.write(
      `\n      ${hostOf(endpoint)}: ${failure} — через ${Math.round(wait / 1000)} c пробую ${next}`,
    );
    await sleep(wait);
  }

  throw new Error(
    `часть рамки ${bbox.map((n) => n.toFixed(3)).join(',')} не выгрузилась за ${MAX_ATTEMPTS} попыток: ` +
    'все зеркала Overpass перегружены.\n' +
    'Скачанное сохранено. Запустите ту же команду ещё раз — сборка продолжится с места остановки.',
  );
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

/**
 * Проверка собранного графа: к каждой точке справочника должна найтись
 * дорога для каждого вида транспорта. Раньше граф молча не покрывал
 * окраинные учреждения, и это обнаруживалось только в интерфейсе.
 */
const checkCoverage = (buffer, points) => {
  const graph = createGraph(decodeGraph(buffer));
  const missing = [];
  const unique = new Map(points.map((point) => [`${point.lat.toFixed(5)},${point.lng.toFixed(5)}`, point]));
  for (const point of unique.values()) {
    const profiles = PROFILE_NAMES.filter((profile) => !graph.snapToRoad(point.lat, point.lng, profile));
    if (profiles.length > 0) missing.push({ point, profiles });
  }
  return { missing, checked: unique.size, components: graph.mainComponentSizes() };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const points = await directoryPoints();
  // Рамка по умолчанию выводится из справочника: см. backend/routing/coverage.js.
  const derived = !args.bbox;
  if (derived) args.bbox = coverageBbox(points);
  let elements = [];

  if (args.printQuery) {
    // Запрос для ручной выгрузки через overpass-turbo.eu.
    for (const [index, part] of splitBbox(args.bbox, args.tiles).entries()) {
      process.stdout.write(`\n=== тайл ${index + 1} ===\n${buildOverpassQuery(part)}\n`);
    }
    return;
  }

  if (args.input.length > 0) {
    // Несколько файлов: выгрузку удобно делать по тайлам и склеивать.
    const seen = new Map();
    for (const file of args.input) {
      const resolved = file.startsWith('~') ? file.replace('~', process.env.HOME || '~') : file;
      process.stdout.write(`Читаю выгрузку из ${resolved}\n`);
      const payload = JSON.parse(await readFile(path.resolve(ROOT, resolved), 'utf8'));
      for (const element of payload.elements || payload) {
        seen.set(`${element.type}/${element.id}`, element);
      }
    }
    elements = [...seen.values()];
  } else {
    const parts = splitBbox(args.bbox, args.tiles);
    const state = {
      endpoints: args.endpoint ? [args.endpoint] : ENDPOINTS,
      preferred: 0,
      useCache: !args.noCache,
      stats: { downloaded: 0, fromCache: 0 },
    };
    process.stdout.write(
      `Рамка ${args.bbox.join(',')}${derived ? ` — Казань и ${points.length} точек справочника с запасом` : ''}.\n` +
      `Выгружаю ${parts.length} тайл(ов) из Overpass. Это занимает минуты.\n`,
    );

    // Элементы дедуплицируются по id: тайлы перекрываются по границам,
    // и один и тот же узел приходит несколько раз.
    const seen = new Map();
    for (const [index, part] of parts.entries()) {
      process.stdout.write(`  тайл ${index + 1}/${parts.length}…`);
      const tile = await fetchArea(part, state);
      for (const element of tile) {
        seen.set(`${element.type}/${element.id}`, element);
      }
      process.stdout.write(` +${tile.length.toLocaleString('ru')} элементов\n`);
    }
    elements = [...seen.values()];
    if (state.stats.fromCache > 0) {
      process.stdout.write(`  (из них ${state.stats.fromCache} рамок взято из кеша прошлого запуска)\n`);
    }
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

  /*
   * Покрытие проверяется ДО публикации. Раньше граф сначала заменял рабочий
   * файл (сервер подхватывает его за 30 секунд), а потом печаталось «450 из
   * 493 адресов без дороги» — и сборка завершалась успехом. Теперь неполный
   * граф не публикуется, код выхода — 1. Осознанно принять пропуски можно
   * флагом --allow-missing.
   */
  const coverage = checkCoverage(buffer, points);
  const rejected = coverage.missing.length > 0 && !args.allowMissing;

  if (!rejected) {
    await mkdir(path.dirname(outPath), { recursive: true });
    // Запись через временный файл: работающий сервер следит за графом
    // и не должен прочитать его наполовину записанным.
    await writeFile(`${outPath}.tmp`, buffer);
    await rename(`${outPath}.tmp`, outPath);

    // Кеш удаляется только после успешной публикации: при отказе он
    // понадобится для следующей попытки. С --no-cache он не трогается вовсе.
    if (args.input.length === 0 && !args.keepCache && !args.noCache) {
      await rm(CACHE_DIR, { recursive: true, force: true });
    }
  }

  const mib = (bytes) => (bytes / 1048576).toFixed(1);
  process.stdout.write(
    `\n${rejected ? 'Граф НЕ опубликован (см. покрытие ниже)' : `Готово: ${args.out}`}\n` +
    `  узлов:  ${stats.nodeCount.toLocaleString('ru')}\n` +
    `  рёбер:  ${stats.edgeCount.toLocaleString('ru')}\n` +
    `  дорог:  ${stats.acceptedWays.toLocaleString('ru')} из ${stats.osmWays.toLocaleString('ru')}\n` +
    `  файл:   ${mib(buffer.byteLength)} МБ\n` +
    `  в памяти сервера: примерно ${mib(buffer.byteLength * 1.5)} МБ\n` +
    `  главная компонента: ${Object.entries(coverage.components).map(([k, v]) => `${k} ${v.toLocaleString('ru')}`).join(', ')}\n`,
  );

  if (coverage.missing.length === 0) {
    process.stdout.write(`  покрытие: все ${coverage.checked} адресов справочника доступны для всех видов транспорта\n`);
  } else {
    process.stdout.write(`\n  ВНИМАНИЕ: ${coverage.missing.length} из ${coverage.checked} адресов без дороги рядом — маршрут к ним не построится:\n`);
    for (const { point, profiles } of coverage.missing.slice(0, 20)) {
      process.stdout.write(`    ${point.lat.toFixed(5)},${point.lng.toFixed(5)}  ${profiles.join('/')}  ${point.label || ''}\n`);
    }
    if (rejected) {
      process.stdout.write(
        '\n  Рабочий граф не изменён. Расширьте рамку (--bbox) или, если пропуски ожидаемы,\n' +
        `  повторите с --allow-missing.${args.input.length === 0 ? ' Выгрузка сохранена в кеше, повторная сборка её не скачивает.' : ''}\n`,
      );
      process.exitCode = 1;
    }
  }
  process.stdout.write('\nДанные © участники OpenStreetMap, лицензия ODbL.\n');
};

main().catch((error) => {
  process.stderr.write(`\nОшибка сборки: ${error.message}\n`);
  process.exitCode = 1;
});
