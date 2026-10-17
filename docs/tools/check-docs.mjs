/*
 * Проверка документации в docs/ (и корневого README.md):
 *
 *   1. относительные ссылки ведут на существующие файлы, якоря — на
 *      существующие заголовки (слаги по правилам GitHub);
 *   2. блоки кода закрыты, диаграммы Mermaid извлекаются в отдельные файлы;
 *   3. ни в одной строке, включая блоки кода, нет похожих на секреты значений
 *      (ключи API, токены, приватные ключи, пароли в присваиваниях). Поиск
 *      идёт и по остальным *.md в корне репозитория. Это эвристика, а не
 *      замена сканеру секретов по всему репозиторию и истории git.
 *
 *   node docs/tools/check-docs.mjs
 *   node docs/tools/check-docs.mjs --mermaid-out /tmp/mmd   # сохранить диаграммы для mmdc
 *
 * Код выхода 1 — найдены ошибки. Скрипт ничего не меняет в репозитории.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOCS = path.join(ROOT, 'docs');
const args = process.argv.slice(2);
const mermaidOut = args.includes('--mermaid-out') ? args[args.indexOf('--mermaid-out') + 1] : null;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
  return entry.name.endsWith('.md') ? [full] : [];
});

const files = [...walk(DOCS), path.join(ROOT, 'README.md')];
const rootMarkdown = fs.readdirSync(ROOT).filter((name) => name.endsWith('.md') && name !== 'README.md').map((name) => path.join(ROOT, name));

/* Слаг заголовка по правилам GitHub: нижний регистр, без пунктуации, пробелы → дефисы. */
const slug = (text) => text
  .trim()
  .toLowerCase()
  .replace(/<[^>]+>/g, '')
  .replace(/[`*_~]/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[^\p{L}\p{N}\s-]/gu, '')
  .replace(/\s/g, '-');

const anchorsCache = new Map();
const anchorsOf = (file) => {
  if (anchorsCache.has(file)) return anchorsCache.get(file);
  const seen = new Map();
  const anchors = new Set();
  let fence = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const match = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!match) continue;
    const base = slug(match[1]);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorsCache.set(file, anchors);
  return anchors;
};

const errors = [];

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{16,}/, 'ключ вида sk-…'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'токен GitHub'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'токен GitHub'],
  [/AKIA[0-9A-Z]{16}/, 'ключ AWS'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'приватный ключ'],
  [/Bearer\s+[A-Za-z0-9._-]{24,}/, 'Bearer-токен'],
  [/xox[abpr]-[A-Za-z0-9-]{10,}/, 'токен Slack'],
  // KEY=…, SECRET: …, PASSWORD="…" со значением, похожим на настоящее: 20+ символов, есть и буквы, и цифры.
  [/\b[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*[=:]\s*["']?(?=[A-Za-z0-9_\-\/+=.]*\d)(?=[A-Za-z0-9_\-\/+=.]*[A-Za-z])[A-Za-z0-9_\-\/+=.]{20,}/, 'значение ключа или пароля'],
];

const findSecrets = (rel, lines) => lines.forEach((line, index) => {
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(line)) errors.push(`${rel}:${index + 1}: похоже на секрет (${label})`);
  }
});

let links = 0;
let diagrams = 0;
if (mermaidOut) fs.mkdirSync(mermaidOut, { recursive: true });

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  // Секреты ищутся во всех строках: пример в блоке кода публикуется так же, как текст.
  findSecrets(rel, lines);

  let fence = null;
  let mermaid = null;
  let fenceStart = 0;
  lines.forEach((line, index) => {
    const opener = line.match(/^\s*(```|~~~)\s*([\w-]*)/);
    if (opener && !fence) {
      fence = opener[1];
      fenceStart = index + 1;
      if (opener[2] === 'mermaid') mermaid = [];
      return;
    }
    if (fence && line.trim().startsWith(fence)) {
      if (mermaid) {
        diagrams += 1;
        if (mermaidOut) {
          const name = `${rel.replace(/[\\/]/g, '__').replace(/\.md$/, '')}__${fenceStart}.mmd`;
          fs.writeFileSync(path.join(mermaidOut, name), `${mermaid.join('\n')}\n`);
        }
      }
      fence = null;
      mermaid = null;
      return;
    }
    if (fence) {
      if (mermaid) mermaid.push(line);
      return;
    }

    // Ссылки вне блоков кода; инлайн-код вырезается, чтобы не ловить примеры.
    const plain = line.replace(/`[^`]*`/g, '');
    for (const match of plain.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:)/.test(target)) continue;
      links += 1;
      const [filePart, anchor] = target.split('#');
      const resolved = filePart ? path.resolve(path.dirname(file), decodeURI(filePart)) : file;
      if (!fs.existsSync(resolved)) {
        errors.push(`${rel}:${index + 1}: нет файла ${target}`);
        continue;
      }
      if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(decodeURIComponent(anchor))) {
        errors.push(`${rel}:${index + 1}: нет заголовка #${anchor} в ${path.relative(ROOT, resolved)}`);
      }
    }
  });
  if (fence) errors.push(`${rel}:${fenceStart}: блок кода не закрыт`);
}

for (const file of rootMarkdown) findSecrets(path.relative(ROOT, file), fs.readFileSync(file, 'utf8').split('\n'));

console.log(`Файлов: ${files.length}, относительных ссылок: ${links}, диаграмм Mermaid: ${diagrams}`);
if (errors.length > 0) {
  console.log(`Ошибок: ${errors.length}`);
  for (const error of errors) console.log(`  ${error}`);
  process.exit(1);
}
console.log('Ошибок нет.');
