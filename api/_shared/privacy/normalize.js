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
export const trigrams = (value) => {
  const padded = `  ${normalizeRu(value)} `;
  const set = new Set();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
};

/** Жаккар по триграммам: 0..1. */
export const trigramSimilarity = (left, right) => {
  const a = trigrams(left);
  const b = trigrams(right);
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

/**
 * Расстояние Дамерау — Левенштейна с ранним выходом.
 * Ограничение maxDistance держит стоимость линейной на практике: опечатка
 * в фамилии — это 1–2 правки, а не произвольная строка.
 *
 * @returns {number} расстояние либо maxDistance + 1, если превышен порог
 */
export const editDistance = (left, right, maxDistance = 3) => {
  const a = normalizeRu(left);
  const b = normalizeRu(right);

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

/**
 * Комбинированная похожесть 0..1: триграммы плюс нормировка по правкам.
 * Триграммы устойчивы к перестановке слов, правки — к опечаткам;
 * по отдельности каждая метрика даёт заметный процент промахов.
 */
export const similarity = (left, right) => {
  const a = normalizeRu(left);
  const b = normalizeRu(right);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a === b) {
    return 1;
  }

  const maxLength = Math.max(a.length, b.length);
  const allowed = Math.min(3, Math.floor(maxLength / 3) + 1);
  const distance = editDistance(a, b, allowed);
  const editScore = distance > allowed ? 0 : 1 - distance / maxLength;

  return Math.max(trigramSimilarity(a, b), editScore);
};

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
