/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Преобразование выгрузки OpenStreetMap в дорожный граф.
 *
 * Модуль отделён от скрипта сборки намеренно: разбор тегов — самая уязвимая
 * к ошибкам часть, и её нужно проверять тестами, а не глазами на выгрузке
 * в сотни мегабайт. Скрипт отвечает только за сеть и файлы.
 *
 * Данные OpenStreetMap распространяются по лицензии ODbL. Сборка графа —
 * производное произведение, и при публикации приложения требуется указание
 * авторства: «© участники OpenStreetMap».
 */

import { ACCESS, COORD_SCALE } from './format.js';

/**
 * Скорость по типу дороги, км/ч, когда тег maxspeed отсутствует.
 * Значения городские и осознанно скромные: завышенная скорость даёт
 * оптимистичный ETA, а пользователь опаздывает к врачу.
 */
const DEFAULT_SPEED = {
  motorway: 90,
  motorway_link: 60,
  trunk: 80,
  trunk_link: 50,
  primary: 60,
  primary_link: 40,
  secondary: 55,
  secondary_link: 40,
  tertiary: 50,
  tertiary_link: 35,
  unclassified: 40,
  residential: 30,
  living_street: 15,
  service: 20,
  road: 30,
};

/** Кто имеет право проезда по типу дороги до учёта отдельных тегов. */
const BASE_ACCESS = {
  motorway: ACCESS.CAR,
  motorway_link: ACCESS.CAR,
  trunk: ACCESS.CAR,
  trunk_link: ACCESS.CAR,
  primary: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  primary_link: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  secondary: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  secondary_link: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  tertiary: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  tertiary_link: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  unclassified: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  residential: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  living_street: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  service: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  road: ACCESS.CAR | ACCESS.BIKE | ACCESS.FOOT,
  pedestrian: ACCESS.FOOT | ACCESS.BIKE,
  footway: ACCESS.FOOT,
  path: ACCESS.FOOT | ACCESS.BIKE,
  steps: ACCESS.FOOT,
  cycleway: ACCESS.BIKE | ACCESS.FOOT,
  track: ACCESS.FOOT | ACCESS.BIKE,
};

/** Значения тега access, запрещающие проход и проезд всем. */
const BLOCKED_ACCESS = new Set(['no', 'private', 'military', 'delivery']);

/** Разбирает maxspeed: «60», «60 km/h», «RU:urban». */
export const parseMaxSpeed = (value) => {
  if (typeof value !== 'string') return null;
  const direct = value.match(/^(\d{1,3})(?:\s*km\/?h)?$/i);
  if (direct) {
    const speed = Number(direct[1]);
    return speed > 0 && speed <= 130 ? speed : null;
  }
  if (/RU:urban/i.test(value)) return 60;
  if (/RU:living_street/i.test(value)) return 20;
  if (/RU:rural/i.test(value)) return 90;
  const mph = value.match(/^(\d{1,3})\s*mph$/i);
  if (mph) return Math.round(Number(mph[1]) * 1.609);
  return null;
};

/**
 * Права проезда по одному пути с учётом частных тегов.
 * Возвращает маску вперёд и назад: односторонняя улица закрыта для
 * автомобиля в обратную сторону, но пешеход по ней ходит в обе.
 */
export const wayAccess = (tags = {}) => {
  const base = BASE_ACCESS[tags.highway];
  if (base === undefined) return null;

  let mask = base;
  if (BLOCKED_ACCESS.has(tags.access)) return null;
  if (BLOCKED_ACCESS.has(tags.motor_vehicle) || BLOCKED_ACCESS.has(tags.vehicle)) mask &= ~ACCESS.CAR;
  if (BLOCKED_ACCESS.has(tags.foot)) mask &= ~ACCESS.FOOT;
  if (BLOCKED_ACCESS.has(tags.bicycle)) mask &= ~ACCESS.BIKE;
  if (tags.foot === 'yes' || tags.foot === 'designated') mask |= ACCESS.FOOT;
  if (tags.bicycle === 'yes' || tags.bicycle === 'designated') mask |= ACCESS.BIKE;
  if (mask === 0) return null;

  const oneway = tags.oneway;
  const isOneway = oneway === 'yes' || oneway === '1' || oneway === 'true';
  const isReversed = oneway === '-1' || oneway === 'reverse';

  // Пешеход и велосипед игнорируют одностороннее движение, если явно
  // не сказано обратное. Для велосипеда это тег oneway:bicycle.
  const bikeIgnoresOneway = tags['oneway:bicycle'] !== 'yes';

  let forward = mask;
  let backward = mask;

  if (isOneway || isReversed) {
    const restricted = ACCESS.CAR | (bikeIgnoresOneway ? 0 : ACCESS.BIKE);
    if (isOneway) backward &= ~restricted;
    if (isReversed) forward &= ~restricted;
  }

  return { forward, backward };
};

export const waySpeed = (tags = {}) =>
  parseMaxSpeed(tags.maxspeed) || DEFAULT_SPEED[tags.highway] || 30;

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;

const metersBetween = (latA, lonA, latB, lonB) => {
  const lat1 = latA * DEG_TO_RAD;
  const lat2 = latB * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLon = (lonB - lonA) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Собирает граф из элементов Overpass.
 *
 * @param {Array<object>} elements узлы и пути в формате Overpass JSON
 * @returns {{graph: object, stats: object}}
 */
export const osmToGraph = (elements) => {
  const coords = new Map();
  const ways = [];

  for (const element of elements) {
    if (element.type === 'node' && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
      coords.set(element.id, element);
    } else if (element.type === 'way' && Array.isArray(element.nodes) && element.nodes.length >= 2) {
      ways.push(element);
    }
  }

  // Узел попадает в граф, только если он лежит хотя бы на одном пригодном пути.
  // Overpass отдаёт и узлы-теги (светофоры, магазины), они графу не нужны.
  const used = new Set();
  const accepted = [];

  for (const way of ways) {
    const access = wayAccess(way.tags || {});
    if (!access) continue;

    const nodes = way.nodes.filter((id) => coords.has(id));
    if (nodes.length < 2) continue;

    accepted.push({ nodes, access, speed: waySpeed(way.tags || {}) });
    for (const id of nodes) used.add(id);
  }

  const order = [...used];
  const indexOf = new Map(order.map((id, index) => [id, index]));
  const nodeCount = order.length;

  const lat = new Int32Array(nodeCount);
  const lon = new Int32Array(nodeCount);
  order.forEach((id, index) => {
    const node = coords.get(id);
    lat[index] = Math.round(node.lat * COORD_SCALE);
    lon[index] = Math.round(node.lon * COORD_SCALE);
  });

  // Два прохода: считаем степень каждого узла, затем раскладываем рёбра.
  const degree = new Uint32Array(nodeCount);
  const segments = [];

  for (const way of accepted) {
    for (let i = 0; i + 1 < way.nodes.length; i += 1) {
      const a = indexOf.get(way.nodes[i]);
      const b = indexOf.get(way.nodes[i + 1]);
      if (a === b) continue;

      const metres = Math.max(
        1,
        Math.round(
          metersBetween(
            lat[a] / COORD_SCALE, lon[a] / COORD_SCALE,
            lat[b] / COORD_SCALE, lon[b] / COORD_SCALE,
          ),
        ),
      );

      if (way.access.forward) { degree[a] += 1; segments.push([a, b, metres, way.speed, way.access.forward]); }
      if (way.access.backward) { degree[b] += 1; segments.push([b, a, metres, way.speed, way.access.backward]); }
    }
  }

  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i += 1) offsets[i + 1] = offsets[i] + degree[i];

  const edgeCount = offsets[nodeCount];
  const targets = new Uint32Array(edgeCount);
  const lengths = new Uint32Array(edgeCount);
  const speeds = new Uint8Array(edgeCount);
  const access = new Uint8Array(edgeCount);
  const cursor = new Uint32Array(nodeCount);

  for (const [from, to, metres, speed, mask] of segments) {
    const slot = offsets[from] + cursor[from];
    cursor[from] += 1;
    targets[slot] = to;
    lengths[slot] = metres;
    speeds[slot] = Math.min(255, speed);
    access[slot] = mask;
  }

  return {
    graph: { lat, lon, offsets, targets, lengths, speeds, access },
    stats: {
      osmNodes: coords.size,
      osmWays: ways.length,
      acceptedWays: accepted.length,
      nodeCount,
      edgeCount,
    },
  };
};

/**
 * Типы дорог, которые сборщик вообще умеет принимать.
 *
 * Список выводится из BASE_ACCESS, а не пишется отдельно: иначе запрос и
 * разбор разъедутся, и мы будем выкачивать то, что потом молча отбрасываем.
 * Белый список в запросе заметно сокращает объём ответа — в городской
 * выгрузке хватает путей, к маршрутизации отношения не имеющих
 * (платформы, коридоры, строящиеся дороги, трассы для гонок).
 */
export const ROUTABLE_HIGHWAY_TYPES = Object.freeze(Object.keys(BASE_ACCESS));

/**
 * Запрос к Overpass за дорожной сетью в рамке.
 *
 * ВАЖНО ПРО ФОРМУ ВЫВОДА. Здесь два оператора вывода, и это не избыточность:
 *
 *   out body;   — пути ВМЕСТЕ С ТЕГАМИ;
 *   >;          — рекурсия вниз, к узлам этих путей;
 *   out skel qt; — узлы без тегов, только координаты.
 *
 * Соблазнительно написать один `out skel qt` на всё — и получить ответ,
 * который выглядит полным: узлы на месте, пути на месте, размер правдоподобный.
 * Но `skel` выбрасывает теги, а без highway, maxspeed и oneway путь для графа
 * бесполезен: сборщик отвергнет все до единого и молча выдаст пустой граф.
 * Именно эта ошибка здесь и была.
 *
 * @param {[number, number, number, number]} bbox [south, west, north, east]
 */
export const buildOverpassQuery = ([south, west, north, east]) => `[out:json][timeout:180];
way["highway"~"^(${ROUTABLE_HIGHWAY_TYPES.join('|')})$"](${south},${west},${north},${east});
out body;
>;
out skel qt;`;
