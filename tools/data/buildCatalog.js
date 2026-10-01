/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сборка справочника частных клиник из принятых снимков сборщика.
 *
 * Снимок — то, что прочитано со страницы источника и прошло проверку;
 * описание источника (data/sources.json) добавляет то, чего на странице нет
 * или чему нельзя верить: id клиники и филиала, район, координаты (если
 * их нет в разметке). Результат проходит ту же проверку, что и ручные
 * данные (shared/privateCatalog.js), и только потом попадает в приложение.
 */

import { parseOpeningHours } from '../../shared/openingHours.js';
import { validatePrivateCatalog } from '../../shared/privateCatalog.js';

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const slugify = (value) =>
  String(value ?? '')
    .toLowerCase()
    .split('')
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * @param {object[]} sources описания источников (только kind: clinic-site)
 * @param {object[]} snapshots снимки из хранилища
 * @param {{includeDemo?: boolean}} [options]
 * @returns {{catalog: object, errors: string[], skipped: string[]}}
 */
export const buildCatalogFromSnapshots = (sources, snapshots, { includeDemo = false } = {}) => {
  const bySource = new Map(snapshots.map((snapshot) => [snapshot.sourceId, snapshot]));
  const catalog = { meta: { source: 'collected', verifiedAt: null }, clinics: [], doctors: [], prices: [] };
  const skipped = [];
  const clinics = new Map();
  let oldest = null;

  for (const source of sources) {
    if (source.kind !== 'clinic-site') continue;
    if (source.demo && !includeDemo) continue;
    const snapshot = bySource.get(source.id);
    const page = snapshot?.records?.clinic;
    if (!page) {
      skipped.push(`${source.id}: нет снимка или на странице не нашлось клиники`);
      continue;
    }

    const lat = page.lat ?? source.geo?.lat ?? null;
    const lng = page.lng ?? source.geo?.lng ?? null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push(`${source.id}: нет координат — укажите geo в описании источника`);
      continue;
    }

    if (!clinics.has(source.clinicId)) {
      clinics.set(source.clinicId, {
        id: source.clinicId,
        name: source.clinicName || page.name,
        ownership: 'Частная',
        website: page.website || source.website || '',
        facilityType: source.facilityType || 'Клиника',
        branches: [],
      });
    }
    clinics.get(source.clinicId).branches.push({
      id: source.branchId,
      name: source.branchName || '',
      district: source.district || '',
      address: page.address || source.address || '',
      lat,
      lng,
      phone: page.phone || '',
      // Часы в разметке бывают в формате, который мы не разбираем, — тогда без часов.
      hours: page.hours && parseOpeningHours(page.hours) ? page.hours : '',
      features: source.features || {},
      sourceUrl: source.url || null,
      verifiedAt: snapshot.verifiedAt || null,
    });
    if (snapshot.verifiedAt && (!oldest || snapshot.verifiedAt < oldest)) oldest = snapshot.verifiedAt;

    for (const doctor of snapshot.records.doctors || []) {
      const id = `${source.clinicId}-${slugify(doctor.name)}`.slice(0, 64).replace(/-+$/, '');
      const existing = catalog.doctors.find((item) => item.id === id);
      if (existing) {
        existing.branchIds.push(source.branchId);
        continue;
      }
      if (!doctor.specialty) continue;
      catalog.doctors.push({
        id,
        name: doctor.name,
        specialty: doctor.specialty,
        branchIds: [source.branchId],
        ...(doctor.hours && parseOpeningHours(doctor.hours) ? { hours: doctor.hours } : {}),
      });
    }

    for (const price of snapshot.records.prices || []) {
      catalog.prices.push({ branchId: source.branchId, serviceId: price.serviceId, price: price.price, observedAt: snapshot.verifiedAt || undefined });
    }
  }

  catalog.clinics = [...clinics.values()];
  // Дата справочника — самая старая из дат проверки: честнее, чем самая свежая.
  catalog.meta.verifiedAt = oldest;
  return { catalog, errors: validatePrivateCatalog(catalog), skipped };
};
