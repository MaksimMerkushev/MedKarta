/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Отказ записи с кодом (slot_taken, slot_held, booking_not_found, …). Код
 * один для любого коннектора: по нему API выбирает HTTP-статус, а интерфейс —
 * что показать пациенту.
 */

export class BookingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}
