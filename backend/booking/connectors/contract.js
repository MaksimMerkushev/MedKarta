/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Контракт коннектора записи: один модуль на способ подключения клиники
 * (демо, заявка, интегратор, API МИС). Подбор и запись МедКарты работают
 * только через этот интерфейс и не знают, какая у клиники МИС.
 *
 * Возможности (can) — что коннектор умеет; по ним интерфейс выбирает
 * «Записаться» или «Оставить заявку»:
 *   slots  — свободное время: listSlots, checkSlot;
 *   hold   — удержание слота на время подтверждения: hold, release;
 *   book   — запись: book;
 *   cancel — отмена: cancel;
 *   status — состояние записей: status;
 *   push   — сам присылает события (вебхук); методов не требует.
 *
 * Методы (могут возвращать Promise):
 *   listSlots({ pairs, fromDay, toDay, at }) — свободные будущие слоты пар
 *     «врач × филиал» списком: { id, doctorId, branchId, clinicId, serviceId,
 *     day, start, end, startAt, endAt, status, bookable, past, updatedAt };
 *   checkSlot({ slotId, at })            — слот в том же виде или null;
 *   hold({ slotId, at })                 — { holdToken, expiresAt, ttlSeconds, slot };
 *   release({ slotId, holdToken, at })   — true, если удержание снято;
 *   book({ slotId, holdToken, idempotencyKey, planId, accountId, at }) — запись;
 *     повтор с тем же ключом возвращает ту же запись (repeated: true);
 *   cancel({ number, cancelToken, at })  — запись, alreadyCancelled, slotReleased;
 *   status({ items: [{ number, cancelToken }], at }) — записи по порядку;
 *     неизвестная — { number, found: false }.
 *
 * Необязательные методы:
 *   schedule({ doctorId, branchId, fromDay, toDay, at }) — все слоты врача с
 *     состояниями и отсутствия; без него расписание строится из listSlots;
 *   listForAccount({ accountId, at }) — записи личного кабинета. Пока их
 *     хранит демо-коннектор; с первой МИС они переедут в общий реестр записей
 *     МедКарты.
 *
 * localSlots: true — слоты лежат в своей базе и читаются без кэша (демо).
 *
 * Отказы — BookingError с кодом (booking/errors.js), а не ошибки МИС как
 * есть: HTTP-ответ по коду одинаков для любого коннектора.
 */

import { BookingError } from '../errors.js';

export const CAPABILITIES = Object.freeze(['slots', 'hold', 'book', 'cancel', 'status', 'push']);

const REQUIRED_METHODS = Object.freeze({
  slots: ['listSlots', 'checkSlot'],
  hold: ['hold', 'release'],
  book: ['book'],
  cancel: ['cancel'],
  status: ['status'],
  push: [],
});
const OPTIONAL_METHODS = Object.freeze(['schedule', 'listForAccount']);
const CONNECTOR_ID = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * Проверяет коннектор и возвращает замороженную копию с полным набором
 * флагов can (неуказанные — false). Неполный коннектор падает при запуске,
 * а не на первой записи пациента.
 */
export const defineConnector = (connector) => {
  if (!connector || typeof connector !== 'object') throw new TypeError('Коннектор записи: нужен объект.');
  const { id, can = {} } = connector;
  if (typeof id !== 'string' || !CONNECTOR_ID.test(id)) throw new TypeError(`Коннектор записи: неверный id «${id}».`);
  const unknown = Object.keys(can).filter((key) => !CAPABILITIES.includes(key));
  if (unknown.length > 0) throw new TypeError(`Коннектор ${id}: неизвестные возможности ${unknown.join(', ')}.`);
  const flags = Object.fromEntries(CAPABILITIES.map((key) => [key, can[key] === true]));
  for (const key of CAPABILITIES) {
    const missing = flags[key] ? REQUIRED_METHODS[key].filter((name) => typeof connector[name] !== 'function') : [];
    if (missing.length > 0) throw new TypeError(`Коннектор ${id}: для ${key} нужны ${missing.join(', ')}.`);
  }
  const broken = OPTIONAL_METHODS.filter((name) => connector[name] !== undefined && typeof connector[name] !== 'function');
  if (broken.length > 0) throw new TypeError(`Коннектор ${id}: ${broken.join(', ')} — не функции.`);
  return Object.freeze({ ...connector, can: Object.freeze(flags), localSlots: connector.localSlots === true });
};

/** Возможность есть — ничего; нет — отказ not_supported вместо падения на отсутствующем методе. */
export const requireCapability = (connector, capability) => {
  if (!connector.can[capability]) {
    throw new BookingError('not_supported', 'Для этой клиники это действие онлайн недоступно.');
  }
};
