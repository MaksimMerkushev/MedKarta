/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Загрузка источников данных: сайты клиник и локальные файлы.
 *
 * Правила вежливого сборщика, без которых нельзя ходить на чужие сайты:
 *   - представляемся (User-Agent с контактом), а не прикидываемся браузером;
 *   - читаем robots.txt и не трогаем запрещённое;
 *   - не чаще одного запроса в секунду к одному сайту;
 *   - условные запросы (ETag / Last-Modified): неизменная страница
 *     возвращает 304 и не грузит ни сайт, ни нас;
 *   - потолок размера и времени ответа.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';

const DEFAULT_UA = 'MedKartaBot/1.0 (+medical navigator for Kazan; contact: set DATA_BOT_CONTACT)';
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 256 * 1024;
const TIMEOUT_MS = 15_000;
const HOST_DELAY_MS = 1_000;
const MAX_REDIRECTS = 3;

/*
 * Адреса, на которые сборщик не ходит ни при каких условиях: локальная
 * машина, внутренние сети, метаданные облака. Проверяется адрес из URL;
 * перенаправления на другой сайт не выполняются вовсе (см. fetchSource).
 */
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
export const isPrivateHost = (hostname) => {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const version = isIP(host);
  if (version === 4) return PRIVATE_V4.some((pattern) => pattern.test(host));
  if (version === 6) return host === '::1' || host === '::' || /^(?:fc|fd|fe80)/.test(host) || host.startsWith('::ffff:');
  return false;
};

/** Тот же сайт: совпадает хост или отличается только «www.». */
export const sameSite = (left, right) => {
  try {
    const strip = (value) => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
    return strip(left) === strip(right);
  } catch {
    return false;
  }
};

/*
 * Чтение тела с потолком по БАЙТАМ, по мере поступления. Раньше тело
 * читалось целиком (response.text()), и проверка размера шла после: ответ
 * без Content-Length или «gzip-бомба» в 300 КБ, разжимавшаяся в 300 МБ,
 * доводили процесс до 700 МБ — на сервере с 2 ГБ это падение.
 */
const readLimited = async (response, maxBytes) => {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0) };
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: 'too_large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
};

/*
 * Кодировка: из Content-Type, затем из <meta charset> в начале страницы.
 * Сайты на windows-1251 раньше читались как UTF-8 и превращались в «�»,
 * а сравнение снимков видело «изменилось всё».
 */
const decodeBody = (bytes, contentType) => {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '')?.[1];
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const fromMeta = /<meta[^>]{0,200}charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase()).decode(bytes);
    } catch {
      // неизвестная кодировка — пробуем следующую
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
};

/**
 * Минимальный разбор robots.txt: группы User-agent «*» и наша, Disallow и
 * Allow с самым длинным совпадением. Этого достаточно, чтобы не ходить туда,
 * куда просят не ходить.
 */
export const parseRobots = (text, agent = 'medkartabot') => {
  const groups = [];
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const [, key, value] = match;
    const field = key.toLowerCase();
    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'disallow' || field === 'allow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  const own = groups.filter((group) => group.agents.some((name) => name && agent.includes(name) && name !== '*'));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes('*'));
  const rules = chosen.flatMap((group) => group.rules).filter((rule) => rule.path);

  return (pathname) => {
    let best = null;
    for (const rule of rules) {
      const prefix = rule.path.replace(/\*$/, '');
      if (pathname.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
        best = { prefix, allow: rule.allow };
      }
    }
    return !best || best.allow;
  };
};

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.root] корень проекта для источников-файлов
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export const createFetcher = ({
  fetchImpl = globalThis.fetch,
  root = process.cwd(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  userAgent = process.env.DATA_BOT_UA || (process.env.DATA_BOT_CONTACT ? `MedKartaBot/1.0 (+${process.env.DATA_BOT_CONTACT})` : DEFAULT_UA),
} = {}) => {
  const robotsCache = new Map();
  const lastHit = new Map();

  const politeWait = async (host) => {
    const wait = (lastHit.get(host) || 0) + HOST_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  };

  const allowedByRobots = async (url) => {
    const { origin, pathname } = new URL(url);
    if (!robotsCache.has(origin)) {
      let rules = () => true;
      try {
        await politeWait(origin);
        const response = await fetchImpl(`${origin}/robots.txt`, {
          headers: { 'User-Agent': userAgent },
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Нет robots.txt — ограничений нет; 401/403 на него — считаем «всё закрыто».
        if (response.status === 401 || response.status === 403) rules = () => false;
        else if (response.ok) {
          const read = await readLimited(response, MAX_ROBOTS_BYTES);
          // Огромный robots.txt — не повод читать его в память целиком; считаем «всё закрыто».
          rules = read.error ? () => false : parseRobots(new TextDecoder('utf-8').decode(read.bytes));
        } else {
          await response.body?.cancel().catch(() => {});
        }
      } catch {
        // Не ответил — ведём себя так, будто запретов нет, но страницу всё равно
        // запросим с теми же паузами и потолками.
      }
      robotsCache.set(origin, rules);
    }
    return robotsCache.get(origin)(pathname);
  };

  /**
   * @param {object} source {type: 'http'|'file', url|path}
   * @param {object} [previous] {etag, lastModified} прошлого снимка
   * @param {object} [vars] подстановки в путь файла ({version})
   * @returns {Promise<{status: 'ok'|'not_modified'|'blocked'|'error', body?: string, etag?: string,
   *   lastModified?: string, code?: string}>}
   */
  const fetchSource = async (source, previous = null, vars = {}) => {
    if (source.type === 'file') {
      const relative = String(source.path || '').replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? source.defaults?.[key] ?? '');
      const absolute = path.resolve(root, relative);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) return { status: 'error', code: 'path_outside_root' };
      try {
        return { status: 'ok', body: await fs.readFile(absolute, 'utf8') };
      } catch {
        return { status: 'error', code: 'file_not_found' };
      }
    }

    if (source.type !== 'http' || !/^https?:\/\//.test(source.url || '')) return { status: 'error', code: 'bad_source' };
    if (isPrivateHost(new URL(source.url).hostname)) return { status: 'error', code: 'private_address' };

    const headers = { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;

    /*
     * Перенаправления — вручную и только в пределах того же сайта. Раньше
     * fetch следовал за любым редиректом, в том числе на 127.0.0.1 и адреса
     * внутренней сети, а robots.txt и паузы применялись лишь к исходному хосту.
     */
    let url = source.url;
    let response;
    for (let hop = 0; ; hop += 1) {
      if (!(await allowedByRobots(url))) return { status: 'blocked', code: 'robots_txt' };
      await politeWait(new URL(url).origin);
      try {
        response = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (error) {
        return { status: 'error', code: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) return { status: 'error', code: 'redirect' };
      let next;
      try {
        next = new URL(location, url);
      } catch {
        return { status: 'error', code: 'redirect' };
      }
      if (!/^https?:$/.test(next.protocol) || !sameSite(next.href, source.url) || isPrivateHost(next.hostname)) {
        return { status: 'error', code: 'redirect_offsite' };
      }
      url = next.href;
    }
    if (response.status === 304) return { status: 'not_modified' };
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: 'error', code: `http_${response.status}` };
    }

    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) {
      await response.body?.cancel().catch(() => {});
      return { status: 'error', code: 'too_large' };
    }
    const read = await readLimited(response, MAX_BYTES);
    if (read.error) return { status: 'error', code: read.error };

    return {
      status: 'ok',
      body: decodeBody(read.bytes, response.headers.get('content-type')),
      etag: response.headers.get('etag') || null,
      lastModified: response.headers.get('last-modified') || null,
    };
  };

  return Object.freeze({ fetchSource, allowedByRobots });
};
