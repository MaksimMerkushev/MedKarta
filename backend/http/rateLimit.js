/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Скользящее окно в памяти инстанса.
 * Ограничение: serverless-инстансы эфемерны и их может быть несколько,
 * поэтому это защита от всплеска с одного адреса, а не строгая квота.
 * Для жёсткого лимита нужен внешний стор (Upstash Redis / Vercel KV) —
 * см. SECURITY.md.
 */

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_IP = 20;
const MAX_PER_INSTANCE = 300;
const MAX_TRACKED_IPS = 20_000;

const prune = (list, now, windowMs) => list.filter((timestamp) => now - timestamp < windowMs);

/*
 * Вытеснение самых давних записей вместо полного сброса.
 *
 * Раньше при переполнении карта очищалась целиком (hits.clear()): разослав
 * запросы с пяти тысяч адресов, можно было обнулить счётчики ВСЕХ клиентов,
 * включая собственный, и получить новый лимит. Map хранит порядок вставки,
 * а активные ключи переставляются в конец при каждом обновлении, поэтому
 * первыми уходят те, кто давно не обращался.
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
 * целую подсеть, и перебор адресов внутри неё обходил лимит «на адрес».
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
 * Независимый ограничитель со своим счётчиком.
 *
 * Разным эндпоинтам нужны разные бюджеты: обращение к языковой модели стоит
 * денег и времени, а построение маршрута считается локально и вызывается
 * при каждом изменении точек на карте. Общий счётчик заставил бы выбирать
 * между «дорого» и «неудобно».
 */
export const createRateLimiter = ({
  windowMs = WINDOW_MS,
  maxPerIp = MAX_PER_IP,
  maxPerInstance = MAX_PER_INSTANCE,
  maxTrackedIps = MAX_TRACKED_IPS,
} = {}) => {
  const hits = new Map();
  let instanceHits = [];
  /*
   * Общий счётчик ведётся, только если общий потолок задан. Раньше массив
   * фильтровался на каждом запросе и при Infinity: при 70 тысячах отметок в
   * окне даже дешёвые /api/events замедлялись втрое.
   */
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
 * Лимит по ЗАТРАЧЕННОМУ ВРЕМЕНИ процессора, а не по числу запросов.
 *
 * У сервера одно ядро, и расчёт маршрута идёт в основном потоке. 110
 * запросов по шесть точек укладывались в лимит «120 на адрес», но держали
 * сервер занятым так, что главная страница отвечала 16 секунд. Теперь у
 * адреса «ведро» миллисекунд: полное — 1,5 с, пополняется на 50 мс в секунду.
 * Обычный пользователь тратит 5–30 мс на маршрут и лимита не замечает.
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
 * Бюджет процессора ассистента. Обычный запрос разбирается за 5–50 мс, но
 * двенадцать реплик по тысяче символов, подобранных под нечёткий поиск
 * фамилий, стоили до 0,8 с. Двадцать таких запросов с одного адреса держали
 * единственное ядро десять секунд. Ведро в 3 с с пополнением 30 мс/с
 * пропускает живой диалог и останавливает перебор.
 */
export const chatCpuLimiter = createCostLimiter({ capacityMs: 3_000, refillMsPerSecond: 30 });

/**
 * Общий предохранитель тяжёлой работы на весь процесс.
 *
 * Лимиты «на адрес» не спасают от двадцати адресов сразу: каждый укладывается
 * в свой бюджет, а ядро одно. Здесь суммируется время, потраченное маршрутами,
 * расчётом времени в пути и ассистентом за последние windowMs. Если сумма
 * превысила долю окна, новые тяжёлые запросы получают 503 с Retry-After, а
 * статика и лёгкие эндпоинты продолжают отвечать.
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
     * share — своя доля для разных потребителей: ассистент отключается
     * первым (60 %), маршруты — только при почти полной загрузке (85 %),
     * чтобы перебор запросов к ассистенту не ломал построение маршрутов.
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

/**
 * Бюджет маршрутизации отдельный и заметно шире: расчёт идёт локально,
 * денег не стоит, но вызывается при каждом изменении набора точек.
 */
export const checkRouteRateLimit = createRateLimiter({
  maxPerIp: 120,
  // Общий потолок на инстанс убран по той же причине, что и у чата: его
  // выбирали 13 адресов, и маршруты переставали строиться у всех. Нагрузку
  // на процессор ограничивает routeCpuLimiter.
  maxPerInstance: Number.POSITIVE_INFINITY,
});

/**
 * Сколько доверенных прокси стоит перед сервером (TRUST_PROXY, по умолчанию 0).
 *
 * Раньше адрес брался из первого значения X-Forwarded-For без всяких условий.
 * Этот заголовок пишет клиент, поэтому, меняя его в каждом запросе, любой
 * обходил лимит «20 запросов с адреса» — а за nginx с
 * `$proxy_add_x_forwarded_for` первое значение тоже остаётся клиентским.
 *
 * Теперь без прокси адрес берётся только из сокета. С TRUST_PROXY=N берётся
 * N-е значение с конца: его дописал наш собственный прокси, подделать его
 * клиент не может.
 */
const parseTrustProxy = (raw) => {
  const value = String(raw ?? '0').trim();
  if (value === '') return 0;
  if (!/^\d+$/.test(value) || Number(value) > 5) {
    // «true», «yes», «-1», «10»: раньше молча читалось как 0, и за nginx все
    // пользователи оказывались в одном ведре лимита. Теперь сервер не стартует.
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
 * Адреса, с которых сервер принимает X-Forwarded-For. По умолчанию — только
 * локальный nginx. Иначе при TRUST_PROXY=1 и открытом наружу порте любой
 * клиент, придя напрямую, подставлял себе адрес заголовком.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const trustedProxies = () => {
  const configured = (process.env.TRUSTED_PROXIES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : LOOPBACK;
};

export const getClientIp = (req) => {
  const socketAddress = (req.socket?.remoteAddress || 'unknown').toString().slice(0, 64);
  const hops = trustedProxyHops();
  if (hops === 0 || !trustedProxies().has(socketAddress.toLowerCase())) {
    return socketAddress;
  }

  /*
   * X-Real-IP больше не читается: его тоже пишет клиент, и при отсутствии
   * X-Forwarded-For он подменял адрес без всяких условий.
   */
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate.slice(0, 64);
  }
  return socketAddress;
};

/**
 * Лимит на адрес. Общего потолка на инстанс здесь больше нет: он
 * расходовался ещё до проверки тела и позволял немногим адресам закрыть
 * ассистента для всех. Деньги на модель теперь защищает takeExternalBudget.
 *
 * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
 */
export const checkRateLimit = createRateLimiter({ maxPerInstance: Number.POSITIVE_INFINITY });

/**
 * Бюджет обращений к внешней модели на инстанс. Расходуется только когда
 * запрос действительно уходит к модели; когда он исчерпан, ассистент
 * отвечает по локальному плану.
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
 * Суточный потолок обращений к модели (AI_DAILY_CALL_LIMIT, по умолчанию 2000).
 * Пятиминутного бюджета мало: 300 вызовов за пять минут — это до 86 тысяч в
 * сутки, и пятнадцать адресов могли держать расход на максимуме круглые сутки.
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
