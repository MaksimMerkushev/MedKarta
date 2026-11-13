/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Приведение реплики пользователя к виду, в котором правила видят то же, что человек:
 * - NFKC: широкие цифры «８９１７», лигатуры, составные буквы («й» из двух кодов);
 * - без невидимых символов (нулевой пробел, мягкий перенос, управляющие направлением);
 * - латинские двойники в русском слове («Гульнaрa» с латинской «a») — кириллица;
 * - без HTML-тегов, сущностей и разметки Markdown («**», «```»);
 * - текст, набранный в латинской раскладке («vtyz pjden»), — по-русски, если после
 *   перевода в нём есть обычные русские слова.
 * Медицинский смысл не меняется: это не обезличивание, а нормализация входа.
 */
import { stripInvisible } from './normalize.js';
import { neutralizeUserMarkup } from './labels.js';

const LAT_TO_CYR = { a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', h: 'н', t: 'т', b: 'в', A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У' };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Слово из кириллицы с вкраплением латинских двойников — в кириллицу. */
const foldMixed = (text) => text.replace(/[\p{L}]+/gu, (word) => {
  if (!/\p{Script=Cyrillic}/u.test(word) || !/[A-Za-z]/u.test(word)) return word;
  return [...word].map((ch) => LAT_TO_CYR[ch] || ch).join('');
});

const RU = 'йцукенгшщзхъфывапролджэячсмитьбю';
const EN = 'qwertyuiop[]asdfghjkl;\'zxcvbnm,.';
const FROM_EN = new Map([...EN].map((ch, i) => [ch, RU[i]]));
const COMMON_RU = new Set(['меня', 'зовут', 'я', 'это', 'болит', 'у', 'мне', 'нет', 'не', 'и', 'в', 'на', 'с', 'телефон', 'адрес', 'живу', 'работаю', 'горло', 'голова', 'живот', 'температура', 'давление', 'здравствуйте', 'привет', 'пишет', 'мое', 'имя']);
const toRu = (word) => [...word].map((ch) => {
  const lower = ch.toLowerCase();
  const mapped = FROM_EN.get(lower);
  if (!mapped) return ch;
  return ch === lower ? mapped : mapped.toUpperCase();
}).join('');

// Почта, ссылка, ник: в другой раскладке они стали бы набором кириллических букв, который детекторы
// почты и ссылок не узнают, а получатель обратит одной заменой. Такие фрагменты не переводятся.
const LINK_LIKE = /[@/:_\d]|^www\.|\.(?:com|ru|net|org|io|me|info|su|biz|pro|ua|kz|by|uz|tj|am|ge|az|de|uk|us|eu|tv|cc|co|xyz|dev|app|online|site|tech|club|shop|store)(?![A-Za-z])/iu;
const OBFUSCATED_EMAIL = /[([]\s*(?:at|dot)\s*[)\]]|\s(?:at|dot)\s/iu;
// Признак раскладки: «[», «;», «'», запятая или точка внутри слова, знак в начале («F[vtnjd», «'nj»,
// «K.lf»). Домены, почта и ники в подсчёт не попадают — они отсеяны раньше (LINK_LIKE).
const LAYOUT_MARK = /[A-Za-z][[\];',.][A-Za-z]|^[,.'[;][A-Za-z]/u;

/** «Vtyz pjden Uekmyfhf» → «Меня зовут Гульнара», если хотя бы два слова стали обычными русскими. */
const fixLayout = (text) => {
  // Слова-кандидаты: от двух латинских букв (знаки «;'[],.» внутри допускаются); метки шлюза
  // (@WORK), «ключ=значение», почта, ссылки и одиночные буквы — не текст в раскладке.
  if (/@[A-Z]|[A-Za-z]=|=[A-Za-z]/u.test(text)) return text;
  const obfuscated = OBFUSCATED_EMAIL.test(text);
  // «e-mail», «[at]», «(dot)» — части записи почты, а не русские слова в раскладке («у-ьфшд», «хфеъ»).
  const isLink = (chunk) => LINK_LIKE.test(chunk) || /^e-?mail[:,]?$/iu.test(chunk)
    || (obfuscated && (/[A-Za-z]\.[A-Za-z]/u.test(chunk) || /^[([]?(?:at|dot)[)\]]?[,.;:]?$/iu.test(chunk)));
  const chunks = text.split(/\s+/u).filter((chunk) => chunk && !isLink(chunk));
  const latinWords = chunks.flatMap((chunk) => chunk.match(/[A-Za-z;'[\],.]+/gu) || []).filter((w) => (w.match(/[A-Za-z]/gu) || []).length >= 2);
  if (latinWords.length < 2 && !/(?<![\p{L}])(?:раскладк|клавиатур|латиниц)/iu.test(text)) return text;
  if (latinWords.length === 0) return text;
  // Запятая и точка в конце слова — пунктуация, а не буквы «б»/«ю».
  const hits = latinWords.filter((w) => COMMON_RU.has(toRu(w.replace(/[,.]+$/u, '')).toLowerCase().replace(/[^а-яё]/gu, ''))).length;
  const marked = latinWords.filter((w) => LAYOUT_MARK.test(w)).length;
  // Однобуквенные «z», «c», «d», «b» в раскладке — «я», «с», «в», «и»: подсказка, если есть знак раскладки.
  const singles = (text.match(/(?<![A-Za-z])[ZzCcDdBbRrJjFfEe](?![A-Za-z;'[\],.])/gu) || []).length;
  // Имя в раскладке сразу после русской подсказки («меня зовут K.lf Bdfyjdf»).
  const nameCue = /(?<![\p{L}])(?:зовут|имя|фамилия)\s*:?\s+[,.;'[]?[A-Za-z]/iu.test(text);
  // Человек сам говорит, что набирает в другой раскладке: «застряла английская раскладка — zhvbcjdbpjh».
  const layoutCue = /(?<![\p{L}])(?:раскладк\p{L}*|клавиатур\p{L}*|латиниц\p{L}*)/iu.test(text);
  if (!(hits >= 2 || ((hits + singles + (nameCue ? 1 : 0)) >= 1 && marked >= 1) || marked >= 2 || (layoutCue && latinWords.length >= 1))) return text;
  // Слово в раскладке может начинаться с «.» или «,» («.cegjdf» — «Юсупова»).
  // Переводится только то, где есть латинская буква: «;» после русского слова — пунктуация, не «ж».
  const word = /(?:(?<![\p{L}\p{N}])[,.](?=[A-Za-z]))?[;'[\]]*[A-Za-z][A-Za-z;'[\]]*(?:[,.](?=[A-Za-z])[A-Za-z;'[\]]*)*/gu;
  // Конечная «;» перед русским словом («zhlfyjdyf; не исправляй») — пунктуация, а не «ж».
  return text.replace(/\S+/gu, (chunk, at) => {
    if (isLink(chunk)) return chunk;
    const russianNext = /^\s+\p{Script=Cyrillic}/u.test(text.slice(at + chunk.length));
    return chunk.replace(word, (w, offset) => {
      const atEnd = offset + w.length === chunk.length;
      return atEnd && russianNext && w.endsWith(';') ? `${toRu(w.slice(0, -1))};` : toRu(w);
    });
  });
};

// HTML-сущности (десятичные и шестнадцатеричные), URL-кодирование и \uXXXX — обратимые записи
// текста. Раскрываются в ограниченное число проходов (двойное кодирование тоже); что осталось
// закодированным после них, финальная проверка не пропустит (outboundInspector, «encoded»).
export const DECODE_ROUNDS = 3;
const TAGS = /<\/?[a-z][^>]{0,200}>/giu;
const decodeEntities = (text) => text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/giu, (m, code) => {
  if (code.startsWith('#')) {
    const n = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
  }
  return ENTITIES[code.toLowerCase()] ?? m;
});
// Одиночное «%» («50%», «%20» в ссылке) не трогается: раскрываются только цепочки байтов UTF-8.
// Двойное кодирование («%25D0%25AF»): два и больше «%25XX» — это закодированные байты, а не проценты.
const undouble = (text) => ((text.match(/%25[0-9A-Fa-f]{2}/gu) || []).length >= 2 ? text.replace(/%25([0-9A-Fa-f]{2})/gu, '%$1') : text);
const decodePercent = (text) => undouble(text).replace(/(?:%[0-9A-Fa-f]{2}){2,}/gu, (m) => {
  try {
    const decoded = decodeURIComponent(m);
    return decoded.includes('\uFFFD') ? m : decoded;
  } catch {
    return m;
  }
});
const decodeEscapes = (text) => text.replace(/(?:\\u[0-9A-Fa-f]{4}){2,}/gu, (m) => {
  try {
    return JSON.parse(`"${m}"`);
  } catch {
    return m;
  }
});
const decodeBounded = (input) => {
  let text = input;
  for (let round = 0; round < DECODE_ROUNDS; round += 1) {
    const next = decodeEscapes(decodePercent(decodeEntities(text))).replace(TAGS, ' ');
    if (next === text) break;
    text = next;
  }
  return text;
};

/**
 * @param {string} value
 * @param {{layout?: boolean, brackets?: boolean}} [options] layout — исправлять раскладку;
 *   brackets — обезвредить пользовательские «[…]» и «@ЗАГЛАВНЫЕ» (вход; финальная проверка — false,
 *   там метки уже серверные)
 */
export const normalizeUserText = (value, { layout = true, brackets = true } = {}) => {
  // «№» NFKC превращает в «No» — правила номеров школ и больниц его бы не узнали.
  const nfkc = (v) => v.replace(/№/gu, '\uE000').normalize('NFKC').replace(/\uE000/gu, '№');
  let text = stripInvisible(nfkc(String(value ?? '')));
  text = decodeBounded(text.replace(TAGS, ' '));
  // Раскодированный текст может нести те же невидимые символы и широкие буквы.
  text = stripInvisible(nfkc(text));
  text = text.replace(/```[a-z]*\n?/giu, ' ').replace(/\*\*|__|~~|`/gu, '');
  if (layout) text = fixLayout(text);
  if (brackets) text = neutralizeUserMarkup(text);
  text = foldMixed(text);
  return text.replace(/[ \t]{2,}/gu, ' ').trim();
};
