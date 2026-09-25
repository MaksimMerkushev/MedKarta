/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Загрузка справочника врачей, клиник и учреждений в форму, пригодную
 * и для entity linking (privacy-слой), и для исполнения плана (executor).
 *
 * ГРАНИЦА ДОВЕРИЯ: этот модуль работает ТОЛЬКО внутри доверенного backend.
 * Внешняя модель не получает ни одной записи отсюда — ни id, ни ФИО,
 * ни координат. Наружу уходят только session-токены (см. storage/tokenVault.js).
 *
 * Справочник врачей и клиник — публично опубликованные сведения, но это
 * НЕ делает их «не персональными данными»: ФИО врача остаётся персональными
 * данными, а связка «ФИО + запрос пользователя» тем более. Поэтому каталог
 * обрабатывается тем же механизмом токенизации, что и данные пациента.
 */

import { parseOpeningHours } from '../../shared/openingHours.js';

/** Канонические специальности. Значение — ключ, используемый в плане. */
export const SPECIALTY_CANON = Object.freeze({
  therapist: 'Терапевт',
  neurologist: 'Невролог',
  cardiologist: 'Кардиолог',
  lor: 'ЛОР',
  ophthalmologist: 'Офтальмолог',
  surgeon: 'Хирург',
  orthopedist: 'Ортопед',
  dermatologist: 'Дерматолог',
  gynecologist: 'Гинеколог',
  pediatrician: 'Педиатр',
  dentist: 'Стоматолог',
  endocrinologist: 'Эндокринолог',
  gastroenterologist: 'Гастроэнтеролог',
  urologist: 'Уролог',
  psychiatrist: 'Психиатр',
  traumatologist: 'Травматолог',
});

/** Обратное соответствие: русское название → ключ плана. */
export const SPECIALTY_BY_LABEL = Object.freeze(
  Object.fromEntries(Object.entries(SPECIALTY_CANON).map(([key, label]) => [label.toLowerCase(), key])),
);

export const DISTRICTS = Object.freeze([
  'Вахитовский',
  'Московский',
  'Ново-Савиновский',
  'Приволжский',
  'Советский',
  'Авиастроительный',
  'Кировский',
]);

export const OWNERSHIPS = Object.freeze(['Государственная', 'Частная']);

/**
 * Аббревиатуры и разговорные названия клиник.
 * Без них «поеду в РКБ» не свяжется с «ГАУЗ Республиканская клиническая больница».
 */
const CLINIC_ALIASES = Object.freeze({
  'икдц': ['мкдц', 'межрегиональный клинико диагностический центр'],
  'ркб': ['республиканская клиническая больница'],
  'дркб': ['детская республиканская клиническая больница'],
});

const asArray = (value) => (Array.isArray(value) ? value : []);

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Приводит расписание к карте дней недели; всё лишнее отбрасывается. */
const normalizeSchedule = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const schedule = {};
  for (const day of DAY_KEYS) {
    if (typeof raw[day] === 'string' && raw[day].trim()) {
      schedule[day] = raw[day].trim();
    }
  }
  return Object.keys(schedule).length > 0 ? schedule : null;
};

const toClinicRecord = (raw, index) => ({
  id: String(raw.clinic_id || raw.id || `clinic-${index}`),
  name: String(raw.name || '').trim(),
  branchName: raw.branch_name ? String(raw.branch_name) : null,
  facilityType: raw.facility_type || raw.facilityType || null,
  ownership: raw.ownership || null,
  district: (raw.district || '').replace(/\s*район\s*$/iu, '').trim() || null,
  address: raw.address_full || raw.address || null,
  lat: raw.coordinates?.lat ?? raw.lat ?? null,
  lng: raw.coordinates?.lng ?? raw.lng ?? null,
  // Расписание приводится к единому виду {mon..sun}: у ClinicsData это
  // working_hours с дополнительным ключом raw, у OSM-учреждений — schedule.
  schedule: normalizeSchedule(raw.working_hours || raw.schedule),
  hoursText: raw.working_hours?.raw || raw.hours || null,
  aliases: asArray(raw.aliases).map(String),
});

const toDoctorRecord = (raw, index) => ({
  id: String(raw.id || `doctor-${index}`),
  name: String(raw.name || '').trim(),
  specialty: raw.specialty || null,
  clinic: raw.clinic || null,
  district: (raw.district || '').replace(/\s*район\s*$/iu, '').trim() || null,
  ownership: raw.ownership || null,
  rating: Number.isFinite(raw.rating) ? raw.rating : null,
  experience: Number.isFinite(raw.experience) ? raw.experience : null,
  lat: Number.isFinite(raw.lat) ? raw.lat : null,
  lng: Number.isFinite(raw.lng) ? raw.lng : null,
  schedule: raw.schedule || null,
  hoursText: raw.hours || null,
  services: asArray(raw.services).map(String),
  features: raw.features || {},
  facilityType: raw.facilityType || null,
});

/**
 * Собирает каталог из произвольных наборов. Вынесено отдельно, чтобы тесты
 * могли подать детерминированную фикстуру вместо реальной базы.
 */
export const buildCatalog = ({ doctors = [], clinics = [], facilities = [] } = {}) => {
  const doctorRecords = doctors.map(toDoctorRecord);
  const clinicRecords = [
    ...clinics.map(toClinicRecord),
    ...facilities.map((item, index) =>
      toClinicRecord(
        {
          clinic_id: item.id,
          name: item.clinic || item.name,
          facility_type: item.facilityType || item.specialty,
          ownership: item.ownership,
          district: item.district,
          address_full: item.address,
          coordinates: { lat: item.lat, lng: item.lng },
          // Часы из исходной строки OSM: сохранённое расписание по дням
          // закрывало выходные почти у всех учреждений (shared/openingHours.js).
          working_hours: parseOpeningHours(item.hours) || item.schedule,
          hours: item.hours,
        },
        index,
      ),
    ),
  ];

  // Дедупликация по нормализованному имени: OSM и ручной справочник пересекаются.
  const seen = new Map();
  for (const clinic of clinicRecords) {
    const key = clinic.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (!key) continue;
    const previous = seen.get(key);
    if (!previous || (previous.lat === null && clinic.lat !== null)) {
      seen.set(key, clinic);
    }
  }

  const uniqueClinics = [...seen.values()].map((clinic) => {
    const key = clinic.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const extra = Object.entries(CLINIC_ALIASES)
      .filter(([alias]) => key.includes(alias))
      .flatMap(([, values]) => values);
    return extra.length > 0 ? { ...clinic, aliases: [...clinic.aliases, ...extra] } : clinic;
  });

  const specialties = new Set(
    doctorRecords.map((doctor) => doctor.specialty).filter(Boolean),
  );
  for (const label of Object.values(SPECIALTY_CANON)) {
    specialties.add(label);
  }

  return Object.freeze({
    doctors: Object.freeze(doctorRecords),
    clinics: Object.freeze(uniqueClinics),
    specialties: Object.freeze([...specialties]),
    districts: Object.freeze([...new Set([...DISTRICTS, ...doctorRecords.map((d) => d.district).filter(Boolean)])]),
  });
};

let cached = null;

/**
 * Каталог по умолчанию.
 *
 * Полная база (`data/doctors.full.js`) не попадает в git и может
 * отсутствовать. Отсутствие файла — не ошибка: подставляется публичный срез.
 * Ни при каких обстоятельствах загрузчик не выдумывает записи.
 *
 * @returns {Promise<ReturnType<typeof buildCatalog>>}
 */
export const loadCatalog = async () => {
  if (cached) {
    return cached;
  }

  const [doctorsModule, clinicsModule, facilitiesModule] = await Promise.all([
    import('../../data/doctors.js').catch(() => ({ verifiedDoctors: [] })),
    import('../../data/clinics.js').catch(() => ({ ClinicsData: { clinics: [] } })),
    process.env.PRIVACY_CATALOG_FACILITIES === 'off'
      ? Promise.resolve({ kazanFacilities: [] })
      : import('../../data/facilities.js').catch(() => ({ kazanFacilities: [] })),
  ]);

  let doctors = doctorsModule.verifiedDoctors || [];
  try {
    const full = await import('../../data/doctors.full.js');
    const fullList = full.verifiedDoctors || full.default;
    if (Array.isArray(fullList) && fullList.length > doctors.length) {
      doctors = fullList;
    }
  } catch {
    // Полной базы нет — работаем на публичном срезе. Это штатный режим.
  }

  cached = buildCatalog({
    doctors,
    clinics: clinicsModule.ClinicsData?.clinics || [],
    facilities: facilitiesModule.kazanFacilities || [],
  });

  return cached;
};

/** Только для тестов: сбрасывает кэш загрузчика. */
export const __resetCatalogCache = () => {
  cached = null;
};
