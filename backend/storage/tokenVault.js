/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Хранилище соответствий «session-токен → реальная сущность».
 *
 * ИНВАРИАНТ. Наружу уходит только токен вида @DOCTOR_A. Реальный UUID, ФИО,
 * адрес и координаты живут исключительно здесь, внутри доверенного контура.
 * Соответствие НЕ передаётся модели, НЕ попадает в ответ клиенту и
 * НЕ пишется в логи (см. observability/safeLogger.js — там стоит запрет).
 *
 * ЭТО ПСЕВДОНИМИЗАЦИЯ, А НЕ АНОНИМИЗАЦИЯ. Токен обратим при наличии доступа
 * к этому хранилищу, поэтому само хранилище — чувствительный актив с тем же
 * уровнем защиты, что и справочник. Утверждать на этом основании, что данные
 * «обезличены» в смысле 152-ФЗ, нельзя (см. docs/privacy-architecture.md).
 *
 * Изоляция сессий обеспечивается ключом: он выводится как HMAC от sessionId,
 * поэтому токен @DOCTOR_A одной сессии физически не разыменовывается в другой.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TTL_SECONDS = 900;

/** Верхняя граница числа токенов на сессию: защита от раздувания хранилища. */
export const MAX_TOKENS_PER_SESSION = 64;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Секрет для вывода ключей. При отсутствии переменной окружения берётся
 * случайный секрет процесса: соответствия тогда не переживают рестарт — это
 * менее удобно, но безопаснее предсказуемого ключа по умолчанию.
 */
const resolveSecret = () => {
  const configured = process.env.PRIVACY_TOKEN_SECRET;
  if (configured && configured.length >= 16) {
    return configured;
  }
  return randomBytes(32).toString('hex');
};

/** In-memory store. Подходит для dev и одиночного инстанса. */
export const createMemoryStore = ({ maxEntries = 50_000 } = {}) => {
  const entries = new Map();

  const prune = (now) => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  };

  return Object.freeze({
    name: 'memory',
    async set(key, value, ttlSeconds) {
      const now = Date.now();
      if (entries.size >= maxEntries) {
        prune(now);
      }
      /*
       * Переполнение после чистки просроченных — вытесняются самые старые
       * записи (Map хранит порядок вставки). Раньше здесь был отказ, и 261
       * запрос со множеством телефонов и ссылок выключал токенизацию для всех
       * пользователей на 15 минут. Свежие соответствия — то, что нужно
       * текущим запросам, — остаются.
       */
      for (const key of entries.keys()) {
        if (entries.size < maxEntries) break;
        entries.delete(key);
      }
      entries.set(key, { value, expiresAt: now + ttlSeconds * 1000 });
    },
    async get(key) {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async delete(key) {
      entries.delete(key);
    },
    /** Только для тестов: принудительное истечение TTL без ожидания. */
    __expireAll() {
      for (const entry of entries.values()) {
        entry.expiresAt = 0;
      }
    },
    get size() {
      return entries.size;
    },
  });
};

/**
 * Upstash Redis через REST. Выбран вместо клиентской библиотеки сознательно:
 * это обычный fetch, без новой npm-зависимости в security-критичном пути.
 */
export const createUpstashStore = ({ url, token, fetchImpl = fetch } = {}) => {
  if (!url || !token) {
    throw new Error('Upstash store requires url and token');
  }

  const base = url.replace(/\/+$/, '');
  const call = async (path) => {
    const response = await fetchImpl(`${base}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`upstash ${response.status}`);
    }
    const payload = await response.json();
    return payload?.result ?? null;
  };

  return Object.freeze({
    name: 'upstash',
    async set(key, value, ttlSeconds) {
      await call(`set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?EX=${ttlSeconds}`);
    },
    async get(key) {
      return call(`get/${encodeURIComponent(key)}`);
    },
    async delete(key) {
      await call(`del/${encodeURIComponent(key)}`);
    },
  });
};

/** Выбор бэкенда по окружению. По умолчанию — память. */
export const createStoreFromEnv = (env = process.env) => {
  const backend = (env.TOKEN_VAULT_BACKEND || 'memory').toLowerCase();
  if (backend === 'upstash' || backend === 'redis') {
    return createUpstashStore({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return createMemoryStore();
};

/**
 * @param {object} options
 * @param {object} [options.store] реализация с методами set/get/delete
 * @param {number} [options.ttlSeconds]
 * @param {string} [options.secret]
 */
export const createTokenVault = ({
  store = createMemoryStore(),
  ttlSeconds = Number(process.env.PRIVACY_TOKEN_TTL_SECONDS) || DEFAULT_TTL_SECONDS,
  secret = resolveSecret(),
} = {}) => {
  const sessionKey = (sessionId) =>
    createHmac('sha256', secret).update(`session:${sessionId}`).digest('hex').slice(0, 32);

  /*
   * Запрос — часть ключа. Токены нумеруются заново в каждом запросе, и два
   * одновременных запроса одной сессии (две вкладки) выдавали одинаковый
   * @DOCTOR_A разным врачам: второй перезаписывал первый, и маршрут первого
   * строился к врачу из второго. План исполняется в том же запросе, в
   * котором выданы токены, поэтому привязка к запросу ничего не ломает.
   */
  const requestKey = (requestId) =>
    requestId ? createHmac('sha256', secret).update(`request:${requestId}`).digest('hex').slice(0, 16) : '-';
  const storageKey = (sessionId, requestId, token) => `pv:${sessionKey(sessionId)}:${requestKey(requestId)}:${token}`;

  /**
   * Смещение алфавита для сессии. Один и тот же врач получает РАЗНЫЕ внешние
   * токены в разных сессиях — иначе внешняя сторона, наблюдая много запросов,
   * могла бы построить устойчивый псевдоним и связать сессии между собой.
   */
  const labelOffset = (sessionId) =>
    createHmac('sha256', secret).update(`label:${sessionId}`).digest()[0] % ALPHABET.length;

  const label = (sessionId, index) => {
    const shifted = (labelOffset(sessionId) + index) % (ALPHABET.length * ALPHABET.length);
    const high = Math.floor(shifted / ALPHABET.length);
    const low = shifted % ALPHABET.length;
    return high === 0 ? ALPHABET[low] : `${ALPHABET[high - 1]}${ALPHABET[low]}`;
  };

  return Object.freeze({
    ttlSeconds,
    storeName: store.name,

    /** Формирует текст токена без записи в хранилище (для предпросмотра). */
    formatToken(sessionId, kind, index) {
      return `@${kind}_${label(sessionId, index)}`;
    },

    /**
     * Записывает соответствие и возвращает токен.
     *
     * @param {object} params
     * @param {string} params.sessionId
     * @param {string} params.kind вид сущности (DOCTOR, CLINIC, PHONE, ...)
     * @param {number} params.index порядковый номер сущности этого вида в запросе
     * @param {object} params.value произвольные данные доверенного контура
     * @returns {Promise<string>} токен вида @DOCTOR_A
     */
    async mint({ sessionId, requestId, kind, index, value }) {
      if (!sessionId || !kind) {
        throw new Error('mint requires sessionId and kind');
      }
      if (index >= MAX_TOKENS_PER_SESSION) {
        throw new Error('too many tokens for one request');
      }

      const token = `@${kind}_${label(sessionId, index)}`;
      await store.set(storageKey(sessionId, requestId, token), JSON.stringify({ kind, value }), ttlSeconds);
      return token;
    },

    /**
     * Разыменование токена. Возвращает null, если токена нет, он истёк или
     * принадлежит другой сессии. Вызывающая сторона ОБЯЗАНА трактовать null
     * как отказ выполнения, а не как «пропустим этот шаг».
     */
    async resolve({ sessionId, requestId, token }) {
      if (!sessionId || typeof token !== 'string' || !token.startsWith('@')) {
        return null;
      }

      const raw = await store.get(storageKey(sessionId, requestId, token));
      if (!raw) {
        return null;
      }

      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    async revoke({ sessionId, requestId, token }) {
      await store.delete(storageKey(sessionId, requestId, token));
    },

    /** Сравнение идентификаторов сессии без утечки времени. */
    sameSession(left, right) {
      const a = Buffer.from(sessionKey(String(left)));
      const b = Buffer.from(sessionKey(String(right)));
      return a.length === b.length && timingSafeEqual(a, b);
    },
  });
};
