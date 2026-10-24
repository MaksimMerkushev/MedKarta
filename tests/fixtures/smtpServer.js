/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Учебный SMTP-сервер для тестов: принимает письма на 127.0.0.1 и складывает
 * их в массив. Поддерживает EHLO, STARTTLS (если переданы ключ и сертификат),
 * AUTH PLAIN и LOGIN, MAIL, RCPT, DATA, QUIT — ровно то, чем пользуется
 * backend/mail/smtp.js. Только для тестов: в приложении не используется.
 */

import net from 'node:net';
import tls from 'node:tls';

export const startSmtpServer = async ({ tlsOptions = null, implicitTls = false, user = 'mailer', password = 'mail-secret', rejectRcpt = false } = {}) => {
  const messages = [];
  const sessions = [];

  const handle = (initial) => {
    let socket = initial;
    let buffer = '';
    let inData = false;
    let data = '';
    let authStep = null;
    const state = { from: null, to: [], auth: null, tls: Boolean(implicitTls) };
    sessions.push(state);
    const send = (line) => socket.write(`${line}\r\n`);

    const onLine = (line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push({ from: state.from, to: [...state.to], data: data.replace(/^\.\./gm, '.'), auth: state.auth, tls: state.tls });
          data = '';
          send('250 2.0.0 Ok: queued');
        } else {
          data += `${line}\r\n`;
        }
        return;
      }
      if (authStep === 'user') {
        state.pendingUser = Buffer.from(line, 'base64').toString('utf8');
        authStep = 'password';
        send(`334 ${Buffer.from('Password:').toString('base64')}`);
        return;
      }
      if (authStep === 'password') {
        const given = Buffer.from(line, 'base64').toString('utf8');
        authStep = null;
        if (state.pendingUser === user && given === password) {
          state.auth = { user, method: 'LOGIN' };
          send('235 2.7.0 Authentication successful');
        } else {
          send('535 5.7.8 Authentication failed');
        }
        return;
      }
      const [verb, ...rest] = line.split(' ');
      const argument = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          send('250-test.smtp');
          if (tlsOptions && !state.tls) send('250-STARTTLS');
          send('250-AUTH PLAIN LOGIN');
          send('250 8BITMIME');
          break;
        case 'STARTTLS': {
          send('220 2.0.0 Ready to start TLS');
          socket.removeAllListeners('data');
          const secure = new tls.TLSSocket(socket, { isServer: true, ...tlsOptions });
          socket = secure;
          state.tls = true;
          buffer = '';
          secure.on('data', onData);
          break;
        }
        case 'AUTH': {
          const [method, initialResponse] = argument.split(' ');
          if (method.toUpperCase() === 'PLAIN') {
            const [, name, secret] = Buffer.from(initialResponse || '', 'base64').toString('utf8').split('\u0000');
            if (name === user && secret === password) {
              state.auth = { user, method: 'PLAIN' };
              send('235 2.7.0 Authentication successful');
            } else {
              send('535 5.7.8 Authentication failed');
            }
          } else {
            authStep = 'user';
            send(`334 ${Buffer.from('Username:').toString('base64')}`);
          }
          break;
        }
        case 'MAIL':
          state.from = argument.replace(/^FROM:\s*<|>$/gi, '');
          send('250 2.1.0 Ok');
          break;
        case 'RCPT':
          if (rejectRcpt) {
            send('550 5.1.1 Mailbox unavailable');
            break;
          }
          state.to.push(argument.replace(/^TO:\s*<|>$/gi, ''));
          send('250 2.1.5 Ok');
          break;
        case 'DATA':
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
          break;
        case 'QUIT':
          send('221 2.0.0 Bye');
          socket.end();
          break;
        default:
          send('502 5.5.2 Command not recognized');
      }
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    };

    socket.on('data', onData);
    socket.on('error', () => {});
    send('220 test.smtp ESMTP ready');
  };

  const server = implicitTls ? tls.createServer(tlsOptions, handle) : net.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    messages,
    sessions,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
