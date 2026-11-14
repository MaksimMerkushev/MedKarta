/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-режим: вымышленные частные клиники, цены и программы ДМС.
 * Только по серверу (/api/config): карта всегда совпадает с тем, что знает
 * ассистент. Выключить демо в браузере нельзя — ни кнопкой, ни ?demo=0.
 */

/*
 * Раньше выбор «без демо» запоминался в браузере (ключ medkarta.demo). Он больше
 * не действует; старое значение стирается, чтобы не путать при отладке.
 */
export const forgetLegacyDemoPreference = () => {
  try {
    localStorage.removeItem('medkarta.demo');
  } catch {
    // Без хранилища стирать нечего.
  }
};

/**
 * Флаги сервера: демо-набор, симуляция записи и скрыты ли государственные
 * клиники (в демо по умолчанию скрыты, PUBLIC_CLINICS=on — показать), плюс
 * публичные настройки из админ-панели.
 */
export const fetchServerConfig = async () => {
  const fallback = { demo: false, booking: false, publicClinics: true, demoOnly: false, settings: null };
  try {
    const response = await fetch('/api/config', { credentials: 'same-origin' });
    if (!response.ok) return fallback;
    const payload = await response.json();
    return {
      demo: payload?.demo === true,
      booking: payload?.booking === true,
      publicClinics: payload?.publicClinics !== false,
      // Только вымышленные клиники и врачи: реальные данные не показываются, демо не выключается.
      demoOnly: payload?.demo === true && payload?.demoOnly === true,
      // Публичные настройки из админ-панели: название, контакты, сообщение о работах.
      settings: payload?.settings && typeof payload.settings === 'object' ? payload.settings : null,
    };
  } catch {
    return fallback;
  }
};


/** Демо-набор грузится отдельным чанком. */
export const loadDemoData = async ({ fictionalOnly = false } = {}) => {
  const [{ demoPrivateCatalog, demoInsurance }, { flattenPrivateCatalog }] = await Promise.all([
    import('@data/demo/index.js'),
    import('@shared/privateCatalog.js'),
  ]);
  const items = flattenPrivateCatalog(demoPrivateCatalog);
  // «Только демо»: реальные клиники из OSM с демо-врачами тоже скрыты — как на сервере.
  return { items: fictionalOnly ? items.filter((item) => !item.realClinic) : items, insurance: demoInsurance };
};
