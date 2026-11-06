/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Разделы статистики из базы аккаунтов и демо-записи: на входе строки, на
 * выходе числа, ряды по корзинам периода и списки. Модуль чистый. Адресов,
 * имён пользователей и их id здесь нет: только виды писем и событий, статусы
 * и справочные названия врачей, клиник и услуг.
 */

import { bucketIndex, moscowDayKey } from './period.js';

const bump = (object, key, by = 1) => {
  object[key] = (object[key] || 0) + by;
};

const ranked = (object, limit = Infinity) => Object.entries(object)
  .map(([key, value]) => ({ key, value }))
  .sort((left, right) => right.value - left.value || left.key.localeCompare(right.key))
  .slice(0, limit);

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** Мелкие корзины [since + k*step) → корзины периода. */
export const rollup = ({ period, since, stepMs, values }) => {
  const series = Array(period.buckets.length).fill(0);
  values.forEach((value, index) => {
    const bucket = bucketIndex(period.buckets, since + index * stepMs);
    if (bucket >= 0) series[bucket] += value;
  });
  return series;
};

/** Письма: очередь хранит их KEEP_DAYS дней, раньше данных нет — экран об этом говорит. */
export const buildMailSection = ({ period, rows, keepDays }) => {
  const size = period.buckets.length;
  const series = { sent: Array(size).fill(0), failed: Array(size).fill(0) };
  const byStatus = {};
  const byKind = {};
  const errors = {};
  for (const row of rows) {
    bump(byStatus, row.status);
    const kind = byKind[row.kind] ||= { kind: row.kind, total: 0, sent: 0, failed: 0, pending: 0 };
    kind.total += 1;
    if (row.status === 'sent') kind.sent += 1;
    else if (row.status === 'failed') kind.failed += 1;
    else kind.pending += 1;
    if (row.status === 'failed' && row.error) bump(errors, row.error);
    const index = bucketIndex(period.buckets, row.createdAt);
    if (index >= 0 && row.status === 'sent') series.sent[index] += 1;
    if (index >= 0 && row.status === 'failed') series.failed[index] += 1;
  }
  const total = rows.length;
  const sent = byStatus.sent || 0;
  const failed = byStatus.failed || 0;
  return {
    total,
    sent,
    failed,
    pending: total - sent - failed,
    deliveryRate: share(sent, sent + failed),
    byKind: Object.values(byKind).sort((left, right) => right.total - left.total || left.kind.localeCompare(right.kind)),
    errors: ranked(errors),
    series,
    keepDays,
  };
};

/** Демо-запись: созданные и отменённые за период, разрезы по справочнику. null — запись выключена. */
export const buildBookingSection = ({ period, rows, now, topLimit = 15 }) => {
  if (!rows) return { available: false };
  const size = period.buckets.length;
  const series = { created: Array(size).fill(0), cancelled: Array(size).fill(0) };
  const counts = { specialty: {}, clinic: {}, doctor: {}, service: {}, district: {}, weekday: Array(7).fill(0), hourOfDay: Array(24).fill(0) };
  let created = 0;
  let cancelled = 0;
  let withPlan = 0;
  let withAccount = 0;
  let leadMinutes = 0;
  let stillActive = 0;

  for (const row of rows) {
    if (row.createdAt >= period.from && row.createdAt < period.to) {
      created += 1;
      if (row.withPlan) withPlan += 1;
      if (row.withAccount) withAccount += 1;
      if (row.status === 'CONFIRMED') stillActive += 1;
      const index = bucketIndex(period.buckets, row.createdAt);
      if (index >= 0) series.created[index] += 1;
      if (row.specialty) bump(counts.specialty, row.specialty);
      if (row.clinic) bump(counts.clinic, row.clinic);
      if (row.doctor) bump(counts.doctor, row.doctor);
      if (row.service) bump(counts.service, row.service);
      if (row.district) bump(counts.district, row.district);
      leadMinutes += Math.max(0, row.startAt - row.createdAt) / 60_000;
      const start = new Date(row.startAt + 3 * 60 * 60 * 1000);
      counts.weekday[(start.getUTCDay() + 6) % 7] += 1;
      counts.hourOfDay[start.getUTCHours()] += 1;
    }
    if (row.cancelledAt && row.cancelledAt >= period.from && row.cancelledAt < period.to) {
      cancelled += 1;
      const index = bucketIndex(period.buckets, row.cancelledAt);
      if (index >= 0) series.cancelled[index] += 1;
    }
  }
  return {
    available: true,
    created,
    cancelled,
    stillActive,
    cancelRate: share(cancelled, created),
    withPlan,
    withAccount,
    upcomingActive: rows.filter((row) => row.status === 'CONFIRMED' && row.startAt > now).length,
    averageLeadHours: created ? Math.round((leadMinutes / created / 60) * 10) / 10 : null,
    series,
    bySpecialty: ranked(counts.specialty, topLimit),
    byClinic: ranked(counts.clinic, topLimit),
    byDoctor: ranked(counts.doctor, topLimit),
    byService: ranked(counts.service, topLimit),
    byDistrict: ranked(counts.district, topLimit),
    weekday: counts.weekday,
    hourOfDay: counts.hourOfDay,
  };
};

/**
 * Пользователи и входы. store — база аккаунтов; authTypes — виды событий входа
 * с подписями. Активность считается по суткам: при почасовом шаге ряда нет.
 */
export const buildAccountsSection = ({ period, store, authTypes, previousCount = 0 }) => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const stepMs = period.bucket === 'hour' ? HOUR : DAY;
  const fine = Math.max(1, Math.ceil((period.to - period.from) / stepMs));
  const since = period.from;

  const created = store.userCreationSeries({ since, bucketMs: stepMs, buckets: fine });
  const auth = store.authEventSeries({ since, bucketMs: stepMs, buckets: fine, types: authTypes.map(([type]) => type) });
  const authSeries = Object.fromEntries(Object.entries(auth).map(([type, values]) => [type, rollup({ period, since, stepMs, values })]));
  const authTotals = authTypes
    .map(([type, label]) => ({ key: type, label, value: (auth[type] || []).reduce((sum, value) => sum + value, 0) }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);

  const fromDay = period.days[0];
  const toDay = period.days[period.days.length - 1];
  const daily = store.dailyActiveUsers(fromDay, toDay);
  const dailyValues = period.days.map((day) => daily[day] || 0);
  let activeSeries = null;
  if (period.bucket === 'day') {
    activeSeries = period.buckets.map((start) => daily[moscowDayKey(start)] || 0);
  } else if (period.bucket !== 'hour') {
    // Неделя или месяц: уникальные за корзину, а не сумма по дням.
    activeSeries = period.buckets.map((start, index) => {
      const end = (period.buckets[index + 1] ?? period.to) - 1;
      return store.countActiveUsers(moscowDayKey(start), moscowDayKey(end));
    });
  }

  const newAccounts = created.reduce((sum, value) => sum + value, 0);
  const counts = store.userCounts();
  const sum = (filter) => counts.filter(filter).reduce((total, row) => total + row.count, 0);
  const roles = {};
  for (const row of counts) bump(roles, row.role, row.count);
  return {
    users: {
      total: sum(() => true),
      active: sum((row) => row.status === 'active'),
      blocked: sum((row) => row.status === 'blocked'),
      archived: sum((row) => row.status === 'archived'),
      pending: store.countPendingUsers(),
      byRole: ranked(roles),
    },
    newAccounts,
    newAccountsPrevious: previousCount,
    uniqueActive: store.countActiveUsers(fromDay, toDay),
    averageDailyActive: dailyValues.length ? Math.round((dailyValues.reduce((total, value) => total + value, 0) / dailyValues.length) * 10) / 10 : 0,
    peakDailyActive: Math.max(0, ...dailyValues),
    auth: authTotals,
    series: {
      newAccounts: rollup({ period, since, stepMs, values: created }),
      logins: authSeries.login_ok,
      failedLogins: authSeries.login_failed,
      activeUsers: activeSeries,
    },
  };
};
