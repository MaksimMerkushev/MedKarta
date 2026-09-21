/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Детерминированный слой обнаружения чувствительных сущностей.
 *
 * МОДЕЛЬ УГРОЗ ЭТОГО МОДУЛЯ.
 * Наивный regex обходится тремя способами, и все три закрыты здесь:
 *   1. невидимые символы внутри слова  — «Пет ров»;
 *   2. гомоглифы                       — «Пeтров» с латинской e;
 *   3. падежи                          — «к Петрову».
 * Поэтому поиск идёт не по исходной строке, а по «скан-виду»: копии текста
 * с вырезанными невидимыми символами и свёрнутыми гомоглифами. Скан-вид хранит
 * карту индексов обратно в оригинал, чтобы замена в redaction.js попадала
 * ровно в исходные символы.
 *
 * Детекторы НИКОГДА не логируют найденный текст: наружу отдаются только
 * вид сущности, границы и уверенность.
 */

import { INVISIBLE_CHARS } from './normalize.js';
import { looksLikePatronymic, looksLikeSurname } from './morphology.js';

/** Виды чувствительных сущностей. Значение — префикс session-токена. */
export const ENTITY_KIND = Object.freeze({
  PERSON: 'PERSON',
  DOCTOR: 'DOCTOR',
  CLINIC: 'CLINIC',
  PHONE: 'PHONE',
  EMAIL: 'EMAIL',
  SNILS: 'SNILS',
  OMS: 'OMS',
  PASSPORT: 'PASSPORT',
  COORDS: 'COORDS',
  ADDRESS: 'ADDRESS',
  UUID: 'UUID',
  INTERNAL_ID: 'INTERNAL_ID',
  DOB: 'DOB',
  ACCOUNT: 'ACCOUNT',
});

/** Виды, которые сами по себе делают запрос непригодным для внешней модели. */
export const HARD_BLOCK_KINDS = Object.freeze(
  new Set([ENTITY_KIND.SNILS, ENTITY_KIND.OMS, ENTITY_KIND.PASSPORT, ENTITY_KIND.ACCOUNT]),
);

const HOMOGLYPH_FOLD = new Map(Object.entries({
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М',
  O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
}));

/**
 * Строит копию текста, пригодную для поиска, вместе с картой индексов.
 * Длина скан-вида может быть меньше исходной — ровно на число вырезанных
 * невидимых символов.
 *
 * Свёртка гомоглифов применяется ТОЛЬКО к смешанным токенам, где кириллица и
 * латиница стоят в одном слове («Пeтров»). Чисто латинский токен не трогается:
 * иначе «doctor» превратился бы в «dосtоr», а hex в UUID — в кириллицу, и
 * детекторы идентификаторов перестали бы срабатывать. Ошибка такого рода уже
 * ловилась на этом модуле, поэтому проверка закреплена тестом.
 *
 * @param {string} original
 * @returns {{ text: string, map: number[] }} map[i] — индекс i-го символа скан-вида в original
 */
export const buildScanView = (original) => {
  const source = typeof original === 'string' ? original : '';
  const chars = [];
  const map = [];

  let index = 0;
  for (const char of source) {
    const width = char.length;
    INVISIBLE_CHARS.lastIndex = 0;
    if (!INVISIBLE_CHARS.test(char)) {
      chars.push(char);
      map.push(index);
    }
    index += width;
  }
  map.push(source.length);

  const isWordChar = (char) => /[\p{L}\p{N}]/u.test(char);
  const hasCyrillic = (chunk) => chunk.some((char) => /\p{Script=Cyrillic}/u.test(char));
  const hasLatin = (chunk) => chunk.some((char) => /\p{Script=Latin}/u.test(char));

  for (let start = 0; start < chars.length; start += 1) {
    if (!isWordChar(chars[start])) {
      continue;
    }

    let end = start;
    while (end < chars.length && isWordChar(chars[end])) {
      end += 1;
    }

    const token = chars.slice(start, end);
    if (hasCyrillic(token) && hasLatin(token)) {
      for (let i = start; i < end; i += 1) {
        chars[i] = HOMOGLYPH_FOLD.get(chars[i]) || chars[i];
      }
    }

    start = end;
  }

  return { text: chars.join(''), map };
};

const makeSpan = (scan, start, end, kind, confidence, detector) => ({
  kind,
  confidence,
  detector,
  start: scan.map[start],
  end: scan.map[Math.min(end, scan.map.length - 1)],
  length: end - start,
});

/*
 * ВНИМАНИЕ: все шаблоны объявляются без флага `g` на уровне модуля и
 * клонируются в момент использования. Общий regex с `g` хранит lastIndex
 * между вызовами — это источник плавающих промахов детектора.
 */
const PATTERNS = [
  {
    detector: 'email',
    kind: ENTITY_KIND.EMAIL,
    confidence: 1,
    source: String.raw`[\p{L}\p{N}._%+\-]{1,64}@[\p{L}\p{N}\-]{1,63}(?:\.[\p{L}\p{N}\-]{1,63})+`,
  },
  {
    detector: 'phone.ru',
    kind: ENTITY_KIND.PHONE,
    confidence: 1,
    source: String.raw`(?:\+?\s?7|8)[\s\-.]?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}`,
  },
  {
    detector: 'phone.local',
    kind: ENTITY_KIND.PHONE,
    confidence: 0.75,
    source: String.raw`(?<![\d.\-])\d{3}[\s\-]\d{2}[\s\-]\d{2}(?![\d.\-])`,
  },
  {
    detector: 'snils',
    kind: ENTITY_KIND.SNILS,
    confidence: 1,
    source: String.raw`(?<!\d)\d{3}[\s\-]\d{3}[\s\-]\d{3}[\s\-]\d{2}(?!\d)`,
  },
  {
    detector: 'snils.labelled',
    kind: ENTITY_KIND.SNILS,
    confidence: 1,
    source: String.raw`снилс\w*\s*[:№#]?\s*\d[\d\s\-]{9,16}\d`,
    flags: 'iu',
  },
  {
    detector: 'oms',
    kind: ENTITY_KIND.OMS,
    confidence: 0.9,
    source: String.raw`(?<!\d)\d{16}(?!\d)`,
  },
  {
    detector: 'oms.labelled',
    kind: ENTITY_KIND.OMS,
    confidence: 1,
    source: String.raw`(?:омс|полис\w*)\s*[:№#]?\s*\d[\d\s\-]{10,22}\d`,
    flags: 'iu',
  },
  {
    detector: 'account',
    kind: ENTITY_KIND.ACCOUNT,
    confidence: 0.85,
    source: String.raw`(?<![\d.])(?:\d{4}[\s\-]){3}\d{4}(?![\d.])`,
  },
  {
    detector: 'passport',
    kind: ENTITY_KIND.PASSPORT,
    confidence: 1,
    source: String.raw`(?:паспорт\w*|серия)\s*[:№#]?\s*\d{2}\s?\d{2}\s?[№#]?\s?\d{6}`,
    flags: 'iu',
  },
  {
    detector: 'passport.bare',
    kind: ENTITY_KIND.PASSPORT,
    confidence: 0.7,
    source: String.raw`(?<!\d)\d{2}\s\d{2}\s\d{6}(?!\d)`,
  },
  {
    detector: 'coords.pair',
    kind: ENTITY_KIND.COORDS,
    confidence: 1,
    // Разделитель пары — любой пробельный символ, запятая или точка с запятой.
    // В русской локали координаты пишутся «55,753381 49,173867»: запятая занята
    // под десятичный разделитель, и пара разделяется пробелом. Раньше такая
    // запись детектором не ловилась и координаты уходили наружу.
    source: String.raw`-?\d{1,3}[.,]\d{3,}[\s,;]+-?\d{1,3}[.,]\d{3,}`,
  },
  {
    detector: 'coords.single',
    kind: ENTITY_KIND.COORDS,
    confidence: 0.8,
    source: String.raw`(?<![\d.])\d{1,3}\.\d{4,}(?![\d.])`,
  },
  {
    // Телефон, записанный с разрядкой: «8 9 6 5 1 2 3 4 5 6 7».
    detector: 'phone.spaced',
    kind: ENTITY_KIND.PHONE,
    confidence: 0.9,
    source: String.raw`(?<![\d\p{L}])(?:\+\s*7|8|7)(?:[\s\-.()]{1,3}\d){9,10}(?![\d])`,
  },
  {
    // «ivan (собака) mail точка ru», «ivan [at] mail [dot] ru».
    detector: 'email.obfuscated',
    kind: ENTITY_KIND.EMAIL,
    confidence: 0.9,
    // Локальная часть и домен — латиница: иначе «врач at клиника точка рядом»
    // опознавалось как почта и редактировалось зря.
    source: String.raw`[a-z0-9._%+-]{2,}\s*[([{]?\s*(?:собака|at|dog)\s*[)\]}]?\s*[a-z0-9.-]{2,}\s*[([{]?\s*(?:точка|dot)\s*[)\]}]?\s*[a-z]{2,6}`,
    flags: 'giu',
  },
  {
    detector: 'uuid',
    kind: ENTITY_KIND.UUID,
    confidence: 1,
    source: String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`,
    flags: 'iu',
  },
  {
    detector: 'internalId.catalog',
    kind: ENTITY_KIND.INTERNAL_ID,
    confidence: 1,
    source: String.raw`\b(?:verified|osm|clinic|doctor|patient|user|appointment)-[a-z0-9]+(?:-[a-z0-9]+)*\b`,
    flags: 'iu',
  },
  {
    detector: 'internalId.opaque',
    kind: ENTITY_KIND.INTERNAL_ID,
    confidence: 0.7,
    source: String.raw`\b[0-9a-f]{24,64}\b`,
    flags: 'iu',
  },
  {
    detector: 'dob',
    kind: ENTITY_KIND.DOB,
    confidence: 0.8,
    source: String.raw`(?<![\d.])(?:0?[1-9]|[12]\d|3[01])[./\-](?:0?[1-9]|1[0-2])[./\-](?:19|20)\d{2}(?![\d.])`,
  },
  {
    detector: 'address.street',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.9,
    source: String.raw`(?:ул\.|улица|пр-?кт\.?|проспект|пер\.|переулок|б-?р\.?|бульвар|ш\.|шоссе|наб\.|набережная|мкр\.?|микрорайон)\s*[\p{L}][\p{L}\-.\s]{1,40}?,?\s*(?:д(?:ом)?\.?\s*)?\d{1,4}\s?[а-яa-z]?(?:\s*(?:к|корп|стр)\.?\s*\d{1,3})?(?:\s*,?\s*кв(?:артира)?\.?\s*\d{1,4})?`,
    flags: 'giu',
  },
  {
    detector: 'address.apartment',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.9,
    source: String.raw`кв(?:артира)?\.?\s*\d{1,4}`,
    flags: 'giu',
  },
  {
    detector: 'address.selfReference',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.85,
    source: String.raw`(?:живу|проживаю|мой\s+адрес|домашний\s+адрес|я\s+по\s+адресу)\s*[:\-]?\s*[\p{L}\d][^,.;!?]{2,60}`,
    flags: 'giu',
  },
];

/** Единичный проход всех регулярных детекторов по скан-виду. */
const runPatternDetectors = (scan) => {
  const spans = [];

  for (const pattern of PATTERNS) {
    const flags = pattern.flags ? `${pattern.flags.replace('g', '')}g` : 'gu';
    const regex = new RegExp(pattern.source, flags);

    let match;
    while ((match = regex.exec(scan.text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      spans.push(
        makeSpan(scan, match.index, match.index + match[0].length, pattern.kind, pattern.confidence, pattern.detector),
      );
    }
  }

  return spans;
};

/*
 * Эвристика ФИО.
 *
 * Работает по скан-виду с сохранённым регистром. Слова-триггеры («меня зовут»,
 * «врач», «доктор», «к») усиливают уверенность, но НЕ являются обязательными:
 * одиночное слово с фамильной морфологией и заглавной буквой уже считается
 * кандидатом. Это намеренно «шумно» — ложная редактура безопаснее пропуска.
 */
const SELF_INTRO = /(?:меня\s+зовут|моя\s+фамилия|мо[её]\s+имя|я\s*[—-]\s*|это\s+я,?)\s*/giu;
const PERSON_CUE = /(?:врач\w*|доктор\w*|терапевт\w*|специалист\w*|пациент\w*|к|у|от|для)\s+$/iu;
const CAPITALIZED_WORD = /\p{Lu}\p{L}{2,}/gu;

const detectPersons = (scan) => {
  const spans = [];
  const text = scan.text;

  // 1. Явное самопредставление: «Меня зовут Иван Иванов».
  const intro = new RegExp(SELF_INTRO.source, 'giu');
  let match;
  while ((match = intro.exec(text)) !== null) {
    const tail = text.slice(match.index + match[0].length);
    const names = tail.match(/^\s*(?:\p{Lu}\p{L}+|[\p{Ll}]{2,})(?:\s+\p{Lu}?\p{L}+){0,2}/u);
    if (names && names[0].trim().length >= 2) {
      const start = match.index + match[0].length + names[0].indexOf(names[0].trim());
      spans.push(makeSpan(scan, start, start + names[0].trim().length, ENTITY_KIND.PERSON, 1, 'person.selfIntro'));
    }
  }

  // 2. Морфологические кандидаты: фамилия и/или отчество в любом падеже.
  const words = new RegExp(CAPITALIZED_WORD.source, 'gu');
  while ((match = words.exec(text)) !== null) {
    const word = match[0];
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    const cued = PERSON_CUE.test(before);
    const surname = looksLikeSurname(word);
    const patronymic = looksLikePatronymic(word);

    if (!surname && !patronymic) {
      continue;
    }

    // Захватываем соседние слова ФИО целиком: «Галявич Альберт Сарварович».
    let end = match.index + word.length;
    const rest = text.slice(end);
    const continuation = rest.match(/^(?:\s+\p{Lu}\p{L}+){1,2}/u);
    if (continuation) {
      end += continuation[0].length;
    }

    const confidence = patronymic ? 0.95 : cued ? 0.9 : 0.6;
    spans.push(makeSpan(scan, match.index, end, ENTITY_KIND.PERSON, confidence, 'person.morphology'));
    words.lastIndex = end;
  }

  return spans;
};

/**
 * Снимает перекрытия. Побеждает более уверенный span, при равной уверенности —
 * более длинный: «Галявич Альберт Сарварович» важнее, чем одна «Галявич».
 */
export const mergeSpans = (spans) => {
  const sorted = [...spans].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.confidence !== right.confidence) return right.confidence - left.confidence;
    return right.end - left.end;
  });

  const result = [];
  for (const span of sorted) {
    if (span.end <= span.start) {
      continue;
    }

    const previous = result[result.length - 1];
    if (previous && span.start < previous.end) {
      const previousWeight = previous.confidence * 1000 + (previous.end - previous.start);
      const currentWeight = span.confidence * 1000 + (span.end - span.start);
      if (currentWeight > previousWeight && span.end > previous.end) {
        result[result.length - 1] = span;
      }
      continue;
    }

    result.push(span);
  }

  return result;
};

/**
 * Полный проход детекторов.
 *
 * @param {string} original исходный пользовательский текст
 * @returns {{ scan: {text: string, map: number[]}, spans: Array<object> }}
 */
export const detectEntities = (original) => {
  const scan = buildScanView(original);
  const spans = mergeSpans([...runPatternDetectors(scan), ...detectPersons(scan)]);
  return { scan, spans };
};

/** Числительные, которыми записывают цифры словами. */
const NUMBER_WORDS = new Set([
  'ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь',
  'девять', 'десять', 'одиннадцать', 'двенадцать', 'ноля', 'нуль',
]);

/**
 * Признаки НАРОЧИТОГО разрыва текста.
 *
 * Отвечает на вопрос, которого не задаёт ни один другой детектор: «похоже ли,
 * что здесь что-то разложили по буквам». Ответ нужен для fail-closed: если
 * такая форма есть, а склейка ничего не нашла в справочнике, мы не можем
 * отличить неизвестную фамилию от бессмыслицы — и наружу текст не отправляем.
 *
 * Считаются ТОЛЬКО буквенные односимвольные токены подряд. Цифры рвут цепочку
 * намеренно: «с 9 до 18 в пн ср пт» иначе давало бы ложное срабатывание.
 *
 * @param {string} text
 * @returns {{longestLetterRun: number, numberWordRun: number, suspicious: boolean}}
 */
export const detectObfuscation = (text) => {
  const tokens = String(text || '').match(/[\p{L}\p{N}]+/gu) || [];

  let longestLetterRun = 0;
  let currentLetters = 0;
  let numberWordRun = 0;
  let currentNumbers = 0;

  for (const token of tokens) {
    const isSingleLetter = token.length === 1 && /\p{L}/u.test(token);
    currentLetters = isSingleLetter ? currentLetters + 1 : 0;
    if (currentLetters > longestLetterRun) longestLetterRun = currentLetters;

    const isNumberWord = NUMBER_WORDS.has(token.toLowerCase());
    currentNumbers = isNumberWord ? currentNumbers + 1 : 0;
    if (currentNumbers > numberWordRun) numberWordRun = currentNumbers;
  }

  return {
    longestLetterRun,
    numberWordRun,
    // Четыре односимвольных слова подряд в живом русском тексте практически
    // не встречаются: «я к ней» — это три, и то с предлогом.
    suspicious: longestLetterRun >= 4 || numberWordRun >= 5,
  };
};

/**
 * Быстрая проверка «есть ли в строке хоть что-то чувствительное».
 * Используется как выходной предохранитель перед сетевым вызовом
 * (см. planner/client.js) — там важен только факт, а не разметка.
 */
export const containsSensitive = (value) => detectEntities(value).spans.length > 0;
