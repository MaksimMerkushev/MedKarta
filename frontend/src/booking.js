/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Переход к записи.
 *
 * Своей записи у МедКарты нет и пока не будет: запись живёт в системе
 * клиники. Задача интерфейса — довести человека до места, где он
 * записывается, одним нажатием, и честно сказать, как это устроено:
 *
 *   - частная клиника — сайт клиники (с меткой, что человек пришёл от нас)
 *     или звонок в регистратуру;
 *   - государственная — по ОМС приём в поликлинике прикрепления, к узким
 *     специалистам обычно нужно направление; записываются через Госуслуги.
 */

/** «Запись на приём к врачу» на Госуслугах. */
export const GOSUSLUGI_APPOINTMENT_URL = 'https://www.gosuslugi.ru/10700/1';

/** Специальности, к которым по ОМС обычно идут без направления. */
const DIRECT_ACCESS = /(?:^|[^\p{L}])(?:терапевт|педиатр|врач общей практики|гинеколог|стоматолог|акушер)/u;

/**
 * Добавляет к ссылке на сайт клиники метку источника.
 *
 * Клиника видит в своей аналитике, что человек пришёл из МедКарты, —
 * без этого модель «клиника платит за пациента» нечем подтвердить.
 * Метка не содержит ничего о человеке. Чужие метки не перезаписываются.
 */
export const withReferral = (url, campaign = 'card') => {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!parsed.searchParams.has('utm_source')) {
    parsed.searchParams.set('utm_source', 'medkarta');
    parsed.searchParams.set('utm_medium', 'referral');
    parsed.searchParams.set('utm_campaign', campaign);
  }
  return parsed.toString();
};

/**
 * Подсказка «как записаться» для государственного учреждения.
 *
 * @param {object} doc карточка врача или учреждения
 * @returns {{needsReferral: boolean, text: string}|null}
 */
export const omsHint = (doc) => {
  if (!doc || doc.ownership !== 'Государственная') return null;
  if (doc.entityKind === 'doctor') {
    const profile = String(doc.doctorProfile || doc.specialty || '').toLowerCase();
    const needsReferral = !DIRECT_ACCESS.test(profile);
    return {
      needsReferral,
      text: needsReferral
        ? 'По ОМС к этому специалисту обычно нужно направление терапевта или педиатра из вашей поликлиники.'
        : 'По ОМС — в поликлинике, к которой вы прикреплены.',
    };
  }
  return {
    needsReferral: false,
    text: 'По ОМС принимают прикреплённых пациентов; к узким специалистам обычно нужно направление.',
  };
};
