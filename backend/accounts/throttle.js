/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Защита от подбора пароля и credential stuffing — счётчики в SQLite
 * (таблица auth_throttle): они переживают перезапуск и общие для всех
 * процессов на этом сервере. Для нескольких серверов нужен общий стор
 * (см. docs/08-security.md).
 *
 * Пять независимых счётчиков неудачных попыток за 15 минут:
 *
 *   ip       — сеть /24 (IPv4) или /64 (IPv6). 30 ошибок или 20 разных
 *              аккаунтов с одного адреса — блок адреса на 30 минут, дальше
 *              вдвое дольше, до 2 часов. Это перебор многих аккаунтов одним
 *              списком (credential stuffing).
 *   ipacct   — пара «адрес + аккаунт». 5 ошибок — пауза 1 минута, дальше
 *              вдвое дольше, до часа: перебор одного аккаунта с одного места.
 *   acct     — аккаунт, но только для устройств, с которых в него ещё не
 *              входили. 10 ошибок (настройка auth.maxFailedPerEmail) — вход с
 *              незнакомых устройств закрыт на 15 минут, дальше до часа:
 *              распределённый перебор с многих адресов.
 *   dev      — пара «доверенное устройство + аккаунт»: 10 ошибок — 15 минут.
 *   mfa      — неверные коды второго фактора для аккаунта: 10 — 15 минут.
 *
 * Почему acct действует только на незнакомые устройства: иначе любой мог
 * бы, отправляя неверные пароли, бесконечно держать чужой аккаунт (в том
 * числе суперадминистратора) закрытым. Устройство, с которого владелец уже
 * входил, несёт cookie mk_device (случайный токен, в базе — SHA-256) и
 * проверяется своим счётчиком dev — его чужие ошибки не трогают (OWASP:
 * «device cookies»).
 *
 * В ключах нет ни email, ни адреса: только усечённые SHA-256.
 */

import { createHash } from 'node:crypto';

import { rateLimitKey } from '../http/rateLimit.js';

const MINUTE = 60 * 1000;
const WINDOW_MS = 15 * MINUTE;

const sha = (value, length = 32) => createHash('sha256').update(String(value)).digest('hex').slice(0, length);

export const emailKey = (email) => sha(`email:${String(email || '').trim().toLowerCase()}`);
export const ipKeyOf = (ip) => sha(`ip:${rateLimitKey(ip)}`, 24);

const DEFAULT_RULES = Object.freeze({
  ip: { threshold: 30, baseMs: 30 * MINUTE, maxMs: 120 * MINUTE, distinctAccounts: 20 },
  ipacct: { threshold: 5, baseMs: 1 * MINUTE, maxMs: 60 * MINUTE },
  acct: { threshold: 10, baseMs: 15 * MINUTE, maxMs: 60 * MINUTE },
  dev: { threshold: 10, baseMs: 15 * MINUTE, maxMs: 15 * MINUTE },
  mfa: { threshold: 10, baseMs: 15 * MINUTE, maxMs: 15 * MINUTE },
});

/**
 * @param {object} deps
 * @param {object} deps.store хранилище с getThrottle/putThrottle
 * @param {object} [deps.settings] настройки (порог acct — auth.maxFailedPerEmail)
 * @param {() => number} [deps.now]
 */
export const createLoginThrottle = ({ store, settings = null, now = () => Date.now(), rules = {} } = {}) => {
  const ruleOf = (scope) => {
    const rule = { ...DEFAULT_RULES[scope], ...(rules[scope] || {}) };
    if (scope === 'acct' && settings && !rules.acct?.threshold) {
      try {
        rule.threshold = settings.get('auth.maxFailedPerEmail');
      } catch {
        // Настройки недоступны — порог по умолчанию.
      }
    }
    return rule;
  };

  const keyFor = (scope, parts) => {
    switch (scope) {
      case 'ip': return `ip:${parts.ipKey}`;
      case 'ipacct': return `ipacct:${parts.ipKey}|${parts.accountKey}`;
      case 'acct': return `acct:${parts.accountKey}`;
      case 'dev': return `dev:${parts.deviceKey}|${parts.accountKey}`;
      case 'mfa': return `mfa:${parts.accountKey}`;
      default: throw new Error(`unknown scope ${scope}`);
    }
  };

  const lockedFor = (row, stamp) => (row?.lockedUntil && row.lockedUntil > stamp ? Math.ceil((row.lockedUntil - stamp) / 1000) : 0);

  /** Активна ли блокировка в этом счётчике; секунд до конца или 0. */
  const lockOf = (scope, parts) => lockedFor(store.getThrottle(keyFor(scope, parts)), now());

  /** Засчитать ошибку; вернуть true, если именно сейчас включилась блокировка. */
  const bump = (scope, parts, { distinct = null } = {}) => {
    const key = keyFor(scope, parts);
    const rule = ruleOf(scope);
    const stamp = now();
    const row = store.getThrottle(key);
    const fresh = !row || stamp - row.windowStart >= WINDOW_MS;
    let failures = (fresh ? 0 : row.failures) + 1;
    const windowStart = fresh ? stamp : row.windowStart;
    // Серия блокировок «забывается» через сутки без новых блокировок.
    let lockCount = row && row.updatedAt > stamp - 24 * 60 * MINUTE ? row.lockCount : 0;
    let lockedUntil = row?.lockedUntil && row.lockedUntil > stamp ? row.lockedUntil : null;
    let data = fresh ? null : row.data;
    let lockedNow = false;
    if (distinct) {
      const seen = new Set(data?.seen || []);
      seen.add(distinct.slice(0, 12));
      data = { seen: [...seen].slice(-50) };
    }
    const distinctHit = scope === 'ip' && (data?.seen?.length || 0) >= rule.distinctAccounts;
    if (!lockedUntil && (failures >= rule.threshold || distinctHit)) {
      lockedUntil = stamp + Math.min(rule.baseMs * 2 ** lockCount, rule.maxMs);
      lockCount += 1;
      failures = 0;
      data = null;
      lockedNow = true;
    }
    store.putThrottle({ key, failures, windowStart: lockedNow ? stamp : windowStart, lockedUntil, lockCount, data, now: stamp });
    return lockedNow;
  };

  const clear = (scope, parts) => store.deleteThrottle(keyFor(scope, parts));

  return Object.freeze({
    keys: { emailKey, ipKeyOf },

    /**
     * Можно ли сейчас проверять пароль. parts: {ipKey, accountKey, deviceKey|null}.
     * С доверенного устройства аккаунтная блокировка (acct) не действует —
     * только его собственный счётчик.
     */
    check(parts) {
      const checks = [['ip', 'ip'], ['ipacct', 'ipacct'], parts.deviceKey ? ['dev', 'device'] : ['acct', 'account']];
      for (const [scope, label] of checks) {
        const seconds = lockOf(scope, parts);
        if (seconds > 0) return { allowed: false, retryAfterSeconds: seconds, scope: label };
      }
      return { allowed: true, retryAfterSeconds: 0, scope: null };
    },

    /** Неверный пароль. accountLocked — включилась блокировка аккаунта для незнакомых устройств. */
    recordFailure(parts) {
      bump('ip', parts, { distinct: parts.accountKey });
      bump('ipacct', parts);
      const accountLocked = parts.deviceKey ? bump('dev', parts) : bump('acct', parts);
      return { accountLocked: !parts.deviceKey && accountLocked, deviceLocked: Boolean(parts.deviceKey) && accountLocked };
    },

    /** Успешный вход: сбросить счётчики этого места и устройства (аккаунтный — тоже: владелец вошёл). */
    recordSuccess(parts) {
      clear('ipacct', parts);
      if (parts.deviceKey) clear('dev', parts);
    },

    /* Второй фактор: свой счётчик на аккаунт. */
    mfaCheck: (accountKey) => {
      const seconds = lockOf('mfa', { accountKey });
      return { allowed: seconds === 0, retryAfterSeconds: seconds };
    },
    mfaFailure: (accountKey) => bump('mfa', { accountKey }),
    mfaSuccess: (accountKey) => clear('mfa', { accountKey }),

    /** Для админ-панели: ограничения входа в этот аккаунт сейчас. */
    accountStatus(accountKey) {
      const stamp = now();
      const account = store.getThrottle(`acct:${accountKey}`);
      const pairs = store.listThrottleBySuffix(`|${accountKey}`).filter((row) => row.key.startsWith('ipacct:') && row.lockedUntil > stamp);
      const mfa = store.getThrottle(`mfa:${accountKey}`);
      return {
        accountLockedUntil: account?.lockedUntil > stamp ? account.lockedUntil : null,
        recentFailures: account && stamp - account.windowStart < WINDOW_MS ? account.failures : 0,
        lockedPlaces: pairs.length,
        mfaLockedUntil: mfa?.lockedUntil > stamp ? mfa.lockedUntil : null,
      };
    },

    /** Снять ограничения входа в аккаунт (администратор, CLI). */
    clearAccount(accountKey) {
      let cleared = 0;
      cleared += Number(store.deleteThrottle(`acct:${accountKey}`));
      cleared += Number(store.deleteThrottle(`mfa:${accountKey}`));
      cleared += store.deleteThrottleBySuffix(`|${accountKey}`);
      return cleared;
    },

    /**
     * Простой постоянный счётчик событий (запросы регистрации и ссылок с
     * адреса): не больше limit за windowMs. Возвращает allowed и, если нет, —
     * сколько ждать.
     */
    consume(key, { limit, windowMs }) {
      const stamp = now();
      const row = store.getThrottle(`rate:${key}`);
      const fresh = !row || stamp - row.windowStart >= windowMs;
      const count = (fresh ? 0 : row.failures) + 1;
      if (!fresh && row.failures >= limit) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.windowStart + windowMs - stamp) / 1000)) };
      }
      store.putThrottle({ key: `rate:${key}`, failures: count, windowStart: fresh ? stamp : row.windowStart, now: stamp });
      return { allowed: true, retryAfterSeconds: 0 };
    },

    purge: () => store.purgeThrottle(now() - 24 * 60 * MINUTE, now()),
  });
};
