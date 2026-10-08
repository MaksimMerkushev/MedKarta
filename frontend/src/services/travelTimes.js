/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Время в пути от точки отправления до многих адресов — запрос к нашему
 * серверу (/api/travel-times). Координаты дальше нашего сервера не уходят.
 */

const ENDPOINT = '/api/travel-times';
const TIMEOUT_MS = 12_000;

/**
 * @param {object} params
 * @param {[number, number]} params.origin [широта, долгота]
 * @param {'driving'|'foot'|'bike'} params.mode
 * @param {number} params.maxMinutes
 * @param {Array<[number, number]>} params.points
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Array<number|null>>} секунды или null для каждой точки
 */
export const fetchTravelTimes = async ({ origin, mode, maxMinutes, points, signal }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
      body: JSON.stringify({
        origin: { lat: Number(origin[0].toFixed(5)), lng: Number(origin[1].toFixed(5)) },
        mode,
        maxMinutes,
        points,
      }),
    });
    if (!response.ok) {
      const error = new Error(`travel-times ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    if (!Array.isArray(payload?.durations) || payload.durations.length !== points.length) {
      throw new Error('travel-times: bad payload');
    }
    return payload.durations.map((value) => (Number.isFinite(value) ? value : null));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
};
