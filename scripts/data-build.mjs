#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Собирает справочник частных клиник приложения из принятых снимков:
 * data/collected/*.json + data/sources.json → data/private/catalog.json.
 * Справочник с ошибками не записывается.
 *
 *   npm run data:build
 *   npm run data:build -- --include-demo --out /tmp/catalog.json   — проверить на демо-источниках
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalogFromSnapshots } from '../tools/data/buildCatalog.js';
import { createFileStore } from '../tools/data/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex === -1 ? path.join(ROOT, 'data', 'private', 'catalog.json') : path.resolve(args[outIndex + 1]);

const main = async () => {
  const { sources } = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'sources.json'), 'utf8'));
  const snapshots = await createFileStore({ root: ROOT }).listSnapshots();
  const { catalog, errors, skipped } = buildCatalogFromSnapshots(sources, snapshots, { includeDemo: args.includes('--include-demo') });

  for (const line of skipped) process.stdout.write(`пропущено: ${line}\n`);
  if (errors.length > 0) {
    process.stderr.write(`Справочник не записан — ошибки:\n${errors.map((error) => `  ${error}`).join('\n')}\n`);
    process.exit(1);
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(`Записано: ${path.relative(ROOT, out)} — клиник ${catalog.clinics.length}, врачей ${catalog.doctors.length}, цен ${catalog.prices.length}\n`);
};

main().catch((error) => {
  process.stderr.write(`Ошибка: ${error?.message || error}\n`);
  process.exit(1);
});
