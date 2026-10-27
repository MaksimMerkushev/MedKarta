/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Одноразовые коды по времени (TOTP, RFC 6238): HMAC-SHA-1, 6 цифр, шаг
 * 30 секунд — так их понимают все приложения-аутентификаторы (Яндекс Ключ,
 * Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden).
 *
 * Код принимается из окна ±1 шаг (часы телефона могут отставать) и только
 * если его шаг новее последнего принятого (store.acceptTotpStep): один и тот
 * же код дважды не сработает.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP = Object.freeze({ DIGITS: 6, PERIOD_S: 30, WINDOW: 1, SECRET_BYTES: 20 });

export const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
};

export const base32Decode = (text) => {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error('bad base32');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

export const newTotpSecret = () => randomBytes(TOTP.SECRET_BYTES);

/** HOTP (RFC 4226) для счётчика: строка из DIGITS цифр. */
export const hotp = (secret, counter) => {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP.DIGITS).padStart(TOTP.DIGITS, '0');
};

export const stepAt = (ms) => Math.floor(ms / 1000 / TOTP.PERIOD_S);

export const totpAt = (secret, ms) => hotp(secret, stepAt(ms));

/** «123 456», «123-456» → «123456»; иначе null. */
export const cleanTotpCode = (value) => {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${TOTP.DIGITS}}$`).test(digits) ? digits : null;
};

/**
 * Шаг, которому соответствует код, или null. Сравнение — постоянное по
 * времени; шаги не новее lastStep не принимаются.
 */
export const matchTotp = (secret, code, { now = Date.now(), lastStep = null, window = TOTP.WINDOW } = {}) => {
  const clean = cleanTotpCode(code);
  if (!clean) return null;
  const current = stepAt(now);
  let matched = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(clean)) && matched === null) matched = step;
  }
  return matched;
};

/** Ссылка otpauth:// для QR-кода и для открытия приложения-аутентификатора на телефоне. */
export const otpauthUri = ({ secret, account, issuer = 'МедКарта' }) => {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(TOTP.DIGITS), period: String(TOTP.PERIOD_S) });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
};
