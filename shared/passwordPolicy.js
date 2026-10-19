/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Правила пароля — одни для сервера (passwords.js) и интерфейса: подсказки
 * при вводе совпадают с тем, что проверит сервер.
 *
 * Правила по NIST SP 800-63B: длина и отсечение известных слабых паролей,
 * без требований «заглавная + цифра + символ» — они делают пароли не
 * надёжнее, а предсказуемее. Длинная фраза из слов лучше «P@ssw0rd!».
 */

export const PASSWORD_LIMITS = Object.freeze({ MIN: 8, MAX: 128 });

/*
 * Самые частые пароли из утечек (в нижнем регистре) и их очевидные
 * варианты для русской раскладки. Это отсечение того, что подбирают
 * первым, а не замена лимитам входа.
 */
const COMMON = [
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwerty12345', 'qwertyqwerty', 'qwe123qwe',
  '1q2w3e4r', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', 'zaq12wsx', 'zaq1zaq1', 'qazwsxedc',
  'qazwsx123', 'asdfghjk', 'asdfghjkl', 'asdf1234', 'zxcvbnm1', 'zxcvbnm123', 'zxcvbnma', 'abcdefgh', 'abcd1234',
  'abc12345', 'abc123456', 'aa123456', 'a1234567', 'a12345678', '1234qwer', '12qwaszx', '123qweasd', '123qweasdzxc',
  'iloveyou', 'iloveyou1', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman123', 'starwars',
  'whatever', 'trustno1', 'letmein1', 'letmein123', 'welcome1', 'welcome123', 'admin123', 'admin1234', 'administrator',
  'changeme', 'changeme1', 'computer', 'internet', 'michael1', 'jennifer', 'master123', 'dragon123', 'monkey123',
  'shadow123', 'killer123', 'mustang1', 'pokemon1', 'samsung1', 'google123', 'yandex123', 'mailru123', 'vkontakte',
  'aaaaaaaa', 'aaaaaaaaa', 'qqqqqqqq', 'zzzzzzzz', 'asasasas', 'qwqwqwqw', 'abababab', 'q1q1q1q1', 'a1a1a1a1',
  'йцукенгш', 'йцукенгшщз', 'фывапролд', 'ячсмитьб', 'пароль12', 'пароль123', 'пароль1234', 'парольпароль',
  'привет123', 'люблютебя', 'наташа123', 'медкарта', 'medkarta', 'medkarta1', 'medkarta123', 'medkarta2026',
  'kazan2025', 'kazan2026', 'kazan123', 'kazan1234', 'казань2026', 'tatarstan', 'tatarstan1', 'doctor123',
  'zdorovie', 'zdorovie1', 'hospital1', 'polyclinic',
];
const COMMON_PASSWORDS = new Set(COMMON);

/** Части адреса, из которых нельзя собирать пароль (имя до @, если оно не короче 4 символов). */
const emailParts = (email) => {
  const local = String(email || '').split('@')[0].toLowerCase();
  return local.length >= 4 ? [local] : [];
};

/**
 * Проверки по отдельности — для подсказки под полем. Порядок — порядок
 * показа. ok — правило выполнено; blocking — без него пароль не принять.
 *
 * @returns {{key: string, ok: boolean, label: string}[]}
 */
export const passwordChecks = (password, { email = '' } = {}) => {
  const value = typeof password === 'string' ? password : '';
  const lower = value.toLowerCase();
  const tooSimple = value.length > 0 && (/^\d+$/.test(value) || /^(.)\1+$/u.test(value) || COMMON_PASSWORDS.has(lower));
  const containsEmail = emailParts(email).some((part) => lower.includes(part));
  return [
    { key: 'length', ok: value.length >= PASSWORD_LIMITS.MIN && value.length <= PASSWORD_LIMITS.MAX, label: `Не короче ${PASSWORD_LIMITS.MIN} символов` },
    { key: 'common', ok: value.length > 0 && !tooSimple, label: 'Не из списка частых паролей и не только цифры' },
    { key: 'email', ok: value.length > 0 && !containsEmail, label: 'Не содержит ваш email' },
  ];
};

/** Пустая строка — пароль подходит; иначе — что не так, по-русски. */
export const passwordProblem = (password, { email = '' } = {}) => {
  if (typeof password !== 'string' || password.length === 0) return 'Введите пароль.';
  if (password.length < PASSWORD_LIMITS.MIN) return `Пароль — не короче ${PASSWORD_LIMITS.MIN} символов.`;
  if (password.length > PASSWORD_LIMITS.MAX) return `Пароль — не длиннее ${PASSWORD_LIMITS.MAX} символов.`;
  if (/^\d+$/.test(password)) return 'Пароль не должен состоять только из цифр.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Этот пароль слишком распространён — его подбирают первым.';
  if (/^(.)\1+$/u.test(password)) return 'Пароль из одного повторяющегося символа слишком простой.';
  if (emailParts(email).some((part) => password.toLowerCase().includes(part))) return 'Пароль не должен содержать email.';
  return '';
};
