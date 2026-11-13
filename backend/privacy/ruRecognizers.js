/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Детерминированные распознаватели персональных данных РФ поверх детекторов Gateway —
 * то, что red-team набор пропускал: имена строчными и без «меня зовут», организации
 * строчными после «работаю в», телефоны словами, почта с заменами, ники и ссылки,
 * закодированные строки, координаты, адреса с сокращениями.
 * Возвращают диапазоны с типом; медицинские слова не трогают. Используются и при
 * обезличивании жалобы, и финальной проверкой тела запроса.
 */
import { isFirstName } from './firstNames.js';
import { looksLikePatronymic, looksLikeSurname } from './morphology.js';
import { isMedicalPhrase, isMedicalWord } from './medicalLexicon.js';

const norm = (v) => v.toLowerCase().replace(/ё/gu, 'е');
// Имена, которых не было в firstNames.js и которые пропускались на dev-наборе.
const EXTRA_FIRST_NAMES = new Set(['ильнур', 'ильнура', 'ильнуру', 'ильнуром', 'зарема', 'заремы', 'зареме', 'заремой', 'патимат', 'магомед', 'магомеда', 'магомеду', 'магомедом', 'мадина', 'мадины', 'мадине', 'мадиной', 'арсен', 'арсена', 'арсену', 'арсеном', 'шамиль', 'шамиля', 'шамилю', 'шамилем', 'марсель', 'марселя', 'марселю', 'марселем', 'земфира', 'земфиры', 'земфире', 'земфирой', 'гузель', 'динара', 'динары', 'динаре', 'динарой']);
const firstName = (w) => isFirstName(w) || EXTRA_FIRST_NAMES.has(norm(w));
const NAME_CUE = /^(?:зовут|я|это|пишет|звать|меня|мое|моё|имя|от|у|к|с|доктор\p{L}*|врач\p{L}*)$/u;
const STOP = new Set(['я', 'и', 'в', 'на', 'с', 'у', 'к', 'по', 'не', 'но', 'а', 'это', 'мне', 'меня', 'уже', 'еще', 'ещё', 'очень', 'день', 'дня', 'дней', 'неделю', 'недели']);

const tokensOf = (text) => [...text.matchAll(/[\p{L}][\p{L}-]*/gu)].map((m) => ({ value: m[0], start: m.index, end: m.index + m[0].length }));

const names = (text) => {
  const spans = [];
  const tokens = tokensOf(text);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (isMedicalWord(t.value) || STOP.has(norm(t.value))) continue;
    const next = tokens[i + 1];
    const gapOk = (a, b) => b && /^[\s,]*$/u.test(text.slice(a.end, b.start)) && !/,/u.test(text.slice(a.end, b.start));
    const surnameLike = (w) => looksLikeSurname(w) && !isMedicalWord(w);
    if (firstName(t.value)) {
      let end = t.end;
      let j = i + 1;
      while (j < tokens.length && j <= i + 2 && gapOk(tokens[j - 1], tokens[j]) && (surnameLike(tokens[j].value) || looksLikePatronymic(tokens[j].value) || firstName(tokens[j].value))) { end = tokens[j].end; j += 1; }
      const before = tokens.slice(Math.max(0, i - 2), i).map((x) => norm(x.value));
      const capital = /^\p{Lu}/u.test(t.value);
      // Одно имя: с заглавной (детекторы его обычно видят) или после «зовут/я/это/у/к/доктор».
      if (end > t.end || capital || before.some((b) => NAME_CUE.test(b)) || i === 0) spans.push({ type: 'PERSON', start: t.start, end });
      i = j - 1;
      continue;
    }
    if (surnameLike(t.value) && next && gapOk(t, next) && (firstName(next.value) || looksLikePatronymic(next.value))) {
      let end = next.end;
      const third = tokens[i + 2];
      if (third && gapOk(next, third) && (looksLikePatronymic(third.value) || firstName(third.value))) end = third.end;
      spans.push({ type: 'PERSON', start: t.start, end });
      i += 1;
      continue;
    }
    // «Петровна сказала», «Ивановна посоветовала»: отчество-обращение.
    if (looksLikePatronymic(t.value) && /^\p{Lu}/u.test(t.value)) spans.push({ type: 'PERSON', start: t.start, end: t.end });
  }
  return spans;
};

// Место работы и учёбы строчными: следующие 1–3 слова, если это не общее «завод», «офис»…
const WORK_CUE = /(?<![\p{L}])(?:работа(?:ю|ет|ем)|тружусь|устроил(?:ся|ась)|сотрудни(?:к|ца)|учусь|учится|студент\p{L}*|наблюда(?:юсь|ется)|лечусь|лечил(?:ся|ась)|я\s+из)\s+(?:в|во|на|из)?\s*/giu;
const GENERIC_WORK = new Set(['заводе', 'завод', 'фабрике', 'офисе', 'школе', 'больнице', 'поликлинике', 'магазине', 'складе', 'стройке', 'шахте', 'такси', 'банке', 'саду', 'детском', 'торговле', 'продажах', 'айти', 'кафе', 'ресторане', 'гараже', 'автосервисе', 'супермаркете', 'вузе', 'университете', 'колледже', 'техникуме', 'институте', 'армии', 'полиции', 'охране', 'бухгалтерии', 'больнице', 'ночную', 'ночные', 'смену', 'смены', 'две', 'удаленке', 'удалёнке', 'декрете', 'пенсии', 'казани', 'казань', 'городе', 'деревне', 'селе', 'компании', 'фирме', 'конторе', 'химией', 'химии', 'холоде', 'жаре', 'улице', 'ногах', 'компьютером', 'компьютере', 'медсестрой', 'водителем', 'учителем', 'продавцом', 'бухгалтером', 'курьером', 'врачом']);
const TITLE_WORD = /^(?:главврач|главн|директор|заведующ|начальник|руководител|заместител|председател|судь|прокурор|ректор|декан|следовател|депутат|министр)/u;
const orgsAfterCue = (text) => {
  const spans = [];
  for (const m of text.matchAll(WORK_CUE)) {
    const from = m.index + m[0].length;
    const rest = text.slice(from).match(/^([\p{L}][\p{L}\p{N}-]*)(?:\s+([\p{L}][\p{L}\p{N}-]*))?/u);
    if (!rest || text[from] === '[') continue;
    const first = rest[1];
    // Должность («главврачом», «судьёй») — забота правила должностей в deidentify.js.
    if (GENERIC_WORK.has(norm(first)) || isMedicalWord(first) || STOP.has(norm(first)) || TITLE_WORD.test(norm(first))) continue;
    // Второе слово берём, только если оно не начинает новую часть фразы.
    const second = rest[2] && !STOP.has(norm(rest[2])) && !isMedicalWord(rest[2]) && !/^(?:болит|болят|тошнит|давит|колет|уже|давно|сильно)$/u.test(norm(rest[2])) ? rest[2] : null;
    spans.push({ type: 'ORG', start: from, end: from + first.length + (second ? rest[0].length - first.length : 0) });
  }
  return spans;
};

const NUMBER_WORD = '(?:ноль|нуль|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять)';
const PHONE_WORDS = new RegExp(`(?<![\\p{L}])${NUMBER_WORD}(?:[\\s,.-]+${NUMBER_WORD}){6,}(?![\\p{L}])`, 'giu');
// Начало — только с границы слова: иначе на длинной строке перебор квадратичный.
const EMAIL_OBF = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{2,}\s*(?:@|\(\s*at\s*\)|\[\s*at\s*\]|\s(?:at|собака)\s)\s*[A-Za-z0-9-]+(?:\s*(?:\.|\(\s*dot\s*\)|\[\s*dot\s*\]|\s(?:dot|точка)\s)\s*[A-Za-z]{2,})+/giu;
const HANDLE = /(?:(?<![\p{L}\p{N}])@|t\.me\/|vk\.com\/|instagram\.com\/|ok\.ru\/|tiktok\.com\/@?|wa\.me\/)[A-Za-z0-9_.]{3,}/giu;
const HANDLE_CUE = /(?<![\p{L}])(?:телеграм\p{L}*|телега|тг|tg|инст\p{L}*|insta\p{L}*|вк|vk|ник|whatsapp|вотсап|viber|вайбер|страница)\s*:?\s+([A-Za-z0-9_.]{3,})/giu;
// Кандидаты — линейным поиском; смешанный регистр и цифры проверяются отдельно (без lookahead по всей длине).
const BASE64_CANDIDATE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/])/gu;
const looksBase64 = (token) => /[A-Z]/u.test(token) && /[a-z]/u.test(token) && /[0-9+/]/u.test(token);
const URL_ENCODED = /(?:%[0-9A-Fa-f]{2}){3,}[^\s]*/gu;
const HEX = /(?<![\p{L}\p{N}])[0-9a-f]{16,}(?![\p{L}\p{N}])/giu;
const COORD = /-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/gu;
// Сокращение — только с точкой, полное слово — только целиком: «пос» внутри «постоянно» — не адрес.
const STREET = '(?:ул\\.|пр-т|пр\\.|пер\\.|б-р|наб\\.|мкр\\.|г\\.|пос\\.|п\\.|с\\.|д\\.|(?:улиц\\p{L}*|проспект\\p{L}*|переул\\p{L}*|бульвар\\p{L}*|шоссе|набережн\\p{L}*|микрорайон\\p{L}*|город|поселок|посёлок|село|деревн\\p{L}*)(?=\\s))';
const ADDRESS = new RegExp(`(?<![\\p{L}])${STREET}\\s*(\\p{L}[\\p{L}-]*)(?:\\s+\\p{Lu}[\\p{L}-]*)?((?:[\\s,]+(?:д\\.|дом)?\\s*\\d+\\p{L}?(?:\\s*[-/]\\s*\\d+)?)?(?:[\\s,]+(?:кв\\.?|квартира|под\\.?|подъезд|эт\\.?|этаж|корп\\.?|корпус)\\s*\\d+)*)`, 'gu');
// Адрес — если название с заглавной или за ним номер дома.
const addressSpans = (text) => [...text.matchAll(ADDRESS)].filter((m) => /^\p{Lu}/u.test(m[1]) || /\d/u.test(m[2] || '')).map((m) => ({ type: 'ADDRESS', start: m.index, end: m.index + m[0].length }));
const HOUSE_DASH = /(?<![\p{L}])\p{Lu}\p{Ll}{3,}\s+\d{1,3}\p{L}?\s*[-/]\s*\d{1,4}(?![\p{N}])/gu;
const FLAT = /(?<![\p{L}])(?:д\.|дом)\s*\d+\p{L}?(?:[\s,]+(?:кв\.?|квартира|под\.?|подъезд|эт\.?|этаж)\s*\d+)+/giu;

const regexSpans = (text, pattern, type, group = 0) => [...text.matchAll(pattern)].map((m) => {
  const start = group ? m.index + m[0].indexOf(m[group]) : m.index;
  return { type, start, end: start + (group ? m[group].length : m[0].length) };
});

/**
 * @param {string} text
 * @returns {Array<{type: string, start: number, end: number}>}
 */
export const recognizePii = (text) => {
  const value = String(text || '');
  const spans = [
    ...names(value),
    ...orgsAfterCue(value),
    // Аббревиатура с падежным окончанием («КАМАЗе», «РКБшке») — название организации.
    ...regexSpans(value, /(?<![\p{L}])\p{Lu}{2,}\p{Ll}{1,3}(?![\p{L}])/gu, 'ORG'),
    ...regexSpans(value, PHONE_WORDS, 'PHONE'),
    ...regexSpans(value, EMAIL_OBF, 'EMAIL'),
    // Метки шлюза (@CURRENT_LOCATION, @DOCTOR_C) — не ники; точка на конце — пунктуация.
    ...regexSpans(value, HANDLE, 'URL').map((sp) => ({ ...sp, end: sp.end - (value.slice(sp.start, sp.end).match(/\.+$/u)?.[0].length || 0) })).filter((sp) => !/^@[A-Z]+(?:_[A-Z0-9]+)*$/u.test(value.slice(sp.start, sp.end))),
    ...regexSpans(value, HANDLE_CUE, 'URL', 1),
    ...regexSpans(value, BASE64_CANDIDATE, 'SECRET').filter((sp) => looksBase64(value.slice(sp.start, sp.end))),
    ...regexSpans(value, URL_ENCODED, 'SECRET'),
    ...regexSpans(value, HEX, 'SECRET'),
    ...regexSpans(value, COORD, 'LOC'),
    ...addressSpans(value),
    ...regexSpans(value, HOUSE_DASH, 'ADDRESS'),
    ...regexSpans(value, FLAT, 'ADDRESS'),
  ];
  // Внутри меток Gateway ничего не ищем; медицинские фразы не трогаем.
  const labels = [...value.matchAll(/\[[^[\]\n]{1,40}\]|@[A-Z]+(?:_[A-Z0-9]+)?/gu)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const seen = new Set();
  return spans.filter((s) => s.end > s.start
    && !seen.has(`${s.type}:${s.start}:${s.end}`) && seen.add(`${s.type}:${s.start}:${s.end}`)
    && !labels.some((l) => l.start <= s.start && s.end <= l.end)
    && !(s.type === 'PERSON' || s.type === 'ORG' ? isMedicalPhrase(value.slice(s.start, s.end)) : false));
};
