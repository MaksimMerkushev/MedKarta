/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Список врачей в одной точке карты: поиск, фильтр по специальности,
 * группировка. Чистые функции без React — их проверяют тесты.
 *
 * Зачем. В РКБ и ДРКБ по 320 врачей на одних координатах. Раньше окно
 * маркера показывало их одной лентой в порядке загрузки, и нужного врача
 * приходилось листать. Теперь:
 *   - поиск по фамилии, специальности, отделению и должности, по нескольким
 *     словам сразу («кардиолог петр»), без учёта регистра и «ё»;
 *   - набранное в английской раскладке («rfhlbjkju») тоже находится;
 *   - фильтр по специальности с числом врачей;
 *   - врачи из маршрута и избранного — наверху, остальные сгруппированы
 *     по специальностям и отсортированы по алфавиту.
 */

/** Нижний регистр и «ё» → «е». Длина строки не меняется — это нужно подсветке. */
const fold = (value) => String(value ?? '').toLowerCase().replace(/ё/g, 'е');

/** Строка запроса: fold плюс схлопнутые пробелы. */
export const normalizeQuery = (value) => fold(value).replace(/\s+/g, ' ').trim();

const LATIN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const CYRILLIC = 'йцукенгшщзхъфывапролджэячсмитьбюё';

/** «rfhlbjkju» → «кардиолог»: текст, набранный в английской раскладке. */
export const fromLatinLayout = (value) =>
  String(value ?? '').replace(/[a-z[\];',.`]/g, (ch) => {
    const index = LATIN.indexOf(ch);
    return index >= 0 ? CYRILLIC[index] : ch;
  });

/** Специальность для группировки; у учреждения её нет. */
export const specialtyOf = (item) =>
  item.entityKind === 'facility' ? null : item.doctorProfile || item.specialty || 'Другое';

const haystackOf = (item) =>
  fold([item.name, item.specialty, item.department, item.position].filter(Boolean).join(' '));

const matches = (item, tokens) => {
  if (tokens.length === 0) return true;
  const haystack = haystackOf(item);
  return tokens.every((token) => haystack.includes(token));
};

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru');

/**
 * Строит видимую часть списка.
 *
 * @param {object[]} items все записи точки
 * @param {{query?: string, specialty?: string|null}} [options]
 * @returns {{
 *   sections: Array<{key: string, title: string, items: object[]}>,
 *   chips: Array<{specialty: string, count: number}>,
 *   total: number, shown: number, tokens: string[], layoutQuery: string|null
 * }}
 */
export const buildPlaceList = (items, { query = '', specialty = null } = {}) => {
  const normalized = normalizeQuery(query);
  let tokens = normalized ? normalized.split(' ') : [];
  let layoutQuery = null;

  const inSpecialty = (item) => specialty === null || specialtyOf(item) === specialty;
  let visible = items.filter((item) => inSpecialty(item) && matches(item, tokens));

  // Ничего не нашлось, а в запросе латиница — вероятно, не та раскладка.
  if (visible.length === 0 && /[a-z]/.test(normalized)) {
    const converted = normalizeQuery(fromLatinLayout(normalized));
    const convertedTokens = converted.split(' ');
    const retry = items.filter((item) => inSpecialty(item) && matches(item, convertedTokens));
    if (retry.length > 0) {
      visible = retry;
      tokens = convertedTokens;
      layoutQuery = converted;
    }
  }

  // Числа на фильтрах считаются с учётом запроса, но без самого фильтра:
  // видно, сколько «Петровых» среди хирургов и сколько среди кардиологов.
  const counts = new Map();
  for (const item of items) {
    const key = specialtyOf(item);
    if (key === null || !matches(item, tokens)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const chips = [...counts]
    .map(([name, count]) => ({ specialty: name, count }))
    .sort((a, b) => b.count - a.count || a.specialty.localeCompare(b.specialty, 'ru'));

  const pinnedRoute = visible
    .filter((item) => item.isRouteTarget)
    .sort((a, b) => (a.routeIndex ?? 0) - (b.routeIndex ?? 0));
  const pinnedFavorites = visible.filter((item) => item.isFavorite && !item.isRouteTarget).sort(byName);
  const rest = visible.filter((item) => !item.isRouteTarget && !item.isFavorite);

  const sections = [];
  if (pinnedRoute.length) sections.push({ key: 'route', title: 'В маршруте', items: pinnedRoute });
  if (pinnedFavorites.length) sections.push({ key: 'favorites', title: 'Избранные', items: pinnedFavorites });

  const facilities = rest.filter((item) => specialtyOf(item) === null).sort(byName);
  if (facilities.length) sections.push({ key: 'facilities', title: 'Учреждение', items: facilities });

  const groups = new Map();
  for (const item of rest) {
    const key = specialtyOf(item);
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ru'))) {
    sections.push({ key: `specialty:${key}`, title: key, items: groups.get(key).sort(byName) });
  }

  return { sections, chips, total: items.length, shown: visible.length, tokens, layoutQuery };
};

/**
 * Разбивает текст на куски для подсветки совпадений.
 * @returns {Array<{text: string, match: boolean}>}
 */
export const highlightParts = (text, tokens) => {
  const source = String(text ?? '');
  if (!tokens?.length || !source) return [{ text: source, match: false }];

  const folded = fold(source);
  const ranges = [];
  for (const token of tokens) {
    if (!token) continue;
    let from = folded.indexOf(token);
    while (from !== -1) {
      ranges.push([from, from + token.length]);
      from = folded.indexOf(token, from + token.length);
    }
  }
  if (ranges.length === 0) return [{ text: source, match: false }];

  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const parts = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: source.slice(cursor, start), match: false });
    parts.push({ text: source.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < source.length) parts.push({ text: source.slice(cursor), match: false });
  return parts;
};
