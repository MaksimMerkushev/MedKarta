/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Резервные копии (backend/ops/backup.js, scripts/backup.mjs) на синтетических
 * данных: снимок с учётом WAL, шифрование, опись и проверка, восстановление в
 * отдельный каталог, политика хранения. Настоящих данных в тесте нет.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupTargets, createBackup, describeConfig, planPrune, restoreBackup, verifyBackup } from '../backend/ops/backup.js';

const sqlite = await import('node:sqlite').catch(() => null);
const skip = !sqlite?.backup && 'нужен node:sqlite с backup()';
const SCRIPT = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url));
const MARKER = 'synthetic-user-17@example.test';

describe('Резервные копии', { skip }, () => {
  let root;
  let key;
  let targets;
  let writer;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-backup-test-'));
    key = randomBytes(32);
    const env = {
      ACCOUNTS_DB_PATH: path.join(root, 'var', 'accounts', 'medkarta.sqlite'),
      DEMO_BOOKING_DB_PATH: path.join(root, 'var', 'demo', 'booking.sqlite'),
      LAB_DB_PATH: path.join(root, 'var', 'demo', 'labs.sqlite'),
      ANALYTICS_DIR: path.join(root, 'var', 'analytics'),
      INTEGRATIONS_DB_PATH: path.join(root, 'var', 'integrations', 'none.sqlite'),
    };
    targets = backupTargets(env, root);
    for (const dir of ['accounts', 'demo', 'analytics']) fs.mkdirSync(path.join(root, 'var', dir), { recursive: true });
    // Аккаунты — в режиме WAL, сервер «держит» соединение открытым, записи ещё не перенесены в основной файл.
    writer = new sqlite.DatabaseSync(env.ACCOUNTS_DB_PATH);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);");
    const insert = writer.prepare('INSERT INTO users (email) VALUES (?)');
    for (let index = 0; index < 50; index += 1) insert.run(`synthetic-user-${index}@example.test`);
    const stats = new sqlite.DatabaseSync(path.join(root, 'var', 'accounts', 'stats.sqlite'));
    stats.exec('CREATE TABLE counters (name TEXT, value INTEGER); INSERT INTO counters VALUES (\'search\', 3);');
    stats.close();
    const booking = new sqlite.DatabaseSync(env.DEMO_BOOKING_DB_PATH);
    booking.exec('CREATE TABLE bookings (number TEXT); INSERT INTO bookings VALUES (\'DEMO-1\');');
    booking.close();
    fs.writeFileSync(path.join(env.ANALYTICS_DIR, 'events-2026-11-10.jsonl'), '{"event":"open"}\n');
    fs.writeFileSync(path.join(env.ANALYTICS_DIR, 'events-2026-11-11.jsonl'), '{"event":"search"}\n');
  });
  after(() => {
    writer?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const make = (outRoot, extra = {}) => createBackup({
    targets, outRoot, key, DatabaseSync: sqlite.DatabaseSync, sqliteBackup: sqlite.backup,
    envText: 'NODE_ENV=production\nDEMO_ONLY=on\nSMTP_PASSWORD=very-secret-smtp\nOPENROUTER_API_KEY=sk-or-v1-synthetic\n', meta: { gitSha: 'test' }, ...extra,
  });

  it('снимок содержит записи из WAL, зашифрован, опись без секретов; отсутствующие базы пропущены', async () => {
    const out = path.join(root, 'backups');
    const { dir, manifest } = await make(out);
    assert.match(path.basename(dir), /^medkarta-\d{8}T\d{6}Z$/);
    assert.ok(!fs.existsSync(`${dir}.partial`));
    const byName = Object.fromEntries(manifest.items.map((item) => [item.name, item]));
    assert.equal(byName.accounts.integrity, 'ok');
    assert.equal(byName.labs.present, false);
    assert.equal(byName.integrations.present, false);
    for (const file of fs.readdirSync(dir)) {
      const data = fs.readFileSync(path.join(dir, file));
      assert.equal(data.includes(MARKER), false, `${file}: открытый текст в копии`);
      assert.equal(data.includes('very-secret-smtp'), false, `${file}: секрет в копии`);
    }
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'LATEST.json'), 'utf8')).ok);
  });

  it('проверка: ключ подходит, суммы совпадают; подмена байта и чужой ключ — отказ', async () => {
    const { dir } = await make(path.join(root, 'verify'));
    const scratch = fs.mkdtempSync(path.join(root, 'scratch-'));
    const { results } = verifyBackup({ dir, key, DatabaseSync: sqlite.DatabaseSync, scratch });
    assert.deepEqual(results.find((item) => item.name === 'accounts').tables, [{ name: 'users', rows: 50 }]);
    assert.throws(() => verifyBackup({ dir, key: randomBytes(32), DatabaseSync: sqlite.DatabaseSync, scratch }));
    const file = path.join(dir, 'accounts.sqlite.mkbak');
    const data = fs.readFileSync(file);
    data[data.length - 5] ^= 0xff;
    fs.writeFileSync(file, data);
    assert.throws(() => verifyBackup({ dir, key, DatabaseSync: sqlite.DatabaseSync, scratch }), /изменён или повреждён/u);
  });

  it('восстановление — только в пустой каталог, данные совпадают, конфигурация без секретов', async () => {
    const { dir } = await make(path.join(root, 'restore'));
    const to = path.join(root, 'restored');
    const { written } = restoreBackup({ dir, key, to, DatabaseSync: sqlite.DatabaseSync });
    const restored = new sqlite.DatabaseSync(written.find((item) => item.name === 'accounts').file, { readOnly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM users').get().n, 50);
    assert.equal(restored.prepare('SELECT email FROM users WHERE id = 18').get().email, MARKER);
    restored.close();
    assert.equal(fs.readFileSync(path.join(to, 'analytics', 'events-2026-11-11.jsonl'), 'utf8'), '{"event":"search"}\n');
    const config = JSON.parse(fs.readFileSync(path.join(to, 'config.json'), 'utf8'));
    assert.deepEqual(config.keys, ['DEMO_ONLY', 'NODE_ENV', 'OPENROUTER_API_KEY', 'SMTP_PASSWORD']);
    assert.deepEqual(config.values, { NODE_ENV: 'production', DEMO_ONLY: 'on' });
    assert.throws(() => restoreBackup({ dir, key, to, DatabaseSync: sqlite.DatabaseSync }), /не пуст/u);
  });

  it('без ключа копия не создаётся', async () => {
    await assert.rejects(() => make(path.join(root, 'nokey'), { key: null }), /ключ/u);
  });

  it('описание конфигурации: несекретные значения, секреты — только имена', () => {
    const config = describeConfig('export NODE_ENV="production"\nMFA_SECRET_KEY=abc\n# комментарий\nALLOWED_HOSTS=navimed.tech\n');
    assert.deepEqual(config, { keys: ['ALLOWED_HOSTS', 'MFA_SECRET_KEY', 'NODE_ENV'], values: { NODE_ENV: 'production', ALLOWED_HOSTS: 'navimed.tech' } });
  });

  it('политика хранения: 7 дневных, 4 недельных, 6 месячных; чужие каталоги не трогаются', () => {
    const names = [];
    for (let day = 0; day < 120; day += 1) {
      const d = new Date(Date.UTC(2026, 10, 12) - day * 86_400_000);
      names.push(`medkarta-${d.toISOString().slice(0, 10).replace(/-/g, '')}T030000Z`);
    }
    names.push('notes', 'medkarta-20261112T030000Z.partial');
    const remove = planPrune(names);
    const kept = names.filter((name) => /^medkarta-\d{8}T\d{6}Z$/.test(name) && !remove.includes(name));
    assert.ok(kept.includes('medkarta-20261112T030000Z'));
    assert.ok(kept.length >= 7 && kept.length <= 17, `осталось ${kept.length}`);
    assert.ok(!remove.includes('notes') && !remove.includes('medkarta-20261112T030000Z.partial'));
  });

  it('CLI: create → verify → restore → status на временных путях', () => {
    const env = {
      ...process.env,
      BACKUP_ENCRYPTION_KEY: key.toString('base64'),
      ACCOUNTS_DB_PATH: targets[0].path,
      DEMO_BOOKING_DB_PATH: targets[2].path,
      LAB_DB_PATH: targets[3].path,
      INTEGRATIONS_DB_PATH: targets[4].path,
      ANALYTICS_DIR: targets[5].path,
    };
    const out = path.join(root, 'cli');
    const run = (...args) => execFileSync(process.execPath, ['--no-warnings', SCRIPT, ...args], { env, encoding: 'utf8' });
    assert.match(run('create', '--out', out), /Копия:/u);
    const dir = path.join(out, fs.readdirSync(out).find((name) => /^medkarta-/.test(name)));
    assert.match(run('verify', '--dir', dir), /базы целы/u);
    assert.match(run('restore', '--dir', dir, '--to', path.join(root, 'cli-restored')), /Рабочие базы не тронуты/u);
    assert.match(run('status', '--out', out), /Последняя копия/u);
  });
});
