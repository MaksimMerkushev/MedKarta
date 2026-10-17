/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Детерминированная «случайность» для демо-набора.
 *
 * Одинаковый seed — одинаковые клиники, врачи, расписания и состояния
 * слотов на любой машине и при каждом сбросе; Math.random() в генераторе не
 * используется, чтобы выдача не менялась от запроса к запросу.
 */

/** 32-битный хеш строки (FNV-1a). */
export const hashString = (value) => {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Число в [0, 1) — детерминированно по набору ключей. */
export const unit = (...keys) => {
  let state = hashString(keys.join('|')) + 0x6d2b79f5;
  state = Math.imul(state ^ (state >>> 15), state | 1);
  state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
  return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
};

/** Генератор последовательности (mulberry32) от seed и метки потока. */
export const createRandom = (seed, stream = '') => {
  let state = hashString(`${seed}|${stream}`);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return Object.freeze({
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (probability) => next() < probability,
    shuffle: (list) => {
      const copy = [...list];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(next() * (index + 1));
        [copy[index], copy[other]] = [copy[other], copy[index]];
      }
      return copy;
    },
  });
};
