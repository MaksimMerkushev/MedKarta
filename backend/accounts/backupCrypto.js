/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Шифрование резервных копий базы аккаунтов (npm run accounts -- backup
 * --encrypt). AES-256-GCM, ключ — BACKUP_ENCRYPTION_KEY (32 байта, base64
 * или hex), отдельный от MFA_SECRET_KEY: копия базы и ключ MFA не должны
 * храниться вместе, а ключ копий нужен там, где копии восстанавливают.
 *
 * Формат файла: «MKBAK1» (6 байт) | IV (12) | тег (16) | шифртекст.
 * Ассоциированные данные — заголовок: подмена версии формата видна.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { parseKey } from './secrets.js';

const MAGIC = Buffer.from('MKBAK1', 'ascii');

export const backupKeyFromEnv = (env = process.env) => {
  if (!env.BACKUP_ENCRYPTION_KEY) return null;
  const key = parseKey(env.BACKUP_ENCRYPTION_KEY);
  if (!key) throw new Error('BACKUP_ENCRYPTION_KEY: нужен ключ 32 байта (base64 или hex)');
  return key;
};

export const encryptBackup = (plain, key) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
};

export const isEncryptedBackup = (data) => data.length > MAGIC.length + 28 && data.subarray(0, MAGIC.length).equals(MAGIC);

export const decryptBackup = (data, key) => {
  if (!isEncryptedBackup(data)) throw new Error('не зашифрованная копия МедКарты');
  const iv = data.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = data.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(MAGIC.length + 28)), decipher.final()]);
};
