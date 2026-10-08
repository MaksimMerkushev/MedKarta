/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Какую территорию обязан покрывать граф дорог.
 *
 * Граф собирается по прямоугольной рамке. Если учреждение справочника лежит
 * за её краем или у самой границы, маршрут к нему не строится: ближайшая
 * дорога в графе — за километры, хотя на карте она в двух шагах. Так
 * случилось с ФАП на ул. Красавина: рамку подбирали «на глаз» по Казани,
 * а справочник включает пригороды за Волгой. Трасса М-7 и мост через Волгу
 * оказались за краем графа, и пригород за рекой стал островом.
 *
 * Поэтому рамка выводится из САМОГО СПРАВОЧНИКА: Казань плюс все его точки
 * с запасом. Появилось новое учреждение — следующая сборка графа покроет его
 * без правки кода, а тест не даст собрать рамку, которая его не покрывает.
 */

/** Казань в административных границах с ближайшими пригородами. */
export const CITY_BBOX = Object.freeze([55.64, 48.75, 55.99, 49.43]);

/**
 * Запас вокруг каждой точки справочника, км.
 *
 * Дорога, которая связывает окраинную точку с городом, может проходить
 * в нескольких километрах от неё: мост, развязка, объезд водохранилища.
 */
export const MARGIN_KM = 6;

const KM_PER_DEGREE_LAT = 111.32;

const toPoint = (lat, lng, label) => {
  const point = { lat: Number(lat), lng: Number(lng), label };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
};

/**
 * Все точки справочника с координатами.
 * Закрытая база врачей подключается, только если файл есть на диске.
 */
export const directoryPoints = async () => {
  const points = [];

  const { kazanFacilities } = await import('../../data/facilities.js');
  for (const item of kazanFacilities) {
    points.push(toPoint(item.lat, item.lng ?? item.lon, item.name || item.address));
  }

  const { ClinicsData } = await import('../../data/clinics.js');
  for (const clinic of ClinicsData.clinics || []) {
    points.push(toPoint(clinic.coordinates?.lat, clinic.coordinates?.lng, clinic.name));
  }

  for (const file of ['../../data/doctors.js', '../../data/doctors.full.js']) {
    try {
      const { verifiedDoctors = [] } = await import(file);
      // Врачи привязаны к учреждениям; имя врача в подпись не берём.
      for (const doctor of verifiedDoctors) points.push(toPoint(doctor.lat, doctor.lng, doctor.clinic));
    } catch {
      // закрытой базы может не быть — это штатно
    }
  }

  return points.filter(Boolean);
};

/** Запас в градусах вокруг широты lat. */
const marginDegrees = (lat, marginKm) => ({
  lat: marginKm / KM_PER_DEGREE_LAT,
  lng: marginKm / (KM_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180)),
});

/**
 * Рамка графа: объединение CITY_BBOX и всех точек с запасом.
 * Координаты округляются наружу до сотых — чтобы рамка была читаемой.
 *
 * @returns {number[]} [south, west, north, east]
 */
export const coverageBbox = (points, { base = CITY_BBOX, marginKm = MARGIN_KM } = {}) => {
  let [south, west, north, east] = base;
  for (const point of points) {
    const margin = marginDegrees(point.lat, marginKm);
    south = Math.min(south, point.lat - margin.lat);
    north = Math.max(north, point.lat + margin.lat);
    west = Math.min(west, point.lng - margin.lng);
    east = Math.max(east, point.lng + margin.lng);
  }
  const down = (value) => Math.floor(value * 100) / 100;
  const up = (value) => Math.ceil(value * 100) / 100;
  return [down(south), down(west), up(north), up(east)];
};

/** Лежит ли точка внутри рамки хотя бы с заданным запасом. */
export const coversPoint = ([south, west, north, east], point, marginKm = MARGIN_KM) => {
  const margin = marginDegrees(point.lat, marginKm);
  return (
    point.lat - margin.lat >= south - 1e-9 &&
    point.lat + margin.lat <= north + 1e-9 &&
    point.lng - margin.lng >= west - 1e-9 &&
    point.lng + margin.lng <= east + 1e-9
  );
};
