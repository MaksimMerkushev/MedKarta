/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Разбор часов работы в формате OpenStreetMap (opening_hours).
 *
 * Зачем. Расписание по дням у учреждений из OSM когда-то собиралось
 * импортом, который понимал не все записи: «Mo-Su 08:00-20:00» превращалось
 * в «пн–пт 08:00-20:00, сб и вс — выходной». 20 учреждений, включая
 * круглосуточный травмпункт, показывались закрытыми по выходным. Исходная
 * строка в данных сохранилась, поэтому расписание восстанавливается из неё.
 *
 * Поддерживаются формы, которые реально встречаются в справочнике:
 * «24/7», «08:00-20:00», «Mo-Fr 08:00-20:00; Sa 09:00-15:00; Su off»,
 * списки и диапазоны дней («Mo,We,Fr», «Mo-Tu,Th-Sa»), «PH» (праздники —
 * игнорируются), несколько интервалов в день («08:00-12:00,13:00-17:00» —
 * берётся общий охват). Всё прочее возвращает null, и тогда используется
 * расписание из данных как есть.
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const OSM_DAYS = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
const CLOSED = 'Выходной';

const parseDays = (spec) => {
  const days = new Set();
  for (const part of spec.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token || token === 'ph') continue;
    const range = token.match(/^([a-z]{2})-([a-z]{2})$/);
    if (range) {
      const from = OSM_DAYS[range[1]];
      const to = OSM_DAYS[range[2]];
      if (from === undefined || to === undefined) return null;
      for (let day = from; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === to) break;
      }
      continue;
    }
    if (!(token in OSM_DAYS)) return null;
    days.add(OSM_DAYS[token]);
  }
  return days.size > 0 ? days : null;
};

const parseTimes = (spec) => {
  const value = spec.trim().toLowerCase();
  if (value === 'off' || value === 'closed') return CLOSED;
  const intervals = [...value.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
  if (intervals.length === 0) return null;
  const leftover = value.replace(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g, '').replace(/[\s,]/g, '');
  if (leftover) return null;
  const first = intervals[0];
  const last = intervals[intervals.length - 1];
  const pad = (hours, minutes) => `${String(Number(hours)).padStart(2, '0')}:${minutes}`;
  return `${pad(first[1], first[2])}-${pad(last[3], last[4])}`;
};

/**
 * @param {string} hours строка opening_hours
 * @returns {null | Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun', string>}
 */
export const parseOpeningHours = (hours) => {
  const text = String(hours || '').trim();
  if (!text) return null;
  if (/^24\/7$/i.test(text)) {
    return Object.fromEntries(DAYS.map((day) => [day, '00:00-00:00']));
  }

  const schedule = Object.fromEntries(DAYS.map((day) => [day, CLOSED]));
  let assigned = false;

  // «… || "Sa by appointment"» — запасное правило с комментарием, не часы.
  // «Mo-Fr 08:00-18:00, Sa 08:00-13:00» — правила через запятую вместо «;».
  const rules = text
    .split('||')[0]
    .replace(/(\d{2}:\d{2})\s*,\s*(?=[A-Za-z]{2}(?:[\s,-]))/g, '$1;')
    .split(';');

  for (const rawRule of rules) {
    const rule = rawRule.trim();
    if (!rule) continue;
    // Праздничные дни в недельное расписание не входят.
    if (/^PH\b/i.test(rule)) continue;

    // «08:00-20:00» без дней — каждый день.
    const bare = parseTimes(rule);
    if (bare && bare !== CLOSED) {
      for (const day of DAYS) schedule[day] = bare;
      assigned = true;
      continue;
    }

    const match = rule.match(/^((?:[A-Za-z]{2}(?:-[A-Za-z]{2})?)(?:\s*,\s*[A-Za-z]{2}(?:-[A-Za-z]{2})?)*)\s+(.+)$/);
    if (!match) return null;
    const days = parseDays(match[1].replace(/\s+/g, ''));
    const times = parseTimes(match[2]);
    if (!days || !times) return null;
    for (const day of days) schedule[DAYS[day]] = times;
    assigned = true;
  }

  return assigned ? schedule : null;
};
