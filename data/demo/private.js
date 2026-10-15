/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. ВСЕ ВРАЧИ, ЦЕНЫ, РАСПИСАНИЯ И ТЕЛЕФОНЫ ВЫМЫШЛЕНЫ.
 *
 * Справочник частных клиник демо-режима в формате shared/privateCatalog.js.
 * Сами данные генерируются (npm run demo:generate → generated.js). Вымышленные
 * клиники: «Демо» в названии, адреса условные, телефоны с кодом 000, сайты —
 * в зоне .example. Реальные частные клиники (real: true): настоящие только
 * название, адрес, точка и часы (OSM), телефона нет. В интерфейсе записи
 * помечены плашкой «Демо», реальные клиники — ещё и «Реальная клиника».
 *
 * Прежний ручной набор переехал в tests/fixtures/legacy-demo — как образец
 * для проверки логики справочника.
 */

import { demoCatalog } from './generated.js';

export const demoPrivateCatalog = {
  meta: demoCatalog.meta,
  clinics: demoCatalog.clinics,
  doctors: demoCatalog.doctors,
  prices: demoCatalog.prices,
};
