/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Хэши паролей: scrypt из node:crypto, без внешних зависимостей.
 *
 * Формат строки: scrypt$N$r$p$соль$хэш (base64url). Параметры хранятся
 * вместе с хэшем — их можно усилить позже, не ломая старые пароли.
 * scrypt считается в пуле потоков libuv и не блокирует сервер с одним ядром.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32 });
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_LIMITS = Object.freeze({ MIN: 8, MAX: 128 });

const scrypt = (password, salt, { N, r, p, keylen }) =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, { N, r, p, maxmem: MAX_MEMORY }, (error, key) => (error ? reject(error) : resolve(key)));
  });

/*
 * Не больше двух расчётов scrypt одновременно и не больше 32 в очереди.
 * Каждый — ~60 мс и 16 МБ; без потолка поток входов со многих адресов занял бы
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
  const key = await withSlot(() => scrypt(String(password), salt, PARAMS));
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
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
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Чужие параметры из базы не должны превращать проверку в отказ в обслуживании.
  if (![N, r, p].every(Number.isInteger) || N > 1 << 17 || r > 16 || p > 4) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (expected.length < 16 || expected.length > 64) return false;
  let actual;
  try {
    actual = await withSlot(() => scrypt(String(password), salt, { N, r, p, keylen: expected.length }));
  } catch (error) {
    // «Занято» — не «неверный пароль»: пользователь должен узнать, что надо подождать.
    if (error instanceof PasswordBusyError) throw error;
    return false;
  }
  return timingSafeEqual(actual, expected) && typeof stored === 'string' && stored.length > 0;
};

// Самые частые пароли из утечек — их подбирают первыми. Список короткий:
// это отсечение очевидного, а не замена лимитам.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'qwertyui', 'qwerty123', 'qwertyuiop', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4',
  'iloveyou', 'abcdefgh', 'abc12345', 'asdfghjk', 'zxcvbnm1', 'zaq12wsx', 'admin123', 'welcome1', 'letmein1',
  'йцукенгш', 'пароль123', 'qazwsxedc', 'aaaaaaaa', 'medkarta', 'medkarta1', 'medkarta123', 'kazan2026',
]);

/** Пустая строка — пароль подходит; иначе — что не так, по-русски. */
export const passwordProblem = (password) => {
  if (typeof password !== 'string') return 'Введите пароль.';
  if (password.length < PASSWORD_LIMITS.MIN) return `Пароль — не короче ${PASSWORD_LIMITS.MIN} символов.`;
  if (password.length > PASSWORD_LIMITS.MAX) return `Пароль — не длиннее ${PASSWORD_LIMITS.MAX} символов.`;
  if (/^\d+$/.test(password)) return 'Пароль не должен состоять только из цифр.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Этот пароль слишком распространён — его подбирают первым.';
  if (/^(.)\1+$/u.test(password)) return 'Пароль из одного повторяющегося символа слишком простой.';
  return '';
};
