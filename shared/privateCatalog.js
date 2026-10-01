/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Справочник частных клиник: клиника → филиалы → врачи → цены услуг.
 *
 * Почему филиал, а не клиника: адрес, часы, телефон и — главное — покрытие
 * ДМС привязаны к конкретному филиалу. «Клиника X входит в мой ДМС» почти
 * никогда не правда целиком: в программу входят перечисленные адреса.
 *
 * Интерфейс и сервер работают с плоскими карточками (врач в филиале,
 * филиал как учреждение), поэтому здесь же — проверка структуры и
 * разворачивание в карточки. Ссылки между записями проверяются: врач
 * в несуществующем филиале или цена несуществующей услуги — ошибка данных,
 * а не «пустое поле».
 */

import { parseOpeningHours } from './openingHours.js';
import { normalizePrice, SERVICE_BY_ID, serviceName } from './services.js';
import { isPediatricRecord, specialtyCode } from './specialties.js';

const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Проверяет справочник. Возвращает список ошибок — пустой, если всё верно.
 * Ошибки на русском: их читает человек, который правит данные.
 */
export const validatePrivateCatalog = (catalog) => {
  const errors = [];
  if (!catalog || typeof catalog !== 'object') return ['справочник не объект'];

  const branchIds = new Set();
  const clinicIds = new Set();
  for (const clinic of catalog.clinics || []) {
    if (!ID.test(clinic.id || '')) errors.push(`клиника: неверный id «${clinic.id}»`);
    if (clinicIds.has(clinic.id)) errors.push(`клиника ${clinic.id}: повтор id`);
    clinicIds.add(clinic.id);
    if (!clinic.name) errors.push(`клиника ${clinic.id}: нет названия`);
    if (!Array.isArray(clinic.branches) || clinic.branches.length === 0) errors.push(`клиника ${clinic.id}: нет филиалов`);
    for (const branch of clinic.branches || []) {
      if (!ID.test(branch.id || '')) errors.push(`филиал: неверный id «${branch.id}»`);
      if (branchIds.has(branch.id)) errors.push(`филиал ${branch.id}: повтор id`);
      branchIds.add(branch.id);
      if (!Number.isFinite(branch.lat) || !Number.isFinite(branch.lng)) errors.push(`филиал ${branch.id}: нет координат`);
      if (!branch.address) errors.push(`филиал ${branch.id}: нет адреса`);
      if (branch.hours && !parseOpeningHours(branch.hours)) errors.push(`филиал ${branch.id}: часы не разбираются «${branch.hours}»`);
    }
  }

  const doctorIds = new Set();
  for (const doctor of catalog.doctors || []) {
    if (!ID.test(doctor.id || '')) errors.push(`врач: неверный id «${doctor.id}»`);
    if (doctorIds.has(doctor.id)) errors.push(`врач ${doctor.id}: повтор id`);
    doctorIds.add(doctor.id);
    if (!doctor.name || !doctor.specialty) errors.push(`врач ${doctor.id}: нет имени или специальности`);
    if (!Array.isArray(doctor.branchIds) || doctor.branchIds.length === 0) errors.push(`врач ${doctor.id}: не привязан к филиалу`);
    for (const branchId of doctor.branchIds || []) {
      if (!branchIds.has(branchId)) errors.push(`врач ${doctor.id}: нет филиала ${branchId}`);
    }
    if (doctor.hours && !parseOpeningHours(doctor.hours)) errors.push(`врач ${doctor.id}: часы не разбираются «${doctor.hours}»`);
  }

  for (const [index, price] of (catalog.prices || []).entries()) {
    if (!branchIds.has(price.branchId)) errors.push(`цена #${index}: нет филиала ${price.branchId}`);
    if (!SERVICE_BY_ID[price.serviceId]) errors.push(`цена #${index}: нет услуги ${price.serviceId}`);
    if (!normalizePrice(price.price)) errors.push(`цена #${index}: неверная цена`);
    if (price.observedAt && !DAY.test(price.observedAt)) errors.push(`цена #${index}: неверная дата`);
  }

  if (catalog.meta?.verifiedAt && !DAY.test(catalog.meta.verifiedAt)) errors.push('meta.verifiedAt: неверная дата');
  return errors;
};

const priceLabelEntry = (serviceId, price) => {
  const normalized = normalizePrice(price);
  if (!normalized) return null;
  return {
    serviceId,
    service: serviceName(serviceId),
    minRub: normalized.min,
    maxRub: normalized.max,
    from: Boolean(normalized.from),
  };
};

/**
 * Разворачивает справочник в карточки интерфейса.
 *
 * Карточка учреждения — на каждый филиал; карточка врача — на каждую пару
 * «врач × филиал» (врач, принимающий в двух филиалах, виден на карте в обоих
 * местах). У карточки есть clinicId и branchId — по ним считается покрытие
 * ДМС, — и consultPrice: минимальная цена первичного приёма для сортировки.
 *
 * @returns {object[]} карточки в формате справочника приложения
 */
export const flattenPrivateCatalog = (catalog) => {
  if (!catalog || validatePrivateCatalog(catalog).length > 0) return [];

  const meta = catalog.meta || {};
  const branches = new Map();
  for (const clinic of catalog.clinics) {
    for (const branch of clinic.branches) branches.set(branch.id, { clinic, branch });
  }

  const pricesByBranch = new Map();
  for (const price of catalog.prices || []) {
    const entry = priceLabelEntry(price.serviceId, price.price);
    if (!entry) continue;
    if (!pricesByBranch.has(price.branchId)) pricesByBranch.set(price.branchId, []);
    pricesByBranch.get(price.branchId).push({ ...entry, observedAt: price.observedAt || meta.verifiedAt || null });
  }

  const common = (clinic, branch) => ({
    clinic: `${clinic.name}${branch.name ? ` — ${branch.name}` : ''}`,
    clinicId: clinic.id,
    branchId: branch.id,
    address: branch.address,
    district: branch.district || '',
    ownership: clinic.ownership || 'Частная',
    lat: branch.lat,
    lng: branch.lng,
    phone: branch.phone || clinic.phone || '',
    website: branch.bookingUrl || clinic.website || '',
    source: meta.source || 'private',
    sourceUrl: branch.sourceUrl || clinic.sourceUrl || null,
    verifiedAt: branch.verifiedAt || clinic.verifiedAt || meta.verifiedAt || null,
    demo: meta.source === 'demo',
  });

  const items = [];

  for (const { clinic, branch } of branches.values()) {
    const branchPrices = pricesByBranch.get(branch.id) || [];
    const branchDoctors = catalog.doctors.filter((doctor) => doctor.branchIds.includes(branch.id));
    const specialties = [...new Set(branchDoctors.map((doctor) => doctor.specialty))].sort((a, b) => a.localeCompare(b, 'ru'));
    items.push({
      ...common(clinic, branch),
      id: branch.id,
      name: `${clinic.name}${branch.name ? ` — ${branch.name}` : ''}`,
      specialty: branch.facilityType || clinic.facilityType || 'Клиника',
      facilityType: branch.facilityType || clinic.facilityType || 'Клиника',
      hours: branch.hours || '',
      schedule: parseOpeningHours(branch.hours) || null,
      services: specialties,
      servicePrices: branchPrices
        .filter((price) => SERVICE_BY_ID[price.serviceId]?.visit !== 'repeat')
        .slice(0, 8),
      features: {
        ...(branch.features || {}),
        children: branchDoctors.some((doctor) => isPediatricRecord(doctor)),
      },
      description: branch.description || clinic.description || '',
      rating: 0,
      experience: 0,
      consultPrice: null,
    });
  }

  for (const doctor of catalog.doctors) {
    const key = specialtyCode(doctor.specialty);
    for (const branchId of doctor.branchIds) {
      const { clinic, branch } = branches.get(branchId);
      const own = (pricesByBranch.get(branchId) || []).filter((price) => {
        const service = SERVICE_BY_ID[price.serviceId];
        return service?.specialty === key || (doctor.serviceIds || []).includes(price.serviceId);
      });
      const firstVisit = own.filter((price) => SERVICE_BY_ID[price.serviceId]?.visit === 'first');
      const hours = doctor.hours || branch.hours || '';
      items.push({
        ...common(clinic, branch),
        id: `${doctor.id}--${branch.id}`,
        doctorId: doctor.id,
        name: doctor.name,
        specialty: doctor.specialty,
        hours,
        schedule: parseOpeningHours(hours) || null,
        services: [doctor.specialty, ...own.map((price) => price.service).filter((name) => name)].filter((value, index, list) => list.indexOf(value) === index),
        servicePrices: own,
        features: {
          ...(branch.features || {}),
          children: isPediatricRecord(doctor),
        },
        experience: Number(doctor.experienceYears) || 0,
        rating: 0,
        description: doctor.description || '',
        consultPrice: firstVisit.length > 0 ? Math.min(...firstVisit.map((price) => price.minRub)) : null,
      });
    }
  }

  return items;
};
