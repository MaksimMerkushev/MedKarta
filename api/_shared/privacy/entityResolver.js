/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Entity linking к собственному справочнику.
 *
 * ПОЧЕМУ НЕ open-domain NER. Мы заранее знаем каталог врачей и клиник, поэтому
 * задача «является ли „Петрову“ врачом» решается не вероятностной моделью, а
 * точным поиском по индексу с морфологией и опечатками. Это детерминированно,
 * работает на CPU за доли миллисекунды и не требует выгрузки текста никуда.
 *
 * ПОЧЕМУ НЕ АХО-КОРАСИК. Он был рассмотрен: при ~10k алиасов и тексте до 1000
 * символов (жёсткий лимит LIMITS.MAX_MESSAGE_CHARS) окно из ≤150 токенов даёт
 * ≤750 обращений к хэш-индексу на сообщение — это дешевле, чем построение и
 * обход автомата, и заметно проще в аудите. Автомат имел бы смысл на потоковом
 * тексте в мегабайты; здесь его сложность не окупается. Решение зафиксировано
 * в docs/adr/001-external-llm-privacy-boundary.md.
 */

import { normalizeRu, similarity } from './normalize.js';
import { looksLikePatronymic, looksLikeSurname, stemSurname, stemWord } from './morphology.js';
import { ENTITY_KIND } from './detectors.js';
import { SPECIALTY_BY_LABEL, SPECIALTY_CANON } from './catalog.js';

/** Максимальная длина окна при поиске многословных названий клиник. */
const MAX_NGRAM = 5;

/** Порог похожести для сопоставления с опечаткой. Подобран по тестам. */
const FUZZY_THRESHOLD = 0.82;

/**
 * Слова, которые сами по себе не идентифицируют клинику.
 * Без этого списка «нужна клиника» связалось бы с первой попавшейся записью,
 * где есть слово «клиника», и мы бы токенизировали обычное существительное.
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
 * ВАЖНО: константы приводятся к основе ТЕМ ЖЕ stemWord, что и текст.
 * Раньше список хранил уже «пристемленные» формы вручную — и слово «район»
 * не совпадало, потому что normalizeRu сводит й к и («раион»). Из-за этого
 * «в Вахитовском районе» связывалось с травмпунктом как с клиникой.
 * Любая новая константа обязана проходить через stemWord здесь, а не в коде.
 */
const GENERIC_CLINIC_TOKENS = new Set(GENERIC_CLINIC_WORDS.map((word) => stemWord(word)));
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

/**
 * Строит поисковые индексы по каталогу. Вызывается один раз на процесс.
 *
 * @param {{doctors: Array, clinics: Array, districts: Array}} catalog
 */
export const createEntityResolver = (catalog) => {
  const surnameIndex = new Map();
  const fullNameIndex = new Map();
  const doctorById = new Map();

  for (const doctor of catalog.doctors) {
    doctorById.set(doctor.id, doctor);
    const words = normalizeRu(doctor.name).split(' ').filter(Boolean);
    if (words.length === 0) continue;

    addToIndex(surnameIndex, stemSurname(words[0]), doctor.id);
    // Часть источников пишет «Имя Фамилия» — индексируем и последнее слово.
    if (words.length > 1 && looksLikeSurname(words[words.length - 1])) {
      addToIndex(surnameIndex, stemSurname(words[words.length - 1]), doctor.id);
    }
    addToIndex(fullNameIndex, words.map(stemSurname).join(' '), doctor.id);
  }

  const surnameStems = [...surnameIndex.keys()];
  // Ведро по первой букве: отсекает 95% кандидатов до дорогой метрики.
  const surnameByFirstChar = new Map();
  for (const stem of surnameStems) {
    addToIndex(surnameByFirstChar, stem[0], stem);
  }

  const clinicIndex = new Map();
  const clinicById = new Map();
  for (const clinic of catalog.clinics) {
    clinicById.set(clinic.id, clinic);
    const variants = [clinic.name, clinic.branchName, ...clinic.aliases].filter(Boolean);

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

  /**
   * Нечёткий поиск фамилии.
   *
   * Вызывается только для «кандидатов в фамилии»: слово с заглавной буквы,
   * либо стоящее после указателя на человека, либо с фамильной морфологией.
   * Без этого ограничения обычные слова начинали бы совпадать с фамилиями и
   * редактировались бы зря; без нечёткого поиска вовсе — опечатка «Галявиу»
   * означала бы, что реальная фамилия уходит во внешнюю модель.
   */
  const fuzzySurname = (stem) => {
    const bucket = surnameByFirstChar.get(stem[0]);
    const pool = bucket ? [...bucket] : surnameStems;

    let best = null;
    let bestScore = FUZZY_THRESHOLD;
    for (const candidate of pool) {
      if (Math.abs(candidate.length - stem.length) > 3) {
        continue;
      }
      const score = similarity(stem, candidate);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    return best ? { stem: best, score: bestScore } : null;
  };

  /**
   * Находит в тексте ссылки на каталог.
   *
   * @param {string} scanText текст в «скан-виде» (см. detectors.buildScanView)
   * @returns {{links: Array, specialties: string[], districts: string[]}}
   */
  const resolve = (scanText) => {
    const tokens = tokenizeWithOffsets(scanText);
    const links = [];
    const specialties = new Set();
    const districts = new Set();
    const specialtyHits = [];
    const consumed = new Set();

    /*
     * Пас 0. Безопасный словарь — специальности и районы.
     *
     * Он выполняется ДО поиска клиник намеренно. «Ново-Савиновский район»
     * распадается на токены, среди которых «Ново» совпадало с названием одной
     * из клиник, и район подменялся клиникой. Специальность и район — не
     * персональные данные, они остаются в тексте открытым текстом и не должны
     * перехватываться справочником учреждений.
     */
    for (let start = 0; start < tokens.length; start += 1) {
      if (consumed.has(start)) continue;

      // Окно 3..1: «Ново Савиновском» — два токена, «Вахитовском» — один.
      for (let size = Math.min(3, tokens.length - start); size >= 1; size -= 1) {
        const window = tokens.slice(start, start + size);
        const key = window.map((token) => stemWord(token.normalized)).join(' ');

        const district = districtIndex.get(key);
        const specialty = size === 1 ? specialtyIndex.get(key) : undefined;
        if (!district && !specialty) continue;

        if (district) districts.add(district);
        if (specialty) {
          specialties.add(specialty);
          // Позиция нужна локальному планировщику, чтобы восстановить порядок
          // шагов («сначала к терапевту, потом к стоматологу»).
          specialtyHits.push({ key: specialty, start: window[0].start, end: window[window.length - 1].end });
        }
        for (let i = start; i < start + size; i += 1) {
          consumed.add(i);
        }
        start += size - 1;
        break;
      }
    }

    // 1. Клиники: жадное окно от длинного к короткому.
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

    // 2. Врачи: по одному токену, с расширением до полного ФИО.
    for (let index = 0; index < tokens.length; index += 1) {
      if (consumed.has(index)) continue;

      const token = tokens[index];
      const stem = stemSurname(token.normalized);
      let bucket = surnameIndex.get(stem);
      let confidence = 1;
      let matcher = 'doctor.exact';

      const previous = index > 0 ? tokens[index - 1].normalized : '';
      const cued = PERSON_CUE_WORDS.has(previous) || PERSON_CUE_WORDS.has(stemWord(previous));
      const capitalized = /^\p{Lu}/u.test(token.raw);
      const surnameCandidate =
        looksLikeSurname(token.normalized) ||
        looksLikePatronymic(token.normalized) ||
        ((capitalized || cued) && token.normalized.length >= 4);

      if (!bucket && surnameCandidate) {
        const fuzzy = fuzzySurname(stem);
        if (fuzzy) {
          bucket = surnameIndex.get(fuzzy.stem);
          confidence = fuzzy.score;
          matcher = 'doctor.fuzzy';
        }
      }

      if (!bucket) continue;

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

      links.push({
        kind: ENTITY_KIND.DOCTOR,
        start: token.start,
        end,
        ids: [...bucket],
        ambiguous: bucket.size > 1,
        confidence,
        matcher,
      });

      for (let i = index; i <= last; i += 1) {
        consumed.add(i);
      }
      index = last;
    }

    return {
      links: links.sort((left, right) => left.start - right.start),
      specialties: [...specialties],
      specialtyHits,
      districts: [...districts],
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
