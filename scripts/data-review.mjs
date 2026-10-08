#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Очередь ручной проверки сборщика.
 *
 *   npm run data:review                       — что ждёт проверки
 *   npm run data:review -- --accept <id>      — принять (применить к снимку)
 *   npm run data:review -- --reject <id>      — отклонить (больше не предлагать)
 *
 * id можно передать несколько раз.
 */

import { fileURLToPath } from 'node:url';

import { describeChange } from '../tools/data/collector.js';
import { createFileStore } from '../tools/data/store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const ids = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : [])).filter(Boolean);

const main = async () => {
  const store = createFileStore({ root: ROOT });
  for (const id of ids('--accept')) {
    const item = await store.accept(id);
    process.stdout.write(item ? `✓ принято: ${describeChange(item)}\n` : `нет в очереди: ${id}\n`);
  }
  for (const id of ids('--reject')) {
    const item = await store.reject(id);
    process.stdout.write(item ? `✗ отклонено: ${describeChange(item)}\n` : `нет в очереди: ${id}\n`);
  }

  const pending = await store.readPending();
  if (pending.length === 0) {
    process.stdout.write('Очередь проверки пуста.\n');
    return;
  }
  process.stdout.write(`\nЖдут проверки: ${pending.length}\n`);
  for (const item of pending) {
    process.stdout.write(`  [${item.id}] ${item.sourceId}: ${describeChange(item)} — ${item.reason} (с ${item.detectedAt})\n`);
  }
  process.stdout.write('\nПринять: npm run data:review -- --accept <id>   Отклонить: --reject <id>\n');
};

main().catch((error) => {
  process.stderr.write(`Ошибка: ${error?.message || error}\n`);
  process.exit(1);
});
