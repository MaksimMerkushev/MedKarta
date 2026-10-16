/*
 * Проверка перевода ссылок для сайта документации (docs/assets/site.js)
 * без браузера: каждая ссылка каждой страницы после перевода должна вести
 * на существующую страницу docs/, существующий файл сайта или файл
 * репозитория (по локальной копии). Заодно — что docs/404.html совпадает с
 * docs/index.html: он открывает сайт при прямом заходе на внутреннюю
 * страницу (адреса без «#»).
 *
 *   node docs/tools/check-site.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOCS = path.join(ROOT, 'docs');
const BLOB = /^https:\/\/github\.com\/MaksimMerkushev\/MedKarta\/blob\/([0-9a-f]{40}|main)\//;

const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(DOCS, 'assets', 'site.js'), 'utf8'), sandbox);
const { rewriteLinks } = sandbox.MedkartaDocs;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : entry.name.endsWith('.md') ? [full] : [];
});

const errors = [];
let checked = 0;
let toGithub = 0;
for (const file of walk(DOCS)) {
  const page = path.relative(DOCS, file).split(path.sep).join('/');
  const out = rewriteLinks(fs.readFileSync(file, 'utf8'), page);
  let fence = false;
  for (const line of out.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    for (const match of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)/g)) {
      const target = match[1].split('#')[0];
      if (!target) continue;
      checked += 1;
      if (BLOB.test(target)) {
        toGithub += 1;
        const repoPath = target.replace(BLOB, '');
        if (!fs.existsSync(path.join(ROOT, decodeURI(repoPath)))) errors.push(`${page}: нет в репозитории ${repoPath}`);
      } else if (/^[a-z]+:/i.test(target)) {
        // внешняя ссылка
      } else if (target.endsWith('/')) {
        // Раздел: «/», «/adr/» (или «adr/» в _sidebar.md) — его README.md.
        const dir = target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(page), target);
        if (!fs.existsSync(path.join(DOCS, decodeURI(dir), 'README.md'))) errors.push(`${page}: нет раздела ${target}`);
      } else if (target.startsWith('/')) {
        if (!fs.existsSync(path.join(DOCS, decodeURI(target.slice(1))))) errors.push(`${page}: нет файла сайта ${target}`);
      } else if (target.endsWith('.md')) {
        if (!fs.existsSync(path.join(DOCS, decodeURI(target)))) errors.push(`${page}: нет страницы ${target}`);
      } else {
        errors.push(`${page}: непереведённая ссылка ${target}`);
      }
    }
  }
}

if (fs.readFileSync(path.join(DOCS, '404.html'), 'utf8') !== fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8')) {
  errors.push('docs/404.html отличается от docs/index.html — скопируйте index.html в 404.html');
}

console.log(`Ссылок проверено: ${checked}, из них на GitHub: ${toGithub}`);
if (errors.length > 0) {
  for (const error of errors) console.log(`  ${error}`);
  process.exit(1);
}
console.log('Ошибок нет.');
