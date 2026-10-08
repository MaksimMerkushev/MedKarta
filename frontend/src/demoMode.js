/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Демо-режим: вымышленные частные клиники, цены и программы ДМС.
 *
 * По умолчанию интерфейс следует серверу (/api/config): если на сервере
 * включён демо-набор, ассистент о нём знает, и карта должна показывать то же.
 * Ссылка с ?demo=1 или ?demo=0 переключает режим вручную и запоминает выбор
 * в этом браузере.
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

export const fetchServerDemoFlag = async () => {
  try {
    const response = await fetch('/api/config', { credentials: 'same-origin' });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.demo === true;
  } catch {
    return false;
  }
};

/** Загружает и разворачивает демо-набор отдельным чанком. */
export const loadDemoData = async () => {
  const [{ demoPrivateCatalog, demoInsurance }, { flattenPrivateCatalog }] = await Promise.all([
    import('@data/demo/index.js'),
    import('@shared/privateCatalog.js'),
  ]);
  return { items: flattenPrivateCatalog(demoPrivateCatalog), insurance: demoInsurance };
};
