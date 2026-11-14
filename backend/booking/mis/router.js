/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Маршрутизатор коннекторов: сервис записи по-прежнему видит один коннектор
 * (тот же контракт), а запросы расходятся:
 *   — по филиалу: филиал сопоставлен с интеграцией — её коннектор МИС, иначе демо;
 *   — по слоту: id вида «mis.<интеграция>.…» — коннектор МИС, остальное — демо;
 *   — по номеру записи: «MK-…» — журнал МИС, «DEMO-…» — демо.
 * Слоты демо читаются из своей базы напрямую, слоты МИС — через кэш
 * (booking/slotCache.js), чтобы подбор не ходил в МИС на каждый поиск.
 * Сбой одной МИС не ломает подбор: её слоты просто не показываются.
 */

import { defineConnector } from '../connectors/contract.js';
import { BookingError } from '../errors.js';
import { createLocalSlotSource, createSlotCache, groupByPair } from '../slotCache.js';
import { decodeSlotId, isMisNumber, isMisSlotId } from './connector.js';

/**
 * @param {object} deps
 * @param {object} deps.demo демо-коннектор
 * @param {object[]} deps.mis коннекторы МИС (createMisConnector)
 */
export const createConnectorRouter = ({ demo, mis = [], logger = null }) => {
  const byIntegration = new Map(mis.map((connector) => [connector.integrationId, connector]));
  const misOf = (branchId) => mis.find((connector) => connector.ownsBranch(branchId)) || null;
  const misForSlot = (slotId) => {
    const decoded = decodeSlotId(slotId);
    const connector = decoded ? byIntegration.get(decoded.integrationId) : null;
    if (!connector) throw new BookingError('slot_not_found', 'Слот не найден.');
    return connector;
  };
  const forSlot = (slotId) => (isMisSlotId(slotId) ? misForSlot(slotId) : demo);

  const splitPairs = (pairs) => {
    const demoPairs = [];
    const misPairs = new Map();
    for (const pair of pairs) {
      const connector = misOf(pair.branchId);
      if (!connector) demoPairs.push(pair);
      else misPairs.set(connector, [...(misPairs.get(connector) || []), pair]);
    }
    return { demoPairs, misPairs };
  };

  const listMisSlots = async (query) => {
    const { misPairs } = splitPairs(query.pairs);
    const parts = await Promise.all([...misPairs].map(async ([connector, pairs]) => {
      try {
        return await connector.listSlots({ ...query, pairs });
      } catch (error) {
        logger?.warn?.('mis.slots_failed', { integration: connector.integrationId, code: error?.code || 'error' });
        throw error;
      }
    }));
    return parts.flat();
  };

  const listSlots = async (query) => {
    const { demoPairs } = splitPairs(query.pairs);
    const demoSlots = demoPairs.length ? await demo.listSlots({ ...query, pairs: demoPairs }) : [];
    let misSlots = [];
    try {
      misSlots = await listMisSlots(query);
    } catch {
      misSlots = [];
    }
    return [...demoSlots, ...misSlots];
  };

  const status = async ({ items, at }) => {
    const list = (items || []).slice(0, 20);
    const results = new Array(list.length);
    const demoItems = [];
    const misItems = new Map();
    list.forEach((item, index) => {
      if (isMisNumber(item?.number)) {
        // Номер МИС не говорит, какая интеграция: спрашиваем все (номер уникален в журнале).
        for (const connector of mis) misItems.set(index, [...(misItems.get(index) || []), connector]);
        if (!mis.length) results[index] = { number: item.number, found: false };
      } else demoItems.push([index, item]);
    });
    if (demoItems.length) {
      const found = await demo.status({ items: demoItems.map(([, item]) => item), at });
      demoItems.forEach(([index], position) => { results[index] = found[position]; });
    }
    for (const [index, connectors] of misItems) {
      for (const connector of connectors) {
        const [result] = await connector.status({ items: [list[index]], at });
        if (result?.found !== false) {
          results[index] = result;
          break;
        }
        results[index] = result;
      }
    }
    return results;
  };

  const cancel = async (input) => {
    if (!isMisNumber(input.number)) return demo.cancel(input);
    for (const connector of mis) {
      if (!connector.can.cancel) continue;
      try {
        return await connector.cancel(input);
      } catch (error) {
        if (error?.code !== 'booking_not_found') throw error;
      }
    }
    throw new BookingError('booking_not_found', 'Запись не найдена.');
  };

  const schedule = async ({ doctorId, branchId, fromDay, toDay, at }) => {
    const connector = branchId ? misOf(branchId) : null;
    if (!connector) return demo.schedule({ doctorId, branchId, fromDay, toDay, at });
    const slots = await connector.listSlots({ pairs: [{ doctorId, branchId }], fromDay, toDay, at });
    return { slots: slots.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)), absences: [] };
  };

  const listForAccount = async ({ accountId, at }) => {
    const parts = await Promise.all([demo.listForAccount ? demo.listForAccount({ accountId, at }) : [], ...mis.map((connector) => connector.listForAccount({ accountId, at }))]);
    return parts.flat();
  };

  /** Составной источник слотов: демо — напрямую, МИС — через кэш. */
  const createSlotSource = (options = {}) => {
    const local = createLocalSlotSource(demo);
    const remote = mis.length
      ? createSlotCache({ connector: { id: 'mis-router', can: { slots: true }, listSlots: listMisSlots }, ...options })
      : null;
    return Object.freeze({
      freeSlots: async (query) => {
        const { demoPairs, misPairs } = splitPairs(query.pairs);
        const result = new Map();
        if (demoPairs.length) for (const [key, value] of await local.freeSlots({ ...query, pairs: demoPairs })) result.set(key, value);
        const remotePairs = [...misPairs.values()].flat();
        if (remote && remotePairs.length) for (const [key, value] of await remote.freeSlots({ ...query, pairs: remotePairs })) result.set(key, value);
        // Порядок пар — как в запросе (поиск на него опирается).
        return groupByPair([...result.values()].flat(), query.pairs);
      },
      invalidateSlot: (slotId) => (isMisSlotId(slotId) ? remote?.invalidateSlot(slotId) : local.invalidateSlot(slotId)),
      invalidateAll: () => remote?.invalidateAll(),
      stats: () => remote?.stats() ?? null,
    });
  };

  return defineConnector({
    id: 'router',
    can: { slots: true, hold: true, book: true, cancel: true, status: true },
    listSlots,
    checkSlot: (input) => forSlot(input.slotId).checkSlot(input),
    hold: (input) => forSlot(input.slotId).hold(input),
    release: (input) => forSlot(input.slotId).release(input),
    book: (input) => forSlot(input.slotId).book(input),
    cancel,
    status,
    schedule,
    listForAccount,
    createSlotSource,
  });
};
