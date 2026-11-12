/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * HTTP-клиент адаптеров МИС. Запросы к МИС делает сервер, поэтому здесь —
 * защита от подделки адреса (SSRF):
 *   — только хосты из конфигурации интеграции (точное совпадение имени);
 *   — только https; http — лишь для локального симулятора вне production;
 *   — имя разрешается заранее, и адрес из частных, служебных и локальных
 *     сетей запрещён (кроме симулятора). Остаточный риск: fetch разрешает имя
 *     ещё раз, и между проверкой и запросом DNS-ответ можно подменить
 *     (rebinding). Он ограничен тем, что имена хостов задаёт администратор
 *     интеграции; закрыть полностью — закрепить адрес в dispatcher undici;
 *   — без редиректов, с тайм-аутом и пределом размера ответа, только JSON.
 * Тела запросов и ответов (в них бывают данные пациента) не журналируются.
 * Ошибки переводятся в MisError: timeout, unavailable, auth_failed, …
 */

import dns from 'node:dns/promises';
import net from 'node:net';

import { MisError } from './core.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;

/* Частные и служебные сети IPv4/IPv6 — туда сервер не ходит. */
export const isPrivateAddress = (address) => {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    return value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9')
      || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff');
  }
  return true;
};

/**
 * @param {object} options
 * @param {string} options.baseUrl адрес API МИС из конфигурации интеграции
 * @param {string[]} options.allowedHosts разрешённые имена хоста
 * @param {() => string|null} [options.authorization] значение заголовка Authorization (секрет — из окружения, не из базы)
 * @param {boolean} [options.allowPrivate] только для симулятора вне production
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.resolve] dns.lookup (для тестов)
 */
export const createMisHttpClient = ({
  baseUrl, allowedHosts, authorization = () => null, allowPrivate = false, timeoutMs = 8000,
  fetchImpl = globalThis.fetch, resolve = (host) => dns.lookup(host, { all: true }), production = process.env.NODE_ENV === 'production',
}) => {
  const base = new URL(baseUrl);
  const hosts = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (!hosts.has(base.hostname.toLowerCase())) throw new TypeError('МИС: хоста API нет в allowedHosts интеграции.');
  if (allowPrivate && production) throw new TypeError('МИС: allowPrivate (симулятор) в production запрещён.');
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && allowPrivate)) throw new TypeError('МИС: нужен https.');

  const checkHost = async (url) => {
    if (!hosts.has(url.hostname.toLowerCase())) throw new MisError('invalid_request', 'host_not_allowed');
    if (allowPrivate) return;
    let addresses;
    try {
      addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await resolve(url.hostname);
    } catch {
      throw new MisError('unavailable', 'dns');
    }
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new MisError('invalid_request', 'private_address');
  };

  /**
   * @param {string} method
   * @param {string} path путь относительно baseUrl (без схемы и хоста)
   * @param {object} [options] { query, body, headers }
   */
  const request = async (method, path, { query = null, body = undefined, headers = {} } = {}) => {
    if (/^[a-z]+:/i.test(path) || path.startsWith('//')) throw new MisError('invalid_request', 'absolute_path');
    const url = new URL(path.replace(/^\/+/, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
    if (url.origin !== base.origin) throw new MisError('invalid_request', 'origin_changed');
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    await checkHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const auth = authorization();
      response = await fetchImpl(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { Authorization: auth } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError') throw new MisError('timeout');
      throw new MisError('unavailable', typeof error?.cause?.code === 'string' ? error.cause.code : 'network');
    }
    try {
      if (response.status === 401 || response.status === 403) throw new MisError('auth_failed', `http_${response.status}`);
      if (response.status === 429) throw new MisError('rate_limited');
      if (response.status >= 500) throw new MisError('unavailable', `http_${response.status}`);
      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_RESPONSE_BYTES) throw new MisError('invalid_response', 'too_large');
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_BYTES) throw new MisError('invalid_response', 'too_large');
      let json = null;
      if (raw) {
        try {
          json = JSON.parse(raw);
        } catch {
          throw new MisError('invalid_response', 'not_json');
        }
      }
      return { status: response.status, json };
    } catch (error) {
      if (error?.name === 'AbortError') throw new MisError('timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({ request });
};
