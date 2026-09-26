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
const MAX_TRACKED_IPS = 5000;

const prune = (list, now, windowMs) => list.filter((timestamp) => now - timestamp < windowMs);

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

  return (address, now = Date.now()) => {
    const ip = rateLimitKey(address);
    instanceHits = prune(instanceHits, now, windowMs);
    if (instanceHits.length >= maxPerInstance) {
      return { allowed: false, retryAfterSeconds: 60, remaining: 0 };
    }

    // Аварийный сброс, чтобы карта не росла бесконечно при разбросе адресов.
    if (hits.size > maxTrackedIps) {
      hits.clear();
    }

    const previous = prune(hits.get(ip) || [], now, windowMs);
    if (previous.length >= maxPerIp) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now - previous[0])) / 1000));
      hits.set(ip, previous);
      return { allowed: false, retryAfterSeconds, remaining: 0 };
    }

    previous.push(now);
    hits.set(ip, previous);
    instanceHits.push(now);

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
      if (buckets.size > maxTrackedIps) buckets.clear();
      buckets.set(key, { level: level(key, now) - Math.max(0, costMs), at: now });
    },
  });
};

export const routeCpuLimiter = createCostLimiter();

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
const trustedProxyHops = () => {
  const hops = Number.parseInt(process.env.TRUST_PROXY ?? '0', 10);
  return Number.isFinite(hops) && hops > 0 ? Math.min(hops, 5) : 0;
};

export const getClientIp = (req) => {
  const socketAddress = (req.socket?.remoteAddress || 'unknown').toString().slice(0, 64);
  const hops = trustedProxyHops();
  if (hops === 0) {
    return socketAddress;
  }

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
    const candidate = chain[chain.length - hops];
    if (candidate) return candidate.slice(0, 64);
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) {
    return realIp.trim().slice(0, 64);
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

export const takeExternalBudget = createBudget();

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_PER_IP, MAX_PER_INSTANCE };
