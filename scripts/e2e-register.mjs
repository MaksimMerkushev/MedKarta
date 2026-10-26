#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка регистрации и писем в настоящем браузере (Chromium,
 * компьютер 1440 px и телефон 375 px) с учебным SMTP-сервером на
 * 127.0.0.1 — письма никуда не уходят, реальные адреса не используются:
 *   — регистрация: email → письмо → «Продолжить» → пароль → вход;
 *   — повторная регистрация на занятый адрес: тот же ответ в интерфейсе,
 *     владельцу — письмо «вы уже зарегистрированы» без ссылки создания;
 *   — повторная отправка письма (прежняя ссылка гаснет), ссылка в другом
 *     браузере, просроченная ссылка;
 *   — восстановление пароля по ссылке из письма и письмо «Пароль изменён»;
 *   — смена email с подтверждением нового адреса (и подтверждением личности);
 *   — пользователь включает приложение-аутентификатор (QR-код) и входит с кодом;
 *   — восстановление пароля при включённой MFA: без второго фактора пароль
 *     не меняется, с кодом из приложения — вход;
 *   — ни токены, ни ссылки из писем не попадают в журналы сервера.
 *
 *   node scripts/e2e-register.mjs [--shots каталог]
 */

/* global window, document -- код внутри page.evaluate выполняется в браузере */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startSmtpServer } from '../tests/fixtures/smtpServer.js';
import { createServer, createSteps, expect, linkOf, requireBrowser, shotsDir, totpDevice, waitForMail } from './e2e-lib.mjs';

const chromium = await requireBrowser();
const SHOTS = shotsDir();
const PORT = Number(process.env.E2E_PORT) || 4220;
const BASE = `http://localhost:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-e2e-register-'));
const smtp = await startSmtpServer();

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  DEMO_DATA: 'on',
  ANALYTICS: 'off',
  COOKIE_SECURE: 'off',
  ACCOUNTS_DB_PATH: path.join(WORK, 'accounts.sqlite'),
  DEMO_BOOKING_DB_PATH: path.join(WORK, 'booking.sqlite'),
  ADMIN_BOOTSTRAP_PASSWORD: '',
  TRUST_PROXY: '1',
  TRUSTED_PROXIES: '',
  // Учебный SMTP-сервер на этом же компьютере: без TLS можно только для localhost.
  SMTP_URL: '',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtp.port),
  SMTP_SECURE: 'none',
  SMTP_ALLOW_INSECURE: 'on',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  SMTP_FROM: 'МедКарта <noreply@medkarta.test>',
  APP_URL: '',
  PUBLIC_BASE_URL: BASE,
  REGISTRATION_MODE: 'open',
  MFA_SECRET_KEY: randomBytes(32).toString('base64'),
};
const server = createServer({ env, base: BASE });
const { step, summary } = createSteps();

const sqlite = async (work) => {
  const { loadSqlite } = await import('../backend/accounts/sqliteStore.js');
  const DatabaseSync = await loadSqlite();
  const db = new DatabaseSync(env.ACCOUNTS_DB_PATH);
  try {
    return work(db);
  } finally {
    db.close();
  }
};

let clientNumber = 0;
const nextClientIp = () => {
  clientNumber += 1;
  return `10.88.${Math.floor(clientNumber / 250)}.${(clientNumber % 250) + 1}`;
};

let browser;
const pageErrors = [];
const tokens = [];
const newPage = async ({ width = 1440 } = {}) => {
  const context = await browser.newContext({
    viewport: { width, height: width < 500 ? 812 : 900 },
    extraHTTPHeaders: { 'X-Forwarded-For': nextClientIp() },
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  return page;
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
const settle = (page) => page.waitForTimeout(400);
const noOverflow = async (page, where) => {
  const sizes = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid=auth-page]') || document.querySelector('[data-testid=profile-page]');
    return { doc: document.documentElement.scrollWidth - window.innerWidth, page: scroller ? scroller.scrollWidth - scroller.clientWidth : 0 };
  });
  expect(sizes.doc <= 0 && sizes.page <= 0, `${where}: горизонтальная прокрутка ${JSON.stringify(sizes)}`);
};
const tokenOf = (link) => link.split('#token=')[1];
const signIn = async (page, email, password) => {
  await page.fill('[data-testid=login-email]', email);
  await page.click('[data-testid=login-continue]');
  await page.fill('[data-testid=login-password]', password);
  await page.click('[data-testid=login-submit]');
};
const accountOf = (page) => page.evaluate(() => fetch('/api/account').then((response) => response.json()).then((body) => body.user));

/** Регистрация через интерфейс до письма: вернуть ссылку из него. */
const requestRegistration = async (page, email, { shots = null } = {}) => {
  await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid=register-email]');
  if (shots) {
    await settle(page);
    await noOverflow(page, 'регистрация: email');
    await shot(page, `${shots}-1-email`);
  }
  const before = smtp.messages.length;
  await page.fill('[data-testid=register-email]', email);
  await page.click('[data-testid=register-submit]');
  await page.waitForSelector('[data-testid=register-sent]');
  if (shots) {
    await settle(page);
    await noOverflow(page, 'регистрация: письмо отправлено');
    await shot(page, `${shots}-2-sent`);
  }
  const mail = await waitForMail(smtp, email, { after: before });
  return { mail, link: linkOf(mail.text) };
};

const PASSWORD = 'Летний-вечер-над-Казанкой';

try {
  await server.start();
  browser = await chromium.launch();

  console.log('Регистрация:');
  await step('С компьютера: «Создать аккаунт» на странице входа → письмо → пароль → вход', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=auth-register]');
    await page.click('[data-testid=auth-register]');
    await page.waitForURL((url) => url.pathname === '/register');
    const { mail, link } = await requestRegistration(page, 'ivan.novikov@medkarta.test');
    expect(mail.subject === 'Подтверждение электронной почты — МедКарта', `тема письма: ${mail.subject}`);
    expect(/Content-Type: text\/html/i.test(mail.data), 'нет HTML-версии письма');
    expect(link && link.startsWith(`${BASE}/register/confirm#token=`), `ссылка: ${String(link).replace(/token=.*/, 'token=…')}`);
    tokens.push(tokenOf(link));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=register-confirm]');
    expect(!page.url().includes('token'), 'токен остался в адресе');
    await page.click('[data-testid=register-continue]');
    await page.waitForSelector('[data-testid=register-password-input]');
    await page.fill('[data-testid=register-first-name]', 'Иван');
    await page.fill('[data-testid=register-password-input]', 'qwerty12345');
    await page.click('[data-testid=register-complete]');
    await page.waitForSelector('[data-testid=auth-error]');
    await page.fill('[data-testid=register-password-input]', PASSWORD);
    expect(Number(await page.getAttribute('[data-testid=password-strength]', 'data-score')) >= 2, 'индикатор надёжности не показал оценку');
    await page.click('[data-testid=register-complete]');
    await page.waitForSelector('[data-testid=register-success]');
    await page.waitForURL((url) => url.pathname === '/', { timeout: 8000 });
    const user = await accountOf(page);
    expect(user?.email === 'ivan.novikov@medkarta.test' && user.role === 'user' && user.emailVerified, `аккаунт: ${JSON.stringify(user)}`);
    await page.context().close();
  });

  await step('С телефона (375 px): все шаги без горизонтальной прокрутки', async () => {
    const page = await newPage({ width: 375 });
    const { link } = await requestRegistration(page, 'olga.mobile@medkarta.test', { shots: 'register-375' });
    tokens.push(tokenOf(link));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=register-confirm]');
    await settle(page);
    await noOverflow(page, 'регистрация: подтверждение');
    await shot(page, 'register-375-3-confirm');
    await page.click('[data-testid=register-continue]');
    await page.waitForSelector('[data-testid=register-password-input]');
    await page.fill('[data-testid=register-password-input]', 'Ольга-и-белые-ночи-2026');
    await settle(page);
    await noOverflow(page, 'регистрация: пароль');
    await shot(page, 'register-375-4-password');
    await page.click('[data-testid=register-complete]');
    await page.waitForSelector('[data-testid=register-success]');
    await settle(page);
    await shot(page, 'register-375-5-success');
    await page.context().close();
  });

  await step('Занятый адрес: тот же ответ, владельцу — письмо без ссылки создания аккаунта', async () => {
    const page = await newPage();
    const { mail, link } = await requestRegistration(page, 'ivan.novikov@medkarta.test');
    expect(/уже зарегистрированы/u.test(mail.subject), `тема: ${mail.subject}`);
    expect(!link || !link.includes('/register/confirm'), 'письмо на занятый адрес содержит ссылку регистрации');
    await page.context().close();
  });

  await step('Повторное письмо: прежняя ссылка гаснет; ссылка, открытая в другом браузере, — «уже использована»', async () => {
    const page = await newPage();
    const first = await requestRegistration(page, 'petr.twice@medkarta.test');
    const before = smtp.messages.length;
    await page.click('[data-testid=register-change-email]');
    await page.click('[data-testid=register-submit]');
    await page.waitForSelector('[data-testid=register-sent]');
    const second = await waitForMail(smtp, 'petr.twice@medkarta.test', { after: before });
    const secondLink = linkOf(second.text);
    tokens.push(tokenOf(first.link), tokenOf(secondLink));
    await page.goto(first.link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=register-problem][data-code=link_revoked]');
    await page.goto(secondLink, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=register-continue]');
    await page.waitForSelector('[data-testid=register-password-input]');
    const stranger = await newPage();
    await stranger.goto(secondLink, { waitUntil: 'domcontentloaded' });
    await stranger.waitForSelector('[data-testid=register-problem][data-code=link_used]');
    await settle(stranger);
    await shot(stranger, 'register-link-used-1440');
    await stranger.context().close();
    await page.context().close();
  });

  await step('Просроченная ссылка — понятная ошибка и путь «Зарегистрироваться заново»', async () => {
    const page = await newPage({ width: 375 });
    const { link } = await requestRegistration(page, 'late.person@medkarta.test');
    tokens.push(tokenOf(link));
    await sqlite((db) => db.prepare('UPDATE registrations SET expires_at = ?').run(Date.now() - 1000));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=register-problem][data-code=link_expired]');
    await settle(page);
    await noOverflow(page, 'регистрация: ссылка истекла');
    await shot(page, 'register-expired-375');
    await page.click('[data-testid=link-again]');
    await page.waitForURL((url) => url.pathname === '/register');
    await page.context().close();
  });

  console.log('Восстановление и смена email:');
  await step('Забыли пароль: письмо → новый пароль → прежний не подходит; письмо «Пароль изменён»', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('[data-testid=login-email]', 'ivan.novikov@medkarta.test');
    await page.click('[data-testid=login-continue]');
    await page.click('[data-testid=auth-no-password]');
    const before = smtp.messages.length;
    await page.click('[data-testid=access-submit]');
    await page.waitForSelector('[data-testid=auth-step-sent]');
    const mail = await waitForMail(smtp, 'ivan.novikov@medkarta.test', { after: before, subject: /Восстановление пароля/u });
    const link = linkOf(mail.text);
    tokens.push(tokenOf(link));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    await page.fill('[data-testid=activation-password-input]', 'Осенний-дождь-над-Волгой');
    const changedAt = smtp.messages.length;
    await page.click('[data-testid=activation-submit]');
    await page.waitForSelector('[data-testid=activation-success]');
    await waitForMail(smtp, 'ivan.novikov@medkarta.test', { after: changedAt, subject: /Пароль изменён/u });
    const old = await newPage();
    await old.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(old, 'ivan.novikov@medkarta.test', PASSWORD);
    await old.waitForSelector('[data-testid=auth-error]');
    await old.context().close();
    await page.context().close();
  });

  await step('Смена email: подтверждение личности, письмо на новый адрес, вход с новым email', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/login?next=${encodeURIComponent('/profile#security')}`, { waitUntil: 'domcontentloaded' });
    await signIn(page, 'ivan.novikov@medkarta.test', 'Осенний-дождь-над-Волгой');
    await page.waitForURL((url) => url.pathname === '/profile', { timeout: 8000 });
    await page.waitForSelector('[data-testid=email-change]');
    // Подтверждение личности «устарело» (как через 10 минут после входа).
    await sqlite((db) => db.prepare('UPDATE sessions SET reauth_at = 1').run());
    await page.click('[data-testid=email-change]');
    await page.fill('[data-testid=email-new]', 'ivan.new@medkarta.test');
    const before = smtp.messages.length;
    await page.click('[data-testid=email-change-submit]');
    await page.waitForSelector('[data-testid=reauth-dialog]');
    await page.fill('[data-testid=reauth-password]', 'Осенний-дождь-над-Волгой');
    await page.click('[data-testid=reauth-submit]');
    await page.waitForSelector('[data-testid=email-sent]');
    const mail = await waitForMail(smtp, 'ivan.new@medkarta.test', { after: before });
    await waitForMail(smtp, 'ivan.novikov@medkarta.test', { after: before, subject: /смена email/iu });
    const link = linkOf(mail.text);
    expect(link?.startsWith(`${BASE}/email/confirm#token=`), 'нет ссылки подтверждения');
    tokens.push(tokenOf(link));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=email-confirm]');
    await settle(page);
    await shot(page, 'email-confirm-1440');
    await page.click('[data-testid=email-confirm-submit]');
    await page.waitForSelector('[data-testid=email-confirm-success]');
    expect((await accountOf(page))?.email === 'ivan.new@medkarta.test', 'email не сменился в этой сессии');
    const fresh = await newPage({ width: 375 });
    await fresh.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(fresh, 'ivan.new@medkarta.test', 'Осенний-дождь-над-Волгой');
    await fresh.waitForURL((url) => url.pathname === '/', { timeout: 8000 });
    await fresh.context().close();
    await page.context().close();
  });

  console.log('Двухфакторная защита пользователя:');
  // Приложение-аутентификатор Ольги — нужен и в сценарии восстановления пароля.
  let olgaDevice = null;
  await step('Телефон: приложение-аутентификатор по QR-коду (после подтверждения личности), резервные коды, вход с кодом', async () => {
    const page = await newPage({ width: 375 });
    await page.goto(`${BASE}/login?next=${encodeURIComponent('/profile#security')}`, { waitUntil: 'domcontentloaded' });
    await signIn(page, 'olga.mobile@medkarta.test', 'Ольга-и-белые-ночи-2026');
    await page.waitForURL((url) => url.pathname === '/profile', { timeout: 8000 });
    await page.click('[data-testid=mfa-add-totp]');
    // Вход подтверждением личности не считается: новый способ входа — только после пароля.
    await page.waitForSelector('[data-testid=reauth-dialog]');
    await page.fill('[data-testid=reauth-password]', 'Ольга-и-белые-ночи-2026');
    await page.click('[data-testid=reauth-submit]');
    await page.waitForSelector('[data-testid=totp-qr]');
    await page.click('text=Показать ключ');
    const secret = (await page.textContent('[data-testid=totp-secret]')).replace(/\s/g, '');
    expect(/^[A-Z2-7]{32}$/.test(secret), `секрет: ${secret.length} символов`);
    await settle(page);
    await shot(page, 'totp-setup-375');
    const device = totpDevice(secret);
    olgaDevice = device;
    await page.fill('[data-testid=totp-confirm-code]', await device.next());
    await page.click('[data-testid=totp-confirm]');
    await page.waitForSelector('[data-testid=recovery-codes]');
    await settle(page);
    await noOverflow(page, 'резервные коды');
    await shot(page, 'recovery-codes-375');
    await page.click('[data-testid=recovery-done]');
    await page.waitForSelector('[data-testid=mfa-status][data-enabled=true]');
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(page, 'olga.mobile@medkarta.test', 'Ольга-и-белые-ночи-2026');
    await page.waitForSelector('[data-testid=auth-step-mfa]');
    await page.click('[data-testid=mfa-use-totp]').catch(() => null);
    await page.fill('[data-testid=mfa-code]', await device.next());
    await page.waitForURL((url) => url.pathname === '/', { timeout: 40_000 });
    expect((await accountOf(page))?.email === 'olga.mobile@medkarta.test', 'вход с кодом не выполнен');
    await page.context().close();
  });

  await step('Забыли пароль при включённой MFA: ссылка из письма без второго фактора пароль не меняет; с кодом — вход', async () => {
    const OLD = 'Ольга-и-белые-ночи-2026';
    const NEW = 'Ольга-сменила-пароль-по-ссылке';
    const page = await newPage({ width: 375 });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('[data-testid=login-email]', 'olga.mobile@medkarta.test');
    await page.click('[data-testid=login-continue]');
    await page.click('[data-testid=auth-no-password]');
    const before = smtp.messages.length;
    await page.click('[data-testid=access-submit]');
    await page.waitForSelector('[data-testid=auth-step-sent]');
    const mail = await waitForMail(smtp, 'olga.mobile@medkarta.test', { after: before, subject: /Восстановление пароля/u });
    const link = linkOf(mail.text);
    tokens.push(tokenOf(link));
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    await page.fill('[data-testid=activation-password-input]', NEW);
    await page.click('[data-testid=activation-submit]');
    // После пароля — второй фактор; пароль ещё не изменён, сессии нет.
    await page.waitForSelector('[data-testid=activation-mfa]');
    expect(await accountOf(page) === null, 'сессия выдана до второго фактора');
    const bare = await page.evaluate((password) => fetch('/api/auth/activation/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    }).then(async (response) => ({ status: response.status, code: (await response.json()).code })), NEW);
    expect(bare.status === 403 && bare.code === 'mfa_required', `пароль без второго фактора: ${JSON.stringify(bare)}`);
    await settle(page);
    await noOverflow(page, 'смена пароля: второй фактор');
    await shot(page, 'reset-mfa-375');
    const check = await newPage();
    await check.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(check, 'olga.mobile@medkarta.test', NEW);
    await check.waitForSelector('[data-testid=auth-error]');
    await check.context().close();
    // Неверный код — понятная ошибка, пароль не меняется.
    await page.fill('[data-testid=mfa-code]', olgaDevice.wrong());
    await page.waitForSelector('[data-testid=activation-mfa] [data-testid=auth-error]');
    await settle(page);
    await noOverflow(page, 'смена пароля: неверный код');
    await shot(page, 'reset-mfa-error-375');
    // Верный код — пароль изменён, вход выполнен.
    const changedAt = smtp.messages.length;
    await page.fill('[data-testid=mfa-code]', await olgaDevice.next());
    await page.waitForSelector('[data-testid=activation-success]', { timeout: 40_000 });
    await page.waitForURL((url) => url.pathname === '/', { timeout: 8000 });
    expect((await accountOf(page))?.email === 'olga.mobile@medkarta.test', 'вход после смены пароля не выполнен');
    await waitForMail(smtp, 'olga.mobile@medkarta.test', { after: changedAt, subject: /Пароль изменён/u });
    const old = await newPage();
    await old.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(old, 'olga.mobile@medkarta.test', OLD);
    await old.waitForSelector('[data-testid=auth-error]');
    await old.context().close();
    await page.context().close();
  });

  await step('Письма: в каждом — текст и HTML, отправитель и тема; токенов и ссылок в журналах сервера нет', async () => {
    expect(smtp.messages.length >= 10, `писем: ${smtp.messages.length}`);
    for (const message of smtp.messages) {
      expect(/^From: .*<noreply@medkarta\.test>/m.test(message.data), 'нет отправителя');
      expect(/multipart\/alternative/.test(message.data), 'письмо без HTML-версии');
    }
    for (const token of tokens) expect(!server.state.output.includes(token), 'токен найден в журнале сервера');
    expect(!/#token=/.test(server.state.output), 'ссылка с токеном в журнале сервера');
  });

  await step('Ошибок JavaScript на страницах нет', async () => {
    expect(pageErrors.length === 0, pageErrors.join('; '));
  });
} catch (error) {
  console.log(`  ✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.stop();
  await smtp.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  summary();
}
