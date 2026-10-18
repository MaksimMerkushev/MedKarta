/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Публичная конфигурация для интерфейса — только то, что можно показать любому
 * посетителю: флаги демо-режима, чтобы интерфейс и ассистент работали с одними
 * и теми же данными, и публичные настройки из админ-панели.
 */

import { respondJson } from '../http/request.js';
import { loadSqlite } from '../demo/bookingStore.js';
import { bookingModeFromEnv, demoDataEnabled, publicClinicsHidden } from '../demo/flags.js';
import { peekAccountContext } from './accountContext.js';

/*
 * Публичные настройки из админ-панели: название, контакты поддержки,
 * сообщение о технических работах, включён ли ассистент. Только ключи с
 * пометкой public в accounts/settings.js — ничего из окружения.
 */
const publicSettings = async () => {
  try {
    const context = await peekAccountContext();
    const values = context?.settings.publicValues() || null;
    if (!values) return null;
    return {
      appName: values['app.name'],
      supportEmail: values['support.email'] || null,
      supportPhone: values['support.phone'] || null,
      maintenance: values['maintenance.enabled'] ? values['maintenance.message'] : null,
      assistant: values['assistant.enabled'] !== false,
    };
  } catch {
    return null;
  }
};

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
    settings: await publicSettings(),
  });
}
