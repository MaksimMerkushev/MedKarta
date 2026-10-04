/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Абстракция маршрутизации.
 *
 * ПОЧЕМУ ИНТЕРФЕЙС, А НЕ ПРЯМОЙ ВЫЗОВ. Геометрически ближайшая клиника и
 * ближайшая по времени поездки — разные объекты: река, односторонние улицы и
 * пробки легко меняют порядок. Сейчас движка маршрутизации на сервере нет,
 * поэтому по умолчанию работает гаверсинус, но контракт уже такой, какой
 * нужен настоящему движку: матрица длительностей. Подключение OSRM/Valhalla
 * не потребует правок ни в Planner, ни в Executor.
 *
 * Модель НИКОГДА не считает расстояния и не видит координат: она оперирует
 * значением selection ("nearest"), а вычисление делает доверенный backend.
 */

const EARTH_RADIUS_KM = 6371;

/** Средние городские скорости, км/ч. Заведомо грубые — это видно из названия. */
export const FALLBACK_SPEEDS_KMH = Object.freeze({ driving: 28, bike: 14, foot: 4.5 });

export const TRAVEL_MODES = Object.freeze(['driving', 'foot', 'bike']);

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/** Расстояние по большому кругу, км. */
export const haversineKm = (from, to) => {
  if (!from || !to) return Number.POSITIVE_INFINITY;
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Базовый интерфейс провайдера маршрутизации.
 * Реализация обязана вернуть массив той же длины, что destinations.
 */
export class RoutingProvider {
  // eslint-disable-next-line no-unused-vars
  async travelTimes(origin, destinations, mode) {
    throw new Error('not implemented');
  }
}

/**
 * Оценка по прямой. Не выдаёт себя за настоящий ETA: поле `approximate`
 * проставлено в true, и resultBuilder обязан это учитывать в формулировке.
 */
export const createHaversineRoutingProvider = ({ speeds = FALLBACK_SPEEDS_KMH } = {}) =>
  Object.freeze({
    name: 'haversine',
    approximate: true,
    async travelTimes(origin, destinations, mode = 'driving') {
      const speed = speeds[mode] || speeds.driving;
      return destinations.map((destination) => {
        const distanceKm = haversineKm(origin, destination);
        return {
          distanceKm: Number.isFinite(distanceKm) ? Number(distanceKm.toFixed(3)) : null,
          durationSeconds: Number.isFinite(distanceKm)
            ? Math.round((distanceKm / speed) * 3600)
            : null,
          approximate: true,
        };
      });
    },
  });

/**
 * Адаптер OSRM (сервис table). Выключен по умолчанию.
 *
 * ВНИМАНИЕ: публичный демо-сервер OSRM не предназначен для промышленной
 * нагрузки, а отправка координат пользователя третьей стороне — это
 * самостоятельная передача данных, которую нужно отразить в политике
 * конфиденциальности. Включать только со своим инстансом.
 */
export const createOsrmRoutingProvider = ({
  baseUrl = process.env.ROUTING_OSRM_URL,
  fetchImpl = fetch,
  timeoutMs = 4000,
} = {}) =>
  Object.freeze({
    name: 'osrm',
    approximate: false,
    async travelTimes(origin, destinations, mode = 'driving') {
      if (!baseUrl) {
        throw new Error('ROUTING_OSRM_URL is not configured');
      }

      const profile = mode === 'foot' ? 'foot' : mode === 'bike' ? 'bike' : 'car';
      const points = [origin, ...destinations]
        .map((point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`)
        .join(';');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(
          `${baseUrl.replace(/\/+$/, '')}/table/v1/${profile}/${points}?sources=0&annotations=duration,distance`,
          { signal: controller.signal, redirect: 'error' },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`osrm ${response.status}`);
        }
        // Ответ сервиса маршрутов читается с потолком: таблица на десяток точек — килобайты.
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > 1_000_000) {
          await response.body?.cancel().catch(() => {});
          throw new Error('osrm response too large');
        }
        const text = await response.text();
        if (text.length > 1_000_000) throw new Error('osrm response too large');
        const payload = JSON.parse(text);
        const durations = payload?.durations?.[0]?.slice(1) || [];
        const distances = payload?.distances?.[0]?.slice(1) || [];

        return destinations.map((_, index) => ({
          durationSeconds: Number.isFinite(durations[index]) ? Math.round(durations[index]) : null,
          distanceKm: Number.isFinite(distances[index]) ? Number((distances[index] / 1000).toFixed(3)) : null,
          approximate: false,
        }));
      } finally {
        clearTimeout(timer);
      }
    },
  });

/**
 * Провайдер поверх собственного движка (backend/routing).
 *
 * Координаты не покидают доверенный контур. Если граф не собран, функция
 * возвращает null и вызывающая сторона переходит на оценку по прямой —
 * приложение работает, просто ETA становится приблизительным.
 */
export const createLocalRoutingProvider = async () => {
  const { getDefaultRoutingEngine } = await import('../routing/engine.js');
  const engine = await getDefaultRoutingEngine();
  return engine;
};

/**
 * Выбор провайдера.
 *
 * По умолчанию — собственный движок, если граф собран; иначе гаверсинус.
 * OSRM остаётся доступен явным флагом, но включать его значит отправлять
 * координаты пользователя третьей стороне, и это нужно отражать в политике
 * конфиденциальности.
 */
export const createRoutingProviderFromEnv = async (env = process.env) => {
  const requested = (env.ROUTING_PROVIDER || 'local').toLowerCase();

  if (requested === 'osrm') {
    return createOsrmRoutingProvider();
  }
  if (requested === 'haversine') {
    return createHaversineRoutingProvider();
  }

  return (await createLocalRoutingProvider()) || createHaversineRoutingProvider();
};

/**
 * Двухступенчатый выбор кандидата.
 *
 *   1. пространственный префильтр (здесь — гаверсинус; место для PostGIS
 *      ST_DWithin / KNN-оператора <->, когда появится БД);
 *   2. матрица времени в пути по оставшимся кандидатам;
 *   3. выбор минимального ETA.
 *
 * Разделение принципиально: считать матрицу по всему справочнику дорого,
 * а выбирать по прямой — неверно.
 *
 * @returns {Promise<{best: object|null, ranked: Array, approximate: boolean}>}
 */
export const selectByTravelTime = async ({
  origin,
  candidates,
  routing,
  mode = 'driving',
  prefilterLimit = 10,
}) => {
  const located = candidates.filter(
    (item) => Number.isFinite(item.lat) && Number.isFinite(item.lng),
  );

  if (located.length === 0) {
    return { best: candidates[0] || null, ranked: candidates, approximate: true };
  }

  if (!origin) {
    // Без точки отправления «ближайший» не определён на сервере.
    // Координаты пользователя остаются в браузере, и порядок уточняет клиент.
    return { best: located[0], ranked: located, approximate: true };
  }

  const prefiltered = [...located]
    .map((item) => ({ item, straightKm: haversineKm(origin, item) }))
    .sort((left, right) => left.straightKm - right.straightKm)
    .slice(0, prefilterLimit);

  const times = await routing.travelTimes(
    origin,
    prefiltered.map((entry) => ({ lat: entry.item.lat, lng: entry.item.lng })),
    mode,
  );

  const ranked = prefiltered
    .map((entry, index) => ({
      ...entry.item,
      distanceKm: times[index]?.distanceKm ?? Number(entry.straightKm.toFixed(3)),
      durationSeconds: times[index]?.durationSeconds ?? null,
    }))
    .sort((left, right) => {
      const a = left.durationSeconds ?? Number.POSITIVE_INFINITY;
      const b = right.durationSeconds ?? Number.POSITIVE_INFINITY;
      return a - b;
    });

  return { best: ranked[0] || null, ranked, approximate: Boolean(routing.approximate) };
};
