/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лабораторный модуль: витрина каталога, подбор корзины, расписание и демо-запись
 * поверх хранилища (labs/store.js). Включён вместе с демо-данными (DEMO_DATA=on);
 * LABS=off выключает раздел целиком.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSqlite } from '../demo/bookingStore.js';
import { addDays, demoNow, isDay, moscowDay, moscowParts } from '../demo/time.js';
import { logger } from '../observability/safeLogger.js';
import { BIOMATERIALS, CATEGORIES, LAB_BRANCH_POINTS, PREPARATION_NOTE } from './catalog.js';
import { createLabQuote, describeTurnaround, LAB_DISCLAIMER } from './quote.js';
import { createLabStore, LAB_WINDOW_DAYS, LabError } from './store.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const createLabService = ({ store, getEngine = async () => null, now = () => Date.now() }) => {
  const quote = createLabQuote({ store, getEngine, now });

  /** Каталог для витрины: исследования с минимальной ценой и числом лабораторий. */
  const catalog = () => {
    const snapshot = store.snapshot();
    const stats = new Map();
    for (const branch of snapshot.branches) {
      for (const [code, offering] of snapshot.offerings.get(branch.id) || []) {
        if (!offering.available) continue;
        const entry = stats.get(code) || { minPrice: Infinity, minHours: Infinity, labs: new Set(), branches: 0 };
        entry.minPrice = Math.min(entry.minPrice, offering.price);
        entry.minHours = Math.min(entry.minHours, offering.turnaroundHours);
        entry.labs.add(branch.labId);
        entry.branches += 1;
        stats.set(code, entry);
      }
    }
    const tests = [...snapshot.tests.values()].map((test) => {
      const entry = stats.get(test.code);
      return {
        code: test.code, name: test.name, category: test.category, biomaterial: test.biomaterial, biomaterialName: test.biomaterialName,
        fasting: test.fasting, requiresBooking: test.requiresBooking, unit: test.unit,
        minPrice: entry ? entry.minPrice : null, fastestHours: entry ? entry.minHours : null, fastestText: entry ? describeTurnaround(entry.minHours) : null,
        labsCount: entry ? entry.labs.size : 0, branchesCount: entry ? entry.branches : 0,
      };
    });
    return {
      demo: true,
      categories: CATEGORIES.map((category) => ({ ...category, count: tests.filter((test) => test.category === category.id).length })),
      biomaterials: Object.entries(BIOMATERIALS).map(([id, item]) => ({ id, name: item.name, fee: item.fee })),
      tests,
      labs: [...snapshot.labs.values()].map((lab) => ({ id: lab.id, name: lab.name, branchesCount: snapshot.branches.filter((branch) => branch.labId === lab.id).length })),
      branches: snapshot.branches.map((branch) => ({ id: branch.id, labId: branch.labId, name: branch.name, address: branch.address, district: branch.district, lat: branch.lat, lng: branch.lng })),
      preparationNote: PREPARATION_NOTE,
      disclaimer: LAB_DISCLAIMER,
    };
  };

  /** Исследование: описание, подготовка, где сделать и почём (по лабораториям), пример бланка. */
  const test = (code) => {
    const item = store.getTest(code);
    if (!item || !item.active) throw new LabError('test_not_found', 'Исследование не найдено.', 404);
    const snapshot = store.snapshot();
    const byLab = new Map();
    for (const offering of store.testOfferings(code)) {
      const branch = snapshot.branches.find((entry) => entry.id === offering.branchId);
      if (!branch || !offering.available) continue;
      const entry = byLab.get(branch.labId) || { lab: snapshot.labs.get(branch.labId), minPrice: Infinity, maxPrice: 0, minHours: Infinity, branches: [] };
      entry.minPrice = Math.min(entry.minPrice, offering.price);
      entry.maxPrice = Math.max(entry.maxPrice, offering.price);
      entry.minHours = Math.min(entry.minHours, offering.turnaroundHours);
      entry.branches.push({ id: branch.id, name: branch.name, price: offering.price, turnaroundHours: offering.turnaroundHours, priceDate: offering.priceDate });
      byLab.set(branch.labId, entry);
    }
    return {
      demo: true,
      test: item,
      preparationNote: PREPARATION_NOTE,
      labs: [...byLab.values()].sort((a, b) => a.minPrice - b.minPrice).map((entry) => ({
        id: entry.lab.id, name: entry.lab.name, minPrice: entry.minPrice, maxPrice: entry.maxPrice,
        turnaroundHours: entry.minHours, turnaroundText: describeTurnaround(entry.minHours), branches: entry.branches,
      })),
      demoResults: store.demoResults(code),
      disclaimer: LAB_DISCLAIMER,
    };
  };

  // Объект OSM, на месте которого стоит демо-филиал: карта заменяет им карточку пункта из OSM.
  const OSM_OF_BRANCH = new Map(LAB_BRANCH_POINTS.map(([labId, key, , , , , , osmId]) => [`${labId}-${key}`, osmId]));

  const labs = () => {
    const snapshot = store.snapshot();
    return {
      demo: true,
      labs: [...snapshot.labs.values()].map((lab) => {
        const branches = snapshot.branches.filter((branch) => branch.labId === lab.id);
        const codes = new Set(branches.flatMap((branch) => [...(snapshot.offerings.get(branch.id) || new Map()).values()].filter((offering) => offering.available).map((offering) => offering.testCode)));
        return { ...lab, branchesCount: branches.length, testsCount: codes.size, branches: branches.map((branch) => ({ id: branch.id, name: branch.name, address: branch.address, lat: branch.lat, lng: branch.lng, district: branch.district, hours: branch.hours, osmId: OSM_OF_BRANCH.get(branch.id) || null })) };
      }),
      disclaimer: LAB_DISCLAIMER,
    };
  };

  /** Лаборатория: филиалы с часами и процедурами, каталог её исследований с ценами. */
  const lab = (id) => {
    const item = store.getLab(id);
    if (!item || !item.active) throw new LabError('lab_not_found', 'Лаборатория не найдена.', 404);
    const branches = store.listBranches({ labId: id });
    const prices = new Map();
    for (const branch of branches) {
      for (const offering of store.branchOfferings(branch.id)) {
        if (!offering.available) continue;
        const entry = prices.get(offering.testCode) || { code: offering.testCode, name: offering.testName, category: offering.category, minPrice: Infinity, maxPrice: 0, minHours: Infinity, branches: 0, fasting: offering.fasting, priceDate: offering.priceDate };
        entry.minPrice = Math.min(entry.minPrice, offering.price);
        entry.maxPrice = Math.max(entry.maxPrice, offering.price);
        entry.minHours = Math.min(entry.minHours, offering.turnaroundHours);
        entry.branches += 1;
        prices.set(offering.testCode, entry);
      }
    }
    return {
      demo: true,
      lab: item,
      branches: branches.map((branch) => ({ ...branch, fees: store.branchFees(branch.id) })),
      tests: [...prices.values()].map((entry) => ({ ...entry, turnaroundText: describeTurnaround(entry.minHours) })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      disclaimer: LAB_DISCLAIMER,
    };
  };

  const branch = (id) => {
    const item = store.getBranch(id);
    if (!item || !item.active) throw new LabError('branch_not_found', 'Филиал не найден.', 404);
    return { demo: true, branch: item, lab: store.getLab(item.labId), fees: store.branchFees(id), offerings: store.branchOfferings(id).filter((offering) => offering.available), disclaimer: LAB_DISCLAIMER };
  };

  /** Расписание филиала: дни окна со свободными местами. */
  const schedule = ({ branchId, from, days = 7, tests = [] }) => {
    const item = store.getBranch(branchId);
    if (!item || !item.active) throw new LabError('branch_not_found', 'Филиал не найден.', 404);
    const at = now();
    const today = moscowDay(at);
    const start = isDay(from) && from >= today ? from : today;
    const count = Math.min(Math.max(Number(days) || 7, 1), LAB_WINDOW_DAYS);
    const end = addDays(start, count - 1);
    const lastDay = addDays(today, LAB_WINDOW_DAYS - 1);
    const codes = Array.isArray(tests) ? tests.filter((code) => typeof code === 'string').slice(0, 25) : [];
    const lines = codes.length ? store.priceLines(branchId, codes) : null;
    return {
      demo: true,
      timezone: 'Europe/Moscow',
      now: { day: today, time: moscowParts(at).time },
      window: { from: today, to: lastDay },
      branch: item,
      slots: store.branchSchedule({ branchId, fromDay: start, toDay: end < lastDay ? end : lastDay, at }),
      quote: lines ? { lines: lines.lines, missing: lines.missing, total: lines.total } : null,
    };
  };

  return Object.freeze({
    store, now, quote: quote.quote, normalize: quote.normalize, catalog, test, labs, lab, branch, schedule,
    book: (input) => store.book({ ...input, at: now() }),
    cancel: (input) => store.cancel({ ...input, at: now() }),
    lookup: (input) => store.lookup({ ...input, at: now() }),
    listForAccount: (input) => store.listForAccount({ ...input, at: now() }),
  });
};

let defaultService;

/** Сервис по умолчанию: при DEMO_DATA=on, LABS≠off и наличии node:sqlite. */
export const getDefaultLabService = () => {
  if (defaultService === undefined) {
    defaultService = (async () => {
      if (process.env.DEMO_DATA !== 'on' || process.env.LABS === 'off') return null;
      const DatabaseSync = await loadSqlite();
      if (!DatabaseSync) {
        logger.warn('labs.unavailable', { status: 'node:sqlite missing (Node 22.13+ required)' });
        return null;
      }
      const file = process.env.LAB_DB_PATH || path.join(ROOT, 'var', 'demo', 'labs.sqlite');
      const now = () => demoNow();
      const store = createLabStore({ DatabaseSync, file, now });
      const { getDefaultRoutingEngine } = await import('../routing/engine.js');
      const getEngine = async () => {
        try {
          return await getDefaultRoutingEngine();
        } catch {
          return null;
        }
      };
      logger.event('labs.ready', { status: 'enabled', count: store.stats().branches });
      return createLabService({ store, getEngine, now });
    })().catch((error) => {
      logger.error('labs.failed', error);
      defaultService = undefined;
      return null;
    });
  }
  return defaultService;
};

/** Только для тестов: подставить свой сервис. */
export const __setDefaultLabService = (service) => {
  defaultService = service === undefined ? undefined : Promise.resolve(service);
};
