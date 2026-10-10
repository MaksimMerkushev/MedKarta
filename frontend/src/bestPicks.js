/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Три лучших варианта для ответа ассистента.
 *
 * Отбор идёт в браузере, по уже отфильтрованному и отсортированному списку:
 * точка отправления, время в пути и программа ДМС никуда не отправляются,
 * а «лучший» без них не определить. Сервер знает только профиль и условия.
 *
 * Модуль без JSX и без псевдонимов сборки — его проверяют тесты Node.
 */

export const TOP_PICKS_LIMIT = 3;

/** «21 год», «23 года», «25 лет». */
const yearsWord = (count) => {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return 'лет';
  if (count % 10 === 1) return 'год';
  if (count % 10 >= 2 && count % 10 <= 4) return 'года';
  return 'лет';
};

/*
 * Три врача из одной поликлиники — это одна поездка, а не три варианта.
 * Сначала берём лучших из разных мест, но только среди первых
 * DIVERSITY_WINDOW: ради разнообразия не стоит поднимать сотый результат.
 */
const DIVERSITY_WINDOW = 12;

const placeKey = (doc) => {
  const lat = Number(doc.lat);
  const lng = Number(doc.lng);
  const point = Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(4)},${lng.toFixed(4)}` : '';
  return `${point}|${(doc.clinic || '').trim().toLowerCase()}`;
};

/**
 * @param {Array<object>} list отсортированная выдача (как в списке на карте)
 * @param {{limit?: number, exclude?: Set<string>}} [options] exclude — id точек
 *        маршрута: они остаются в списке без учёта фильтров и в «лучшие» не идут
 * @returns {{picks: Array<object>, total: number}}
 */
/*
 * Один и тот же врач, принимающий в двух филиалах, — это один вариант,
 * а не два: в подборку он попадает один раз, с лучшим из адресов.
 */
const personKey = (doc) => (doc.entityKind === 'doctor' && doc.name
  ? `${String(doc.name).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')}|${doc.doctorProfile || doc.specialty || ''}`
  : `id:${doc.id}`);

export const selectTopPicks = (list, { limit = TOP_PICKS_LIMIT, exclude = new Set() } = {}) => {
  const candidates = (Array.isArray(list) ? list : []).filter((doc) => doc && !exclude.has(doc.id));
  const picks = [];
  const usedPlaces = new Set();
  const usedPeople = new Set();

  const take = (doc) => {
    picks.push(doc);
    usedPeople.add(personKey(doc));
    usedPlaces.add(placeKey(doc));
  };

  for (const doc of candidates.slice(0, DIVERSITY_WINDOW)) {
    if (picks.length >= limit) break;
    if (usedPeople.has(personKey(doc)) || usedPlaces.has(placeKey(doc))) continue;
    take(doc);
  }
  for (const doc of candidates) {
    if (picks.length >= limit) break;
    if (!picks.includes(doc) && !usedPeople.has(personKey(doc))) take(doc);
  }

  return { picks, total: candidates.length };
};

const TRAVEL_MODE_TEXT = { driving: 'на машине', foot: 'пешком', bike: 'на велосипеде' };

export const formatTravel = (seconds, mode = 'driving', approximate = false) => {
  if (!Number.isFinite(seconds)) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${approximate ? '≈' : ''}${minutes} мин ${TRAVEL_MODE_TEXT[mode] || ''}`.trim();
};

export const formatDistance = (km) => {
  if (!Number.isFinite(km)) return null;
  if (km < 1) return `${Math.max(50, Math.round((km * 1000) / 50) * 50)} м`;
  return `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} км`;
};

export const formatPrice = (value) => (Number.isFinite(value) && value > 0 ? `от ${Math.round(value).toLocaleString('ru-RU')} ₽` : null);

/**
 * Почему вариант попал в лучшие — короткие факты из карточки, по важности.
 * Ничего не выдумываем: нет расписания — нет и пункта про часы.
 *
 * @returns {Array<{kind: string, text: string}>}
 */
export const pickReasons = (doc, { travelMode = 'driving', childrenOnly = false, maxReasons = 4 } = {}) => {
  const reasons = [];

  const travel = formatTravel(doc.travelSeconds, travelMode, doc.travelApproximate);
  const distance = formatDistance(doc.distanceKm);
  if (travel) reasons.push({ kind: 'travel', text: travel });
  else if (distance) reasons.push({ kind: 'distance', text: distance });

  if (doc.openNow) {
    reasons.push({ kind: 'open', text: 'Открыто сейчас' });
  } else if (typeof doc.todayHours === 'string' && doc.todayHours && !/уточняется/i.test(doc.todayHours)) {
    reasons.push({ kind: 'hours', text: /выходн/i.test(doc.todayHours) ? 'Сегодня выходной' : `Сегодня ${doc.todayHours}` });
  }

  if (doc.dmsCoverage?.status === 'covered') {
    reasons.push({ kind: 'dms', text: doc.dmsCoverage.partial ? 'ДМС, часть врачей' : 'По вашему ДМС' });
  }

  const price = formatPrice(doc.consultPrice);
  if (price) reasons.push({ kind: 'price', text: price });

  if (childrenOnly && doc.features?.children) reasons.push({ kind: 'child', text: 'Детский приём' });
  if (doc.rating > 0) reasons.push({ kind: 'rating', text: `★ ${doc.rating.toFixed(1).replace('.', ',')}` });
  if (doc.experience >= 5) reasons.push({ kind: 'experience', text: `Стаж ${doc.experience} ${yearsWord(doc.experience)}` });

  return reasons.slice(0, maxReasons);
};

/** Как отсортированы варианты — одной фразой для заголовка подборки. */
export const SORT_EXPLANATION = Object.freeze({
  recommendation: 'открытые сейчас, рейтинг и расстояние',
  distance: 'ближе всего',
  schedule: 'раньше начинают приём',
  rating: 'выше рейтинг',
  experience: 'больше стаж',
  price: 'дешевле',
  name: 'по алфавиту',
  clinic: 'по клинике',
});

/**
 * Условия запроса, которые действительно применены к выдаче, —
 * для строки «под ваш запрос: …».
 */
export const describeCriteria = ({
  profile = null,
  childrenOnly = false,
  maxTravelMinutes = 0,
  travelMode = 'driving',
  travelActive = false,
  dmsPlanName = null,
  openOnly = false,
  eveningOnly = false,
  weekendOnly = false,
  ownership = 'all',
  district = 'all',
} = {}) => {
  const items = [];
  if (profile) items.push(profile);
  if (childrenOnly) items.push('детский приём');
  if (travelActive && maxTravelMinutes > 0) items.push(`до ${maxTravelMinutes} мин ${TRAVEL_MODE_TEXT[travelMode] || ''}`.trim());
  if (dmsPlanName) items.push(`ДМС «${dmsPlanName}»`);
  if (openOnly) items.push('открыто сейчас');
  if (eveningOnly) items.push('вечером');
  if (weekendOnly) items.push('в выходные');
  if (ownership === 'Частная') items.push('частные');
  if (ownership === 'Государственная') items.push('государственные');
  if (district && district !== 'all') items.push(district);
  return items;
};

/** Показывать ли подборку на ответ ассистента: только на поиск, а не на маршрут или сброс. */
export const wantsTopPicks = (result) => {
  if (!result || typeof result !== 'object') return false;
  if (result.buildRoute || result.clearFilters || result.clearRoute) return false;
  if (Array.isArray(result.targetStops) && result.targetStops.length > 0) return false;
  return Boolean(
    result.specialty
      || result.searchQuery
      || result.doctorProfile
      || result.clinic
      || result.service
      || (Array.isArray(result.services) && result.services.length > 0),
  );
};
