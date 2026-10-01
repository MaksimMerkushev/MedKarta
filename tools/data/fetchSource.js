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

const DEFAULT_UA = 'MedKartaBot/1.0 (+medical navigator for Kazan; contact: set DATA_BOT_CONTACT)';
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const HOST_DELAY_MS = 1_000;

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
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        // Нет robots.txt — ограничений нет; 401/403 на него — считаем «всё закрыто».
        if (response.status === 401 || response.status === 403) rules = () => false;
        else if (response.ok) rules = parseRobots(await response.text());
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
    if (!(await allowedByRobots(source.url))) return { status: 'blocked', code: 'robots_txt' };

    await politeWait(new URL(source.url).origin);
    const headers = { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml' };
    if (previous?.etag) headers['If-None-Match'] = previous.etag;
    if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;

    let response;
    try {
      response = await fetchImpl(source.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      return { status: 'error', code: error?.name === 'TimeoutError' ? 'timeout' : 'network' };
    }
    if (response.status === 304) return { status: 'not_modified' };
    if (!response.ok) return { status: 'error', code: `http_${response.status}` };

    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) return { status: 'error', code: 'too_large' };
    const body = await response.text();
    if (body.length > MAX_BYTES) return { status: 'error', code: 'too_large' };

    return {
      status: 'ok',
      body,
      etag: response.headers.get('etag') || null,
      lastModified: response.headers.get('last-modified') || null,
    };
  };

  return Object.freeze({ fetchSource, allowedByRobots });
};
