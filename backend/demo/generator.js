/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Генератор демонстрационного набора: всё, что он создаёт, вымышлено.
 *
 * Набор показывает сценарий «запрос → строгий подбор → свободное окно →
 * запись» на согласованных данных. Ни одна запись не выдаёт себя за реальную:
 *   — в названиях вымышленных клиник есть «Демо», id начинаются с «demo-»;
 *   — их адреса условные («демо-адрес»), без реальных номеров домов;
 *   — телефоны с несуществующим кодом 000, сайты — в зоне .example;
 *   — страховщик «Демо-Страхование» и программы Demo Basic / Standard /
 *     Premium не связаны ни с одной реальной страховой компанией.
 *
 * Кроме вымышленных, в наборе есть реальные частные клиники
 * (data/demo/realClinics.js): название, адрес, точка, сайт и часы — из
 * OpenStreetMap. Врачи, цены, расписание и покрытие ДМС в них вымышлены;
 * клиника помечена real: true, телефон не выдаётся, смены врачей не выходят
 * за часы работы клиники по OSM.
 *
 * Всё выводится из seed (DEMO_SEED). Статичная часть (клиники, врачи,
 * услуги, цены, графики, ДМС) записывается в data/demo/generated.js
 * командой npm run demo:generate и лежит в репозитории; слоты на даты строит
 * generateDaySlots — детерминированно по seed, врачу и дате.
 *
 * Согласованность, которую проверяют тесты:
 *   — врач принимает только в своих филиалах и только в часы работы филиала;
 *   — в двух филиалах врач работает в разные дни, пересечений нет;
 *   — слот лежит внутри смены и вне перерыва, его длительность равна
 *     длительности услуги, слоты одного врача не пересекаются;
 *   — услуги врача — только его специальности и его возрастной группы.
 */

import { SPECIALTY_CANON, SPECIALTY_KEYS } from '../../shared/specialties.js';
import { SERVICE_BY_ID } from '../../shared/services.js';
import { slug } from '../../shared/translit.js';
import { REAL_PRIVATE_CLINIC_POINTS } from '../../data/demo/realClinics.js';
import { createRandom, unit } from './random.js';
import { addDays, dayIndex, minutesOf, timeOf, weekdayOf } from './time.js';

export const DEMO_SEED = 'medkarta-demo-2026';
export const SLOT_WINDOW_DAYS = 14;
export const DEMO_VERSION = 2;

/* ---------- Услуги и длительности ---------- */

/** Длительность услуг, минуты. Приём — по специальности, процедуры — свои. */
const FIRST_MINUTES = Object.freeze({ dentist: 40, psychiatrist: 50 });
const REPEAT_MINUTES = Object.freeze({ dentist: 30, psychiatrist: 30 });
const PROCEDURES = Object.freeze({
  lor: { id: 'proc.lor.tonsils', minutes: 20, base: 1500 },
  ophthalmologist: { id: 'proc.ophthalmologist.glasses', minutes: 30, base: 1600 },
  dermatologist: { id: 'proc.dermatologist.dermatoscopy', minutes: 30, base: 1800 },
  gynecologist: { id: 'proc.gynecologist.ultrasound', minutes: 30, base: 2200 },
  cardiologist: { id: 'diag.ecg', minutes: 20, base: 900 },
  dentist: { id: 'proc.dentist.hygiene', minutes: 60, base: 4500 },
});

/** Базовые цены первичного и повторного приёма в клинике «стандарт», ₽. */
const BASE_PRICES = Object.freeze({
  therapist: [1900, 1600], lor: [2200, 1900], neurologist: [2400, 2000], cardiologist: [2500, 2100],
  ophthalmologist: [2100, 1800], gynecologist: [2300, 1900], endocrinologist: [2400, 2000],
  gastroenterologist: [2400, 2000], urologist: [2300, 1900], dermatologist: [2400, 2000],
  surgeon: [2200, 1800], orthopedist: [2300, 1900], traumatologist: [2200, 1800],
  pediatrician: [1900, 1600], dentist: [1500, 1200], psychiatrist: [3500, 2800],
});

const TIER_FACTOR = Object.freeze({ economy: 0.85, standard: 1, premium: 1.35 });
const roundPrice = (value) => Math.round(value / 50) * 50;

/* ---------- Клиники ---------- */

/*
 * Точки филиалов — жилые кварталы Казани в пределах дорожного графа, а не
 * адреса настоящих клиник. Адрес условный: район и «демо-адрес».
 */
const BRANCH_POINTS = Object.freeze({
  centr1: { district: 'Вахитовский', lat: 55.7887, lng: 49.1221 },
  centr2: { district: 'Вахитовский', lat: 55.7818, lng: 49.1341 },
  centr3: { district: 'Вахитовский', lat: 55.7960, lng: 49.1160 },
  sever1: { district: 'Ново-Савиновский', lat: 55.8237, lng: 49.1186 },
  sever2: { district: 'Ново-Савиновский', lat: 55.8268, lng: 49.1395 },
  azino: { district: 'Советский', lat: 55.7536, lng: 49.2047 },
  ametyevo: { district: 'Советский', lat: 55.7712, lng: 49.1755 },
  derbyshki: { district: 'Советский', lat: 55.8575, lng: 49.2230 },
  gorki: { district: 'Приволжский', lat: 55.7650, lng: 49.1630 },
  dubravnaya: { district: 'Приволжский', lat: 55.7398, lng: 49.1495 },
  avia: { district: 'Авиастроительный', lat: 55.8560, lng: 49.0880 },
  moskovsky1: { district: 'Московский', lat: 55.8189, lng: 49.0805 },
  moskovsky2: { district: 'Московский', lat: 55.8110, lng: 49.0650 },
  kirov: { district: 'Кировский', lat: 55.8040, lng: 49.0700 },
  privolzh: { district: 'Приволжский', lat: 55.7531, lng: 49.1302 },
  savinovo: { district: 'Ново-Савиновский', lat: 55.8350, lng: 49.1180 },
});

/** Часы работы филиала по уровню клиники. */
const BRANCH_HOURS = Object.freeze({
  weekdaysSat: { days: [1, 2, 3, 4, 5, 6], weekday: ['08:00', '21:00'], saturday: ['09:00', '18:00'], sunday: null },
  allWeek: { days: [1, 2, 3, 4, 5, 6, 7], weekday: ['08:00', '21:00'], saturday: ['09:00', '18:00'], sunday: ['10:00', '16:00'] },
});

const MULTI = ['therapist', 'lor', 'neurologist', 'cardiologist', 'ophthalmologist', 'gynecologist', 'endocrinologist', 'gastroenterologist', 'urologist', 'dermatologist'];
const KIDS = ['pediatrician', 'lor', 'neurologist', 'ophthalmologist', 'surgeon', 'dermatologist', 'orthopedist'];

/*
 * Профиль клиники: какие специальности, для кого, сколько врачей.
 * extra — специальности, по которым врачей два.
 */
const CLINICS = Object.freeze([
  { id: 'demo-yasen', name: 'Демо-клиника «Ясень»', type: 'Медцентр', tier: 'standard', hours: 'weekdaysSat', branches: [['centr', 'центр', 'centr1'], ['sever', 'Ново-Савиновский', 'sever1']], specialties: MULTI, extra: ['therapist', 'lor'], age: 'adult' },
  { id: 'demo-beresta', name: 'Демо-медцентр «Береста»', type: 'Медцентр', tier: 'economy', hours: 'weekdaysSat', branches: [['azino', 'Азино', 'azino'], ['gorki', 'Горки', 'gorki']], specialties: MULTI, extra: ['therapist', 'gynecologist'], age: 'adult' },
  { id: 'demo-kama', name: 'Демо-клиника «Кама Премиум»', type: 'Медцентр', tier: 'premium', hours: 'allWeek', branches: [['centr', 'центр', 'centr2']], specialties: [...MULTI, 'surgeon'], extra: [], age: 'adult' },
  { id: 'demo-detstvo', name: 'Детская демо-клиника «Детство»', type: 'Клиника', tier: 'standard', hours: 'allWeek', branches: [['gorki', 'Горки', 'gorki'], ['derbyshki', 'Дербышки', 'derbyshki']], specialties: KIDS, extra: ['pediatrician', 'lor'], age: 'child' },
  { id: 'demo-pediatr-plus', name: 'Демо-клиника «Педиатр Плюс»', type: 'Клиника', tier: 'economy', hours: 'weekdaysSat', branches: [['avia', 'Авиастроительный', 'avia']], specialties: ['pediatrician', 'lor', 'ophthalmologist'], extra: ['pediatrician'], age: 'child' },
  { id: 'demo-dent', name: 'Демо-стоматология «Дент»', type: 'Стоматология', tier: 'standard', hours: 'weekdaysSat', branches: [['avia', 'Авиастроительный', 'avia'], ['moskovsky', 'Московский', 'moskovsky1']], specialties: ['dentist'], extra: ['dentist', 'dentist'], age: 'adult' },
  { id: 'demo-ulybka', name: 'Демо-стоматология «Улыбка Премиум»', type: 'Стоматология', tier: 'premium', hours: 'allWeek', branches: [['centr', 'центр', 'centr3']], specialties: ['dentist'], extra: ['dentist', 'dentist'], age: 'both' },
  { id: 'demo-zhenskoe', name: 'Демо-центр «Женское здоровье»', type: 'Клиника', tier: 'standard', hours: 'weekdaysSat', branches: [['kirov', 'Кировский', 'kirov']], specialties: ['gynecologist', 'endocrinologist'], extra: ['gynecologist', 'gynecologist'], age: 'adult' },
  { id: 'demo-travma', name: 'Демо-травмоцентр «Опора»', type: 'Медцентр', tier: 'standard', hours: 'allWeek', branches: [['sever', 'Ново-Савиновский', 'sever2']], specialties: ['traumatologist', 'orthopedist', 'surgeon'], extra: ['traumatologist'], age: 'adult' },
  { id: 'demo-derma', name: 'Демо-клиника «Дерма»', type: 'Клиника', tier: 'standard', hours: 'weekdaysSat', branches: [['dubravnaya', 'Дубравная', 'dubravnaya']], specialties: ['dermatologist'], extra: ['dermatologist', 'dermatologist'], age: 'both' },
  { id: 'demo-neuro', name: 'Демо-центр «Нейро»', type: 'Медцентр', tier: 'premium', hours: 'weekdaysSat', branches: [['ametyevo', 'Аметьево', 'ametyevo']], specialties: ['neurologist', 'psychiatrist'], extra: ['neurologist', 'psychiatrist'], age: 'adult' },
  { id: 'demo-semya', name: 'Демо-клиника «Семейный доктор»', type: 'Клиника', tier: 'economy', hours: 'weekdaysSat', branches: [['moskovsky', 'Московский', 'moskovsky2']], specialties: ['therapist', 'pediatrician', 'lor', 'ophthalmologist'], extra: ['therapist'], age: 'both' },
]);

/*
 * Реальные частные клиники: точки — по osm-id из data/demo/realClinics.js.
 * Профили врачей — правдоподобные для клиники (глазная — офтальмологи,
 * «Мать и дитя» — женское и детское здоровье), но сами врачи вымышлены.
 */
const REAL_CLINICS = Object.freeze([
  { id: 'demo-real-razumed', name: 'Разумед', type: 'Клиника', tier: 'standard', branches: [['pushkina', 'ул. Пушкина', 'osm-node-12863010208'], ['leningradskaya', 'Ленинградская ул.', 'osm-node-4277729442']], specialties: ['therapist', 'lor', 'neurologist', 'cardiologist', 'gynecologist', 'endocrinologist', 'gastroenterologist', 'urologist'], extra: ['therapist', 'neurologist'], age: 'adult' },
  { id: 'demo-real-budzdorov', name: 'Будь здоров', type: 'Клиника', tier: 'premium', branches: [['narimanova', 'ул. Нариманова', 'osm-node-10837307213']], specialties: ['therapist', 'lor', 'cardiologist', 'dermatologist', 'gynecologist', 'ophthalmologist'], extra: [], age: 'adult' },
  { id: 'demo-real-aibolit', name: 'Айболит', type: 'Медцентр', tier: 'economy', branches: [['maksimova', 'ул. Максимова', 'osm-node-11403915602'], ['kurskaya', 'Курская ул.', 'osm-node-7309478748']], specialties: ['therapist', 'pediatrician', 'lor', 'neurologist', 'ophthalmologist', 'dermatologist'], extra: ['pediatrician', 'therapist'], age: 'both' },
  { id: 'demo-real-kuzlyar', name: 'Кузляр', type: 'Клиника', tier: 'standard', branches: [['kutuya', 'ул. Аделя Кутуя', 'osm-node-8370818131'], ['lobachevskogo', 'ул. Лобачевского', 'osm-node-9984003800']], specialties: ['ophthalmologist'], extra: ['ophthalmologist', 'ophthalmologist'], age: 'both' },
  { id: 'demo-real-citidoc', name: 'Ситидок', type: 'Клиника', tier: 'standard', branches: [['zelenaya', 'Зелёная ул.', 'osm-node-5214562721']], specialties: ['therapist', 'lor', 'neurologist', 'cardiologist', 'gastroenterologist'], extra: [], age: 'adult' },
  { id: 'demo-real-mamadeti', name: 'Мать и дитя', type: 'Клиника', tier: 'premium', branches: [['daurskaya', 'Даурская ул.', 'osm-node-8521190137']], specialties: ['gynecologist', 'pediatrician', 'endocrinologist', 'therapist', 'lor'], extra: ['gynecologist', 'pediatrician'], age: 'both' },
  { id: 'demo-real-nurievy', name: 'Клиника Нуриевых', type: 'Клиника', tier: 'standard', branches: [['serova', 'ул. Серова', 'osm-node-9937772987'], ['zorge', 'ул. Рихарда Зорге', 'osm-node-12136502789']], specialties: ['gynecologist', 'urologist', 'therapist', 'endocrinologist'], extra: ['gynecologist'], age: 'adult' },
]);

const REAL_POINTS = new Map(REAL_PRIVATE_CLINIC_POINTS.map((point) => [point.osmId, point]));

/** Все клиники набора: сначала вымышленные (их порядок задаёт имена и id), потом реальные. */
const ALL_CLINICS = Object.freeze([...CLINICS, ...REAL_CLINICS.map((spec) => ({ ...spec, real: true }))]);

/* ---------- Имена ---------- */

/*
 * Имена собираются из списков. Совпадение с реальным человеком возможно
 * и случайно; в интерфейсе каждая карточка помечена «Демо».
 */
const SURNAMES = [
  ['Абдуллин', 'Абдуллина'], ['Белоусов', 'Белоусова'], ['Валеев', 'Валеева'], ['Галиев', 'Галиева'], ['Давыдов', 'Давыдова'],
  ['Ефимов', 'Ефимова'], ['Жуков', 'Жукова'], ['Зарипов', 'Зарипова'], ['Ибрагимов', 'Ибрагимова'], ['Калинин', 'Калинина'],
  ['Ларионов', 'Ларионова'], ['Мухаметзянов', 'Мухаметзянова'], ['Никитин', 'Никитина'], ['Осипов', 'Осипова'], ['Прохоров', 'Прохорова'],
  ['Рахимов', 'Рахимова'], ['Сабиров', 'Сабирова'], ['Тимофеев', 'Тимофеева'], ['Усманов', 'Усманова'], ['Фролов', 'Фролова'],
  ['Хасанов', 'Хасанова'], ['Цветков', 'Цветкова'], ['Чернов', 'Чернова'], ['Шайхутдинов', 'Шайхутдинова'], ['Яхин', 'Яхина'],
  ['Аксёнов', 'Аксёнова'], ['Бурханов', 'Бурханова'], ['Вагизов', 'Вагизова'], ['Гурьянов', 'Гурьянова'], ['Дьячков', 'Дьячкова'],
  ['Егоршин', 'Егоршина'], ['Зиннатуллин', 'Зиннатуллина'], ['Исмагилов', 'Исмагилова'], ['Кожевников', 'Кожевникова'], ['Латыпов', 'Латыпова'],
  ['Мельников', 'Мельникова'], ['Насыров', 'Насырова'], ['Овчинников', 'Овчинникова'], ['Пестов', 'Пестова'], ['Рябинин', 'Рябинина'],
  ['Сафиуллин', 'Сафиуллина'], ['Тагиров', 'Тагирова'], ['Уразов', 'Уразова'], ['Фаттахов', 'Фаттахова'], ['Хабибуллин', 'Хабибуллина'],
  ['Шарафутдинов', 'Шарафутдинова'], ['Юнусов', 'Юнусова'], ['Агеев', 'Агеева'], ['Булыгин', 'Булыгина'], ['Воронцов', 'Воронцова'],
];
/*
 * Фамилии врачей реальных клиник — отдельный список: выбор зависит от длины
 * списка, и общий список поменял бы имена и id врачей вымышленных клиник.
 * Без фамилий, совпадающих с названиями клиник набора.
 */
const SURNAMES_EXTRA = [
  ['Алексеев', 'Алексеева'], ['Баранов', 'Баранова'], ['Волков', 'Волкова'], ['Гаязов', 'Гаязова'], ['Еремеев', 'Еремеева'],
  ['Зайцев', 'Зайцева'], ['Ильин', 'Ильина'], ['Карпов', 'Карпова'], ['Лебедев', 'Лебедева'], ['Миронов', 'Миронова'],
  ['Назаров', 'Назарова'], ['Орлов', 'Орлова'], ['Павлов', 'Павлова'], ['Романов', 'Романова'], ['Соколов', 'Соколова'],
  ['Титов', 'Титова'], ['Хайруллин', 'Хайруллина'], ['Шакиров', 'Шакирова'], ['Ахметов', 'Ахметова'], ['Гарипов', 'Гарипова'],
  ['Закиров', 'Закирова'], ['Минуллин', 'Минуллина'], ['Валиуллин', 'Валиуллина'], ['Гимадиев', 'Гимадиева'], ['Борисов', 'Борисова'],
  ['Кузнецов', 'Кузнецова'], ['Морозов', 'Морозова'], ['Поляков', 'Полякова'], ['Смирнов', 'Смирнова'], ['Степанов', 'Степанова'],
  ['Тихонов', 'Тихонова'], ['Филиппов', 'Филиппова'], ['Шамсутдинов', 'Шамсутдинова'], ['Яруллин', 'Яруллина'], ['Камалов', 'Камалова'],
  ['Белов', 'Белова'], ['Гусев', 'Гусева'], ['Денисов', 'Денисова'], ['Журавлёв', 'Журавлёва'], ['Комаров', 'Комарова'],
  ['Афанасьев', 'Афанасьева'], ['Бикмуллин', 'Бикмуллина'], ['Власов', 'Власова'], ['Галимов', 'Галимова'], ['Дмитриев', 'Дмитриева'],
  ['Ерофеев', 'Ерофеева'], ['Зуев', 'Зуева'], ['Исаев', 'Исаева'], ['Киселёв', 'Киселёва'], ['Лукин', 'Лукина'],
  ['Макаров', 'Макарова'], ['Низамов', 'Низамова'], ['Осокин', 'Осокина'], ['Пономарёв', 'Пономарёва'], ['Рашитов', 'Рашитова'],
  ['Сергеев', 'Сергеева'], ['Тарасов', 'Тарасова'], ['Ушаков', 'Ушакова'], ['Фахрутдинов', 'Фахрутдинова'], ['Чистяков', 'Чистякова'],
];
const MALE_NAMES = ['Айдар', 'Артём', 'Булат', 'Вадим', 'Глеб', 'Данияр', 'Евгений', 'Ильдар', 'Кирилл', 'Ленар', 'Марат', 'Никита', 'Олег', 'Ринат', 'Тимур', 'Фарид'];
const FEMALE_NAMES = ['Алина', 'Гузель', 'Дарья', 'Елена', 'Зульфия', 'Ирина', 'Камила', 'Лилия', 'Мария', 'Наиля', 'Ольга', 'Регина', 'Светлана', 'Татьяна', 'Эльмира', 'Юлия'];
const PATRONYMICS = [
  ['Айдарович', 'Айдаровна'], ['Андреевич', 'Андреевна'], ['Булатович', 'Булатовна'], ['Викторович', 'Викторовна'], ['Ильдарович', 'Ильдаровна'],
  ['Маратович', 'Маратовна'], ['Николаевич', 'Николаевна'], ['Олегович', 'Олеговна'], ['Ринатович', 'Ринатовна'], ['Сергеевич', 'Сергеевна'],
  ['Рустемович', 'Рустемовна'], ['Павлович', 'Павловна'],
];

/* ---------- Графики ---------- */

/*
 * Типовые смены. Вечерние смены нужны в каждой крупной специальности:
 * запрос «после 18:00» — один из главных сценариев демо.
 */
const SHIFTS = Object.freeze({
  morning: { start: '08:00', end: '14:00', breakAt: null },
  day: { start: '10:00', end: '18:00', breakAt: ['13:30', '14:00'] },
  evening: { start: '14:00', end: '21:00', breakAt: ['17:30', '18:00'] },
  late: { start: '16:00', end: '21:00', breakAt: null },
});
const SATURDAY_SHIFT = { start: '09:00', end: '15:00', breakAt: null };
const SUNDAY_SHIFT = { start: '10:00', end: '15:00', breakAt: null };

const DAY_CODES = ['', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** Интервалы смены без перерыва: [[начало, конец], …] в минутах. */
export const shiftIntervals = (shift) => {
  const start = minutesOf(shift.start);
  const end = minutesOf(shift.end);
  if (!shift.breakAt) return [[start, end]];
  return [[start, minutesOf(shift.breakAt[0])], [minutesOf(shift.breakAt[1]), end]];
};

/** Смена как строка часов OSM: «14:00-17:30,18:00-21:00». */
const shiftText = (shift) => shiftIntervals(shift).map(([from, to]) => `${timeOf(from)}-${timeOf(to)}`).join(',');

/** График врача в филиале строкой OSM («Mo,We 14:00-17:30,18:00-21:00; Sa 09:00-15:00»). */
export const scheduleText = (entries) => {
  const groups = new Map();
  for (const entry of entries) {
    const key = shiftText(entry.shift);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry.weekday);
  }
  return [...groups.entries()]
    .sort((left, right) => Math.min(...left[1]) - Math.min(...right[1]))
    .map(([text, days]) => `${days.sort((a, b) => a - b).map((day) => DAY_CODES[day]).join(',')} ${text}`)
    .join('; ');
};

const branchHoursText = (hours) => {
  const parts = [`Mo-Fr ${hours.weekday[0]}-${hours.weekday[1]}`, `Sa ${hours.saturday[0]}-${hours.saturday[1]}`];
  if (hours.sunday) parts.push(`Su ${hours.sunday[0]}-${hours.sunday[1]}`);
  return parts.join('; ');
};

/** Часы филиала в день недели: [начало, конец] в минутах или null. */
export const branchOpenOn = (hoursKey, weekday) => {
  const hours = BRANCH_HOURS[hoursKey];
  if (!hours.days.includes(weekday)) return null;
  const pair = weekday === 7 ? hours.sunday : weekday === 6 ? hours.saturday : hours.weekday;
  return pair ? [minutesOf(pair[0]), minutesOf(pair[1])] : null;
};

/** Часы реального филиала (по OSM) в день недели: [начало, конец] в минутах или null. */
const realOpenOn = (point, weekday) => {
  const pair = point.hours[weekday];
  return pair ? [minutesOf(pair[0]), minutesOf(pair[1])] : null;
};

/*
 * Смена, подогнанная под часы клиники: врач не принимает раньше открытия и
 * позже закрытия. Перерыв остаётся, только если он целиком внутри смены.
 * Короче трёх часов — смены нет.
 */
const MIN_SHIFT_MINUTES = 180;
const fitShift = (shift, open) => {
  if (!open) return null;
  const start = Math.max(minutesOf(shift.start), open[0]);
  const end = Math.min(minutesOf(shift.end), open[1]);
  if (end - start < MIN_SHIFT_MINUTES) return null;
  const breakAt = shift.breakAt && minutesOf(shift.breakAt[0]) > start && minutesOf(shift.breakAt[1]) < end ? shift.breakAt : null;
  return { start: timeOf(start), end: timeOf(end), breakAt };
};

const realHoursText = (point) => {
  const groups = new Map();
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const pair = point.hours[weekday];
    if (!pair) continue;
    const key = `${pair[0]}-${pair[1]}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(weekday);
  }
  return [...groups.entries()].map(([text, list]) => {
    const contiguous = list.length > 2 && list[list.length - 1] - list[0] === list.length - 1;
    return `${contiguous ? `${DAY_CODES[list[0]]}-${DAY_CODES[list[list.length - 1]]}` : list.map((day) => DAY_CODES[day]).join(',')} ${text}`;
  }).join('; ');
};

/* ---------- Генерация справочника ---------- */

/**
 * Статичная часть демо-набора: клиники, филиалы, врачи, услуги, цены,
 * графики и программы ДМС. Формат совместим с shared/privateCatalog.js —
 * карта и ассистент используют те же функции, что и для реальных клиник.
 */
export const generateDemoCatalog = ({ seed = DEMO_SEED } = {}) => {
  const random = createRandom(seed, 'catalog');

  const clinics = [];
  const branchMeta = new Map();
  let pointPhone = 0;
  for (const spec of CLINICS) {
    const branches = spec.branches.map(([suffix, label, pointKey]) => {
      const point = BRANCH_POINTS[pointKey];
      pointPhone += 1;
      const id = `${spec.id}-${suffix}`;
      const branch = {
        id,
        name: label,
        district: point.district,
        address: `Казань, ${point.district} район, демо-адрес (точка на карте условная)`,
        lat: point.lat,
        lng: point.lng,
        phone: `+7 (843) 000-${String(10 + pointPhone).padStart(2, '0')}-00`,
        hours: branchHoursText(BRANCH_HOURS[spec.hours]),
        features: { wheelchair: random.chance(0.7), parking: random.chance(0.6), onlineBooking: true },
      };
      branchMeta.set(id, { clinic: spec, branch });
      return branch;
    });
    clinics.push({
      id: spec.id,
      name: spec.name,
      ownership: 'Частная',
      facilityType: spec.type,
      website: `https://${spec.id}.example`,
      description: 'Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.',
      tier: spec.tier,
      branches,
    });
  }

  /*
   * Реальные частные клиники: всё о самой клинике — из OSM, без выдумок
   * (ни телефона, ни «есть парковка»). Вымышлено только то, что внутри:
   * врачи, цены, расписание.
   */
  for (const spec of REAL_CLINICS) {
    const points = spec.branches.map(([, , osmId]) => REAL_POINTS.get(osmId));
    if (points.some((point) => !point)) throw new Error(`нет точки реальной клиники ${spec.id}`);
    const branches = spec.branches.map(([suffix, label], position) => {
      const point = points[position];
      const id = `${spec.id}-${suffix}`;
      const branch = {
        id,
        name: label,
        district: point.district,
        address: point.address,
        lat: point.lat,
        lng: point.lng,
        phone: null,
        hours: realHoursText(point),
        osmId: point.osmId,
        features: {},
      };
      branchMeta.set(id, { clinic: spec, branch, point });
      return branch;
    });
    clinics.push({
      id: spec.id,
      name: spec.name,
      ownership: 'Частная',
      facilityType: spec.type,
      website: points.find((point) => point.website)?.website || null,
      description: 'Реальная частная клиника: название, адрес, точка и часы работы — из OpenStreetMap. Врачи, цены, расписание и запись здесь вымышленные, демонстрационные — клиника о них не знает.',
      real: true,
      source: 'OSM',
      tier: spec.tier,
      branches,
    });
  }

  /* Врачи: по одному на специальность клиники, по два — на extra. */
  const usedNames = new Set();
  const nameFor = (key, surnames = SURNAMES) => {
    const name = createRandom(seed, `name|${key}`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const female = name.chance(0.55);
      const pair = name.pick(surnames);
      const surname = pair[female ? 1 : 0];
      const first = name.pick(female ? FEMALE_NAMES : MALE_NAMES);
      const patronymic = name.pick(PATRONYMICS)[female ? 1 : 0];
      const full = `${surname} ${first} ${patronymic}`;
      // Однофамильцы в одном наборе путают: фамилия не повторяется,
      // а в новом списке — и в другой форме («Белов» и «Белова»).
      const family = surnames === SURNAMES ? surname : `family|${pair[0]}`;
      if (!usedNames.has(full) && !usedNames.has(surname) && !usedNames.has(family)) {
        usedNames.add(full);
        usedNames.add(surname);
        usedNames.add(family);
        return { full, gender: female ? 'female' : 'male' };
      }
    }
    throw new Error(`не удалось подобрать уникальное имя для ${key}`);
  };

  const doctors = [];
  const prices = [];
  const pricedServices = new Set();

  for (const spec of ALL_CLINICS) {
    const branchIds = spec.branches.map(([suffix]) => `${spec.id}-${suffix}`);
    const roster = [...spec.specialties, ...spec.extra];
    const counts = new Map();
    for (const [order, specialty] of roster.entries()) {
      counts.set(specialty, (counts.get(specialty) || 0) + 1);
      const key = `${spec.id}|${specialty}|${counts.get(specialty)}`;
      const { full: name, gender } = nameFor(key, spec.real ? SURNAMES_EXTRA : SURNAMES);
      const rnd = createRandom(seed, `doctor|${key}`);

      /* Возраст пациентов: детская клиника — дети; семейная — оба. */
      let ageGroups = spec.age === 'child' || specialty === 'pediatrician' ? ['child'] : ['adult'];
      if (spec.age === 'both' && specialty !== 'pediatrician' && rnd.chance(0.6)) ageGroups = ['adult', 'child'];
      const childOnly = ageGroups.length === 1 && ageGroups[0] === 'child';
      const canon = SPECIALTY_CANON[specialty];
      const label = childOnly && specialty !== 'pediatrician' ? `Детский ${specialty === 'lor' ? canon : canon.toLowerCase()}` : canon;

      /* Услуги: первичный и повторный приём; процедура — у части врачей. */
      const serviceIds = [`consult.${specialty}.first`, `consult.${specialty}.repeat`];
      const procedure = PROCEDURES[specialty];
      if (procedure && rnd.chance(0.65)) serviceIds.push(procedure.id);

      /*
       * Филиалы и дни. Врач сети с двумя филиалами работает в обоих —
       * в разные дни; остальные — в одном.
       */
      const twoBranches = branchIds.length > 1 && rnd.chance(0.35);
      const homeIndex = order % branchIds.length;
      const doctorBranches = twoBranches ? branchIds : [branchIds[homeIndex]];
      const shiftKinds = ['morning', 'day', 'evening', 'late'];
      // Каждой второй специальности клиники — вечерняя смена: «после 18:00» должно находиться.
      const mainShift = order % 2 === 1 ? rnd.pick(['evening', 'late']) : rnd.pick(shiftKinds);
      const weekdays = rnd.shuffle([1, 2, 3, 4, 5]).slice(0, rnd.int(3, 5)).sort((a, b) => a - b);
      const schedule = [];
      weekdays.forEach((weekday, index) => {
        const branchId = doctorBranches[twoBranches ? index % 2 : 0];
        // Каждый третий день — другая смена: у врача бывают и утренние, и вечерние приёмы.
        const shiftKey = index % 3 === 2 ? rnd.pick(shiftKinds) : mainShift;
        if (!spec.real) {
          schedule.push({ branchId, weekday, shift: SHIFTS[shiftKey] });
          return;
        }
        // Реальная клиника: смена — в часах её работы по OSM; не помещается — другая смена или выходной.
        const open = realOpenOn(branchMeta.get(branchId).point, weekday);
        const shift = [shiftKey, ...shiftKinds].map((kind) => fitShift(SHIFTS[kind], open)).find(Boolean);
        if (shift) schedule.push({ branchId, weekday, shift });
      });
      if (spec.real) {
        // Суббота и воскресенье — только если клиника по OSM в эти дни работает.
        for (const [weekday, base, chance] of [[6, SATURDAY_SHIFT, 0.4], [7, SUNDAY_SHIFT, 0.3]]) {
          const shift = fitShift(base, realOpenOn(branchMeta.get(doctorBranches[0]).point, weekday));
          if (shift && rnd.chance(chance)) schedule.push({ branchId: doctorBranches[0], weekday, shift });
        }
        if (schedule.length === 0) throw new Error(`у врача ${name} нет ни одной смены в часах клиники`);
      }
      const hoursKey = spec.hours;
      if (!spec.real && rnd.chance(0.4)) schedule.push({ branchId: doctorBranches[0], weekday: 6, shift: SATURDAY_SHIFT });
      if (!spec.real && BRANCH_HOURS[hoursKey].sunday && rnd.chance(0.3)) schedule.push({ branchId: doctorBranches[0], weekday: 7, shift: SUNDAY_SHIFT });

      // Смена внутри часов филиала: на случай правки таблиц выше — проверка здесь же.
      for (const entry of schedule) {
        const open = spec.real ? realOpenOn(branchMeta.get(entry.branchId).point, entry.weekday) : branchOpenOn(hoursKey, entry.weekday);
        const [start, end] = [minutesOf(entry.shift.start), minutesOf(entry.shift.end)];
        if (!open || start < open[0] || end > open[1]) {
          throw new Error(`смена врача ${name} вне часов филиала ${entry.branchId}`);
        }
      }

      const usedBranches = [...new Set(schedule.map((entry) => entry.branchId))];
      const hoursByBranch = Object.fromEntries(usedBranches.map((branchId) => [
        branchId,
        scheduleText(schedule.filter((entry) => entry.branchId === branchId)),
      ]));

      const [surnameWord, firstWord] = name.split(' ');
      const id = `demo-doc-${slug(surnameWord)}-${slug(firstWord)}`;
      if (doctors.some((doctor) => doctor.id === id)) throw new Error(`повтор id врача ${id}`);
      doctors.push({
        id,
        name,
        specialty: label,
        specialtyKey: specialty,
        ageGroups,
        branchIds: usedBranches,
        serviceIds,
        hoursByBranch,
        schedule: schedule.map((entry) => ({
          branchId: entry.branchId,
          weekday: entry.weekday,
          start: entry.shift.start,
          end: entry.shift.end,
          breakAt: entry.shift.breakAt,
        })),
        experienceYears: rnd.int(3, 28),
        gender,
        features: { children: ageGroups.includes('child') },
        description: spec.real
          ? `Демонстрационный врач: вымышленное лицо. Клиника «${spec.name}» реальная, но этот врач, его расписание и цены придуманы для показа записи.`
          : 'Демонстрационный врач: вымышленное лицо для показа записи.',
      });

      /* Цены: единые для всех филиалов клиники. */
      const factor = TIER_FACTOR[spec.tier];
      const [first, repeat] = BASE_PRICES[specialty];
      const serviceBase = { [`consult.${specialty}.first`]: first, [`consult.${specialty}.repeat`]: repeat };
      if (procedure) serviceBase[procedure.id] = procedure.base;
      for (const serviceId of serviceIds) {
        for (const branchId of branchIds) {
          const priceKey = `${branchId}|${serviceId}`;
          if (pricedServices.has(priceKey)) continue;
          pricedServices.add(priceKey);
          prices.push({ branchId, serviceId, price: roundPrice(serviceBase[serviceId] * factor) });
        }
      }
    }
  }

  const services = [...new Set(doctors.flatMap((doctor) => doctor.serviceIds))].sort().map((serviceId) => {
    const base = SERVICE_BY_ID[serviceId];
    const specialty = base?.specialty;
    const minutes = base?.kind === 'consult'
      ? (base.visit === 'first' ? FIRST_MINUTES[specialty] || 30 : REPEAT_MINUTES[specialty] || 20)
      : Object.values(PROCEDURES).find((item) => item.id === serviceId)?.minutes || 30;
    return { id: serviceId, name: base.name, specialty, kind: base.kind, visit: base.visit || null, durationMinutes: minutes };
  });

  return {
    meta: {
      source: 'demo',
      version: DEMO_VERSION,
      seed,
      verifiedAt: '2026-10-09',
      disclaimer: 'Демонстрационные данные: врачи, цены, расписание и программы ДМС вымышлены и не являются предложениями реальных организаций. Клиники с «Демо» в названии вымышлены; у реальных частных клиник настоящие только название, адрес, точка и часы работы (OpenStreetMap).',
    },
    clinics,
    doctors,
    prices,
    services,
    insurance: generateDemoInsurance(clinics, doctors),
  };
};

/* ---------- ДМС ---------- */

/*
 * Три программы с разным покрытием. Модель — та же, что для реальных
 * памяток (shared/dms.js): правила по филиалам, специальностям и услугам,
 * режимы доступа «прямо / по направлению / по согласованию / исключено».
 */
const generateDemoInsurance = (clinics) => {
  const branchesOf = (...clinicIds) => clinics.filter((clinic) => clinicIds.includes(clinic.id)).flatMap((clinic) => clinic.branches.map((branch) => branch.id));
  const coverage = [];
  const add = (planId, branchIds, rule) => branchIds.forEach((branchId) => coverage.push({ planId, branchId, ...rule }));

  /*
   * Demo Basic: эконом-сеть, базовые специалисты, процедуры не входят.
   * Реальные клиники в программах — тоже часть вымысла: «Демо-Страхование»
   * с ними ни о чём не договаривалось.
   */
  const basicClinics = ['demo-beresta', 'demo-semya', 'demo-travma', 'demo-real-aibolit'];
  const basic = branchesOf(...basicClinics);
  for (const specialty of ['therapist', 'lor', 'ophthalmologist', 'gynecologist', 'surgeon', 'traumatologist']) {
    add('demo-basic', basic, { scope: 'specialty', specialty, access: 'direct' });
  }
  for (const specialty of ['neurologist', 'cardiologist', 'endocrinologist']) {
    add('demo-basic', basic, { scope: 'specialty', specialty, access: 'referral_required', notes: 'По направлению терапевта по программе.' });
  }
  for (const serviceId of ['proc.lor.tonsils', 'proc.ophthalmologist.glasses', 'diag.ecg', 'proc.gynecologist.ultrasound']) {
    add('demo-basic', basic, { scope: 'service', serviceId, access: 'excluded', notes: 'Процедуры не входят в Demo Basic.' });
  }

  /* Demo Standard: взрослые и дети, большинство клиник; процедуры — по согласованию. */
  const standardClinics = [
    'demo-yasen', 'demo-beresta', 'demo-semya', 'demo-detstvo', 'demo-pediatr-plus', 'demo-zhenskoe', 'demo-travma', 'demo-derma', 'demo-dent',
    'demo-real-razumed', 'demo-real-aibolit', 'demo-real-citidoc', 'demo-real-kuzlyar',
  ];
  const standard = branchesOf(...standardClinics);
  add('demo-standard', standard, { scope: 'all_outpatient', access: 'direct' });
  for (const serviceId of ['proc.lor.tonsils', 'proc.ophthalmologist.glasses', 'proc.dermatologist.dermatoscopy', 'proc.gynecologist.ultrasound', 'diag.ecg']) {
    add('demo-standard', standard, { scope: 'service', serviceId, access: 'approval_required', notes: 'Процедура — после согласования со страховой.' });
  }
  add('demo-standard', branchesOf('demo-dent'), { scope: 'service', serviceId: 'proc.dentist.hygiene', access: 'excluded', notes: 'Профгигиена не входит в Demo Standard.' });
  add('demo-standard', standard, { scope: 'specialty', specialty: 'psychiatrist', access: 'excluded', notes: 'Психиатрия не входит в Demo Standard.' });

  /* Demo Premium: все демо-клиники напрямую; профгигиена — раз в год по согласованию. */
  const premium = clinics.flatMap((clinic) => clinic.branches.map((branch) => branch.id));
  add('demo-premium', premium, { scope: 'all_outpatient', access: 'direct' });
  add('demo-premium', branchesOf('demo-dent', 'demo-ulybka'), { scope: 'service', serviceId: 'proc.dentist.hygiene', access: 'approval_required', limitPerYear: 1, notes: 'Профгигиена — раз в год, по согласованию.' });

  return {
    meta: { source: 'demo', verifiedAt: '2026-10-09' },
    providers: [
      {
        id: 'demo-insurer',
        name: 'Демо-Страхование',
        demo: true,
        pultPhone: '+7 (800) 000-00-00',
        bookingNote: 'Демонстрационная страховая: программы вымышлены и не связаны с реальными страховщиками.',
      },
    ],
    plans: [
      { id: 'demo-basic', providerId: 'demo-insurer', name: 'Demo Basic', insured: 'adult', validFrom: '2026-01-01', validTo: '2027-12-31', sourceDoc: 'Демо-программа, не реальный полис', summary: `Терапевт, ЛОР, офтальмолог, гинеколог, хирург и травматолог в ${basicClinics.length} клиниках эконом-сегмента. Невролог, кардиолог, эндокринолог — по направлению. Процедуры не входят.` },
      { id: 'demo-standard', providerId: 'demo-insurer', name: 'Demo Standard', insured: 'family', validFrom: '2026-01-01', validTo: '2027-12-31', sourceDoc: 'Демо-программа, не реальный полис', summary: `Взрослые и дети, ${standardClinics.length} клиник. Приёмы напрямую, процедуры — после согласования. Психиатрия и профгигиена не входят.` },
      { id: 'demo-premium', providerId: 'demo-insurer', name: 'Demo Premium', insured: 'family', validFrom: '2026-01-01', validTo: '2027-12-31', sourceDoc: 'Демо-программа, не реальный полис', summary: `Все ${clinics.length} клиник демо-набора и все услуги напрямую. Профгигиена — раз в год по согласованию.` },
    ],
    coverage,
  };
};

/* ---------- Слоты на дату ---------- */

/** Доля слотов, уже занятых «другими пациентами» и закрытых клиникой. */
const INITIAL_BOOKED = 0.3;
const INITIAL_BLOCKED = 0.05;

/**
 * Отсутствие врача в день: отпуск на неделю у части врачей и редкие
 * отгулы. Детерминированно по seed, врачу и дате.
 */
export const absenceOn = (seed, doctorId, day) => {
  const week = Math.floor((dayIndex(day) + 3) / 7);
  if (unit(seed, 'vacation', doctorId, week) < 0.06) return 'vacation';
  if (unit(seed, 'dayoff', doctorId, day) < 0.04) return 'day_off';
  return null;
};

/**
 * Слоты врача на дату во всех его филиалах. Слоты идут подряд внутри
 * смены, длительность слота — длительность его услуги; перерыв пропускается.
 *
 * @returns {{absence: string|null, slots: object[]}}
 */
export const generateDaySlots = (catalog, doctor, day, { seed = catalog.meta.seed } = {}) => {
  const weekday = weekdayOf(day);
  const absence = absenceOn(seed, doctor.id, day);
  const entries = doctor.schedule.filter((entry) => entry.weekday === weekday);
  if (entries.length === 0) return { absence: null, slots: [] };
  if (absence) return { absence, slots: [] };

  const serviceById = new Map(catalog.services.map((service) => [service.id, service]));
  const first = serviceById.get(doctor.serviceIds[0]);
  const repeat = serviceById.get(doctor.serviceIds[1]);
  const procedure = doctor.serviceIds[2] ? serviceById.get(doctor.serviceIds[2]) : null;
  const clinicByBranch = new Map(catalog.clinics.flatMap((clinic) => clinic.branches.map((branch) => [branch.id, clinic.id])));

  const slots = [];
  for (const entry of entries) {
    const intervals = shiftIntervals(entry);
    let index = 0;
    for (const [from, to] of intervals) {
      let cursor = from;
      while (cursor < to) {
        const roll = unit(seed, 'service', doctor.id, day, cursor);
        let service = roll < 0.6 ? first : roll < 0.9 || !procedure ? repeat : procedure;
        if (cursor + service.durationMinutes > to) service = [repeat, first, procedure].filter(Boolean).find((item) => cursor + item.durationMinutes <= to) || null;
        if (!service) break;
        const start = timeOf(cursor);
        const id = `${doctor.id}--${entry.branchId}--${day.replace(/-/g, '')}-${start.replace(':', '')}`;
        const state = unit(seed, 'state', id);
        slots.push({
          id,
          clinicId: clinicByBranch.get(entry.branchId),
          branchId: entry.branchId,
          doctorId: doctor.id,
          serviceId: service.id,
          day,
          start,
          end: timeOf(cursor + service.durationMinutes),
          status: state < INITIAL_BOOKED ? 'BOOKED' : state < INITIAL_BOOKED + INITIAL_BLOCKED ? 'BLOCKED' : 'FREE',
          index,
        });
        index += 1;
        cursor += service.durationMinutes;
      }
    }
  }
  return { absence: null, slots };
};

/** Дни окна расписания, начиная с даты. */
export const windowDays = (startDay, days = SLOT_WINDOW_DAYS) => Array.from({ length: days }, (_, offset) => addDays(startDay, offset));

export const DEMO_SPECIALTIES = Object.freeze([...new Set(ALL_CLINICS.flatMap((clinic) => clinic.specialties))].filter((key) => SPECIALTY_KEYS.includes(key)));
