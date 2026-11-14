#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Резервные копии всех данных сервера (backend/ops/backup.js). Ключ —
 * BACKUP_ENCRYPTION_KEY (32 байта, base64 или hex; openssl rand -base64 32),
 * хранить отдельно от копий и от ключей приложения.
 *
 *   npm run backup -- create --out /backup/medkarta [--env-file /путь/.env]
 *   npm run backup -- verify --dir /backup/medkarta/medkarta-20261112T030000Z
 *   npm run backup -- restore --dir <копия> --to <пустой каталог>
 *   npm run backup -- prune --out /backup/medkarta [--keep-daily 7 --keep-weekly 4 --keep-monthly 6] [--dry-run]
 *   npm run backup -- status --out /backup/medkarta [--max-age-hours 26]
 *
 * restore пишет только в пустой каталог: подменить рабочие базы — решение
 * человека при остановленном сервере (internal-docs/15-server-deployment.md).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupKeyFromEnv } from '../backend/accounts/backupCrypto.js';
import { backupTargets, BACKUP_NAME, createBackup, planPrune, restoreBackup, verifyBackup } from '../backend/ops/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command] = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const die = (message) => {
  console.error(message);
  process.exit(1);
};
const requireKey = () => {
  let key;
  try {
    key = backupKeyFromEnv();
  } catch (error) {
    die(error.message);
  }
  if (!key) die('Задайте BACKUP_ENCRYPTION_KEY (openssl rand -base64 32). Без шифрования копия не создаётся.');
  return key;
};
const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite?.DatabaseSync || !sqlite.backup) die('Нужен Node 22.16+ с node:sqlite (backup).');

switch (command) {
  case 'create': {
    const outRoot = option('out');
    if (!outRoot) die('Укажите --out каталог для копий');
    const envFile = option('env-file');
    let gitSha = null;
    try {
      gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      gitSha = null;
    }
    const { dir, manifest } = await createBackup({
      targets: backupTargets(process.env, ROOT),
      outRoot: path.resolve(outRoot),
      key: requireKey(),
      DatabaseSync: sqlite.DatabaseSync,
      sqliteBackup: sqlite.backup,
      envText: envFile ? fs.readFileSync(envFile, 'utf8') : null,
      meta: { gitSha, node: process.version },
    });
    console.log(`Копия: ${dir}`);
    for (const item of manifest.items) console.log(`  ${item.name.padEnd(13)} ${item.present ? `${item.bytes ?? ''} байт${item.integrity ? ', integrity_check ok' : ''}` : 'нет на диске — пропущено'}`);
    break;
  }
  case 'verify': {
    const dir = option('dir');
    if (!dir) die('Укажите --dir каталог копии');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-verify-'));
    try {
      const { results } = verifyBackup({ dir: path.resolve(dir), key: requireKey(), DatabaseSync: sqlite.DatabaseSync, scratch });
      for (const item of results) console.log(`  ${item.name.padEnd(13)} ok${item.tables ? `, таблиц ${item.tables.length}` : ''}`);
      console.log('Копия читается, суммы совпадают, базы целы.');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    break;
  }
  case 'restore': {
    const dir = option('dir');
    const to = option('to');
    if (!dir || !to) die('Укажите --dir каталог копии и --to пустой каталог');
    const { written } = restoreBackup({ dir: path.resolve(dir), key: requireKey(), to: path.resolve(to), DatabaseSync: sqlite.DatabaseSync });
    for (const item of written) console.log(`  ${item.name.padEnd(13)} → ${item.file}${item.tables ? ` (таблиц ${item.tables.length})` : ''}`);
    console.log('Готово. Рабочие базы не тронуты. После подмены баз при остановленном сервере выполните: npm run accounts -- reapply-erasures');
    break;
  }
  case 'prune': {
    const outRoot = option('out');
    if (!outRoot) die('Укажите --out каталог копий');
    const names = fs.readdirSync(outRoot).filter((name) => BACKUP_NAME.test(name));
    const remove = planPrune(names, { keepDaily: Number(option('keep-daily', 7)), keepWeekly: Number(option('keep-weekly', 4)), keepMonthly: Number(option('keep-monthly', 6)) });
    for (const name of remove) {
      console.log(`${flag('dry-run') ? 'удалилась бы' : 'удалена'}: ${name}`);
      if (!flag('dry-run')) fs.rmSync(path.join(outRoot, name), { recursive: true, force: true });
    }
    console.log(`Осталось копий: ${names.length - remove.length}`);
    break;
  }
  case 'status': {
    const outRoot = option('out');
    if (!outRoot) die('Укажите --out каталог копий');
    const maxAge = Number(option('max-age-hours', 26));
    let latest;
    try {
      latest = JSON.parse(fs.readFileSync(path.join(outRoot, 'LATEST.json'), 'utf8'));
    } catch {
      die('Копий ещё нет (LATEST.json не найден).');
    }
    const hours = (Date.now() - Date.parse(latest.createdAt)) / 3_600_000;
    console.log(`Последняя копия: ${latest.name}, ${hours.toFixed(1)} ч назад`);
    if (hours > maxAge) die(`Копия старше ${maxAge} ч.`);
    break;
  }
  default:
    die('Команды: create, verify, restore, prune, status. Подробности — в начале scripts/backup.mjs.');
}
