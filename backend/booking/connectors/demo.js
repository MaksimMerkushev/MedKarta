/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-коннектор: вымышленное расписание и записи в своей базе SQLite
 * (backend/demo/bookingStore.js). Наружу ничего не уходит. Методы только
 * передают вызов хранилищу — поведение то же, что до слоя коннекторов.
 */

import { defineConnector } from './contract.js';

/**
 * @param {object} deps
 * @param {object} deps.store демо-хранилище (createBookingStore)
 */
export const createDemoConnector = ({ store }) => defineConnector({
  id: 'demo',
  can: { slots: true, hold: true, book: true, cancel: true, status: true },
  localSlots: true,
  listSlots: ({ pairs, fromDay, toDay, at }) => [...store.freeSlots({ pairs, fromDay, toDay, at }).values()].flat(),
  checkSlot: ({ slotId, at }) => (typeof slotId === 'string' ? store.getSlot(slotId, at) : null),
  hold: ({ slotId, at }) => store.hold({ slotId, at }),
  release: ({ slotId, holdToken, at }) => store.release({ slotId, holdToken, at }),
  book: ({ slotId, holdToken, idempotencyKey, planId, accountId, at }) => store.book({ slotId, holdToken, idempotencyKey, planId, accountId, at }),
  cancel: ({ number, cancelToken, at }) => store.cancel({ number, cancelToken, at }),
  status: ({ items, at }) => store.lookup({ items, at }),
  schedule: ({ doctorId, branchId, fromDay, toDay, at }) => store.doctorSchedule({ doctorId, branchId, fromDay, toDay, at }),
  listForAccount: ({ accountId, at }) => store.listForAccount({ accountId, at }),
});
