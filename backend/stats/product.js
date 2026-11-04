/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Поиск и карта за период: свод журнала аналитики (analytics/eventStore.js).
 *
 * Считается по суткам и складывается: завершённые сутки сохраняются в базе
 * статистики и больше не перечитываются, поэтому отчёт за полгода не читает
 * полгода файлов; текущие сутки считаются при каждом запросе. Сессия, идущая
 * через полночь, считается в каждых сутках отдельно — для такого масштаба это
 * не искажает выводы, и на экране об этом сказано.
 *
 * Логика «успешного поиска» — та же, что в отчёте npm run report:searches
 * (analytics/report.js). Журнал браузер пишет только без DNT/GPC.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

import { sanitizeEvent } from '../../shared/analytics.js';
import { buildReport } from '../analytics/report.js';

/** Версия формата свода: при изменении прежние своды считаются заново. */
export const PRODUCT_SUMMARY_VERSION = 1;

const bump = (object, key, by = 1) => {
  object[key] = (object[key] || 0) + by;
};

const addAll = (target, source = {}) => {
  for (const [key, value] of Object.entries(source)) bump(target, key, value);
  return target;
};

const moscowHour = (ts) => {
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed + 3 * 60 * 60 * 1000).getUTCHours() : null;
};

/** Свод одних суток: то, что считает отчёт по поискам, и то, чего ему не нужно, но нужно экрану. */
export const summarizeDay = (events) => {
  const report = buildReport(events, { topLimit: Number.POSITIVE_INFINITY });
  const extra = {
    filters: {},
    locationSearches: 0,
    dmsSearches: 0,
    resultCounts: { zero: 0, few: 0, many: 0 },
    opens: { surface: {}, kind: {}, ownership: {} },
    openPlaces: {},
    routeModes: {},
    contactKinds: {},
    perHour: Array(24).fill(0),
    searchesPerHour: Array(24).fill(0),
  };
  for (const event of events) {
    const hour = moscowHour(event.ts);
    if (hour !== null) {
      extra.perHour[hour] += 1;
      if (event.type === 'search') extra.searchesPerHour[hour] += 1;
    }
    switch (event.type) {
      case 'search':
        for (const filter of event.filters || []) bump(extra.filters, filter);
        if (event.hasLocation) extra.locationSearches += 1;
        if (event.dmsPlan) extra.dmsSearches += 1;
        if (event.results === 0) extra.resultCounts.zero += 1;
        else if (event.results <= 5) extra.resultCounts.few += 1;
        else extra.resultCounts.many += 1;
        break;
      case 'result_open':
        bump(extra.opens.surface, event.surface);
        bump(extra.opens.kind, event.kind);
        if (event.ownership) bump(extra.opens.ownership, event.ownership);
        if (event.placeId) bump(extra.openPlaces, event.placeId);
        break;
      case 'route_build':
        bump(extra.routeModes, event.mode);
        break;
      case 'contact_click':
        bump(extra.contactKinds, event.kind);
        break;
      default:
        break;
    }
  }
  return { ...report, extra };
};

/** Сутки из файла журнала; повреждённые строки пропускаются. Нет файла — null. */
export const readDayEvents = (dir, day) => new Promise((resolve) => {
  const events = [];
  const stream = createReadStream(path.join(dir, `events-${day}.jsonl`));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  // Нет файла: readline передаёт ошибку потока сюда, необработанная уронила бы процесс.
  lines.on('error', () => resolve(null));
  lines.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const { ts, ...rest } = JSON.parse(line);
      // Повторная проверка: в журнал могли дописать руками или старой версией.
      const event = sanitizeEvent(rest);
      if (event) events.push({ ts, ...event });
    } catch {
      // Повреждённая строка.
    }
  });
  lines.on('close', () => resolve(events));
});

/**
 * Своды за сутки периода. Завершённые сутки — из базы, если там есть.
 *
 * @returns {Promise<Array<{day: string, summary: object}>>} только сутки, за которые есть журнал
 */
export const loadProductDays = async ({ dir, store, days, today }) => {
  const loaded = [];
  for (const day of days) {
    let summary = day < today ? store?.productDay(day, PRODUCT_SUMMARY_VERSION) : null;
    if (!summary) {
      // По одному файлу: сервер — одно ядро.
      const events = await readDayEvents(dir, day);
      if (!events) continue;
      summary = summarizeDay(events);
      if (day < today) store?.saveProductDay(day, PRODUCT_SUMMARY_VERSION, summary);
    }
    loaded.push({ day, summary });
  }
  return loaded;
};

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const topList = (object, limit = Infinity) => Object.entries(object)
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .slice(0, limit)
  .map(([key, value]) => ({ key, value }));

/** Складывает своды суток в раздел отчёта. placeName — название места по id из справочника. */
export const mergeProductDays = (loaded, { placeName = () => null, topLimit = 15 } = {}) => {
  const funnel = { sessions: 0, searched: 0, opened: 0, acted: 0, satisfied: 0 };
  const searches = { total: 0, zeroResults: 0, successful: 0 };
  const byType = {};
  const bySpecialty = {};
  const bySource = {};
  const zeroBySpecialty = {};
  const zeroByFilter = {};
  const feedbackReasons = {};
  const feedbackByContext = {};
  const feedback = { yes: 0, no: 0 };
  const contactChannels = {};
  const contactPlaces = {};
  const externalMaps = {};
  const routes = { ok: 0, failed: 0 };
  const reportReasons = {};
  const reportPlaces = {};
  const filters = {};
  const resultCounts = { zero: 0, few: 0, many: 0 };
  const opens = { surface: {}, kind: {}, ownership: {} };
  const openPlaces = {};
  const routeModes = {};
  const contactKinds = {};
  const perHour = Array(24).fill(0);
  const searchesPerHour = Array(24).fill(0);
  let events = 0;
  let locationSearches = 0;
  let dmsSearches = 0;
  const daily = [];

  for (const { day, summary } of loaded) {
    events += summary.totals.events;
    for (const key of Object.keys(funnel)) funnel[key] += summary.funnel[key] || 0;
    for (const key of Object.keys(searches)) searches[key] += summary.searches[key] || 0;
    addAll(byType, summary.totals.byType);
    for (const row of summary.bySpecialty) {
      const entry = bySpecialty[row.specialty] ||= { searches: 0, successful: 0, zeroResults: 0 };
      entry.searches += row.searches;
      entry.successful += row.successful;
      entry.zeroResults += row.zeroResults;
    }
    for (const row of summary.bySource) {
      const entry = bySource[row.source] ||= { searches: 0, successful: 0 };
      entry.searches += row.searches;
      entry.successful += row.successful;
    }
    addAll(zeroBySpecialty, summary.zeroResults.bySpecialty);
    addAll(zeroByFilter, summary.zeroResults.byFilter);
    feedback.yes += summary.feedback.yes;
    feedback.no += summary.feedback.no;
    addAll(feedbackReasons, summary.feedback.reasons);
    addAll(feedbackByContext, summary.feedback.byContext);
    addAll(contactChannels, summary.contacts.byChannel);
    addAll(contactPlaces, summary.contacts.topPlaces);
    addAll(externalMaps, summary.externalMaps);
    routes.ok += summary.routes.ok;
    routes.failed += summary.routes.failed;
    addAll(reportReasons, summary.dataReports.byReason);
    addAll(reportPlaces, summary.dataReports.topPlaces);
    addAll(filters, summary.extra.filters);
    locationSearches += summary.extra.locationSearches;
    dmsSearches += summary.extra.dmsSearches;
    addAll(resultCounts, summary.extra.resultCounts);
    addAll(opens.surface, summary.extra.opens.surface);
    addAll(opens.kind, summary.extra.opens.kind);
    addAll(opens.ownership, summary.extra.opens.ownership);
    addAll(openPlaces, summary.extra.openPlaces);
    addAll(routeModes, summary.extra.routeModes);
    addAll(contactKinds, summary.extra.contactKinds);
    summary.extra.perHour.forEach((value, hour) => { perHour[hour] += value; });
    summary.extra.searchesPerHour.forEach((value, hour) => { searchesPerHour[hour] += value; });
    daily.push({
      day,
      events: summary.totals.events,
      sessions: summary.funnel.sessions,
      searches: summary.searches.total,
      successful: summary.searches.successful,
      zeroResults: summary.searches.zeroResults,
      opens: summary.totals.byType.result_open || 0,
      contacts: summary.totals.byType.contact_click || 0,
      routes: summary.routes.ok + summary.routes.failed,
    });
  }

  const places = (object) => topList(object, topLimit).map(({ key, value }) => ({ id: key, name: placeName(key), value }));
  return {
    events,
    funnel: { ...funnel, searchedShare: share(funnel.searched, funnel.sessions), actedShareOfSearched: share(funnel.acted, funnel.searched) },
    searches: { ...searches, successRate: share(searches.successful, searches.total), zeroResultRate: share(searches.zeroResults, searches.total), withLocation: locationSearches, withDms: dmsSearches },
    byType: topList(byType),
    bySpecialty: Object.entries(bySpecialty)
      .map(([specialty, row]) => ({ specialty, ...row, successRate: share(row.successful, row.searches) }))
      .sort((left, right) => right.searches - left.searches || left.specialty.localeCompare(right.specialty)),
    bySource: Object.entries(bySource).map(([source, row]) => ({ source, ...row, successRate: share(row.successful, row.searches) })).sort((left, right) => right.searches - left.searches),
    filters: topList(filters),
    resultCounts,
    zeroResults: { bySpecialty: topList(zeroBySpecialty, topLimit), byFilter: topList(zeroByFilter, topLimit) },
    opens: { surface: topList(opens.surface), kind: topList(opens.kind), ownership: topList(opens.ownership), topPlaces: places(openPlaces) },
    contacts: { channels: topList(contactChannels), kinds: topList(contactKinds), topPlaces: places(contactPlaces) },
    routes: { ...routes, failureRate: share(routes.failed, routes.ok + routes.failed), modes: topList(routeModes) },
    externalMaps: topList(externalMaps),
    feedback: { ...feedback, satisfaction: share(feedback.yes, feedback.yes + feedback.no), reasons: topList(feedbackReasons), byContext: topList(feedbackByContext) },
    dataReports: { reasons: topList(reportReasons), topPlaces: places(reportPlaces) },
    perHour,
    searchesPerHour,
    daily,
  };
};
