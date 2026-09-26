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
 * сохраняются все: перерыв — это «закрыто»). Всё прочее возвращает null,
 * и тогда используется расписание из данных как есть.
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
  // «25:00-99:99» — не время; такое правило не принимается целиком.
  if (intervals.some((item) => Number(item[1]) > 24 || Number(item[3]) > 24 || Number(item[2]) > 59 || Number(item[4]) > 59)) {
    return null;
  }
  const leftover = value.replace(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g, '').replace(/[\s,]/g, '');
  if (leftover) return null;
  /*
   * Все интервалы, а не общий охват: «09:00-12:30,13:00-17:30» раньше
   * становилось «09:00-17:30», и в обед учреждение показывалось открытым.
   */
  const pad = (hours, minutes) => `${String(Number(hours)).padStart(2, '0')}:${minutes}`;
  return intervals.map((item) => `${pad(item[1], item[2])}-${pad(item[3], item[4])}`).join(',');
};

const DAY_MINUTES = 24 * 60;

/**
 * Интервалы работы из строки расписания одного дня, в минутах от полуночи.
 *
 * «09:00-12:30,13:00-17:30» → два интервала; «20:00-08:00» → конец на
 * следующих сутках (> 1440); «00:00-00:00» и «Круглосуточно» — весь день.
 * Выходной, пустая строка и нераспознанный текст — null.
 *
 * @param {string} value
 * @returns {null | Array<{start: number, end: number}>}
 */
export const scheduleIntervals = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (!text || /выход|closed|\boff\b/u.test(text)) return null;
  if (text.includes('круглосуточ') || text === '24/7') return [{ start: 0, end: DAY_MINUTES }];

  const intervals = [];
  const pattern = /(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const [, h1, m1, h2, m2] = match.map(Number);
    if (h1 > 24 || h2 > 24 || m1 > 59 || m2 > 59) return null;
    const start = h1 * 60 + m1;
    let end = h2 * 60 + m2;
    if (end === 23 * 60 + 59) end = DAY_MINUTES;
    if (start === end || (start === 0 && end === DAY_MINUTES)) {
      intervals.push({ start: 0, end: DAY_MINUTES });
      continue;
    }
    if (end < start) end += DAY_MINUTES;
    intervals.push({ start, end });
  }
  return intervals.length > 0 ? intervals : null;
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
    // Праздничные дни в недельное расписание не входят. Но «PH,Su off» —
    // это ещё и воскресенье: пропускается только правило для одних
    // праздников, а «ph» внутри списка дней отбрасывает parseDays.
    if (/^PH\s/i.test(rule)) continue;

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
