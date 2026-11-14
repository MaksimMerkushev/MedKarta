/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Подбор лаборатории для корзины исследований. Сравнивается не цена одного
 * анализа, а полная стоимость визита: все исследования корзины плюс процедуры
 * взятия (одна на вид биоматериала: кровь из вены, мазок…). Учитываются
 * наличие всех исследований в филиале, сроки готовности, свободное время,
 * расстояние и время в пути. Филиал, где есть не всё, в основной список не
 * попадает: он показан отдельно с перечнем недостающего.
 *
 * Дата, время, точка отправления и время в пути понимаются так же, как в
 * подборе врача (shared/demoSearch.js): один разбор условий на всё приложение.
 *
 * Данные демонстрационные и неполные, поэтому «дешевле всего» здесь значит
 * «дешевле всего среди демо-филиалов МедКарты», а не по городу.
 */

import { normalizeLabRequest } from '../../shared/labSearch.js';
import { distanceMeters } from '../routing/graph.js';
import { resolveDays } from '../demo/search.js';
import { addDays, moscowDay, moscowParts } from '../demo/time.js';
import { LAB_WINDOW_DAYS, normalizeLabText } from './store.js';
import { PREPARATION_NOTE } from './catalog.js';

export { LAB_SORTS, LAB_TIMES_OF_DAY, normalizeLabRequest } from '../../shared/labSearch.js';
const FASTING_UNTIL = '12:00';
const SHOW_SLOTS = 4;
const MAX_OPTIONS = 10;
export const LAB_DISCLAIMER = 'Демонстрационные данные: лаборатории, цены, сроки и время вымышлены, запись в лабораторию не уходит.';

/*
 * Готовность для человека: «в день сдачи», «через 1 день», «через 5 дней».
 * Срок — в календарных днях от дня сдачи. Считаем, что сдали около 9:00, а
 * результаты выдают до 20:00: 30 часов — это завтра днём («через 1 день»), а не
 * «через 2 дня», как дало бы деление с округлением вверх.
 */
export const describeTurnaround = (hours) => {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const ready = 9 + hours;
  const days = Math.floor(ready / 24) + (ready % 24 > 20 ? 1 : 0);
  if (days === 0) return 'в день сдачи';
  const tail = days % 100;
  const word = tail >= 11 && tail <= 14 ? 'дней' : days % 10 === 1 ? 'день' : days % 10 >= 2 && days % 10 <= 4 ? 'дня' : 'дней';
  return `через ${days} ${word}`;
};

/**
 * Пересечения состава в корзине: исследование, которое уже входит в другое
 * (АЛТ — в печёночные пробы, ОАК без формулы — в ОАК с формулой). Подбор
 * ничего не убирает сам — направление важнее, — но предупреждает, что можно
 * не платить дважды.
 * @param {object[]} tests исследования корзины (с components)
 * @param {{code: string, normalized: string}[]} synonyms индекс синонимов
 */
export const findLabOverlaps = (tests, synonyms) => {
  const codeOf = new Map(synonyms.map((item) => [item.normalized, item.code]));
  const overlaps = [];
  for (const panel of tests) {
    if (!panel?.components?.length) continue;
    const inside = new Set(panel.components.map((name) => codeOf.get(normalizeLabText(name))).filter(Boolean));
    for (const test of tests) {
      if (!test || test.code === panel.code || overlaps.some((item) => item.code === test.code)) continue;
      const contained = inside.has(test.code) || (test.components?.length > 0 && test.components.every((name) => panel.components.includes(name)));
      if (contained) overlaps.push({ code: test.code, name: test.name, insideCode: panel.code, insideName: panel.name });
    }
  }
  return overlaps;
};

/** «АЛТ и АСТ уже входят в «Печёночные пробы» — …»: одна фраза на каждое большое исследование. */
export const describeLabOverlaps = (overlaps, nameOf = (code, name) => name) => {
  const groups = new Map();
  for (const item of overlaps) {
    if (!groups.has(item.insideCode)) groups.set(item.insideCode, { inside: nameOf(item.insideCode, item.insideName), names: [] });
    groups.get(item.insideCode).names.push(nameOf(item.code, item.name));
  }
  return [...groups.values()].map(({ inside, names }) => {
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} и ${names.at(-1)}` : names[0];
    return `${list} уже ${names.length > 1 ? 'входят' : 'входит'} в «${inside}» — если врач не назначил ${names.length > 1 ? 'их' : 'это исследование'} отдельно, можно убрать из списка и не платить дважды.`;
  });
};

/**
 * @param {object} deps
 * @param {object} deps.store хранилище лабораторий (labs/store.js)
 * @param {() => Promise<object|null>} [deps.getEngine] маршрутизатор для времени в пути
 * @param {() => number} [deps.now]
 */
export const createLabQuote = ({ store, getEngine = async () => null, now = () => Date.now() }) => {
  /** Время в пути до филиалов: маршрутизатор, а без него — оценка по прямой (помечена как примерная). */
  const travelOf = async (origin, branches, travel) => {
    const result = new Map();
    if (!origin) return result;
    const mode = travel?.mode || 'driving';
    let estimates = null;
    try {
      const engine = await getEngine();
      if (engine && typeof engine.travelTimes === 'function') {
        estimates = await engine.travelTimes(origin, branches.map((branch) => ({ lat: branch.lat, lng: branch.lng })), mode, { maxSeconds: 90 * 60 });
      }
    } catch {
      estimates = null;
    }
    branches.forEach((branch, position) => {
      const straightKm = distanceMeters(origin.lat, origin.lng, branch.lat, branch.lng) / 1000;
      const estimate = estimates?.[position];
      if (Number.isFinite(estimate?.durationSeconds) && estimate.approximate !== true) {
        result.set(branch.id, { minutes: Math.max(1, Math.round(estimate.durationSeconds / 60)), distanceKm: Number((estimate.distanceKm ?? straightKm).toFixed(1)), approximate: false });
      } else {
        // По прямой: машина ~22 км/ч по городу с учётом светофоров, пешком ~4,5 км/ч, велосипед ~12 км/ч.
        const speed = mode === 'foot' ? 4.5 : mode === 'bike' ? 12 : 22;
        result.set(branch.id, { minutes: Math.max(1, Math.round(((straightKm * 1.3) / speed) * 60)), distanceKm: Number(straightKm.toFixed(1)), approximate: true });
      }
    });
    return result;
  };

  /**
   * @param {object} raw запрос подбора (normalizeLabRequest)
   */
  const quote = async (raw) => {
    const { request, errors } = normalizeLabRequest(raw);
    const at = now();
    const today = moscowDay(at);
    const snapshot = store.snapshot();
    const unknown = request.tests.filter((code) => !snapshot.tests.has(code));
    if (request.tests.length === 0 || unknown.length > 0 || errors.length > 0) {
      return { status: 'invalid', errors: [...errors, ...(request.tests.length === 0 ? ['no_tests'] : []), ...unknown.map((code) => `unknown_test:${code}`)], request, options: [], partial: [] };
    }
    const tests = request.tests.map((code) => snapshot.tests.get(code));
    const fasting = tests.some((test) => test.fasting);
    const days = resolveDays(request, today, LAB_WINDOW_DAYS);
    const dateAsked = request.date.kind !== 'any';
    const timeAsked = Boolean(request.timeFrom || request.timeTo || request.evening);
    const fromTime = request.timeFrom || (request.evening ? '17:00' : null);
    const toTime = request.timeTo || null;
    const fastingConflict = fasting && Boolean(fromTime && fromTime >= FASTING_UNTIL);

    let branches = snapshot.branches;
    if (request.labIds.length) branches = branches.filter((branch) => request.labIds.includes(branch.labId));
    if (request.branchIds.length) branches = branches.filter((branch) => request.branchIds.includes(branch.id));
    const funnel = { branches: branches.length, complete: 0, price: 0, turnaround: 0, travel: 0, slots: 0 };

    const complete = [];
    const partial = [];
    for (const branch of branches) {
      const offerings = snapshot.offerings.get(branch.id) || new Map();
      const fees = snapshot.fees.get(branch.id) || new Map();
      const lines = [];
      const missing = [];
      const kinds = new Set();
      for (const test of tests) {
        const offering = offerings.get(test.code);
        if (!offering || !offering.available) {
          missing.push(test);
          continue;
        }
        lines.push({ kind: 'test', code: test.code, name: test.name, price: offering.price, turnaroundHours: offering.turnaroundHours, priceDate: offering.priceDate, conditions: offering.conditions });
        kinds.add(test.biomaterial);
      }
      const feeLines = [];
      for (const kind of kinds) {
        const fee = fees.get(kind);
        if (!fee) missing.push({ code: `fee:${kind}`, name: `приём биоматериала: ${kind}` });
        else feeLines.push({ kind: 'fee', feeKind: kind, name: fee.name, price: fee.price });
      }
      const testsTotal = lines.reduce((sum, line) => sum + line.price, 0);
      const feesTotal = feeLines.reduce((sum, line) => sum + line.price, 0);
      const entry = {
        branch, lab: snapshot.labs.get(branch.labId), lines, feeLines, testsTotal, feesTotal, total: testsTotal + feesTotal,
        turnaroundHours: lines.length ? Math.max(...lines.map((line) => line.turnaroundHours)) : null,
        priceDate: lines.length ? lines.map((line) => line.priceDate).sort()[0] : null,
      };
      if (missing.length) partial.push({ ...entry, missing: missing.map((item) => ({ code: item.code, name: item.name })) });
      else complete.push(entry);
    }
    funnel.complete = complete.length;
    const cheapestComplete = complete.length ? Math.min(...complete.map((entry) => entry.total)) : null;

    let candidates = complete;
    if (request.maxTotalPrice) candidates = candidates.filter((entry) => entry.total <= request.maxTotalPrice);
    funnel.price = candidates.length;
    if (request.maxTurnaroundHours) candidates = candidates.filter((entry) => entry.turnaroundHours <= request.maxTurnaroundHours);
    funnel.turnaround = candidates.length;

    const travel = await travelOf(request.origin, candidates.map((entry) => entry.branch), request.travel);
    for (const entry of candidates) entry.travel = travel.get(entry.branch.id) || null;
    if (request.travel?.maxMinutes) candidates = candidates.filter((entry) => entry.travel && entry.travel.minutes <= request.travel.maxMinutes);
    funnel.travel = candidates.length;

    // Время: в выбранные дни и часы; натощак — до полудня, если часы не названы.
    const slotTo = toTime || (fasting && !timeAsked ? FASTING_UNTIL : null);
    const slots = store.freeSlots({ branchIds: candidates.map((entry) => entry.branch.id), days, fromTime, toTime: slotTo, at });
    for (const entry of candidates) {
      const list = slots.get(entry.branch.id) || [];
      entry.slots = list.slice(0, SHOW_SLOTS);
      entry.slotsCount = list.length;
      const first = list[0];
      entry.readyAt = first && entry.turnaroundHours ? new Date(Date.parse(first.startAt) + entry.turnaroundHours * 3600_000).toISOString() : null;
    }
    candidates = candidates.filter((entry) => entry.slotsCount > 0);
    funnel.slots = candidates.length;

    const sort = request.sort || (request.origin && request.travel?.maxMinutes ? 'total' : 'total');
    const byTotal = (a, b) => a.total - b.total || (a.travel?.minutes ?? 999) - (b.travel?.minutes ?? 999);
    const comparators = {
      total: byTotal,
      distance: (a, b) => (a.travel?.minutes ?? 999) - (b.travel?.minutes ?? 999) || a.total - b.total,
      turnaround: (a, b) => a.turnaroundHours - b.turnaroundHours || a.total - b.total,
      soonest: (a, b) => Date.parse(a.slots[0]?.startAt || 0) - Date.parse(b.slots[0]?.startAt || 0) || a.total - b.total,
    };
    candidates.sort(comparators[sort] || byTotal);

    const cheapest = candidates.length ? Math.min(...candidates.map((entry) => entry.total)) : null;
    const fastest = candidates.length ? Math.min(...candidates.map((entry) => entry.turnaroundHours)) : null;
    const view = (entry) => ({
      branch: { id: entry.branch.id, name: entry.branch.name, address: entry.branch.address, district: entry.branch.district, lat: entry.branch.lat, lng: entry.branch.lng, phone: entry.branch.phone, collection: entry.branch.collection, hours: entry.branch.hours },
      lab: { id: entry.lab.id, name: entry.lab.name },
      lines: entry.lines,
      fees: entry.feeLines,
      testsTotal: entry.testsTotal,
      feesTotal: entry.feesTotal,
      total: entry.total,
      currency: 'RUB',
      priceDate: entry.priceDate,
      turnaroundHours: entry.turnaroundHours,
      turnaroundText: describeTurnaround(entry.turnaroundHours),
      readyAt: entry.readyAt || null,
      travel: entry.travel || null,
      slots: entry.slots || [],
      slotsCount: entry.slotsCount || 0,
      singleVisit: true,
      badges: [
        ...(entry.total === cheapest ? ['cheapest'] : []),
        ...(entry.turnaroundHours === fastest ? ['fastest'] : []),
      ],
      ...(entry.missing ? { missing: entry.missing } : {}),
    });

    const overlaps = findLabOverlaps(tests, store.synonymIndex());
    const notes = [...describeLabOverlaps(overlaps)];
    if (fasting) notes.push(fastingConflict
      ? `${tests.filter((test) => test.fasting).map((test) => test.name).join(', ')} ${tests.filter((test) => test.fasting).length > 1 ? 'сдаются' : 'сдаётся'} натощак — вечером это обычно невозможно. Посмотрите утреннее время.`
      : 'В корзине есть анализы натощак — показываю время до 12:00.');
    if (tests.some((test) => test.requiresBooking)) notes.push('Часть исследований — только по предварительной записи и занимает больше времени (например, глюкозотолерантный тест — около 2 часов).');
    if ([...travel.values()].some((item) => item.approximate)) notes.push('Время в пути примерное: посчитано по расстоянию.');

    const status = candidates.length > 0 ? 'ok' : 'empty';
    return {
      status,
      request,
      today,
      windowDays: { from: today, to: addDays(today, LAB_WINDOW_DAYS - 1) },
      dateAsked,
      timeAsked,
      tests: tests.map((test) => ({ code: test.code, name: test.name, biomaterial: test.biomaterial, biomaterialName: test.biomaterialName, fasting: test.fasting, requiresBooking: test.requiresBooking, preparation: test.preparation })),
      preparationNote: PREPARATION_NOTE,
      total: candidates.length,
      options: candidates.slice(0, MAX_OPTIONS).map(view),
      partial: partial.sort((a, b) => a.missing.length - b.missing.length || a.total - b.total).slice(0, 5).map(view),
      funnel,
      cheapestComplete,
      blockedBy: status === 'empty' ? blockedBy(funnel, request, dateAsked || timeAsked) : null,
      notes,
      overlaps,
      comparisonScope: `Сравнение среди ${funnel.branches} демо-филиалов МедКарты — не по всему городу.`,
      disclaimer: LAB_DISCLAIMER,
      generatedAt: new Date(at).toISOString(),
      fastingConflict,
      timeCaption: request.timeFrom || request.timeTo ? `${request.timeFrom ? `с ${request.timeFrom}` : ''}${request.timeTo ? ` до ${request.timeTo}` : ''}`.trim() : null,
      nowTime: moscowParts(at).time,
    };
  };

  /** Какое условие отсекло все варианты: показывается человеку, ослабить его — его решение. */
  const blockedBy = (funnel, request, timed) => {
    if (funnel.complete === 0) return 'missing';
    if (request.maxTotalPrice && funnel.price === 0) return 'price';
    if (request.maxTurnaroundHours && funnel.turnaround === 0) return 'turnaround';
    if (request.travel?.maxMinutes && funnel.travel === 0) return 'travel';
    return timed ? 'slots' : 'no_slots';
  };

  return Object.freeze({ quote, normalize: normalizeLabRequest });
};
