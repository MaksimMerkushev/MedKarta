/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Правила пароля — одни для сервера (passwords.js) и интерфейса: подсказки
 * при вводе совпадают с тем, что проверит сервер.
 *
 * Правила по NIST SP 800-63B-4 и OWASP Authentication Cheat Sheet:
 *   - длина — не меньше 15 символов (символ — кодовая точка Unicode после
 *     нормализации NFKC), не больше 256: длинная фраза из слов разрешена,
 *     пробелы и любые буквы — тоже;
 *   - без требований «заглавная + цифра + символ»: они делают пароли не
 *     надёжнее, а предсказуемее;
 *   - отсечение известных слабых паролей: частые из утечек, повторы,
 *     раскладочные и цифровые последовательности, адрес почты и название
 *     сервиса с цифрами в хвосте. Проверка по базе утечек (k-анонимность) —
 *     на сервере, если включена (backend/accounts/breachedPasswords.js).
 * Индикатор надёжности (passwordStrength) — только подсказка в интерфейсе,
 * сервер решает по passwordProblem.
 */

export const PASSWORD_LIMITS = Object.freeze({ MIN: 15, MAX: 256 });

/** Нормализация, одинаковая при хэшировании и проверке: NFKC (NIST 800-63B, 3.1.1.2). */
export const normalizePassword = (value) => (typeof value === 'string' ? value.normalize('NFKC') : '');

/** Длина в символах Unicode, а не в единицах UTF-16: «😀» — один символ. */
export const passwordLength = (value) => [...normalizePassword(value)].length;

/*
 * Частые пароли из утечек (в нижнем регистре, без пробелов) — длинные, от
 * 15 символов: короче правило длины отсекает и так. Плюс очевидные варианты
 * для русской раскладки. Это отсечение того, что подбирают первым, а не
 * замена лимитам входа.
 */
const COMMON = [
  'password1234567', 'password12345678', 'password123456789', 'passwordpassword', 'passwordpassword1',
  'qwertyuiopasdfg', 'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'qwertyuiopasdfghjklzxcvbnm', 'qwertyqwertyqwerty',
  '1q2w3e4r5t6y7u8i', '1q2w3e4r5t6y7u8i9o0p', 'q1w2e3r4t5y6u7i8', 'q1w2e3r4t5y6u7i8o9p0', '1qaz2wsx3edc4rfv',
  '1qaz2wsx3edc4rfv5tgb', 'zaq12wsxcde34rfv', 'qazwsxedcrfvtgbyhn', '123qweasdzxc123qweasdzxc', 'iloveyouiloveyou',
  'iloveyou1234567', 'letmeinletmein1', 'welcomewelcome1', 'administrator123', 'administrator1234', 'changemechangeme',
  'trustno1trustno1', 'superman1234567', 'starwarsstarwars', 'footballfootball', 'monkeymonkeymonkey',
  'correcthorsebatterystaple', 'thequickbrownfoxjumpsoverthelazydog', 'mypasswordismypassword',
  'йцукенгшщзхъфывап', 'йцукенгшщзхъфывапролджэ', 'фывапролджэячсмить', 'парольпарольпароль', 'пароль1234567890',
  'япаролькоторыйневзломать', 'люблютебялюблютебя', 'здравствуйтездравствуйте',
];
const COMMON_PASSWORDS = new Set(COMMON);

// Название сервиса и его варианты: «medkarta2026!!!!» подбирают сразу после словаря.
const CONTEXT_WORDS = ['medkarta', 'медкарта', 'navimed', 'навимед', 'medcard', 'медкард', 'kazan', 'казань'];

const KEYBOARD_ROWS = [
  '1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю',
  'abcdefghijklmnopqrstuvwxyz', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', 'qazwsxedcrfvtgbyhnujmikolp',
];

/** Без пробелов, знаков и регистра: «Qwerty Uiop!» и «qwertyuiop» — одно и то же. */
const squash = (value) => value.toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');

/** Пароль — повтор одного короткого куска («abcabcabc…», «пароль-пароль-пароль»). */
const isRepetition = (value) => {
  const chars = [...value];
  for (let size = 1; size <= Math.min(8, Math.floor(chars.length / 2)); size += 1) {
    const unit = chars.slice(0, size).join('');
    if (chars.length % size === 0 && unit.repeat(chars.length / size) === value) return true;
  }
  return false;
};

/** Пароль целиком из ряда клавиатуры, алфавита или цифр подряд — в любую сторону и с повтором. */
const isSequence = (value) => {
  if (value.length < 6) return false;
  const runs = KEYBOARD_ROWS.flatMap((row) => [row, [...row].reverse().join('')]);
  let rest = value;
  // Снимаем с начала самые длинные куски рядов; остаток не длиннее 3 знаков — последовательность.
  for (let guard = 0; guard < 12 && rest.length > 3; guard += 1) {
    let best = 0;
    for (const run of runs) {
      for (let length = Math.min(run.length, rest.length); length >= 3; length -= 1) {
        if (length <= best) break;
        if (run.includes(rest.slice(0, length))) {
          best = length;
          break;
        }
      }
    }
    if (best === 0) return false;
    rest = rest.slice(best);
  }
  return rest.length <= 3;
};

/** Название сервиса и цифры или знаки — и больше ничего. */
const isContextual = (squashed) => CONTEXT_WORDS.some((word) => {
  if (!squashed.includes(word)) return false;
  const rest = squashed.split(word).join('');
  return /^[\d]*$/u.test(rest) || rest.length < 4;
});

/** Части адреса, из которых нельзя собирать пароль (имя до @, если оно не короче 4 символов). */
const emailParts = (email) => {
  const local = String(email || '').split('@')[0].toLowerCase();
  return local.length >= 4 ? [local] : [];
};

const weakness = (password) => {
  const normalized = normalizePassword(password);
  const squashed = squash(normalized);
  if (/^\d+$/u.test(squashed)) return 'digits';
  if (COMMON_PASSWORDS.has(squashed)) return 'common';
  if (isRepetition(normalized.toLowerCase()) || isRepetition(squashed)) return 'repeat';
  if (isSequence(squashed)) return 'sequence';
  if (isContextual(squashed)) return 'context';
  return '';
};

/**
 * Проверки по отдельности — для подсказки под полем. Порядок — порядок
 * показа. ok — правило выполнено.
 *
 * @returns {{key: string, ok: boolean, label: string}[]}
 */
export const passwordChecks = (password, { email = '' } = {}) => {
  const value = normalizePassword(password);
  const length = passwordLength(value);
  const containsEmail = emailParts(email).some((part) => value.toLowerCase().includes(part));
  return [
    { key: 'length', ok: length >= PASSWORD_LIMITS.MIN && length <= PASSWORD_LIMITS.MAX, label: `Не короче ${PASSWORD_LIMITS.MIN} символов — можно фразу из нескольких слов` },
    { key: 'common', ok: length > 0 && !weakness(value), label: 'Не из частых паролей, без повторов и рядов клавиатуры' },
    { key: 'email', ok: length > 0 && !containsEmail, label: 'Не содержит ваш email' },
  ];
};

const WEAKNESS_MESSAGES = Object.freeze({
  digits: 'Пароль не должен состоять только из цифр.',
  common: 'Этот пароль слишком распространён — его подбирают первым.',
  repeat: 'Пароль из повторяющихся символов или слов слишком простой.',
  sequence: 'Пароль из ряда клавиатуры или алфавита подбирают первым.',
  context: 'Название сервиса с цифрами — слишком очевидный пароль.',
});

/** Пустая строка — пароль подходит; иначе — что не так, по-русски. */
export const passwordProblem = (password, { email = '' } = {}) => {
  if (typeof password !== 'string' || password.length === 0) return 'Введите пароль.';
  const value = normalizePassword(password);
  const length = passwordLength(value);
  if (length < PASSWORD_LIMITS.MIN) return `Пароль — не короче ${PASSWORD_LIMITS.MIN} символов. Удобно взять фразу из 3–4 слов.`;
  if (length > PASSWORD_LIMITS.MAX) return `Пароль — не длиннее ${PASSWORD_LIMITS.MAX} символов.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'В пароле не должно быть управляющих символов.';
  const weak = weakness(value);
  if (weak) return WEAKNESS_MESSAGES[weak];
  if (emailParts(email).some((part) => value.toLowerCase().includes(part))) return 'Пароль не должен содержать email.';
  return '';
};

/**
 * Оценка надёжности для индикатора: 0 — не подходит, 1 — слабый, 2 —
 * средний, 3 — хороший, 4 — отличный. Грубая эвристика по длине и
 * разнообразию; к безопасности отношения не имеет — сервер проверяет
 * passwordProblem, лимиты входа и (если включена) базу утечек.
 */
export const passwordStrength = (password, { email = '' } = {}) => {
  if (!password) return { score: 0, label: '' };
  if (passwordProblem(password, { email })) return { score: 0, label: 'Не подходит' };
  const value = normalizePassword(password);
  const chars = [...value];
  const unique = new Set(chars.map((char) => char.toLowerCase())).size;
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\d/u, /[\s\p{P}\p{S}]/u].filter((pattern) => pattern.test(value)).length;
  const words = value.trim().split(/[\s\-_.]+/u).filter((part) => part.length >= 3).length;
  let points = 0;
  if (chars.length >= 15) points += 1;
  if (chars.length >= 20) points += 1;
  if (chars.length >= 28) points += 1;
  if (unique >= 10) points += 1;
  if (classes >= 3 || words >= 4) points += 1;
  const score = Math.max(1, Math.min(4, points));
  return { score, label: ['', 'Слабый', 'Средний', 'Хороший', 'Отличный'][score] };
};
