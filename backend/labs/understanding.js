/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Понимание лабораторного запроса на сервере, без внешней модели: какие
 * исследования названы, что сделать с корзиной («добавь», «убери», «вместо»,
 * «только»), какие условия (день, время, цена за всё, место, время в пути,
 * порядок) и что неоднозначно («железо», «сахар», «щитовидка», «сдать кровь»).
 *
 * Исследования ищутся по синонимам каталога с учётом падежей: «ферритина» —
 * ферритин, «общего анализа крови» — ОАК. Неоднозначное слово исследование не
 * выбирает: ассистент уточняет. Набор анализов по области («щитовидка»,
 * «гормоны») ассистент не подбирает — их назначает врач.
 *
 * Условия разбираются теми же правилами, что и для записи к врачу
 * (privacy/gateway.js, privacy/bookingConstraints.js), но по тексту без названий
 * анализов: «Т4» и «25-OH» не должны читаться как часы и цена.
 */

import { extractBookingConstraints } from '../privacy/bookingConstraints.js';
import { extractConstraints } from '../privacy/gateway.js';
import { AMBIGUOUS_TERMS } from './catalog.js';

const TOKEN = /[\p{L}\p{N}]+/gu;
const lower = (text) => String(text || '').toLowerCase().replace(/ё/gu, 'е');
/*
 * Основа слова для сравнения названий: окончания прилагательных и существительных
 * отбрасываются, чтобы «общего анализа крови» совпало с «общий анализ крови».
 * Короткие слова, аббревиатуры с цифрами и латиница сравниваются целиком.
 */
const ENDINGS = ['ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ами', 'ями', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю', 'ым', 'им', 'ых', 'их', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и', 'о', 'ь', 'й'];
const stem = (token) => {
  if (token.length <= 3 || /\d|[a-z]/u.test(token)) return token;
  for (const ending of ENDINGS) {
    if (token.endsWith(ending) && token.length - ending.length >= 3) return token.slice(0, -ending.length);
  }
  return token;
};

/* Признаки лабораторного запроса. */
const LAB_CUE = /(?<![\p{L}])(?:сдат\p{L}*|сдам|сдаю|сдаст\p{L}*|анализ\p{L}*|лаборатори\p{L}*|пцр|мазок|мазк\p{L}*|биоматериал\p{L}*|натощак|забор\p{L}*\s+крови|бланк\p{L}*|результат\p{L}*\s+анализ\p{L}*|проверить\s+(?:щитовидк|гормон|сахар|витамин|железо))/u;
const REMOVE_CUE = /(?<![\p{L}])(?:убер\p{L}*|убр\p{L}*|удал\p{L}*|исключ\p{L}*|без|не\s+нуж\p{L}*|не\s+надо|не\s+буду|отмени\p{L}*|вычеркн\p{L}*)(?![\p{L}])/u;
const ADD_CUE = /(?<![\p{L}])(?:добав\p{L}*|ещ[её]|также|тоже|плюс)(?![\p{L}])/u;
const ONLY_CUE = /(?<![\p{L}])только(?![\p{L}])/u;
const INSTEAD_CUE = /(?<![\p{L}])вместо(?![\p{L}])/u;
const REQUEST_CUE = /(?<![\p{L}])(?:хочу\s+сдать|нужно\s+сдать|надо\s+сдать|где\s+(?:можно\s+)?сдать|назначил\p{L}*|направлени\p{L}*|выписал\p{L}*)(?![\p{L}])/u;
const PREPARATION_CUE = /(?<![\p{L}])(?:как\s+подготов\p{L}*|подготовк\p{L}*|натощак\s+ли|нужно\s+ли[^.?!]{0,20}натощак|можно\s+ли\s+(?:есть|пить|курить|кофе|чай)|что\s+нельзя\s+перед)/u;
const BOOKING_CUE = /(?<![\p{L}])(?:запиш\p{L}*|записат\p{L}*|забронир\p{L}*|оформ\p{L}*\s+запис\p{L}*)/u;
const RESULTS_CUE = /(?<![\p{L}])(?:расшифр\p{L}*|что\s+значит|что\s+означа\p{L}*|это\s+норма|норма\s+ли|в\s+норме\s+ли|мои\s+результат\p{L}*|у\s+меня\s+(?:гемоглобин|ферритин|сахар|глюкоза|холестерин|ттг|соэ|лейкоцит\p{L}*)\s*\d)/u;
const CHEAPER_CUE = /(?<![\p{L}])(?:дешевл\p{L}*|подешевл\p{L}*|дешев\p{L}*|бюджетн\p{L}*|подешевле|экономн\p{L}*)/u;
const FASTER_CUE = /(?:быстре\p{L}*|скорее|побыстрее)[^.?!]{0,30}(?:результат\p{L}*|готов\p{L}*|получ\p{L}*|сдела\p{L}*)|результат\p{L}*[^.?!]{0,20}(?:быстре\p{L}*|побыстрее|в\s+тот\s+же\s+день|сегодня\s+же)|срочн\p{L}*[^.?!]{0,15}результат/u;
const SAME_DAY_CUE = /результат\p{L}*[^.?!]{0,15}(?:в\s+(?:тот\s+же\s+|этот\s+же\s+)?день\s+сдачи|в\s+тот\s+же\s+день|сегодня\s+же)/u;
const NEAR_CUE = /(?<![\p{L}])(?:ближ\p{L}*|поближе|рядом|недалеко|неподал\p{L}*)(?![\p{L}])/u;
const ONE_VISIT_CUE = /(?:в\s+одной\s+лаборатори\p{L}*|за\s+(?:один|одно|1)\s+(?:раз|посещени\p{L}*|визит)|всё\s+сразу|все\s+сразу|за\s+раз)/u;

/* Слова после «сдать …», которые не названия анализов: дни, время, местоимения. */
const UNRESOLVED_STOP = new Set(['кровь', 'крови', 'мочу', 'мочи', 'кал', 'кала', 'сдачи', 'всё', 'все', 'это', 'их', 'его', 'ее', 'её', 'анализы', 'анализ', 'анализов',
  'завтра', 'сегодня', 'послезавтра', 'утром', 'вечером', 'днем', 'днём', 'ночью', 'за', 'до', 'после', 'рядом', 'недалеко', 'где', 'можно', 'когда', 'срочно', 'быстро',
  'один', 'одна', 'одно', 'раз', 'субботу', 'воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'выходные', 'утра', 'вечера', 'ближайшее']);

/**
 * @param {object} deps
 * @param {Array<{code:string, synonym:string, normalized:string}>} deps.synonyms синонимы каталога (store.synonymIndex)
 * @param {Map<string, object>} deps.tests исследования по коду
 */
export const createLabUnderstanding = ({ synonyms, tests }) => {
  const entries = [];
  const seen = new Set();
  for (const item of synonyms) {
    const stems = (lower(item.normalized).match(TOKEN) || []).map(stem);
    if (stems.length === 0) continue;
    const key = `${item.code}|${stems.join(' ')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ code: item.code, stems });
  }
  entries.sort((a, b) => b.stems.length - a.stems.length);
  const byFirst = new Map();
  for (const entry of entries) {
    if (!byFirst.has(entry.stems[0])) byFirst.set(entry.stems[0], []);
    byFirst.get(entry.stems[0]).push(entry);
  }

  /** Названные исследования: самое длинное совпадение на месте, без пересечений. */
  const findTests = (text) => {
    const source = lower(text);
    const tokens = [...source.matchAll(TOKEN)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length, stem: stem(match[0]) }));
    const candidates = [];
    tokens.forEach((token, index) => {
      for (const entry of byFirst.get(token.stem) || []) {
        if (index + entry.stems.length > tokens.length) continue;
        if (entry.stems.every((part, offset) => tokens[index + offset].stem === part)) {
          candidates.push({ code: entry.code, from: index, to: index + entry.stems.length, start: token.start, end: tokens[index + entry.stems.length - 1].end });
        }
      }
    });
    candidates.sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from);
    const taken = [];
    for (const candidate of candidates) {
      if (taken.some((item) => candidate.from < item.to && item.from < candidate.to)) continue;
      taken.push(candidate);
    }
    return taken.sort((a, b) => a.start - b.start).map((item) => ({ ...item, original: String(text).slice(item.start, item.end) }));
  };

  const blank = (text, spans) => {
    let result = String(text);
    for (const span of spans) result = `${result.slice(0, span.start)}${' '.repeat(span.end - span.start)}${result.slice(span.end)}`;
    return result;
  };

  /** Неоднозначные слова вне найденных названий. */
  const findAmbiguous = (text, spans) => {
    const rest = lower(blank(text, spans));
    for (const term of AMBIGUOUS_TERMS) {
      const match = new RegExp(`(?<![\\p{L}])(?:${term.pattern})`, 'u').exec(rest);
      if (match) return { id: term.id, question: term.question, advice: term.advice || null, options: term.options.filter((code) => tests.has(code)), original: match[0] };
    }
    return null;
  };

  /* Часть реплики до точки, запятой или противопоставления: в её пределах действует «убери», «добавь». */
  const clauseOf = (source, start) => {
    const before = source.slice(0, start);
    const after = source.slice(start);
    const from = Math.max(before.lastIndexOf('.'), before.lastIndexOf(','), before.lastIndexOf(';'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.search(/\s(?:а|но)\s(?!.*\s(?:а|но)\s)/u)) + 1;
    const endMatch = after.search(/[.,;!?]|\s(?:а|но)\s/u);
    return source.slice(from, endMatch === -1 ? source.length : start + endMatch);
  };

  /** Условия реплики: правила записи к врачу по тексту без названий анализов. */
  const conditionsOf = (text, spans) => {
    const stripped = blank(text, spans);
    const constraints = extractConstraints(stripped);
    const booking = extractBookingConstraints(stripped);
    const source = lower(stripped);
    const result = {};
    if (booking.date) result.date = booking.date;
    if (booking.timeAny) result.timeAny = true;
    if (booking.timeOfDay === 'morning' || booking.timeOfDay === 'afternoon') result.timeOfDay = booking.timeOfDay;
    if (constraints.evening) result.timeOfDay = 'evening';
    // «В 8:30», «около девяти»: окно в полчаса от названного времени.
    const exact = booking.timeExact || booking.timeAround || null;
    if (typeof exact === 'string' && /^\d{2}:\d{2}$/u.test(exact)) {
      const [hours, minutes] = exact.split(':').map(Number);
      const start = Math.max(0, hours * 60 + minutes - (booking.timeAround ? 30 : 0));
      const end = Math.min(23 * 60 + 59, hours * 60 + minutes + 30);
      result.timeFrom = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
      result.timeTo = `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
    }
    if (constraints.availableAfter) result.timeFrom = constraints.availableAfter;
    if (constraints.availableBefore) result.timeTo = constraints.availableBefore;
    if (Object.hasOwn(booking, 'maxPrice')) result.maxTotalPrice = booking.maxPrice;
    if (booking.originPlace) result.originPlace = booking.originPlace;
    if (Number.isInteger(constraints.maxTravelMinutes)) result.maxMinutes = constraints.maxTravelMinutes;
    if (booking.preferCheap || CHEAPER_CUE.test(source)) result.sort = 'total';
    if (FASTER_CUE.test(source)) result.sort = 'turnaround';
    if (SAME_DAY_CUE.test(source)) result.maxTurnaroundHours = 10;
    if (!result.sort && NEAR_CUE.test(source) && (booking.originPlace || constraints.selection === 'nearest')) result.sort = 'distance';
    if (ONE_VISIT_CUE.test(source)) result.oneVisit = true;
    return result;
  };

  /**
   * Разбор диалога. turns — реплики пользователя по порядку; doctorTurns — номера
   * реплик, где назван врач (из gateway). Возвращает корзину, условия, намерения
   * и то, что нужно уточнить.
   */
  const analyze = (turns, { doctorTurns = new Set() } = {}) => {
    const texts = (Array.isArray(turns) ? turns : []).map((text) => String(text || ''));
    const perTurn = texts.map((text) => {
      const found = findTests(text);
      const ambiguous = findAmbiguous(text, found);
      const source = lower(text);
      return {
        text, source, found, ambiguous,
        labCue: LAB_CUE.test(source) || found.length > 0 || Boolean(ambiguous),
        conditions: conditionsOf(text, found),
        preparation: PREPARATION_CUE.test(source),
        booking: BOOKING_CUE.test(source),
        results: RESULTS_CUE.test(source),
      };
    });
    const start = perTurn.findIndex((turn) => turn.labCue);
    if (start === -1) return { active: false, tests: [], intents: [], filters: {}, latestIsLab: false };

    let cart = [];
    const operations = [];
    const filters = {};
    let ambiguous = null;
    let lastLab = start;
    for (let index = start; index < perTurn.length; index += 1) {
      const turn = perTurn[index];
      const doctorOnly = doctorTurns.has(index) && !turn.labCue;
      if (turn.labCue) lastLab = index;
      if (!doctorOnly) {
        // Реплика-уточнение снимает прежний вопрос, если в ней есть ответ.
        if (turn.ambiguous) ambiguous = turn.ambiguous;
        else if (turn.found.length > 0) ambiguous = null;
        if (turn.found.length > 0) {
          const codes = turn.found.map((item) => item.code);
          const removed = [];
          const added = [];
          let only = false;
          for (const item of turn.found) {
            const clause = clauseOf(turn.source, item.start);
            const head = turn.source.slice(Math.max(0, item.start - 12), item.start);
            const negated = /(?<![\p{L}])не\s+$/u.test(head);
            if (REMOVE_CUE.test(clause) || negated || (INSTEAD_CUE.test(head))) removed.push(item.code);
            else {
              added.push(item.code);
              if (ONLY_CUE.test(clause)) only = true;
            }
          }
          const fresh = cart.length === 0 || only || (REQUEST_CUE.test(turn.source) && !ADD_CUE.test(turn.source) && removed.length === 0);
          if (fresh && added.length > 0) {
            cart = [...new Set(added)];
            operations.push({ turn: index, op: only ? 'only' : 'set', codes: cart });
          } else {
            const next = cart.filter((code) => !removed.includes(code));
            for (const code of added) if (!next.includes(code)) next.push(code);
            if (removed.length) operations.push({ turn: index, op: 'remove', codes: removed });
            if (added.length && !fresh) operations.push({ turn: index, op: 'add', codes: added.filter((code) => !cart.includes(code)) });
            cart = next;
          }
          if (codes.length === 0) operations.push({ turn: index, op: 'none' });
        }
        const conditions = turn.conditions;
        if (conditions.timeAny) {
          delete filters.timeOfDay;
          delete filters.timeFrom;
          delete filters.timeTo;
        }
        if (conditions.timeOfDay || conditions.timeFrom || conditions.timeTo) {
          delete filters.timeOfDay;
          delete filters.timeFrom;
          delete filters.timeTo;
        }
        for (const key of ['date', 'timeOfDay', 'timeFrom', 'timeTo', 'originPlace', 'maxMinutes', 'sort', 'maxTurnaroundHours', 'oneVisit']) {
          if (conditions[key] !== undefined) filters[key] = conditions[key];
        }
        if (Object.hasOwn(conditions, 'maxTotalPrice')) {
          if (conditions.maxTotalPrice === null) delete filters.maxTotalPrice;
          else filters.maxTotalPrice = conditions.maxTotalPrice;
        }
      }
    }

    const latest = perTurn[perTurn.length - 1];
    const latestIndex = perTurn.length - 1;
    // Последняя реплика — о лаборатории: в ней анализы, или это продолжение (условия, «дешевле», «быстрее»).
    const followUp = latestIndex > start && !doctorTurns.has(latestIndex) && Object.keys(latest.conditions).length > 0;
    const latestIsLab = latest.labCue || followUp || (latestIndex === lastLab);
    const intents = new Set();
    if (latest.results) intents.add('unsupported_request');
    if (cart.length > 0) intents.add('laboratory_search');
    if (latest.found.length > 0 && cart.length > 0) intents.add('laboratory_test_search');
    if (operations.some((item) => item.turn === latestIndex && ['add', 'remove', 'only'].includes(item.op))) intents.add('laboratory_cart');
    if (latest.booking || perTurn.slice(start).some((turn) => turn.booking)) intents.add('laboratory_booking');
    if (latest.preparation) intents.add('laboratory_preparation_info');
    if (ambiguous && cart.length === 0) intents.add('clarification');
    if (ambiguous && latestIndex === perTurn.findLastIndex((turn) => turn.ambiguous)) intents.add('clarification');
    if ([...doctorTurns].some((index) => index >= start) || doctorTurns.has(latestIndex)) intents.add('doctor_search');

    /* Слова «анализ на …», после которых каталог ничего не нашёл: их может понять модель. */
    const unresolved = [];
    for (const turn of perTurn.slice(start)) {
      const rest = lower(blank(turn.text, turn.found));
      for (const cue of rest.matchAll(/(?<![\p{L}])(?:анализ\p{L}*|сдать|сдам|проверить|тест\p{L}*)(?![\p{L}])/gu)) {
        const match = /^\s+(?:на\s+)?([\p{L}][\p{L}\s-]{2,40}?)(?=[.,;!?]|\s+(?:и|а|завтра|сегодня|послезавтра|утром|вечером|до|после|в|во|на|рядом|недалеко|где)\s|$)/u.exec(rest.slice(cue.index + cue[0].length));
        if (!match) continue;
        const fragment = match[1].trim().replace(/^(?:на|в|во|по)\s+/u, '');
        const first = fragment.split(/\s+/u)[0];
        const ambiguousText = turn.ambiguous ? lower(turn.ambiguous.original).trim() : null;
        if (fragment.length < 3 || UNRESOLVED_STOP.has(first) || (ambiguousText && (fragment.includes(ambiguousText) || ambiguousText.includes(fragment)))) continue;
        unresolved.push(fragment);
      }
    }

    return {
      active: true,
      start,
      latestIsLab,
      tests: cart.map((code) => ({ code, name: tests.get(code)?.name || code })),
      operations,
      filters,
      ambiguous,
      intents: [...intents],
      unresolved: [...new Set(unresolved)].slice(0, 5),
      preparationAsked: latest.preparation,
      resultsAsked: latest.results,
      foundInLatest: latest.found.map((item) => item.code),
    };
  };

  return Object.freeze({ findTests, findAmbiguous, analyze });
};
