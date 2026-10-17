/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Только справочник (врачи, клиники, специальности, расписания), только
 * чтение. Чувствительные данные пациентов должны жить за отдельным
 * репозиторием и ролью БД, эфемерные — в storage/tokenVault.js
 * (см. docs/privacy-architecture.md).
 *
 * Планировщик (внешняя модель) не получает ни результатов выборки, ни их размера.
 */

import { SPECIALTY_CANON } from '../privacy/catalog.js';
import { normalizeRu } from '../privacy/normalize.js';
import { scheduleIntervals } from '../../shared/openingHours.js';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const parseMinutes = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * Приём идёт и после заданного времени (в любой день). Без расписания запись
 * фильтр не проходит: иначе пользователь увидит врача, которого может не быть
 * на месте. Граница строгая: закрывающаяся в 18:00 клиника «после 18:00» не
 * принимает. Интервалы с переходом через полночь — см. scheduleIntervals.
 */
const worksAfter = (schedule, time) => {
  const threshold = parseMinutes(time);
  if (threshold === null) return true;
  if (!schedule || typeof schedule !== 'object') {
    return false;
  }

  return DAY_KEYS.some((day) =>
    (scheduleIntervals(schedule[day]) || []).some((interval) => interval.end > threshold));
};

/** Приём начинается раньше заданного времени (граница строгая). */
const worksBefore = (schedule, time) => {
  const threshold = parseMinutes(time);
  if (threshold === null) return true;
  if (!schedule || typeof schedule !== 'object') return false;

  return DAY_KEYS.some((day) =>
    (scheduleIntervals(schedule[day]) || []).some((interval) => interval.start < threshold));
};

const worksWeekend = (schedule) => {
  if (!schedule || typeof schedule !== 'object') return false;
  return ['sat', 'sun'].some(
    (day) => typeof schedule[day] === 'string' && !/выходн/iu.test(schedule[day]),
  );
};

/** @param {{doctors: Array, clinics: Array}} catalog */
export const createCatalogRepository = (catalog) => {
  const doctorsById = new Map(catalog.doctors.map((doctor) => [doctor.id, doctor]));
  const clinicsById = new Map(catalog.clinics.map((clinic) => [clinic.id, clinic]));

  const bySpecialty = new Map();
  for (const doctor of catalog.doctors) {
    const label = normalizeRu(doctor.specialty || '');
    if (!label) continue;
    const bucket = bySpecialty.get(label) || [];
    bucket.push(doctor);
    bySpecialty.set(label, bucket);
  }

  /*
   * В текущем справочнике расписание и признаки вечернего/выходного приёма
   * есть только у учреждений, поэтому время врача проверяется по расписанию
   * его клиники. Это приближение, а не подтверждённое время записи. Без
   * клиники или расписания врач в указанное время недоступен (см. relaxed).
   */
  const clinicByName = new Map();
  for (const clinic of catalog.clinics) {
    const key = normalizeRu(clinic.name);
    if (key) clinicByName.set(key, clinic);
  }

  const scheduleFor = (doctor) => {
    if (doctor.schedule && typeof doctor.schedule === 'object') {
      return doctor.schedule;
    }
    const key = normalizeRu(doctor.clinic || '');
    if (!key) return null;

    const direct = clinicByName.get(key);
    if (direct?.schedule) return direct.schedule;

    for (const [name, clinic] of clinicByName) {
      if (clinic.schedule && (name.includes(key) || key.includes(name))) {
        return clinic.schedule;
      }
    }
    return null;
  };

  /** Ограничения, которые можно ослабить, если под них ничего не нашлось. */
  const RELAXABLE = ['available_after', 'available_before', 'evening', 'weekend', 'wheelchair', 'online_booking'];

  const matchesConstraints = (record, constraints = {}) => {
    const schedule = scheduleFor(record);

    if (constraints.ownership && record.ownership !== constraints.ownership) return false;
    if (constraints.district && record.district !== constraints.district) return false;
    if (constraints.min_rating && (record.rating ?? 0) < constraints.min_rating) return false;
    if (constraints.min_experience_years && (record.experience ?? 0) < constraints.min_experience_years) {
      return false;
    }
    if (constraints.children && record.features?.children !== true) return false;
    if (constraints.wheelchair && record.features?.wheelchair !== true) return false;
    if (constraints.online_booking && record.features?.onlineBooking !== true) return false;
    if (constraints.evening && !(record.features?.eveningReception === true || worksAfter(schedule, '18:00'))) {
      return false;
    }
    if (constraints.weekend && !(record.features?.weekendReception === true || worksWeekend(schedule))) {
      return false;
    }
    if (constraints.available_after && !worksAfter(schedule, constraints.available_after)) return false;
    if (constraints.available_before && !worksBefore(schedule, constraints.available_before)) return false;
    return true;
  };

  /**
   * При пустом результате последовательно ослабляет необязательные
   * ограничения. Ослабленные возвращаются в relaxed и попадают в текст
   * ответа: попросивший приём после 18:00 должен узнать, что это время
   * не подтверждено, а не прийти к закрытой двери.
   */
  const filterWithRelaxation = (records, constraints) => {
    const strict = records.filter((record) => matchesConstraints(record, constraints));
    if (strict.length > 0) {
      return { records: strict, relaxed: [] };
    }

    const relaxed = [];
    const working = { ...constraints };
    for (const key of RELAXABLE) {
      if (!(key in working)) continue;
      delete working[key];
      relaxed.push(key);
      const attempt = records.filter((record) => matchesConstraints(record, working));
      if (attempt.length > 0) {
        return { records: attempt, relaxed };
      }
    }

    return { records: [], relaxed };
  };

  return Object.freeze({
    getDoctor: (id) => doctorsById.get(id) || null,
    getClinic: (id) => clinicsById.get(id) || null,

    hasSpecialty: (key) => Boolean(SPECIALTY_CANON[key]),

    /**
     * Выборка из памяти; при появлении БД тело заменяется запросом PostGIS
     * (ST_DWithin / KNN <->) с той же сигнатурой.
     *
     * @param {object} params
     * @param {string} params.specialty ключ специальности
     * @param {object} [params.constraints]
     * @param {number} [params.limit]
     */
    findBySpecialty({ specialty, constraints = {}, limit = 50 }) {
      const label = normalizeRu(SPECIALTY_CANON[specialty] || '');
      if (!label) return { records: [], relaxed: [], specialtyMissing: true };

      const exact = bySpecialty.get(label) || [];
      // «Детский ЛОР» содержит «лор»: подстрочное совпадение расширяет выборку
      // на профильные и детские варианты той же специальности.
      const related = catalog.doctors.filter((doctor) => normalizeRu(doctor.specialty || '').includes(label));
      // Для ребёнка точного совпадения мало: взрослый «ЛОР» детей не принимает,
      // а «Детский ЛОР» в точную выборку не входит.
      const pool = constraints.children
        ? related
        : exact.length > 0
          ? exact
          : related;

      if (pool.length === 0) {
        // Выдумывать врача нельзя: resultBuilder сообщит, что специальности нет.
        return { records: [], relaxed: [], specialtyMissing: true };
      }

      const filtered = filterWithRelaxation(pool, constraints);
      return { ...filtered, records: filtered.records.slice(0, limit), specialtyMissing: false };
    },

    findClinics({ constraints = {}, limit = 50 }) {
      return catalog.clinics
        .filter((clinic) => {
          if (constraints.ownership && clinic.ownership !== constraints.ownership) return false;
          if (constraints.district && clinic.district !== constraints.district) return false;
          return true;
        })
        .slice(0, limit);
    },

    scheduleForDoctor: scheduleFor,

    findByClinicIds(ids, { constraints = {}, limit = 50 } = {}) {
      const names = new Set(
        ids.map((id) => normalizeRu(clinicsById.get(id)?.name || '')).filter(Boolean),
      );
      if (names.size === 0) return [];

      return catalog.doctors
        .filter((doctor) => {
          const clinicName = normalizeRu(doctor.clinic || '');
          if (!clinicName) return false;
          const hit = [...names].some(
            (name) => clinicName.includes(name) || name.includes(clinicName),
          );
          return hit && matchesConstraints(doctor, constraints);
        })
        .slice(0, limit);
    },

    stats: Object.freeze({ doctors: doctorsById.size, clinics: clinicsById.size }),
  });
};
