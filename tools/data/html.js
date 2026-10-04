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

/*
 * Код символа из сущности страницы. Значения вне Юникода («&#x110000;»)
 * раньше бросали RangeError и обрывали весь прогон сборщика; суррогаты и
 * управляющие символы превращаются в знак замены и пробел.
 */
const codePointToText = (value) => {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\ufffd';
  if (value < 0x20 || (value >= 0x7f && value < 0xa0)) return ' ';
  return String.fromCodePoint(value);
};

export const decodeEntities = (text) =>
  String(text ?? '')
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, hex) => codePointToText(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,9});/g, (_, dec) => codePointToText(Number(dec)))
    .replace(/&([a-z]{2,8});/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);

/**
 * Текст со страницы, пригодный для справочника и для терминала: без
 * управляющих символов (ESC-последовательности переписывали строки в
 * выводе data:review и прятали настоящие изменения от проверяющего), без
 * знаков направления текста и не длиннее max.
 */
export const cleanText = (value, max = 200) =>
  String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article']);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/*
 * Разбор тегов одним проходом по indexOf. Прежние регулярные выражения
 * (`<[^>]+>`, `\s*\n\s*`) на враждебной странице работали квадратично и
 * хуже: 300 КБ из «<» разбирались 40 секунд, три мегабайта — часами.
 */
const tagNameAt = (lower, index) => {
  let cursor = index + 1;
  if (lower[cursor] === '/') cursor += 1;
  let name = '';
  while (cursor < lower.length && name.length < 16) {
    const char = lower[cursor];
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      name += char;
      cursor += 1;
    } else break;
  }
  return name;
};

/** Видимый текст страницы: без скриптов, стилей и тегов. */
export const htmlToText = (html) => {
  const source = String(html ?? '');
  const lower = source.toLowerCase();
  const parts = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open === -1) {
      parts.push(source.slice(index));
      break;
    }
    parts.push(source.slice(index, open));
    const close = source.indexOf('>', open + 1);
    if (close === -1) {
      // Незакрытый «<» — дальше просто текст, как читает его браузер.
      parts.push(source.slice(open));
      break;
    }
    const closing = source[open + 1] === '/';
    const name = tagNameAt(lower, open);
    if (!closing && RAW_TEXT_TAGS.has(name)) {
      const end = lower.indexOf(`</${name}`, close + 1);
      if (end === -1) break;
      const endClose = source.indexOf('>', end);
      parts.push(' ');
      index = endClose === -1 ? source.length : endClose + 1;
      continue;
    }
    parts.push(name === 'br' || (closing && BLOCK_TAGS.has(name)) ? '\n' : ' ');
    index = close + 1;
  }
  return decodeEntities(parts.join(''))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
};

/** Ячейки строки таблицы (td и th) в порядке документа. */
const tableCells = (rowHtml, limit = 50) => {
  const source = String(rowHtml ?? '');
  const lower = source.toLowerCase();
  const cells = [];
  let index = 0;
  while (cells.length < limit) {
    const open = lower.indexOf('<t', index);
    if (open === -1) break;
    const kind = lower[open + 2];
    const after = lower[open + 3];
    if ((kind !== 'd' && kind !== 'h') || (after && /[a-z0-9]/.test(after))) {
      index = open + 2;
      continue;
    }
    const tagEnd = source.indexOf('>', open);
    if (tagEnd === -1) break;
    const end = lower.indexOf(`</t${kind}`, tagEnd + 1);
    if (end === -1) break;
    cells.push(source.slice(tagEnd + 1, end));
    index = end + 4;
  }
  return cells;
};

/** Содержимое элементов name внутри html: [{attributes, inner}] — одним проходом. */
const elements = (html, name, limit = 5_000) => {
  const source = String(html ?? '');
  const lower = source.toLowerCase();
  const found = [];
  let index = 0;
  while (found.length < limit) {
    const open = lower.indexOf(`<${name}`, index);
    if (open === -1) break;
    const after = lower[open + name.length + 1];
    if (after && /[a-z0-9]/.test(after)) {
      index = open + 1;
      continue;
    }
    const tagEnd = source.indexOf('>', open);
    if (tagEnd === -1) break;
    const end = lower.indexOf(`</${name}`, tagEnd + 1);
    if (end === -1) break;
    found.push({ attributes: source.slice(open + name.length + 1, tagEnd).slice(0, 2_000), inner: source.slice(tagEnd + 1, end) });
    index = end + name.length + 2;
  }
  return found;
};

const asArray = (value) => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

const typesOf = (node) => asArray(node?.['@type']).map(String);

const CLINIC_TYPES = new Set(['MedicalClinic', 'MedicalOrganization', 'Hospital', 'Dentist', 'MedicalBusiness', 'Physician']);

const textOf = (value, max = 200) =>
  cleanText(typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.name === 'string' ? value.name : '', max);

/* Пустая строка в geo раньше превращалась в 0 — точку в Гвинейском заливе. */
const coordinateOf = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^\s*-?\d{1,3}(?:\.\d+)?\s*$/.test(value)) return null;
  return Number(value);
};

const addressOf = (address) => {
  if (typeof address === 'string') return cleanText(address, 300);
  if (!address || typeof address !== 'object') return '';
  return cleanText([address.addressLocality, address.streetAddress].filter((part) => typeof part === 'string').join(', '), 300);
};

const hoursOf = (value) => {
  const list = asArray(value).filter((item) => typeof item === 'string' && item.trim()).slice(0, 14);
  return list.length > 0 ? cleanText(list.join('; '), 300) : '';
};

/**
 * Все узлы JSON-LD страницы. Битый блок пропускается: один сломанный
 * скрипт на странице не должен обнулять остальные.
 */
export const extractJsonLd = (html) => {
  const nodes = [];
  for (const { attributes, inner } of elements(html, 'script', 200)) {
    if (!/type\s*=\s*["']?application\/ld\+json/i.test(attributes)) continue;
    try {
      const parsed = JSON.parse(inner.trim());
      for (const item of asArray(parsed)) {
        nodes.push(...asArray(item?.['@graph']).concat(item?.['@graph'] ? [] : [item]));
      }
    } catch {
      // Битый JSON-LD — не наша ошибка и не повод терять страницу.
    }
  }
  return nodes.filter((node) => node && typeof node === 'object').slice(0, 5_000);
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
      phone: textOf(clinicNode.telephone, 40),
      hours: hoursOf(clinicNode.openingHours),
      website: textOf(clinicNode.url, 300),
      lat: coordinateOf(clinicNode.geo?.latitude),
      lng: coordinateOf(clinicNode.geo?.longitude),
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
      specialty: textOf(asArray(node.medicalSpecialty)[0], 120) || textOf(node.jobTitle, 120),
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
  for (const table of elements(html, 'table', 200)) {
    for (const row of elements(table.inner, 'tr', 5_000)) {
      const cells = tableCells(row.inner).map((cell) => htmlToText(cell));
      if (cells.length < 2) continue;
      const name = cleanText(cells[0], 200);
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
