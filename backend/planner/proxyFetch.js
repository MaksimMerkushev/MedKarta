/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Запросы к модели через прокси (AI_PROXY_URL).
 *
 * Зачем: OpenRouter не принимает запросы с российских адресов. Сервер в РФ
 * обращается к модели через прокси за рубежом. Через прокси идёт только
 * запрос к модели; карта, маршруты и кабинет работают напрямую.
 *
 * Как: туннель через прокси (HTTP CONNECT или SOCKS5), а внутри туннеля —
 * обычный TLS до самого провайдера с проверкой сертификата. Прокси видит
 * только имя хоста (openrouter.ai:443) и зашифрованный поток: ни ключа модели,
 * ни текста запроса он не видит. Логин и пароль от прокси передаются ему
 * открыто — так устроены оба протокола; это пароль от прокси, не от модели.
 *
 * Без зависимостей: node:net, node:tls, node:http, node:zlib.
 * Возвращает настоящий Response, поэтому подставляется вместо fetch.
 */

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

const HANDSHAKE_LIMIT = 16 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export class ProxyFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProxyFetchError';
    this.code = code;
  }
}

const configError = (message) => new ProxyFetchError('proxy_config', message);

const parsePort = (value) => {
  const port = Number(value);
  if (!/^\d{1,5}$/.test(String(value)) || port < 1 || port > 65535) throw configError('Порт прокси — число от 1 до 65535.');
  return port;
};

const checkHost = (host) => {
  if (!host || host.length > 253 || !(net.isIP(host) || /^[a-z0-9.-]+$/i.test(host))) {
    throw configError('Адрес прокси — IP или имя хоста.');
  }
  return host;
};

/**
 * Разбирает адрес прокси. Принимает форматы продавцов прокси:
 *   login:password@ip:port          — как выдают чаще всего (считается HTTP)
 *   ip:port:login:password          — второй частый формат
 *   ip:port                         — без пароля
 *   http://login:password@ip:port   — явная схема
 *   socks5://login:password@ip:port — SOCKS5 (имя хоста резолвит прокси)
 * В сообщениях об ошибках самого значения нет: в нём пароль.
 */
export const parseProxyUrl = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw configError('Адрес прокси пустой.');

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    const protocol = scheme[1].toLowerCase();
    const kind = protocol === 'http' ? 'http' : protocol === 'socks5' || protocol === 'socks5h' ? 'socks5' : null;
    if (!kind) throw configError('Поддерживаются прокси http:// и socks5://.');
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw configError('Адрес прокси не разобрать. Спецсимволы в пароле (@ : / #) нужно записать как %40 %3A %2F %23.');
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw configError('В адресе прокси не должно быть пути.');
    let username = '';
    let password = '';
    try {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      throw configError('Логин или пароль прокси записан с ошибкой в %-кодировке.');
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    return Object.freeze({ protocol: kind, host: checkHost(host), port: parsePort(url.port), username, password });
  }

  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const credentials = raw.slice(0, at);
    const address = raw.slice(at + 1);
    const colon = credentials.indexOf(':');
    const separator = address.lastIndexOf(':');
    if (colon <= 0 || separator <= 0) throw configError('Ожидается формат login:password@ip:port.');
    return Object.freeze({
      protocol: 'http',
      host: checkHost(address.slice(0, separator)),
      port: parsePort(address.slice(separator + 1)),
      username: credentials.slice(0, colon),
      password: credentials.slice(colon + 1),
    });
  }

  const parts = raw.split(':');
  if (parts.length === 2) {
    return Object.freeze({ protocol: 'http', host: checkHost(parts[0]), port: parsePort(parts[1]), username: '', password: '' });
  }
  if (parts.length >= 4) {
    return Object.freeze({
      protocol: 'http',
      host: checkHost(parts[0]),
      port: parsePort(parts[1]),
      username: parts[2],
      password: parts.slice(3).join(':'),
    });
  }
  throw configError('Ожидается формат login:password@ip:port.');
};

/** Адрес прокси без логина и пароля — для журналов и проверок. */
export const describeProxy = (proxy) => `${proxy.protocol}://${proxy.host.includes(':') ? `[${proxy.host}]` : proxy.host}:${proxy.port}`;

const abortReason = (signal) => signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');

/*
 * Чтение рукопожатия прокси по байтам. Обработчики снимаются до начала TLS:
 * дальше сокетом владеет TLS. Лишние байты после ответа прокси — нарушение
 * протокола (сервер не должен ничего слать, пока клиент не начал TLS).
 */
const createHandshakeReader = (socket) => {
  let buffer = Buffer.alloc(0);
  let waiter = null;
  let failure = null;

  const settle = () => {
    if (!waiter) return;
    if (failure) {
      const { reject } = waiter;
      waiter = null;
      reject(failure);
      return;
    }
    const result = waiter.take(buffer);
    if (result) {
      const { resolve } = waiter;
      waiter = null;
      buffer = buffer.subarray(result.used);
      resolve(result.value);
    }
  };
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > HANDSHAKE_LIMIT) failure = new ProxyFetchError('proxy_protocol', 'Прокси прислал слишком длинный ответ.');
    settle();
  };
  const onEnd = () => {
    failure ||= new ProxyFetchError('proxy_protocol', 'Прокси закрыл соединение во время подключения.');
    settle();
  };
  const onError = (error) => {
    failure ||= error instanceof ProxyFetchError ? error : new ProxyFetchError('proxy_connect', `Не удалось подключиться к прокси (${error?.code || 'ошибка сети'}).`);
    settle();
  };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('error', onError);

  return {
    /** take(buffer) → { value, used } или null, если байтов пока мало. */
    read: (take) => new Promise((resolve, reject) => {
      waiter = { take, resolve, reject };
      settle();
    }),
    bytes: (count) => new Promise((resolve, reject) => {
      waiter = { take: (data) => (data.length >= count ? { value: data.subarray(0, count), used: count } : null), resolve, reject };
      settle();
    }),
    release() {
      // Дальше сокетом владеет TLS (или HTTP-клиент): наши обработчики снимаются.
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      if (buffer.length > 0) throw new ProxyFetchError('proxy_protocol', 'Прокси прислал лишние данные после подключения.');
    },
  };
};

const httpConnect = async (socket, reader, proxy, host, port) => {
  const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.username || proxy.password) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64')}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const head = await reader.read((data) => {
    const end = data.indexOf('\r\n\r\n');
    return end === -1 ? null : { value: data.subarray(0, end).toString('latin1'), used: end + 4 };
  });
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
  if (status === 407) throw new ProxyFetchError('proxy_auth', 'Прокси не принял логин или пароль (407).');
  if (!(status >= 200 && status < 300)) {
    throw new ProxyFetchError('proxy_refused', `Прокси отказал в подключении${Number.isFinite(status) ? ` (${status})` : ''}.`);
  }
};

const SOCKS_REPLIES = {
  1: 'общая ошибка прокси',
  2: 'подключение запрещено правилами прокси',
  3: 'сеть недоступна',
  4: 'хост недоступен',
  5: 'соединение отклонено',
  6: 'истекло время ожидания',
  7: 'команда не поддерживается',
  8: 'тип адреса не поддерживается',
};

const socks5Connect = async (socket, reader, proxy, host, port) => {
  const withAuth = Boolean(proxy.username || proxy.password);
  socket.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [version, method] = await reader.bytes(2);
  if (version !== 5) throw new ProxyFetchError('proxy_protocol', 'Это не SOCKS5-прокси. Попробуйте схему http://.');
  if (method === 0xff) throw new ProxyFetchError('proxy_auth', 'SOCKS5-прокси требует другой способ входа.');
  if (method === 2) {
    const user = Buffer.from(proxy.username, 'utf8');
    const pass = Buffer.from(proxy.password, 'utf8');
    if (user.length > 255 || pass.length > 255) throw configError('Логин и пароль SOCKS5 — не длиннее 255 байт.');
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const [, status] = await reader.bytes(2);
    if (status !== 0) throw new ProxyFetchError('proxy_auth', 'Прокси не принял логин или пароль.');
  } else if (method !== 0) {
    throw new ProxyFetchError('proxy_protocol', 'SOCKS5-прокси выбрал неизвестный способ входа.');
  }

  let address;
  if (net.isIPv4(host)) {
    address = Buffer.from([1, ...host.split('.').map(Number)]);
  } else if (net.isIPv6(host)) {
    // Адрес модели — всегда имя хоста; IPv6-литерал через SOCKS5 не нужен.
    throw configError('IPv6-адрес модели через SOCKS5 не поддерживается — укажите имя хоста.');
  } else {
    const name = Buffer.from(host, 'utf8');
    if (name.length > 255) throw configError('Слишком длинное имя хоста.');
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]));

  const reply = await reader.read((data) => {
    if (data.length < 5) return null;
    const type = data[3];
    const length = type === 1 ? 4 + 4 + 2 : type === 4 ? 4 + 16 + 2 : type === 3 ? 4 + 1 + data[4] + 2 : -1;
    if (length === -1) return { value: data.subarray(0, 4), used: data.length };
    return data.length >= length ? { value: data.subarray(0, length), used: length } : null;
  });
  if (reply[0] !== 5) throw new ProxyFetchError('proxy_protocol', 'Прокси ответил не по протоколу SOCKS5.');
  if (reply[1] !== 0) {
    const code = reply[1] === 2 || reply[1] === 5 ? 'proxy_refused' : 'proxy_connect';
    throw new ProxyFetchError(code, `Прокси не смог подключиться: ${SOCKS_REPLIES[reply[1]] || `код ${reply[1]}`}.`);
  }
};

const normalizeHeaders = (headers) => {
  const result = {};
  if (!headers) return result;
  const entries = typeof headers.entries === 'function' && !Array.isArray(headers) ? headers.entries() : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    const name = String(key).toLowerCase();
    if (!HOP_BY_HOP.has(name) && value !== undefined) result[name] = String(value);
  }
  return result;
};

const toBodyBuffer = (body) => {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError('proxyFetch: тело запроса — строка или байты.');
};

const decode = (buffer, encoding, limit) => {
  const options = { maxOutputLength: limit };
  switch ((encoding || '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return buffer;
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buffer, options);
    case 'deflate':
      return zlib.inflateSync(buffer, options);
    case 'br':
      return zlib.brotliDecompressSync(buffer, options);
    default:
      throw new ProxyFetchError('upstream_encoding', 'Неизвестное сжатие ответа.');
  }
};

/**
 * fetch через прокси.
 *
 * @param {object} options
 * @param {string|object} options.proxy адрес прокси (см. parseProxyUrl) или результат разбора
 * @param {number} [options.connectTimeoutMs] подключение к прокси, туннель и TLS
 * @param {number} [options.idleTimeoutMs] тишина в соединении после отправки запроса
 * @param {number} [options.maxResponseBytes] потолок ответа (после распаковки)
 * @param {object} [options.tlsOptions] дополнительные параметры TLS (в тестах — свой ca)
 */
export const createProxyFetch = ({
  proxy,
  connectTimeoutMs = 10_000,
  idleTimeoutMs = 30_000,
  maxResponseBytes = 2 * 1024 * 1024,
  tlsOptions = {},
} = {}) => {
  const config = typeof proxy === 'string' ? parseProxyUrl(proxy) : proxy;
  if (!config?.host || !config?.port || !['http', 'socks5'].includes(config.protocol)) throw configError('Не задан адрес прокси.');

  return async function proxyFetch(input, init = {}) {
    const target = new URL(typeof input === 'string' ? input : input?.url ?? String(input));
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new TypeError('proxyFetch: только http и https.');
    const secure = target.protocol === 'https:';
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = Number(target.port) || (secure ? 443 : 80);
    const method = String(init.method || 'GET').toUpperCase();
    const body = toBodyBuffer(init.body);
    const signal = init.signal || null;
    if (signal?.aborted) throw abortReason(signal);

    const sockets = new Set();
    let request = null;
    let onAbort = null;

    const destroyAll = (error) => {
      request?.destroy(error);
      for (const socket of sockets) socket.destroy();
    };

    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let handshakeTimer = null;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(handshakeTimer);
          destroyAll();
          reject(error);
        };
        const succeed = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        onAbort = () => fail(abortReason(signal));
        signal?.addEventListener('abort', onAbort, { once: true });

        const raw = net.connect({ host: config.host, port: config.port });
        sockets.add(raw);
        raw.setNoDelay(true);
        handshakeTimer = setTimeout(() => fail(new ProxyFetchError('proxy_timeout', 'Прокси не ответил вовремя.')), connectTimeoutMs);
        const reader = createHandshakeReader(raw);
        // Постоянный обработчик: ошибка сокета без слушателя уронила бы процесс.
        raw.on('error', (error) => fail(new ProxyFetchError('proxy_connect', `Ошибка соединения с прокси (${error?.code || 'ошибка сети'}).`)));

        const start = async () => {
          await new Promise((ready, broken) => {
            raw.once('connect', ready);
            raw.once('error', broken);
          }).catch((error) => {
            throw new ProxyFetchError('proxy_connect', `Не удалось подключиться к прокси (${error?.code || 'ошибка сети'}).`);
          });
          if (config.protocol === 'socks5') await socks5Connect(raw, reader, config, host, port);
          else await httpConnect(raw, reader, config, host, port);
          reader.release();

          let channel = raw;
          if (secure) {
            channel = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'], ...tlsOptions });
            sockets.add(channel);
            await new Promise((ready, broken) => {
              channel.once('secureConnect', ready);
              channel.once('error', broken);
            }).catch((error) => {
              throw new ProxyFetchError('tls', `TLS-соединение с ${host} не прошло проверку (${error?.code || 'ошибка TLS'}).`);
            });
          }
          clearTimeout(handshakeTimer);
          if (settled) return;

          const headers = normalizeHeaders(init.headers);
          headers.host = target.host;
          headers.connection = 'close';
          headers['accept-encoding'] ||= 'identity';
          if (body) headers['content-length'] = String(body.length);
          else if (!['GET', 'HEAD'].includes(method)) headers['content-length'] = '0';

          request = http.request({
            method,
            path: `${target.pathname}${target.search}`,
            headers,
            createConnection: () => channel,
          });
          request.setTimeout(idleTimeoutMs, () => fail(new ProxyFetchError('upstream_timeout', 'Модель не ответила вовремя.')));
          request.on('error', (error) => fail(error instanceof ProxyFetchError ? error : new ProxyFetchError('upstream_connect', `Соединение с ${host} прервалось (${error?.code || 'ошибка сети'}).`)));
          request.on('response', (response) => {
            const status = response.statusCode;
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > maxResponseBytes) {
                fail(new ProxyFetchError('upstream_too_large', 'Ответ модели слишком большой.'));
                return;
              }
              chunks.push(chunk);
            });
            response.on('error', () => fail(new ProxyFetchError('upstream_connect', `Соединение с ${host} прервалось.`)));
            response.on('end', () => {
              try {
                if (!(status >= 200 && status <= 599)) throw new ProxyFetchError('upstream_protocol', `Неожиданный статус ответа: ${status}.`);
                const decoded = decode(Buffer.concat(chunks), response.headers['content-encoding'], maxResponseBytes);
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(response.headers)) {
                  if (name === 'content-encoding' || name === 'content-length' || name === 'transfer-encoding') continue;
                  for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
                }
                responseHeaders.set('content-length', String(decoded.length));
                const payload = NULL_BODY_STATUSES.has(status) || method === 'HEAD' ? null : decoded;
                succeed(new Response(payload, { status, statusText: response.statusMessage || '', headers: responseHeaders }));
              } catch (error) {
                fail(error instanceof ProxyFetchError ? error : new ProxyFetchError('upstream_protocol', 'Не удалось прочитать ответ модели.'));
              } finally {
                for (const socket of sockets) socket.destroy();
              }
            });
          });
          request.end(body || undefined);
        };

        start().catch((error) => {
          clearTimeout(handshakeTimer);
          fail(error instanceof ProxyFetchError ? error : new ProxyFetchError('proxy_connect', 'Не удалось подключиться через прокси.'));
        });
      });
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
};
