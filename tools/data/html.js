/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Разбор страниц сайтов клиник без внешних зависимостей.
 *
 * Два источника структуры, которые встречаются на сайтах клиник чаще всего:
 *   - разметка schema.org в JSON-LD (MedicalClinic, Physician, …) — её
 *     ставят ради поисковиков, и она описывает адрес, часы, телефон, врачей;
 *   - таблица прайса: строка = услуга, последняя ячейка с числом = цена.
 *
 * Разбор консервативный: всё, что не удалось однозначно понять, не
 * «додумывается», а отдаётся наверх как нераспознанное — на ручную проверку.
 */

import { matchService, normalizePrice } from '../../shared/services.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–' };

export const decodeEntities = (text) =>
  String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);

/** Видимый текст страницы: без скриптов, стилей и тегов. */
export const htmlToText = (html) =>
  decodeEntities(
    String(html ?? '')
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const typesOf = (node) => asArray(node?.['@type']).map(String);

const CLINIC_TYPES = new Set(['MedicalClinic', 'MedicalOrganization', 'Hospital', 'Dentist', 'MedicalBusiness', 'Physician']);

const textOf = (value) => (typeof value === 'string' ? value.trim() : value && typeof value === 'object' && typeof value.name === 'string' ? value.name.trim() : '');

const addressOf = (address) => {
  if (typeof address === 'string') return address.trim();
  if (!address || typeof address !== 'object') return '';
  return [address.addressLocality, address.streetAddress].filter(Boolean).join(', ').trim();
};

const hoursOf = (value) => {
  const list = asArray(value).filter((item) => typeof item === 'string' && item.trim());
  return list.length > 0 ? list.join('; ') : '';
};

/**
 * Все узлы JSON-LD страницы. Битый блок пропускается: один сломанный
 * скрипт на странице не должен обнулять остальные.
 */
export const extractJsonLd = (html) => {
  const nodes = [];
  const pattern = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html ?? '').matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      for (const item of asArray(parsed)) {
        nodes.push(...asArray(item?.['@graph']).concat(item?.['@graph'] ? [] : [item]));
      }
    } catch {
      // Битый JSON-LD — не наша ошибка и не повод терять страницу.
    }
  }
  return nodes.filter((node) => node && typeof node === 'object');
};

/**
 * Клиника и врачи из JSON-LD.
 *
 * @returns {{clinic: object|null, doctors: object[]}}
 */
export const parseJsonLd = (html) => {
  const nodes = extractJsonLd(html);
  const clinicNode = nodes.find((node) => typesOf(node).some((type) => CLINIC_TYPES.has(type) && type !== 'Physician'));

  const clinic = clinicNode
    ? {
      name: textOf(clinicNode.name),
      address: addressOf(clinicNode.address),
      phone: textOf(clinicNode.telephone),
      hours: hoursOf(clinicNode.openingHours),
      website: textOf(clinicNode.url),
      lat: Number.isFinite(Number(clinicNode.geo?.latitude)) ? Number(clinicNode.geo.latitude) : null,
      lng: Number.isFinite(Number(clinicNode.geo?.longitude)) ? Number(clinicNode.geo.longitude) : null,
    }
    : null;

  // Врачи — отдельные узлы Physician или перечень employee/member клиники.
  const doctorNodes = [
    ...nodes.filter((node) => typesOf(node).includes('Physician') && node !== clinicNode),
    ...asArray(clinicNode?.employee),
    ...asArray(clinicNode?.member),
  ];
  const seen = new Set();
  const doctors = [];
  for (const node of doctorNodes) {
    const name = textOf(node?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    doctors.push({
      name,
      specialty: textOf(asArray(node.medicalSpecialty)[0]) || textOf(node.jobTitle),
      hours: hoursOf(node.openingHours),
    });
  }

  return { clinic, doctors };
};

/**
 * Прайс из HTML-таблиц: название услуги — первая ячейка, цена — последняя
 * ячейка, похожая на цену. Строки без цены (заголовки разделов) пропускаются.
 *
 * @returns {Array<{name: string, price: object, serviceId: string|null}>}
 */
export const parsePriceTables = (html) => {
  const rows = [];
  for (const table of String(html ?? '').matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    for (const row of table[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
      const cells = [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => htmlToText(cell[1]));
      if (cells.length < 2) continue;
      const name = cells[0].replace(/\s+/g, ' ').trim();
      const priceCell = [...cells.slice(1)].reverse().find((cell) => normalizePrice(cell));
      const price = priceCell ? normalizePrice(priceCell) : null;
      if (!name || !price) continue;
      rows.push({ name, price, serviceId: matchService(name) });
    }
  }
  return rows;
};

/** Ключ имени для сравнения: регистр, «ё», лишние пробелы и инициалы не важны. */
export const nameKey = (name) =>
  String(name ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Есть ли врач на странице. Совпадение — по фамилии и имени целиком
 * («Иванова Мария»), отчество необязательно: на сайтах его часто сокращают.
 * Одна фамилия не годится — однофамильцы на странице отделения обычное дело.
 */
export const findPersonOnPage = (pageText, fullName) => {
  const [surname, firstName] = nameKey(fullName).split(' ');
  if (!surname || !firstName) return false;
  const text = ` ${nameKey(pageText)} `;
  return text.includes(` ${surname} ${firstName}`) || text.includes(` ${firstName} ${surname} `)
    || new RegExp(` ${surname} ${firstName[0]}(?: |$)`, 'u').test(text);
};
