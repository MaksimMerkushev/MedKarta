/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сборщик данных с отслеживанием изменений.
 *
 *   источник → загрузка → разбор → сравнение с прошлым снимком
 *            → безопасные изменения применяются сами
 *            → рискованные — в очередь ручной проверки
 *            → снимок с датой проверки
 *
 * Что считается рискованным, решает classifyChange. Главная защита —
 * от тихой порчи справочника: врач «пропал», потому что сайт поменял
 * вёрстку; цена «выросла втрое», потому что парсер взял не ту ячейку.
 * Такие изменения человек видит до того, как их увидит пользователь.
 */

import { createHash } from 'node:crypto';

import { serviceName } from '../../shared/services.js';
import { htmlToText, nameKey, parseJsonLd, parsePriceTables, findPersonOnPage } from './html.js';

export const EMPTY_RECORDS = Object.freeze({ clinic: null, doctors: [], prices: [], unmatched: [] });

/** Насколько может сдвинуться цена без ручной проверки. */
export const PRICE_AUTO_TOLERANCE = 0.2;
/** Доля пропавших записей, после которой весь прогон считается подозрительным. */
export const MASS_CHANGE_SHARE = 0.5;

const CLINIC_AUTO_FIELDS = new Set(['phone', 'hours', 'website']);

export const kazanDay = (date) => new Date(date.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** Разбор страницы выбранными парсерами. */
export const extractRecords = (body, parsers = ['jsonld', 'price-table']) => {
  const records = { clinic: null, doctors: [], prices: [], unmatched: [] };
  if (parsers.includes('jsonld')) {
    const { clinic, doctors } = parseJsonLd(body);
    records.clinic = clinic;
    records.doctors = doctors;
  }
  if (parsers.includes('price-table')) {
    const seen = new Set();
    for (const row of parsePriceTables(body)) {
      if (row.serviceId) {
        // Первая строка услуги главнее: дубли в прайсе — обычно акции ниже по странице.
        if (seen.has(row.serviceId)) continue;
        seen.add(row.serviceId);
        records.prices.push({ serviceId: row.serviceId, name: row.name, price: row.price });
      } else {
        records.unmatched.push({ name: row.name, price: row.price });
      }
    }
  }
  return records;
};

const isEmpty = (records) => !records.clinic && records.doctors.length === 0 && records.prices.length === 0;

const priceValue = (price) => price?.min ?? null;

/**
 * Изменения между снимками.
 *
 * @returns {Array<{kind: string, key: string, change: 'added'|'removed'|'changed',
 *   field?: string, before?: any, after?: any}>}
 */
export const diffRecords = (previous = EMPTY_RECORDS, next = EMPTY_RECORDS) => {
  const changes = [];

  if (!previous.clinic && next.clinic) {
    changes.push({ kind: 'clinic', key: 'clinic', change: 'added', after: next.clinic });
  } else if (previous.clinic && next.clinic) {
    for (const field of ['name', 'address', 'phone', 'hours', 'website']) {
      if ((previous.clinic[field] || '') !== (next.clinic[field] || '')) {
        changes.push({ kind: 'clinic', key: 'clinic', change: 'changed', field, before: previous.clinic[field] || '', after: next.clinic[field] || '' });
      }
    }
    const moved = previous.clinic.lat !== next.clinic.lat || previous.clinic.lng !== next.clinic.lng;
    if (moved && next.clinic.lat !== null) {
      changes.push({ kind: 'clinic', key: 'clinic', change: 'changed', field: 'geo', before: [previous.clinic.lat, previous.clinic.lng], after: [next.clinic.lat, next.clinic.lng] });
    }
  }

  const prevDoctors = new Map(previous.doctors.map((doctor) => [nameKey(doctor.name), doctor]));
  const nextDoctors = new Map(next.doctors.map((doctor) => [nameKey(doctor.name), doctor]));
  for (const [key, doctor] of nextDoctors) {
    const before = prevDoctors.get(key);
    if (!before) {
      changes.push({ kind: 'doctor', key, change: 'added', after: doctor });
      continue;
    }
    for (const field of ['specialty', 'hours']) {
      if ((before[field] || '') !== (doctor[field] || '')) {
        changes.push({ kind: 'doctor', key, name: doctor.name, change: 'changed', field, before: before[field] || '', after: doctor[field] || '' });
      }
    }
  }
  for (const [key, doctor] of prevDoctors) {
    if (!nextDoctors.has(key)) changes.push({ kind: 'doctor', key, change: 'removed', before: doctor });
  }

  const prevPrices = new Map(previous.prices.map((price) => [price.serviceId, price]));
  const nextPrices = new Map(next.prices.map((price) => [price.serviceId, price]));
  for (const [key, price] of nextPrices) {
    const before = prevPrices.get(key);
    if (!before) changes.push({ kind: 'price', key, change: 'added', after: price });
    else if (priceValue(before.price) !== priceValue(price.price) || Boolean(before.price.from) !== Boolean(price.price.from)) {
      changes.push({ kind: 'price', key, change: 'changed', field: 'price', before: before.price, after: price.price });
    }
  }
  for (const [key, price] of prevPrices) {
    if (!nextPrices.has(key)) changes.push({ kind: 'price', key, change: 'removed', before: price });
  }

  // Нераспознанные строки прайса — всегда человеку: их надо сопоставить с услугой.
  const knownUnmatched = new Set((previous.unmatched || []).map((row) => nameKey(row.name)));
  for (const row of next.unmatched || []) {
    if (!knownUnmatched.has(nameKey(row.name))) changes.push({ kind: 'unmatched_price', key: nameKey(row.name), change: 'added', after: row });
  }

  return changes;
};

/**
 * Решение по одному изменению: 'auto' — применить, 'review' — человеку.
 */
export const classifyChange = (change) => {
  switch (change.kind) {
    case 'clinic':
      if (change.change === 'added') return { decision: 'auto' };
      return CLINIC_AUTO_FIELDS.has(change.field) ? { decision: 'auto' } : { decision: 'review', reason: `изменилось поле «${change.field}»` };
    case 'doctor':
      if (change.change === 'added') return { decision: 'auto' };
      if (change.change === 'removed') return { decision: 'review', reason: 'уточните, принимает ли врач, прежде чем убирать его из справочника' };
      return change.field === 'hours' ? { decision: 'auto' } : { decision: 'review', reason: 'изменилась специальность' };
    case 'price': {
      if (change.change === 'added') return { decision: 'auto' };
      if (change.change === 'removed') return { decision: 'review', reason: 'услуга пропала из прайса' };
      const before = priceValue(change.before);
      const after = priceValue(change.after);
      const shift = before ? Math.abs(after - before) / before : 1;
      return shift <= PRICE_AUTO_TOLERANCE
        ? { decision: 'auto' }
        : { decision: 'review', reason: `цена изменилась на ${Math.round(shift * 100)}%` };
    }
    case 'unmatched_price':
      return { decision: 'review', reason: 'сопоставьте с услугой справочника или отклоните' };
    default:
      return { decision: 'review', reason: 'неизвестный тип изменения' };
  }
};

/**
 * Массовое изменение — признак поломки разбора (сайт сменил вёрстку), а не
 * того, что половина врачей уволилась за неделю. Тогда на проверку уходит всё.
 */
export const isMassChange = (previous, changes) => {
  const removedDoctors = changes.filter((change) => change.kind === 'doctor' && change.change === 'removed').length;
  const removedPrices = changes.filter((change) => change.kind === 'price' && change.change === 'removed').length;
  return (previous.doctors.length >= 3 && removedDoctors / previous.doctors.length > MASS_CHANGE_SHARE)
    || (previous.prices.length >= 3 && removedPrices / previous.prices.length > MASS_CHANGE_SHARE);
};

/** Применяет изменения к записям снимка. */
export const applyChanges = (records, changes) => {
  const next = {
    clinic: records.clinic ? { ...records.clinic } : null,
    doctors: records.doctors.map((doctor) => ({ ...doctor })),
    prices: records.prices.map((price) => ({ ...price })),
    unmatched: [...(records.unmatched || [])],
  };
  for (const change of changes) {
    if (change.kind === 'clinic') {
      if (change.change === 'added') next.clinic = { ...change.after };
      else if (change.field === 'geo') [next.clinic.lat, next.clinic.lng] = change.after;
      else next.clinic[change.field] = change.after;
    } else if (change.kind === 'doctor') {
      const index = next.doctors.findIndex((doctor) => nameKey(doctor.name) === change.key);
      if (change.change === 'added' && index === -1) next.doctors.push({ ...change.after });
      else if (change.change === 'removed' && index !== -1) next.doctors.splice(index, 1);
      else if (change.change === 'changed' && index !== -1) next.doctors[index][change.field] = change.after;
    } else if (change.kind === 'price') {
      const index = next.prices.findIndex((price) => price.serviceId === change.key);
      if (change.change === 'added' && index === -1) next.prices.push({ ...change.after });
      else if (change.change === 'removed' && index !== -1) next.prices.splice(index, 1);
      else if (change.change === 'changed' && index !== -1) next.prices[index].price = change.after;
    } else if (change.kind === 'unmatched_price') {
      next.unmatched.push(change.after);
    }
  }
  return next;
};

/** Стабильный id пункта очереди: одно и то же изменение не дублируется между прогонами. */
export const reviewId = (sourceId, change) =>
  hash([sourceId, change.kind, change.key, change.change, change.field || '', change.after ?? null]).slice(0, 12);

/**
 * Один прогон по источнику.
 *
 * @param {object} params
 * @param {object} params.source описание источника из data/sources.json
 * @param {{fetchSource: Function}} params.fetcher
 * @param {object} params.store хранилище снимков и очереди
 * @param {Date} [params.now]
 * @param {object} [params.vars] подстановки в путь файла-источника
 * @param {boolean} [params.dryRun] ничего не записывать
 */
export const collectSource = async ({ source, fetcher, store, now = new Date(), vars = {}, dryRun = false }) => {
  const today = kazanDay(now);
  const previous = await store.readSnapshot(source.id);
  const fetched = await fetcher.fetchSource(source, previous, vars);

  const touch = async (status) => {
    if (previous && !dryRun) await store.saveSnapshot({ ...previous, fetchedAt: now.toISOString(), verifiedAt: today });
    return { sourceId: source.id, status, auto: [], review: [] };
  };

  if (fetched.status === 'not_modified') return touch('unchanged');
  // Ошибка или запрет — снимок не трогаем: дата проверки стареет, и это видно.
  if (fetched.status !== 'ok') return { sourceId: source.id, status: fetched.status, code: fetched.code, auto: [], review: [] };

  const contentHash = hash(fetched.body);
  if (previous && previous.contentHash === contentHash) return touch('unchanged');

  const records = extractRecords(fetched.body, source.parser || ['jsonld', 'price-table']);
  if (isEmpty(records)) {
    const item = { kind: 'source', key: 'page', change: 'changed', field: 'structure', after: 'empty' };
    const review = [{ ...item, id: reviewId(source.id, item), sourceId: source.id, reason: 'страница не разобралась — возможно, сменилась вёрстка', detectedAt: today }];
    if (!dryRun) await store.enqueue(review);
    return { sourceId: source.id, status: 'parse_empty', auto: [], review };
  }

  const base = previous?.records || EMPTY_RECORDS;
  const changes = diffRecords(base, records);
  // Первый прогон по источнику — это заведение снимка, а не «изменения».
  const bootstrap = !previous;
  const mass = !bootstrap && isMassChange(base, changes);

  const auto = [];
  const review = [];
  for (const change of changes) {
    const verdict = bootstrap ? { decision: change.kind === 'unmatched_price' ? 'review' : 'auto' } : mass
      ? { decision: 'review', reason: 'слишком много изменений сразу — проверьте разбор страницы' }
      : classifyChange(change);
    if (bootstrap && change.kind === 'unmatched_price') verdict.reason = 'сопоставьте с услугой справочника или отклоните';
    if (verdict.decision === 'auto') auto.push(change);
    else review.push({ ...change, id: reviewId(source.id, change), sourceId: source.id, reason: verdict.reason, detectedAt: today });
  }

  const rejected = await store.readRejected();
  const pending = review.filter((item) => !rejected.has(item.id));

  if (!dryRun) {
    await store.saveSnapshot({
      sourceId: source.id,
      fetchedAt: now.toISOString(),
      verifiedAt: today,
      etag: fetched.etag || null,
      lastModified: fetched.lastModified || null,
      contentHash,
      records: applyChanges(base, auto),
    });
    await store.enqueue(pending);
  }

  return { sourceId: source.id, status: mass ? 'mass_change' : bootstrap ? 'created' : 'updated', auto, review: pending };
};

/**
 * Проверка государственных врачей: есть ли каждый на странице, с которой
 * его взяли. Страница загружается один раз на всех её врачей.
 *
 * @returns {Promise<Record<string, {status: 'present'|'missing'|'unreachable', checkedAt: string,
 *   verifiedAt?: string, code?: string}>>}
 */
export const verifyDoctorsOnPages = async ({ doctors, fetcher, now = new Date(), limitPages = Infinity, onPage = () => {} }) => {
  const today = kazanDay(now);
  const byUrl = new Map();
  for (const doctor of doctors) {
    if (!doctor?.id || !/^https?:\/\//.test(doctor.sourceUrl || '')) continue;
    if (!byUrl.has(doctor.sourceUrl)) byUrl.set(doctor.sourceUrl, []);
    byUrl.get(doctor.sourceUrl).push(doctor);
  }

  const results = {};
  let pages = 0;
  for (const [url, list] of byUrl) {
    if (pages >= limitPages) break;
    pages += 1;
    const fetched = await fetcher.fetchSource({ type: 'http', url });
    const text = fetched.status === 'ok' ? htmlToText(fetched.body) : null;
    for (const doctor of list) {
      if (!text) {
        results[doctor.id] = { status: 'unreachable', checkedAt: today, code: fetched.code || fetched.status };
      } else if (findPersonOnPage(text, doctor.name)) {
        results[doctor.id] = { status: 'present', checkedAt: today, verifiedAt: today };
      } else {
        results[doctor.id] = { status: 'missing', checkedAt: today };
      }
    }
    onPage({ url, status: fetched.status, doctors: list.length });
  }
  return results;
};

const FIELD_LABELS = { name: 'название', address: 'адрес', phone: 'телефон', hours: 'часы работы', website: 'сайт', geo: 'координаты', specialty: 'специальность', price: 'цена', structure: 'структура страницы' };

const show = (value) => {
  if (value && typeof value === 'object' && 'min' in value) {
    return `${value.from ? 'от ' : ''}${value.min === value.max ? value.min : `${value.min}–${value.max}`} ₽`;
  }
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return value.name || JSON.stringify(value);
  return String(value ?? '—') || '—';
};

/** Человекочитаемое описание изменения — для отчёта и очереди проверки. */
export const describeChange = (change) => {
  const field = FIELD_LABELS[change.field] || change.field;
  switch (change.kind) {
    case 'clinic':
      return change.change === 'added' ? `клиника «${change.after?.name || '?'}» заведена` : `клиника: ${field} «${show(change.before)}» → «${show(change.after)}»`;
    case 'doctor':
      if (change.change === 'added') return `новый врач «${change.after.name}»${change.after.specialty ? ` (${change.after.specialty})` : ''}`;
      if (change.change === 'removed') return `врача «${change.before.name}» больше нет на странице`;
      return `врач «${change.name || change.key}»: ${field} «${show(change.before)}» → «${show(change.after)}»`;
    case 'price':
      if (change.change === 'added') return `новая цена: ${change.after.name} — ${show(change.after.price)}`;
      if (change.change === 'removed') return `из прайса пропало: ${change.before.name}`;
      return `цена «${serviceName(change.key) || change.key}»: ${show(change.before)} → ${show(change.after)}`;
    case 'unmatched_price':
      return `строка прайса без услуги в справочнике: «${change.after.name}» — ${show(change.after.price)}`;
    case 'source':
      return 'страница не разобралась (сменилась вёрстка?)';
    default:
      return `${change.kind}: ${change.change}`;
  }
};
