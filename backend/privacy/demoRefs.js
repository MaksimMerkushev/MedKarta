/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Названные в реплике врачи и клиники демо-набора — для строгого подбора
 * записи. Только идентификаторы из справочника; слова пользователя наружу
 * не уходят (как и остальные условия записи — см. bookingConstraints.js).
 *
 * Однофамильцы: «к Ефимовой» — это Ефимова, а не Ефимов, хотя справочник
 * по основе фамилии находит обоих. «Ефимову» и «Ефимова» читаются и как
 * мужская, и как женская форма — тогда остаются оба, и подбор покажет обоих.
 */

import { ENTITY_KIND } from './detectors.js';
import { slug } from '../../shared/translit.js';
import { NO_DEMO_BRANCH } from '../../shared/demoSearch.js';

const DEMO_DOCTOR = 'demo-doc-';

/* Окончания форм фамилии на -ов/-ев/-ин: мужская и женская. */
const MALE_ENDINGS = new Set(['', 'a', 'u', 'ym', 'e', 'om']);
const FEMALE_ENDINGS = new Set(['a', 'oy', 'u']);

/*
 * Предлог уточняет падеж: «к Ибрагимову» — дательный, это мужская форма
 * (женская — «к Ибрагимовой»); «у Ефимова» — родительный, тоже мужская.
 */
const CASE_ENDINGS = {
  dative: { male: new Set(['u']), female: new Set(['oy']) },
  genitive: { male: new Set(['a']), female: new Set(['oy']) },
};

const surnameFits = (doctorId, words, grammaticalCase = null) => {
  const surname = doctorId.slice(DEMO_DOCTOR.length).split('-')[0];
  const female = /(?:ov|ev|in|yn)a$/.test(surname);
  const male = /(?:ov|ev|in|yn)$/.test(surname);
  if (!female && !male) return true;
  const stem = female ? surname.slice(0, -1) : surname;
  const word = words.find((item) => item.startsWith(stem));
  if (!word) return true;
  const ending = word.slice(stem.length);
  if (grammaticalCase) return CASE_ENDINGS[grammaticalCase][female ? 'female' : 'male'].has(ending);
  return (female ? FEMALE_ENDINGS : MALE_ENDINGS).has(ending);
};

/*
 * Имя рядом с фамилией: «к Ефимову Тимуру» — это Ефимов Тимур, хотя форма
 * «Ефимову» подходит и Ефимовой. Сверяется основа имени из id врача.
 */
const firstNameFits = (doctorId, words) => {
  const first = doctorId.slice(DEMO_DOCTOR.length).split('-')[1] || '';
  // «Марии» — «marii», а id — «mariya»: падежное окончание срезается вместе с последней буквой основы.
  const stem = first.length > 5 ? first.slice(0, -2) : first.length > 4 ? first.slice(0, -1) : first;
  return stem.length >= 3 && words.some((word) => word.startsWith(stem));
};

/*
 * Филиал по улице или району: «в Айболит на Максимова» — филиал на ул.
 * Максимова. Основа части id после клиники («maksimova», «leningradskaya»)
 * сверяется со словами реплики.
 */
const branchFits = (branchId, clinicIds, words) => {
  const clinicId = clinicIds.find((id) => branchId.startsWith(`${id}-`));
  const suffix = clinicId ? branchId.slice(clinicId.length + 1) : '';
  const stem = suffix.slice(0, Math.max(4, suffix.length - 3));
  return stem.length >= 4 && words.some((word) => word.startsWith(stem));
};

/* «Но не Ефимов», «кроме Ясеня», «только не в Разумед» — исключение, а не выбор. */
/* «Разумед не надо», «Кузляр не предлагай», «Морозов не подходит» — исключение после названия. */
const EXCLUDED_AFTER = /^[»"]?\s*,?\s*(?:—\s*)?(?:не\s+(?:надо|нужно|нужен|нужна|предлагай\p{L}*|подходит|хочу|интересует|рассматрива\p{L}*|советуй\p{L}*)|исключ\p{L}*|мимо)(?!\p{L})/u;

const EXCLUDED_BEFORE = /(?:^|[^\p{L}])(?:не|кроме|исключая|без|только\s+не|но\s+не)\s+(?:(?:к|ко|у|в|во|на)\s+)?(?:(?:клиник|медцентр|центр|стоматологи|врач|доктор)\p{L}*\s+)?[«"]?$/u;

/**
 * Врачи и клиники, названные в реплике. Несколько названных («к Ефимовой
 * или Валееву», «в Ясене или Бересте») — все сразу.
 *
 * @param {{message: {content: string}, entities: Array}} analysis разбор реплики
 * @returns {{doctorIds?: string[], excludeDoctorIds?: string[], branchIds?: string[], excludeBranchIds?: string[], foreignDoctor?: true, clinicChoice?: true}}
 */
export const demoRefsOf = (analysis) => {
  const content = analysis.message.content;
  const lower = content.toLowerCase().replace(/ё/g, 'е');
  const messageWords = lower.split(/[^\p{L}-]+/u).filter(Boolean).map(slug);
  const doctorIds = new Set();
  const excludeDoctorIds = new Set();
  const branchIds = new Set();
  const excludeBranchIds = new Set();
  let foreignDoctor = false;
  let clinicNamed = false;
  const clinicBranches = new Set();
  let excludedClinicEnd = -1;
  for (const entity of [...(analysis.entities || [])].sort((left, right) => left.start - right.start)) {
    if (!Array.isArray(entity.ids) || entity.ids.length === 0) continue;
    // «Не в Айболит на Курской»: улица филиала после исключённой клиники — часть того же исключения.
    const streetOfExcluded = entity.kind === ENTITY_KIND.CLINIC && excludedClinicEnd >= 0
      && /^\s*,?\s*(?:на|по|в|во|у)\s+(?:ул(?:ице|\.)?\s+)?$/u.test(lower.slice(excludedClinicEnd, entity.start));
    const excluded = streetOfExcluded || EXCLUDED_BEFORE.test(lower.slice(Math.max(0, entity.start - 36), entity.start))
      || EXCLUDED_AFTER.test(lower.slice(entity.end, entity.end + 30));
    if (entity.kind === ENTITY_KIND.CLINIC) excludedClinicEnd = excluded ? entity.end : -1;
    const preposition = /(?:^|[^\p{L}])(к|ко|у|от|для)\s+(?:врачу\s+|доктору\s+|(?:\p{L}+(?:логу|педу|апевту|ургу|иатру))\s+)?$/u.exec(lower.slice(Math.max(0, entity.start - 24), entity.start))?.[1];
    const grammaticalCase = preposition === 'к' || preposition === 'ко' ? 'dative' : preposition ? 'genitive' : null;
    if (entity.kind === ENTITY_KIND.DOCTOR) {
      const words = content.slice(entity.start, entity.end).split(/[^\p{L}-]+/u).filter(Boolean).map(slug);
      const ids = [...new Set(entity.ids.filter((id) => id.startsWith(DEMO_DOCTOR)).map((id) => id.split('--')[0]))];
      // Врач назван, но не из демо: записи к нему нет, а подменять его другим нельзя.
      if (ids.length === 0 && !excluded) foreignDoctor = true;
      let fitting = ids.filter((id) => surnameFits(id, words, grammaticalCase));
      if (fitting.length === 0) fitting = ids;
      const named = fitting.filter((id) => firstNameFits(id, messageWords));
      if (named.length > 0) fitting = named;
      fitting.forEach((id) => (excluded ? excludeDoctorIds : doctorIds).add(id));
    }
    if (entity.kind === ENTITY_KIND.CLINIC) {
      const demoBranches = entity.ids.filter((id) => id.startsWith('demo-') && !id.startsWith(DEMO_DOCTOR));
      const clinicIds = [...new Set(demoBranches.map((id) => id.replace(/-[a-z0-9]+$/, '')))];
      // Улица сужает и исключение: «не в Айболит на Курской» — без филиала на Курской, а не без всего «Айболита».
      const nearWords = lower.slice(entity.end, entity.end + 40).split(/[^\p{L}-]+/u).filter(Boolean).map(slug);
      if (excluded) {
        const streetExcluded = demoBranches.filter((id) => branchFits(id, clinicIds, nearWords));
        (streetExcluded.length > 0 ? streetExcluded : demoBranches).forEach((id) => excludeBranchIds.add(id));
        continue;
      }
      clinicNamed = true;
      demoBranches.forEach((id) => clinicBranches.add(id));
      const onStreet = demoBranches.filter((id) => branchFits(id, clinicIds, messageWords));
      (onStreet.length > 0 ? onStreet : demoBranches).forEach((id) => branchIds.add(id));
    }
  }
  const refs = {};
  /*
   * «Кардиолог в Ситидок или Разумед»: две клиники через «или» — выбор
   * места приёма, а не маршрут через обе (как может понять планировщик).
   */
  const clinics = (analysis.entities || []).filter((entity) => entity.kind === ENTITY_KIND.CLINIC).sort((left, right) => left.start - right.start);
  if (clinics.slice(1).some((entity, position) => /^\s*,?\s*(?:или|либо)\s+(?:в\s+|во\s+)?$/u.test(lower.slice(clinics[position].end, entity.start)))) {
    refs.clinicChoice = true;
  }
  if (doctorIds.size > 0) refs.doctorIds = [...doctorIds];
  if (excludeDoctorIds.size > 0) refs.excludeDoctorIds = [...excludeDoctorIds];
  if (excludeBranchIds.size > 0) refs.excludeBranchIds = [...excludeBranchIds];
  if (foreignDoctor && doctorIds.size === 0) refs.foreignDoctor = true;
  // Клиника названа, но демо-записи в ней нет — подбор так и скажет, а не подменит.
  if (clinicNamed) refs.branchIds = branchIds.size > 0 ? [...branchIds] : [NO_DEMO_BRANCH];
  // Все филиалы названной клиники — чтобы «а на Ленинградской?» следующей репликой сменило филиал.
  if (clinicBranches.size > 0) refs.clinicBranches = [...clinicBranches];
  return refs;
};

/**
 * «А на Ленинградской?» после «в Разумед на Пушкина»: улица без названия
 * клиники выбирает филиал той клиники, что названа раньше.
 *
 * @param {string[]} clinicBranches все демо-филиалы названной раньше клиники
 * @param {string} content реплика
 * @returns {string[]} филиалы на названной улице (или пусто)
 */
export const branchesOnStreet = (clinicBranches, content) => {
  const words = String(content || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}-]+/u).filter(Boolean).map(slug);
  const clinicIds = [...new Set(clinicBranches.map((id) => id.replace(/-[a-z0-9]+$/, '')))];
  return clinicBranches.filter((id) => branchFits(id, clinicIds, words));
};

/**
 * «К Ефимова» → «Тимуру»: однофамильцы, названные раньше, у которых имя
 * совпадает со словом реплики.
 *
 * @param {string[]} doctorIds демо-врачи, названные раньше
 * @param {string} content реплика
 * @returns {string[]} врачи с этим именем (или пусто)
 */
export const doctorsByFirstName = (doctorIds, content) => {
  const words = String(content || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}-]+/u).filter(Boolean).map(slug);
  return doctorIds.filter((id) => id.startsWith(DEMO_DOCTOR) && firstNameFits(id, words));
};
