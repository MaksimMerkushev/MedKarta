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

import { createHash } from 'node:crypto';

import { parseOpeningHours } from '../../shared/openingHours.js';
import { validatePrivateCatalog } from '../../shared/privateCatalog.js';
import { sameSite } from './fetchSource.js';

const shortHash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 10);

/* Сайт со страницы принимается, только если он того же сайта, что и источник. */
const trustedWebsite = (candidate, source) => {
  if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate) && source.url && sameSite(candidate, source.url)) return candidate;
  if (typeof source.website === 'string' && /^https?:\/\//i.test(source.website)) return source.website;
  try {
    return source.url ? new URL(source.url).origin : '';
  } catch {
    return '';
  }
};

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
  const doctorsByIdentity = new Map();
  const usedIds = new Set();
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
    if (snapshot.approved === false) {
      skipped.push(`${source.id}: новый источник ещё не подтверждён (npm run data:review)`);
      continue;
    }

    /*
     * Координаты из описания источника главнее страницы: их ставил человек.
     * Страница может написать что угодно — в том числе 0 или 1e308.
     */
    const lat = source.geo?.lat ?? page.lat ?? null;
    const lng = source.geo?.lng ?? page.lng ?? null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      skipped.push(`${source.id}: нет координат — укажите geo в описании источника`);
      continue;
    }

    if (!clinics.has(source.clinicId)) {
      clinics.set(source.clinicId, {
        id: source.clinicId,
        name: source.clinicName || page.name,
        ownership: 'Частная',
        website: trustedWebsite(page.website, source),
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
      /*
       * Один и тот же врач в двух филиалах клиники — одна запись с двумя
       * филиалами. Разные люди с одинаковым транслитом («Иванова Мария» и
       * «Иванова-Мария», «ц» и «тс») раньше сливались в одну запись; теперь
       * врач узнаётся по имени и специальности, а id при совпадении
       * транслита получает суффикс.
       */
      if (!doctor.specialty) continue;
      const identity = `${source.clinicId}|${doctor.name}|${doctor.specialty}`;
      const existing = doctorsByIdentity.get(identity);
      if (existing) {
        if (!existing.branchIds.includes(source.branchId)) existing.branchIds.push(source.branchId);
        continue;
      }
      /*
       * id — непрозрачный хэш, а не транслит имени: он попадает в адрес
       * страницы (?doc=) и в события аналитики, а там имя врача рядом со
       * специальностью (например, психиатр) ни к чему.
       */
      let id = `${source.clinicId.slice(0, 48)}-d${shortHash(identity)}`;
      for (let attempt = 1; usedIds.has(id); attempt += 1) id = `${source.clinicId.slice(0, 48)}-d${shortHash(`${identity}|${attempt}`)}`;
      usedIds.add(id);
      const record = {
        id,
        name: doctor.name,
        specialty: doctor.specialty,
        branchIds: [source.branchId],
        ...(doctor.hours && parseOpeningHours(doctor.hours) ? { hours: doctor.hours } : {}),
      };
      doctorsByIdentity.set(identity, record);
      catalog.doctors.push(record);
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
