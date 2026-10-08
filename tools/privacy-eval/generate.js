/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Генератор размеченного набора запросов для проверки обезличивания.
 *
 * Каждый пример — реплики пользователя и список того, что НЕ должно уйти
 * во внешнюю модель (имена в той форме, в какой их написал человек,
 * цифры телефона и документов, адрес с номером дома, слова диагнозов).
 * Обычные запросы без персональных данных помечены benign: по ним
 * считается, сколько нормальных вопросов система зря не отправила модели
 * или испортила лишними заменами.
 *
 * Набор детерминирован (seed): цифры одного прогона можно сравнивать с
 * цифрами другого. Шаблоны и имена делятся на «обучение» и «проверку»,
 * чтобы обучаемый детектор (ner.js) оценивался на том, чего не видел.
 */

import { AMBIGUOUS_NAMES, DIMINUTIVES, FEMALE_NAMES, MALE_NAMES, SURNAMES } from './names.js';
import { CASES, declineFirstName, declinePatronymic, declineSurname, patronymicOf, toLatin } from './declension.js';

/** Детерминированный генератор случайных чисел (mulberry32). */
export const createRandom = (seed = 1) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max) => Math.floor(next() * max);
  const pick = (list) => list[int(list.length)];
  const chance = (probability) => next() < probability;
  return { next, int, pick, chance };
};

/** Стабильный хэш строки: делит имена и шаблоны на обучение и проверку. */
const hashOf = (value) => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
};
export const splitOf = (value) => (hashOf(value) % 3 === 0 ? 'test' : 'train');

const KIN = {
  мама: { gender: 'f', forms: ['мама', 'мамы', 'маме', 'маму', 'мамой'] },
  папа: { gender: 'm', forms: ['папа', 'папы', 'папе', 'папу', 'папой'] },
  сын: { gender: 'm', forms: ['сын', 'сына', 'сыну', 'сына', 'сыном'] },
  дочь: { gender: 'f', forms: ['дочь', 'дочери', 'дочери', 'дочь', 'дочерью'] },
  дочка: { gender: 'f', forms: ['дочка', 'дочки', 'дочке', 'дочку', 'дочкой'] },
  муж: { gender: 'm', forms: ['муж', 'мужа', 'мужу', 'мужа', 'мужем'] },
  жена: { gender: 'f', forms: ['жена', 'жены', 'жене', 'жену', 'женой'] },
  бабушка: { gender: 'f', forms: ['бабушка', 'бабушки', 'бабушке', 'бабушку', 'бабушкой'] },
  дедушка: { gender: 'm', forms: ['дедушка', 'дедушки', 'дедушке', 'дедушку', 'дедушкой'] },
  брат: { gender: 'm', forms: ['брат', 'брата', 'брату', 'брата', 'братом'] },
  сестра: { gender: 'f', forms: ['сестра', 'сестры', 'сестре', 'сестру', 'сестрой'] },
  внук: { gender: 'm', forms: ['внук', 'внука', 'внуку', 'внука', 'внуком'] },
  внучка: { gender: 'f', forms: ['внучка', 'внучки', 'внучке', 'внучку', 'внучкой'] },
  тёща: { gender: 'f', forms: ['тёща', 'тёщи', 'тёще', 'тёщу', 'тёщей'] },
  свекровь: { gender: 'f', forms: ['свекровь', 'свекрови', 'свекрови', 'свекровь', 'свекровью'] },
};

const SPECIALTIES = [
  ['терапевт', 'терапевта', 'терапевту', 'терапевта', 'терапевтом'],
  ['педиатр', 'педиатра', 'педиатру', 'педиатра', 'педиатром'],
  ['кардиолог', 'кардиолога', 'кардиологу', 'кардиолога', 'кардиологом'],
  ['невролог', 'невролога', 'неврологу', 'невролога', 'неврологом'],
  ['стоматолог', 'стоматолога', 'стоматологу', 'стоматолога', 'стоматологом'],
  ['лор', 'лора', 'лору', 'лора', 'лором'],
  ['окулист', 'окулиста', 'окулисту', 'окулиста', 'окулистом'],
  ['гинеколог', 'гинеколога', 'гинекологу', 'гинеколога', 'гинекологом'],
  ['уролог', 'уролога', 'урологу', 'уролога', 'урологом'],
  ['эндокринолог', 'эндокринолога', 'эндокринологу', 'эндокринолога', 'эндокринологом'],
  ['хирург', 'хирурга', 'хирургу', 'хирурга', 'хирургом'],
  ['дерматолог', 'дерматолога', 'дерматологу', 'дерматолога', 'дерматологом'],
  ['травматолог', 'травматолога', 'травматологу', 'травматолога', 'травматологом'],
  ['ортопед', 'ортопеда', 'ортопеду', 'ортопеда', 'ортопедом'],
];

const SPECIALTY_CODES = [
  'therapist', 'pediatrician', 'cardiologist', 'neurologist', 'dentist', 'lor', 'ophthalmologist', 'gynecologist',
  'urologist', 'endocrinologist', 'surgeon', 'dermatologist', 'traumatologist', 'orthopedist',
];

const TIMES = ['', 'после 18:00', 'вечером', 'завтра утром', 'в субботу', 'сегодня', 'после работы', 'на выходных', 'до обеда', 'к 9 утра'];
const PLACES = ['', 'рядом', 'поближе к дому', 'в Вахитовском районе', 'в Советском районе', 'недалеко', 'в Приволжском районе', 'у метро Козья слобода', 'рядом с Баумана', 'в Ново-Савиновском районе'];

const STREETS = [
  ['ул.', 'Баумана'], ['улица', 'Пушкина'], ['ул', 'Островского'], ['ул.', 'Чистопольская'], ['проспект', 'Амирхана'],
  ['ул.', 'Ямашева'], ['пр.', 'Победы'], ['улица', 'Декабристов'], ['ул.', 'Гагарина'], ['ул.', 'Абсалямова'],
  ['улица', 'Хади Такташа'], ['ул.', 'Карла Маркса'], ['ул.', 'Кул Гали'], ['ул.', 'Мавлютова'], ['улица', 'Сахарова'],
  ['ул.', 'Юлиуса Фучика'], ['ул.', 'Дубравная'], ['ул.', 'Минская'], ['ул.', 'Сибгата Хакима'], ['ул.', 'Бутлерова'],
  ['улица', 'Тукая'], ['ул.', 'Горького'], ['ул.', 'Достоевского'], ['ул.', 'Николая Ершова'], ['ул.', 'Глушко'],
  ['ул.', 'Рихарда Зорге'], ['ул.', 'Маршала Чуйкова'], ['ул.', 'Короленко'], ['ул.', 'Восстания'], ['ул.', 'Вишневского'],
];

const NUMBER_WORDS = ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'двенадцать', 'пятнадцать', 'двадцать', 'сорок четыре', 'сто'];
const DIGIT_WORDS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const DIAGNOSES = [
  { text: 'у меня ВИЧ', words: ['вич'], specialty: 'инфекциониста' },
  { text: 'диабет второго типа', words: ['диабет'], specialty: 'эндокринолога' },
  { text: 'после химиотерапии', words: ['химиотерапии'], specialty: 'терапевта' },
  { text: 'у брата шизофрения', words: ['шизофрения'], specialty: 'психиатра' },
  { text: 'беременность 12 недель', words: ['беременность'], specialty: 'гинеколога' },
  { text: 'гепатит С', words: ['гепатит'], specialty: 'гастроэнтеролога' },
  { text: 'рак груди в ремиссии', words: ['рак'], specialty: 'онколога' },
  { text: 'депрессия и панические атаки', words: ['депрессия', 'панические'], specialty: 'психиатра' },
  { text: 'сифилис', words: ['сифилис'], specialty: 'дерматолога' },
  { text: 'алкогольная зависимость у мужа', words: ['алкогольная', 'зависимость'], specialty: 'нарколога' },
  { text: 'туберкулёз в анамнезе', words: ['туберкулез'], specialty: 'терапевта' },
  { text: 'бесплодие', words: ['бесплодие'], specialty: 'гинеколога' },
];

const pools = (byOrigin) =>
  Object.entries(byOrigin).flatMap(([origin, list]) => list.map((name) => ({ name, origin })));

const MALE = pools(MALE_NAMES).map((item) => ({ ...item, gender: 'm' }));
const FEMALE = pools(FEMALE_NAMES).map((item) => ({ ...item, gender: 'f' }));
const SURNAME_POOL = Object.entries(SURNAMES).flatMap(([origin, list]) =>
  list.map((name) => ({ name, origin: origin === 'ski' || origin === 'invariable' ? 'russian' : origin })));

/**
 * Шаблоны персон. Плейсхолдеры:
 *   {K.case}        родственник в падеже;
 *   {P.case.fmt}    человек (родственник / сам пользователь / врач не из справочника);
 *   {SP.case}       специальность; {T} время; {L} место.
 * fmt: first — имя; fi — имя фамилия; if — фамилия имя; full — ФИО; sur — фамилия;
 *      io — имя отчество; sio — фамилия И. О.
 * Два набора шаблонов — для обучения детектора и для проверки.
 */
const RELATIVE_TEMPLATES = {
  train: [
    'запишите {K.acc} {P.acc.first} к {SP.dat} {T}',
    'нужен {SP.nom} для {K.gen} {P.gen.fi} {L}',
    '{K.dat} {P.dat.first} нужен {SP.nom} {T}',
    'найдите {SP.acc} {K.dat} {P.dat.io} {L}',
    'у {K.gen} {P.gen.first} болит горло, нужен {SP.nom}',
    'хочу записать {K.acc} {P.acc.full} к {SP.dat}',
    'подскажите {SP.acc} для {K.gen} {P.gen.sur} {T}',
    'мы с {K.ins} {P.ins.first} ищем {SP.acc} {L}',
    '{K.nom} {P.nom.fi} хочет к {SP.dat} {T}',
    'запись {K.gen} {P.gen.if} к {SP.dat}',
    'пациент {P.nom.full}, {K.nom}, нужен {SP.nom}',
    'для {K.gen} {P.gen.first} {P.gen.sur} нужен {SP.nom} {L}',
  ],
  test: [
    'можно {K.acc} {P.acc.first} записать к {SP.dat} {T}?',
    '{K.nom} у меня {P.nom.first}, ей/ему нужен {SP.nom} {L}',
    'ищу {SP.acc} {L} для {K.gen} — {P.nom.fi}',
    'запишите пожалуйста {K.acc} {P.acc.if} на приём к {SP.dat}',
    'помогите найти {SP.acc} {K.dat} {P.dat.first} {T}',
    'надо {P.acc.first} {K.acc} показать {SP.dat} {L}',
    '{K.nom} {P.nom.full} — запись к {SP.dat} {T}',
    'записать {K.acc} {P.acc.sio} к {SP.dat}',
    'с {K.ins} {P.ins.fi} хотим к {SP.dat} {L}',
    'за {K.acc} {P.acc.first} {P.acc.sur} спрашиваю, нужен {SP.nom}',
  ],
};

const SELF_TEMPLATES = {
  train: [
    'меня зовут {P.nom.first}, нужен {SP.nom} {L}',
    'я {P.nom.fi}, запишите к {SP.dat} {T}',
    'это {P.nom.first} {P.nom.sur}, ищу {SP.acc}',
    'здравствуйте, {P.nom.full}, нужен {SP.nom} {T}',
    'запишите меня, {P.acc.fi}, к {SP.dat}',
    'фамилия {P.nom.sur}, нужен {SP.nom} {L}',
  ],
  test: [
    'добрый день, меня зовут {P.nom.fi}, ищу {SP.acc} {L}',
    'я {P.nom.first}, мне нужен {SP.nom} {T}',
    'пишет {P.nom.full}, запишите к {SP.dat}',
    'на имя {P.gen.fi} запись к {SP.dat} {T}',
    'фио: {P.nom.full}. нужен {SP.nom}',
  ],
};

const DOCTOR_TEMPLATES = {
  train: [
    'запишите к врачу {P.dat.sur} {T}',
    'хочу к доктору {P.dat.fi} {L}',
    'где принимает {SP.nom} {P.nom.full}?',
    'маршрут к {SP.dat} {P.dat.sur}',
  ],
  test: [
    'ищу врача {P.acc.sio}, {SP.acc}',
    'к {SP.dat} {P.dat.if} можно попасть {T}?',
    'принимает ли сейчас доктор {P.nom.sur}',
    'нужен {SP.nom} {P.nom.full}, где он работает',
  ],
};

const surnameFor = (random, split) => {
  for (;;) {
    const candidate = random.pick(SURNAME_POOL);
    if (splitOf(candidate.name) === split || split === 'any') return candidate;
  }
};

const nameFor = (random, split, gender) => {
  const pool = gender === 'f' ? FEMALE : MALE;
  for (;;) {
    const candidate = random.pick(pool);
    if (splitOf(candidate.name) === split || split === 'any') return candidate;
  }
};

/** Человек: имя, фамилия, отчество и происхождение имени. */
const makePerson = (random, split, gender) => {
  const first = nameFor(random, split, gender);
  const surname = surnameFor(random, split);
  const father = nameFor(random, 'any', 'm');
  return { gender, first: first.name, origin: first.origin, surname: surname.name, surnameOrigin: surname.origin, patronymic: patronymicOf(father.name, gender) };
};

const initial = (word) => `${word[0].toUpperCase()}.`;

/** Части имени человека в падеже и формате. */
const personParts = (person, grammaticalCase, fmt) => {
  const first = declineFirstName(person.first, person.gender, grammaticalCase);
  const sur = declineSurname(person.surname, person.gender, grammaticalCase);
  const pat = declinePatronymic(person.patronymic, grammaticalCase);
  switch (fmt) {
    case 'first': return [first];
    case 'fi': return [first, sur];
    case 'if': return [sur, first];
    case 'full': return [sur, first, pat];
    case 'io': return [first, pat];
    case 'sur': return [sur];
    case 'sio': return [sur, `${initial(person.first)}${initial(person.patronymic)}`];
    default: return [first];
  }
};

/* Опечатка: перестановка или пропуск буквы внутри слова длиннее 4 букв. */
const typo = (random, word) => {
  if (word.length < 5) return word;
  const index = 1 + random.int(word.length - 3);
  return random.chance(0.5)
    ? word.slice(0, index) + word[index + 1] + word[index] + word.slice(index + 2)
    : word.slice(0, index) + word.slice(index + 1);
};

const VARIANTS = [['normal', 0.45], ['lower', 0.3], ['typo', 0.1], ['latin', 0.07], ['upper', 0.08]];
const pickVariant = (random) => {
  let roll = random.next();
  for (const [name, weight] of VARIANTS) {
    roll -= weight;
    if (roll <= 0) return name;
  }
  return 'normal';
};

const applyVariant = (random, variant, word) => {
  if (/^\p{Lu}\.\p{Lu}\.$/u.test(word)) return variant === 'lower' ? word.toLowerCase() : word;
  switch (variant) {
    case 'lower': return word.toLowerCase();
    case 'upper': return word.toUpperCase();
    case 'typo': return typo(random, word);
    case 'latin': return toLatin(word);
    default: return word;
  }
};

const capitalizeFirst = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const tidy = (text) => text.replace(/\s+([,.?!])/g, '$1').replace(/\s{2,}/g, ' ').replace(/,\s*$/u, '').trim();

/** Заполняет шаблон персоны. */
const fillPersonTemplate = (random, template, { person, kin, variant }) => {
  const sensitive = [];
  let text = template.replace(/\{(K|P|SP)\.(\w+)(?:\.(\w+))?\}/g, (_, slot, grammaticalCase, fmt) => {
    const index = CASES.indexOf(grammaticalCase);
    if (slot === 'K') return KIN[kin].forms[index];
    if (slot === 'SP') return random.pick(SPECIALTIES)[index];
    const words = personParts(person, grammaticalCase, fmt).map((word) => applyVariant(random, variant, word));
    for (const word of words) {
      if (!/^\p{L}\.\p{L}\.$/u.test(word)) sensitive.push({ kind: 'PERSON', value: word });
    }
    return words.join(' ');
  });
  text = text.replace('{T}', random.pick(TIMES)).replace('{L}', random.pick(PLACES));
  text = text.replace('ей/ему', person.gender === 'f' ? 'ей' : 'ему');
  text = tidy(text);
  if (variant === 'upper') text = text.toUpperCase();
  return { text: random.chance(0.4) ? capitalizeFirst(text) : text, sensitive };
};

const kinFor = (random, gender) => {
  const options = Object.entries(KIN).filter(([, value]) => !gender || value.gender === gender).map(([key]) => key);
  return random.pick(options);
};

const sample = (fields) => ({ benign: false, messages: [], sensitive: [], ...fields });

/* ---------- Прочие персональные данные ---------- */

const phoneDigits = (random) => `9${random.int(10)}${random.int(10)}${String(1_000_000 + random.int(9_000_000)).slice(0, 7)}`;
const formatPhone = (random, digits) => {
  const [a, b, c, d] = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 8), digits.slice(8, 10)];
  return random.pick([
    `+7 ${a} ${b}-${c}-${d}`, `8${digits}`, `+7${digits}`, `8 (${a}) ${b}-${c}-${d}`, `8-${a}-${b}-${c}-${d}`,
    `${a}-${b}-${c}-${d}`, `8 ${a} ${b} ${c} ${d}`, `+7 (${a}) ${b} ${c} ${d}`, `8.${a}.${b}.${c}.${d}`,
    `8 ${[...digits].join(' ')}`,
  ]);
};
const phoneInWords = (digits) => `восемь ${[...digits].map((digit) => DIGIT_WORDS[Number(digit)]).join(' ')}`;

const PHONE_TEMPLATES = {
  train: ['перезвоните мне {X}', 'мой номер {X}, нужен {SP}', 'телефон для связи {X}', 'позвоните по номеру {X} пожалуйста'],
  test: ['можно записаться? номер {X}', 'тел {X}, запишите к {SPD}', 'свяжитесь со мной: {X}', 'наберите {X} после 18:00'],
};

const emailOf = (random, person) => {
  const local = toLatin(random.pick([
    `${person.first}.${person.surname}`, `${person.surname}${random.int(99)}`, `${person.first[0]}.${person.surname}`,
  ])).toLowerCase().replace(/[^a-z0-9._]/g, '');
  const domain = random.pick(['mail.ru', 'yandex.ru', 'gmail.com', 'bk.ru', 'inbox.ru', 'list.ru']);
  const [name, zone] = domain.split('.');
  return {
    local,
    text: random.pick([
      `${local}@${domain}`, `${local} собака ${name} точка ${zone}`, `${local}(at)${name}(dot)${zone}`,
      `${local} [at] ${name} [dot] ${zone}`, `${local} at ${name} dot ${zone}`,
    ]),
  };
};

const snils = (random) => {
  const digits = Array.from({ length: 9 }, () => random.int(10));
  let sum = digits.reduce((total, digit, index) => total + digit * (9 - index), 0);
  if (sum > 101) sum %= 101;
  const control = sum === 100 || sum === 101 ? '00' : String(sum).padStart(2, '0');
  const text = digits.join('');
  return { digits: text + control, text: `${text.slice(0, 3)}-${text.slice(3, 6)}-${text.slice(6, 9)} ${control}` };
};

const addressOf = (random) => {
  const [kind, street] = random.pick(STREETS);
  const house = String(1 + random.int(140));
  const letter = random.chance(0.15) ? random.pick(['а', 'б', 'в']) : '';
  const flat = String(1 + random.int(300));
  const style = random.int(6);
  const parts = { street, house: `${house}${letter}`, flat };
  const text = [
    `${kind} ${street}, д. ${house}${letter}, кв. ${flat}`,
    `${street} ${house}${letter}-${flat}`,
    `${kind} ${street} ${house}${letter} квартира ${flat}`,
    `${street}, дом ${house}${letter}`,
    `${street} ${house}${letter}`,
    `${kind} ${street} дом ${random.pick(NUMBER_WORDS)}`,
  ][style];
  const sensitive = style === 5
    ? [{ kind: 'ADDRESS', value: text.split(' дом ')[1], near: street }]
    : [{ kind: 'ADDRESS', value: `${house}${letter}`, near: street }, ...(style <= 2 ? [{ kind: 'ADDRESS', value: flat, near: 'кв' }] : [])];
  return { text, sensitive, parts };
};

const ADDRESS_TEMPLATES = {
  train: ['я живу {X}, нужен {SP} рядом', 'от дома {X} до {SPG}', 'постройте маршрут с {X} к {SPD}', 'мой адрес {X}'],
  test: ['живу на {X}, ищу {SPA} поблизости', 'маршрут от {X} до ближайшего {SPG}', 'адрес: {X}. нужен {SP}', 'забрать с {X} и отвезти к {SPD}'],
};

const dobOf = (random) => {
  const day = 1 + random.int(28);
  const month = 1 + random.int(12);
  const year = 1940 + random.int(70);
  const dd = String(day).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  return random.pick([
    { text: `${dd}.${mm}.${year}`, digits: `${dd}${mm}${year}` },
    { text: `${day} ${MONTHS[month - 1]} ${year}`, digits: `${year}`, words: `${day} ${MONTHS[month - 1]} ${year}` },
    { text: `${year}-${mm}-${dd}`, digits: `${year}${mm}${dd}` },
    { text: `${dd}/${mm}/${year}`, digits: `${dd}${mm}${year}` },
  ]);
};

const DOCUMENT_TEMPLATES = {
  train: ['мой снилс {SNILS}, нужен {SP}', 'полис омс {OMS}, запишите к {SPD}', 'паспорт {PASS}', 'дата рождения {DOB}, нужен {SP}'],
  test: ['снилс: {SNILS}', 'номер полиса {OMS} — куда можно бесплатно к {SPD}', 'серия и номер паспорта {PASS}, нужен {SP}', 'родилась {DOB}, ищу {SPA}'],
};

const BENIGN_TEMPLATES = {
  train: [
    'нужен {SP} {L} {T}', 'покажи {SPA} {L}', 'где принимает {SP} {T}', 'запишите к {SPD} {T}', 'найди {SPA} с хорошим рейтингом',
    'ближайший {SP} {T}', 'нужен детский {SP} {L}', 'платный {SP} недорого', 'постройте маршрут до {SPG}',
    '{SP} по омс {L}', 'для мамы нужен {SP} {T}', 'сыну нужен {SP}', 'кто принимает {T}?',
  ],
  test: [
    'подскажите {SPA} {L}', 'есть {SP} {T}?', 'хочу к {SPD} {L} {T}', 'нужна консультация {SPG} {T}',
    'какой {SP} работает {T}', 'мужу нужен {SP} {L}', 'запишите дочку к {SPD}', 'любой {SP} {L} подойдёт',
    'стоматология в Вахитовском районе', 'детская поликлиника рядом', 'где сделать МРТ ночью', 'травмпункт рядом',
    'кардиолог с рейтингом выше 4.5', '{SP} до 2000 рублей', 'нужен {SP} по ДМС {L}', 'есть надежда попасть к {SPD} {T}?',
    'маршрут до РКБ', 'как доехать до ДРКБ на автобусе', 'анализ крови рядом утром', '{SP} в поликлинике 21',
  ],
};

const specialtyForms = (random) => {
  const forms = random.pick(SPECIALTIES);
  return { SP: forms[0], SPG: forms[1], SPD: forms[2], SPA: forms[3] };
};

const fillSimple = (random, template, values) => {
  const specialty = specialtyForms(random);
  return tidy(template
    .replace(/\{(SPG|SPD|SPA|SP)\}/g, (_, key) => specialty[key])
    .replace('{T}', random.pick(TIMES))
    .replace('{L}', random.pick(PLACES))
    .replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match));
};

/**
 * Генерирует набор.
 *
 * @param {object} options
 * @param {'train'|'test'} options.split
 * @param {number} [options.seed]
 * @param {number} [options.scale] множитель размера
 * @param {{name: string, specialty: string}[]} [options.catalogDoctors] врачи справочника
 */
export const generateDataset = ({ split = 'test', seed = 7, scale = 1, catalogDoctors = [] } = {}) => {
  const random = createRandom(seed + (split === 'test' ? 1000 : 0));
  const samples = [];
  const add = (fields) => samples.push(sample({ id: `${split}-${samples.length + 1}`, split, ...fields }));
  const count = (base) => Math.round(base * scale);
  const catalogSurnames = new Set(catalogDoctors.map((doctor) => doctor.name.split(' ')[0].toLowerCase()));

  // Родственники.
  for (let i = 0; i < count(2400); i += 1) {
    const kin = kinFor(random);
    const person = makePerson(random, split, KIN[kin].gender);
    const variant = pickVariant(random);
    const { text, sensitive } = fillPersonTemplate(random, random.pick(RELATIVE_TEMPLATES[split]), { person, kin, variant });
    add({ category: 'relative', origin: person.origin, variant, person, messages: [text], sensitive });
  }

  // Сам пользователь.
  for (let i = 0; i < count(900); i += 1) {
    const person = makePerson(random, split, random.chance(0.5) ? 'f' : 'm');
    const variant = pickVariant(random);
    const { text, sensitive } = fillPersonTemplate(random, random.pick(SELF_TEMPLATES[split]), { person, kin: 'мама', variant });
    add({ category: 'self', origin: person.origin, variant, person, messages: [text], sensitive });
  }

  // Врач, которого нет в справочнике: имя всё равно не должно уйти.
  for (let i = 0; i < count(600); i += 1) {
    let person;
    do person = makePerson(random, split, random.chance(0.5) ? 'f' : 'm');
    while (catalogSurnames.has(person.surname.toLowerCase()));
    const variant = pickVariant(random);
    const { text, sensitive } = fillPersonTemplate(random, random.pick(DOCTOR_TEMPLATES[split]), { person, kin: 'мама', variant });
    add({ category: 'unknown_doctor', origin: person.origin, variant, person, messages: [text], sensitive });
  }

  // Имя, разнесённое по двум репликам.
  for (let i = 0; i < count(300); i += 1) {
    const kin = kinFor(random);
    const person = makePerson(random, split, KIN[kin].gender);
    const variant = pickVariant(random);
    const name = applyVariant(random, variant, person.first);
    const specialty = random.pick(SPECIALTIES);
    const first = tidy(`нужен ${specialty[0]} для ${KIN[kin].forms[1]} ${random.pick(PLACES)}`);
    const second = random.pick([`${KIN[kin].forms[0]} зовут ${name}`, `её/его зовут ${name}`, `имя ${name}`, `это ${name}`])
      .replace('её/его', KIN[kin].gender === 'f' ? 'её' : 'его');
    add({ category: 'multi_turn', origin: person.origin, variant, person, messages: [first, second], sensitive: [{ kind: 'PERSON', value: name }] });
  }

  // Уменьшительные имена: «запишите Сашу», «Гулечке нужен педиатр».
  for (let i = 0; i < count(400); i += 1) {
    const { forms, gender } = random.pick(DIMINUTIVES);
    const kin = kinFor(random, gender);
    const variant = random.chance(0.4) ? 'lower' : 'normal';
    const [nom, gen, dat, acc] = forms.map((form) => applyVariant(random, variant, form));
    const specialty = random.pick(SPECIALTIES);
    const [text, value] = random.pick([
      [`запишите ${KIN[kin].forms[3]} ${acc} к ${specialty[2]}`, acc],
      [`${dat} нужен ${specialty[0]} ${random.pick(TIMES)}`, dat],
      [`для ${gen} ищу ${specialty[3]} ${random.pick(PLACES)}`, gen],
      [`${KIN[kin].forms[0]} ${nom} хочет к ${specialty[2]}`, nom],
      [`${acc} надо показать ${specialty[2]}`, acc],
    ]);
    add({ category: 'diminutive', origin: 'russian', variant, messages: [capitalizeFirst(tidy(text))], sensitive: [{ kind: 'PERSON', value }] });
  }

  // Многозначные имена рядом с родственником и обычные слова-омонимы.
  for (let i = 0; i < count(200); i += 1) {
    const { name, gender } = random.pick(AMBIGUOUS_NAMES);
    const kin = kinFor(random, gender);
    const formAcc = declineFirstName(name, gender, 'acc');
    const surname = declineSurname(surnameFor(random, 'any').name, gender, 'acc');
    const text = random.pick([
      `запишите ${KIN[kin].forms[3]} ${formAcc} к ${random.pick(SPECIALTIES)[2]}`,
      `${KIN[kin].forms[3]} ${formAcc} ${surname} к ${random.pick(SPECIALTIES)[2]}`,
    ]);
    const sensitive = [{ kind: 'PERSON', value: formAcc }, ...(text.includes(surname) ? [{ kind: 'PERSON', value: surname }] : [])];
    add({ category: 'ambiguous_name', origin: 'russian', variant: 'normal', messages: [text], sensitive });
  }

  // Телефоны.
  for (let i = 0; i < count(500); i += 1) {
    const digits = phoneDigits(random);
    const inWords = random.chance(0.12);
    const value = inWords ? phoneInWords(digits) : formatPhone(random, digits);
    const text = fillSimple(random, random.pick(PHONE_TEMPLATES[split]), { X: value });
    add({ category: 'phone', messages: [text], sensitive: [{ kind: inWords ? 'PHONE_WORDS' : 'PHONE', value: inWords ? value : `${digits}` }] });
  }

  // Почта.
  for (let i = 0; i < count(250); i += 1) {
    const person = makePerson(random, split, random.chance(0.5) ? 'f' : 'm');
    const email = emailOf(random, person);
    const text = fillSimple(random, random.pick(['пишите на {X}', 'моя почта {X}, нужен {SP}', 'ответ пришлите на {X}', 'почта: {X}']), { X: email.text });
    add({ category: 'email', messages: [text], sensitive: [{ kind: 'EMAIL', value: email.local }] });
  }

  // Адреса.
  for (let i = 0; i < count(500); i += 1) {
    const address = addressOf(random);
    const text = fillSimple(random, random.pick(ADDRESS_TEMPLATES[split]), { X: address.text });
    add({ category: 'address', messages: [text], sensitive: address.sensitive });
  }

  // Документы и дата рождения.
  for (let i = 0; i < count(400); i += 1) {
    const template = random.pick(DOCUMENT_TEMPLATES[split]);
    const values = {};
    const sensitive = [];
    if (template.includes('{SNILS}')) {
      const value = snils(random);
      values.SNILS = value.text;
      sensitive.push({ kind: 'DOCUMENT', value: value.digits });
    }
    if (template.includes('{OMS}')) {
      const digits = Array.from({ length: 16 }, () => random.int(10)).join('');
      values.OMS = random.chance(0.5) ? digits : digits.replace(/(\d{4})(?=\d)/g, '$1 ');
      sensitive.push({ kind: 'DOCUMENT', value: digits });
    }
    if (template.includes('{PASS}')) {
      const series = String(1000 + random.int(9000));
      const number = String(100000 + random.int(900000));
      values.PASS = random.pick([`${series} ${number}`, `${series.slice(0, 2)} ${series.slice(2)} ${number}`, `серия ${series} номер ${number}`]);
      sensitive.push({ kind: 'DOCUMENT', value: series + number });
    }
    if (template.includes('{DOB}')) {
      const dob = dobOf(random);
      values.DOB = dob.text;
      sensitive.push(dob.words ? { kind: 'DOB_WORDS', value: dob.words } : { kind: 'DOB', value: dob.digits });
    }
    add({ category: 'document', messages: [fillSimple(random, template, values)], sensitive });
  }

  // Диагнозы.
  for (let i = 0; i < count(300); i += 1) {
    const diagnosis = random.pick(DIAGNOSES);
    const text = random.pick([
      `${diagnosis.text}, нужен специалист ${random.pick(PLACES)}`, `${diagnosis.text} — к какому врачу идти`,
      `ищу ${diagnosis.specialty}, ${diagnosis.text}`, `${diagnosis.text}, подскажите врача ${random.pick(TIMES)}`,
    ]);
    add({ category: 'medical', messages: [tidy(text)], sensitive: diagnosis.words.map((word) => ({ kind: 'MEDICAL', value: word })) });
  }

  // Всё сразу: имя, телефон, адрес.
  for (let i = 0; i < count(300); i += 1) {
    const kin = kinFor(random);
    const person = makePerson(random, split, KIN[kin].gender);
    const variant = pickVariant(random);
    const name = personParts(person, 'acc', random.pick(['first', 'fi', 'full'])).map((word) => applyVariant(random, variant, word));
    const digits = phoneDigits(random);
    const address = addressOf(random);
    const specialty = random.pick(SPECIALTIES);
    const text = tidy(`запишите ${KIN[kin].forms[3]} ${name.join(' ')} к ${specialty[2]}, мы на ${address.text}, телефон ${formatPhone(random, digits)}`);
    add({
      category: 'combined',
      origin: person.origin,
      variant,
      person,
      messages: [text],
      sensitive: [...name.filter((word) => word.length > 2).map((value) => ({ kind: 'PERSON', value })), { kind: 'PHONE', value: digits }, ...address.sensitive],
    });
  }

  // Врачи справочника: фамилия должна уйти меткой, а не текстом (не персональные данные, но проверяем разбор).
  for (let i = 0; i < count(300) && catalogDoctors.length > 0; i += 1) {
    const doctor = random.pick(catalogDoctors);
    const [surname, first] = doctor.name.split(' ');
    const gender = /[ая]$/u.test(first || '') ? 'f' : 'm';
    const variant = random.chance(0.3) ? 'lower' : 'normal';
    const dative = applyVariant(random, variant, declineSurname(surname, gender, 'dat'));
    const text = random.pick([`запишите к врачу ${dative}`, `маршрут к доктору ${dative}`, `хочу к ${dative} ${random.pick(TIMES)}`]);
    add({ category: 'catalog_doctor', variant, messages: [tidy(text)], sensitive: [{ kind: 'CATALOG_DOCTOR', value: dative }] });
  }

  // Обычные запросы без персональных данных.
  for (let i = 0; i < count(1500); i += 1) {
    add({ category: 'benign', benign: true, messages: [fillSimple(random, random.pick(BENIGN_TEMPLATES[split]), {})], sensitive: [] });
  }

  // Обычные запросы «как в жизни»: опечатки, сленг, лекарства, торговые центры.
  for (let i = 0; i < count(800); i += 1) {
    const [code, variants] = random.pick(Object.entries(NOISY_SPECIALTIES));
    const specialty = random.pick(variants);
    const template = random.pick(NOISY_TEMPLATES[split]);
    const text = tidy(template
      .replace('{S}', specialty)
      .replace('{F}', random.pick(FILLERS))
      .replace('{T}', random.pick(TIMES))
      .replace('{L}', random.pick(NOISY_PLACES))
      .replace('{D}', random.pick(DRUGS)));
    add({ category: 'benign_noisy', benign: true, messages: [text], sensitive: [], fixedExpect: { specialty: code } });
  }

  addStructureSamples({ split, seed, count, add, catalogDoctors });

  for (const item of samples) item.expect = { ...inferExpect(item.messages.join(' ')), ...(item.fixedExpect || {}) };
  return samples;
};

/*
 * Группы, проверяющие смысл, который описание вместо текста может потерять:
 * порядок шагов маршрута, улицу, стаж и сортировку, травмпункт; и короткие
 * реплики без запроса («привет»), которые модели отправлять незачем.
 * Свой генератор случайных чисел: добавление групп не меняет примеры старых.
 */
const SEQUENCE_WORDS = {
  train: [['сначала', 'потом', 'а потом'], ['сперва', 'затем', 'и в конце'], ['сначала', 'после этого', 'потом']],
  test: [['сначала', 'затем', 'а потом'], ['сперва', 'потом', 'а после'], ['для начала', 'потом', 'а в конце']],
};
const SEQUENCE_ENDS = [['домой', '@HOME'], ['на работу', '@WORK'], ['', null]];
const STREET_MENTIONS = [
  ['на Баумана', 'бауман'], ['на Ямашева', 'ямашев'], ['на Чистопольской', 'чистопольск'], ['на Декабристов', 'декабрист'],
  ['на Мусы Джалиля', 'джалил'], ['на Хади Такташа', 'такташ'], ['на Фучика', 'фучик'], ['на Пушкина', 'пушкин'],
  ['на Гагарина', 'гагарин'], ['на Абсалямова', 'абсалямов'], ['на Дубравной', 'дубравн'], ['на Минской', 'минск'],
  ['на проспекте Победы', 'побед'], ['на Карла Маркса', 'маркс'], ['на Островского', 'островск'], ['на Бутлерова', 'бутлеров'],
  ['на Ершова', 'ершов'], ['на Космонавтов', 'космонавт'], ['рядом с Баумана', 'бауман'], ['возле Ямашева', 'ямашев'],
  ['на Сибирском тракте', 'сибирск'], ['на Амирхана', 'амирхан'], ['на Восстания', 'восстани'], ['на Адоратского', 'адоратск'],
];
const STREET_TEMPLATES = {
  train: ['{SP} {STREET}', 'нужен {SP} {STREET} {T}', 'клиника {STREET}', 'где {SP} {STREET}'],
  test: ['ищу {SPA} {STREET}', 'есть {SP} {STREET}?', 'поликлиника {STREET} {T}', 'хочу к {SPD} {STREET}'],
};
const FILTER_TEMPLATES = {
  train: [
    ['{SP} с опытом больше {N} лет', { experience: true }], ['{SP} стаж от {N} лет {T}', { experience: true }],
    ['покажи {SPA} по рейтингу', { sort: 'rating' }], ['{SP} {L}, отсортируй по стажу', { sort: 'experience' }],
    ['ближайший травмпункт', { specialty: 'traumatologist' }], ['травмпункт {T}', { specialty: 'traumatologist' }],
  ],
  test: [
    ['нужен {SP} с опытом от {N} лет', { experience: true }], ['{SP} со стажем не менее {N} лет', { experience: true }],
    ['{SP} {T} по рейтингу', { sort: 'rating' }], ['найди {SPA} и отсортируй по стажу', { sort: 'experience' }],
    ['где травмпункт рядом', { specialty: 'traumatologist' }], ['травмпункт {L} {T}', { specialty: 'traumatologist' }],
  ],
};
const SMALLTALK = {
  train: ['привет', 'спасибо', 'ок', 'добрый день', '...', 'ясно', 'а ты кто', 'понятно спасибо', 'хорошо', 'ага'],
  test: ['здравствуйте', 'спасибо большое', 'ладно', '?????', 'как дела', 'ты бот?', 'ок понял', 'супер', '👍', 'пока'],
};

const addStructureSamples = ({ split, seed, count, add, catalogDoctors }) => {
  const random = createRandom(seed + 5000 + (split === 'test' ? 1000 : 0));
  const specialtyOf = () => {
    const index = random.int(SPECIALTIES.length);
    return { forms: SPECIALTIES[index], code: SPECIALTY_CODES[index] };
  };

  // Маршрут из нескольких шагов: порядок должен дойти до модели.
  for (let i = 0; i < count(600); i += 1) {
    const [first, second, third] = random.pick(SEQUENCE_WORDS[split]);
    const a = specialtyOf();
    let b = specialtyOf();
    while (b.code === a.code) b = specialtyOf();
    const [endText, endToken] = random.pick(SEQUENCE_ENDS);
    const time = random.pick(['', 'после 18:00', 'вечером']);
    const kind = random.int(3);
    const order = [];
    let text;
    let sensitive = [];
    let benign = true;
    if (kind === 0 || catalogDoctors.length === 0) {
      text = `построй маршрут: ${first} к ${a.forms[2]}, ${second} к ${b.forms[2]} ${time}`;
      order.push(a.code, b.code);
    } else if (kind === 1) {
      const doctor = random.pick(catalogDoctors);
      const [surname, name] = doctor.name.split(' ');
      const dative = declineSurname(surname, /[ая]$/u.test(name || '') ? 'f' : 'm', 'dat');
      text = `${first} к доктору ${dative}, ${second} к ${b.forms[2]} ${time}`;
      order.push('@DOCTOR', b.code);
      sensitive = [{ kind: 'CATALOG_DOCTOR', value: dative }];
    } else {
      const person = makePerson(random, split, 'f');
      const name = declineFirstName(person.first, 'f', 'gen');
      text = `для мамы ${name}: ${first} к ${a.forms[2]}, ${second} к ${b.forms[2]} ${time}`;
      order.push(a.code, b.code);
      sensitive = [{ kind: 'PERSON', value: name }];
      benign = false;
    }
    if (endToken) {
      text += `, ${third} ${endText}`;
      order.push(endToken);
    }
    add({ category: 'route_sequence', benign, messages: [tidy(text)], sensitive, fixedExpect: { order } });
  }

  // Улица без номера дома: публичное место, его смысл должен дойти.
  for (let i = 0; i < count(400); i += 1) {
    const [mention, stem] = random.pick(STREET_MENTIONS);
    const { forms } = specialtyOf();
    const text = random.pick(STREET_TEMPLATES[split])
      .replace('{SPA}', forms[3]).replace('{SPD}', forms[2]).replace('{SP}', forms[0])
      .replace('{STREET}', mention).replace('{T}', random.pick(TIMES));
    add({ category: 'benign_street', benign: true, messages: [tidy(text)], sensitive: [], fixedExpect: { place: { kind: 'street', value: stem } } });
  }

  // Стаж, сортировка, травмпункт.
  for (let i = 0; i < count(400); i += 1) {
    const [template, expectation] = random.pick(FILTER_TEMPLATES[split]);
    const { forms } = specialtyOf();
    const years = random.pick([5, 10, 15, 20]);
    const text = template
      .replace('{SPA}', forms[3]).replace('{SPD}', forms[2]).replace('{SP}', forms[0])
      .replace('{N}', String(years)).replace('{T}', random.pick(TIMES)).replace('{L}', random.pick(PLACES));
    const fixedExpect = { ...expectation };
    if (expectation.experience) fixedExpect.experience = years;
    add({ category: 'benign_filters', benign: true, messages: [tidy(text)], sensitive: [], fixedExpect });
  }

  // Реплики без запроса: модели отправлять нечего.
  for (let i = 0; i < count(150); i += 1) {
    add({ category: 'smalltalk', benign: true, messages: [random.pick(SMALLTALK[split])], sensitive: [], fixedExpect: { local: true } });
  }
};

const NOISY_SPECIALTIES = {
  therapist: ['терапефт', 'тeрапевт', 'тирапевт', 'участковый', 'терапевта'],
  dentist: ['стамотолог', 'стоматолох', 'зубник', 'зубной', 'дантист'],
  cardiologist: ['кардеолог', 'кардиолох', 'кардиолог'],
  neurologist: ['невралог', 'невропатолог', 'неврoлог'],
  pediatrician: ['педиатор', 'педиатр', 'детский врач'],
  gynecologist: ['гинеколок', 'гинеколог'],
  lor: ['лорр', 'лорик', 'ухогорлонос', 'лор'],
  ophthalmologist: ['окулис', 'глазник', 'глазной', 'офтальмолог'],
  urologist: ['уралог', 'уролог'],
  endocrinologist: ['эндокренолог', 'эндокринолог'],
  dermatologist: ['дерматалог', 'дерматолог', 'кожник'],
  surgeon: ['хирурк', 'хирург'],
  traumatologist: ['травмотолог', 'травматолог'],
  orthopedist: ['артопед', 'ортопед'],
};
const FILLERS = ['', 'плиз', 'срочно', 'щас', 'короче', 'блин', 'ну', 'пжлст', 'помогите', 'подскажите плз'];
const NOISY_PLACES = ['', 'рядом с ТЦ Мега', 'возле Кольца', 'у Парк Хауса', 'около ЦУМа', 'рядом с площадью Тукая', 'в Горках', 'на Дербышках', 'в Азино', 'рядом с работой', 'недалеко от универа'];
const DRUGS = ['эутирокс', 'конкор', 'ибупрофен', 'мидокалм', 'омепразол', 'метформин', 'амоксиклав', 'нурофен'];
const NOISY_TEMPLATES = {
  train: ['{F} нужен {S} {T} {L}', '{S} {L} {F}', 'где {S} {T}', 'нужен {S}, пью {D} {F}'],
  test: ['{F} ищу {S} {L} {T}', 'есть {S} {T}? {F}', '{S} нада {L}', 'хочу к врачу {S} {T}', 'назначили {D}, нужен {S} {L}'],
};

const DISTRICTS = ['вахитовск', 'советск', 'приволжск', 'ново-савиновск', 'московск', 'кировск', 'авиастроительн'];

/**
 * Что из запроса должно дойти до модели в любом виде — текстом или
 * структурой: профиль врача, время, место. По этим ожиданиям считается,
 * сколько смысла теряется, когда вместо текста уходит описание.
 */
export const inferExpect = (text) => {
  const lower = ` ${text.toLowerCase().replace(/ё/g, 'е')} `;
  const expect = {};
  SPECIALTIES.forEach((forms, index) => {
    if (forms.some((form) => new RegExp(`[^\\p{L}]${form}[^\\p{L}]`, 'u').test(lower))) expect.specialty ||= SPECIALTY_CODES[index];
  });
  if (lower.includes('после 18:00')) expect.time = 'availableAfter';
  else if (/ вечером /.test(lower)) expect.time = 'evening';
  else if (lower.includes('на выходных')) expect.time = 'weekend';
  // «малыш», но не фамилия «Малышев(а)».
  if (/ (?:детск|ребен|ребён|малыш(?![её]в|ов)|грудн)/.test(lower)) expect.child = true;
  if (lower.includes(' дмс')) expect.dms = true;
  if (/ (?:пешком|на машине|на велосипеде|на велике)/.test(lower)) expect.travel = /пешком/.test(lower) ? 'foot' : /машин/.test(lower) ? 'driving' : 'bike';
  if (/ (?:ркб|дркб|мкдц|поликлиник\S* \d+)/.test(lower)) expect.clinic = true;
  const district = DISTRICTS.find((stem) => lower.includes(stem));
  if (district) expect.place = { kind: 'district', value: district };
  else if (lower.includes('козья слобода')) expect.place = { kind: 'landmark', value: 'козья слобода' };
  else if (/ (рядом|недалеко|поближе|поблизости|ближайш)/.test(lower)) expect.place = { kind: 'nearest', value: 'nearest' };
  return expect;
};
