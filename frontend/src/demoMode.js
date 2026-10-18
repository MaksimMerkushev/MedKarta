/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-режим: вымышленные частные клиники, цены и программы ДМС.
 * По умолчанию следует серверу (/api/config), чтобы карта совпадала с тем, что
 * знает ассистент; ?demo=1 / ?demo=0 переключает вручную и запоминается в браузере.
 */

const STORAGE_KEY = 'medkarta.demo';

/** true / false — выбор пользователя; null — следовать серверу. */
export const readDemoPreference = () => {
  try {
    const param = new URLSearchParams(window.location.search).get('demo');
    if (param === '1' || param === '0') {
      localStorage.setItem(STORAGE_KEY, param);
      return param === '1';
    }
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === '1' ? true : stored === '0' ? false : null;
  } catch {
    return null;
  }
};

export const setDemoPreference = (enabled) => {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Без хранилища выбор живёт до перезагрузки — это не ошибка.
  }
};

/**
 * Флаги сервера: демо-набор, симуляция записи и скрыты ли государственные
 * клиники (в демо по умолчанию скрыты, PUBLIC_CLINICS=on — показать), плюс
 * публичные настройки из админ-панели.
 */
export const fetchServerConfig = async () => {
  const fallback = { demo: false, booking: false, publicClinics: true, settings: null };
  try {
    const response = await fetch('/api/config', { credentials: 'same-origin' });
    if (!response.ok) return fallback;
    const payload = await response.json();
    return {
      demo: payload?.demo === true,
      booking: payload?.booking === true,
      publicClinics: payload?.publicClinics !== false,
      // Публичные настройки из админ-панели: название, контакты, сообщение о работах.
      settings: payload?.settings && typeof payload.settings === 'object' ? payload.settings : null,
    };
  } catch {
    return fallback;
  }
};


/** Демо-набор грузится отдельным чанком. */
export const loadDemoData = async () => {
  const [{ demoPrivateCatalog, demoInsurance }, { flattenPrivateCatalog }] = await Promise.all([
    import('@data/demo/index.js'),
    import('@shared/privateCatalog.js'),
  ]);
  return { items: flattenPrivateCatalog(demoPrivateCatalog), insurance: demoInsurance };
};
