/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Состояние приложения для админ-панели: компоненты, процесс, запросы,
 * справочники. Ничего из окружения, кроме того, что перечислено явно:
 * ни переменных, ни ключей, ни путей к файлам вне репозитория, ни адресов.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { metrics } from '../observability/metrics.js';
import { requestStats } from '../observability/requestStats.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const startedAt = Date.now() - Math.round(process.uptime() * 1000);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch {
    return null;
  }
};

/** Короткий хэш коммита: из APP_COMMIT (ставится при деплое) или из .git, если он есть. */
const readCommit = () => {
  const fromEnv = process.env.APP_COMMIT || process.env.GIT_COMMIT;
  if (fromEnv && /^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 12);
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 12);
    const ref = head.match(/^ref: (refs\/[\w./-]+)$/)?.[1];
    if (!ref) return null;
    try {
      return fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim().slice(0, 12);
    } catch {
      const packed = fs.readFileSync(path.join(ROOT, '.git', 'packed-refs'), 'utf8');
      return packed.split('\n').find((line) => line.endsWith(` ${ref}`))?.slice(0, 12) || null;
    }
  } catch {
    return null;
  }
};

const VERSION = readJson('package.json')?.version || null;
const COMMIT = readCommit();

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  timer.unref?.();
})]);

const fileInfo = (relative, label) => {
  try {
    const stats = fs.statSync(path.join(ROOT, relative));
    return { label, file: relative, exists: true, bytes: stats.size, modifiedAt: stats.mtime.toISOString() };
  } catch {
    return { label, file: relative, exists: false, bytes: null, modifiedAt: null };
  }
};

const status = (ok, detail, extra = {}) => ({ status: ok === null ? 'off' : ok ? 'ok' : 'error', detail, ...extra });

/** Компоненты для дашборда: быстро, без тяжёлых загрузок. */
export const collectComponentHealth = async () => {
  const components = [];
  components.push({ key: 'backend', label: 'Backend (Node.js)', ...status(true, `работает ${Math.round((Date.now() - startedAt) / 60000)} мин`) });

  const { getAccountContext } = await import('./accountContext.js');
  const context = await getAccountContext().catch(() => null);
  const storage = context?.admin.storageHealth() || null;
  components.push({
    key: 'accounts',
    label: 'База аккаунтов (SQLite)',
    ...status(storage ? storage.ok : false, storage ? `аккаунтов: ${storage.users}, ${(storage.bytes / 1024 / 1024).toFixed(1)} МБ, схема ${storage.schemaVersion}` : 'недоступна'),
  });

  if (process.env.DEMO_DATA === 'on' && process.env.DEMO_BOOKING !== 'off') {
    const { getDefaultDemoBookingService } = await import('./demoBooking.js');
    const booking = await withTimeout(getDefaultDemoBookingService(), 2000).catch(() => null);
    const stats = booking?.store.stats() || null;
    components.push({ key: 'booking', label: 'Демо-запись (SQLite)', ...status(Boolean(stats), stats ? `слотов: ${Object.values(stats).reduce((sum, count) => sum + count, 0)}` : 'недоступна') });
  } else {
    components.push({ key: 'booking', label: 'Демо-запись', ...status(null, 'выключена (DEMO_DATA)') });
  }

  if (process.env.ROUTING_GRAPH_PATH || fileInfo('data/graph/kazan.graph', 'Граф дорог').exists) {
    const { getDefaultRoutingEngine } = await import('../routing/engine.js');
    const engine = await withTimeout(getDefaultRoutingEngine().catch(() => null), 2000);
    const stats = engine?.stats?.() || null;
    components.push({ key: 'routing', label: 'Маршрутизация (граф дорог)', ...status(Boolean(stats), stats ? `${stats.nodes.toLocaleString('ru-RU')} узлов` : 'граф не загружен') });
  } else {
    components.push({ key: 'routing', label: 'Маршрутизация (граф дорог)', ...status(false, 'файла графа нет') });
  }

  const hasModel = Boolean(process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY);
  components.push({ key: 'planner', label: 'Планировщик ассистента', status: 'ok', detail: hasModel ? 'внешняя модель настроена' : 'только локальный планировщик' });
  components.push({ key: 'vault', label: 'Хранилище меток Token Vault', status: 'ok', detail: process.env.TOKEN_VAULT_BACKEND === 'upstash' || process.env.TOKEN_VAULT_BACKEND === 'redis' ? 'Upstash Redis' : 'память процесса' });
  components.push({ key: 'analytics', label: 'Журнал аналитики', ...status(process.env.ANALYTICS === 'off' ? null : true, process.env.ANALYTICS === 'off' ? 'выключен' : 'включён') });

  const requests = requestStats.snapshot();
  return {
    checkedAt: new Date().toISOString(),
    components,
    errors: { since: requests.since, total: requests.total, errors5xx: requests.errors5xx, errors4xx: requests.errors4xx, perHour: requests.perHour },
  };
};

/** Подробности для раздела «Система». */
export const collectSystemInfo = async () => {
  const health = await collectComponentHealth();
  const memory = process.memoryUsage();

  let catalog = null;
  try {
    const { loadCatalog } = await import('../privacy/catalog.js');
    const loaded = await withTimeout(loadCatalog(), 5000);
    if (loaded) catalog = { doctors: loaded.doctors.length, clinics: loaded.clinics.length, specialties: loaded.specialties.length };
  } catch {
    catalog = null;
  }

  let demo = null;
  if (process.env.DEMO_DATA === 'on') {
    try {
      const { getDemoCatalog } = await import('../demo/catalog.js');
      const index = await getDemoCatalog();
      demo = { clinics: index.catalog.clinics.length, branches: index.branches.size, doctors: index.doctors.size, services: index.services.size, plans: index.plans.size };
    } catch {
      demo = null;
    }
  }

  const verification = readJson('data/verification.json');
  const collected = readJson('data/private/catalog.json');
  const sources = readJson('data/sources.json');

  const counters = metrics.snapshot().counters;
  const errorCounters = Object.entries(counters)
    .filter(([key]) => /error|failed|busy|shed|throttled/.test(key))
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 20);

  return {
    ...health,
    process: {
      startedAt: new Date(startedAt).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      appVersion: VERSION,
      commit: COMMIT,
      memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
      environment: process.env.NODE_ENV === 'production' ? 'production' : process.env.APP_ENV || 'development',
      demoMode: process.env.DEMO_DATA === 'on',
    },
    requests: requestStats.snapshot(),
    counters: errorCounters,
    data: {
      catalog,
      demo,
      sources: Array.isArray(sources?.sources) ? sources.sources.length : null,
      verifiedAt: verification?.generatedAt || null,
      collectedVerifiedAt: collected?.meta?.verifiedAt || null,
      collectedCounts: collected ? { clinics: collected.clinics?.length || 0, doctors: collected.doctors?.length || 0, prices: collected.prices?.length || 0 } : null,
      files: [
        fileInfo('data/doctors.js', 'Врачи (публичный срез)'),
        fileInfo('data/clinics.js', 'Клиники'),
        fileInfo('data/facilities.js', 'Учреждения OSM'),
        fileInfo('data/private/catalog.json', 'Собранный справочник'),
        fileInfo('data/demo/generated.js', 'Демо-набор'),
        fileInfo('data/graph/kazan.graph', 'Граф дорог'),
      ],
    },
  };
};
