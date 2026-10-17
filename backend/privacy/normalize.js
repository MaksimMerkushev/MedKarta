/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Любое сравнение текста пользователя со справочником идёт через эти функции,
 * иначе детектор обходится написанием «ПЕТРОВ» или «Пeтров» с латинской «e».
 * Нормализация только для сравнения: смещения теряются, замена в тексте — через
 * detectors/redaction по исходным индексам.
 */

/** Управляющие, невидимые и bidi-символы: ими маскируют вставки. */
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

export const stripInvisible = (value) =>
  typeof value === 'string' ? value.replace(INVISIBLE_CHARS, '') : '';

/**
 * Каноническая форма для сравнения: NFKC → гомоглифы и нижний регистр → ё=е →
 * всё, кроме букв и цифр, в одиночный пробел.
 *
 * й не сводится к и: «Петровой» стала бы «петровои», и окончание «-ой» не
 * опозналось бы. Допуск й/и — дело нечёткого сравнения (similarity).
 *
 * @param {string} value
 * @returns {string}
 */
export const normalizeRu = (value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  /*
   * Гомоглифы — до toLowerCase(): латинская «B» похожа на «В», а «b» — на «ь»,
   * и после понижения регистра «BИЧ» стало бы «ьич».
   */
  let out = '';
  for (const char of stripInvisible(value).normalize('NFKC')) {
    let lower = HOMOGLYPHS.get(char) || char.toLowerCase();
    if (lower === 'ё') lower = 'е';
    out += HOMOGLYPHS.get(lower) || lower;
  }

  return out.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
};

/**
 * «Пеетроов» → «петров». Только дополнительный ключ индекса: схлопывание
 * теряет информацию и даёт ложные совпадения.
 */
export const collapseRepeats = (value) => normalizeRu(value).replace(/(.)\1+/gu, '$1');

export const tokenize = (value) => {
  const normalized = normalizeRu(value);
  return normalized.length === 0 ? [] : normalized.split(' ');
};

/**
 * Триграммы для similarity. Границы слова помечаются, чтобы «ров» в начале и в
 * конце различались.
 *
 * Варианты «…Of» принимают уже нормализованную строку: публичные функции
 * нормализуют вход сами, а повторная normalizeRu на каждом сравнении — заметная
 * доля времени разбора. Внутренние вызовы с нормализованными сторонами — через «…Of».
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
 * Расстояние Дамерау — Левенштейна с ранним выходом по maxDistance: опечатка
 * в фамилии — 1–2 правки, дальше считать незачем.
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
 * Похожесть 0..1: триграммы устойчивы к перестановке слов, правки — к опечаткам;
 * по отдельности каждая метрика заметно промахивается.
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
 * Класс «символ слова» для кириллицы. В JS \b и \w — это [A-Za-z0-9_], и шаблон
 * из \b, «вечер» и \w* не совпадёт с «вечером». Поэтому словарные шаблоны
 * privacy-слоя строятся через ruPattern, а не через \b.
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
 * Деобфускация: ключи поиска по индексу для разных написаний одного имени, а не
 * исправленный текст — замена в тексте идёт по позициям токенов. Ключи
 * схлопывающие, и разные фамилии иногда дают один ключ: лишняя редактура
 * безопаснее пропуска, а ссылка на каталог умеет нести несколько кандидатов.
 */

/**
 * Цифры вместо похожих букв. Только для кандидатов в имена: иначе номер дома
 * «12» превратился бы в буквы.
 */
const LEET_MAP = new Map(Object.entries({
  '0': 'о', '3': 'з', '4': 'ч', '6': 'б', '1': 'л', '9': 'д', '5': 'ѕ', '8': 'в',
}));

export const unleet = (value) => {
  let out = '';
  for (const char of normalizeRu(value)) {
    out += LEET_MAP.get(char) || char;
  }
  return out;
};

/*
 * Кириллица из справочника и латиница из текста сводятся к одному латинскому
 * «скелету»: диграфы схлопываются, мягкость и удвоения отбрасываются.
 * «Галявич», «Galyavich» и «Galjavitch» дают galavic.
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
   * Без normalizeRu: она сворачивает латинские гомоглифы в кириллицу, и «Petrov»
   * дал бы ключ «retrov», отличный от ключа «Петров».
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
 * Ключи сравнения для одного слова. Индекс и поиск обязаны строить ключи этой же
 * функцией, иначе они разойдутся.
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

// «Без ДМС и стаж от 10 лет»: союз «и/а/но/или» заканчивает отрицание — «стаж» уже не под «без».
const NEGATION_TAIL = /(?:^|[^\p{L}])(?:не|нет|без|кроме|никаких|никакой|исключая)\s+(?:(?!(?:и|а|но|или|либо)\s)\p{L}+\s+){0,2}$/iu;

/**
 * Отрицание перед словом-триггером: «только не в государственную» — запрет, а не
 * выбор. Окно назад небольшое: «не» через пол-предложения к триггеру не относится.
 */
export const isNegatedBefore = (text, index, window = 28) =>
  NEGATION_TAIL.test(String(text || '').slice(Math.max(0, index - window), index));

/* Опечатки в словах дня («завтро», «седня»): иначе день теряется, а время из фразы остаётся. */
const TYPOS = [
  [/(?<!\p{L})(после)?за(?:втро|фтра|втр|вра)(?!\p{L})/gu, (_, after) => `${after || ''}завтра`],
  [/(?<!\p{L})(?:с[её]дня|седня|сегодя|севодня|сиводня|сегоня)(?!\p{L})/gu, 'сегодня'],
];
export const fixCommonTypos = (lower) => TYPOS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(lower || ''));

/*
 * Отрицаемая граница времени. «Не после 18, а до 12» — исправление: отрицаемая
 * граница снимается, остаётся та, что после «а». Без «а …» «не после 18» — это
 * «не позже 18», «не до 12» — «не раньше 12».
 */
const NEGATED_BOUND = '(\\d{1,2}(?::\\d{2})?(?:\\s+час\\p{L}*)?(?:\\s+(?:утра|дня|вечера))?)';
export const rewriteNegatedTimeBounds = (lower) => String(lower || '')
  .replace(new RegExp(`(?<!\\p{L})не\\s+(?:после|до)\\s+${NEGATED_BOUND}\\s*,?\\s*(?=а\\s+(?:(?:лучше|можно|давай\\p{L}*|тогда)\\s+)?(?:(?:после|до|с|со|в|к|на|около|не\\s+позже|не\\s+раньше)(?!\\p{L})|утр|вечер|дн[её]м))`, 'gu'), ' ')
  .replace(/(?<!\p{L})не\s+после(?=\s+\d)/gu, 'не позже')
  .replace(/(?<!\p{L})не\s+до(?=\s+\d)/gu, 'не раньше');

/**
 * @returns {'affirmed'|'negated'|null} 'affirmed' — есть неотрицаемое вхождение
 *   любой из основ; 'negated' — только отрицаемые; null — вхождений нет
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
