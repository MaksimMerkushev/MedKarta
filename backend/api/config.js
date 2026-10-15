/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Публичная конфигурация для интерфейса: только то, что можно показать
 * любому посетителю. Флаги демо-режима — включён ли демо-набор, симуляция
 * записи и скрыты ли государственные клиники, — чтобы интерфейс и
 * ассистент работали с одними и теми же данными.
 */

import { respondJson } from '../http/request.js';
import { loadSqlite } from '../demo/bookingStore.js';
import { bookingModeFromEnv, demoDataEnabled, publicClinicsHidden } from '../demo/flags.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    respondJson(res, 405, { error: 'Метод не поддерживается.' });
    return;
  }
  respondJson(res, 200, {
    demo: demoDataEnabled(),
    // Симуляция записи: только в демо и только если есть node:sqlite.
    booking: bookingModeFromEnv() && Boolean(await loadSqlite()),
    // В демо государственные клиники скрыты из выдачи (PUBLIC_CLINICS=on — показать).
    publicClinics: !publicClinicsHidden(),
  });
}
