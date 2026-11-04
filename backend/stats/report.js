/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сводка запросов и ассистента за период из почасовых и суточных счётчиков.
 * Модуль чистый: чтение базы — в stats/index.js.
 *
 * Время ответа считается по гистограмме: среднее точное, p50 и p95 — верхняя
 * граница корзины («не дольше»), поэтому на экране они приблизительные.
 */

import { groupOfEndpoint } from './endpoints.js';
import { bucketIndex, moscowDayStart, moscowWeekdayHour } from './period.js';
import { LATENCY_BOUNDS } from './store.js';

const emptyTotals = () => ({ count: 0, s2xx: 0, s3xx: 0, s4xx: 0, s429: 0, s5xx: 0, totalMs: 0, latency: Array(LATENCY_BOUNDS.length + 1).fill(0) });

const addRow = (target, row) => {
  target.count += row.count;
  target.s2xx += row.s2xx;
  target.s3xx += row.s3xx;
  target.s4xx += row.s4xx;
  target.s429 += row.s429;
  target.s5xx += row.s5xx;
  target.totalMs += row.totalMs;
  row.latency.forEach((value, index) => { target.latency[index] += value; });
  return target;
};

/** Верхняя граница корзины, в которую попал процентиль; последняя корзина границы не имеет — её нижняя. */
export const percentileOf = (latency, fraction) => {
  const total = latency.reduce((sum, value) => sum + value, 0);
  if (total === 0) return null;
  const target = Math.ceil(total * fraction);
  let seen = 0;
  for (let index = 0; index < latency.length; index += 1) {
    seen += latency[index];
    if (seen >= target) return LATENCY_BOUNDS[index] ?? LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1];
  }
  return LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1];
};

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const view = (totals) => ({
  count: totals.count,
  ok: totals.s2xx + totals.s3xx,
  s2xx: totals.s2xx,
  s3xx: totals.s3xx,
  s4xx: totals.s4xx,
  s429: totals.s429,
  s5xx: totals.s5xx,
  errorRate: share(totals.s5xx, totals.count),
  avgMs: totals.count ? Math.round(totals.totalMs / totals.count) : null,
  p50Ms: percentileOf(totals.latency, 0.5),
  p95Ms: percentileOf(totals.latency, 0.95),
});

const totalsOf = (rows) => rows.reduce(addRow, emptyTotals());

/** Изменение к прошлому периоду, %; null — сравнивать не с чем. */
export const changeOf = (current, previous) => {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

export const buildRequestsSection = ({ period, rows, previousRows }) => {
  const totals = totalsOf(rows);
  const previous = totalsOf(previousRows);
  const size = period.buckets.length;
  const series = { count: Array(size).fill(0), s4xx: Array(size).fill(0), s5xx: Array(size).fill(0), s429: Array(size).fill(0), avgMs: Array(size).fill(null), p95Ms: Array(size).fill(null) };
  const bucketLatency = Array.from({ length: size }, () => emptyTotals());
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const perHourOfDay = Array(24).fill(0);
  const byEndpoint = new Map();
  const byGroup = new Map();
  const byHour = new Map();
  const byDay = new Map();

  for (const row of rows) {
    const index = bucketIndex(period.buckets, row.hour);
    if (index >= 0) {
      series.count[index] += row.count;
      series.s4xx[index] += row.s4xx;
      series.s5xx[index] += row.s5xx;
      series.s429[index] += row.s429;
      addRow(bucketLatency[index], row);
    }
    const { weekday, hour } = moscowWeekdayHour(row.hour);
    heatmap[weekday][hour] += row.count;
    perHourOfDay[hour] += row.count;
    addRow(byEndpoint.get(row.endpoint) || byEndpoint.set(row.endpoint, emptyTotals()).get(row.endpoint), row);
    const group = groupOfEndpoint(row.endpoint);
    addRow(byGroup.get(group) || byGroup.set(group, emptyTotals()).get(group), row);
    byHour.set(row.hour, (byHour.get(row.hour) || 0) + row.count);
    const day = moscowDayStart(row.hour);
    byDay.set(day, (byDay.get(day) || 0) + row.count);
  }
  bucketLatency.forEach((bucket, index) => {
    series.avgMs[index] = bucket.count ? Math.round(bucket.totalMs / bucket.count) : null;
    series.p95Ms[index] = percentileOf(bucket.latency, 0.95);
  });

  const peak = (map) => [...map].reduce((best, [start, count]) => (!best || count > best.count ? { start: new Date(start).toISOString(), count } : best), null);
  const ranked = (map, extra = () => ({})) => [...map]
    .map(([name, entry]) => ({ name, ...extra(name), ...view(entry), share: share(entry.count, totals.count) }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

  const durationHours = Math.max(1, (period.to - period.from) / 3_600_000);
  return {
    totals: view(totals),
    previous: view(previous),
    change: { count: changeOf(totals.count, previous.count), s5xx: changeOf(totals.s5xx, previous.s5xx), avgMs: changeOf(view(totals).avgMs, view(previous).avgMs) },
    perHourAverage: Math.round((totals.count / durationHours) * 10) / 10,
    peakHour: peak(byHour),
    peakDay: peak(byDay),
    series,
    byGroup: ranked(byGroup),
    byEndpoint: ranked(byEndpoint, (name) => ({ group: groupOfEndpoint(name) })),
    heatmap,
    perHourOfDay,
    latency: { bounds: LATENCY_BOUNDS, counts: totals.latency },
  };
};

const METRIC_KEY = /^([^{]+)(?:\{(.*)\})?$/;

/** «gateway.decision{decision=local_only}» → {name, labels}. */
export const parseMetricKey = (key) => {
  const [, name, labels = ''] = METRIC_KEY.exec(key) || [null, key, ''];
  return { name, labels: Object.fromEntries(labels.split(',').filter(Boolean).map((pair) => pair.split('='))) };
};

const ranked = (object) => Object.entries(object).map(([key, value]) => ({ key, value })).sort((left, right) => right.value - left.value || left.key.localeCompare(right.key));

/**
 * Ассистент и прочие счётчики процесса — по суткам (см. store.js). Запросы к
 * /api/chat считаются точнее, по часам, из http_hourly.
 */
export const buildAssistantSection = ({ period, requests, metricRows, previousMetricRows, dailyLimit = null }) => {
  const days = new Map(period.days.map((day) => [day, { modelCalls: 0, tokens: 0, local: 0, errors: 0 }]));
  const sums = {};
  const label = {};
  const add = (name, labelName, value, key) => {
    sums[name] = (sums[name] || 0) + value;
    if (labelName) {
      label[name] ||= {};
      label[name][key ?? 'unknown'] = (label[name][key ?? 'unknown'] || 0) + value;
    }
  };
  for (const row of metricRows) {
    const { name, labels } = parseMetricKey(row.key);
    const first = Object.keys(labels)[0];
    add(name, first, row.value, first ? labels[first] : null);
    const day = days.get(row.day);
    if (!day) continue;
    if (name === 'planner.usage') day.modelCalls += row.value;
    if (name === 'planner.tokens') day.tokens += row.value;
    if (name === 'planner.local_fallback' || name === 'planner.local_after_triage') day.local += row.value;
    if (name === 'planner.error' || name === 'api.chat.error' || name === 'triage.error') day.errors += row.value;
  }
  const previous = previousMetricRows.reduce((sum, row) => sum + (parseMetricKey(row.key).name === 'planner.usage' ? row.value : 0), 0);
  const chat = requests.byEndpoint.find((row) => row.name === 'POST /api/chat') || null;
  const tokens = label['planner.tokens'] || {};
  const of = (name) => sums[name] || 0;
  const list = (name) => ranked(label[name] || {});
  return {
    requests: chat,
    modelCalls: of('planner.usage'),
    modelCallsChange: changeOf(of('planner.usage'), previous),
    localAnswers: of('planner.local_fallback') + of('planner.local_after_triage'),
    localReasons: list('planner.local_fallback'),
    tokens: { prompt: tokens.prompt || 0, completion: tokens.completion || 0, total: of('planner.tokens') },
    gatewayDecisions: list('gateway.decision'),
    triage: { results: list('triage.result'), retries: of('triage.retry'), errors: list('triage.error') },
    emergency: of('gateway.emergency'),
    bookingRequests: of('pipeline.booking_request'),
    problems: {
      budgetExhausted: of('planner.budget_exhausted'),
      shed: of('api.chat.shed'),
      busy: of('api.chat.busy'),
      invalidPlans: of('planner.invalid_plan'),
      policyRejected: of('policy.rejected'),
      outboundBlocked: of('gateway.outbound_blocked'),
      plannerErrors: list('planner.error'),
      chatErrors: list('api.chat.error'),
    },
    routing: { unavailable: of('routing.unavailable') + of('travel_times.unavailable'), failed: list('routing.failed') },
    auth: { logins: list('auth.login'), registerRequested: of('auth.register_requested'), registered: of('auth.registered'), throttled: of('auth.throttled'), accessLinks: of('auth.access_link_requested'), activations: list('auth.activation') },
    analytics: { accepted: of('analytics.accepted'), rejected: of('analytics.rejected'), quotaExceeded: of('analytics.quota_exceeded') },
    daily: [...days].map(([day, values]) => ({ day, ...values })),
    dailyLimit,
  };
};
