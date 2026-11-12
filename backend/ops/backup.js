/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Резервные копии всех данных сервера: базы SQLite (аккаунты и журнал
 * согласий, статистика, демо-запись, лаборатории), события аналитики и
 * описание конфигурации без секретов.
 *
 * Как устроена копия (каталог medkarta-YYYYMMDDTHHMMSSZ):
 *   <имя>.sqlite.mkbak  — снимок базы через онлайн-копирование SQLite
 *                         (sqlite.backup: согласованно, с учётом WAL, пока
 *                         сервер работает), зашифрованный AES-256-GCM;
 *   analytics.json.mkbak — файлы событий аналитики, зашифрованные;
 *   config.json.mkbak    — какие переменные окружения заданы (имена) и
 *                          значения только несекретных; без ключей и паролей;
 *   manifest.json        — размеры, SHA-256 открытого и зашифрованного
 *                          содержимого, результат PRAGMA integrity_check.
 * Шифрование — accounts/backupCrypto.js (формат MKBAK1), ключ —
 * BACKUP_ENCRYPTION_KEY, отдельно от ключей приложения. Без ключа копия не
 * создаётся: незашифрованная копия базы аккаунтов — та же база.
 *
 * Копия собирается в каталоге *.partial и переименовывается, только когда
 * всё записано и проверено. Восстановление пишет базы в пустой каталог и
 * никогда не перезаписывает существующие файлы — подменить рабочие базы может
 * только человек, остановив сервер.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { decryptBackup, encryptBackup } from '../accounts/backupCrypto.js';

export const BACKUP_FORMAT = 1;
export const BACKUP_NAME = /^medkarta-(\d{8})T(\d{6})Z$/;

/* Несекретные переменные: их значения нужны, чтобы поднять сервер так же. */
export const SAFE_ENV_KEYS = Object.freeze([
  'NODE_ENV', 'APP_ENV', 'PORT', 'HOST', 'TRUST_PROXY', 'ALLOWED_HOSTS', 'PUBLIC_BASE_URL', 'SERVE_STATIC',
  'DEMO_DATA', 'DEMO_ONLY', 'BOOKING', 'PUBLIC_CLINICS', 'LABS', 'REGISTRATION_MODE', 'OPERATOR_NOTIFIED',
  'CHAT_REQUIRES_ACCOUNT', 'ACCOUNTS', 'AI_SYMPTOM_TRIAGE', 'AI_MODEL', 'AI_TRIAGE_MODEL', 'AI_LAB_MODEL',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_FROM', 'MIS_INTEGRATIONS', 'REAL_BOOKING',
  'ACCOUNTS_DB_PATH', 'STATS_DB_PATH', 'DEMO_BOOKING_DB_PATH', 'LAB_DB_PATH', 'ANALYTICS_DIR', 'INTEGRATIONS_DB_PATH',
]);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Что копировать: пути — те же, что у сервера (переменные окружения или значения по умолчанию). */
export const backupTargets = (env = process.env, root = process.cwd()) => {
  const accounts = env.ACCOUNTS_DB_PATH || path.join(root, 'var', 'accounts', 'medkarta.sqlite');
  return [
    { name: 'accounts', kind: 'sqlite', path: accounts },
    { name: 'stats', kind: 'sqlite', path: env.STATS_DB_PATH || path.join(path.dirname(accounts), 'stats.sqlite') },
    { name: 'demo-booking', kind: 'sqlite', path: env.DEMO_BOOKING_DB_PATH || path.join(root, 'var', 'demo', 'booking.sqlite') },
    { name: 'labs', kind: 'sqlite', path: env.LAB_DB_PATH || path.join(root, 'var', 'demo', 'labs.sqlite') },
    { name: 'integrations', kind: 'sqlite', path: env.INTEGRATIONS_DB_PATH || path.join(root, 'var', 'integrations', 'integrations.sqlite') },
    { name: 'analytics', kind: 'dir', path: env.ANALYTICS_DIR || path.join(root, 'var', 'analytics') },
  ];
};

/** Описание конфигурации: имена всех переменных из файла окружения и значения только несекретных. */
export const describeConfig = (envText) => {
  const keys = [];
  const values = {};
  for (const line of String(envText || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    keys.push(match[1]);
    if (SAFE_ENV_KEYS.includes(match[1])) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return { keys: [...new Set(keys)].sort(), values };
};

const stampOf = (at) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const integrity = (DatabaseSync, file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('PRAGMA integrity_check').all();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map((row) => ({ name: row.name, rows: db.prepare(`SELECT COUNT(*) AS n FROM "${row.name.replace(/"/g, '""')}"`).get().n }));
    return { ok: rows.length === 1 && rows[0].integrity_check === 'ok', detail: rows.slice(0, 3).map((row) => row.integrity_check), tables };
  } finally {
    db.close();
  }
};

/**
 * Создать копию.
 * @param {object} options
 * @param {Array} options.targets backupTargets()
 * @param {string} options.outRoot каталог для копий
 * @param {Buffer} options.key ключ шифрования (32 байта)
 * @param {Function} options.DatabaseSync node:sqlite
 * @param {Function} options.sqliteBackup node:sqlite backup()
 * @param {string|null} [options.envText] содержимое файла окружения — в копию попадут только имена и несекретные значения
 * @param {object} [options.meta] версия приложения, git SHA
 */
export const createBackup = async ({ targets, outRoot, key, DatabaseSync, sqliteBackup, envText = null, meta = {}, now = () => Date.now() }) => {
  if (!key || key.length !== 32) throw new Error('нужен ключ шифрования 32 байта (BACKUP_ENCRYPTION_KEY)');
  const at = now();
  const name = `medkarta-${stampOf(at)}`;
  const final = path.join(outRoot, name);
  const work = `${final}.partial`;
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const manifest = { format: BACKUP_FORMAT, name, createdAt: new Date(at).toISOString(), meta, items: [] };
  try {
    for (const target of targets) {
      if (!fs.existsSync(target.path)) {
        manifest.items.push({ name: target.name, kind: target.kind, present: false });
        continue;
      }
      let plain;
      let check = null;
      if (target.kind === 'sqlite') {
        const snapshot = path.join(work, `${target.name}.snapshot.sqlite`);
        // Обычное соединение: в режиме WAL соединению только для чтения нужен доступ к -shm; backup базу не меняет.
        const source = new DatabaseSync(target.path);
        try {
          await sqliteBackup(source, snapshot);
        } finally {
          source.close();
        }
        check = integrity(DatabaseSync, snapshot);
        plain = fs.readFileSync(snapshot);
        fs.rmSync(snapshot, { force: true });
        if (!check.ok) throw new Error(`снимок ${target.name} не прошёл integrity_check: ${check.detail.join('; ')}`);
      } else {
        const files = fs.readdirSync(target.path).filter((file) => fs.statSync(path.join(target.path, file)).isFile()).sort();
        plain = Buffer.from(JSON.stringify(Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(target.path, file), 'utf8')]))));
      }
      const sealed = encryptBackup(plain, key);
      const file = `${target.name}.${target.kind === 'sqlite' ? 'sqlite' : 'json'}.mkbak`;
      fs.writeFileSync(path.join(work, file), sealed, { mode: 0o600, flag: 'wx' });
      manifest.items.push({
        name: target.name, kind: target.kind, present: true, file,
        bytes: plain.length, sha256: sha256(plain), sealedSha256: sha256(sealed),
        ...(check ? { integrity: 'ok', tables: check.tables.length } : {}),
      });
    }
    if (envText !== null) {
      const sealed = encryptBackup(Buffer.from(JSON.stringify(describeConfig(envText))), key);
      fs.writeFileSync(path.join(work, 'config.json.mkbak'), sealed, { mode: 0o600, flag: 'wx' });
      manifest.items.push({ name: 'config', kind: 'config', present: true, file: 'config.json.mkbak', sealedSha256: sha256(sealed) });
    }
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    fs.renameSync(work, final);
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
  fs.writeFileSync(path.join(outRoot, 'LATEST.json'), JSON.stringify({ name, createdAt: manifest.createdAt, ok: true }), { mode: 0o600 });
  return { dir: final, manifest };
};

const readManifest = (dir) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`неизвестный формат копии: ${manifest.format}`);
  return manifest;
};

/** Проверить копию без восстановления: ключ подходит, суммы совпадают, базы целы. */
export const verifyBackup = ({ dir, key, DatabaseSync, scratch }) => {
  const manifest = readManifest(dir);
  const results = [];
  for (const item of manifest.items.filter((entry) => entry.present)) {
    const sealed = fs.readFileSync(path.join(dir, item.file));
    if (sha256(sealed) !== item.sealedSha256) throw new Error(`${item.file}: файл изменён или повреждён`);
    const plain = decryptBackup(sealed, key);
    if (item.sha256 && sha256(plain) !== item.sha256) throw new Error(`${item.file}: содержимое не совпадает с описью`);
    if (item.kind === 'sqlite') {
      const file = path.join(scratch, `${item.name}.verify.sqlite`);
      fs.writeFileSync(file, plain, { mode: 0o600 });
      try {
        const check = integrity(DatabaseSync, file);
        if (!check.ok) throw new Error(`${item.name}: integrity_check — ${check.detail.join('; ')}`);
        results.push({ name: item.name, tables: check.tables });
      } finally {
        fs.rmSync(file, { force: true });
      }
    } else results.push({ name: item.name });
  }
  return { manifest, results };
};

/** Восстановить в пустой каталог `to`. Рабочие базы не трогаются никогда. */
export const restoreBackup = ({ dir, key, to, DatabaseSync }) => {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(to).length > 0) throw new Error(`каталог ${to} не пуст: восстановление пишет только в пустой каталог`);
  const manifest = readManifest(dir);
  const written = [];
  for (const item of manifest.items.filter((entry) => entry.present)) {
    const sealed = fs.readFileSync(path.join(dir, item.file));
    if (sha256(sealed) !== item.sealedSha256) throw new Error(`${item.file}: файл изменён или повреждён`);
    const plain = decryptBackup(sealed, key);
    if (item.sha256 && sha256(plain) !== item.sha256) throw new Error(`${item.file}: содержимое не совпадает с описью`);
    if (item.kind === 'sqlite') {
      const file = path.join(to, `${item.name}.sqlite`);
      fs.writeFileSync(file, plain, { mode: 0o600, flag: 'wx' });
      const check = integrity(DatabaseSync, file);
      if (!check.ok) throw new Error(`${item.name}: integrity_check — ${check.detail.join('; ')}`);
      written.push({ name: item.name, file, tables: check.tables });
    } else if (item.kind === 'dir') {
      const folder = path.join(to, item.name);
      fs.mkdirSync(folder, { mode: 0o700 });
      for (const [file, text] of Object.entries(JSON.parse(plain.toString('utf8')))) {
        if (path.basename(file) !== file) throw new Error(`недопустимое имя файла в копии: ${file}`);
        fs.writeFileSync(path.join(folder, file), text, { mode: 0o600, flag: 'wx' });
      }
      written.push({ name: item.name, file: folder });
    } else if (item.kind === 'config') {
      const file = path.join(to, 'config.json');
      fs.writeFileSync(file, plain, { mode: 0o600, flag: 'wx' });
      written.push({ name: item.name, file });
    }
  }
  return { manifest, written };
};

/**
 * Какие копии удалить: хранятся последние keepDaily дневных, по одной за
 * keepWeekly последних недель и keepMonthly последних месяцев. Возвращает
 * имена к удалению — удаляет вызывающий.
 */
export const planPrune = (names, { keepDaily = 7, keepWeekly = 4, keepMonthly = 6 } = {}) => {
  const items = names.map((name) => ({ name, match: name.match(BACKUP_NAME) })).filter((item) => item.match)
    .map((item) => ({ name: item.name, day: item.match[1], at: Date.parse(`${item.match[1].slice(0, 4)}-${item.match[1].slice(4, 6)}-${item.match[1].slice(6, 8)}T00:00:00Z`) }))
    .sort((a, b) => b.name.localeCompare(a.name));
  const keep = new Set();
  const byPeriod = (keyOf, limit) => {
    const seen = new Set();
    for (const item of items) {
      const periodKey = keyOf(item);
      if (seen.has(periodKey)) continue;
      seen.add(periodKey);
      if (seen.size > limit) break;
      keep.add(item.name);
    }
  };
  byPeriod((item) => item.day, keepDaily);
  byPeriod((item) => { const d = new Date(item.at); const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return monday.toISOString().slice(0, 10); }, keepWeekly);
  byPeriod((item) => item.day.slice(0, 6), keepMonthly);
  return items.filter((item) => !keep.has(item.name)).map((item) => item.name);
};
