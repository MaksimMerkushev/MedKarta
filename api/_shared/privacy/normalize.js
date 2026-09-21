/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Нормализация строк для privacy-слоя.
 *
 * БЕЗОПАСНОСТЬ: любое сравнение пользовательского текста со справочником
 * обязано идти через эти функции. Иначе тривиальный обход детектора —
 * это «Петр о в», «ПЕТРОВ», «Пeтров» с латинской «e» или «Петров у».
 * Нормализация здесь только для СРАВНЕНИЯ; исходные смещения символов
 * при этом не сохраняются, поэтому для замены в тексте используйте
 * detectors/redaction, которые работают по оригинальным индексам.
 */

/** Управляющие, невидимые и bidi-символы: ими маскируют вставки. */
// Управляющие символы здесь и есть предмет проверки: ими маскируют инъекции.
export const INVISIBLE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Гомоглифы: латиница, визуально неотличимая от кириллицы.
 * Без этой таблицы «Пeтров» (латинская e) не совпадёт с «Петров».
 */
const HOMOGLYPHS = new Map(Object.entries({
  a: 'а', b: 'ь', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о',
  p: 'р', t: 'т', x: 'х', y: 'у', A: 'а', B: 'в', C: 'с', E: 'е',
  H: 'н', K: 'к', M: 'м', O: 'о', P: 'р', T: 'т', X: 'х', Y: 'у',
  'Ѕ': 'ѕ', 'ѕ': 'ѕ',
}));

/** Убирает невидимые символы, не меняя длину видимого текста. */
export const stripInvisible = (value) =>
  typeof value === 'string' ? value.replace(INVISIBLE_CHARS, '') : '';

/**
 * Приводит строку к канонической форме для сравнения:
 * NFKC → нижний регистр → ё=е → гомоглифы → схлопывание пробелов.
 *
 * ВАЖНО: й НЕ сводится к и. Такая свёртка выглядит безобидной, но ломает
 * морфологию: «Петровой» превращается в «петровои», окончание «ой» перестаёт
 * опознаваться, и основа расходится с «Петров». Допуск к замене й/и относится
 * к нечёткому сравнению (similarity), а не к канонизации.
 *
 * @param {string} value
 * @returns {string}
 */
export const normalizeRu = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  let text = stripInvisible(value).normalize('NFKC').toLowerCase();

  let out = '';
  for (const char of text) {
    if (char === 'ё') {
      out += 'е';
      continue;
    }
    out += HOMOGLYPHS.get(char) || char;
  }

  return out.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
};

/**
 * Схлопывает повторы букв: «Пеетроов» → «петров».
 * Используется только как дополнительный ключ индекса, не как основной:
 * схлопывание теряет информацию и даёт ложные совпадения.
 */
export const collapseRepeats = (value) => normalizeRu(value).replace(/(.)\1+/gu, '$1');

/** Разбивает нормализованную строку на слова. */
export const tokenize = (value) => {
  const normalized = normalizeRu(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
};

/**
 * Набор символьных n-грамм для оценки похожести (см. similarity).
 * Границы слова помечаются, чтобы «ров» в начале и в конце различались.
 */
/*
 * Варианты «…Of» работают с УЖЕ нормализованной строкой.
 *
 * Публичные функции нормализуют вход сами, и при сравнении двух основ
 * normalizeRu вызывалась четырежды на каждое сравнение — в профиле это
 * давало треть всего времени разбора. Внутренние вызовы, где обе стороны
 * заведомо нормализованы, должны идти через «…Of».
 */
export const trigramsOf = (normalized) => {
  const padded = `  ${normalized} `;
  const set = new Set();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
};

export const trigrams = (value) => trigramsOf(normalizeRu(value));

/** Жаккар по триграммам: 0..1. */
export const trigramSimilarityOf = (left, right) => {
  const a = trigramsOf(left);
  const b = trigramsOf(right);
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const gram of a) {
    if (b.has(gram)) {
      intersection += 1;
    }
  }

  return intersection / (a.size + b.size - intersection);
};

export const trigramSimilarity = (left, right) =>
  trigramSimilarityOf(normalizeRu(left), normalizeRu(right));

/**
 * Расстояние Дамерау — Левенштейна с ранним выходом.
 * Ограничение maxDistance держит стоимость линейной на практике: опечатка
 * в фамилии — это 1–2 правки, а не произвольная строка.
 *
 * @returns {number} расстояние либо maxDistance + 1, если превышен порог
 */
export const editDistanceOf = (a, b, maxDistance = 3) => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previousPrevious = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = [];

  for (let i = 1; i <= a.length; i += 1) {
    current = new Array(b.length + 1);
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );

      // Транспозиция соседних символов: «Птеров» → «Петров» это 1 правка.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previousPrevious[j - 2] + 1);
      }

      current[j] = value;
      if (value < rowMin) {
        rowMin = value;
      }
    }

    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }

    previousPrevious = previous;
    previous = current;
  }

  return previous[b.length];
};

export const editDistance = (left, right, maxDistance = 3) =>
  editDistanceOf(normalizeRu(left), normalizeRu(right), maxDistance);

/**
 * Комбинированная похожесть 0..1: триграммы плюс нормировка по правкам.
 * Триграммы устойчивы к перестановке слов, правки — к опечаткам;
 * по отдельности каждая метрика даёт заметный процент промахов.
 */
export const similarityOf = (a, b) => {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a === b) {
    return 1;
  }

  const maxLength = Math.max(a.length, b.length);
  const allowed = Math.min(3, Math.floor(maxLength / 3) + 1);
  const distance = editDistanceOf(a, b, allowed);
  const editScore = distance > allowed ? 0 : 1 - distance / maxLength;

  // Триграммы дороже правок, поэтому считаются только если правки не дали
  // уверенного результата: на порогах 0.82+ это отсекает большую часть работы.
  if (editScore >= 0.82) {
    return editScore;
  }

  return Math.max(trigramSimilarityOf(a, b), editScore);
};

export const similarity = (left, right) => similarityOf(normalizeRu(left), normalizeRu(right));

/**
 * Класс «символ слова» для кириллицы.
 *
 * ЛОВУШКА JS: \b и \w определены через [A-Za-z0-9_] и с кириллицей НЕ работают.
 * Шаблон из \b, слова «вечер» и \w-звёздочки никогда не совпадёт со словом
 * «вечером»: перед «в» стоит пробел, оба символа — не-\w, границы нет.
 * Из-за этого молча отказывали распознавание намерений и подстановка @HOME.
 * Поэтому все словарные шаблоны в privacy-слое строятся функцией ruPattern,
 * а не вручную через \b.
 */
export const RU_WORD_CHAR = '[\\p{L}\\p{N}]';

/**
 * Собирает шаблон «слово целиком» с юникодными границами.
 *
 * @param {string} body тело шаблона (может содержать альтернативы)
 * @param {string} [flags]
 * @returns {RegExp}
 */
export const ruPattern = (body, flags = 'iu') =>
  new RegExp(`(?<!${RU_WORD_CHAR})(?:${body})(?!${RU_WORD_CHAR})`, flags);

/** Шаблон «основа + любое окончание»: ruStem('вечер') совпадёт с «вечером». */
export const ruStem = (...stems) =>
  ruPattern(stems.map((stem) => `${stem}\\p{L}*`).join('|'));

/*
 * ============================================================================
 * ДЕОБФУСКАЦИЯ
 *
 * Ниже — ключи сравнения для случаев, когда одно и то же имя записано
 * по-разному. Все функции возвращают КЛЮЧ для поиска по индексу, а не
 * «исправленный текст»: исходные границы символов при этом теряются, поэтому
 * замена в тексте всегда идёт по позициям токенов, а не по этим строкам.
 *
 * Направление ошибки выбрано в пользу приватности: ключи намеренно
 * «схлопывающие», и разные фамилии иногда дают один ключ. Лишняя редактура
 * безопаснее пропуска, а неоднозначность уже поддержана — ссылка на каталог
 * умеет нести список кандидатов.
 * ============================================================================
 */

/**
 * Цифры, которыми заменяют похожие буквы.
 * Применяется ТОЛЬКО к кандидатам в имена, не к тексту вообще: иначе номер
 * дома «12» превратился бы в буквы.
 */
const LEET_MAP = new Map(Object.entries({
  '0': 'о', '3': 'з', '4': 'ч', '6': 'б', '1': 'л', '9': 'д', '5': 'ѕ', '8': 'в',
}));

/** Возвращает слово с цифрами, заменёнными на похожие кириллические буквы. */
export const unleet = (value) => {
  let out = '';
  for (const char of normalizeRu(value)) {
    out += LEET_MAP.get(char) || char;
  }
  return out;
};

/*
 * Каноническая латинская форма.
 *
 * Обе стороны — кириллическая запись из справочника и латинская из текста —
 * сводятся к одному «скелету»: диграфы схлопываются, мягкость и удвоения
 * отбрасываются. «Галявич» и «Galyavich» дают galavic; «Galjavitch» — тоже.
 */
const CYRILLIC_TO_LATIN = new Map(Object.entries({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'z', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', ш: 's', щ: 's',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a',
}));

/** Диграфы латиницы, сводимые к одной букве. Порядок важен: длинные раньше. */
const LATIN_DIGRAPHS = [
  ['shch', 's'], ['tch', 'c'], ['sch', 's'],
  // -off/-eff — старая традиция транслитерации фамилий: Смирнов → Smirnoff.
  ['ff', 'v'],
  ['zh', 'z'], ['ch', 'c'],
  ['sh', 's'], ['kh', 'h'], ['ts', 'c'], ['ya', 'a'], ['ja', 'a'],
  ['yu', 'u'], ['ju', 'u'], ['ye', 'e'], ['je', 'e'], ['yo', 'e'],
  ['jo', 'e'], ['iy', 'i'], ['yi', 'i'], ['ii', 'i'], ['ee', 'i'],
  ['ia', 'a'], ['iu', 'u'], ['oo', 'u'],
  ['w', 'v'], ['x', 'h'], ['q', 'k'], ['y', 'i'], ['j', 'i'],
];

/**
 * Ключ транслитерации. Принимает и кириллицу, и латиницу.
 *
 * @param {string} value
 * @returns {string} ключ из букв a-z, либо '' для непригодного ввода
 */
export const translitKey = (value) => {
  /*
   * ВАЖНО: здесь НЕЛЬЗЯ использовать normalizeRu. Она сворачивает латинские
   * гомоглифы в кириллицу, и «Petrov» превращался в «retrov» ещё до
   * транслитерации — ключи латинского и кириллического написания расходились,
   * то есть ровно та проверка, ради которой эта функция существует, не работала.
   */
  const normalized = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}]/gu, '');

  if (normalized.length === 0) {
    return '';
  }

  let latin = '';
  for (const char of normalized) {
    if (CYRILLIC_TO_LATIN.has(char)) {
      latin += CYRILLIC_TO_LATIN.get(char);
    } else if (/[a-z]/.test(char)) {
      latin += char;
    }
  }

  for (const [digraph, replacement] of LATIN_DIGRAPHS) {
    latin = latin.split(digraph).join(replacement);
  }

  // Удвоения не несут смысла в этом сравнении: «Ааронов» и «Аронов» совпадут.
  return latin.replace(/(.)\1+/g, '$1');
};

/**
 * Набор ключей сравнения для одного слова.
 * Используется и при построении индекса, и при поиске — обе стороны обязаны
 * проходить через эту же функцию, иначе ключи разойдутся.
 *
 * @param {string} value
 * @param {(word: string) => string} stemmer функция приведения к основе
 * @returns {string[]} уникальные непустые ключи
 */
export const comparisonKeys = (value, stemmer) => {
  const base = normalizeRu(value);
  if (base.length === 0) {
    return [];
  }

  const keys = new Set();
  const add = (candidate) => {
    const stem = stemmer ? stemmer(candidate) : candidate;
    if (stem && stem.length >= 3) {
      keys.add(stem);
    }
  };

  add(base);
  add(collapseRepeats(base));
  if (/\d/.test(base)) {
    add(unleet(base));
  }

  return [...keys];
};

/**
 * Отрицание непосредственно перед словом-триггером.
 *
 * «но только НЕ в государственную» — это запрет, а не выбор. Поиск по
 * ключевым словам слеп к отрицанию, и фильтр вставал ровно на то, что
 * пользователь отвергал. Окно назад небольшое: «не» через пол-предложения
 * к триггеру уже не относится.
 */
const NEGATION_TAIL = /(?:^|[^\p{L}])(?:не|нет|без|кроме|никаких|никакой|исключая)\s+(?:\p{L}+\s+){0,2}$/iu;

export const isNegatedBefore = (text, index, window = 28) =>
  NEGATION_TAIL.test(String(text || '').slice(Math.max(0, index - window), index));

/**
 * Ищет первое НЕотрицаемое вхождение любой из основ.
 *
 * @returns {'affirmed'|'negated'|null}
 */
export const findTrigger = (text, ...stems) => {
  const regex = new RegExp(
    `(?<!${RU_WORD_CHAR})(?:${stems.map((stem) => `${stem}\\p{L}*`).join('|')})(?!${RU_WORD_CHAR})`,
    'giu',
  );

  let negated = false;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!isNegatedBefore(text, match.index)) {
      return 'affirmed';
    }
    negated = true;
  }

  return negated ? 'negated' : null;
};
