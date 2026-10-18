/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Аватар: PNG, JPEG или WebP до 256 КБ и до 1024×1024. Тип определяется по
 * сигнатуре файла, а не по заявленному; из файла вырезаются метаданные
 * (EXIF с координатами съёмки, XMP, комментарии, ICC) — остаются только
 * фрагменты, нужные для отрисовки. SVG не принимается: это код, а не картинка.
 */

export const AVATAR_LIMITS = Object.freeze({ MAX_BYTES: 256 * 1024, MAX_SIDE: 1024, MIN_SIDE: 16 });

export class AvatarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AvatarError';
    this.code = 'bad_image';
  }
}

const fail = (message) => {
  throw new AvatarError(message);
};

const checkSize = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < AVATAR_LIMITS.MIN_SIDE || height < AVATAR_LIMITS.MIN_SIDE) {
    fail(`Картинка меньше ${AVATAR_LIMITS.MIN_SIDE}×${AVATAR_LIMITS.MIN_SIDE}.`);
  }
  if (width > AVATAR_LIMITS.MAX_SIDE || height > AVATAR_LIMITS.MAX_SIDE) {
    fail(`Картинка больше ${AVATAR_LIMITS.MAX_SIDE}×${AVATAR_LIMITS.MAX_SIDE}.`);
  }
};

/* --------------------------------- PNG ---------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Только то, без чего картинка не отрисуется правильно; текст, EXIF, время, анимация — вон.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA']);

const sanitizePng = (buffer) => {
  const parts = [PNG_SIGNATURE];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawEnd = false;
  let first = true;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (length > buffer.length || end > buffer.length || !/^[A-Za-z]{4}$/.test(type)) fail('Повреждённый PNG.');
    if (first) {
      if (type !== 'IHDR' || length !== 13) fail('Повреждённый PNG.');
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      first = false;
    }
    if (PNG_KEEP.has(type)) parts.push(buffer.subarray(offset, end));
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (first || !sawEnd || !parts.some((part) => part.length > 8 && part.toString('latin1', 4, 8) === 'IDAT')) fail('Повреждённый PNG.');
  checkSize(width, height);
  return { mime: 'image/png', data: Buffer.concat(parts), width, height };
};

/* --------------------------------- JPEG --------------------------------- */

const isSof = (marker) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
// APP0 (JFIF) и APP14 (Adobe: цветовое преобразование) нужны для отрисовки; прочие APPn и COM — метаданные.
const keepJpegSegment = (marker) => !((marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe);

const sanitizeJpeg = (buffer) => {
  const parts = [buffer.subarray(0, 2)];
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) fail('Повреждённый JPEG.');
    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    if (marker === undefined) fail('Повреждённый JPEG.');
    if (marker === 0xd9) {
      parts.push(Buffer.from([0xff, 0xd9]));
      if (!sawScan || !width) fail('Повреждённый JPEG.');
      checkSize(width, height);
      return { mime: 'image/jpeg', data: Buffer.concat(parts), width, height };
    }
    if (offset + 4 > buffer.length) fail('Повреждённый JPEG.');
    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buffer.length) fail('Повреждённый JPEG.');
    if (isSof(marker)) {
      if (length < 7) fail('Повреждённый JPEG.');
      height = buffer.readUInt16BE(offset + 5);
      width = buffer.readUInt16BE(offset + 7);
    }
    if (keepJpegSegment(marker)) parts.push(buffer.subarray(offset, end));
    offset = end;
    if (marker === 0xda) {
      // Данные скана — до следующего маркера (FF00 — экранированный байт, FFD0–FFD7 — рестарт).
      sawScan = true;
      let scan = offset;
      while (scan + 1 < buffer.length && !(buffer[scan] === 0xff && buffer[scan + 1] !== 0x00 && !(buffer[scan + 1] >= 0xd0 && buffer[scan + 1] <= 0xd7))) {
        scan += 1;
      }
      if (scan + 1 >= buffer.length) fail('Повреждённый JPEG.');
      parts.push(buffer.subarray(offset, scan));
      offset = scan;
    }
  }
  fail('Повреждённый JPEG.');
  return null;
};

/* --------------------------------- WebP --------------------------------- */

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH']);

const sanitizeWebp = (buffer) => {
  if (buffer.length < 20 || buffer.toString('latin1', 8, 12) !== 'WEBP') fail('Повреждённый WebP.');
  const declared = buffer.readUInt32LE(4) + 8;
  const limit = Math.min(declared, buffer.length);
  const chunks = [];
  let offset = 12;
  let width = 0;
  let height = 0;
  let hasImage = false;
  while (offset + 8 <= limit) {
    const type = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    const end = offset + 8 + padded;
    if (offset + 8 + size > buffer.length) fail('Повреждённый WebP.');
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (type === 'ANIM' || type === 'ANMF') fail('Анимированные картинки не подходят.');
    if (type === 'VP8X') {
      if (size < 10) fail('Повреждённый WebP.');
      if (body[0] & 0x02) fail('Анимированные картинки не подходят.');
      width = body.readUIntLE(4, 3) + 1;
      height = body.readUIntLE(7, 3) + 1;
      // Флаги ICC, EXIF и XMP снимаются: самих фрагментов больше нет.
      const flags = Buffer.from(body);
      flags[0] &= ~(0x20 | 0x08 | 0x04);
      chunks.push(Buffer.concat([buffer.subarray(offset, offset + 8), flags, size % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]));
    } else if (WEBP_KEEP.has(type)) {
      if (type === 'VP8 ') {
        if (size < 10 || body[3] !== 0x9d || body[4] !== 0x01 || body[5] !== 0x2a) fail('Повреждённый WebP.');
        width ||= body.readUInt16LE(6) & 0x3fff;
        height ||= body.readUInt16LE(8) & 0x3fff;
        hasImage = true;
      } else if (type === 'VP8L') {
        if (size < 5 || body[0] !== 0x2f) fail('Повреждённый WebP.');
        const bits = body.readUInt32LE(1);
        width ||= (bits & 0x3fff) + 1;
        height ||= ((bits >> 14) & 0x3fff) + 1;
        hasImage = true;
      }
      chunks.push(buffer.subarray(offset, Math.min(end, buffer.length)));
    }
    offset = end;
  }
  if (!hasImage) fail('Повреждённый WebP.');
  checkSize(width, height);
  const payload = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(payload.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { mime: 'image/webp', data: Buffer.concat([header, payload]), width, height };
};

/** Тип по сигнатуре: заявленный клиентом тип не учитывается. */
export const detectImageType = (buffer) => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

/**
 * data:image/…;base64,… → очищенная картинка {mime, data, width, height}.
 * Любая проблема — AvatarError с понятным сообщением.
 */
export const sanitizeAvatar = (dataUrl) => {
  if (typeof dataUrl !== 'string') fail('Нужна картинка.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) fail('Подходят только PNG, JPEG и WebP.');
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0) fail('Пустой файл.');
  if (buffer.length > AVATAR_LIMITS.MAX_BYTES) fail(`Файл больше ${AVATAR_LIMITS.MAX_BYTES / 1024} КБ.`);
  const type = detectImageType(buffer);
  if (!type) fail('Это не PNG, JPEG или WebP.');
  if (type === 'image/png') return sanitizePng(buffer);
  if (type === 'image/jpeg') return sanitizeJpeg(buffer);
  return sanitizeWebp(buffer);
};
