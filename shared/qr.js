/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * QR-код (ISO/IEC 18004, модель 2) без зависимостей: байтовый режим,
 * уровень коррекции M, версии 1–20 (до ~660 байт). Нужен для настройки
 * приложения-аутентификатора: ссылка otpauth:// с секретом не должна уходить
 * на сторонние сервисы генерации картинок — код рисуется прямо на странице.
 *
 * Алгоритм — стандартный: данные → блоки Рида — Соломона (GF(256), 0x11D) →
 * чередование → размещение «змейкой» → лучшая из 8 масок по штрафам →
 * служебная информация (формат, версия). Проверяется декодером OpenCV в
 * tests/qr.test.js.
 */

const MAX_VERSION = 20;
// Уровень M: кодовых слов коррекции на блок и число блоков (версии 1–20).
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
const ECC_LEVEL_BITS_M = 0b00;

/* ------------------------------ GF(256) ------------------------------ */

const multiply = (x, y) => {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
};

/** Делитель Рида — Соломона степени degree: корни α^0 … α^(degree−1). */
const rsDivisor = (degree) => {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
};

const rsRemainder = (data, divisor) => {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coef, index) => {
      result[index] ^= multiply(coef, factor);
    });
  }
  return result;
};

/* ------------------------------ размеры ------------------------------ */

const alignmentPositions = (version) => {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
};

/** Модулей под данные и коррекцию (без служебных узоров). */
const rawDataModules = (version) => {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    result -= (25 * count - 10) * count - 55;
    if (version >= 7) result -= 36;
  }
  return result;
};

const dataCodewords = (version) => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version - 1] * BLOCKS[version - 1];

/* ------------------------------ данные ------------------------------ */

const utf8 = (text) => Array.from(new TextEncoder().encode(String(text)));

/** Битовый поток: режим «байты», длина, данные, терминатор и заполнители. */
const encodeData = (bytes, version) => {
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((byte) => put(byte, 8));
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  return codewords;
};

/** Блоки с коррекцией и чередование (сначала данные по столбцам, потом коррекция). */
const addEcc = (data, version) => {
  const blockCount = BLOCKS[version - 1];
  const eccLength = ECC_PER_BLOCK[version - 1];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks = [];
  for (let i = 0, offset = 0; i < blockCount; i += 1) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    const ecc = rsRemainder(chunk, divisor);
    if (i < shortBlocks) chunk.push(null);
    blocks.push([...chunk, ...ecc]);
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, index) => {
      if (i !== shortLength - eccLength || index >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
};

/* ------------------------------ матрица ------------------------------ */

const PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const createMatrix = (version) => {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  // Синхронизирующие полосы.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Поисковые узоры с разделителями.
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, distance !== 2 && distance !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // Выравнивающие узоры.
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((ay, i) => {
    positions.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });
  // Место под формат (заполняется после выбора маски) и тёмный модуль.
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  set(8, size - 8, true);
  // Информация о версии (от 7).
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  return { size, modules, reserved };
};

const placeData = ({ size, modules, reserved }, codewords) => {
  let bit = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!reserved[y][x] && bit < total) {
          modules[y][x] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
          bit += 1;
        }
      }
    }
  }
};

const applyMask = ({ size, modules, reserved }, mask) => {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!reserved[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  }
};

const drawFormat = ({ size, modules }, mask) => {
  const data = (ECC_LEVEL_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bitAt = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) modules[i][8] = bitAt(i);
  modules[7][8] = bitAt(6);
  modules[8][8] = bitAt(7);
  modules[8][7] = bitAt(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bitAt(i);
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bitAt(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bitAt(i);
  modules[size - 8][8] = true;
};

/** Штраф по правилам стандарта: серии, блоки 2×2, «поисковые» узоры, баланс тёмных. */
const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

const penalty = ({ size, modules }) => {
  let result = 0;
  const at = (horizontal, line, index) => (index < 0 || index >= size ? false : horizontal ? modules[line][index] : modules[index][line]);
  for (const horizontal of [true, false]) {
    for (let line = 0; line < size; line += 1) {
      // Серии одного цвета длиной 5 и больше.
      let run = 1;
      for (let index = 1; index <= size; index += 1) {
        if (index < size && at(horizontal, line, index) === at(horizontal, line, index - 1)) {
          run += 1;
        } else {
          if (run >= 5) result += PENALTY.N1 + (run - 5);
          run = 1;
        }
      }
      // Похожие на поисковый узор 1:1:3:1:1 с четырьмя светлыми модулями сбоку (за краем — светлое поле).
      for (let start = -4; start < size; start += 1) {
        for (const pattern of FINDER_LIKE) {
          if (pattern.every((dark, offset) => at(horizontal, line, start + offset) === dark)) result += PENALTY.N3;
        }
      }
    }
  }
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += PENALTY.N2;
    }
  }
  let dark = 0;
  modules.forEach((row) => row.forEach((value) => {
    if (value) dark += 1;
  }));
  const total = size * size;
  result += Math.floor(Math.abs(dark * 100 / total - 50) / 5) * PENALTY.N4;
  return result;
};

/**
 * Закодировать текст. Возвращает {size, modules} — modules[y][x] = true для
 * тёмного модуля; поле тишины (4 модуля) добавляет тот, кто рисует.
 *
 * @param {string} text
 * @returns {{version: number, size: number, modules: boolean[][]}}
 */
export const encodeQr = (text) => {
  const bytes = utf8(text);
  let version = 1;
  while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) version += 1;
  if (version > MAX_VERSION) throw new RangeError('QR: слишком длинный текст');
  const codewords = addEcc(encodeData(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = createMatrix(version);
    placeData(matrix, codewords);
    applyMask(matrix, mask);
    drawFormat(matrix, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { score, matrix };
  }
  return { version, size: best.matrix.size, modules: best.matrix.modules };
};

/** Путь SVG (по модулю на клетку) — для <path d=…> в viewBox с полем тишины quiet. */
export const qrSvgPath = ({ size, modules }, quiet = 4) => {
  const parts = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return parts.join('');
};

/** Для тестов: обратное чтение матрицы и проверка блоков Рида — Соломона. */
export const __internals = Object.freeze({ createMatrix, rawDataModules, rsDivisor, rsRemainder, ECC_PER_BLOCK, BLOCKS, MASKS });
