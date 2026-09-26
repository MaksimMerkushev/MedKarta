/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Доступ к справочным данным.
 *
 * РАЗДЕЛЕНИЕ ДАННЫХ (см. docs/privacy-architecture.md):
 *   A. Справочник — врачи, клиники, специальности, расписания. Только чтение,
 *      доступен Executor'у. Это единственная категория, к которой обращается
 *      данный модуль.
 *   B. Чувствительные данные — пациенты, контакты, записи, медицинские
 *      сведения. В проекте сейчас отсутствуют; когда появятся, они обязаны
 *      жить за отдельным репозиторием и отдельной ролью БД, и этот модуль
 *      не должен получать к ним доступ.
 *   C. Эфемерные данные — местоположение, состояние диалога, соответствия
 *      токенов: storage/tokenVault.js.
 *
 * Планировщик (внешняя модель) не имеет доступа ни к одному из репозиториев:
 * он не получает ни результатов выборки, ни их размера.
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
 * Проверяет, что приём идёт и ПОСЛЕ заданного времени.
 * Отсутствие расписания трактуется как «не подтверждено»: запись НЕ проходит
 * фильтр по времени. Обратное поведение показывало бы пользователю врача,
 * которого может не быть на месте.
 *
 * Граница строгая: клиника, закрывающаяся в 18:00, «после 18:00» не
 * принимает (раньше проходила — 15 клиник справочника). Интервалы — все
 * интервалы дня, с переходом через полночь (см. scheduleIntervals).
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

/**
 * Репозиторий справочника.
 *
 * @param {{doctors: Array, clinics: Array}} catalog
 */
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
   * ДОПУЩЕНИЕ О ДАННЫХ (проверено на текущем справочнике).
   * У записей врачей нет ни собственного расписания, ни признаков вечернего
   * и выходного приёма — эти сведения есть только у учреждений. Поэтому
   * ограничение по времени проверяется по расписанию клиники, где врач ведёт
   * приём. Это приближение: индивидуальный график врача может отличаться,
   * и подавать результат как подтверждённое время записи нельзя.
   * Если клиника не найдена или расписания нет, врач НЕ считается доступным
   * в указанное время — и об этом честно сообщается через relaxed.
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
   * Применяет фильтры, при пустом результате последовательно ослабляя
   * необязательные ограничения.
   *
   * Молчаливо игнорировать ограничение нельзя: пользователь, попросивший
   * приём после 18:00, должен узнать, что подтвердить это время не удалось,
   * а не прийти к закрытой двери. Список ослабленных условий возвращается
   * наверх и попадает в текст ответа.
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

    /** Существует ли такая специальность в справочнике. */
    hasSpecialty: (key) => Boolean(SPECIALTY_CANON[key]),

    /**
     * Кандидаты по специальности с фильтрами.
     *
     * ЗДЕСЬ БУДЕТ POSTGIS. Сейчас это выборка из памяти; при появлении БД
     * тело метода заменяется запросом с ST_DWithin / KNN-оператором <->,
     * а сигнатура и всё, что выше по стеку, остаются прежними.
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
      const pool = exact.length > 0
        ? exact
        : catalog.doctors.filter((doctor) => normalizeRu(doctor.specialty || '').includes(label));

      if (pool.length === 0) {
        // Специальности нет в справочнике. Выдумывать врача нельзя —
        // возвращаем честный признак, resultBuilder сообщит об этом.
        return { records: [], relaxed: [], specialtyMissing: true };
      }

      const filtered = filterWithRelaxation(pool, constraints);
      return { ...filtered, records: filtered.records.slice(0, limit), specialtyMissing: false };
    },

    /** Учреждения по фильтрам — для FIND_CLINIC. */
    findClinics({ constraints = {}, limit = 50 }) {
      return catalog.clinics
        .filter((clinic) => {
          if (constraints.ownership && clinic.ownership !== constraints.ownership) return false;
          if (constraints.district && clinic.district !== constraints.district) return false;
          return true;
        })
        .slice(0, limit);
    },

    /** Врачи конкретного учреждения. */
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
