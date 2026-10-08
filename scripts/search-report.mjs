#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Отчёт по поискам из журнала аналитики.
 *
 *   npm run report:searches                 — последние 7 дней
 *   npm run report:searches -- --days 30    — последние 30 дней
 *   npm run report:searches -- --from 2026-10-01 --to 2026-10-14
 *   npm run report:searches -- --json       — то же в JSON
 *   npm run report:searches -- --dir /var/lib/medkarta/analytics
 *
 * Читает файлы events-YYYY-MM-DD.jsonl (backend/analytics/eventStore.js).
 * Повреждённые строки пропускаются и считаются отдельно.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeEvent } from '../shared/analytics.js';
import { buildReport, formatReport } from '../backend/analytics/report.js';
import { __private } from '../backend/analytics/eventStore.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const parseArgs = (argv) => {
  const args = { days: 7, json: false, dir: process.env.ANALYTICS_DIR || path.join(ROOT, 'var', 'analytics') };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--json') args.json = true;
    else if (flag === '--days' && /^\d{1,4}$/.test(value || '')) { args.days = Number(value); index += 1; }
    else if (flag === '--from' && DAY.test(value || '')) { args.from = value; index += 1; }
    else if (flag === '--to' && DAY.test(value || '')) { args.to = value; index += 1; }
    else if (flag === '--dir' && value) { args.dir = path.resolve(value); index += 1; }
    else {
      process.stderr.write(`Неизвестный аргумент: ${flag}\n`);
      process.exit(2);
    }
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const today = __private.kazanDay(new Date());
  const to = args.to || today;
  const from = args.from || __private.kazanDay(new Date(Date.now() - (Math.max(1, args.days) - 1) * 24 * 60 * 60 * 1000));

  let names = [];
  try {
    names = await fs.readdir(args.dir);
  } catch {
    process.stderr.write(`Журнал не найден: ${args.dir}\nСобытия появятся после первых посещений сайта.\n`);
    process.exit(1);
  }

  const files = names
    .map((name) => name.match(__private.FILE_PATTERN))
    .filter((match) => match && match[1] >= from && match[1] <= to)
    .map((match) => match[0])
    .sort();

  const events = [];
  let broken = 0;
  for (const name of files) {
    const text = await fs.readFile(path.join(args.dir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const { ts, ...rest } = JSON.parse(line);
        // Повторная проверка: в журнал могли дописать руками или старой версией.
        const event = sanitizeEvent(rest);
        if (event) events.push({ ts, ...event });
        else broken += 1;
      } catch {
        broken += 1;
      }
    }
  }

  const report = buildReport(events);
  const period = `${from} — ${to}, файлов: ${files.length}${broken ? `, пропущено строк: ${broken}` : ''}`;
  process.stdout.write(args.json ? `${JSON.stringify({ period: { from, to, files: files.length, broken }, ...report }, null, 2)}\n` : `${formatReport(report, { period })}\n`);
};

main().catch((error) => {
  process.stderr.write(`Ошибка отчёта: ${error?.message || error}\n`);
  process.exit(1);
});
