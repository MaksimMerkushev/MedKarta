#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Список редакций документов legal/manifest.json.
 *
 *   node scripts/legal-manifest.mjs                        добавить новые файлы legal/<документ>/<версия>.md
 *   node scripts/legal-manifest.mjs --current terms 2026-11-01   сделать редакцию действующей
 *
 * Опубликованную редакцию нельзя изменить: если текст файла не совпадает
 * с SHA-256 в манифесте, скрипт останавливается. Новая редакция — новый файл
 * с новой датой в имени (а прежний остаётся как есть): журнал согласий
 * хранит хэш принятого текста, и он должен совпадать с файлом.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGAL_DOCUMENTS } from '../shared/legal.js';

const DIR = fileURLToPath(new URL('../legal', import.meta.url));
const MANIFEST = path.join(DIR, 'manifest.json');
const VERSION = /^\d{4}-\d{2}-\d{2}(\.\d{1,2})?$/;
const FOLDERS = { privacy_policy: 'privacy-policy', terms: 'terms', health_consent: 'health-consent' };
const STATUS = { health_consent: 'not_offered' };

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : { documents: {} };
const errors = [];

for (const key of Object.keys(LEGAL_DOCUMENTS)) {
  const folder = path.join(DIR, FOLDERS[key]);
  const entry = manifest.documents[key] || { current: null, status: STATUS[key] || 'published', versions: [] };
  const known = new Map(entry.versions.map((item) => [item.version, item]));
  const files = fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.md')).sort() : [];
  for (const name of files) {
    const version = name.replace(/\.md$/, '');
    if (!VERSION.test(version)) {
      errors.push(`${FOLDERS[key]}/${name}: имя файла — дата редакции ГГГГ-ММ-ДД`);
      continue;
    }
    const hash = sha256(fs.readFileSync(path.join(folder, name), 'utf8'));
    const existing = known.get(version);
    if (existing) {
      if (existing.sha256 !== hash) errors.push(`${FOLDERS[key]}/${name}: текст изменён после публикации — создайте новую редакцию`);
      continue;
    }
    entry.versions.push({ version, file: `${FOLDERS[key]}/${name}`, sha256: hash, publishedAt: version.slice(0, 10) });
    console.log(`+ ${key} ${version}`);
  }
  for (const item of entry.versions) {
    if (!files.includes(path.basename(item.file))) errors.push(`${item.file}: файл опубликованной редакции удалён`);
  }
  entry.versions.sort((a, b) => (a.version < b.version ? -1 : 1));
  if (!entry.current && entry.versions.length > 0) entry.current = entry.versions.at(-1).version;
  manifest.documents[key] = entry;
}

const index = process.argv.indexOf('--current');
if (index > 0) {
  const [key, version] = process.argv.slice(index + 1, index + 3);
  const entry = manifest.documents[key];
  if (!entry || !entry.versions.some((item) => item.version === version)) errors.push(`--current: нет редакции ${key} ${version}`);
  else entry.current = version;
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log('legal/manifest.json обновлён.');
