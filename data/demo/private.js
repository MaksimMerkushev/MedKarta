/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. ВСЕ КЛИНИКИ, ВРАЧИ, ЦЕНЫ И ТЕЛЕФОНЫ ВЫМЫШЛЕНЫ.
 *
 * Справочник частных клиник демо-режима в формате shared/privateCatalog.js.
 * Сами данные генерируются (npm run demo:generate → generated.js): названия
 * клиник содержат «Демо», адреса условные, телефоны с кодом 000, сайты —
 * в зоне .example. В интерфейсе записи помечены плашкой «Демо».
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
