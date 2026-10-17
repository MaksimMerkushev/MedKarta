/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Entity linking к собственному справочнику. Каталог врачей и клиник известен
 * заранее, поэтому «является ли „Петрову“ врачом» решает не вероятностный NER,
 * а точный поиск по индексу с морфологией и опечатками: детерминированно, на
 * CPU за доли миллисекунды и без выгрузки текста.
 *
 * Без Ахо — Корасик: при ~10k алиасов и тексте до 1000 символов
 * (LIMITS.MAX_MESSAGE_CHARS) окно из ≤150 токенов даёт ≤750 обращений к
 * хэш-индексу на сообщение — дешевле построения и обхода автомата и проще.
 * См. docs/adr/001-external-llm-privacy-boundary.md.
 */

import { comparisonKeys, editDistanceOf, isNegatedBefore, normalizeRu, similarityOf, translitKey } from './normalize.js';
import { looksLikePatronymic, looksLikeSurname, stemSurname, stemWord } from './morphology.js';
import { ENTITY_KIND } from './detectors.js';
import { SPECIALTY_BY_LABEL, SPECIALTY_CANON } from './catalog.js';

/** Максимальная длина окна при поиске многословных названий клиник. */
const MAX_NGRAM = 5;

/** Сколько токенов максимум склеивается при поиске разорванных написаний. */
const MAX_GLUE_TOKENS = 14;

/** Сколько нечётких сравнений допускается на один разбор сообщения. */
const FUZZY_BUDGET_PER_RESOLVE = 24;

/*
 * Слова, которые совпадают с названиями клиник, но в запросе почти всегда
 * значат своё: «для» (Госпиталь для ветеранов войн), «Ваш» (Ваш доктор),
 * «марта» (Март). Иначе «построй маршрут к педиатру для сына» ведёт в
 * госпиталь для ветеранов.
 */
const COMMON_SINGLE_WORDS = [
  'для', 'ваш', 'наш', 'мой', 'твой', 'свой', 'хороший', 'хорошо', 'плюс', 'город', 'мир', 'март',
  'апрель', 'май', 'июнь', 'июль', 'август', 'здоровый', 'добрый', 'новый', 'свет', 'жизнь', 'семья',
  'мама', 'папа', 'дети', 'ребенок', 'будь', 'здоров', 'лучший', 'лучше', 'рядом', 'дом', 'сити',
  'центр', 'столица', 'первый', 'главный', 'личный', 'надежда', 'вера', 'любовь', 'гармония',
  'баланс', 'эксперт', 'профи', 'норма', 'формула', 'точка', 'линия', 'время', 'сейчас', 'сегодня',
];

/*
 * Односимвольные служебные слова: склейка не начинается с них, иначе
 * «к Г а л я в и ч у» склеится с предлогом в «кгалявич», нечёткое сравнение
 * найдёт врача, и в спан попадёт предлог, а хвост слова останется снаружи.
 */
const FUNCTION_LETTERS = new Set(['к', 'в', 'с', 'у', 'и', 'а', 'о', 'я', 'ж', 'б', 'й']);

/** Порог похожести для сопоставления с опечаткой. Подобран по тестам. */
const FUZZY_THRESHOLD = 0.82;

/**
 * Слова, которые сами по себе не идентифицируют клинику: иначе «нужна
 * клиника» свяжется с первой записью со словом «клиника», и обычное
 * существительное станет токеном.
 */
const GENERIC_CLINIC_WORDS = [
  'гауз', 'гбуз', 'фгбу', 'фгбоу', 'ано', 'ооо', 'зао', 'оао', 'ип', 'му', 'мбуз',
  'клиника', 'клинический', 'центр', 'больница', 'поликлиника', 'медцентр', 'мед',
  'медицинский', 'диагностический', 'лечебный', 'городской', 'детский',
  'республиканский', 'имени', 'казань', 'амбулатория', 'отделение', 'филиал',
  'корпус', 'номер', 'стоматология', 'лаборатория', 'аптека', 'здоровье',
  'семья', 'жизнь', 'доктор', 'врач', 'район', 'районный', 'улица', 'проспект',
  'дом', 'татарстан', 'республика', 'служба', 'помощь', 'первичный', 'приём',
  'специализированный', 'консультативный', 'взрослый', 'женский', 'мужской',
  'новый', 'старый', 'большой', 'малый', 'первый', 'второй', 'травмпункт',
];

/** Слова, после которых следующий токен с высокой вероятностью — человек. */
const PERSON_CUE_WORDS_RAW = [
  'к', 'у', 'от', 'для', 'доктор', 'врач', 'специалист', 'пациент', 'записать',
  'терапевт', 'кардиолог', 'невролог', 'хирург', 'педиатр', 'стоматолог', 'приём',
];

/*
 * Константы приводятся к основе тем же stemWord, что и текст: вручную
 * записанная основа может не совпасть (normalizeRu сводит «й» к «и»: «раион»),
 * и «в Вахитовском районе» свяжется с травмпунктом как с клиникой.
 */
const GENERIC_CLINIC_TOKENS = new Set(GENERIC_CLINIC_WORDS.map((word) => stemWord(word)));
const COMMON_SINGLE_TOKENS = new Set(COMMON_SINGLE_WORDS.map((word) => stemWord(word)));
const PERSON_CUE_WORDS = new Set(PERSON_CUE_WORDS_RAW.map((word) => stemWord(word)));

const tokenizeWithOffsets = (text) => {
  const tokens = [];
  const regex = /[\p{L}\p{N}]+/gu;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      normalized: normalizeRu(match[0]),
    });
  }
  return tokens;
};

const addToIndex = (index, key, value) => {
  if (!key) return;
  let bucket = index.get(key);
  if (!bucket) {
    bucket = new Set();
    index.set(key, bucket);
  }
  bucket.add(value);
};

const SPECIALTY_SYNONYMS = {
  lor: ['лор', 'лора', 'лору', 'лором', 'лоре', 'лоры', 'лоров', 'лорам', 'лорик', 'лорика', 'лорику', 'отоларинголог', 'оториноларинголог', 'ухогорлонос',
    'лорр', 'лорра', 'лорру'],
  ophthalmologist: ['окулист', 'окулиста', 'окулисту', 'окулистом', 'окулисты', 'глазник', 'глазника', 'глазнику', 'офтальмолог'],
  dentist: ['зубной', 'зубного', 'зубному', 'зубник', 'зубника', 'зубнику', 'дантист', 'дантиста', 'дантисту'],
  neurologist: ['невропатолог', 'невропатолога', 'невропатологу'],
  gynecologist: ['гинеколог', 'гинеколога', 'гинекологу'],
  psychiatrist: ['психиатр', 'психиатра', 'психиатру', 'психотерапевт', 'психотерапевта', 'психотерапевту'],
  pediatrician: ['педиатр', 'педиатра', 'педиатру'],
  traumatologist: ['травматолог', 'травматолога', 'травматологу', 'травмотолог', 'травмотологу',
    'травмпункт', 'травмпункта', 'травмпункту', 'травмпунктом', 'травмпункте', 'травмпункты', 'травмпунктов'],
  therapist: ['участковый', 'участкового', 'участковому', 'терапевт'],
  dermatologist: ['кожник', 'кожника', 'кожнику', 'дерматовенеролог'],
};

/*
 * Латиница: «zapishite mamu k terapevtu», «need dentist». Транслитерация с
 * типичными окончаниями и английские названия; normalizeRu сводит латинские
 * двойники букв так же, как во входном тексте, поэтому формы совпадают.
 */
const LATIN_SPECIALTIES = Object.freeze({
  therapist: ['terapevt', 'therapist'],
  dentist: ['stomatolog', 'dantist', 'dentist'],
  pediatrician: ['pediatr', 'pediatrician'],
  cardiologist: ['kardiolog', 'cardiologist'],
  neurologist: ['nevrolog', 'neurologist'],
  lor: ['lor'],
  ophthalmologist: ['okulist', 'oftalmolog', 'ophthalmologist'],
  gynecologist: ['ginekolog', 'gynecologist', 'gynaecologist'],
  urologist: ['urolog', 'urologist'],
  endocrinologist: ['endokrinolog', 'endocrinologist'],
  surgeon: ['hirurg', 'khirurg', 'surgeon'],
  dermatologist: ['dermatolog', 'dermatologist'],
  traumatologist: ['travmatolog', 'traumatologist'],
  orthopedist: ['ortoped', 'orthopedist', 'orthopaedist'],
  psychiatrist: ['psihiatr', 'psychiatrist'],
  gastroenterologist: ['gastroenterolog', 'gastroenterologist'],
});
for (const [key, stems] of Object.entries(LATIN_SPECIALTIES)) {
  const forms = stems.flatMap((stem) => (/[a-z]$/u.test(stem) && !/ist$/u.test(stem) ? [stem, `${stem}a`, `${stem}u`, `${stem}om`] : [stem, `${stem}s`]));
  SPECIALTY_SYNONYMS[key] = Object.freeze([...(SPECIALTY_SYNONYMS[key] || []), ...forms]);
}

/*
 * Опечатки в названии врача: «терапефт», «уралог», «артопед». Допуск — одна
 * правка для слов от пяти букв (две — от десяти), и только против названий
 * специальностей.
 */
const FUZZY_SPECIALTY_FORMS = (() => {
  const forms = [];
  const add = (word, key) => {
    const base = normalizeRu(word);
    if (base.length < 5 || base.includes(' ')) return;
    for (const ending of ['', 'а', 'у', 'ом', 'ы', 'ов']) forms.push({ form: base + ending, key });
  };
  for (const [key, label] of Object.entries(SPECIALTY_CANON)) add(label, key);
  for (const [key, words] of Object.entries(SPECIALTY_SYNONYMS)) words.forEach((word) => add(word, key));
  return forms;
})();

const fuzzySpecialty = (normalized) => {
  if (normalized.length < 5) return undefined;
  const limit = normalized.length >= 10 ? 2 : 1;
  let best;
  let bestDistance = limit + 1;
  for (const { form, key } of FUZZY_SPECIALTY_FORMS) {
    if (Math.abs(form.length - normalized.length) > limit) continue;
    const distance = editDistanceOf(normalized, form, limit);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
      if (distance === 0) break;
    }
  }
  return bestDistance <= limit ? best : undefined;
};

/**
 * Строит поисковые индексы по каталогу. Вызывается один раз на процесс.
 *
 * @param {{doctors: Array, clinics: Array, districts: Array}} catalog
 */
export const createEntityResolver = (catalog) => {
  const surnameIndex = new Map();
  const fullNameIndex = new Map();
  const doctorById = new Map();

  /*
   * Фамилия индексируется несколькими ключами: «Гаалявич» (растянуто),
   * «Галя8ич» (цифра вместо буквы), «Galyavich» (латиница). Ключи строят
   * comparisonKeys/translitKey — те же функции применяются к тексту при
   * поиске, иначе стороны разойдутся.
   */
  const translitIndex = new Map();

  const indexSurname = (word, doctorId) => {
    for (const key of comparisonKeys(word, stemSurname)) {
      addToIndex(surnameIndex, key, doctorId);
    }
    const latin = translitKey(stemSurname(word));
    if (latin.length >= 4) {
      addToIndex(translitIndex, latin, doctorId);
    }
  };

  for (const doctor of catalog.doctors) {
    doctorById.set(doctor.id, doctor);
    const words = normalizeRu(doctor.name).split(' ').filter(Boolean);
    if (words.length === 0) continue;

    indexSurname(words[0], doctor.id);
    // Часть источников пишет «Имя Фамилия» — индексируем и последнее слово.
    if (words.length > 1 && looksLikeSurname(words[words.length - 1])) {
      indexSurname(words[words.length - 1], doctor.id);
    }
    addToIndex(fullNameIndex, words.map(stemSurname).join(' '), doctor.id);
  }

  /*
   * Короткие фамилии (Цой, Пак, Ким): основа слишком коротка для общего
   * индекса, и «к доктору Цою» ушло бы наружу. Для них строятся падежные формы
   * целиком и ищутся точным совпадением слова с заглавной буквы.
   */
  const shortSurnameIndex = new Map();
  for (const doctor of catalog.doctors) {
    const surname = normalizeRu(doctor.name).split(' ')[0] || '';
    if (surname.length < 2 || surname.length > 4) continue;
    const forms = new Set([surname]);
    if (/[ой]й$/u.test(surname) || /ай$/u.test(surname)) {
      const stem = surname.slice(0, -1);
      for (const ending of ['я', 'ю', 'ем', 'е']) forms.add(stem + ending);
    } else if (/[бвгджзклмнпрстфхцчшщ]$/u.test(surname)) {
      for (const ending of ['а', 'у', 'ом', 'е', 'ым']) forms.add(surname + ending);
    }
    for (const form of forms) addToIndex(shortSurnameIndex, form, doctor.id);
  }

  const surnameStems = [...surnameIndex.keys()];
  // Ведро по первой букве: отсекает 95% кандидатов до дорогой метрики.
  const surnameByFirstChar = new Map();
  for (const stem of surnameStems) {
    addToIndex(surnameByFirstChar, stem[0], stem);
  }

  const clinicIndex = new Map();
  const clinicById = new Map();
  // «Городская поликлиника №21» → {number: '21', kind: 'поликлиник'} для поиска по номеру.
  const numberedClinics = [];
  for (const clinic of catalog.clinics) {
    const match = /(поликлиник|больниц|роддом)\p{L}*\s*(?:№|n)\s*(\d{1,3})(?!\d)/iu.exec(clinic.name || '');
    if (match) {
      numberedClinics.push({ id: clinic.id, kind: match[1].toLowerCase(), number: match[2], childish: /детск/iu.test(clinic.name) });
    }
  }
  // Однословные ключи из аббревиатур («РКБ», «МКДЦ»): им не нужна заглавная
  // буква, «поеду в ркб» — обычная запись.
  const aliasSingleKeys = new Set();
  for (const clinic of catalog.clinics) {
    clinicById.set(clinic.id, clinic);
    const variants = [clinic.name, clinic.branchName, ...clinic.aliases].filter(Boolean);

    for (const alias of clinic.aliases || []) {
      const stems = normalizeRu(alias).split(' ').filter(Boolean).map(stemWord);
      if (stems.length === 1) aliasSingleKeys.add(stems[0]);
    }
    // Аббревиатуры прямо в названии: «… МЗ РТ (РКБ)», «(МКДЦ)».
    for (const variant of variants) {
      for (const word of String(variant).match(/\p{Lu}{2,6}/gu) || []) {
        // Организационно-правовые формы и названия услуг («МРТ», «УЗИ») —
        // не название конкретной клиники: «Где сделать МРТ» — вопрос об услуге.
        if (/^(?:МЗ|РТ|РФ|ГАУЗ|ГБУЗ|ФГБУ|ФГБОУ|АНО|ООО|ЗАО|ОАО|ПАО|ИП|МУ|МБУЗ|ЛПУ|ЦРБ|МРТ|КТ|УЗИ|ЭКГ|ЭЭГ|ЭНМГ|ЛОР|ЛФК|ОМС|ДМС|МСЭ|ВМП|ПЭТ|СПИД|ВИЧ|ЭКО|ПЦР|ЦКБ)$/u.test(word)) continue;
        aliasSingleKeys.add(stemWord(normalizeRu(word)));
      }
    }

    for (const variant of variants) {
      const stems = normalizeRu(variant).split(' ').filter(Boolean).map(stemWord);
      if (stems.length === 0) continue;

      for (let size = 1; size <= Math.min(MAX_NGRAM, stems.length); size += 1) {
        for (let offset = 0; offset + size <= stems.length; offset += 1) {
          const window = stems.slice(offset, offset + size);
          if (size === 1) {
            const single = window[0];
            if (single.length < 3 || GENERIC_CLINIC_TOKENS.has(single)) {
              continue;
            }
          }
          // Окно только из общих слов («Медицинский центр») ничего не
          // идентифицирует: иначе запрос целиком станет токеном клиники.
          if (window.every((stem) => GENERIC_CLINIC_TOKENS.has(stem) || stem.length < 3)) {
            continue;
          }
          addToIndex(clinicIndex, window.join(' '), clinic.id);
        }
      }
    }
  }

  // n-граммы, указывающие более чем на 8 клиник, ничего не идентифицируют.
  for (const [key, bucket] of clinicIndex) {
    if (bucket.size > 8 && key.split(' ').length < 3) {
      clinicIndex.delete(key);
    }
  }

  const specialtyIndex = new Map();
  for (const [key, label] of Object.entries(SPECIALTY_CANON)) {
    specialtyIndex.set(stemWord(label), key);
  }
  /*
   * Разговорные названия и формы, которые основа не сводит к канону:
   * «лору» (у короткого «ЛОР» stemWord окончание не отрезает), «окулист»,
   * «зубной». Иначе «к лору» и «к окулисту» теряют профиль.
   */
  for (const [key, words] of Object.entries(SPECIALTY_SYNONYMS)) {
    for (const word of words) specialtyIndex.set(stemWord(normalizeRu(word)), key);
  }
  for (const label of catalog.specialties) {
    const key = SPECIALTY_BY_LABEL[String(label).toLowerCase()];
    if (key) {
      specialtyIndex.set(stemWord(label), key);
    }
  }

  // Районы индексируются и целиком, и по каждому значимому слову: «Ново-
  // Савиновский» распадается на два токена, и без пословного ключа не нашёлся бы.
  const districtIndex = new Map();
  for (const district of catalog.districts) {
    districtIndex.set(stemWord(district), district);
    for (const word of normalizeRu(district).split(' ')) {
      const stem = stemWord(word);
      if (stem.length >= 5 && !GENERIC_CLINIC_TOKENS.has(stem)) {
        districtIndex.set(stem, district);
      }
    }
  }

  const translitStems = [...translitIndex.keys()];

  /*
   * Префиксный префильтр: склейка проверяет до четырнадцати окон на токен, и
   * без дешёвой отсечки каждое проходит нормализации, приведение к основе и
   * транслитерацию. Трёхбуквенные префиксы ключей индекса отсекают почти все
   * окна одной проверкой в хэш-таблице.
   */
  const rememberLength = (index, prefix, length) => {
    const range = index.get(prefix);
    if (!range) {
      index.set(prefix, { min: length, max: length });
      return;
    }
    if (length < range.min) range.min = length;
    if (length > range.max) range.max = length;
  };

  const surnamePrefixes = new Map();
  for (const key of surnameIndex.keys()) {
    if (key.length >= 3) rememberLength(surnamePrefixes, key.slice(0, 3), key.length);
  }
  const translitPrefixes = new Map();
  for (const key of translitIndex.keys()) {
    if (key.length >= 3) rememberLength(translitPrefixes, key.slice(0, 3), key.length);
  }

  const collapse = (value) => value.replace(/(.)\1+/gu, '$1');

  /*
   * Префикс хранится с диапазоном длин: при склейке первые три буквы окна не
   * меняются, и без диапазона все окна с одного старта уходили бы в дорогой
   * разбор. Запас сверху — на падежное окончание.
   */
  const inRange = (index, key, length) => {
    const range = index.get(key);
    return Boolean(range) && length >= range.min - 1 && length <= range.max + 4;
  };

  /** Дешёвая проверка «может ли это вообще быть фамилией из справочника». */
  const mayBeSurname = (normalized, raw) => {
    if (normalized.length >= 3) {
      if (inRange(surnamePrefixes, normalized.slice(0, 3), normalized.length)) return true;
      const collapsed = collapse(normalized);
      if (collapsed.length >= 3 && inRange(surnamePrefixes, collapsed.slice(0, 3), collapsed.length)) {
        return true;
      }
    }
    const latin = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    if (latin.length < 4) return false;
    const key = translitKey(latin);
    return key.length >= 3 && inRange(translitPrefixes, key.slice(0, 3), key.length);
  };

  /*
   * Бюджет нечётких сравнений на один разбор: иначе сообщение из
   * односимвольных токенов даёт тысячи вызовов метрики. Сбрасывается в начале
   * каждого resolve(); исчерпание помечает разбор как incomplete.
   */
  let fuzzyBudget = FUZZY_BUDGET_PER_RESOLVE;
  let fuzzySkipped = 0;

  /**
   * Поиск фамилии по всем ключам сравнения: точная основа, схлопнутые
   * повторы, цифры вместо букв, транслитерация.
   *
   * @param {string} word сырое слово или склеенная цепочка из текста:
   *   normalizeRu сворачивает латинские гомоглифы в кириллицу и испортил бы
   *   «Galyavich» до построения ключа транслитерации.
   * @param {boolean} allowFuzzy разрешать ли нечёткое сравнение транслитераций
   * @returns {{ids: string[], matcher: string, confidence: number}|null}
   */
  const lookupSurname = (word, allowFuzzy = false, normalizedHint = null) => {
    const normalized = normalizedHint ?? normalizeRu(word);
    if (normalized.length < 3) {
      return null;
    }

    // Быстрый путь: точная основа. Покрывает подавляющее большинство попаданий.
    const direct = surnameIndex.get(stemSurname(normalized));
    if (direct) {
      return { ids: [...direct], matcher: 'doctor.exact', confidence: 1 };
    }

    if (!mayBeSurname(normalized, word)) {
      return null;
    }

    for (const key of comparisonKeys(word, stemSurname)) {
      const bucket = surnameIndex.get(key);
      if (bucket) return { ids: [...bucket], matcher: 'doctor.exact', confidence: 1 };
    }

    const latin = translitKey(word);
    if (latin.length >= 4) {
      const bucket = translitIndex.get(latin) || translitIndex.get(translitKey(stemSurname(word)));
      if (bucket) return { ids: [...bucket], matcher: 'doctor.translit', confidence: 0.95 };

      if (allowFuzzy && fuzzyBudget <= 0) fuzzySkipped += 1;
      if (allowFuzzy && fuzzyBudget > 0) {
        fuzzyBudget -= 1;
        // «Petroff» против «Петров»: одна правка на скелете из шести букв.
        let best = null;
        let bestScore = 0.86;
        for (const candidate of translitStems) {
          if (Math.abs(candidate.length - latin.length) > 2) continue;
          const score = similarityOf(latin, candidate);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
        if (best) {
          return {
            ids: [...translitIndex.get(best)],
            matcher: 'doctor.translit.fuzzy',
            confidence: bestScore,
          };
        }
      }
    }

    return null;
  };

  /*
   * Только для кандидатов в фамилии (заглавная буква, указатель на человека
   * или фамильная морфология): иначе обычные слова совпадут с фамилиями. Без
   * нечёткого поиска опечатка «Галявиу» оставила бы фамилию открытой.
   */
  const fuzzySurname = (stem) => {
    if (fuzzyBudget <= 0) {
      fuzzySkipped += 1;
      return null;
    }
    fuzzyBudget -= 1;

    const bucket = surnameByFirstChar.get(stem[0]);
    const pool = bucket ? [...bucket] : surnameStems;

    let best = null;
    let bestScore = FUZZY_THRESHOLD;
    for (const candidate of pool) {
      if (Math.abs(candidate.length - stem.length) > 3) {
        continue;
      }
      const score = similarityOf(stem, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best ? { stem: best, score: bestScore } : null;
  };

  /**
   * @param {string} scanText текст в «скан-виде» (см. detectors.buildScanView)
   * @returns {{links: Array, specialties: string[], specialtyHits: Array,
   *   districts: string[], incomplete: boolean}}
   */
  const resolve = (scanText) => {
    const tokens = tokenizeWithOffsets(scanText);
    fuzzyBudget = FUZZY_BUDGET_PER_RESOLVE;
    fuzzySkipped = 0;
    const links = [];
    const specialties = new Set();
    const districts = new Set();
    const specialtyHits = [];
    const consumed = new Set();

    /*
     * Пас 0. Специальности и районы — до поиска клиник: в «Ново-Савиновский
     * район» токен «Ново» совпадает с названием клиники. Специальность и район
     * не персональные данные, остаются открытым текстом и не должны
     * перехватываться справочником учреждений.
     */
    for (let start = 0; start < tokens.length; start += 1) {
      if (consumed.has(start)) continue;

      // Окно 3..1: «Ново Савиновском» — два токена, «Вахитовском» — один.
      for (let size = Math.min(3, tokens.length - start); size >= 1; size -= 1) {
        const window = tokens.slice(start, start + size);
        const key = window.map((token) => stemWord(token.normalized)).join(' ');

        const district = districtIndex.get(key);
        // Опечатка ищется только у слова со строчной буквы: «Уралова» — фамилия, «уралог» — врач.
        const specialty = size === 1
          ? specialtyIndex.get(key) ?? (/^\p{Ll}/u.test(window[0].raw) ? fuzzySpecialty(window[0].normalized) : undefined)
          // «Детский врач» — педиатр: двухсловное название, которого нет в каноне.
          : size === 2 && /^детск/u.test(window[0].normalized) && /^врач/u.test(window[1].normalized) ? 'pediatrician' : undefined;
        if (!district && !specialty) continue;

        if (district) districts.add(district);
        if (specialty) {
          // «Мне не нужен кардиолог» — упоминание есть, потребности нет.
          // Отрицаемая специальность не попадает ни в подсказки модели,
          // ни в шаги локального плана.
          const negated = isNegatedBefore(scanText, window[0].start);
          if (!negated) specialties.add(specialty);
          // Позиция нужна локальному планировщику, чтобы восстановить порядок
          // шагов («сначала к терапевту, потом к стоматологу»).
          specialtyHits.push({
            key: specialty,
            start: window[0].start,
            end: window[window.length - 1].end,
            negated,
          });
        }
        for (let i = start; i < start + size; i += 1) {
          consumed.add(i);
        }
        start += size - 1;
        break;
      }
    }

    /*
     * 0.5. Учреждения с номером: «в детскую поликлинику №7». Номер — главное,
     * что их различает, а n-граммы справочника его не видят: «поликлиника» —
     * общее слово, «21» — число.
     */
    const NUMBERED = /(?<!\p{L})((?:детск\p{L}*\s+)?(?:городск\p{L}*\s+)?(?:детск\p{L}*\s+)?(поликлиник|больниц|роддом|стоматологическ\p{L}*\s+поликлиник)\p{L}*\s*(?:№|n|номер)?\s*(\d{1,3}))(?!\d)/giu;
    let numbered;
    while ((numbered = NUMBERED.exec(scanText)) !== null) {
      const number = numbered[3];
      const kind = numbered[2].toLowerCase();
      const childish = /детск/iu.test(numbered[1]);
      const ids = numberedClinics
        .filter((clinic) => clinic.number === number && clinic.kind.startsWith(kind.slice(0, 6)) && (!childish || clinic.childish))
        .map((clinic) => clinic.id);
      if (ids.length === 0) continue;
      const start = numbered.index;
      const end = numbered.index + numbered[1].length;
      links.push({
        kind: ENTITY_KIND.CLINIC,
        start,
        end,
        ids,
        ambiguous: ids.length > 1,
        confidence: 0.9,
        matcher: 'clinic.numbered',
      });
      tokens.forEach((token, index) => {
        if (token.start >= start && token.end <= end) consumed.add(index);
      });
    }

    // 1. Клиники: жадное окно от длинного к короткому.
    const deferredClinics = [];
    for (let start = 0; start < tokens.length; start += 1) {
      if (consumed.has(start)) continue;

      for (let size = Math.min(MAX_NGRAM, tokens.length - start); size >= 1; size -= 1) {
        let overlapsReserved = false;
        for (let i = start; i < start + size; i += 1) {
          if (consumed.has(i)) {
            overlapsReserved = true;
            break;
          }
        }
        if (overlapsReserved) continue;

        const window = tokens.slice(start, start + size);
        const key = window.map((token) => stemWord(token.normalized)).join(' ');
        const bucket = clinicIndex.get(key);
        if (!bucket) continue;

        /*
         * «к доктору Садыкову»: окно «доктор садыков» совпадает с «Клиникой
         * доктора Садыковой», но если в справочнике есть врач с такой
         * фамилией, речь о нём — клиника пишется «в клинику доктора …».
         */
        if (size === 2 && /^(?:доктор|врач)/u.test(window[0].normalized)
          && surnameIndex.has(stemSurname(window[1].normalized))
          && !/клиник|центр/u.test(tokens[start - 1]?.normalized || '')) {
          continue;
        }

        /*
         * Одно слово — слабое основание считать, что речь о клинике. Такое
         * совпадение принимается, только если слово не из общеупотребимых,
         * написано с заглавной не в начале предложения или стоит в кавычках.
         * Аббревиатуры («ркб») принимаются всегда.
         */
        if (size === 1 && !aliasSingleKeys.has(key)) {
          const token = window[0];
          // Одно слово после «доктор»/«врач» — тоже поиску врачей (см. выше).
          if (/^(?:доктор|врач)/u.test(tokens[start - 1]?.normalized || '')) continue;
          if (COMMON_SINGLE_TOKENS.has(key) || token.normalized.length < 4) continue;
          const before = scanText.slice(Math.max(0, token.start - 3), token.start);
          const quoted = /[«"„“]\s*$/u.test(before);
          const sentenceStart = token.start === 0 || /[.!?]\s*$/u.test(scanText.slice(0, token.start));
          const capitalized = /^\p{Lu}/u.test(token.raw);
          /*
           * «…после 16. Ясень или Береста»: с заглавной в начале предложения —
           * не основание, но если рядом через «или»/запятую названа другая
           * клиника, это перечисление клиник. Решается после прохода.
           */
          if (!quoted && capitalized && sentenceStart) {
            deferredClinics.push({ start, token, bucket });
            continue;
          }
          if (!quoted && !capitalized) continue;
        }

        links.push({
          kind: ENTITY_KIND.CLINIC,
          start: window[0].start,
          end: window[window.length - 1].end,
          ids: [...bucket],
          ambiguous: bucket.size > 1,
          confidence: size >= 2 ? 1 : 0.85,
          matcher: 'clinic.ngram',
        });
        for (let i = start; i < start + size; i += 1) {
          consumed.add(i);
        }
        start += size - 1;
        break;
      }
    }

    const LIST_GAP = /^\s*(?:,|или|либо)\s*(?:(?:в|во)\s+)?[«"]?\s*$/u;
    for (const { start, token, bucket } of deferredClinics) {
      if (consumed.has(start)) continue;
      const clinicLinks = links.filter((link) => link.kind === ENTITY_KIND.CLINIC);
      const listed = clinicLinks.some((link) => LIST_GAP.test(scanText.slice(token.end, link.start)) && link.start >= token.end)
        || clinicLinks.some((link) => link.end <= token.start && LIST_GAP.test(scanText.slice(link.end, token.start)));
      if (!listed) continue;
      links.push({
        kind: ENTITY_KIND.CLINIC,
        start: token.start,
        end: token.end,
        ids: [...bucket],
        ambiguous: bucket.size > 1,
        confidence: 0.8,
        matcher: 'clinic.ngram_listed',
      });
      consumed.add(start);
    }

    // 2. Врачи: по одному токену, с расширением до полного ФИО.
    for (let index = 0; index < tokens.length; index += 1) {
      if (consumed.has(index)) continue;

      const token = tokens[index];
      const previous = index > 0 ? tokens[index - 1].normalized : '';
      const cued = PERSON_CUE_WORDS.has(previous) || PERSON_CUE_WORDS.has(stemWord(previous));
      const capitalized = /^\p{Lu}/u.test(token.raw);
      // Латинское слово рядом с указателем на человека — кандидат в фамилию:
      // морфологические признаки на транслитерации не работают.
      const latinWord = /^[a-z]{5,}$/i.test(token.raw);
      const surnameCandidate =
        looksLikeSurname(token.normalized) ||
        looksLikePatronymic(token.normalized) ||
        ((capitalized || cued) && token.normalized.length >= 4) ||
        ((capitalized || cued) && latinWord);

      let hit = lookupSurname(token.raw, surnameCandidate, token.normalized);

      if (!hit && capitalized && token.normalized.length <= 6) {
        const short = shortSurnameIndex.get(token.normalized);
        if (short) hit = { ids: [...short], matcher: 'doctor.short', confidence: 0.9 };
      }

      if (!hit && surnameCandidate) {
        const fuzzy = fuzzySurname(stemSurname(token.normalized));
        if (fuzzy) {
          hit = {
            ids: [...surnameIndex.get(fuzzy.stem)],
            matcher: 'doctor.fuzzy',
            confidence: fuzzy.score,
          };
        }
      }

      if (!hit) continue;

      /*
       * Имя и отчество перед фамилией («к Альберту Галявичу»): до двух слов
       * назад, если они совпадают с именем или отчеством найденного врача.
       */
      let begin = token.start;
      let first = index;
      const nameStems = new Set();
      for (const id of hit.ids) {
        const parts = normalizeRu(doctorById.get(id)?.name || '').split(' ').slice(1);
        for (const part of parts) nameStems.add(stemWord(part));
      }
      for (let previousIndex = index - 1; previousIndex >= Math.max(0, index - 2); previousIndex -= 1) {
        if (consumed.has(previousIndex)) break;
        const candidate = tokens[previousIndex];
        const stem = stemWord(candidate.normalized);
        const matchesName = [...nameStems].some(
          (nameStem) => nameStem.length >= 3 && (stem.startsWith(nameStem) || nameStem.startsWith(stem)) && stem.length >= 3,
        );
        if (!matchesName) break;
        begin = candidate.start;
        first = previousIndex;
      }

      // Расширяем спан до полного ФИО: «Галявич Альберт Сарварович».
      // Иначе имя и отчество остались бы в тексте после редактуры фамилии.
      let end = token.end;
      let last = index;
      for (let next = index + 1; next < Math.min(index + 3, tokens.length); next += 1) {
        if (consumed.has(next)) break;
        const candidate = tokens[next];
        if (!/^\p{L}{3,}$/u.test(candidate.normalized)) break;
        const isNamePart =
          looksLikePatronymic(candidate.normalized) || /^\p{Lu}/u.test(candidate.raw);
        if (!isNamePart) break;
        end = candidate.end;
        last = next;
      }

      /*
       * Инициалы после фамилии («Галявич А. С.»): сами по себе безобидны, но
       * рядом с должностью и клиникой сужают круг до одного человека.
       */
      for (let next = last + 1; next < Math.min(last + 3, tokens.length); next += 1) {
        if (consumed.has(next)) break;
        const candidate = tokens[next];
        if (candidate.normalized.length !== 1) break;
        const tail = scanText.slice(candidate.end, candidate.end + 1);
        if (tail !== '.') break;
        end = candidate.end + 1;
        last = next;
      }

      links.push({
        kind: ENTITY_KIND.DOCTOR,
        start: begin,
        end,
        ids: hit.ids,
        ambiguous: hit.ids.length > 1,
        confidence: hit.confidence,
        matcher: hit.matcher,
      });

      for (let i = first; i <= last; i += 1) {
        consumed.add(i);
      }
      index = last;
    }

    /*
     * Пас 3. Склейка разорванных написаний: «Г а л я в и ч», «Г.а.л.я.в.и.ч»,
     * «Галя вичу» — одна фамилия, которую токенизация режет на куски.
     *
     * Окно принимается только при попадании в справочник, поэтому обычные
     * слова не склеиваются: «к врачу» даёт «кврачу», которого в индексе нет.
     * Форма окна дополнительно ограничена (splitShape, brokenWord), чтобы не
     * склеивать подряд идущие короткие слова наугад.
     */
    for (let start = 0; start < tokens.length; start += 1) {
      if (consumed.has(start)) continue;
      if (FUNCTION_LETTERS.has(tokens[start].normalized)) continue;

      let gluedRaw = '';
      let gluedNorm = '';
      let best = null;

      for (let end = start; end < Math.min(start + MAX_GLUE_TOKENS, tokens.length); end += 1) {
        if (consumed.has(end)) break;

        if (end > start) {
          const separator = scanText.slice(tokens[end - 1].end, tokens[end].start);
          /*
           * Разрыв — только из разделителей и не длиннее четырёх единиц UTF-16
           * (эмодзи занимает две): пробелы, точки, дефисы, косая черта, запятая,
           * эмодзи («Галя🙂вичу», «Шуль/ману») и невидимые символы — резолвер
           * вызывается и без скан-вида, и «Пет\u200bрову» иначе не склеится.
           */
          if (
            separator.length > 4 ||
            !/^(?:[\s.\-_*·/\\|,+~'`\u00AD\u200B-\u200F\uFEFF]|\p{Extended_Pictographic})*$/u.test(separator)
          ) break;
        }

        gluedRaw += tokens[end].raw;
        gluedNorm += tokens[end].normalized;
        if (end === start || gluedNorm.length < 4 || gluedNorm.length > 24) continue;
        if (!mayBeSurname(gluedNorm, gluedRaw)) continue;

        const window = tokens.slice(start, end + 1);
        const short = window.filter((item) => item.normalized.length <= 2).length;
        const splitShape = window.length >= 3 && short >= 2 && short / window.length >= 0.4;
        const brokenWord = window.length === 2 && window.every((item) => item.normalized.length >= 3);
        if (!splitShape && !brokenWord) continue;

        const found = lookupSurname(gluedRaw, splitShape, gluedNorm);
        // Самое длинное совпадение, а не первое: «Г а л я в и ч у» совпадает
        // и на «галявич», и на «галявичу», и с первым хвост останется в тексте.
        if (found) {
          best = { end, window, found, splitShape };
        }
      }

      if (!best) continue;

      links.push({
        kind: ENTITY_KIND.DOCTOR,
        start: best.window[0].start,
        end: best.window[best.window.length - 1].end,
        ids: best.found.ids,
        ambiguous: best.found.ids.length > 1,
        confidence: Math.min(best.found.confidence, 0.9),
        matcher: best.splitShape ? 'doctor.glued' : 'doctor.joined',
      });

      for (let i = start; i <= best.end; i += 1) {
        consumed.add(i);
      }
      start = best.end;
    }

    /*
     * Уточнение врача по специальности рядом: «к терапевту Петрову» и «к
     * стоматологу Петровой» — разные люди с общей основой фамилии. Без сужения
     * выбор шёл бы по специальностям всего плана, и «сначала к терапевту
     * Петрову, потом к стоматологу» дважды вело бы к стоматологу. Засчитывается
     * только специальность прямо перед фамилией (до ADJACENCY_CHARS символов).
     */
    const ADJACENCY_CHARS = 30;
    for (const link of links) {
      if (link.kind !== ENTITY_KIND.DOCTOR || link.ids.length < 2) continue;

      const hint = specialtyHits
        .filter((hit) => hit.end <= link.start && link.start - hit.end <= ADJACENCY_CHARS)
        .sort((left, right) => right.end - left.end)[0];
      if (!hint) continue;

      const label = normalizeRu(SPECIALTY_CANON[hint.key] || '');
      if (!label) continue;

      const narrowed = link.ids.filter((id) =>
        normalizeRu(doctorById.get(id)?.specialty || '').includes(label),
      );
      if (narrowed.length > 0 && narrowed.length < link.ids.length) {
        link.ids = narrowed;
        link.ambiguous = narrowed.length > 1;
        link.narrowedBySpecialty = hint.key;
      }
    }

    return {
      links: links.sort((left, right) => left.start - right.start),
      specialties: [...specialties],
      specialtyHits,
      districts: [...districts],
      // Были кандидаты в фамилии, которые не удалось проверить из-за бюджета.
      incomplete: fuzzySkipped > 0,
    };
  };

  return Object.freeze({
    resolve,
    getDoctor: (id) => doctorById.get(id) || null,
    getClinic: (id) => clinicById.get(id) || null,
    stats: Object.freeze({
      doctors: doctorById.size,
      clinics: clinicById.size,
      surnameKeys: surnameIndex.size,
      clinicKeys: clinicIndex.size,
    }),
  });
};
