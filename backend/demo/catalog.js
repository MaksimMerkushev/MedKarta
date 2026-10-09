/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Доступ к статичной части демо-набора (data/demo/generated.js) и индексы
 * по ней: врачи, филиалы, услуги, цены. Набор не меняется во время работы
 * сервера; меняются только состояния слотов — они в bookingStore.
 */

import { SPECIALTY_CANON } from '../../shared/specialties.js';

/** Текст модуля data/demo/generated.js. */
export const renderGeneratedModule = (catalog) => `/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * СГЕНЕРИРОВАНО: npm run demo:generate (backend/demo/generator.js, seed ${JSON.stringify(catalog.meta.seed)}).
 * Не править вручную — правки пропадут при следующей генерации.
 *
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. Клиники, врачи, цены, графики и программы ДМС
 * вымышлены и не являются предложениями реальных медицинских организаций
 * или страховых компаний.
 */

export const demoCatalog = ${JSON.stringify(catalog, null, 2)};
`;

/**
 * Индексы набора для поиска и записи.
 * @param {object} catalog результат generateDemoCatalog / demoCatalog
 */
export const indexDemoCatalog = (catalog) => {
  const branches = new Map();
  for (const clinic of catalog.clinics) {
    for (const branch of clinic.branches) branches.set(branch.id, { clinic, branch });
  }
  const doctors = new Map(catalog.doctors.map((doctor) => [doctor.id, doctor]));
  const services = new Map(catalog.services.map((service) => [service.id, service]));
  const prices = new Map(catalog.prices.map((price) => [`${price.branchId}|${price.serviceId}`, price.price]));
  const plans = new Map(catalog.insurance.plans.map((plan) => [plan.id, plan]));

  return Object.freeze({
    catalog,
    branches,
    doctors,
    services,
    plans,
    priceOf: (branchId, serviceId) => prices.get(`${branchId}|${serviceId}`) ?? null,
    specialtyLabel: (key) => SPECIALTY_CANON[key] || key,
  });
};

let cached = null;

/** Демо-набор из data/demo/generated.js (один раз на процесс). */
export const getDemoCatalog = async () => {
  if (!cached) {
    const { demoCatalog } = await import('../../data/demo/generated.js');
    cached = indexDemoCatalog(demoCatalog);
  }
  return cached;
};
