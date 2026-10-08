/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Канонические специальности и признак «детский приём».
 *
 * Модуль общий для сервера и браузера: раньше список специальностей жил
 * только в backend/privacy/catalog.js, и интерфейс не мог сослаться на тот
 * же закрытый набор — например, в событиях аналитики.
 */

/** Канонические специальности. Значение — ключ, используемый в плане. */
export const SPECIALTY_CANON = Object.freeze({
  therapist: 'Терапевт',
  neurologist: 'Невролог',
  cardiologist: 'Кардиолог',
  lor: 'ЛОР',
  ophthalmologist: 'Офтальмолог',
  surgeon: 'Хирург',
  orthopedist: 'Ортопед',
  dermatologist: 'Дерматолог',
  gynecologist: 'Гинеколог',
  pediatrician: 'Педиатр',
  dentist: 'Стоматолог',
  endocrinologist: 'Эндокринолог',
  gastroenterologist: 'Гастроэнтеролог',
  urologist: 'Уролог',
  psychiatrist: 'Психиатр',
  traumatologist: 'Травматолог',
});

export const SPECIALTY_KEYS = Object.freeze(Object.keys(SPECIALTY_CANON));

/*
 * Порядок проверки: длинные названия раньше коротких, иначе «Детский
 * кардиохирург» нашёл бы «хирург» раньше «кардио…». Совпадение — по слову
 * целиком: «ЛОР» не должен находиться внутри «колоректальный».
 */
const LABEL_MATCHERS = Object.entries(SPECIALTY_CANON)
  .map(([key, label]) => ({ key, pattern: new RegExp(`(?:^|[^\\p{L}])${label.toLowerCase()}(?:$|[^\\p{L}])`, 'u') }))
  .sort((left, right) => right.pattern.source.length - left.pattern.source.length);

/**
 * Код канонической специальности по названию из справочника или фильтра:
 * «Детский ЛОР» → lor, «Педиатр» → pediatrician. Узкие профили, которых нет
 * в каноническом списке (кардиохирург, неонатолог), дают 'other'.
 * Пустое значение — null: «специальность не выбрана» и «другая» различаются.
 */
export const specialtyCode = (label) => {
  const text = String(label ?? '').trim().toLowerCase();
  if (!text || text === 'all') return null;
  for (const { key, pattern } of LABEL_MATCHERS) {
    if (pattern.test(text)) return key;
  }
  return 'other';
};

const PEDIATRIC_PROFILE = /(?:^|[^\p{L}])(?:детск\p{L}*|педиатр\p{L}*|неонатолог\p{L}*)(?:$|[^\p{L}])/u;

/**
 * Принимают ли здесь детей.
 *
 * В справочнике флаг features.children не заполнен ни у одного врача, хотя
 * «Детский ЛОР», «Педиатр» и «Неонатолог» — однозначно детский приём, а
 * «Детская поликлиника № 7» — детское учреждение. Фильтр «Для детей» из-за
 * этого прятал всю выдачу. Явный флаг источника по-прежнему главнее.
 */
export const isPediatricRecord = (record) => {
  if (!record || typeof record !== 'object') return false;
  if (record.features?.children === true) return true;
  const fields = [record.specialty, record.doctorProfile, record.name, record.clinic, record.department];
  return fields.some((value) => typeof value === 'string' && PEDIATRIC_PROFILE.test(value.toLowerCase()));
};
