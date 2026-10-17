/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Флаги демо-режима. Всё обратимо и ничего не удаляет:
 *
 *   DEMO_DATA=on        — вымышленные частные клиники, врачи, ДМС;
 *   DEMO_BOOKING=off    — выключить симуляцию записи (по умолчанию включена
 *                         вместе с DEMO_DATA, нужен Node 22.13+);
 *   PUBLIC_CLINICS=on   — показывать государственные клиники и в демо-режиме
 *                         (по умолчанию скрыты: демо-сценарий — частные
 *                         клиники, расписание и ДМС). Данные ОМС и их
 *                         обработка не меняются — скрывается только выдача.
 */

export const demoDataEnabled = (env = process.env) => env.DEMO_DATA === 'on';

export const bookingModeFromEnv = (env = process.env) => demoDataEnabled(env) && env.DEMO_BOOKING !== 'off';

export const publicClinicsHidden = (env = process.env) => demoDataEnabled(env) && env.PUBLIC_CLINICS !== 'on';

export const PUBLIC_OWNERSHIP = 'Государственная';

/** Запись государственного учреждения (врач, клиника, объект OSM)? */
export const isPublicClinicRecord = (record) => record?.ownership === PUBLIC_OWNERSHIP;
