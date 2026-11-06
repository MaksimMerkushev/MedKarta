/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Почта через Yandex Cloud Postbox без настоящей отправки: письмо (MIME,
 * UTF-8, отправитель, Reply-To, постоянный Message-ID), разбор ответов SMTP
 * по кодам Postbox, повторы только временных ошибок, обрыв после передачи
 * письма, суточная квота и пауза между письмами, журнал без секретов.
 * SMTP-сервер — сценарный, на 127.0.0.1: отвечает заданными строками.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { createDelivery, mailQuotaFromEnv } from '../backend/accounts/delivery.js';
import { createSqliteAccountStore } from '../backend/accounts/sqliteStore.js';
import { createMailer, MAIL_LIMITS, retryDelay } from '../backend/mail/outbox.js';
import { buildMessage, MailError, replyError, sendMail, smtpConfigFromEnv } from '../backend/mail/smtp.js';
import { renderMail } from '../backend/mail/templates.js';
import { logger } from '../backend/observability/safeLogger.js';
import { startSmtpServer } from './fixtures/smtpServer.js';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const FROM = 'notifications@navimed.test';
const TO = 'olga@medkarta.test';
const SMTP_KEY_ID = 'ajeKeyId4242';
const SMTP_SECRET = 'postbox-secret-part-0000';

/**
 * Сценарный SMTP-сервер: на каждую команду — заданный ответ, 'close' (оборвать
 * соединение) или 'silent' (молчать). Записывает команды, но не их аргументы.
 */
const scriptedSmtp = async (replies = {}) => {
  const commands = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    let inData = false;
    const answer = (reply) => {
      if (reply === 'close') socket.destroy();
      else if (reply !== 'silent') socket.write(`${reply}\r\n`);
    };
    answer(replies.greeting || '220 test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            answer(replies.message || '250 2.6.0 OK: queued as q-1a2b3c4d');
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        commands.push(verb);
        if (verb === 'EHLO') socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') answer(replies.auth || '235 2.7.0 Authentication successful');
        else if (verb === 'MAIL') answer(replies.mail || '250 2.1.0 Ok');
        else if (verb === 'RCPT') answer(replies.rcpt || '250 2.1.5 Ok');
        else if (verb === 'DATA') {
          const reply = replies.data || '354 End data with <CR><LF>.<CR><LF>';
          answer(reply);
          inData = reply.startsWith('354');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else socket.write('502 5.5.2 Unknown command\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    commands,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
};

const letter = () => buildMessage({ from: FROM, fromName: 'МедКарта', to: TO, subject: 'Проверка — МедКарта', text: 'Текст', html: '<p>Текст</p>' });

const sendTo = (port, extra = {}) => sendMail({
  host: '127.0.0.1', port, secure: 'none', allowInsecure: true, user: SMTP_KEY_ID, password: SMTP_SECRET,
  from: FROM, to: TO, message: letter(), timeoutMs: 2000, ...extra,
});

const failureOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('ожидалась ошибка');
  return null;
};

/** Заголовок письма, раскодированный из =?UTF-8?B?…?=. */
const header = (message, name) => {
  const line = message.split('\r\n').find((item) => item.startsWith(`${name}: `));
  return line?.slice(name.length + 2).replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, data) => Buffer.from(data, 'base64').toString('utf8')) ?? null;
};

/* ------------------------------- Письмо -------------------------------- */

describe('Почта: письмо для Postbox', () => {
  it('отправитель «МедКарта», UTF-8, MIME 1.0, Date, Message-ID, текст и HTML', () => {
    const message = buildMessage({ from: FROM, fromName: 'МедКарта', to: TO, subject: 'Подтверждение электронной почты — МедКарта', text: 'Здравствуйте!', html: '<p>Здравствуйте!</p>' });
    assert.equal(header(message, 'From'), `МедКарта <${FROM}>`);
    assert.equal(header(message, 'To'), `<${TO}>`);
    assert.equal(header(message, 'Subject'), 'Подтверждение электронной почты — МедКарта');
    assert.equal(header(message, 'MIME-Version'), '1.0');
    assert.match(header(message, 'Date'), /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} \+0000$/);
    assert.match(header(message, 'Message-ID'), /^<[a-f0-9]{32}@navimed\.test>$/);
    assert.match(message, /Content-Type: multipart\/alternative/);
    assert.match(message, /Content-Type: text\/plain; charset=utf-8/);
    assert.match(message, /Content-Type: text\/html; charset=utf-8/);
    assert.equal(header(message, 'Reply-To'), null, 'Reply-To — только если задан');
    assert.equal(header(message, 'List-Unsubscribe'), null, 'в письмах со ссылками отписки нет');
    const bodies = message.split(/\r\n\r\n/).slice(2).map((part) => Buffer.from(part.split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8'));
    assert.ok(bodies.some((part) => part.includes('Здравствуйте!')), 'русский текст в base64 раскодируется');
  });

  it('Reply-To — проверенный адрес; подстановка заголовков отвергается', () => {
    const message = buildMessage({ from: FROM, to: TO, replyTo: 'support@navimed.test', subject: 's', text: 't' });
    assert.equal(header(message, 'Reply-To'), '<support@navimed.test>');
    assert.throws(() => buildMessage({ from: FROM, to: TO, replyTo: 'support@navimed.test\r\nBcc: evil@z.ru', subject: 's', text: 't' }), (error) => error instanceof MailError && error.code === 'bad_address' && error.transient === false);
  });

  it('повтор письма из очереди — с тем же Message-ID; чужой id — случайный', () => {
    const first = buildMessage({ from: FROM, to: TO, subject: 's', text: 't', messageId: '0a1b2c3d4e5f60718293a4b5' });
    const again = buildMessage({ from: FROM, to: TO, subject: 's', text: 't', messageId: '0a1b2c3d4e5f60718293a4b5' });
    assert.equal(header(first, 'Message-ID'), '<mk.0a1b2c3d4e5f60718293a4b5@navimed.test>');
    assert.equal(header(again, 'Message-ID'), header(first, 'Message-ID'));
    assert.match(header(buildMessage({ from: FROM, to: TO, subject: 's', text: 't', messageId: '../x y>' }), 'Message-ID'), /^<[a-f0-9]{32}@navimed\.test>$/);
  });

  it('проверочное письмо: экранирование, текстовая версия, никакой медицины', () => {
    const mail = renderMail('smtp_check', { sentAt: Date.parse('2026-11-03T12:00:00+03:00') });
    assert.equal(mail.subject, 'Проверка почты — МедКарта');
    assert.match(mail.text, /3 ноября/);
    assert.match(mail.html, /<!doctype html>/);
    assert.doesNotMatch(`${mail.text}${mail.html}`, /симптом|диагноз|анализ|врач|<script/i);
  });
});

/* ------------------------------ Настройки ------------------------------ */

describe('Почта: настройки Postbox', () => {
  const POSTBOX = {
    SMTP_HOST: 'postbox.cloud.yandex.net', SMTP_PORT: '587', SMTP_SECURE: 'starttls', SMTP_USER: SMTP_KEY_ID, SMTP_PASSWORD: SMTP_SECRET,
    SMTP_FROM: `МедКарта <${FROM}>`, PUBLIC_BASE_URL: 'https://navimed.test',
  };

  it('587 + STARTTLS, логин — id ключа, пароль — его секрет; SMTP_TIMEOUT в секундах', () => {
    assert.deepEqual(smtpConfigFromEnv(POSTBOX), { host: 'postbox.cloud.yandex.net', port: 587, secure: 'starttls', user: SMTP_KEY_ID, password: SMTP_SECRET, allowInsecure: false });
    assert.equal(smtpConfigFromEnv({ ...POSTBOX, SMTP_TIMEOUT: '15' }).timeoutMs, 15_000);
    assert.ok(smtpConfigFromEnv({ ...POSTBOX, SMTP_TIMEOUT: '3' }).error);
    assert.ok(smtpConfigFromEnv({ ...POSTBOX, SMTP_TIMEOUT: 'долго' }).error);
    assert.equal(smtpConfigFromEnv({ ...POSTBOX, SMTP_PORT: '465', SMTP_SECURE: 'tls' }).secure, 'tls');
  });

  it('Reply-To и квоты; опечатка — проблема настройки, а не сломанная почта; секретов в описании нет', () => {
    const delivery = createDelivery({ env: { ...POSTBOX, SMTP_REPLY_TO: 'support@navimed.test' } });
    assert.equal(delivery.emailEnabled, true);
    assert.equal(delivery.replyTo, 'support@navimed.test');
    assert.deepEqual(delivery.quota, { dailyLimit: 200, minIntervalMs: 1000 });
    assert.doesNotMatch(JSON.stringify(delivery.describe()), new RegExp(`${SMTP_SECRET}|${SMTP_KEY_ID}`));

    const typo = createDelivery({ env: { ...POSTBOX, SMTP_REPLY_TO: 'support@', MAIL_DAILY_LIMIT: 'много' } });
    assert.equal(typo.emailEnabled, true);
    assert.equal(typo.replyTo, null);
    assert.equal(typo.quota.dailyLimit, 200);
    assert.equal(typo.problems.length, 2);
    assert.deepEqual(mailQuotaFromEnv({ MAIL_DAILY_LIMIT: '0', MAIL_MIN_INTERVAL_MS: '250' }), { dailyLimit: 0, minIntervalMs: 250, problems: [] });
    assert.equal(mailQuotaFromEnv({}, { smtp: false }).minIntervalMs, 0, 'подменённый транспорт паузу не ждёт');
  });
});

/* ------------------------- Ответы SMTP-сервера ------------------------- */

describe('Почта: ответы Postbox', () => {
  const reply = (line) => ({ code: Number(line.slice(0, 3)), lines: [line.slice(4)] });

  it('коды Postbox → коды МедКарты; 4xx — временно, 5xx — нет', () => {
    const cases = [
      ['421 4.3.0 Unexpected error.', 'greeting', 'smtp_temporary', true],
      ['451 4.4.2 Timeout waiting for data from client', 'message', 'smtp_temporary', true],
      ['454 Maximum sending rate exceeded', 'mail_from', 'smtp_rate', true],
      ['454 4.7.0 Temporary authentication failure', 'auth', 'smtp_temporary', true],
      ['535 5.7.8 Authentication failed', 'auth', 'smtp_auth', false],
      ['538 5.7.8 Authentication credentials invalid', 'auth', 'smtp_auth', false],
      ['534 5.7.8 Not enough permissions', 'auth', 'smtp_auth', false],
      ['550 5.4.5 Daily sending quota exceeded.', 'mail_from', 'smtp_quota', false],
      ['550 5.4.1 identity not verified', 'mail_from', 'smtp_sender', false],
      ['550 5.7.1 sender is not allowed', 'mail_from', 'smtp_sender', false],
      ['550 5.1.1 Mailbox unavailable', 'rcpt', 'smtp_rejected', false],
      ['552 5.3.4 message is too big (message size quota exceeded)', 'message', 'smtp_too_big', false],
      ['552 5.5.3 Maximum limit of 200 recipients reached', 'rcpt', 'smtp_recipients', false],
    ];
    for (const [line, stage, code, transient] of cases) {
      const error = replyError(reply(line), stage);
      assert.equal(error.code, code, line);
      assert.equal(error.transient, transient, line);
      assert.equal(error.status, Number(line.slice(0, 3)), line);
    }
    assert.equal(replyError(reply('550 5.4.5 Daily sending quota exceeded.'), 'mail_from').enhanced, '5.4.5');
  });

  it('RequestID из ответа сохраняется, остальной текст — нет', () => {
    const error = replyError(reply('550 5.4.1 identity not verified RequestID: 9f3c2a1b-77aa'), 'mail_from');
    assert.equal(error.requestId, '9f3c2a1b-77aa');
    assert.doesNotMatch(error.message, /identity|RequestID/);
  });
});

describe('Почта: настоящий SMTP-диалог со сценарным сервером', () => {
  it('250 «queued as» — принято в очередь; id провайдера возвращается', async () => {
    const smtp = await scriptedSmtp();
    try {
      const result = await sendTo(smtp.port);
      assert.deepEqual(result, { status: 250, queuedAs: 'q-1a2b3c4d', requestId: null });
      assert.deepEqual(smtp.commands, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    } finally {
      await smtp.close();
    }
  });

  it('проверка входа без письма: EHLO, AUTH, QUIT — и ни MAIL, ни DATA', async () => {
    const smtp = await scriptedSmtp();
    try {
      const result = await sendTo(smtp.port, { verifyOnly: true, to: undefined, message: undefined });
      assert.equal(result.status, 235);
      assert.deepEqual(smtp.commands, ['EHLO', 'AUTH', 'QUIT']);
    } finally {
      await smtp.close();
    }
  });

  it('отказ входа 535: smtp_auth без повтора, в ошибке нет ни ключа, ни секрета', async () => {
    const smtp = await scriptedSmtp({ auth: '535 5.7.8 Authentication failed RequestID: rq-77aa11bb' });
    try {
      const error = await failureOf(sendTo(smtp.port));
      assert.equal(error.code, 'smtp_auth');
      assert.equal(error.transient, false);
      assert.equal(error.requestId, 'rq-77aa11bb');
      assert.doesNotMatch(`${error.message}${JSON.stringify(error)}`, new RegExp(`${SMTP_SECRET}|${SMTP_KEY_ID}`));
      assert.ok(!smtp.commands.includes('MAIL'), 'после отказа входа письмо не передаётся');
    } finally {
      await smtp.close();
    }
  });

  it('временные ошибки: 421 при приветствии, 454 на MAIL, 451 после письма', async () => {
    for (const [replies, code] of [[{ greeting: '421 4.3.0 Unexpected error.' }, 'smtp_temporary'], [{ mail: '454 Maximum sending rate exceeded' }, 'smtp_rate'], [{ message: '451 4.4.2 Timeout waiting for data from client' }, 'smtp_temporary']]) {
      const smtp = await scriptedSmtp(replies);
      try {
        const error = await failureOf(sendTo(smtp.port));
        assert.equal(error.code, code, JSON.stringify(replies));
        assert.equal(error.transient, true);
      } finally {
        await smtp.close();
      }
    }
  });

  it('квота 550 5.4.5 и отправитель 550 5.4.1 — постоянные', async () => {
    for (const [replies, code] of [[{ mail: '550 5.4.5 Daily sending quota exceeded.' }, 'smtp_quota'], [{ mail: '550 5.4.1 identity not verified' }, 'smtp_sender'], [{ message: '552 5.3.4 Maximum message size exceeded' }, 'smtp_too_big']]) {
      const smtp = await scriptedSmtp(replies);
      try {
        const error = await failureOf(sendTo(smtp.port));
        assert.equal(error.code, code);
        assert.equal(error.transient, false);
      } finally {
        await smtp.close();
      }
    }
  });

  it('обрыв после передачи письма — smtp_uncertain: сервер мог письмо и принять', async () => {
    const smtp = await scriptedSmtp({ message: 'close' });
    try {
      const error = await failureOf(sendTo(smtp.port));
      assert.equal(error.code, 'smtp_uncertain');
      assert.equal(error.transient, true);
    } finally {
      await smtp.close();
    }
  });

  it('нет соединения и молчащий сервер — временные ошибки с понятным кодом', async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    const refused = await failureOf(sendTo(port));
    assert.equal(refused.code, 'smtp_connect');
    assert.equal(refused.transient, true);

    const smtp = await scriptedSmtp({ greeting: 'silent' });
    try {
      const silent = await failureOf(sendTo(smtp.port, { timeoutMs: 300 }));
      assert.equal(silent.code, 'smtp_timeout');
      assert.equal(silent.transient, true);
    } finally {
      await smtp.close();
    }
  });

  it('проверку сертификата не отключить параметрами TLS', async (t) => {
    let tlsOptions = null;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-postbox-'));
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
      tlsOptions = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
    } catch {
      t.skip('нет openssl для тестового сертификата');
      return;
    }
    const smtp = await startSmtpServer({ tlsOptions, implicitTls: true });
    try {
      const options = { host: '127.0.0.1', port: smtp.port, secure: 'tls', user: 'mailer', password: 'mail-secret', from: FROM, to: TO, message: letter(), timeoutMs: 2000 };
      const forced = await failureOf(sendMail({ ...options, tls: { rejectUnauthorized: false, minVersion: 'TLSv1' } }));
      assert.equal(forced.code, 'smtp_tls', 'самоподписанный сертификат без ca не принимается');
      const trusted = await sendMail({ ...options, tls: { ca: tlsOptions.cert, checkServerIdentity: () => undefined } });
      assert.equal(trusted.status, 250, 'с доверенным сертификатом — письмо уходит');
    } finally {
      await smtp.close();
    }
  });
});

/* -------------------------------- Очередь ------------------------------- */

describe('Почта: очередь, повторы и квоты', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  const setup = ({ deliver, quota = { dailyLimit: 200, minIntervalMs: 0 }, ...options } = {}) => {
    const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
    const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
    const calls = [];
    const delivery = {
      emailEnabled: true,
      quota,
      deliver: async (input) => {
        calls.push(input);
        return deliver(input, calls.length);
      },
    };
    const mailer = createMailer({ store, delivery, now: () => clock.t, random: () => 0.5, ...options });
    const enqueue = (to = TO) => mailer.enqueue({ kind: 'new_login', to, params: { name: 'Ольга', at: clock.t, client: 'Firefox' } });
    return { clock, store, mailer, calls, enqueue };
  };

  const recordsSince = (mark) => logger.__records.slice(mark);

  it('постоянная ошибка (535) — сразу failed, без повторов, в журнал уровнем error', async () => {
    const { store, mailer, calls, enqueue } = setup({ deliver: () => { throw new MailError('smtp_auth', 'SMTP 535', { transient: false, status: 535, enhanced: '5.7.8', requestId: 'rq-77aa11bb' }); } });
    const mark = logger.__records.length;
    const id = enqueue();
    await mailer.drain();
    assert.equal(calls.length, 1);
    assert.equal(store.getMail(id).status, 'failed');
    assert.equal(store.getMail(id).lastError, 'smtp_auth');
    const failed = recordsSince(mark).find((record) => record.event === 'mail.failed');
    assert.equal(failed.level, 'error');
    assert.equal(failed.error_code, 'smtp_auth');
    assert.equal(failed.smtp_status, 535);
    assert.equal(failed.smtp_enhanced, '5.7.8');
    assert.equal(failed.provider_request_id, 'rq-77aa11bb');
    assert.equal(failed.mail_id, id);
  });

  it('временная ошибка (454) — повтор через 30 с плюс случайная добавка, не больше пяти попыток', async () => {
    const { clock, store, mailer, calls, enqueue } = setup({ deliver: () => { throw new MailError('smtp_rate', 'SMTP 454', { status: 454 }); } });
    const id = enqueue();
    await mailer.drain();
    const queued = store.getMail(id);
    assert.equal(queued.status, 'pending');
    assert.equal(queued.lastError, 'smtp_rate');
    assert.equal(queued.nextAttemptAt, clock.t + 30_000 + 3_000, 'random 0,5 → +10 %');
    for (let step = 0; step < 10; step += 1) {
      clock.t += 40 * 60 * 1000;
      await mailer.drain();
    }
    assert.equal(calls.length, MAIL_LIMITS.MAX_ATTEMPTS);
    assert.equal(store.getMail(id).status, 'failed');
  });

  it('пауза перед повтором: ступени растут, добавка — не больше 20 %', () => {
    assert.equal(retryDelay(1, () => 0), 30_000);
    assert.ok(retryDelay(1, () => 0.999) < 36_000);
    assert.equal(retryDelay(2, () => 0), 2 * 60 * 1000);
    assert.equal(retryDelay(9, () => 0), 30 * 60 * 1000, 'дальше последней ступени не растёт');
  });

  it('обрыв после передачи письма — один повтор с тем же Message-ID, потом failed', async () => {
    const { clock, store, mailer, calls, enqueue } = setup({ deliver: () => { throw new MailError('smtp_uncertain'); } });
    const id = enqueue();
    await mailer.drain();
    assert.equal(store.getMail(id).status, 'pending');
    clock.t += 60 * 1000;
    await mailer.drain();
    assert.equal(calls.length, 2);
    assert.equal(store.getMail(id).status, 'failed');
    assert.deepEqual(calls.map((call) => call.messageId), [id, id], 'у повтора тот же id письма — тот же Message-ID');
  });

  it('принятое письмо — sent; в журнале id у провайдера и RequestID, но не адрес и не текст', async () => {
    const { store, mailer, enqueue } = setup({ deliver: () => ({ status: 250, queuedAs: 'q-1a2b3c4d', requestId: 'rq-77aa11bb' }) });
    const mark = logger.__records.length;
    const id = enqueue();
    await mailer.drain();
    assert.equal(store.getMail(id).status, 'sent');
    const sent = recordsSince(mark).find((record) => record.event === 'mail.sent');
    assert.equal(sent.provider_ref, 'q-1a2b3c4d');
    assert.equal(sent.provider_request_id, 'rq-77aa11bb');
    assert.doesNotMatch(JSON.stringify(recordsSince(mark)), /olga|Ольга|Firefox/);
  });

  it('суточная квота: сверх лимита письмо не ставится в очередь; не ушедшие (failed) не считаются', async () => {
    let fail = true;
    const { mailer, enqueue } = setup({ quota: { dailyLimit: 2, minIntervalMs: 0 }, deliver: () => { if (fail) throw new MailError('bad_address', 'x', { transient: false }); return null; } });
    assert.equal(mailer.allows({ kind: 'new_login', to: 'a@medkarta.test' }).allowed, true);
    enqueue('a@medkarta.test');
    await mailer.drain();
    fail = false;
    enqueue('b@medkarta.test');
    enqueue('c@medkarta.test');
    assert.deepEqual(mailer.allows({ kind: 'new_login', to: 'd@medkarta.test' }), { allowed: false, reason: 'daily_quota' });
    assert.deepEqual(mailer.allows({ kind: 'reset', to: 'e@medkarta.test' }), { allowed: false, reason: 'daily_quota' }, 'и для писем со ссылками');
  });

  it('заявки на регистрацию занимают не больше половины квоты: сброс пароля и уведомления проходят', async () => {
    const { mailer } = setup({ quota: { dailyLimit: 4, minIntervalMs: 0 } });
    const signup = (to) => mailer.enqueue({ kind: 'register_confirm', to, params: { link: 'https://medkarta.test/register/confirm#token=x', expiresAt: Date.now() + 60_000, ttlMinutes: 60 } });
    for (const to of ['a@medkarta.test', 'b@medkarta.test']) {
      assert.equal(mailer.allows({ kind: 'register_confirm', to }).allowed, true);
      signup(to);
    }
    assert.deepEqual(mailer.allows({ kind: 'register_confirm', to: 'c@medkarta.test' }), { allowed: false, reason: 'registration_quota' });
    assert.deepEqual(mailer.allows({ kind: 'register_exists', to: 'c@medkarta.test' }), { allowed: false, reason: 'registration_quota' });
    assert.equal(mailer.allows({ kind: 'reset', to: 'owner@medkarta.test' }).allowed, true, 'сброс пароля не зависит от заявок');
    assert.equal(mailer.allows({ kind: 'password_changed', to: 'owner@medkarta.test' }).allowed, true);
    await mailer.drain();
    assert.deepEqual(mailer.allows({ kind: 'register_confirm', to: 'c@medkarta.test' }), { allowed: false, reason: 'registration_quota' }, 'отправленные заявки тоже считаются');
  });

  it('один источник: не больше 30 писем со ссылками в сутки, даже если укладывается в часовой лимит', () => {
    const { mailer, clock } = setup({ quota: { dailyLimit: 0, minIntervalMs: 0 } });
    const send = (i) => mailer.enqueue({ kind: 'register_confirm', to: `s${i}@medkarta.test`, sourceKey: 'src', params: { link: 'https://medkarta.test/register/confirm#token=x', expiresAt: clock.t + 60_000, ttlMinutes: 60 } });
    for (let i = 0; i < 30; i += 1) {
      if (i > 0 && i % 10 === 0) clock.t += 61 * 60 * 1000;
      assert.equal(mailer.allows({ kind: 'register_confirm', to: `s${i}@medkarta.test`, sourceKey: 'src' }).allowed, true, `письмо ${i}`);
      send(i);
    }
    clock.t += 61 * 60 * 1000;
    assert.equal(mailer.allows({ kind: 'register_confirm', to: 'next@medkarta.test', sourceKey: 'src' }).allowed, false);
    assert.equal(mailer.allows({ kind: 'register_confirm', to: 'next@medkarta.test', sourceKey: 'other' }).allowed, true, 'другой источник не затронут');
  });

  it('не чаще письма в секунду: и очередь, и «отправить сразу» — по одному, с паузой', async () => {
    const sleeps = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { mailer, enqueue } = setup({
      quota: { dailyLimit: 200, minIntervalMs: 1000 },
      clock: () => 5_000,
      sleep: async (ms) => { sleeps.push(ms); },
      deliver: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return null;
      },
    });
    enqueue('a@medkarta.test');
    enqueue('b@medkarta.test');
    const direct = enqueue('c@medkarta.test');
    await Promise.all([mailer.sendNow(direct), mailer.drain()]);
    assert.equal(maxInFlight, 1, 'одновременно уходит одно письмо');
    assert.deepEqual(sleeps, [1000, 1000], 'перед вторым и третьим — пауза');
  });
});

/* -------------------------- Журнал без секретов ------------------------- */

describe('Почта: секреты SMTP не попадают в журнал', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, () => {
  it('отказ входа и успешная отправка через настоящий транспорт: ни ключа, ни секрета, ни ссылки, ни адреса', async () => {
    for (const replies of [{ auth: '535 5.7.8 Authentication failed RequestID: rq-77aa11bb' }, {}]) {
      const smtp = await scriptedSmtp(replies);
      try {
        const delivery = createDelivery({ env: {
          SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'none', SMTP_ALLOW_INSECURE: 'on',
          SMTP_USER: SMTP_KEY_ID, SMTP_PASSWORD: SMTP_SECRET, SMTP_FROM: `МедКарта <${FROM}>`, PUBLIC_BASE_URL: 'http://localhost:3000',
          MAIL_MIN_INTERVAL_MS: '0',
        } });
        const store = createSqliteAccountStore({ DatabaseSync, file: ':memory:' });
        const mailer = createMailer({ store, delivery });
        const mark = logger.__records.length;
        const link = 'http://localhost:3000/activate#token=SecretTokenValue0123456789abcdefghijKLMNOP';
        mailer.enqueue({ kind: 'reset', to: TO, params: { name: 'Ольга', link, expiresAt: Date.now() + 30 * 60 * 1000, ttlMinutes: 30 } });
        await mailer.drain();
        const journal = JSON.stringify(logger.__records.slice(mark));
        assert.match(journal, replies.auth ? /"error_code":"smtp_auth"/ : /"event":"mail.sent"/);
        for (const secret of [SMTP_SECRET, SMTP_KEY_ID, 'SecretTokenValue', TO, 'Ольга']) {
          assert.ok(!journal.includes(secret), `в журнале нет «${secret}»`);
        }
        store.close();
      } finally {
        await smtp.close();
      }
    }
  });
});
