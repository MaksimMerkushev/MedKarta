#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сборщик данных: обходит источники из data/sources.json, сравнивает
 * с прошлым снимком, безопасные изменения применяет, рискованные кладёт
 * в очередь ручной проверки (npm run data:review).
 *
 *   npm run data:collect                         — все источники
 *   npm run data:collect -- --source <id>        — один источник
 *   npm run data:collect -- --source <id> --version v2   — другая версия файла-источника
 *   npm run data:collect -- --dry-run            — показать, ничего не записывать
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectSource, describeChange } from '../tools/data/collector.js';
import { createFetcher } from '../tools/data/fetchSource.js';
import { createFileStore } from '../tools/data/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};
const sourceIds = args.flatMap((arg, index) => (arg === '--source' ? [args[index + 1]] : [])).filter(Boolean);
const dryRun = args.includes('--dry-run');
const version = option('--version');

const STATUS = {
  created: 'снимок заведён',
  updated: 'обновлён',
  unchanged: 'без изменений, дата проверки обновлена',
  mass_change: 'СЛИШКОМ МНОГО ИЗМЕНЕНИЙ — всё на проверку',
  parse_empty: 'страница не разобралась — на проверку',
  too_many_records: 'СЛИШКОМ МНОГО ЗАПИСЕЙ — на проверку, ничего не применено',
  failed: 'сбой разбора — источник пропущен',
  blocked: 'запрещено robots.txt — пропущен',
  error: 'ошибка загрузки',
};

const main = async () => {
  const { sources } = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'sources.json'), 'utf8'));
  const selected = sourceIds.length > 0 ? sources.filter((source) => sourceIds.includes(source.id)) : sources;
  if (selected.length === 0) {
    process.stderr.write('Источники не найдены. Список — в data/sources.json.\n');
    process.exit(2);
  }

  const fetcher = createFetcher({ root: ROOT });
  const store = createFileStore({ root: ROOT });
  let reviewTotal = 0;

  for (const source of selected) {
    const vars = version && sourceIds.length > 0 ? { version } : {};
    /*
     * Сбой одного источника не останавливает остальные: раньше одна битая
     * страница обрывала весь прогон, и следующие источники не проверялись.
     */
    let report;
    try {
      report = await collectSource({ source, fetcher, store, vars, dryRun });
    } catch (error) {
      report = { status: 'failed', code: error?.name || 'error', auto: [], review: [] };
    }
    process.stdout.write(`\n${source.id}: ${STATUS[report.status] || report.status}${report.code ? ` (${report.code})` : ''}\n`);
    for (const change of report.auto) process.stdout.write(`  ✓ ${describeChange(change)}\n`);
    for (const item of report.review) process.stdout.write(`  ? ${describeChange(item)} — ${item.reason} [${item.id}]\n`);
    reviewTotal += report.review.length;
  }

  process.stdout.write(`\n${dryRun ? 'Пробный прогон: ничего не записано.' : 'Снимки — в data/collected/.'}`);
  process.stdout.write(reviewTotal > 0 ? ` На проверке: ${reviewTotal} — npm run data:review\n` : '\n');
};

main().catch((error) => {
  process.stderr.write(`Ошибка сборщика: ${error?.message || error}\n`);
  process.exit(1);
});
