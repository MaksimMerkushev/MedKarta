/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Склонение имён, фамилий и отчеств для набора проверки.
 *
 * Правила упрощены, но покрывают то, как люди реально пишут в чате:
 * «запишите Гульнару», «для Ильдара», «маме Айгуль» (женские имена на
 * согласный не склоняются), «к Хайруллиной». Ошибки склонения в наборе
 * допустимы — пользователи тоже склоняют по-разному, — поэтому для
 * спорных случаев генератор берёт оба варианта.
 */

export const CASES = ['nom', 'gen', 'dat', 'acc', 'ins'];

const HUSHING = /[гкхжшчщ]$/u;
const SIBILANT_SOFT = /[жшчщц]$/u;

const keepCase = (source, result) => (source[0] === source[0].toUpperCase() ? result[0].toUpperCase() + result.slice(1) : result);

/** Имя в падеже. */
export const declineFirstName = (name, gender, grammaticalCase) => {
  if (grammaticalCase === 'nom') return name;
  const lower = name.toLowerCase();
  const stem = (cut) => name.slice(0, name.length - cut);
  const ending = {
    gen: 0, dat: 1, acc: 2, ins: 3,
  }[grammaticalCase];

  // Несклоняемые: на гласный, кроме а/я («Алсу», «Эндже», «Нелли», «Гаяне»).
  if (/[уюоеиэы]$/u.test(lower)) return name;

  if (/ия$/u.test(lower)) return stem(2) + ['ии', 'ии', 'ию', 'ией'][ending];
  if (/ья$/u.test(lower)) return stem(2) + ['ьи', 'ье', 'ью', 'ьей'][ending];
  if (/я$/u.test(lower)) return stem(1) + ['и', 'е', 'ю', gender === 'm' ? 'ёй' : 'ей'][ending];
  if (/а$/u.test(lower)) {
    const base = stem(1);
    const genitive = HUSHING.test(base.toLowerCase()) ? 'и' : 'ы';
    const instrumental = SIBILANT_SOFT.test(base.toLowerCase()) ? 'ей' : 'ой';
    return base + [genitive, 'е', 'у', instrumental][ending];
  }

  if (gender === 'f') {
    // Женские на согласный: «Любовь» склоняется, «Айгуль», «Гузель», «Чулпан» — обычно нет.
    if (lower === 'любовь') return ['Любови', 'Любови', 'Любовь', 'Любовью'][ending];
    return name;
  }

  if (/й$/u.test(lower)) return stem(1) + ['я', 'ю', 'я', 'ем'][ending];
  if (/ь$/u.test(lower)) return stem(1) + ['я', 'ю', 'я', 'ем'][ending];
  if (lower === 'лев') return ['Льва', 'Льву', 'Льва', 'Львом'][ending];
  const instrumental = SIBILANT_SOFT.test(lower) ? 'ем' : 'ом';
  return name + ['а', 'у', 'а', instrumental][ending];
};

/** Фамилия в падеже; gender — род носителя. */
export const declineSurname = (surname, gender, grammaticalCase) => {
  const lower = surname.toLowerCase();
  const index = CASES.indexOf(grammaticalCase);
  const pick = (forms) => forms[index];

  if (/(?:ых|их|ко)$/u.test(lower)) return surname;

  if (/(?:ский|цкий)$/u.test(lower)) {
    const base = surname.slice(0, -2);
    return gender === 'f'
      ? pick([`${base}ая`, `${base}ой`, `${base}ой`, `${base}ую`, `${base}ой`])
      : pick([surname, `${base}ого`, `${base}ому`, `${base}ого`, `${base}им`]);
  }

  if (/(?:ов|ев|ёв|ин|ын)$/u.test(lower)) {
    return gender === 'f'
      ? pick([`${surname}а`, `${surname}ой`, `${surname}ой`, `${surname}у`, `${surname}ой`])
      : pick([surname, `${surname}а`, `${surname}у`, `${surname}а`, `${surname}ым`]);
  }

  // Прочие на согласный: мужские склоняются («Акопяна», «Шмидта»), женские — нет.
  if (gender === 'f' || /[аеёиоуыэюя]$/u.test(lower)) return surname;
  const instrumental = SIBILANT_SOFT.test(lower) ? 'ем' : 'ом';
  return pick([surname, `${surname}а`, `${surname}у`, `${surname}а`, `${surname}${instrumental}`]);
};

/** Отчество от имени отца. */
export const patronymicOf = (fatherName, gender) => {
  const lower = fatherName.toLowerCase();
  const special = {
    'илья': ['Ильич', 'Ильинична'],
    'никита': ['Никитич', 'Никитична'],
    'лука': ['Лукич', 'Лукинична'],
    'фома': ['Фомич', 'Фоминична'],
    'кузьма': ['Кузьмич', 'Кузьминична'],
    'яков': ['Яковлевич', 'Яковлевна'],
    'лев': ['Львович', 'Львовна'],
    'пётр': ['Петрович', 'Петровна'],
    'павел': ['Павлович', 'Павловна'],
  }[lower];
  if (special) return gender === 'f' ? special[1] : special[0];
  let base = fatherName;
  let suffix = 'ович';
  if (/ий$/u.test(lower)) {
    base = fatherName.slice(0, -2);
    suffix = 'ьевич';
    if (/[кгх]ий$/u.test(lower) || /(?:ентий|рий)$/u.test(lower)) suffix = 'иевич';
  } else if (/й$/u.test(lower)) {
    base = fatherName.slice(0, -1);
    suffix = 'евич';
  } else if (/ь$/u.test(lower)) {
    base = fatherName.slice(0, -1);
    suffix = 'евич';
  } else if (/[жшчщц]$/u.test(lower)) {
    suffix = 'евич';
  } else if (/[ауоыэюяеи]$/u.test(lower)) {
    base = fatherName.slice(0, -1);
    suffix = 'ович';
  }
  const male = keepCase(fatherName, base + suffix);
  return gender === 'f' ? male.replace(/ич$/u, 'на') : male;
};

export const declinePatronymic = (patronymic, grammaticalCase) => {
  const index = CASES.indexOf(grammaticalCase);
  const lower = patronymic.toLowerCase();
  if (/на$/u.test(lower)) {
    const base = patronymic.slice(0, -1);
    return [patronymic, `${base}ы`, `${base}е`, `${base}у`, `${base}ой`][index];
  }
  return [patronymic, `${patronymic}а`, `${patronymic}у`, `${patronymic}а`, `${patronymic}ем`][index];
};

const LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Латиница, как её набирают на телефоне без русской раскладки. */
export const toLatin = (text) =>
  [...text].map((char) => {
    const lower = char.toLowerCase();
    const mapped = LATIN[lower];
    if (mapped === undefined) return char;
    return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }).join('');
