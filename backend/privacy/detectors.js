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
import { isFirstName } from './firstNames.js';

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
  HANDLE: 'HANDLE',
  URL: 'URL',
  PLATE: 'PLATE',
});

/** Виды, которые сами по себе делают запрос непригодным для внешней модели. */
export const HARD_BLOCK_KINDS = Object.freeze(
  new Set([ENTITY_KIND.SNILS, ENTITY_KIND.OMS, ENTITY_KIND.PASSPORT, ENTITY_KIND.ACCOUNT]),
);

const HOMOGLYPH_FOLD = new Map(Object.entries({
  // Латиница.
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М',
  O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  // Греческий: «Кондрашοву» с греческой омикрон.
  'α': 'а', 'ε': 'е', 'ο': 'о', 'ρ': 'р', 'τ': 'т', 'κ': 'к', 'χ': 'х', 'υ': 'у',
  'Α': 'А', 'Β': 'В', 'Ε': 'Е', 'Η': 'Н', 'Κ': 'К', 'Μ': 'М', 'Ο': 'О', 'Ρ': 'Р', 'Τ': 'Т', 'Χ': 'Х', 'Υ': 'У',
}));

/*
 * Буквы украинского и белорусского алфавитов, которые подставляют вместо
 * русских: «Сафіуллін Ріната». Это та же кириллица, поэтому проверка на
 * «смешанный токен» их не ловит — сворачиваются всегда.
 */
const CYRILLIC_VARIANT_FOLD = new Map(Object.entries({
  'і': 'и', 'ї': 'и', 'є': 'е', 'ґ': 'г', 'ў': 'у',
  'І': 'И', 'Ї': 'И', 'Є': 'Е', 'Ґ': 'Г', 'Ў': 'У',
}));

/*
 * Нули десятичных систем письма, которые NFKC не сводит к ASCII:
 * арабско-индийские, деванагари и т. п. «٨٩١٧…» — такой же телефон.
 * Полноширинные и математические цифры NFKC сводит сам.
 */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x07c0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66,
  0x0ce6, 0x0d66, 0x0de6, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
];

const foldDigit = (char) => {
  const code = char.codePointAt(0);
  for (const zero of DIGIT_ZEROS) {
    if (code >= zero && code <= zero + 9) return String(code - zero);
  }
  return char;
};

const COMBINING_MARK = /^\p{M}$/u;
const WORD_CHAR = /^[\p{L}\p{N}]$/u;

/**
 * Строит копию текста, пригодную для поиска, вместе с картой индексов.
 *
 * Что сворачивается:
 *   - невидимые символы вырезаются («Пет\u200bров»);
 *   - NFKC: полноширинные и «математические» буквы и цифры («８９１７»,
 *     «𝟖𝟗») становятся обычными;
 *   - цифры других систем письма — арабские «٨٩١٧» — в ASCII;
 *   - комбинируемые знаки: если знак образует с предыдущей буквой готовый
 *     символ («и» + бреве = «й»), они склеиваются; иначе знак удаляется —
 *     так пропадают ударения («Кондрашки́ну») и «кнопки» у эмодзи-цифр;
 *   - украинские и белорусские буквы, заменяющие русские;
 *   - гомоглифы (латиница и греческий) — только в смешанных токенах, где
 *     кириллица стоит рядом с чужими буквами («Пeтров»). Чисто латинский
 *     токен не трогается: иначе hex в UUID стал бы кириллицей и детекторы
 *     идентификаторов перестали бы срабатывать.
 *
 * КАРТА ИНДЕКСОВ ведётся по единицам UTF-16 скан-вида. Раньше она велась по
 * символам, а регулярные выражения отдают позиции в единицах UTF-16: каждый
 * эмодзи (две единицы) сдвигал замену на символ вправо. Десять эмодзи перед
 * фамилией — и фамилия уходила наружу целиком, а токен «съедал» соседнее
 * слово. Теперь map[i] — индекс в исходной строке для i-й единицы скан-вида.
 *
 * @param {string} original
 * @returns {{ text: string, map: number[] }}
 */
export const buildScanView = (original) => {
  const source = typeof original === 'string' ? original : '';
  const pieces = []; // { text, origin } — один элемент на символ скан-вида

  let index = 0;
  for (const char of source) {
    const width = char.length;
    INVISIBLE_CHARS.lastIndex = 0;

    if (INVISIBLE_CHARS.test(char) || char === '️' || char === '︎') {
      index += width;
      continue;
    }

    if (COMBINING_MARK.test(char)) {
      const previous = pieces[pieces.length - 1];
      if (previous) {
        const composed = (previous.text + char).normalize('NFC');
        if ([...composed].length === 1) {
          previous.text = composed;
        }
      }
      index += width;
      continue;
    }

    let folded = char.normalize('NFKC');
    if (/^\p{Nd}$/u.test(folded) && !/^[0-9]$/.test(folded)) {
      folded = foldDigit(folded);
    }
    folded = CYRILLIC_VARIANT_FOLD.get(folded) || folded;

    // NFKC может развернуть символ в несколько («ﬁ» → «fi»): все они
    // указывают на один исходный индекс.
    for (const part of folded) {
      if (COMBINING_MARK.test(part)) continue;
      pieces.push({ text: part, origin: index });
    }
    index += width;
  }

  const isWordChar = (piece) => WORD_CHAR.test(piece.text);
  const hasCyrillic = (chunk) => chunk.some((piece) => /\p{Script=Cyrillic}/u.test(piece.text));
  const hasForeign = (chunk) => chunk.some((piece) => /[\p{Script=Latin}\p{Script=Greek}]/u.test(piece.text));

  for (let start = 0; start < pieces.length; start += 1) {
    if (!isWordChar(pieces[start])) continue;

    let end = start;
    while (end < pieces.length && isWordChar(pieces[end])) end += 1;

    const token = pieces.slice(start, end);
    if (hasCyrillic(token) && hasForeign(token)) {
      for (let i = start; i < end; i += 1) {
        pieces[i].text = HOMOGLYPH_FOLD.get(pieces[i].text) || pieces[i].text;
      }
    }
    start = end;
  }

  let text = '';
  const map = [];
  for (const piece of pieces) {
    text += piece.text;
    for (let unit = 0; unit < piece.text.length; unit += 1) {
      map.push(piece.origin);
    }
  }
  map.push(source.length);

  return { text, map };
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
    // «паспорт 9212 345678», «паспортные данные: 92 12 345678»,
    // «серия 92 12 номер 345678». \w в JS — только ASCII, поэтому буквы
    // после «паспорт» описаны через \p{L}: иначе «паспортные» не совпадало.
    detector: 'passport',
    kind: ENTITY_KIND.PASSPORT,
    confidence: 1,
    source: String.raw`(?:паспорт\p{L}*|серия)[^\d\n]{0,24}\d{2}\s?\d{2}[^\d\n]{0,16}\d{6}`,
    flags: 'iu',
  },
  {
    /*
     * Номер документа по контексту: «номер карты пациента 4567891»,
     * «полис 1234.5678.9012.3456», «СНИЛС 123/456/789/01». Любые разделители —
     * точка, косая черта, подчёркивание. Такой запрос не уходит наружу вовсе.
     */
    detector: 'document.labelled',
    kind: ENTITY_KIND.ACCOUNT,
    confidence: 0.95,
    source: String.raw`(?:инн|медкарт|карт\p{L}*\s+пациент|номер\s+карт|амбулаторн\p{L}*\s+карт|договор)\p{L}*[^\d\n]{0,24}\d(?:[\s./_\-]{0,2}\d){4,}`,
    flags: 'iu',
  },
  {
    detector: 'snils.loose',
    kind: ENTITY_KIND.SNILS,
    confidence: 0.95,
    source: String.raw`снилс\p{L}*[^\d\n]{0,16}\d(?:[\s./_\-]{0,2}\d){8,12}`,
    flags: 'iu',
  },
  {
    detector: 'oms.loose',
    kind: ENTITY_KIND.OMS,
    confidence: 0.95,
    source: String.raw`(?:омс|полис\p{L}*)[^\d\n]{0,16}\d(?:[\s./_\-]{0,2}\d){9,20}`,
    flags: 'iu',
  },
  {
    /*
     * Любая длинная цепочка цифр с произвольными разделителями:
     * «8/917/123/45/67», «8_917_123_45_67», «123.456.789 01». Семь цифр и
     * больше в запросе о враче — это телефон или номер документа. Точные
     * детекторы выше дают более конкретный вид и выигрывают по уверенности;
     * этот ловит всё, что они пропустили.
     */
    detector: 'digits.run',
    kind: ENTITY_KIND.ACCOUNT,
    confidence: 0.7,
    source: String.raw`(?<![\d.,])\+?\d(?:[\s./_\-()]{0,3}\d){6,}(?![\d])`,
    // Российский мобильный или городской с кодом — телефон (редактируется,
    // запрос уходит); всё прочее длинное — номер документа (не уходит).
    classify: (value) => {
      const digits = value.replace(/\D/g, '');
      if ((digits.length === 11 && /^[78]/.test(digits)) || (digits.length === 10 && /^9/.test(digits))) {
        return ENTITY_KIND.PHONE;
      }
      return ENTITY_KIND.ACCOUNT;
    },
  },
  {
    // «@kondrashova_m». Наши собственные токены (@DOCTOR_A) — заглавные и не совпадают.
    detector: 'handle',
    kind: ENTITY_KIND.HANDLE,
    confidence: 0.9,
    source: String.raw`(?<![\p{L}\p{N}_.])@(?![A-Z_]+(?![a-z0-9]))[A-Za-z][A-Za-z0-9_.]{3,31}`,
  },
  {
    detector: 'url',
    kind: ENTITY_KIND.URL,
    confidence: 1,
    source: String.raw`(?:https?:\/\/|www\.)[^\s<>"«»]+|(?:vk\.com|vk\.ru|t\.me|ok\.ru|instagram\.com|facebook\.com|wa\.me|max\.ru)\/[^\s<>"«»]+`,
    flags: 'iu',
  },
  {
    // Автомобильный номер: «А123ВС116», «а 123 вс 116 rus».
    detector: 'plate',
    kind: ENTITY_KIND.PLATE,
    confidence: 0.9,
    source: String.raw`(?<![\p{L}\d])[авекмнорстухabekmhopctyx]\s?\d{3}\s?[авекмнорстухabekmhopctyx]{2}\s?\d{2,3}(?:\s?rus)?(?![\p{L}\d])`,
    flags: 'iu',
  },
  {
    // Координаты в градусах, минутах и секундах: «55°45′12″ с.ш.».
    detector: 'coords.dms',
    kind: ENTITY_KIND.COORDS,
    confidence: 1,
    source: String.raw`\d{1,3}\s?°\s?\d{1,2}\s?['′]\s?(?:\d{1,2}(?:[.,]\d+)?\s?["″]?)?\s?(?:[сю]\.?\s?ш\.?|[вз]\.?\s?д\.?|[nsew])?`,
    flags: 'iu',
  },
  {
    detector: 'coords.dms.plain',
    kind: ENTITY_KIND.COORDS,
    confidence: 0.9,
    source: String.raw`(?<!\d)\d{1,3}\s\d{1,2}\s\d{1,2}(?:[.,]\d+)?\s?(?:[NSEW]|[сю]\.?\s?ш\.?|[вз]\.?\s?д\.?)(?![\p{L}])`,
    flags: 'u',
  },
  {
    // Две тройки чисел подряд: «55 45 12 и 49 10 25» — градусы без значков.
    detector: 'coords.triples',
    kind: ENTITY_KIND.COORDS,
    confidence: 0.85,
    source: String.raw`(?<!\d)\d{2}\s\d{2}\s\d{2}(?:[.,]\d+)?\s*(?:и|,|;|/)\s*\d{2}\s\d{2}\s\d{2}(?:[.,]\d+)?(?!\d)`,
    flags: 'u',
  },
  {
    detector: 'dob.iso',
    kind: ENTITY_KIND.DOB,
    confidence: 0.85,
    source: String.raw`(?<![\d.])(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d])`,
  },
  {
    detector: 'dob.shortYear',
    kind: ENTITY_KIND.DOB,
    confidence: 0.75,
    source: String.raw`(?<![\d.])(?:0?[1-9]|[12]\d|3[01])[./](?:0?[1-9]|1[0-2])[./]\d{2}(?![\d.])`,
  },
  {
    detector: 'dob.words',
    kind: ENTITY_KIND.DOB,
    confidence: 0.85,
    source: String.raw`(?<!\d)(?:0?[1-9]|[12]\d|3[01])\s+(?:январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*\s+(?:19|20)\d{2}`,
    flags: 'iu',
  },
  {
    /*
     * E-mail, записанный с пробелами или словами: «ivan @ mail.ru»,
     * «ivan at mail.ru», «ivan[at]mail[.]ru», «ivanpetrov85@gmail» (без зоны).
     * Домен — строчная латиница, поэтому наши токены «to @HOME» не совпадают.
     */
    detector: 'email.loose',
    kind: ENTITY_KIND.EMAIL,
    confidence: 0.9,
    source: String.raw`[A-Za-z0-9._%+\-]{2,}\s*(?:@|\[at\]|\(at\)|\sat\s|\[собака\]|\(собака\))\s*[a-z0-9\-]{2,}(?:\s*(?:\.|\[\.\]|\(\.\)|\[dot\]|\(dot\)|\sdot\s|\sточка\s)\s*[a-z]{2,6})*`,
    flags: 'gu',
  },
  {
    // «иван собака мейл точка ру» — целиком словами.
    detector: 'email.words',
    kind: ENTITY_KIND.EMAIL,
    confidence: 0.85,
    source: String.raw`[\p{L}\p{N}._\-]{2,}\s+(?:собака|собачка)\s+[\p{L}\p{N}\-]{2,}(?:\.[\p{L}]{2,4}|\s+(?:точка|dot)\s+[\p{L}]{2,4})`,
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
    /*
     * Адрес без слова «улица»: «Баумана 44-12», «Пушкина 5/17»,
     * «Амирхана 91, подъезд 3». Признак — номер дома с квартирой или
     * подъездом: у названий клиник («Поликлиника 21») его не бывает.
     */
    detector: 'address.house',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.85,
    source: String.raw`\p{Lu}\p{Ll}+(?:[\s\-]\p{Lu}\p{Ll}+)?\s+\d{1,3}\s?[а-я]?(?:\s*[\-/]\s*\d{1,4}|\s*,?\s*(?:кв|квартира|подъезд|под|корпус|корп|стр|строение|этаж)\.?\s*\d{1,4})`,
    flags: 'gu',
  },
  {
    // «дом 5 корпус 2», «5 корпус 2», «д. 12, стр. 3».
    detector: 'address.building',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.8,
    source: String.raw`(?:(?:дом|д\.)\s*)?\d{1,3}\s?[а-я]?\s*,?\s*(?:корпус|корп\.?|к\.|строение|стр\.?)\s*\d{1,3}(?:\s+на\s+\p{Lu}\p{Ll}+(?:\s+улиц\p{L}*)?)?`,
    flags: 'giu',
  },
  {
    // «от Амирхана 91», «с Победы 100/2», «из пр. Победы 100».
    detector: 'address.origin',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.75,
    source: String.raw`(?<![\p{L}])(?:от|из|с|со|около|возле|у)\s+(?:(?:ул|пр|просп|пер|б-р|ш)\.?\s*)?(?!Поликлиник|Больниц|Клиник|Стоматолог|Детск|Роддом|Центр|Школ|Гимнази|Лицей)\p{Lu}\p{Ll}{3,}\s+\d{1,3}\s?[а-я]?(?![\d:.,]|\s*(?:км|мин|час|м\b|лет|год|руб|₽|%))`,
    flags: 'gu',
  },
  {
    // «улицы Баумана дом сорок четыре» — номер дома словами.
    detector: 'address.words',
    kind: ENTITY_KIND.ADDRESS,
    confidence: 0.85,
    source: String.raw`(?:ул\.|улиц\p{L}*|проспект\p{L}*|переул\p{L}*)\s*\p{L}[\p{L}\-]{2,}\s+(?:дом|д\.)\s+(?:\p{L}+\s*){1,3}`,
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
      const kind = pattern.classify ? pattern.classify(match[0]) : pattern.kind;
      spans.push(
        makeSpan(scan, match.index, match.index + match[0].length, kind, pattern.confidence, pattern.detector),
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
const SELF_INTRO = /(?:зовут|(?<!\p{L})(?:фамилия|имя|отчество|фио)(?:\s+(?:пациент|мам|пап|сын|доч|реб[её]нк|жен|муж)\p{L}*)?\s*[:\-—]?|я\s*[—-]\s*|это\s+я,?)\s*/giu;

/** Родственники: после них в запросе обычно стоит имя или фамилия. */
const KINSHIP = /^(?:мам|пап|мат|отц|отец|сын|доч|жен|муж|бабушк|бабул|дедушк|дед|брат|сестр|реб[её]нк|ребенок|внук|внучк|тёщ|тещ|свекров|племянн|пациент)\p{L}*$/iu;

/**
 * Слова на «-ский/-ская», которые выглядят как фамилии, но в запросах
 * о врачах почти всегда прилагательные: «Медицинский центр», «Детская
 * поликлиника», районы Казани. Без исключения «Медицинский центр рядом»
 * считался запросом с фамилией и не уходил планировщику.
 */
const NOT_A_SURNAME = /^(?:медицинск|детск|семейн|городск|республиканск|клиническ|стоматологическ|женск|мужск|частн|государственн|ближайш|круглосуточн|районн|центральн|областн|военн|железнодорожн|ведомственн|психоневрологическ|онкологическ|наркологическ|травматологическ|хирургическ|неврологическ|кардиологическ|диагностическ|реабилитационн|консультативн|санаторн|инфекционн|кожно|вахитовск|московск|советск|кировск|приволжск|авиастроительн|савиновск|ново|казанск|татарск|российск|русск|европейск|международн|университетск|академическ|научн|специализированн)/iu;

export const isCommonAdjective = (word) => NOT_A_SURNAME.test(String(word || ''));
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
    const surname = looksLikeSurname(word) && !isCommonAdjective(word);
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

  spans.push(...detectNamesByDictionary(scan));
  spans.push(...detectLatinNames(scan));
  return spans;
};

const tokenize = (text) => {
  const tokens = [];
  const regex = /[\p{L}\p{N}]+(?:-[\p{L}]+)?/gu;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({ raw: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
};

const isCapitalized = (word) => /^\p{Lu}\p{Ll}/u.test(word);

/**
 * Имена по словарю и соседние с ними слова.
 *
 *   «запишите маму Марию»          — имя с заглавной;
 *   «маму марию», «сына иванова»    — строчными, но сразу после родственника;
 *   «Анну Черных», «Гоголя Николая» — имя плюс соседнее слово с заглавной:
 *                                      нерусская фамилия морфологией не ловится,
 *                                      но рядом с именем это почти всегда она.
 */
const detectNamesByDictionary = (scan) => {
  const spans = [];
  const tokens = tokenize(scan.text);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const previous = tokens[i - 1];
    const afterKin = previous && KINSHIP.test(previous.raw) && scan.text.slice(previous.end, token.start).trim() === '';
    const latinAfterKin = afterKin && /^[a-z]{3,}$/i.test(token.raw);
    const dictionaryName = (isFirstName(token.raw) && (isCapitalized(token.raw) || afterKin)) || latinAfterKin;
    const kinSurname = afterKin && token.raw.length >= 4
      && (looksLikeSurname(token.raw) || looksLikePatronymic(token.raw)) && !isCommonAdjective(token.raw);

    if (!dictionaryName && !kinSurname) continue;

    let first = i;
    let last = i;
    // Соседи с заглавной буквы: фамилия и отчество, до двух слов в каждую сторону.
    for (let j = i - 1; j >= Math.max(0, i - 2); j -= 1) {
      const gap = scan.text.slice(tokens[j].end, tokens[j + 1].start);
      if (!/^\s+$/.test(gap) || !isCapitalized(tokens[j].raw) || isCommonAdjective(tokens[j].raw)) break;
      first = j;
    }
    for (let j = i + 1; j <= Math.min(tokens.length - 1, i + 2); j += 1) {
      const gap = scan.text.slice(tokens[j - 1].end, tokens[j].start);
      const neighbour = tokens[j].raw;
      const fits = isCapitalized(neighbour) || isFirstName(neighbour) || looksLikePatronymic(neighbour)
        || (afterKin && looksLikeSurname(neighbour)) || (latinAfterKin && /^[a-z]{3,}$/i.test(neighbour));
      if (!/^\s+$/.test(gap) || !fits || isCommonAdjective(neighbour)) break;
      last = j;
    }

    spans.push(makeSpan(scan, tokens[first].start, tokens[last].end, ENTITY_KIND.PERSON, 0.9, 'person.dictionary'));
    i = last;
  }

  return spans;
};

/**
 * Имена латиницей: «Maria Kondrashova», «Kondrashova».
 * Два слова с заглавной подряд или одно — с фамильным окончанием транслита.
 */
const LATIN_SURNAME_TAIL = /(?:ova|eva|ina|yna|ov|ev|in|sky|skiy|skii|skaya|enko|uk|yuk|ich|vich|yan|shvili|ullin|ullina)$/i;

const detectLatinNames = (scan) => {
  const spans = [];

  // Одно латинское слово с заглавной после указателя на человека:
  // «к доктору Lurie», «пациент Smith».
  const cued = /(?:врач\p{L}*|доктор\p{L}*|пациент\p{L}*|специалист\p{L}*|к|у|для)\s+(\p{Lu}[a-z]{2,})(?![\p{L}])/gu;
  let cue;
  while ((cue = cued.exec(scan.text)) !== null) {
    const start = cue.index + cue[0].length - cue[1].length;
    spans.push(makeSpan(scan, start, start + cue[1].length, ENTITY_KIND.PERSON, 0.8, 'person.latin.cued'));
  }

  // Буквы вперемешку с цифрами: «К0ндрашову», «Сафиу11ина».
  const leet = /(?<![\p{L}\d])\p{Lu}[\p{L}\d]*\d[\p{L}\d]*(?![\p{L}\d])/gu;
  let mixed;
  while ((mixed = leet.exec(scan.text)) !== null) {
    const letters = mixed[0].replace(/\d/g, '');
    const digits = mixed[0].length - letters.length;
    if (letters.length >= 4 && digits <= 3 && /\p{Script=Cyrillic}/u.test(letters)) {
      spans.push(makeSpan(scan, mixed.index, mixed.index + mixed[0].length, ENTITY_KIND.PERSON, 0.75, 'person.leet'));
    }
  }

  const regex = /(?<![\p{L}@])\p{Lu}[a-z]{1,}(?:\s+\p{Lu}[a-z]{1,}){0,2}(?![\p{L}])/gu;
  let match;
  while ((match = regex.exec(scan.text)) !== null) {
    if (!/^[A-Za-z\s]+$/.test(match[0])) continue;
    const parts = match[0].split(/\s+/);
    const pair = parts.length >= 2;
    const surnameLike = parts.some((part) => part.length >= 4 && LATIN_SURNAME_TAIL.test(part));
    if (!pair && !surnameLike) continue;
    spans.push(makeSpan(scan, match.index, match.index + match[0].length, ENTITY_KIND.PERSON, 0.8, 'person.latin'));
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
  'ноль', 'нуль', 'ноля', 'один', 'одна', 'два', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь',
  'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать', 'двадцать',
  'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто',
  'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот',
  'девятьсот', 'тысяча', 'тысячи', 'тысяч', 'плюс',
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
  // Цифры вперемешку с числительными: «8-917-один два три-45-67».
  let mixedRun = 0;
  let currentMixed = 0;
  let mixedHasWord = false;
  let mixedHasDigits = false;

  for (const token of tokens) {
    const isSingleLetter = token.length === 1 && /\p{L}/u.test(token);
    currentLetters = isSingleLetter ? currentLetters + 1 : 0;
    if (currentLetters > longestLetterRun) longestLetterRun = currentLetters;

    const isNumberWord = NUMBER_WORDS.has(token.toLowerCase());
    currentNumbers = isNumberWord ? currentNumbers + 1 : 0;
    if (currentNumbers > numberWordRun) numberWordRun = currentNumbers;

    const isDigits = /^\d+$/.test(token);
    if (isNumberWord || isDigits) {
      currentMixed += 1;
      mixedHasWord ||= isNumberWord;
      mixedHasDigits ||= isDigits;
      if (mixedHasWord && mixedHasDigits && currentMixed > mixedRun) mixedRun = currentMixed;
    } else {
      currentMixed = 0;
      mixedHasWord = false;
      mixedHasDigits = false;
    }
  }

  /*
   * Слово, разорванное эмодзи или косой чертой: «Кондрат🙂ьеву»,
   * «Кондра/шову». Для врачей из справочника такую запись склеивает
   * резолвер; всё остальное — неизвестное слово, которое пытались спрятать.
   */
  const brokenWord = /\p{L}{2,}\p{Extended_Pictographic}+\p{L}{2,}|\p{Lu}\p{Ll}{2,}[/|\\]\p{Ll}{2,}/u.test(String(text || ''));

  return {
    longestLetterRun,
    brokenWord,
    numberWordRun: Math.max(numberWordRun, mixedRun),
    // Четыре односимвольных слова подряд в живом русском тексте практически
    // не встречаются: «я к ней» — это три, и то с предлогом.
    suspicious: longestLetterRun >= 4 || numberWordRun >= 5 || mixedRun >= 5 || brokenWord,
  };
};

/**
 * Быстрая проверка «есть ли в строке хоть что-то чувствительное».
 * Используется как выходной предохранитель перед сетевым вызовом
 * (см. planner/client.js) — там важен только факт, а не разметка.
 */
export const containsSensitive = (value) => detectEntities(value).spans.length > 0;
