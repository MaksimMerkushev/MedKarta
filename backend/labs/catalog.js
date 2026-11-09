/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Исходный набор лабораторного модуля: каталог исследований, демо-лаборатории,
 * филиалы, цены и расписания. Каталог исследований — справочник с принятыми в
 * лабораторной практике названиями и синонимами. Лаборатории, филиалы, цены,
 * сроки и слоты вымышлены. Совпадение названий с действующими сетями случайно,
 * партнёрства нет.
 *
 * Филиалы стоят рядом с известными местами Казани (shared/kazanPlaces.js,
 * координаты OpenStreetMap). Точка филиала смещена от места на 50–250 м
 * детерминированно, поэтому адрес не выдаётся за настоящий: «около метро …».
 *
 * Тексты о подготовке — общие правила, заранее подготовленные и проверяемые;
 * ассистент их не сочиняет. В интерфейсе к ним приписано, что правила нужно
 * сверить с лабораторией.
 */

import { KAZAN_PLACES } from '../../shared/kazanPlaces.js';
import { createRandom } from '../demo/random.js';

export const LAB_CATALOG_VERSION = 1;

export const CATEGORIES = Object.freeze([
  { id: 'clinical', name: 'Общеклинические исследования' },
  { id: 'biochemistry', name: 'Биохимия крови' },
  { id: 'hormones', name: 'Гормоны' },
  { id: 'vitamins', name: 'Витамины и микроэлементы' },
  { id: 'coagulation', name: 'Гемостаз' },
  { id: 'immunology', name: 'Иммунология' },
  { id: 'infections', name: 'Инфекционные исследования' },
  { id: 'urine', name: 'Исследования мочи' },
  { id: 'feces', name: 'Исследования кала' },
]);
export const CATEGORY_IDS = Object.freeze(CATEGORIES.map((item) => item.id));

/* Биоматериал и процедура взятия: процедура оплачивается один раз за посещение. */
export const BIOMATERIALS = Object.freeze({
  venous_blood: { name: 'Венозная кровь', fee: 'Взятие крови из вены' },
  capillary_blood: { name: 'Капиллярная кровь', fee: 'Взятие капиллярной крови' },
  urine: { name: 'Моча', fee: 'Контейнер для мочи' },
  feces: { name: 'Кал', fee: 'Контейнер для кала' },
  swab: { name: 'Мазок', fee: 'Взятие мазка' },
});
export const BIOMATERIAL_KINDS = Object.freeze(Object.keys(BIOMATERIALS));

export const PREPARATION_NOTE = 'Справочные демо-данные. Перед сдачей уточните правила подготовки в лаборатории или у врача.';

const PREP = Object.freeze({
  fasting: 'Натощак: после последнего приёма пищи должно пройти 8–12 часов. Можно пить чистую негазированную воду. За сутки исключить алкоголь и жирную пищу, за 30 минут — курение и физическую нагрузку.',
  lipids: 'Строго натощак: 12–14 часов без еды, можно пить чистую негазированную воду. За сутки исключить алкоголь и жирную пищу, за 30 минут — курение.',
  cbc: 'Желательно натощак или через 3–4 часа после лёгкого приёма пищи. За 30 минут до сдачи не курить и избегать физической нагрузки.',
  thyroid: 'Утром, натощак или через 4 часа после лёгкого приёма пищи. Если принимаете препараты гормонов щитовидной железы, сдавайте до приёма таблетки и скажите об этом врачу.',
  hormones: 'Утром, натощак. За сутки исключить алкоголь и интенсивные нагрузки. День цикла для половых гормонов назначает врач.',
  cortisol: 'Утром, с 7 до 10 часов, натощак. За сутки исключить алкоголь и интенсивные нагрузки, за 30 минут — курение, перед сдачей посидеть спокойно 10–15 минут.',
  gtt: 'Только по назначению врача. Натощак (8–14 часов без еды), тест длится около 2 часов: кровь берут до и после приёма раствора глюкозы. В это время нельзя есть, курить и много двигаться.',
  plain: 'Специальной подготовки не требуется. Желательно сдавать утром.',
  urine: 'Утренняя порция мочи после гигиены наружных половых органов, в стерильный контейнер. Доставить в лабораторию в течение 2 часов. Женщинам не сдавать во время менструации.',
  urine_culture: 'Утренняя средняя порция мочи в стерильный контейнер, до начала приёма антибиотиков или не ранее чем через 2 недели после окончания курса. Доставить в течение 2 часов.',
  feces: 'Собрать в стерильный контейнер без примеси мочи. Не использовать слабительные и свечи за 2–3 дня до сдачи. Доставить в лабораторию в тот же день.',
  occult: 'Собрать в специальный контейнер из набора лаборатории. Иммунохимический тест не требует диеты; во время менструации и при кровотечении из геморроидальных узлов не сдавать.',
  swab_resp: 'За 3–4 часа до взятия мазка не есть, не пить, не чистить зубы, не полоскать горло и не закапывать капли в нос.',
  swab_uro: 'За 2–3 часа до взятия мазка не мочиться. За 2 дня исключить местные средства (свечи, спринцевание). Женщинам — вне менструации.',
});

/*
 * Каталог исследований. code — канонический идентификатор: его выбирает ассистент,
 * по нему считается корзина. synonyms — как называют исследование в направлениях и в
 * разговоре. Разные по составу исследования — разные коды (ОАК с лейкоцитарной
 * формулой и без неё). hours — ориентировочный срок готовности.
 */
export const TESTS = Object.freeze([
  // Общеклинические
  { code: 'CBC_DIFF', name: 'Общий анализ крови с лейкоцитарной формулой', category: 'clinical', biomaterial: 'venous_blood', price: 450, hours: 24, prep: 'cbc', synonyms: ['ОАК', 'общий анализ крови', 'клинический анализ крови', 'развёрнутый анализ крови', 'ОАК с лейкоформулой', 'общий анализ крови с формулой', 'ОАК с формулой'], description: 'Эритроциты, гемоглобин, гематокрит, тромбоциты, лейкоциты и лейкоцитарная формула (доли разных видов лейкоцитов).', components: ['Гемоглобин', 'Эритроциты', 'Гематокрит', 'Тромбоциты', 'Лейкоциты', 'Лейкоцитарная формула'] },
  { code: 'CBC', name: 'Общий анализ крови без лейкоцитарной формулы', category: 'clinical', biomaterial: 'venous_blood', price: 330, hours: 24, prep: 'cbc', synonyms: ['ОАК без лейкоцитарной формулы', 'ОАК без формулы', 'общий анализ крови без формулы', 'общий анализ крови без лейкоформулы'], description: 'Эритроциты, гемоглобин, гематокрит, тромбоциты и общее число лейкоцитов — без подсчёта лейкоцитарной формулы.', components: ['Гемоглобин', 'Эритроциты', 'Гематокрит', 'Тромбоциты', 'Лейкоциты'] },
  { code: 'ESR', name: 'СОЭ (скорость оседания эритроцитов)', category: 'clinical', biomaterial: 'venous_blood', price: 220, hours: 24, prep: 'cbc', synonyms: ['СОЭ', 'скорость оседания эритроцитов', 'РОЭ'], unit: 'мм/ч', description: 'Неспецифический показатель, который врач оценивает вместе с другими анализами.' },
  { code: 'RETIC', name: 'Ретикулоциты', category: 'clinical', biomaterial: 'venous_blood', price: 320, hours: 24, prep: 'cbc', synonyms: ['ретикулоциты', 'ретикулоцитов'], unit: '%', description: 'Молодые формы эритроцитов.' },
  { code: 'BLOOD_GROUP', name: 'Группа крови и резус-фактор', category: 'clinical', biomaterial: 'venous_blood', price: 520, hours: 24, prep: 'plain', synonyms: ['группа крови', 'резус фактор', 'группа крови и резус', 'резус-фактор'], description: 'Определение группы крови по системе AB0 и резус-принадлежности.' },
  // Биохимия
  { code: 'GLUCOSE', name: 'Глюкоза в крови (венозная плазма)', category: 'biochemistry', biomaterial: 'venous_blood', price: 250, hours: 24, prep: 'fasting', fasting: true, synonyms: ['глюкоза', 'глюкоза в крови', 'сахар в крови', 'кровь на сахар', 'анализ крови на сахар', 'глюкоза натощак', 'сахар натощак'], unit: 'ммоль/л', description: 'Уровень глюкозы в венозной плазме натощак.' },
  { code: 'HBA1C', name: 'Гликированный гемоглобин (HbA1c)', category: 'biochemistry', biomaterial: 'venous_blood', price: 650, hours: 24, prep: 'plain', synonyms: ['гликированный гемоглобин', 'гликозилированный гемоглобин', 'HbA1c', 'гликогемоглобин', 'гликированный'], unit: '%', description: 'Отражает средний уровень глюкозы за последние 2–3 месяца.' },
  { code: 'GTT', name: 'Глюкозотолерантный тест (ГТТ)', category: 'biochemistry', biomaterial: 'venous_blood', price: 950, hours: 24, prep: 'gtt', fasting: true, requiresBooking: true, synonyms: ['глюкозотолерантный тест', 'ГТТ', 'тест на толерантность к глюкозе', 'сахарная кривая', 'нагрузка глюкозой'], description: 'Глюкоза натощак и через 2 часа после приёма раствора глюкозы. Только по назначению врача, длится около 2 часов.' },
  { code: 'ALT', name: 'Аланинаминотрансфераза (АЛТ)', category: 'biochemistry', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'fasting', fasting: true, synonyms: ['АЛТ', 'АлАТ', 'аланинаминотрансфераза'], unit: 'Ед/л', description: 'Фермент, который врач оценивает в составе печёночных проб.' },
  { code: 'AST', name: 'Аспартатаминотрансфераза (АСТ)', category: 'biochemistry', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'fasting', fasting: true, synonyms: ['АСТ', 'АсАТ', 'аспартатаминотрансфераза'], unit: 'Ед/л', description: 'Фермент печени и мышц.' },
  { code: 'BILI_TOTAL', name: 'Билирубин общий', category: 'biochemistry', biomaterial: 'venous_blood', price: 250, hours: 24, prep: 'fasting', fasting: true, synonyms: ['билирубин общий', 'общий билирубин', 'билирубин'], unit: 'мкмоль/л' },
  { code: 'BILI_DIRECT', name: 'Билирубин прямой', category: 'biochemistry', biomaterial: 'venous_blood', price: 250, hours: 24, prep: 'fasting', fasting: true, synonyms: ['билирубин прямой', 'прямой билирубин', 'связанный билирубин'], unit: 'мкмоль/л' },
  { code: 'GGT', name: 'Гамма-глутамилтрансфераза (ГГТ)', category: 'biochemistry', biomaterial: 'venous_blood', price: 280, hours: 24, prep: 'fasting', fasting: true, synonyms: ['ГГТ', 'гамма-ГТ', 'гамма-глутамилтрансфераза', 'ГГТП'], unit: 'Ед/л' },
  { code: 'ALP', name: 'Щелочная фосфатаза', category: 'biochemistry', biomaterial: 'venous_blood', price: 270, hours: 24, prep: 'fasting', fasting: true, synonyms: ['щелочная фосфатаза', 'ЩФ'], unit: 'Ед/л' },
  { code: 'TOTAL_PROTEIN', name: 'Общий белок', category: 'biochemistry', biomaterial: 'venous_blood', price: 230, hours: 24, prep: 'fasting', fasting: true, synonyms: ['общий белок', 'белок общий', 'белок в крови'], unit: 'г/л' },
  { code: 'ALBUMIN', name: 'Альбумин', category: 'biochemistry', biomaterial: 'venous_blood', price: 240, hours: 24, prep: 'fasting', fasting: true, synonyms: ['альбумин', 'альбумин в крови'], unit: 'г/л' },
  { code: 'CREATININE', name: 'Креатинин', category: 'biochemistry', biomaterial: 'venous_blood', price: 250, hours: 24, prep: 'fasting', fasting: true, synonyms: ['креатинин', 'креатинин в крови'], unit: 'мкмоль/л' },
  { code: 'UREA', name: 'Мочевина', category: 'biochemistry', biomaterial: 'venous_blood', price: 240, hours: 24, prep: 'fasting', fasting: true, synonyms: ['мочевина', 'мочевина в крови'], unit: 'ммоль/л' },
  { code: 'URIC_ACID', name: 'Мочевая кислота', category: 'biochemistry', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'fasting', fasting: true, synonyms: ['мочевая кислота'], unit: 'мкмоль/л' },
  { code: 'CHOLESTEROL', name: 'Холестерин общий', category: 'biochemistry', biomaterial: 'venous_blood', price: 240, hours: 24, prep: 'lipids', fasting: true, synonyms: ['холестерин', 'общий холестерин', 'холестерин общий'], unit: 'ммоль/л' },
  { code: 'TRIGLYCERIDES', name: 'Триглицериды', category: 'biochemistry', biomaterial: 'venous_blood', price: 270, hours: 24, prep: 'lipids', fasting: true, synonyms: ['триглицериды', 'ТГ'], unit: 'ммоль/л' },
  { code: 'HDL', name: 'Холестерин липопротеинов высокой плотности (ЛПВП)', category: 'biochemistry', biomaterial: 'venous_blood', price: 290, hours: 24, prep: 'lipids', fasting: true, synonyms: ['ЛПВП', 'холестерин ЛПВП', 'липопротеины высокой плотности', 'хороший холестерин'], unit: 'ммоль/л' },
  { code: 'LDL', name: 'Холестерин липопротеинов низкой плотности (ЛПНП)', category: 'biochemistry', biomaterial: 'venous_blood', price: 290, hours: 24, prep: 'lipids', fasting: true, synonyms: ['ЛПНП', 'холестерин ЛПНП', 'липопротеины низкой плотности', 'плохой холестерин'], unit: 'ммоль/л' },
  { code: 'LIPID_PROFILE', name: 'Липидный профиль (липидограмма)', category: 'biochemistry', biomaterial: 'venous_blood', price: 950, hours: 24, prep: 'lipids', fasting: true, synonyms: ['липидный профиль', 'липидограмма', 'липидный спектр', 'липидный спектр крови'], description: 'Холестерин общий, ЛПВП, ЛПНП, триглицериды, расчёт коэффициента атерогенности.', components: ['Холестерин общий', 'ЛПВП', 'ЛПНП', 'Триглицериды', 'Коэффициент атерогенности'] },
  { code: 'LIVER_PANEL', name: 'Печёночные пробы', category: 'biochemistry', biomaterial: 'venous_blood', price: 1150, hours: 24, prep: 'fasting', fasting: true, synonyms: ['печёночные пробы', 'печеночные пробы', 'печёночный профиль', 'функциональные пробы печени'], description: 'АЛТ, АСТ, билирубин общий и прямой, ГГТ, щелочная фосфатаза.', components: ['АЛТ', 'АСТ', 'Билирубин общий', 'Билирубин прямой', 'ГГТ', 'Щелочная фосфатаза'] },
  { code: 'KIDNEY_PANEL', name: 'Почечные пробы', category: 'biochemistry', biomaterial: 'venous_blood', price: 690, hours: 24, prep: 'fasting', fasting: true, synonyms: ['почечные пробы', 'почечный профиль'], description: 'Креатинин, мочевина, мочевая кислота.', components: ['Креатинин', 'Мочевина', 'Мочевая кислота'] },
  { code: 'CRP', name: 'С-реактивный белок (СРБ), количественно', category: 'biochemistry', biomaterial: 'venous_blood', price: 420, hours: 24, prep: 'plain', synonyms: ['СРБ', 'С-реактивный белок', 'С реактивный белок', 'c-реактивный белок', 'CRP'], unit: 'мг/л', description: 'Белок острой фазы воспаления.' },
  { code: 'AMYLASE', name: 'Альфа-амилаза', category: 'biochemistry', biomaterial: 'venous_blood', price: 280, hours: 24, prep: 'fasting', fasting: true, synonyms: ['амилаза', 'альфа-амилаза', 'амилаза в крови'], unit: 'Ед/л' },
  { code: 'LIPASE', name: 'Липаза', category: 'biochemistry', biomaterial: 'venous_blood', price: 420, hours: 24, prep: 'fasting', fasting: true, synonyms: ['липаза'], unit: 'Ед/л' },
  { code: 'POTASSIUM', name: 'Калий', category: 'biochemistry', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'plain', synonyms: ['калий', 'калий в крови'], unit: 'ммоль/л' },
  { code: 'SODIUM', name: 'Натрий', category: 'biochemistry', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'plain', synonyms: ['натрий', 'натрий в крови'], unit: 'ммоль/л' },
  { code: 'CALCIUM', name: 'Кальций общий', category: 'biochemistry', biomaterial: 'venous_blood', price: 250, hours: 24, prep: 'fasting', fasting: true, synonyms: ['кальций', 'кальций общий', 'общий кальций'], unit: 'ммоль/л' },
  { code: 'MAGNESIUM', name: 'Магний', category: 'biochemistry', biomaterial: 'venous_blood', price: 280, hours: 24, prep: 'fasting', fasting: true, synonyms: ['магний', 'магний в крови'], unit: 'ммоль/л' },
  { code: 'PHOSPHORUS', name: 'Фосфор неорганический', category: 'biochemistry', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'fasting', fasting: true, synonyms: ['фосфор', 'фосфор неорганический'], unit: 'ммоль/л' },
  // Гормоны
  { code: 'TSH', name: 'Тиреотропный гормон (ТТГ)', category: 'hormones', biomaterial: 'venous_blood', price: 500, hours: 24, prep: 'thyroid', synonyms: ['ТТГ', 'тиреотропный гормон', 'тиреотропин', 'TSH'], unit: 'мМЕ/л', description: 'Гормон гипофиза, регулирующий работу щитовидной железы.' },
  { code: 'FT4', name: 'Тироксин свободный (Т4 свободный)', category: 'hormones', biomaterial: 'venous_blood', price: 520, hours: 24, prep: 'thyroid', synonyms: ['Т4 свободный', 'свободный Т4', 'Т4 св', 'тироксин свободный', 'свободный тироксин', 'FT4'], unit: 'пмоль/л' },
  { code: 'FT3', name: 'Трийодтиронин свободный (Т3 свободный)', category: 'hormones', biomaterial: 'venous_blood', price: 520, hours: 24, prep: 'thyroid', synonyms: ['Т3 свободный', 'свободный Т3', 'Т3 св', 'трийодтиронин свободный', 'FT3'], unit: 'пмоль/л' },
  { code: 'ANTI_TPO', name: 'Антитела к тиреопероксидазе (АТ-ТПО)', category: 'hormones', biomaterial: 'venous_blood', price: 620, hours: 48, prep: 'thyroid', synonyms: ['антитела к ТПО', 'АТ-ТПО', 'АТ к ТПО', 'антитела к тиреопероксидазе', 'анти-ТПО'], unit: 'МЕ/мл' },
  { code: 'PROLACTIN', name: 'Пролактин', category: 'hormones', biomaterial: 'venous_blood', price: 520, hours: 24, prep: 'hormones', synonyms: ['пролактин'], unit: 'мМЕ/л' },
  { code: 'CORTISOL', name: 'Кортизол в крови', category: 'hormones', biomaterial: 'venous_blood', price: 560, hours: 24, prep: 'cortisol', fasting: true, synonyms: ['кортизол', 'кортизол в крови'], unit: 'нмоль/л' },
  { code: 'INSULIN', name: 'Инсулин', category: 'hormones', biomaterial: 'venous_blood', price: 580, hours: 24, prep: 'fasting', fasting: true, synonyms: ['инсулин', 'инсулин натощак'], unit: 'мкЕд/мл' },
  { code: 'TESTOSTERONE', name: 'Тестостерон общий', category: 'hormones', biomaterial: 'venous_blood', price: 540, hours: 24, prep: 'hormones', synonyms: ['тестостерон', 'тестостерон общий', 'общий тестостерон'], unit: 'нмоль/л' },
  { code: 'ESTRADIOL', name: 'Эстрадиол', category: 'hormones', biomaterial: 'venous_blood', price: 540, hours: 24, prep: 'hormones', synonyms: ['эстрадиол'], unit: 'пмоль/л' },
  { code: 'FSH', name: 'Фолликулостимулирующий гормон (ФСГ)', category: 'hormones', biomaterial: 'venous_blood', price: 500, hours: 24, prep: 'hormones', synonyms: ['ФСГ', 'фолликулостимулирующий гормон'], unit: 'мМЕ/мл' },
  { code: 'LH', name: 'Лютеинизирующий гормон (ЛГ)', category: 'hormones', biomaterial: 'venous_blood', price: 500, hours: 24, prep: 'hormones', synonyms: ['ЛГ', 'лютеинизирующий гормон'], unit: 'мМЕ/мл' },
  { code: 'PTH', name: 'Паратиреоидный гормон (паратгормон)', category: 'hormones', biomaterial: 'venous_blood', price: 760, hours: 48, prep: 'fasting', fasting: true, synonyms: ['паратгормон', 'паратиреоидный гормон', 'ПТГ'], unit: 'пг/мл' },
  { code: 'HCG', name: 'ХГЧ общий (бета-ХГЧ) в крови', category: 'hormones', biomaterial: 'venous_blood', price: 520, hours: 24, prep: 'plain', synonyms: ['ХГЧ', 'бета-ХГЧ', 'бета ХГЧ', 'хорионический гонадотропин', 'ХГЧ в крови'], unit: 'мМЕ/мл' },
  // Витамины и микроэлементы
  { code: 'VITD', name: '25-OH витамин D', category: 'vitamins', biomaterial: 'venous_blood', price: 1650, hours: 48, prep: 'plain', synonyms: ['витамин D', 'витамин Д', '25-OH витамин D', '25(OH)D', '25-гидроксивитамин D', 'гидроксивитамин D'], unit: 'нг/мл' },
  { code: 'B12', name: 'Витамин B12 (цианокобаламин)', category: 'vitamins', biomaterial: 'venous_blood', price: 720, hours: 48, prep: 'fasting', fasting: true, synonyms: ['витамин B12', 'витамин В12', 'B12', 'В12', 'цианокобаламин'], unit: 'пг/мл' },
  { code: 'FOLATE', name: 'Фолиевая кислота в сыворотке', category: 'vitamins', biomaterial: 'venous_blood', price: 720, hours: 48, prep: 'fasting', fasting: true, synonyms: ['фолиевая кислота', 'фолаты', 'витамин B9', 'витамин В9'], unit: 'нг/мл' },
  { code: 'FERRITIN', name: 'Ферритин', category: 'vitamins', biomaterial: 'venous_blood', price: 620, hours: 24, prep: 'fasting', fasting: true, synonyms: ['ферритин'], unit: 'мкг/л', description: 'Белок, по которому врач оценивает запасы железа в организме.' },
  { code: 'IRON', name: 'Железо сыворотки', category: 'vitamins', biomaterial: 'venous_blood', price: 260, hours: 24, prep: 'fasting', fasting: true, synonyms: ['железо сыворотки', 'сывороточное железо', 'железо в сыворотке', 'железо сывороточное'], unit: 'мкмоль/л' },
  { code: 'TIBC', name: 'Общая железосвязывающая способность сыворотки (ОЖСС)', category: 'vitamins', biomaterial: 'venous_blood', price: 320, hours: 24, prep: 'fasting', fasting: true, synonyms: ['ОЖСС', 'железосвязывающая способность', 'общая железосвязывающая способность'], unit: 'мкмоль/л' },
  { code: 'TRANSFERRIN', name: 'Трансферрин', category: 'vitamins', biomaterial: 'venous_blood', price: 480, hours: 24, prep: 'fasting', fasting: true, synonyms: ['трансферрин'], unit: 'г/л' },
  { code: 'ZINC', name: 'Цинк в сыворотке', category: 'vitamins', biomaterial: 'venous_blood', price: 480, hours: 72, prep: 'fasting', fasting: true, synonyms: ['цинк', 'цинк в крови'], unit: 'мкмоль/л' },
  // Гемостаз
  { code: 'COAG_BASIC', name: 'Коагулограмма базовая', category: 'coagulation', biomaterial: 'venous_blood', price: 820, hours: 24, prep: 'cbc', synonyms: ['коагулограмма', 'гемостазиограмма', 'свёртываемость крови', 'анализ на свёртываемость'], description: 'Протромбиновое время, МНО, АЧТВ, фибриноген.', components: ['Протромбиновое время', 'МНО', 'АЧТВ', 'Фибриноген'] },
  { code: 'INR', name: 'Протромбиновое время и МНО', category: 'coagulation', biomaterial: 'venous_blood', price: 330, hours: 24, prep: 'cbc', synonyms: ['МНО', 'протромбиновое время', 'протромбин', 'ПТИ'] },
  { code: 'DDIMER', name: 'D-димер', category: 'coagulation', biomaterial: 'venous_blood', price: 980, hours: 24, prep: 'plain', synonyms: ['D-димер', 'Д-димер', 'д димер', 'd димер'], unit: 'нг/мл FEU' },
  // Иммунология
  { code: 'IGE_TOTAL', name: 'Иммуноглобулин E общий (IgE общий)', category: 'immunology', biomaterial: 'venous_blood', price: 560, hours: 48, prep: 'plain', synonyms: ['IgE общий', 'иммуноглобулин E', 'иммуноглобулин Е', 'общий IgE'], unit: 'МЕ/мл' },
  { code: 'RF', name: 'Ревматоидный фактор', category: 'immunology', biomaterial: 'venous_blood', price: 380, hours: 24, prep: 'plain', synonyms: ['ревматоидный фактор', 'РФ'], unit: 'МЕ/мл' },
  { code: 'ASLO', name: 'Антистрептолизин-О (АСЛО)', category: 'immunology', biomaterial: 'venous_blood', price: 400, hours: 24, prep: 'plain', synonyms: ['АСЛО', 'антистрептолизин-О', 'антистрептолизин О'], unit: 'МЕ/мл' },
  // Инфекции
  { code: 'HIV_AGAB', name: 'ВИЧ-1/2: антитела и антиген p24', category: 'infections', biomaterial: 'venous_blood', price: 480, hours: 48, prep: 'plain', synonyms: ['анализ на ВИЧ', 'ВИЧ', 'антитела к ВИЧ', 'ВИЧ антиген антитела'] },
  { code: 'HBSAG', name: 'HBsAg (поверхностный антиген вируса гепатита B)', category: 'infections', biomaterial: 'venous_blood', price: 420, hours: 48, prep: 'plain', synonyms: ['HBsAg', 'гепатит B', 'гепатит В', 'австралийский антиген'] },
  { code: 'ANTI_HCV', name: 'Антитела к вирусу гепатита C (anti-HCV)', category: 'infections', biomaterial: 'venous_blood', price: 480, hours: 48, prep: 'plain', synonyms: ['anti-HCV', 'гепатит C', 'гепатит С', 'антитела к гепатиту C', 'антитела к гепатиту С'] },
  { code: 'SYPHILIS', name: 'Антитела к Treponema pallidum (суммарные)', category: 'infections', biomaterial: 'venous_blood', price: 420, hours: 48, prep: 'plain', synonyms: ['сифилис', 'анализ на сифилис', 'RW', 'реакция Вассермана', 'антитела к трепонеме'] },
  { code: 'HPYLORI_AB', name: 'Антитела к Helicobacter pylori (IgG)', category: 'infections', biomaterial: 'venous_blood', price: 560, hours: 48, prep: 'plain', synonyms: ['хеликобактер', 'Helicobacter pylori', 'антитела к хеликобактеру', 'H. pylori'] },
  { code: 'COVID_PCR', name: 'ПЦР на SARS-CoV-2 (мазок из носо- и ротоглотки)', category: 'infections', biomaterial: 'swab', price: 790, hours: 24, prep: 'swab_resp', synonyms: ['ПЦР на ковид', 'ПЦР на коронавирус', 'ПЦР на COVID', 'тест на ковид', 'ковид ПЦР', 'SARS-CoV-2'] },
  { code: 'FLU_PCR', name: 'ПЦР на вирусы гриппа A и B', category: 'infections', biomaterial: 'swab', price: 890, hours: 24, prep: 'swab_resp', synonyms: ['ПЦР на грипп', 'тест на грипп', 'грипп ПЦР', 'вирус гриппа'] },
  { code: 'FLORA_SMEAR', name: 'Мазок на флору (микроскопия урогенитального мазка)', category: 'infections', biomaterial: 'swab', price: 420, hours: 24, prep: 'swab_uro', synonyms: ['мазок на флору', 'мазок на микрофлору', 'микроскопия мазка'] },
  // Моча
  { code: 'URINE_GENERAL', name: 'Общий анализ мочи (ОАМ)', category: 'urine', biomaterial: 'urine', price: 300, hours: 24, prep: 'urine', synonyms: ['ОАМ', 'общий анализ мочи', 'клинический анализ мочи', 'анализ мочи'], description: 'Физические и химические свойства мочи, микроскопия осадка.' },
  { code: 'NECHIPORENKO', name: 'Анализ мочи по Нечипоренко', category: 'urine', biomaterial: 'urine', price: 320, hours: 24, prep: 'urine', synonyms: ['анализ мочи по Нечипоренко', 'по Нечипоренко', 'моча по Нечипоренко', 'Нечипоренко'] },
  { code: 'URINE_ALBUMIN', name: 'Альбумин в моче (соотношение альбумин/креатинин)', category: 'urine', biomaterial: 'urine', price: 480, hours: 48, prep: 'urine', synonyms: ['микроальбумин', 'микроальбумин в моче', 'альбумин в моче', 'альбумин креатининовое соотношение'] },
  { code: 'URINE_CULTURE', name: 'Посев мочи на флору с определением чувствительности к антибиотикам', category: 'urine', biomaterial: 'urine', price: 1150, hours: 120, prep: 'urine_culture', synonyms: ['посев мочи', 'бакпосев мочи', 'бактериологический посев мочи', 'посев мочи на флору'] },
  // Кал
  { code: 'COPROGRAM', name: 'Копрограмма (общий анализ кала)', category: 'feces', biomaterial: 'feces', price: 450, hours: 48, prep: 'feces', synonyms: ['копрограмма', 'общий анализ кала', 'анализ кала', 'кал общий'] },
  { code: 'FECES_OCCULT', name: 'Кал на скрытую кровь (иммунохимический тест)', category: 'feces', biomaterial: 'feces', price: 620, hours: 48, prep: 'occult', synonyms: ['кал на скрытую кровь', 'скрытая кровь', 'скрытая кровь в кале', 'анализ на скрытую кровь'] },
  { code: 'FECES_PARASITES', name: 'Кал на яйца гельминтов и простейших', category: 'feces', biomaterial: 'feces', price: 420, hours: 72, prep: 'feces', synonyms: ['кал на яйца гельминтов', 'кал на яйца глист', 'яйца гельминтов', 'анализ на глисты', 'кал на паразитов'] },
].map((test) => Object.freeze({
  unit: null,
  description: '',
  components: [],
  fasting: false,
  requiresBooking: false,
  ...test,
  preparation: PREP[test.prep],
})));

export const TEST_CODES = Object.freeze(TESTS.map((test) => test.code));

/*
 * Неоднозначные слова: исследование по ним не выбирается, ассистент уточняет.
 * «Железо» — железо сыворотки или ферритин, «сахар» — глюкоза или гликированный
 * гемоглобин. «Щитовидка», «гормоны», «биохимия», «витамины», «сдать кровь» — не
 * исследование, а область: набор анализов назначает врач, ассистент его не подбирает.
 */
export const AMBIGUOUS_TERMS = Object.freeze([
  { id: 'iron', pattern: 'анализ\\s+на\\s+железо|железо(?!\\s+сыворот)(?!\\s+в\\s+сыворот)', options: ['IRON', 'FERRITIN'], question: 'Какое исследование назначил врач: железо сыворотки или ферритин? Это разные анализы.' },
  { id: 'sugar', pattern: 'сахар(?!\\s+в\\s+крови)(?!\\s+натощак)', options: ['GLUCOSE', 'HBA1C'], question: 'Какой анализ на сахар нужен: глюкоза натощак или гликированный гемоглобин (HbA1c)? Посмотрите в направлении.' },
  { id: 'thyroid', pattern: 'щитовидк\\p{L}*|щитовидн\\p{L}*', options: [], advice: 'thyroid', question: 'Набор анализов для щитовидной железы назначает врач — я его не подбираю. Если в направлении есть названия (например, ТТГ), напишите их. Если направления нет, можно записаться к эндокринологу.' },
  { id: 'hormones', pattern: '(?<!на\\s)гормон(?:ы|ов|ам)(?!\\s+щитовид)', options: [], question: 'Какие именно гормоны указаны в направлении? Напишите названия, и я подберу лабораторию.' },
  { id: 'biochem', pattern: 'биохими\\p{L}*|биохимическ\\p{L}*', options: [], question: 'Биохимия — это группа показателей. Какие указаны в направлении (например, глюкоза, АЛТ, креатинин)?' },
  { id: 'vitamins', pattern: 'витамин(?:ы|ов)(?!\\s+[bвdд])', options: [], question: 'Какие витамины нужно проверить? Напишите названия из направления, например «витамин D».' },
  { id: 'blood', pattern: 'сдать\\s+кровь|анализ\\p{L}*\\s+крови(?!\\s+на)|кровь\\s+из\\s+вены|кровь\\s+из\\s+пальца', options: [], question: 'Какое исследование нужно? Напишите название из направления, например «общий анализ крови» или «ферритин».' },
]);

/* Вымышленные лаборатории. tier — ценовая категория (множитель цены). */
export const LABS = Object.freeze([
  { id: 'lab-labtochka', name: 'ЛабТочка', tier: 0.88, hoursFactor: 1, sameDay: false, description: 'Демо-сеть пунктов забора у метро: короткая очередь, базовые анализы по доступной цене.', phone: '+7 (843) 000-01-01', fees: { venous_blood: 150, capillary_blood: 100, urine: 0, feces: 0, swab: 250 }, coverage: 0.84 },
  { id: 'lab-probirka', name: 'Пробирка', tier: 1.0, hoursFactor: 1, sameDay: true, description: 'Демо-лаборатория с результатами общего анализа крови в день сдачи.', phone: '+7 (843) 000-02-02', fees: { venous_blood: 200, capillary_blood: 120, urine: 0, feces: 0, swab: 300 }, coverage: 0.95 },
  { id: 'lab-mediana', name: 'Медиана', tier: 1.15, hoursFactor: 0.75, sameDay: true, description: 'Демо-лаборатория полного цикла: гормоны, витамины и посевы, быстрые сроки.', phone: '+7 (843) 000-03-03', fees: { venous_blood: 250, capillary_blood: 150, urine: 50, feces: 50, swab: 350 }, coverage: 1 },
  { id: 'lab-eritro', name: 'Эритро', tier: 0.95, hoursFactor: 1.25, sameDay: false, description: 'Демо-сеть с невысокими ценами и сроками от одного рабочего дня.', phone: '+7 (843) 000-04-04', fees: { venous_blood: 180, capillary_blood: 100, urine: 0, feces: 0, swab: 280 }, coverage: 0.88 },
  { id: 'lab-analitika24', name: 'Аналитика 24', tier: 1.05, hoursFactor: 1, sameDay: false, description: 'Демо-лаборатория с ранним открытием и работой в выходные.', phone: '+7 (843) 000-05-05', fees: { venous_blood: 190, capillary_blood: 110, urine: 0, feces: 0, swab: 300 }, coverage: 0.9 },
  { id: 'lab-kristall', name: 'Кристалл-Лаб', tier: 1.22, hoursFactor: 0.9, sameDay: true, description: 'Демо-лаборатория премиум-класса: забор без очереди, выезд не предусмотрен.', phone: '+7 (843) 000-06-06', fees: { venous_blood: 300, capillary_blood: 180, urine: 60, feces: 60, swab: 400 }, coverage: 0.97 },
].map((lab) => Object.freeze(lab)));

/*
 * Часы работы и приёма биоматериала. Ключ — день недели (1 — понедельник). Приём
 * биоматериала у многих пунктов только до полудня: в это время сдаются анализы натощак.
 */
const H = (from, to) => [[from, to]];
const SCHEDULES = Object.freeze({
  morning: { hours: { 1: H('07:00', '19:00'), 2: H('07:00', '19:00'), 3: H('07:00', '19:00'), 4: H('07:00', '19:00'), 5: H('07:00', '19:00'), 6: H('08:00', '15:00'), 7: [] }, collection: { 1: H('07:00', '12:00'), 2: H('07:00', '12:00'), 3: H('07:00', '12:00'), 4: H('07:00', '12:00'), 5: H('07:00', '12:00'), 6: H('08:00', '12:00'), 7: [] } },
  allday: { hours: { 1: H('07:00', '20:00'), 2: H('07:00', '20:00'), 3: H('07:00', '20:00'), 4: H('07:00', '20:00'), 5: H('07:00', '20:00'), 6: H('08:00', '18:00'), 7: H('09:00', '15:00') }, collection: { 1: H('07:00', '19:00'), 2: H('07:00', '19:00'), 3: H('07:00', '19:00'), 4: H('07:00', '19:00'), 5: H('07:00', '19:00'), 6: H('08:00', '17:00'), 7: H('09:00', '14:00') } },
  weekdays: { hours: { 1: H('08:00', '18:00'), 2: H('08:00', '18:00'), 3: H('08:00', '18:00'), 4: H('08:00', '18:00'), 5: H('08:00', '18:00'), 6: [], 7: [] }, collection: { 1: H('08:00', '17:00'), 2: H('08:00', '17:00'), 3: H('08:00', '17:00'), 4: H('08:00', '17:00'), 5: H('08:00', '17:00'), 6: [], 7: [] } },
  early: { hours: { 1: H('06:30', '20:00'), 2: H('06:30', '20:00'), 3: H('06:30', '20:00'), 4: H('06:30', '20:00'), 5: H('06:30', '20:00'), 6: H('07:00', '17:00'), 7: H('08:00', '14:00') }, collection: { 1: H('06:30', '19:30'), 2: H('06:30', '19:30'), 3: H('06:30', '19:30'), 4: H('06:30', '19:30'), 5: H('06:30', '19:30'), 6: H('07:00', '16:00'), 7: H('08:00', '13:00') } },
});
export const SCHEDULE_PRESETS = Object.freeze(Object.keys(SCHEDULES));

/* Где стоят филиалы: лаборатория, место из kazanPlaces, расписание, вместимость слота. */
const PLACE_LABELS = Object.freeze({
  tukay: { label: 'около площади Тукая', district: 'Вахитовский', short: 'площадь Тукая' },
  kremlin: { label: 'около Кремля', district: 'Вахитовский', short: 'Кремлёвская' },
  center: { label: 'в центре, у метро «Кремлёвская»', district: 'Вахитовский', short: 'Центр' },
  vokzal: { label: 'около Центрального вокзала', district: 'Вахитовский', short: 'Вокзал' },
  avtovokzal: { label: 'около автовокзала', district: 'Приволжский', short: 'Автовокзал' },
  aviastroitelnaya: { label: 'около метро «Авиастроительная»', district: 'Авиастроительный', short: 'Авиастроительная' },
  severny: { label: 'около метро «Северный вокзал»', district: 'Московский', short: 'Северный вокзал' },
  yashlek: { label: 'около метро «Яшьлек»', district: 'Московский', short: 'Яшьлек' },
  kozya: { label: 'около метро «Козья слобода»', district: 'Кировский', short: 'Козья слобода' },
  sukonnaya: { label: 'около метро «Суконная слобода»', district: 'Вахитовский', short: 'Суконная слобода' },
  ametyevo: { label: 'около метро «Аметьево»', district: 'Приволжский', short: 'Аметьево' },
  gorki: { label: 'около метро «Горки»', district: 'Приволжский', short: 'Горки' },
  pobedy: { label: 'около метро «Проспект Победы»', district: 'Приволжский', short: 'Проспект Победы' },
  dubravnaya: { label: 'около метро «Дубравная»', district: 'Приволжский', short: 'Дубравная' },
  koltso: { label: 'около ТЦ «Кольцо»', district: 'Вахитовский', short: 'ТЦ «Кольцо»' },
  bauman: { label: 'около улицы Баумана', district: 'Вахитовский', short: 'Баумана' },
  mega: { label: 'около ТЦ «Мега»', district: 'Советский', short: 'ТЦ «Мега»' },
});

const BRANCH_PLAN = Object.freeze([
  ['lab-labtochka', 'tukay', 'morning', 3], ['lab-labtochka', 'yashlek', 'morning', 2], ['lab-labtochka', 'gorki', 'morning', 2], ['lab-labtochka', 'avtovokzal', 'morning', 2], ['lab-labtochka', 'aviastroitelnaya', 'morning', 2],
  ['lab-probirka', 'koltso', 'allday', 3], ['lab-probirka', 'kozya', 'allday', 2], ['lab-probirka', 'pobedy', 'allday', 2], ['lab-probirka', 'severny', 'morning', 2],
  ['lab-mediana', 'kremlin', 'allday', 3], ['lab-mediana', 'sukonnaya', 'weekdays', 2], ['lab-mediana', 'mega', 'allday', 3], ['lab-mediana', 'yashlek', 'weekdays', 2],
  ['lab-eritro', 'vokzal', 'morning', 2], ['lab-eritro', 'ametyevo', 'morning', 2], ['lab-eritro', 'dubravnaya', 'morning', 2], ['lab-eritro', 'kozya', 'weekdays', 2],
  ['lab-analitika24', 'center', 'early', 3], ['lab-analitika24', 'gorki', 'early', 2], ['lab-analitika24', 'severny', 'early', 2], ['lab-analitika24', 'tukay', 'early', 2],
  ['lab-kristall', 'bauman', 'allday', 2], ['lab-kristall', 'pobedy', 'weekdays', 2], ['lab-kristall', 'mega', 'allday', 2],
]);

/* Тесты, которых нет в маленьких пунктах: посевы, мазки и длительные пробы требуют процедурного кабинета. */
const LARGE_ONLY = new Set(['GTT', 'URINE_CULTURE', 'FLORA_SMEAR', 'COVID_PCR', 'FLU_PCR']);

const roundTo = (value, step) => Math.max(step, Math.round(value / step) * step);

/** Детерминированный исходный набор: одинаковый при каждом сбросе демо. */
export const buildLabSeed = ({ seed = 'medkarta-labs-v1', priceDate = '2026-11-01' } = {}) => {
  const labs = LABS.map((lab) => ({
    id: lab.id, name: lab.name, description: lab.description, phone: lab.phone, logo: null, website: null, email: null,
  }));
  const branches = [];
  const fees = [];
  const offerings = [];
  const counter = new Map();
  for (const [labId, placeKey, preset, capacity] of BRANCH_PLAN) {
    const lab = LABS.find((item) => item.id === labId);
    const place = KAZAN_PLACES[placeKey];
    const labels = PLACE_LABELS[placeKey];
    if (!lab || !place || !labels) continue;
    const number = (counter.get(labId) || 0) + 1;
    counter.set(labId, number);
    const random = createRandom(seed, `${labId}|${placeKey}`);
    // Смещение 50–250 м: филиал рядом с местом, а не на нём.
    const angle = random.next() * Math.PI * 2;
    const meters = 50 + random.next() * 200;
    const lat = Number((place.lat + (meters * Math.cos(angle)) / 111_320).toFixed(6));
    const lng = Number((place.lng + (meters * Math.sin(angle)) / (111_320 * Math.cos((place.lat * Math.PI) / 180))).toFixed(6));
    const id = `${labId}-${placeKey}`;
    const large = capacity >= 3 || preset === 'allday';
    const schedule = SCHEDULES[preset];
    branches.push({
      id, labId, name: `${lab.name} · ${labels.short}`,
      address: `Казань, ${labels.label} (демо-филиал, адрес условный)`, district: labels.district, lat, lng,
      phone: lab.phone, hours: schedule.hours, collection: schedule.collection, slotMinutes: 10, slotCapacity: capacity,
      bookingModes: ['online', 'walk_in'], large,
    });
    for (const [kind, price] of Object.entries(lab.fees)) {
      if (kind === 'swab' && !large) continue;
      fees.push({ branchId: id, kind, name: BIOMATERIALS[kind].fee, price });
    }
    for (const test of TESTS) {
      if (LARGE_ONLY.has(test.code) && !large) continue;
      if (test.biomaterial === 'swab' && !large) continue;
      // Не все сети делают всё: доля покрытия задана у лаборатории, выбор детерминирован.
      const offered = createRandom(seed, `${labId}|cover|${test.code}`).next() < lab.coverage;
      if (!offered) continue;
      const noise = 0.92 + createRandom(seed, `${labId}|price|${test.code}`).next() * 0.16;
      // Филиал в центре у премиальной сети — дороже на 5 %.
      const local = labId === 'lab-kristall' && placeKey === 'bauman' ? 1.05 : 1;
      const price = roundTo(test.price * lab.tier * noise * local, 10);
      let hours = Math.round(test.hours * lab.hoursFactor);
      if (lab.sameDay && ['CBC_DIFF', 'CBC', 'ESR', 'GLUCOSE', 'CRP'].includes(test.code)) hours = 6;
      hours = Math.max(4, hours);
      offerings.push({ branchId: id, testCode: test.code, price, hours, available: true, conditions: test.requiresBooking ? 'Только по предварительной записи' : null, priceDate });
    }
  }
  return { labs, branches, fees, offerings };
};

/*
 * Демонстрационные бланки результатов. Значения синтетические, человека за ними нет.
 * Пригодны только для показа формы бланка — не для медицинских решений.
 */
export const DEMO_RESULTS = Object.freeze([
  {
    id: 'demo-result-cbc', testCode: 'CBC_DIFF', title: 'Пример бланка: общий анализ крови (синтетические значения)',
    rows: [
      { name: 'Гемоглобин', value: '138', unit: 'г/л', reference: '120–160' },
      { name: 'Эритроциты', value: '4,6', unit: '×10¹²/л', reference: '3,9–5,2' },
      { name: 'Лейкоциты', value: '6,2', unit: '×10⁹/л', reference: '4,0–9,0' },
      { name: 'Тромбоциты', value: '245', unit: '×10⁹/л', reference: '150–400' },
      { name: 'Нейтрофилы', value: '58', unit: '%', reference: '47–72' },
      { name: 'Лимфоциты', value: '32', unit: '%', reference: '19–37' },
    ],
  },
  {
    id: 'demo-result-tsh', testCode: 'TSH', title: 'Пример бланка: ТТГ (синтетическое значение)',
    rows: [{ name: 'ТТГ', value: '1,8', unit: 'мМЕ/л', reference: '0,4–4,0' }],
  },
  {
    id: 'demo-result-lipids', testCode: 'LIPID_PROFILE', title: 'Пример бланка: липидный профиль (синтетические значения)',
    rows: [
      { name: 'Холестерин общий', value: '4,9', unit: 'ммоль/л', reference: '< 5,2' },
      { name: 'ЛПВП', value: '1,4', unit: 'ммоль/л', reference: '> 1,0' },
      { name: 'ЛПНП', value: '2,8', unit: 'ммоль/л', reference: '< 3,0' },
      { name: 'Триглицериды', value: '1,1', unit: 'ммоль/л', reference: '< 1,7' },
    ],
  },
  {
    id: 'demo-result-ferritin', testCode: 'FERRITIN', title: 'Пример бланка: ферритин (синтетическое значение)',
    rows: [{ name: 'Ферритин', value: '64', unit: 'мкг/л', reference: '10–120' }],
  },
].map((item) => Object.freeze({ ...item, disclaimer: 'Демонстрационный пример. Значения вымышлены и не подходят для медицинских решений. Референсные интервалы зависят от лаборатории, пола и возраста.' })));
