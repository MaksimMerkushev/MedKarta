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

  return (ip, now = Date.now()) => {
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
 * Бюджет маршрутизации отдельный и заметно шире: расчёт идёт локально,
 * денег не стоит, но вызывается при каждом изменении набора точек.
 */
export const checkRouteRateLimit = createRateLimiter({
  maxPerIp: 120,
  maxPerInstance: 1500,
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
 * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
 */
export const checkRateLimit = createRateLimiter();

export const RATE_LIMIT_CONFIG = { WINDOW_MS, MAX_PER_IP, MAX_PER_INSTANCE };
