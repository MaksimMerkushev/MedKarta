#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Проверка заголовков безопасности сайта после выкладки — только GET-запросы
 * к публичным адресам, ничего не меняет:
 *
 *   node scripts/check-headers.mjs https://navimed.tech
 *
 * Сверяет главную, один файл из /assets/, страницу со ссылкой-ключом
 * (/activate) и /api/health с SECURITY_HEADERS из backend/http/securityHeaders.js.
 * Код выхода 1 — чего-то не хватает или значение расходится.
 */

import { SECURITY_HEADERS } from '../backend/http/securityHeaders.js';

const base = String(process.argv[2] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('Укажите адрес сайта: node scripts/check-headers.mjs https://navimed.tech');
  process.exit(2);
}

const get = async (url) => {
  const response = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'MedKarta-header-check/1.0' } });
  const body = response.headers.get('content-type')?.includes('text/html') ? await response.text() : '';
  return { status: response.status, headers: response.headers, body };
};

const problems = [];
const check = (label, headers, expected) => {
  for (const [name, value] of Object.entries(expected)) {
    const actual = headers.get(name);
    if (actual === null) problems.push(`${label}: нет заголовка ${name}`);
    else if (actual !== value) problems.push(`${label}: ${name} = «${actual.slice(0, 120)}», ожидалось «${value.slice(0, 120)}»`);
  }
};

const home = await get(`${base}/`);
if (home.status !== 200) problems.push(`/: HTTP ${home.status}`);
check('/', home.headers, SECURITY_HEADERS);
const asset = home.body.match(/\/assets\/[A-Za-z0-9._-]+\.js/)?.[0];
if (asset) {
  const file = await get(`${base}${asset}`);
  check(asset, file.headers, SECURITY_HEADERS);
  if (!/immutable/.test(file.headers.get('cache-control') || '')) problems.push(`${asset}: нет долгого кэша (Cache-Control … immutable)`);
} else problems.push('на главной не найден файл /assets/*.js');
const token = await get(`${base}/activate`);
check('/activate', token.headers, { ...SECURITY_HEADERS, 'Referrer-Policy': 'no-referrer' });
const api = await get(`${base}/api/health`);
check('/api/health', api.headers, SECURITY_HEADERS);
if (base.startsWith('https://')) {
  const plain = await get(base.replace(/^https:/, 'http:') + '/').catch(() => null);
  if (plain && ![301, 308].includes(plain.status)) problems.push(`http:// → HTTP ${plain.status}, ожидался редирект на https`);
}
const server = home.headers.get('server') || '';
if (/\d/.test(server)) problems.push(`Server раскрывает версию: «${server}» (server_tokens off)`);

if (problems.length) {
  console.log(`Найдено ${problems.length}:`);
  for (const item of problems) console.log(` - ${item}`);
  process.exit(1);
}
console.log('Заголовки безопасности на месте: /, /assets, /activate, /api/health.');
