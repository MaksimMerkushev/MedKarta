/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Отправка письма по SMTP без внешних зависимостей: node:net и node:tls.
 * Поддерживается то, что нужно почтовым сервисам: TLS сразу (порт 465) или
 * STARTTLS (порт 587), AUTH PLAIN и LOGIN, одно письмо — одному адресату.
 *
 * Пароль SMTP передаётся только внутри TLS: без шифрования клиент
 * авторизоваться откажется (кроме явного allowInsecure для локальной отладки).
 * Ошибки возвращаются кодом, без текста ответа сервера: в нём бывают адреса.
 */

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import tls from 'node:tls';

export class MailError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MailError';
    this.code = code;
  }
}

const LINE_LIMIT = 64 * 1024;
const ADDRESS = /^[^\s<>()[\]\\,;:"@]{1,64}@[a-z0-9.-]{1,253}$/i;

/** Адрес без переводов строк и угловых скобок — защита от подстановки заголовков. */
export const checkAddress = (value) => {
  const address = String(value || '').trim();
  if (!ADDRESS.test(address)) throw new MailError('bad_address', 'Некорректный адрес');
  return address;
};

const encodeWord = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);

// Переводы строк в тексте — CRLF, как требует RFC 5322 и для закодированного тела.
const base64Lines = (text) => Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');

/**
 * Письмо в формате RFC 5322: text/plain и text/html одним multipart/alternative,
 * тело в base64 — без проблем с длинными строками и точками в начале строки.
 */
export const buildMessage = ({ from, fromName = '', to, subject, text, html = null, date = new Date() }) => {
  const sender = checkAddress(from);
  const recipient = checkAddress(to);
  const cleanSubject = String(subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  const cleanName = String(fromName).replace(/[\r\n"<>]+/g, ' ').trim().slice(0, 80);
  const domain = sender.split('@')[1];
  const boundary = `mk_${randomBytes(12).toString('hex')}`;
  const headers = [
    `From: ${cleanName ? `${encodeWord(cleanName)} ` : ''}<${sender}>`,
    `To: <${recipient}>`,
    `Subject: ${encodeWord(cleanSubject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
  ];
  if (!html) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(text)].join('\r\n');
  }
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
};

/** Читатель ответов SMTP поверх сокета: многострочные ответы «250-…» собираются целиком. */
const createReader = (getSocket, timeoutMs) => {
  let buffer = '';
  let pending = null;
  let failure = null;

  const tryResolve = () => {
    if (!pending) return;
    if (failure) {
      const { reject } = pending;
      pending = null;
      reject(failure);
      return;
    }
    const lines = [];
    let offset = 0;
    for (;;) {
      const end = buffer.indexOf('\r\n', offset);
      if (end < 0) return;
      const line = buffer.slice(offset, end);
      offset = end + 2;
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        buffer = buffer.slice(offset);
        const { resolve, timer } = pending;
        clearTimeout(timer);
        pending = null;
        resolve({ code: Number(line.slice(0, 3)), lines: lines.map((item) => item.slice(4)) });
        return;
      }
    }
  };

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > LINE_LIMIT) failure = new MailError('smtp_protocol', 'Слишком длинный ответ сервера');
    tryResolve();
  };
  const onError = (error) => {
    failure ||= new MailError(error?.code === 'ETIMEDOUT' ? 'smtp_timeout' : 'smtp_connect', 'Соединение с почтовым сервером прервано');
    tryResolve();
  };
  const onClose = () => {
    failure ||= new MailError('smtp_closed', 'Почтовый сервер закрыл соединение');
    tryResolve();
  };

  return {
    attach(socket) {
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    },
    detach(socket) {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
    read() {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null;
          reject(new MailError('smtp_timeout', 'Почтовый сервер не ответил вовремя'));
          getSocket()?.destroy();
        }, timeoutMs);
        pending = { resolve, reject, timer };
        tryResolve();
      });
    },
    reset() {
      buffer = '';
    },
  };
};

const expect = (reply, codes, code) => {
  if (!codes.includes(reply.code)) throw new MailError(code, `SMTP ${reply.code}`);
  return reply;
};

/**
 * Отправить одно письмо.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {'tls'|'starttls'|'none'} options.secure tls — сразу (465), starttls — обязательно поднять TLS (587)
 * @param {string} [options.user]
 * @param {string} [options.password]
 * @param {string} options.from адрес отправителя (envelope)
 * @param {string} options.to адрес получателя
 * @param {string} options.message готовое письмо (buildMessage)
 * @param {boolean} [options.allowInsecure] разрешить вход без TLS (только локальная отладка)
 * @param {object} [options.tls] доп. параметры TLS (ca для тестов)
 */
export const sendMail = async ({
  host, port, secure = 'starttls', user = '', password = '', from, to, message, heloName = 'medkarta.local',
  allowInsecure = false, timeoutMs = 20_000, tls: tlsOptions = {},
}) => {
  const sender = checkAddress(from);
  const recipient = checkAddress(to);
  let socket = null;
  const reader = createReader(() => socket, timeoutMs);

  const connect = () => new Promise((resolve, reject) => {
    const onError = (error) => reject(new MailError(error?.code === 'ECONNREFUSED' ? 'smtp_connect' : 'smtp_tls', 'Не удалось подключиться к почтовому серверу'));
    const created = secure === 'tls'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...tlsOptions }, () => resolve(created))
      : net.connect({ host, port }, () => resolve(created));
    created.setTimeout(timeoutMs, () => created.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    created.once('error', onError);
  });

  const write = (line) => socket.write(`${line}\r\n`);
  const command = async (line, codes, code) => {
    write(line);
    return expect(await reader.read(), codes, code);
  };

  try {
    socket = await connect();
    reader.attach(socket);
    expect(await reader.read(), [220], 'smtp_greeting');
    let ehlo = await command(`EHLO ${heloName}`, [250], 'smtp_ehlo');
    let encrypted = secure === 'tls';

    if (secure === 'starttls') {
      if (!ehlo.lines.some((line) => /^STARTTLS\b/i.test(line))) throw new MailError('smtp_no_starttls', 'Сервер не поддерживает STARTTLS');
      await command('STARTTLS', [220], 'smtp_starttls');
      reader.detach(socket);
      reader.reset();
      const plain = socket;
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, ...tlsOptions }, () => resolve(upgraded));
        upgraded.once('error', () => reject(new MailError('smtp_tls', 'Не удалось установить TLS с почтовым сервером')));
      });
      reader.attach(socket);
      encrypted = true;
      ehlo = await command(`EHLO ${heloName}`, [250], 'smtp_ehlo');
    }

    if (user) {
      if (!encrypted && !allowInsecure) throw new MailError('smtp_insecure', 'Вход на почтовый сервер без TLS запрещён');
      const authLine = ehlo.lines.find((line) => /^AUTH\b/i.test(line)) || '';
      if (/\bPLAIN\b/i.test(authLine)) {
        await command(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')}`, [235], 'smtp_auth');
      } else if (/\bLOGIN\b/i.test(authLine)) {
        await command('AUTH LOGIN', [334], 'smtp_auth');
        await command(Buffer.from(user, 'utf8').toString('base64'), [334], 'smtp_auth');
        await command(Buffer.from(password, 'utf8').toString('base64'), [235], 'smtp_auth');
      } else {
        throw new MailError('smtp_auth', 'Сервер не предлагает поддерживаемый способ входа');
      }
    }

    await command(`MAIL FROM:<${sender}>`, [250], 'smtp_rejected');
    await command(`RCPT TO:<${recipient}>`, [250, 251], 'smtp_rejected');
    await command('DATA', [354], 'smtp_rejected');
    // Точка в начале строки удваивается (RFC 5321, 4.5.2); письмо заканчивается «.».
    const body = String(message).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    socket.write(`${body}${body.endsWith('\r\n') ? '' : '\r\n'}.\r\n`);
    expect(await reader.read(), [250], 'smtp_rejected');
    write('QUIT');
    await reader.read().catch(() => null);
  } finally {
    socket?.end();
    socket?.destroy();
  }
};

/**
 * Настройки SMTP из окружения:
 *   SMTP_URL=smtps://login:пароль@smtp.example.ru:465 (TLS сразу)
 *   SMTP_URL=smtp://login:пароль@smtp.example.ru:587  (обязательный STARTTLS)
 * или SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE=tls|starttls.
 * null — SMTP не настроен.
 */
export const smtpConfigFromEnv = (env = process.env) => {
  let host = null;
  let port = null;
  let secure = null;
  let user = '';
  let password = '';
  if (env.SMTP_URL) {
    let url;
    try {
      url = new URL(env.SMTP_URL);
    } catch {
      return { error: 'SMTP_URL: некорректный адрес' };
    }
    if (!['smtp:', 'smtps:'].includes(url.protocol)) return { error: 'SMTP_URL: нужна схема smtp:// или smtps://' };
    host = url.hostname;
    secure = url.protocol === 'smtps:' ? 'tls' : 'starttls';
    port = Number(url.port) || (secure === 'tls' ? 465 : 587);
    try {
      user = decodeURIComponent(url.username || '');
      password = decodeURIComponent(url.password || '');
    } catch {
      return { error: 'SMTP_URL: некорректно закодированы логин или пароль' };
    }
  } else if (env.SMTP_HOST) {
    host = env.SMTP_HOST;
    secure = ['tls', 'starttls', 'none'].includes(env.SMTP_SECURE) ? env.SMTP_SECURE : 'starttls';
    port = Number(env.SMTP_PORT) || (secure === 'tls' ? 465 : 587);
    user = env.SMTP_USER || '';
    password = env.SMTP_PASSWORD || '';
  } else {
    return null;
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { error: 'SMTP: некорректный сервер или порт' };
  const allowInsecure = env.SMTP_ALLOW_INSECURE === 'on' && ['localhost', '127.0.0.1', '::1'].includes(host);
  if (secure === 'none' && !allowInsecure) return { error: 'SMTP без TLS разрешён только для localhost и SMTP_ALLOW_INSECURE=on' };
  return { host, port, secure, user, password, allowInsecure };
};
