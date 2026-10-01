/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Ссылки на маршрут во внешних картах: Яндекс Карты и 2ГИС.
 *
 * МедКарта подбирает, КУДА обратиться; вести до двери умеют навигаторы —
 * с пробками, общественным транспортом и голосом. Ссылка открывает
 * приложение на телефоне, если оно установлено, иначе сайт.
 *
 * Координаты уходят в Яндекс или 2ГИС только по нажатию пользователя —
 * это его явное действие, как если бы он сам вбил адрес.
 */

/** Режим нашего движка → режим внешних карт. */
export const EXTERNAL_MODE_BY_TRAVEL_MODE = Object.freeze({ driving: 'auto', foot: 'foot', bike: 'bike' });

const YANDEX_RTT = Object.freeze({ auto: 'auto', transit: 'mt', foot: 'pd', bike: 'bc' });
const TWOGIS_TAB = Object.freeze({ auto: 'car', transit: 'bus', foot: 'pedestrian', bike: 'bicycle' });

const isPoint = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);

const toPoint = (value) => {
  if (Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    return { lat: value[0], lng: value[1] };
  }
  return isPoint(value) ? { lat: value.lat, lng: value.lng } : null;
};

const fixed = (value) => Number(value).toFixed(6);

/**
 * Яндекс Карты: rtext=широта,долгота~широта,долгота, rtt — тип маршрута.
 * Без точки отправления строка начинается с «~»: Яндекс подставит текущее
 * местоположение сам — лучше, чем вести от центра города.
 *
 * @param {[number, number]|{lat:number,lng:number}|null} origin
 * @param {Array<{lat:number,lng:number}>} targets
 * @param {'auto'|'transit'|'foot'|'bike'} [mode]
 */
export const buildYandexRouteUrl = (origin, targets, mode = 'auto') => {
  const points = (targets || []).map(toPoint).filter(Boolean);
  if (points.length === 0) return null;
  const start = toPoint(origin);
  const rtext = [start ? `${fixed(start.lat)},${fixed(start.lng)}` : '', ...points.map((p) => `${fixed(p.lat)},${fixed(p.lng)}`)].join('~');
  // Строка собирается вручную: в ней только цифры, точки, запятые и «~» —
  // безопасные символы запроса, а «%2C%7E» после URLSearchParams хуже читается.
  return `https://yandex.ru/maps/?rtext=${rtext}&rtt=${YANDEX_RTT[mode] || 'auto'}`;
};

/**
 * 2ГИС: /directions/tab/<тип>/points/<долгота>,<широта>|<долгота>,<широта>.
 * Порядок координат обратный яндексовскому: сначала долгота.
 * Пустая первая точка — «от моего местоположения».
 */
export const build2gisRouteUrl = (origin, targets, mode = 'auto') => {
  const points = (targets || []).map(toPoint).filter(Boolean);
  if (points.length === 0) return null;
  const start = toPoint(origin);
  const path = [start ? `${fixed(start.lng)},${fixed(start.lat)}` : '', ...points.map((p) => `${fixed(p.lng)},${fixed(p.lat)}`)].join('|');
  return `https://2gis.ru/kazan/directions/tab/${TWOGIS_TAB[mode] || 'car'}/points/${path}`;
};

export const buildExternalRouteUrl = (provider, origin, targets, mode) =>
  provider === '2gis' ? build2gisRouteUrl(origin, targets, mode) : buildYandexRouteUrl(origin, targets, mode);
