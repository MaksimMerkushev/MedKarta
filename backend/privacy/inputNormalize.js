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
  const isLink = (chunk) => LINK_LIKE.test(chunk) || (obfuscated && /[A-Za-z]\.[A-Za-z]/u.test(chunk));
  const chunks = text.split(/\s+/u).filter((chunk) => chunk && !isLink(chunk));
  const latinWords = chunks.flatMap((chunk) => chunk.match(/[A-Za-z;'[\],.]+/gu) || []).filter((w) => (w.match(/[A-Za-z]/gu) || []).length >= 2);
  if (latinWords.length < 2) return text;
  // Запятая и точка в конце слова — пунктуация, а не буквы «б»/«ю».
  const hits = latinWords.filter((w) => COMMON_RU.has(toRu(w.replace(/[,.]+$/u, '')).toLowerCase().replace(/[^а-яё]/gu, ''))).length;
  const marked = latinWords.filter((w) => LAYOUT_MARK.test(w)).length;
  // Однобуквенные «z», «c», «d», «b» в раскладке — «я», «с», «в», «и»: подсказка, если есть знак раскладки.
  const singles = (text.match(/(?<![A-Za-z])[ZzCcDdBbRrJjFfEe](?![A-Za-z;'[\],.])/gu) || []).length;
  // Имя в раскладке сразу после русской подсказки («меня зовут K.lf Bdfyjdf»).
  const nameCue = /(?<![\p{L}])(?:зовут|имя|фамилия)\s*:?\s+[,.;'[]?[A-Za-z]/iu.test(text);
  if (!(hits >= 2 || ((hits + singles + (nameCue ? 1 : 0)) >= 1 && marked >= 1) || marked >= 2)) return text;
  // Слово в раскладке может начинаться с «.» или «,» («.cegjdf» — «Юсупова»).
  const word = /(?:(?<![\p{L}\p{N}])[,.](?=[A-Za-z]))?[A-Za-z;'[\]]+(?:[,.](?=[A-Za-z])[A-Za-z;'[\]]*)*/gu;
  return text.replace(/\S+/gu, (chunk) => (isLink(chunk) ? chunk : chunk.replace(word, (w) => toRu(w))));
};

export const normalizeUserText = (value, { layout = true } = {}) => {
  // «№» NFKC превращает в «No» — правила номеров школ и больниц его бы не узнали.
  let text = String(value ?? '').replace(/№/gu, '\uE000').normalize('NFKC').replace(/\uE000/gu, '№');
  text = stripInvisible(text);
  text = text.replace(/<\/?[a-z][^>]{0,200}>/giu, ' ').replace(/&(#\d{1,6}|[a-z]{2,6});/giu, (m, code) => {
    if (code.startsWith('#')) { const n = Number(code.slice(1)); return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' '; }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
  text = text.replace(/```[a-z]*\n?/giu, ' ').replace(/\*\*|__|~~|`/gu, '');
  if (layout) text = fixLayout(text);
  text = foldMixed(text);
  return text.replace(/[ \t]{2,}/gu, ' ').trim();
};
