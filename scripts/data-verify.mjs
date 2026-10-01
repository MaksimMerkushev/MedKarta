#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Проверка государственных врачей на официальных страницах учреждений.
 *
 * Для каждого врача справочника берётся страница, с которой его взяли
 * (sourceUrl); страница загружается один раз на всех её врачей. Врач на
 * странице — дата проверки обновляется; не найден — отметка «не найден»,
 * интерфейс предупредит; страница недоступна — дата не меняется.
 *
 * Результат — data/verification.json (только id врачей и даты). Сайты
 * больниц опрашиваются вежливо: robots.txt, пауза между запросами, свой
 * User-Agent (контакт задаётся переменной DATA_BOT_CONTACT).
 *
 *   npm run data:verify
 *   npm run data:verify -- --limit-pages 5      — проверить первые 5 страниц
 *   npm run data:verify -- --dry-run            — без записи
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyDoctorsOnPages } from '../tools/data/collector.js';
import { createFetcher } from '../tools/data/fetchSource.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'data', 'verification.json');
const args = process.argv.slice(2);
const limitIndex = args.indexOf('--limit-pages');
const limitPages = limitIndex === -1 ? Infinity : Number(args[limitIndex + 1]) || Infinity;
const dryRun = args.includes('--dry-run');

const loadDoctors = async () => {
  for (const name of ['doctors.full.js', 'doctors.js']) {
    try {
      const module = await import(pathToFileURL(path.join(ROOT, 'data', name)).href);
      const list = module.verifiedDoctors || module.default;
      if (Array.isArray(list) && list.length > 0) return { list, name };
    } catch {
      // нет файла — пробуем следующий
    }
  }
  return { list: [], name: null };
};

const main = async () => {
  const { list, name } = await loadDoctors();
  const withSource = list.filter((doctor) => /^https?:\/\//.test(doctor.sourceUrl || ''));
  process.stdout.write(`Справочник: data/${name} — врачей ${list.length}, со ссылкой на источник ${withSource.length}\n`);

  const fetcher = createFetcher({ root: ROOT });
  const results = await verifyDoctorsOnPages({
    doctors: withSource,
    fetcher,
    limitPages,
    onPage: ({ url, status, doctors }) => process.stdout.write(`  ${status === 'ok' ? '✓' : '✗'} ${url} (${doctors})\n`),
  });

  const counts = { present: 0, missing: 0, unreachable: 0 };
  for (const result of Object.values(results)) counts[result.status] += 1;
  process.stdout.write(`\nНа месте: ${counts.present}, не найдены: ${counts.missing}, страница недоступна: ${counts.unreachable}\n`);
  const byId = new Map(list.map((doctor) => [doctor.id, doctor]));
  for (const [id, result] of Object.entries(results)) {
    if (result.status === 'missing') process.stdout.write(`  не найден: ${byId.get(id)?.name} — ${byId.get(id)?.sourceUrl}\n`);
  }

  if (dryRun) {
    process.stdout.write('Пробный прогон: data/verification.json не изменён.\n');
    return;
  }
  let previous = { results: {} };
  try {
    previous = JSON.parse(await fs.readFile(OUT, 'utf8'));
  } catch {
    // файла ещё нет
  }
  // Недоступная страница не стирает прошлый успешный результат.
  const merged = { ...(previous.results || {}) };
  for (const [id, result] of Object.entries(results)) {
    merged[id] = result.status === 'unreachable' && merged[id]?.status === 'present'
      ? { ...merged[id], lastAttempt: result.checkedAt, lastAttemptCode: result.code }
      : result;
  }
  await fs.writeFile(OUT, `${JSON.stringify({ generatedAt: new Date().toISOString(), results: merged }, null, 2)}\n`);
  process.stdout.write('Записано: data/verification.json\n');
};

main().catch((error) => {
  process.stderr.write(`Ошибка проверки: ${error?.message || error}\n`);
  process.exit(1);
});
