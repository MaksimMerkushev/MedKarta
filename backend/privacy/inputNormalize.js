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

/** «Vtyz pjden Uekmyfhf» → «Меня зовут Гульнара», если хотя бы два слова стали обычными русскими. */
const fixLayout = (text) => {
  // Слова-кандидаты: от двух латинских букв (знаки «;'[],.» внутри допускаются); метки шлюза
  // (@WORK), «ключ=значение» и одиночные буквы — не текст в раскладке.
  if (/@[A-Z]|[A-Za-z]=|=[A-Za-z]/u.test(text)) return text;
  const latinWords = (text.match(/[A-Za-z;'[\],.]+/gu) || []).filter((w) => (w.match(/[A-Za-z]/gu) || []).length >= 2);
  if (latinWords.length < 2) return text;
  // Запятая и точка в конце слова — пунктуация, а не буквы «б»/«ю».
  const hits = latinWords.filter((w) => COMMON_RU.has(toRu(w.replace(/[,.]+$/u, '')).toLowerCase().replace(/[^а-яё]/gu, ''))).length;
  // Признак раскладки: «[», «;», «'» внутри или в начале латинского слова («F[vtnjd», «'nj»).
  const layoutMarks = latinWords.some((w) => /[A-Za-z][[\];'][A-Za-z]|^[,.'[;][A-Za-z]|[A-Za-z][,.][A-Za-z]/u.test(w));
  if (!(hits >= 2 || (hits >= 1 && layoutMarks))) return text;
  // Слово в раскладке может начинаться с «.» или «,» («.cegjdf» — «Юсупова»).
  return text.replace(/(?:(?<![\p{L}\p{N}])[,.](?=[A-Za-z]))?[A-Za-z;'[\]]+(?:[,.](?=[A-Za-z])[A-Za-z;'[\]]*)*/gu, (w) => toRu(w));
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
