/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ключ для секретов второго фактора: секреты TOTP хранятся в базе
 * зашифрованными (AES-256-GCM), резервные коды — как HMAC-SHA-256 с этим
 * ключом. Утечка одной базы (копия, бэкап) не даёт ни секретов TOTP, ни
 * возможности перебрать резервные коды офлайн.
 *
 * Откуда ключ:
 *   1) MFA_SECRET_KEY — 32 байта в base64, base64url или hex (рекомендуется
 *      для production: ключ хранится отдельно от базы);
 *   2) иначе — файл secrets/mfa.key рядом с базой аккаунтов (создаётся сам,
 *      права 0600). Удобно, но ключ лежит на том же диске, что и база:
 *      резервная копия должна включать файл, иначе TOTP-факторы станут
 *      неработающими (останутся passkeys и резервные коды — их тоже нет,
 *      значит только процедура восстановления через CLI).
 * Ключ никогда не пишется в журнал и не отдаётся в API.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_BYTES = 32;

/** 32 байта из строки base64 / base64url / hex или null. */
export const parseKey = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(text)) candidates.push(Buffer.from(text, 'hex'));
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) candidates.push(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return candidates.find((buffer) => buffer.length === KEY_BYTES) || null;
};

/**
 * @param {object} options
 * @param {object} [options.env]
 * @param {string|null} [options.keyFile] путь к файлу ключа (null — без файла, только окружение или ключ в памяти)
 * @returns {{key: Buffer, source: 'env'|'file'|'memory'}}
 */
export const loadMfaKey = ({ env = process.env, keyFile = null } = {}) => {
  if (env.MFA_SECRET_KEY) {
    const key = parseKey(env.MFA_SECRET_KEY);
    if (!key) throw new Error('MFA_SECRET_KEY: нужен ключ из 32 байт (base64 или hex), например `openssl rand -base64 32`.');
    return { key, source: 'env' };
  }
  if (!keyFile) return { key: randomBytes(KEY_BYTES), source: 'memory' };
  try {
    const existing = parseKey(fs.readFileSync(keyFile, 'utf8'));
    if (existing) return { key: existing, source: 'file' };
    throw new Error('MFA key file is damaged');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  // wx — не перезаписать ключ, созданный параллельно другим процессом.
  try {
    fs.writeFileSync(keyFile, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') return { key: parseKey(fs.readFileSync(keyFile, 'utf8')), source: 'file' };
    throw error;
  }
  return { key, source: 'file' };
};

/** Шифрование секрета: v1.iv.tag.ciphertext (base64url), associated data — назначение и id. */
export const createSecretBox = (key) => {
  const encKey = createHmac('sha256', key).update('medkarta:mfa:enc:v1').digest();
  const macKey = createHmac('sha256', key).update('medkarta:mfa:mac:v1').digest();
  return Object.freeze({
    seal(plain, aad = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const data = Buffer.concat([cipher.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },
    /** Расшифровать или null (чужой ключ, испорченные данные, другая aad). */
    open(sealed, aad = '') {
      try {
        const [version, iv, tag, data] = String(sealed).split('.');
        if (version !== 'v1') return null;
        const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
      } catch {
        return null;
      }
    },
    /** HMAC для значений, которые нужно только сравнивать (резервные коды). */
    mac: (value) => createHmac('sha256', macKey).update(String(value), 'utf8').digest('hex'),
  });
};

/** Ключ процесса для писем со ссылками в очереди: живёт только в памяти. */
export const createEphemeralBox = () => {
  const box = createSecretBox(randomBytes(KEY_BYTES));
  return { box, keyId: randomBytes(8).toString('hex') };
};
