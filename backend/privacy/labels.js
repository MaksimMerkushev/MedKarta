/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Метки обезличивания, которые создаёт только сервер, и их точная грамматика.
 *
 * Пользовательский текст никогда не считается уже обезличенным: квадратные скобки и
 * «@ЗАГЛАВНЫЕ» из реплики на входе обезвреживаются (neutralizeUserMarkup), поэтому
 * после нормализации любая метка в тексте — серверная. Правила, ML-слой и финальная
 * проверка доверяют только меткам из этого списка; другие скобки в исходящем тексте —
 * отказ отправки (untrustedBrackets).
 */

export const SERVER_LABEL_NAMES = Object.freeze([
  'имя', 'организация', 'место', 'адрес', 'телефон', 'почта', 'номер', 'аккаунт', 'дата', 'код',
  'должность', 'название', 'клиника', 'врач', 'страховая', 'ссылка', 'о другом человеке', 'уточнение',
]);

const SOURCE = `\\[(?:${SERVER_LABEL_NAMES.join('|')})(?:_\\d{1,3})?\\]`;

/** Новый глобальный шаблон серверных меток (у каждого вызова свой lastIndex). */
export const trustedLabelPattern = () => new RegExp(SOURCE, 'gu');

/** Строка целиком — серверная метка. */
export const isTrustedLabel = (value) => new RegExp(`^${SOURCE}$`, 'u').test(String(value));

/** Квадратные скобки вне серверных меток: подделка метки или ошибка сервера. */
export const untrustedBrackets = (text) => /[[\]]/u.test(String(text).replace(trustedLabelPattern(), ''));

/**
 * Пользовательская разметка, похожая на серверную, — обычный текст: «[Иванов]» → «(Иванов)»,
 * «@IVANOV_PETR» → «@ivanov_petr» (ник, его найдут распознаватели). Вызывается на входе,
 * после исправления раскладки (там «[» и «]» — буквы «х» и «ъ»).
 */
export const neutralizeUserMarkup = (text) => String(text)
  .replace(/\[/gu, '(')
  .replace(/\]/gu, ')')
  .replace(/@(?=[A-Z])[A-Z0-9_]+/gu, (token) => token.toLowerCase());

/*
 * Ключ сущности для устойчивой метки в диалоге: «Ринат», «Рината», «Ринату» — один человек.
 * Отбрасывается падежное окончание, если остаётся основа от трёх букв.
 */
// «-ов», «-ев», «-ин» — часть фамилии, а не окончание: «Петров», «Петрову», «Петровой» → «петров».
const ENDING = /(?:ами|ями|ого|его|ому|ему|ыми|ими|ой|ей|ою|ею|ом|ем|ым|им|ам|ям|ах|ях|ую|юю|ая|яя|а|я|у|ю|е|ы|и)$/u;
export const entityKey = (type, value) => {
  const words = String(value).toLowerCase().replace(/ё/gu, 'е').match(/[\p{L}\p{N}]+/gu) || [];
  const stems = words.map((word) => {
    const stem = word.replace(ENDING, '');
    return stem.length >= 3 ? stem : word;
  });
  return `${type}:${stems.join(' ')}`;
};

/**
 * Состояние нумерации меток на диалог. seedTexts — уже обезличенные реплики: номера
 * продолжают выданные правилами, а не начинаются заново (разные люди — разные номера).
 */
export const createLabelState = (seedTexts = []) => {
  const counters = new Map();
  for (const text of seedTexts) {
    for (const m of String(text).matchAll(trustedLabelPattern())) {
      const inner = m[0].slice(1, -1);
      const at = inner.lastIndexOf('_');
      if (at < 0) continue;
      const name = inner.slice(0, at);
      const index = Number(inner.slice(at + 1));
      if (Number.isInteger(index) && index > (counters.get(name) || 0)) counters.set(name, index);
    }
  }
  return { byKey: new Map(), counters };
};

const stemsOf = (key) => new Set(String(key).replace(/^[A-Z]+:/u, '').split(' ').filter(Boolean));
const subsetOf = (a, b) => a.size > 0 && [...a].every((x) => b.has(x));

/**
 * Метка для сущности: та же сущность — тот же номер, новая — следующий. Имена связываются по
 * основам: «Рината» и «Ринат Сафин» — один человек (основы одного входят в основы другого);
 * «Ринат Сафин» и «Ринат Ахметов» — разные.
 */
export const labelFor = (state, labelName, key) => {
  if (!state) return `[${labelName}]`;
  const full = `${labelName}|${key}`;
  if (!state.byKey.has(full) && labelName === 'имя') {
    if (!state.people) state.people = [];
    const stems = stemsOf(key);
    const same = state.people.find((person) => subsetOf(stems, person.stems) || subsetOf(person.stems, stems));
    if (same) {
      for (const stem of stems) same.stems.add(stem);
      state.byKey.set(full, same.index);
    }
  }
  if (!state.byKey.has(full)) {
    const next = (state.counters.get(labelName) || 0) + 1;
    state.counters.set(labelName, next);
    state.byKey.set(full, next);
    if (labelName === 'имя') state.people.push({ stems: stemsOf(key), index: next });
  }
  return `[${labelName}_${state.byKey.get(full)}]`;
};
