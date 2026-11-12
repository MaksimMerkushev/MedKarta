/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Шаблон nginx (deploy/nginx): заголовки безопасности для страниц и статики,
 * которые отдаёт nginx, совпадают с теми, что ставит Node; каждый блок,
 * отдающий файлы, их подключает (add_header в location отменяет заголовки
 * уровня server). Синтаксис проверяет только `nginx -t` на сервере.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FILES } from '../scripts/nginx-config.mjs';
import { SECURITY_HEADERS } from '../backend/http/securityHeaders.js';

const DIR = fileURLToPath(new URL('../deploy/nginx/', import.meta.url));
const site = fs.readFileSync(`${DIR}navimed.tech.conf`, 'utf8').replace(/#.*$/gm, '');
const proxy = fs.readFileSync(`${DIR}medkarta-proxy.conf`, 'utf8').replace(/#.*$/gm, '');

/* Блоки location верхнего уровня внутри server: «location … { … }» без вложенных скобок. */
const locations = (text) => [...text.matchAll(/location\s+([^{]+)\{([^{}]*)\}/g)].map((match) => ({ path: match[1].trim(), body: match[2] }));

describe('nginx: заголовки безопасности', () => {
  it('фрагменты совпадают с генератором и содержат все заголовки Node', () => {
    for (const [name, render] of Object.entries(FILES)) {
      assert.equal(fs.readFileSync(`${DIR}${name}`, 'utf8'), render(), `${name} устарел: node scripts/nginx-config.mjs`);
    }
    const snippet = fs.readFileSync(`${DIR}security-headers.conf`, 'utf8');
    for (const name of Object.keys(SECURITY_HEADERS)) assert.match(snippet, new RegExp(`add_header ${name} "[^"]+" always;`), name);
    assert.match(fs.readFileSync(`${DIR}security-headers-token-pages.conf`, 'utf8'), /add_header Referrer-Policy "no-referrer" always;/);
  });

  it('каждый блок, отдающий файлы, подключает заголовки; API проксируется в Node', () => {
    const blocks = locations(site);
    const serving = blocks.filter((block) => /try_files/.test(block.body));
    assert.ok(serving.length >= 3, 'ожидались блоки для /, /assets/ и страниц с ключом');
    for (const block of serving) assert.match(block.body, /include \/etc\/nginx\/snippets\/security-headers[-a-z]*\.conf;/, `location ${block.path}`);
    const api = blocks.filter((block) => /\/api/.test(block.path));
    assert.ok(api.length >= 3);
    for (const block of api) assert.match(block.body, /include \/etc\/nginx\/snippets\/medkarta-proxy\.conf;/, `location ${block.path}`);
  });

  it('HTTPS, скрытая версия, пределы тела и времени, только свои имена сайта', () => {
    assert.match(site, /return 301 https:\/\/navimed\.tech\$request_uri;/);
    assert.match(site, /server_tokens off;/);
    assert.match(site, /client_max_body_size \d+k;/);
    assert.match(site, /client_body_timeout \d+s;/);
    assert.match(site, /server_name _;[\s\S]*?return 444;/, 'запросы на чужие имена закрываются');
    assert.match(site, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
    assert.match(site, /limit_req zone=medkarta_chat/);
  });

  it('прокси передаёт имя сайта и адрес клиента, но не доверяет пришедшему X-Forwarded-For', () => {
    assert.match(proxy, /proxy_set_header Host \$host;/);
    assert.match(proxy, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.doesNotMatch(proxy, /\$proxy_add_x_forwarded_for/);
    assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);
  });
});
