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

import { comparisonKeys, isNegatedBefore, normalizeRu, similarityOf, translitKey } from './normalize.js';
import { looksLikePatronymic, looksLikeSurname, stemSurname, stemWord } from './morphology.js';
import { ENTITY_KIND } from './detectors.js';
import { SPECIALTY_BY_LABEL, SPECIALTY_CANON } from './catalog.js';

/** Максимальная длина окна при поиске многословных названий клиник. */
const MAX_NGRAM = 5;

/** Сколько токенов максимум склеивается при поиске разорванных написаний. */
const MAX_GLUE_TOKENS = 14;

/*
 * Односимвольные служебные слова русского языка. Склейка не может начинаться
 * с них: иначе «к Г а л я в и ч у» склеивалось вместе с предлогом в
 * «кгалявич», нечёткое сравнение всё равно находило врача, и в спан попадал
 * предлог, а хвост слова оставался снаружи.
 */
/** Сколько нечётких сравнений допускается на один разбор сообщения. */
const FUZZY_BUDGET_PER_RESOLVE = 12;

const FUNCTION_LETTERS = new Set(['к', 'в', 'с', 'у', 'и', 'а', 'о', 'я', 'ж', 'б', 'й']);

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

  /*
   * Каждая фамилия индексируется НЕСКОЛЬКИМИ ключами, потому что одно и то же
   * имя приходит в разной записи: «Галявич», «Гаалявич» (растянуто),
   * «Галя8ич» (цифра вместо буквы), «Galyavich» (латиница). Ключи строит
   * comparisonKeys/translitKey, и та же функция применяется к тексту при
   * поиске — иначе стороны разойдутся.
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
  const translitStems = [...translitIndex.keys()];

  /*
   * Префиксный префильтр.
   *
   * Склейка проверяет до четырнадцати окон на каждый токен, и без дешёвой
   * отсечки каждое окно проходило полный путь: три нормализации, три
   * приведения к основе и построение ключа транслитерации. На обычном
   * сообщении это давало 50 мс вместо 7. Набор трёхбуквенных префиксов всех
   * ключей индекса отсекает подавляющее большинство окон за одну проверку
   * в хэш-таблице.
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
   * Префикс запоминается вместе с диапазоном длин.
   *
   * Одного префикса недостаточно: при склейке первые три буквы окна не меняются
   * по мере его роста, поэтому все четырнадцать окон с одного старта проходили
   * фильтр и уходили в дорогой разбор — 51 мс на сообщение вместо 4. Диапазон
   * длин отсекает окна, которые заведомо короче или длиннее любой фамилии
   * с таким началом. Запас сверху — на падежное окончание.
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
   * Бюджет нечётких сравнений на один разбор. Без него сообщение из одних
   * односимвольных токенов заставило бы склейку перебирать сотни основ на
   * каждом окне — тысячи вызовов метрики на один запрос. Счётчик живёт
   * в замыкании резолвера и сбрасывается в начале каждого resolve().
   */
  let fuzzyBudget = FUZZY_BUDGET_PER_RESOLVE;

  /**
   * Поиск фамилии по всем ключам сравнения: точная основа, схлопнутые
   * повторы, цифры вместо букв, транслитерация.
   *
   * @param {string} word СЫРОЕ слово или склеенная цепочка из текста.
   *   Именно сырое: normalizeRu сворачивает латинские гомоглифы в кириллицу,
   *   и «Galyavich» превращался в мусор ещё до построения ключа транслитерации.
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

  const fuzzySurname = (stem) => {
    if (fuzzyBudget <= 0) {
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
   * Находит в тексте ссылки на каталог.
   *
   * @param {string} scanText текст в «скан-виде» (см. detectors.buildScanView)
   * @returns {{links: Array, specialties: string[], districts: string[]}}
   */
  const resolve = (scanText) => {
    const tokens = tokenizeWithOffsets(scanText);
    fuzzyBudget = FUZZY_BUDGET_PER_RESOLVE;
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
       * Инициалы после фамилии: «Галявич А. С.».
       * Без этого шага буквы оставались бы в тексте после редактуры — сами
       * по себе они безобидны, но рядом с должностью и клиникой сужают круг
       * до одного человека.
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
        start: token.start,
        end,
        ids: hit.ids,
        ambiguous: hit.ids.length > 1,
        confidence: hit.confidence,
        matcher: hit.matcher,
      });

      for (let i = index; i <= last; i += 1) {
        consumed.add(i);
      }
      index = last;
    }

    /*
     * Пас 3. Склейка разорванных написаний.
     *
     * «Г а л я в и ч», «Г.а.л.я.в.и.ч», «Г-а-л-я-в-и-ч» и «Галя вичу» — это
     * одна и та же фамилия, но обычная токенизация режет их на куски, и поиск
     * по индексу промахивается. Раньше такая запись уходила во внешнюю модель
     * открытым текстом.
     *
     * Окно принимается только при ПОПАДАНИИ в справочник, поэтому ложные
     * склейки обычных слов невозможны: «к врачу» даёт «кврачу», которого в
     * индексе нет. Дополнительно форма окна ограничена двумя правилами,
     * чтобы не склеивать подряд идущие короткие слова наугад.
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
          // Разрыв допускается только из разделителей и не длиннее двух символов.
          /*
           * Невидимые символы тоже считаются разделителем. Обычно их вырезает
           * скан-вид ещё до резолвера, но полагаться на это нельзя: резолвер
           * вызывается и напрямую, и тогда «Пет\u200bрову» распадалось на два
           * токена, которые уже никак не склеивались.
           */
          if (separator.length > 2 || !/^[\s.\-_*·\u00AD\u200B-\u200F\uFEFF]*$/u.test(separator)) break;
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
        // Берём САМОЕ ДЛИННОЕ совпадение, а не первое: «Г а л я в и ч у»
        // совпадает и на «галявич», и на «галявичу», и если остановиться на
        // первом, хвост слова останется в тексте неотредактированным.
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
     * Уточнение врача по стоящей рядом специальности.
     *
     * «к терапевту Петрову» и «к стоматологу Петровой» — разные люди с общей
     * основой фамилии. Без этого сужения выбор между однофамильцами делался бы
     * по специальностям всего плана, и маршрут «сначала к терапевту Петрову,
     * потом к стоматологу» уводил бы к стоматологу дважды. Специальность
     * засчитывается, только если стоит непосредственно перед фамилией.
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
