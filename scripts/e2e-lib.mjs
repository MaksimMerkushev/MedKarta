/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общее для сквозных проверок в браузере (scripts/e2e-*.mjs): запуск
 * сервера на временной базе, шаги с итогом, виртуальный ключ доступа
 * (WebAuthn через протокол отладки Chromium — настоящая церемония в
 * браузере, ключ хранится в памяти теста), коды TOTP, учебная почта.
 * Только для проверок: в приложении не используется.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base32Decode, hotp, stepAt } from '../backend/accounts/totp.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Проверка окружения: собранный фронтенд и Playwright. */
export const requireBrowser = async () => {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.error('Нет dist/: сначала npm run build.');
    process.exit(2);
  }
  try {
    return (await import(process.env.PLAYWRIGHT_MODULE || 'playwright')).chromium;
  } catch {
    console.error('Нет Playwright: npm i --no-save playwright && npx playwright install chromium');
    process.exit(2);
  }
  return null;
};

export const shotsDir = () => {
  const index = process.argv.indexOf('--shots');
  const dir = index > 0 ? path.resolve(process.argv[index + 1]) : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

/** Сервер МедКарты на заданном окружении. output — всё, что он написал (для проверки журналов). */
export const createServer = ({ env, base }) => {
  let child = null;
  const state = { output: '' };
  const start = async () => {
    child = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { state.output += chunk; });
    child.stderr.on('data', (chunk) => { state.output += chunk; });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${base}/api/config`);
        if (response.ok) return;
      } catch {
        // ещё стартует
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`сервер не запустился:\n${state.output.slice(-2000)}`);
  };
  const stop = async () => {
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    child = null;
  };
  return { start, stop, state };
};

/** Шаги с итогом. stopOnFail — прервать сценарий после первой ошибки. */
export const createSteps = ({ stopOnFail = false } = {}) => {
  const results = [];
  const step = async (name, work) => {
    const started = Date.now();
    try {
      await work();
      results.push({ name, ok: true, ms: Date.now() - started });
      console.log(`  ✓ ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      console.log(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
      process.exitCode = 1;
      if (stopOnFail) throw error;
    }
  };
  const summary = () => {
    const passed = results.filter((item) => item.ok).length;
    console.log(`\n${passed} из ${results.length} сценариев пройдено${process.exitCode ? ' — есть ошибки' : ''}.`);
  };
  return { step, results, summary };
};

export const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* --------------------------------- TOTP --------------------------------- */

/**
 * Коды приложения-аутентификатора для теста. Сервер не принимает один и тот
 * же шаг дважды — next() ждёт следующего 30-секундного окна, если текущее
 * уже использовано.
 */
export const totpDevice = (secretBase32) => {
  const secret = base32Decode(secretBase32);
  let lastStep = -1;
  return {
    async next() {
      let step = stepAt(Date.now());
      if (step <= lastStep) {
        await new Promise((resolve) => setTimeout(resolve, (lastStep + 1) * 30_000 - Date.now() + 300));
        step = stepAt(Date.now());
      }
      lastStep = step;
      return hotp(secret, step);
    },
    wrong: () => String((Number(hotp(secret, stepAt(Date.now()))) + 500_000) % 1_000_000).padStart(6, '0'),
  };
};

/* ---------------------------- ключ доступа ---------------------------- */

/**
 * Виртуальный ключ доступа на странице (WebAuthn в Chromium через CDP):
 * отпечаток «подтверждается» автоматически. Ключи можно перенести на другую
 * страницу или в другой браузер (exportCredentials / importCredentials) —
 * как синхронизация ключей между устройствами одного человека.
 */
export const attachAuthenticator = async (page) => {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return {
    async exportCredentials() {
      return (await client.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
    },
    async importCredentials(credentials) {
      for (const credential of credentials) await client.send('WebAuthn.addCredential', { authenticatorId, credential });
    },
    async count() {
      return (await client.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length;
    },
  };
};

/* --------------------------------- почта --------------------------------- */

/** Текстовая часть письма из учебного SMTP-сервера (base64 в multipart/alternative). */
export const mailText = (message) => {
  const parts = message.data.split(/\r\n--mk_[0-9a-f]+/);
  const textPart = parts.find((part) => /Content-Type: text\/plain/i.test(part)) || message.data;
  const body = textPart.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/--\s*$/u, '').replace(/\s/g, '');
  return Buffer.from(body, 'base64').toString('utf8');
};

export const mailSubject = (message) => {
  const match = message.data.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=/m);
  return match ? Buffer.from(match[1], 'base64').toString('utf8') : '';
};

export const linkOf = (text) => text.match(/https?:\/\/\S+#token=[A-Za-z0-9_-]{43}/)?.[0] || null;

/** Дождаться письма на адрес (учебный SMTP-сервер складывает их в массив). */
export const waitForMail = async (smtp, to, { after = 0, timeout = 15_000, subject = null } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = smtp.messages.slice(after).find((message) => message.to.includes(to) && (!subject || subject.test(mailSubject(message))));
    if (found) return { ...found, text: mailText(found), subject: mailSubject(found) };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`письмо на ${to} не пришло за ${timeout / 1000} с`);
};
