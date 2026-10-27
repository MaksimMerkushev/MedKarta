/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Хэши паролей: scrypt из node:crypto, без внешних зависимостей.
 *
 * Формат строки: scrypt2$N$r$p$соль$хэш (base64url) — пароль перед хэшем
 * нормализуется в NFKC (NIST SP 800-63B-4): «é» из двух кодовых точек и из
 * одной дают один и тот же хэш. Старый формат scrypt$… (без нормализации)
 * проверяется как раньше и при входе пересчитывается в новый (needsRehash):
 * миграция не требует знать пароли.
 *
 * Параметры хранятся вместе с хэшем — их можно усилить позже, не ломая
 * старые пароли. scrypt считается в пуле потоков libuv и не блокирует
 * сервер с одним ядром.
 *
 * Почему не Argon2id: в node:crypto Node 22 его нет (появился в Node 24.7),
 * а нативный модуль усложняет сборку на сервере. scrypt — функция с большим
 * расходом памяти из того же списка OWASP Password Storage Cheat Sheet;
 * N=2^15, r=8, p=3 — одна из рекомендованных OWASP настроек (32 МБ, ~0,3 с
 * на ядро). Перейти на Argon2id можно с новым префиксом в строке хэша и
 * пересчётом при входе — как сделан переход scrypt → scrypt2.
 */

import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

import { normalizePassword, PASSWORD_LIMITS } from '../../shared/passwordPolicy.js';

const PARAMS = Object.freeze({ N: 32768, r: 8, p: 3, keylen: 32 });
const MAX_MEMORY = 64 * 1024 * 1024;
const FORMAT = 'scrypt2';
const LEGACY_FORMAT = 'scrypt';
/*
 * Сколько единиц UTF-16 принимается на проверку: 256 символов пароля — это до
 * 512 единиц (символы вне BMP), с запасом. Длиннее — сразу «неверно», без
 * обрезки: обрезанный длинный пароль совпал бы с другим.
 */
export const MAX_PASSWORD_INPUT = 1024;

export { PASSWORD_LIMITS };

const scrypt = (password, salt, { N, r, p, keylen }) =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N, r, p, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });

/*
 * Не больше двух расчётов scrypt одновременно и не больше 32 в очереди.
 * Каждый — ~0,3 с и 32 МБ; без потолка поток входов со многих адресов занял бы
 * все потоки libuv, которыми пользуются и отдача файлов, и gzip.
 */
const MAX_PARALLEL = 2;
const MAX_QUEUE = 32;
let active = 0;
const waiting = [];

export class PasswordBusyError extends Error {
  constructor() {
    super('Слишком много входов одновременно.');
    this.name = 'PasswordBusyError';
  }
}

const withSlot = async (work) => {
  if (active >= MAX_PARALLEL) {
    if (waiting.length >= MAX_QUEUE) throw new PasswordBusyError();
    // Освободившийся слот передаётся ожидающему напрямую — счётчик не превышает потолок.
    await new Promise((resolve) => waiting.push(resolve));
  } else {
    active += 1;
  }
  try {
    return await work();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
};

export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await withSlot(() => scrypt(normalizePassword(String(password)), salt, PARAMS));
  return [FORMAT, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
};

/*
 * Хэш-«пустышка» для несуществующего email: проверка занимает столько же
 * времени, сколько настоящая, и по задержке нельзя узнать, зарегистрирован
 * ли адрес.
 */
let dummyHash = null;
const getDummyHash = async () => {
  dummyHash ||= await hashPassword(randomBytes(12).toString('base64url'));
  return dummyHash;
};

export const verifyPassword = async (password, stored) => {
  const target = typeof stored === 'string' && stored ? stored : await getDummyHash();
  const parts = target.split('$');
  if (parts.length !== 6 || (parts[0] !== FORMAT && parts[0] !== LEGACY_FORMAT)) return false;
  const input = typeof password === 'string' ? password : '';
  // Слишком длинный ввод — сразу «неверно», но после такой же работы (по времени не отличить).
  const tooLong = input.length > MAX_PASSWORD_INPUT;
  const candidate = tooLong ? '' : parts[0] === FORMAT ? normalizePassword(input) : input;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Чужие параметры из базы не должны превращать проверку в отказ в обслуживании.
  if (![N, r, p].every(Number.isInteger) || N > 1 << 17 || r > 16 || p > 8) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length < 16 || expected.length > 64) return false;
  let actual;
  try {
    actual = await withSlot(() => scrypt(candidate, salt, { N, r, p, keylen: expected.length }));
  } catch (error) {
    // «Занято» — не «неверный пароль»: пользователь должен узнать, что надо подождать.
    if (error instanceof PasswordBusyError) throw error;
    return false;
  }
  return timingSafeEqual(actual, expected) && !tooLong && typeof stored === 'string' && stored.length > 0;
};

// Правила пароля общие с интерфейсом: shared/passwordPolicy.js.
export { passwordChecks, passwordProblem } from '../../shared/passwordPolicy.js';

/** Хэш посчитан со старыми параметрами — при входе его стоит пересчитать. */
export const needsRehash = (stored) => {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  return parts[0] !== FORMAT || Number(parts[1]) !== PARAMS.N || Number(parts[2]) !== PARAMS.r || Number(parts[3]) !== PARAMS.p;
};

/*
 * Временный пароль: 20 знаков без похожих (0/O, 1/l/I), группами по 4 —
 * его диктуют и переписывают. ~116 бит энтропии, randomInt без смещения.
 */
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const generateTemporaryPassword = () => {
  const chars = Array.from({ length: 20 }, () => TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)]);
  return chars.join('').match(/.{4}/g).join('-');
};
