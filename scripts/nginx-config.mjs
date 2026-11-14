#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Фрагменты nginx с заголовками безопасности для страниц и статики, которые
 * отдаёт nginx, а не Node. Источник один — SECURITY_HEADERS из
 * backend/http/securityHeaders.js, поэтому заголовки страницы и API не
 * расходятся. tests/nginx-config.test.js сверяет закоммиченные файлы с этим
 * генератором.
 *
 *   node scripts/nginx-config.mjs          — переписать deploy/nginx/*.conf
 *   node scripts/nginx-config.mjs --check  — только сверить (код 1 — расходятся)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECURITY_HEADERS } from '../backend/http/securityHeaders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'deploy', 'nginx');

const HEADER = '# Сгенерировано scripts/nginx-config.mjs из backend/http/securityHeaders.js — не правьте вручную.\n';

/* nginx: в значениях не должно быть двойных кавычек и переводов строки. */
const line = (name, value) => {
  if (/["\n\r]/.test(value)) throw new Error(`недопустимое значение заголовка ${name}`);
  return `add_header ${name} "${value}" always;`;
};

export const renderSecurityHeaders = () => HEADER + Object.entries(SECURITY_HEADERS).map(([name, value]) => line(name, value)).join('\n') + '\n';

/* Страницы со ссылкой-ключом в адресе: те же заголовки, но Referer не уходит никуда. */
export const renderTokenPageHeaders = () => HEADER + Object.entries({ ...SECURITY_HEADERS, 'Referrer-Policy': 'no-referrer' })
  .map(([name, value]) => line(name, value)).join('\n') + '\n';

export const FILES = Object.freeze({
  'security-headers.conf': renderSecurityHeaders,
  'security-headers-token-pages.conf': renderTokenPageHeaders,
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  let stale = 0;
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, render] of Object.entries(FILES)) {
    const file = path.join(DIR, name);
    const expected = render();
    const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (actual === expected) continue;
    if (check) {
      console.error(`Расходится с генератором: deploy/nginx/${name}`);
      stale += 1;
    } else {
      fs.writeFileSync(file, expected);
      console.log(`Записан deploy/nginx/${name}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('Фрагменты nginx совпадают с backend/http/securityHeaders.js.');
}
