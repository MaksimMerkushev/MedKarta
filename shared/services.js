/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Закрытый справочник услуг и сведение строк прайсов («Приём ЛОР-врача первичный»,
 * «Осмотр отоларинголога») к одной услуге — без этого не сравнить цены и покрытие ДМС.
 * Коды — по номенклатуре Минздрава (приказ № 804н); код в прайсе клиники главнее нашего.
 */

const consult = (specialty, label, code) => [
  {
    id: `consult.${specialty}.first`,
    name: `Приём ${label} первичный`,
    specialty,
    kind: 'consult',
    visit: 'first',
    nomenclature: `${code}.001`,
  },
  {
    id: `consult.${specialty}.repeat`,
    name: `Приём ${label} повторный`,
    specialty,
    kind: 'consult',
    visit: 'repeat',
    nomenclature: `${code}.002`,
  },
];

export const SERVICES = Object.freeze([
  ...consult('therapist', 'терапевта', 'B01.047'),
  ...consult('pediatrician', 'педиатра', 'B01.031'),
  ...consult('lor', 'оториноларинголога (ЛОР)', 'B01.028'),
  ...consult('neurologist', 'невролога', 'B01.023'),
  ...consult('dermatologist', 'дерматовенеролога', 'B01.008'),
  ...consult('gynecologist', 'акушера-гинеколога', 'B01.001'),
  ...consult('cardiologist', 'кардиолога', 'B01.015'),
  ...consult('ophthalmologist', 'офтальмолога', 'B01.029'),
  ...consult('endocrinologist', 'эндокринолога', 'B01.058'),
  ...consult('urologist', 'уролога', 'B01.053'),
  ...consult('gastroenterologist', 'гастроэнтеролога', 'B01.004'),
  ...consult('traumatologist', 'травматолога-ортопеда', 'B01.050'),
  ...consult('dentist', 'стоматолога-терапевта', 'B01.065'),
  ...consult('surgeon', 'хирурга', 'B01.057'),
  ...consult('orthopedist', 'ортопеда', 'B01.050'),
  ...consult('psychiatrist', 'психиатра', 'B01.035'),
  { id: 'diag.ultrasound.abdomen', name: 'УЗИ органов брюшной полости', specialty: null, kind: 'diagnostics', nomenclature: 'A04.16.001' },
  { id: 'diag.ecg', name: 'ЭКГ (регистрация электрокардиограммы)', specialty: 'cardiologist', kind: 'diagnostics', nomenclature: 'A05.10.006' },
  { id: 'lab.cbc', name: 'Общий анализ крови (развёрнутый)', specialty: null, kind: 'lab', nomenclature: 'B03.016.003' },
  /*
   * Процедуры для демо-расписания: своя длительность и своё покрытие ДМС.
   * Код номенклатуры без сверки с источником не подставляется.
   */
  { id: 'proc.lor.tonsils', name: 'Промывание миндалин', specialty: 'lor', kind: 'procedure', nomenclature: null },
  { id: 'proc.ophthalmologist.glasses', name: 'Подбор очков', specialty: 'ophthalmologist', kind: 'procedure', nomenclature: null },
  { id: 'proc.dermatologist.dermatoscopy', name: 'Дерматоскопия', specialty: 'dermatologist', kind: 'procedure', nomenclature: null },
  { id: 'proc.gynecologist.ultrasound', name: 'УЗИ органов малого таза', specialty: 'gynecologist', kind: 'procedure', nomenclature: null },
  { id: 'proc.dentist.hygiene', name: 'Профессиональная гигиена полости рта', specialty: 'dentist', kind: 'procedure', nomenclature: null },
]);

export const SERVICE_BY_ID = Object.freeze(Object.fromEntries(SERVICES.map((service) => [service.id, service])));

/*
 * Основы названий специальностей в прайсах. Строка должна совпасть ровно с одной
 * специальностью; узкие профили отсекаются раньше (NOT_THIS_PROFILE).
 */
const SPECIALTY_STEMS = [
  ['lor', ['оториноларинголог', 'отоларинголог', 'лор']],
  ['pediatrician', ['педиатр']],
  ['therapist', ['терапевт', 'врач общей практики']],
  ['neurologist', ['невролог', 'невропатолог']],
  ['dermatologist', ['дерматовенеролог', 'дерматолог']],
  ['gynecologist', ['гинеколог', 'акушер']],
  ['cardiologist', ['кардиолог']],
  ['ophthalmologist', ['офтальмолог', 'окулист']],
  ['endocrinologist', ['эндокринолог']],
  ['urologist', ['уролог']],
  ['gastroenterologist', ['гастроэнтеролог']],
  ['traumatologist', ['травматолог', 'ортопед']],
  ['dentist', ['стоматолог', 'дантист']],
];

/**
 * Профили, которые содержат общую основу, но услугой этого профиля не
 * являются: «кардиохирург» — не кардиолог. Строка с таким профилем не
 * сопоставляется вовсе.
 */
const NOT_THIS_PROFILE = /\p{L}*(?:хирург|онколог|аллерголог|физиотерап|реабилитолог|косметолог|трихолог)\p{L}*/gu;

const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'()[\]{}.,:;!?/\\|+*–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const hasWord = (text, stem) => new RegExp(`(?:^|[^\\p{L}])${stem}`, 'u').test(text);

const CONSULT = /(?:^|[^\p{L}])(?:прием|консультац|осмотр)/u;
const REPEAT = /(?:^|[^\p{L}])повторн/u;
/** Пакеты и комплексы — не приём: «Приём педиатра + анализы, пакет». */
const PACKAGE = /(?:^|[^\p{L}])(?:пакет|комплекс|программ|абонемент|на дому|выезд|онлайн|телемед|видео)/u;

const DIAGNOSTICS = [
  ['diag.ultrasound.abdomen', (text) => hasWord(text, 'узи') && hasWord(text, 'брюшн') && !PACKAGE.test(text)],
  ['diag.ecg', (text) => (hasWord(text, 'экг') || hasWord(text, 'электрокардиограм')) && !/холтер|сут/u.test(text)],
  ['lab.cbc', (text) => (/(?:^|[^\p{L}])оак(?:$|[^\p{L}])/u.test(text) || /(?:общий|клинический) анализ крови/u.test(text)) && !/биохим/u.test(text)],
];

/**
 * Строка прайса → услуга справочника. Правило консервативное: лучше «не узнал»
 * (строка уйдёт на ручную разметку), чем сравнить цену пакета с ценой приёма.
 *
 * @param {string} text название из прайса
 * @returns {string|null} id услуги
 */
export const matchService = (text) => {
  const value = normalize(text);
  if (!value) return null;

  for (const [id, test] of DIAGNOSTICS) {
    if (test(value)) return id;
  }

  if (!CONSULT.test(value) || PACKAGE.test(value)) return null;

  // Строка про другой профиль («приём хирурга-проктолога и терапевта») —
  // не наша услуга, даже если рядом стоит знакомое слово.
  if (value.replace(NOT_THIS_PROFILE, ' ') !== value) return null;

  const profileText = value;
  const matched = SPECIALTY_STEMS.filter(([, stems]) => stems.some((stem) => hasWord(profileText, stem)));
  // Две специальности в одной строке («приём терапевта и кардиолога») — не одна услуга.
  if (matched.length !== 1) return null;

  const [specialty] = matched[0];
  const visit = REPEAT.test(value) ? 'repeat' : 'first';
  return `consult.${specialty}.${visit}`;
};

export const serviceName = (id) => SERVICE_BY_ID[id]?.name || null;

/*
 * Цена — число рублей, диапазон {min, max} или строка из прайса
 * («1 500 ₽», «от 1500 руб.»). «От» сохраняется: это нижняя граница, и
 * показывать её как точную цену нельзя. Ноль, отрицательное, мусор — null:
 * неверная цена хуже, чем никакой.
 */
export const normalizePrice = (value) => {
  if (typeof value === 'number') {
    // Меньше 10 ₽ — ошибка разбора, а не цена: иначе «0,4» станет «0 ₽» и встанет первым.
    return Number.isFinite(value) && value >= 10 && value < 1_000_000 ? { min: Math.round(value), max: Math.round(value) } : null;
  }
  if (value && typeof value === 'object') {
    const min = normalizePrice(value.min)?.min;
    const max = normalizePrice(value.max)?.max;
    if (!min && !max) return null;
    const range = { min: Math.min(min ?? max, max ?? min), max: Math.max(min ?? max, max ?? min) };
    return value.from === true ? { ...range, from: true } : range;
  }
  if (typeof value === 'string') {
    const match = value
      .toLowerCase()
      .replace(/[\s\u00a0]/g, '')
      .match(/^(от)?(\d{2,6})(?:[.,]\d{1,2})?(?:₽|руб\.?|р\.?)?$/u);
    if (!match) return null;
    const price = normalizePrice(Number(match[2]));
    return price && match[1] ? { ...price, from: true } : price;
  }
  return null;
};
