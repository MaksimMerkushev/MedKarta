/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Скользящее окно в памяти процесса: счётчики сбрасываются при перезапуске
 * и не общие для нескольких процессов. Для общего лимита на несколько
 * серверов нужен внешний стор (Upstash Redis) — см. SECURITY.md.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_PER_INSTANCE = 300;
const MAX_TRACKED_IPS = 20_000;

const prune = (list, now, windowMs) => list.filter((timestamp) => now - timestamp < windowMs);

/*
 * При переполнении вытесняются самые давние записи, а не вся карта: иначе
 * запросами с тысяч адресов можно обнулить счётчики всех клиентов, включая
 * свой. Map хранит порядок вставки, активные ключи переставляются в конец.
 */
const touch = (map, key, value, maxSize) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    map.delete(map.keys().next().value);
  }
};

/*
 * Ключ лимита. IPv6-адрес считается по сети /64: провайдер выдаёт клиенту
 * целую подсеть, и перебор адресов внутри неё обходил бы лимит «на адрес».
 */
export const rateLimitKey = (ip) => {
  const value = String(ip || 'unknown').toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (!value.includes(':')) return value;
  const [head, tail = ''] = value.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const full = [...left, ...Array(missing).fill('0'), ...right];
  return `${full.slice(0, 4).map((part) => part.replace(/^0+(?=.)/, '')).join(':')}::/64`;
};

/**
 * Независимый ограничитель со своим счётчиком: эндпоинтам нужны разные
 * бюджеты — вызов модели стоит денег, а маршрут дешёвый, но запрашивается
 * при каждом изменении точек на карте.
 */
export const createRateLimiter = ({
  windowMs = WINDOW_MS,
  maxPerIp = MAX_PER_IP,
  maxPerInstance = MAX_PER_INSTANCE,
  maxTrackedIps = MAX_TRACKED_IPS,
} = {}) => {
  const hits = new Map();
  let instanceHits = [];
  // Общий счётчик ведётся, только если потолок задан: фильтрация десятков
  // тысяч отметок на каждом запросе заметно замедляет даже дешёвые эндпоинты.
  const instanceCapped = Number.isFinite(maxPerInstance);

  return (address, now = Date.now()) => {
    const ip = rateLimitKey(address);
    if (instanceCapped) {
      instanceHits = prune(instanceHits, now, windowMs);
      if (instanceHits.length >= maxPerInstance) {
        return { allowed: false, retryAfterSeconds: 60, remaining: 0 };
      }
    }

    const previous = prune(hits.get(ip) || [], now, windowMs);
    if (previous.length >= maxPerIp) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - previous[0])) / 1000));
      touch(hits, ip, previous, maxTrackedIps);
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    previous.push(now);
    touch(hits, ip, previous, maxTrackedIps);
    if (instanceCapped) instanceHits.push(now);

    return { allowed: true, retryAfterSeconds: 0, remaining: maxPerIp - previous.length };
  };
};

/**
 * Лимит по затраченному времени процессора, а не по числу запросов: ядро одно,
 * маршрут считается в основном потоке, и тяжёлые запросы в пределах лимита по
 * числу всё равно останавливают сервер. У адреса «ведро» миллисекунд (1,5 с,
 * пополнение 50 мс/с); обычный маршрут стоит 5–30 мс.
 */
export const createCostLimiter = ({
  capacityMs = 1_500,
  refillMsPerSecond = 50,
  maxTrackedIps = MAX_TRACKED_IPS,
} = {}) => {
  const buckets = new Map();

  const level = (key, now) => {
    const bucket = buckets.get(key);
    if (!bucket) return capacityMs;
    return Math.min(capacityMs, bucket.level + ((now - bucket.at) / 1000) * refillMsPerSecond);
  };

  return Object.freeze({
    check(address, now = Date.now()) {
      const key = rateLimitKey(address);
      const available = level(key, now);
      if (available > 0) return { allowed: true, retryAfterSeconds: 0 };
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(-available / refillMsPerSecond) + 1) };
    },
    charge(address, costMs, now = Date.now()) {
      const key = rateLimitKey(address);
      touch(buckets, key, { level: level(key, now) - Math.max(0, costMs), at: now }, maxTrackedIps);
    },
  });
};

export const routeCpuLimiter = createCostLimiter();

/*
 * Бюджет процессора ассистента. Обычный запрос разбирается за 5–50 мс, а
 * реплики, подобранные под нечёткий поиск фамилий, — до 0,8 с. Ведро в 3 с
 * с пополнением 30 мс/с пропускает живой диалог и останавливает перебор.
 */
export const chatCpuLimiter = createCostLimiter({ capacityMs: 3_000, refillMsPerSecond: 30 });

/**
 * Общий предохранитель тяжёлой работы на весь процесс: лимиты «на адрес» не
 * спасают от многих адресов сразу, а ядро одно. Суммируется время маршрутов,
 * расчёта времени в пути и ассистента за последние windowMs; когда сумма
 * превышает долю окна, тяжёлые запросы получают 503 с Retry-After, а статика
 * и лёгкие эндпоинты продолжают отвечать.
 */
export const createLoadShedder = ({ windowMs = 10_000, maxShare = 0.6 } = {}) => {
  let entries = [];
  let total = 0;
  const trim = (now) => {
    while (entries.length > 0 && now - entries[0].at >= windowMs) {
      total -= entries.shift().ms;
    }
  };
  return Object.freeze({
    /*
     * share — доля для конкретного потребителя: ассистент отключается первым
     * (60 %), маршруты — при почти полной загрузке (85 %), чтобы перебор
     * запросов к ассистенту не ломал построение маршрутов.
     */
    allows(now = Date.now(), share = maxShare) {
      trim(now);
      return total < windowMs * share;
    },
    record(ms, now = Date.now()) {
      if (!(ms > 0)) return;
      trim(now);
      entries.push({ at: now, ms });
      total += ms;
    },
    retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 2000)),
  });
};

export const heavyWork = createLoadShedder();
export const ROUTING_LOAD_SHARE = 0.85;

// Бюджет маршрутизации шире: расчёт локальный, но идёт при каждом изменении точек.
export const checkRouteRateLimit = createRateLimiter({
  maxPerIp: 120,
  // Без общего потолка: его выбирали бы несколько адресов, и маршруты
  // переставали бы строиться у всех. Процессор ограничивает routeCpuLimiter.
  maxPerInstance: Number.POSITIVE_INFINITY,
});

/**
 * Сколько доверенных прокси стоит перед сервером (TRUST_PROXY, по умолчанию 0).
 *
 * X-Forwarded-For пишет клиент, и за nginx с `$proxy_add_x_forwarded_for`
 * первое значение тоже клиентское. Поэтому без прокси адрес берётся только из
 * сокета, а с TRUST_PROXY=N — N-е значение с конца: его дописал наш прокси.
 */
const parseTrustProxy = (raw) => {
  const value = String(raw ?? '0').trim();
  if (value === '') return 0;
  if (!/^\d+$/.test(value) || Number(value) > 5) {
    // «true», «-1», «10» — ошибка запуска, а не 0: иначе за nginx все
    // пользователи попали бы в одно ведро лимита.
    throw new Error('TRUST_PROXY должен быть целым числом от 0 до 5 — числом прокси перед сервером.');
  }
  return Number(value);
};

/** Проверка переменной при запуске сервера: ошибка лучше тихого неверного режима. */
export const validateTrustProxy = () => parseTrustProxy(process.env.TRUST_PROXY);

const trustedProxyHops = () => {
  try {
    return parseTrustProxy(process.env.TRUST_PROXY);
  } catch {
    return 0;
  }
};

/*
 * Адреса, с которых принимается X-Forwarded-For (TRUSTED_PROXIES, по умолчанию
 * только локальный nginx). Иначе при TRUST_PROXY=1 и открытом наружу порте
 * клиент, придя напрямую, подставил бы себе адрес заголовком.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const trustedProxies = () => {
  const configured = (process.env.TRUSTED_PROXIES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : LOOPBACK;
};

/** Пришёл ли запрос от нашего прокси: только тогда можно верить X-Forwarded-*. */
export const isFromTrustedProxy = (req) => {
  const socketAddress = (req.socket?.remoteAddress || '').toString().slice(0, 64).toLowerCase();
  return trustedProxyHops() > 0 && trustedProxies().has(socketAddress);
};

export const getClientIp = (req) => {
  const socketAddress = (req.socket?.remoteAddress || 'unknown').toString().slice(0, 64);
  const hops = trustedProxyHops();
  if (hops === 0 || !trustedProxies().has(socketAddress.toLowerCase())) {
    return socketAddress;
  }

  // X-Real-IP не читается: его тоже может прислать клиент.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate.slice(0, 64);
  }
  return socketAddress;
};

// 40 за 5 минут: кнопки уточнений под подбором («вечера», «в любой день»)
// тоже уходят в чат репликой.
export const CHAT_MAX_PER_IP = 40;
/**
 * Лимит реплик ассистента на адрес, без общего потолка на процесс: он
 * расходуется до проверки тела, и немногие адреса закрыли бы ассистента для
 * всех. Процессор ограничивает chatCpuLimiter, деньги на модель —
 * takeExternalBudget.
 *
 * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
 */
export const checkRateLimit = createRateLimiter({ maxPerIp: CHAT_MAX_PER_IP, maxPerInstance: Number.POSITIVE_INFINITY });

/**
 * Бюджет обращений к внешней модели на процесс. Расходуется, только когда
 * запрос действительно уходит к модели; исчерпан — ассистент отвечает по
 * локальному плану.
 */
export const createBudget = ({ windowMs = WINDOW_MS, max = MAX_PER_INSTANCE } = {}) => {
  let taken = [];
  return (now = Date.now()) => {
    taken = prune(taken, now, windowMs);
    if (taken.length >= max) return false;
    taken.push(now);
    return true;
  };
};

/*
 * Суточный потолок обращений к модели (AI_DAILY_CALL_LIMIT, по умолчанию 2000):
 * пятиминутный бюджет сам по себе допускает до 86 тысяч вызовов в сутки.
 * Когда потолок выбран, ассистент отвечает по локальному плану. Жёсткий лимит
 * расходов стоит включить и в кабинете провайдера модели.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const dailyCallLimit = () => {
  const value = Number.parseInt(process.env.AI_DAILY_CALL_LIMIT ?? '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 2000;
};

export const createExternalBudget = ({ windowMs = WINDOW_MS, max = MAX_PER_INSTANCE, dailyLimit = dailyCallLimit } = {}) => {
  const shortWindow = createBudget({ windowMs, max });
  let dailyTaken = [];
  return (now = Date.now()) => {
    dailyTaken = prune(dailyTaken, now, DAY_MS);
    if (dailyTaken.length >= dailyLimit()) return false;
    if (!shortWindow(now)) return false;
    dailyTaken.push(now);
    return true;
  };
};

export const takeExternalBudget = createExternalBudget();

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_PER_IP, MAX_PER_INSTANCE };
