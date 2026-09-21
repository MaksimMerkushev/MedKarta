/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Бинарный формат дорожного графа.
 *
 * ПОЧЕМУ СВОЙ ФОРМАТ, А НЕ ГОТОВЫЙ ДВИЖОК. Сервер — одно ядро и 2 ГБ.
 * OSRM держит в памяти обработанный граф и при подготовке данных требует
 * кратно больше оперативной памяти, чем весит исходный экстракт; GraphHopper
 * тянет JVM с собственной кучей. Оба съели бы половину сервера ради задачи,
 * которая для города решается несколькими мегабайтами типизированных массивов.
 *
 * Граф хранится в CSR (compressed sparse row): массив смещений по узлам плюс
 * плоские массивы рёбер. Это даёт обход соседей без единой аллокации в цикле
 * поиска — на слабом процессоре сборщик мусора вредит больше, чем сам алгоритм.
 *
 * Все величины целочисленные: координаты в стотысячных долях градуса,
 * длина в метрах, скорость в км/ч. Ни одного числа с плавающей точкой
 * в горячем пути.
 */

export const MAGIC = 0x314b_4d47; // 'GMK1'
export const FORMAT_VERSION = 1;

/** Координаты хранятся как целые: градусы × 1e6 (точность ≈ 11 см). */
export const COORD_SCALE = 1e6;

/** Биты доступности ребра по профилям. */
export const ACCESS = Object.freeze({
  CAR: 1 << 0,
  FOOT: 1 << 1,
  BIKE: 1 << 2,
});

/**
 * Профили передвижения.
 *
 * maxSpeedKmh задаёт допустимую эвристику A*: она обязана НЕ ПЕРЕОЦЕНИВАТЬ
 * оставшееся время, иначе алгоритм перестаёт гарантировать оптимальный путь.
 * Поэтому здесь верхняя граница скорости по профилю, а не средняя.
 */
export const PROFILES = Object.freeze({
  driving: { access: ACCESS.CAR, maxSpeedKmh: 90, fallbackSpeedKmh: 40 },
  foot: { access: ACCESS.FOOT, maxSpeedKmh: 6, fallbackSpeedKmh: 4.8 },
  bike: { access: ACCESS.BIKE, maxSpeedKmh: 22, fallbackSpeedKmh: 15 },
});

export const PROFILE_NAMES = Object.freeze(Object.keys(PROFILES));

/**
 * Раскладка файла.
 *
 * ┌──────────────┬─────────────────────────────────────────────┐
 * │ заголовок    │ 64 байта                                    │
 * │ lat          │ Int32   × nodeCount   (градусы × 1e6)        │
 * │ lon          │ Int32   × nodeCount                          │
 * │ offsets      │ Uint32  × (nodeCount + 1)                    │
 * │ targets      │ Uint32  × edgeCount                          │
 * │ lengths      │ Uint32  × edgeCount   (метры)                │
 * │ speeds       │ Uint8   × edgeCount   (км/ч для авто)        │
 * │ access       │ Uint8   × edgeCount   (битовая маска)        │
 * └──────────────┴─────────────────────────────────────────────┘
 *
 * Секции выровнены по 4 байта: без выравнивания создание типизированного
 * представления поверх буфера бросает исключение на некоторых платформах.
 */
export const HEADER_BYTES = 64;

const align4 = (value) => (value + 3) & ~3;

export const computeLayout = (nodeCount, edgeCount) => {
  let offset = HEADER_BYTES;
  const section = (bytes) => {
    const start = offset;
    offset = align4(offset + bytes);
    return start;
  };

  const layout = {
    lat: section(nodeCount * 4),
    lon: section(nodeCount * 4),
    offsets: section((nodeCount + 1) * 4),
    targets: section(edgeCount * 4),
    lengths: section(edgeCount * 4),
    speeds: section(edgeCount * 1),
    access: section(edgeCount * 1),
  };
  layout.totalBytes = offset;
  return layout;
};

/**
 * Собирает файл графа.
 *
 * @param {object} graph
 * @param {Int32Array} graph.lat
 * @param {Int32Array} graph.lon
 * @param {Uint32Array} graph.offsets
 * @param {Uint32Array} graph.targets
 * @param {Uint32Array} graph.lengths
 * @param {Uint8Array} graph.speeds
 * @param {Uint8Array} graph.access
 * @returns {Buffer}
 */
export const encodeGraph = ({ lat, lon, offsets, targets, lengths, speeds, access }) => {
  const nodeCount = lat.length;
  const edgeCount = targets.length;
  const layout = computeLayout(nodeCount, edgeCount);

  const buffer = Buffer.alloc(layout.totalBytes);
  buffer.writeUInt32LE(MAGIC, 0);
  buffer.writeUInt32LE(FORMAT_VERSION, 4);
  buffer.writeUInt32LE(nodeCount, 8);
  buffer.writeUInt32LE(edgeCount, 12);
  buffer.writeUInt32LE(COORD_SCALE, 16);

  const write = (typed, start) => {
    Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).copy(buffer, start);
  };

  write(lat, layout.lat);
  write(lon, layout.lon);
  write(offsets, layout.offsets);
  write(targets, layout.targets);
  write(lengths, layout.lengths);
  write(speeds, layout.speeds);
  write(access, layout.access);

  return buffer;
};

/**
 * Разбирает файл графа БЕЗ копирования: типизированные массивы указывают
 * в тот же буфер. Для 30-мегабайтного графа это разница между 30 и 60 МБ.
 *
 * @param {Buffer|ArrayBuffer} source
 */
export const decodeGraph = (source) => {
  const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('graph file is truncated');
  }
  if (buffer.readUInt32LE(0) !== MAGIC) {
    throw new Error('not a MedКарта graph file');
  }

  const version = buffer.readUInt32LE(4);
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported graph version ${version}`);
  }

  const nodeCount = buffer.readUInt32LE(8);
  const edgeCount = buffer.readUInt32LE(12);
  const layout = computeLayout(nodeCount, edgeCount);

  if (buffer.byteLength < layout.totalBytes) {
    throw new Error('graph file is shorter than its header claims');
  }

  const view = (Type, start, length) =>
    new Type(buffer.buffer, buffer.byteOffset + start, length);

  return {
    nodeCount,
    edgeCount,
    lat: view(Int32Array, layout.lat, nodeCount),
    lon: view(Int32Array, layout.lon, nodeCount),
    offsets: view(Uint32Array, layout.offsets, nodeCount + 1),
    targets: view(Uint32Array, layout.targets, edgeCount),
    lengths: view(Uint32Array, layout.lengths, edgeCount),
    speeds: view(Uint8Array, layout.speeds, edgeCount),
    access: view(Uint8Array, layout.access, edgeCount),
    byteLength: layout.totalBytes,
  };
};
