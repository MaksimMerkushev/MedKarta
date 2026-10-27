/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * QR-код для настройки приложения-аутентификатора (shared/qr.js): обратное
 * чтение матрицы (формат, маска, блоки Рида — Соломона, данные) и — если в
 * системе есть Python с OpenCV — распознавание настоящим декодером.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { __internals, encodeQr, qrSvgPath } from '../shared/qr.js';

const { createMatrix, rawDataModules, rsDivisor, rsRemainder, ECC_PER_BLOCK, BLOCKS, MASKS } = __internals;

/** Прочитать матрицу обратно: маска из формата, кодовые слова «змейкой», блоки, данные. */
const decode = ({ version, size, modules }) => {
  // Формат (первая копия) → маска; уровень M.
  const bitAt = (y, x) => (modules[y][x] ? 1 : 0);
  const formatBits = [0, 1, 2, 3, 4, 5].map((i) => bitAt(i, 8)).concat([bitAt(7, 8), bitAt(8, 8), bitAt(8, 7)], [9, 10, 11, 12, 13, 14].map((i) => bitAt(8, 14 - i)));
  const raw = formatBits.reduce((acc, bit, index) => acc | (bit << index), 0) ^ 0x5412;
  const level = raw >>> 13;
  const mask = (raw >>> 10) & 7;
  assert.equal(level, 0, 'уровень коррекции M');
  // Вторая копия формата совпадает с первой.
  const second = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => bitAt(8, size - 1 - i)).concat([8, 9, 10, 11, 12, 13, 14].map((i) => bitAt(size - 15 + i, 8)));
  assert.deepEqual(second, formatBits);
  const { reserved } = createMatrix(version);
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!reserved[y][x]) bits.push(modules[y][x] !== MASKS[mask](x, y) ? 1 : 0);
      }
    }
  }
  const total = Math.floor(rawDataModules(version) / 8);
  const codewords = [];
  for (let i = 0; i < total; i += 1) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  // Разбор чередования на блоки и проверка коррекции.
  const blockCount = BLOCKS[version - 1];
  const eccLength = ECC_PER_BLOCK[version - 1];
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount);
  const blocks = Array.from({ length: blockCount }, (_, i) => ({ data: [], ecc: [], dataLength: shortLength - eccLength + (i < shortBlocks ? 0 : 1) }));
  let index = 0;
  for (let i = 0; i < shortLength - eccLength + 1; i += 1) {
    blocks.forEach((block) => {
      if (i < block.dataLength) block.data.push(codewords[index++]);
    });
  }
  for (let i = 0; i < eccLength; i += 1) blocks.forEach((block) => block.ecc.push(codewords[index++]));
  const divisor = rsDivisor(eccLength);
  for (const block of blocks) assert.deepEqual(rsRemainder(block.data, divisor), block.ecc, 'коррекция блока сходится');
  const data = blocks.flatMap((block) => block.data);
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((shift) => (byte >>> shift) & 1));
  const read = (offset, length) => stream.slice(offset, offset + length).reduce((acc, bit) => (acc << 1) | bit, 0);
  assert.equal(read(0, 4), 0b0100, 'байтовый режим');
  const countBits = version <= 9 ? 8 : 16;
  const length = read(4, countBits);
  const bytes = Array.from({ length }, (_, i) => read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
};

const SAMPLES = [
  'A',
  'https://navimed.tech',
  'Привет, МедКарта!',
  'otpauth://totp/%D0%9C%D0%B5%D0%B4%D0%9A%D0%B0%D1%80%D1%82%D0%B0%3Aanna%40example.ru?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=%D0%9C%D0%B5%D0%B4%D0%9A%D0%B0%D1%80%D1%82%D0%B0&algorithm=SHA1&digits=6&period=30',
  'x'.repeat(300),
  'y'.repeat(600),
];

describe('QR-код (shared/qr.js)', () => {
  it('матрица читается обратно: формат, маска, коррекция и данные сходятся', () => {
    for (const text of SAMPLES) {
      const qr = encodeQr(text);
      assert.equal(qr.size, qr.version * 4 + 17);
      assert.equal(decode(qr), text, `версия ${qr.version}`);
    }
  });

  it('версия растёт с длиной; слишком длинный текст — ошибка, а не обрезка', () => {
    assert.equal(encodeQr('A').version, 1);
    assert.ok(encodeQr('y'.repeat(600)).version >= 19);
    assert.throws(() => encodeQr('z'.repeat(1000)), RangeError);
  });

  it('путь SVG: по квадрату на тёмный модуль, с полем тишины', () => {
    const qr = encodeQr('A');
    const dark = qr.modules.flat().filter(Boolean).length;
    const path = qrSvgPath(qr);
    assert.equal(path.split('M').length - 1, dark);
    assert.match(path, /^M4 4h1v1h-1z/, 'левый верхний угол поискового узора — после поля в 4 модуля');
  });

  it('распознаётся настоящим декодером (OpenCV), если он установлен', (t) => {
    const probe = spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' });
    if (probe.status !== 0) {
      t.skip('нет python3 с OpenCV');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-qr-'));
    const files = SAMPLES.map((text, index) => {
      const qr = encodeQr(text);
      const scale = 6;
      const quiet = 4;
      const n = (qr.size + quiet * 2) * scale;
      const pixels = Buffer.alloc(n * n, 255);
      for (let y = 0; y < qr.size; y += 1) {
        for (let x = 0; x < qr.size; x += 1) {
          if (!qr.modules[y][x]) continue;
          for (let dy = 0; dy < scale; dy += 1) pixels.fill(0, ((y + quiet) * scale + dy) * n + (x + quiet) * scale, ((y + quiet) * scale + dy) * n + (x + quiet + 1) * scale);
        }
      }
      const file = path.join(dir, `qr-${index}.pgm`);
      fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5 ${n} ${n} 255\n`), pixels]));
      return file;
    });
    const script = [
      'import cv2, json, sys',
      'detectors = [cv2.QRCodeDetector()] + ([cv2.QRCodeDetectorAruco()] if hasattr(cv2, "QRCodeDetectorAruco") else [])',
      'out = []',
      'for f in sys.argv[1:]:',
      '    img = cv2.imread(f, cv2.IMREAD_GRAYSCALE)',
      '    found = ""',
      '    for d in detectors:',
      '        found = d.detectAndDecode(img)[0]',
      '        if found: break',
      '    out.append(found)',
      'print(json.dumps(out))',
    ].join('\n');
    const decoded = JSON.parse(execFileSync('python3', ['-c', script, ...files], { encoding: 'utf8' }));
    assert.deepEqual(decoded, SAMPLES);
  });
});
