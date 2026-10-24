#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка входа и приглашений в настоящем браузере:
 *   — экраны /login и /activate при ширине 375, 768 и 1440 px (светлая и
 *     тёмная тема): нет горизонтальной прокрутки, заголовок не прыгает при
 *     смене шага, снимки экранов;
 *   — вход существующего пользователя с возвратом по ?next=, сессия
 *     переживает перезагрузку;
 *   — несуществующий email и неактивированный аккаунт неотличимы от
 *     неверного пароля; запрос ссылки не выдаёт, есть ли аккаунт;
 *   — неверный, просроченный, отозванный, повторно использованный токен;
 *     заблокированный аккаунт; две вкладки с одной ссылкой; другой браузер;
 *   — токен уходит из адреса сразу и не попадает в журналы сервера;
 *   — только клавиатура; prefers-reduced-motion; требования к паролю;
 *   — второй фактор при входе: ключ доступа (виртуальный ключ WebAuthn в
 *     Chromium), код из приложения, резервный код (одноразовый), неверный
 *     код; добавление ключа в профиле; подтверждение личности перед
 *     удалением способа входа; последний способ сотрудник удалить не может;
 *   — регистрация в режиме «только по приглашению» закрыта.
 *
 * Нужны собранный фронтенд (npm run build) и Playwright с Chromium
 * (npm i --no-save playwright && npx playwright install chromium).
 * Сервер поднимается сам на временной базе; почта не настроена — ссылки
 * передаются вручную, как в админ-панели без SMTP. Регистрация и письма —
 * scripts/e2e-register.mjs.
 *
 *   node scripts/e2e-auth.mjs [--shots каталог]
 */

/* global window, document, getComputedStyle -- код внутри page.evaluate выполняется в браузере */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex > 0 ? path.resolve(process.argv[shotsIndex + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('Нет dist/: сначала npm run build.');
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  console.error('Нет Playwright: npm i --no-save playwright && npx playwright install chromium');
  process.exit(2);
}

const PORT = Number(process.env.E2E_PORT) || 4210;
// localhost, а не 127.0.0.1: ключи доступа (WebAuthn) работают только на доменном имени.
const BASE = `http://localhost:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-e2e-auth-'));
const ROOT_EMAIL = 'maximka2703@bk.ru';
const ROOT_PASSWORD = `Е2Е-${randomBytes(9).toString('base64url')}-корень`;
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
  ADMIN_BOOTSTRAP_EMAIL: ROOT_EMAIL,
  ADMIN_BOOTSTRAP_PASSWORD: ROOT_PASSWORD,
  // Каждый браузер в проверке — «свой» клиент со своим адресом (X-Forwarded-For
  // от локального «прокси»): иначе все сценарии упёрлись бы в лимиты одного IP.
  TRUST_PROXY: '1',
  TRUSTED_PROXIES: '',
  // Почта выключена явно, даже если в окружении разработчика она настроена.
  SMTP_URL: '',
  SMTP_HOST: '',
  APP_URL: '',
  PUBLIC_BASE_URL: BASE,
  REGISTRATION_MODE: 'invite_only',
  MFA_SECRET_KEY: randomBytes(32).toString('base64'),
};
const { attachAuthenticator, totpDevice } = await import('./e2e-lib.mjs');

let server = null;
let serverOutput = '';
const startServer = async () => {
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/config`);
      if (response.ok) return;
    } catch {
      // ещё стартует
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('сервер не запустился');
};
const stopServer = async () => {
  if (!server) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  await exited;
  server = null;
};

const results = [];
const step = async (name, work) => {
  const started = Date.now();
  try {
    await work();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  ✗ ${name}\n      ${error.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

/* ---------------------- API администратора (без браузера) ---------------------- */

let adminCookie = '';
const adminApi = async (method, url, body) => {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: adminCookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const line of response.headers.getSetCookie?.() || []) {
    if (line.startsWith('mk_sid=')) adminCookie = line.split(';')[0];
  }
  return { status: response.status, body: await response.json().catch(() => null) };
};
let clientNumber = 0;
const nextClientIp = () => {
  clientNumber += 1;
  return `10.77.${Math.floor(clientNumber / 250)}.${(clientNumber % 250) + 1}`;
};
const publicApi = async (url, body, ip = nextClientIp()) => {
  const response = await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-Forwarded-For': ip }, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
};
let counter = 0;
/** Новый пользователь «ожидает активации» и ссылка-приглашение к нему (ручная передача). */
const invite = async (name = 'Тест') => {
  counter += 1;
  const email = `e2e.auth.${counter}@medkarta.test`;
  const created = await adminApi('POST', '/api/admin/users', { email, firstName: name, lastName: 'Проверкин', role: 'user', delivery: 'manual' });
  expect(created.status === 201 && created.body?.link, `не создан пользователь: ${created.status} ${created.body?.error || ''}`);
  return { email, id: created.body.user.id, link: created.body.link, token: created.body.link.split('#token=')[1] };
};

let browser;
const pageErrors = [];
const newPage = async ({ width = 1440, dark = false, reducedMotion = 'no-preference', context = null } = {}) => {
  const ctx = context || await browser.newContext({
    viewport: { width, height: width < 500 ? 812 : 900 },
    colorScheme: dark ? 'dark' : 'light',
    reducedMotion,
    extraHTTPHeaders: { 'X-Forwarded-For': nextClientIp() },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  return page;
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
/** Нет горизонтальной прокрутки ни у страницы, ни у прокручиваемого контейнера входа. */
const noOverflow = async (page, where) => {
  const sizes = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid=auth-page]');
    return {
      doc: document.documentElement.scrollWidth - window.innerWidth,
      page: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    };
  });
  expect(sizes.doc <= 0 && sizes.page <= 0, `${where}: горизонтальная прокрутка ${JSON.stringify(sizes)}`);
};
const titleTop = (page) => page.evaluate(() => Math.round(document.querySelector('[data-testid=auth-page] h1')?.getBoundingClientRect().top ?? -1));
const settle = (page) => page.waitForTimeout(450);

const signIn = async (page, email, password) => {
  await page.fill('[data-testid=login-email]', email);
  await page.click('[data-testid=login-continue]');
  await page.fill('[data-testid=login-password]', password);
  await page.click('[data-testid=login-submit]');
};

/*
 * Второй фактор суперадминистратора: приложение-аутентификатор (включено
 * через API при подготовке) и ключ доступа (добавляется в профиле в первом
 * сценарии «Второй фактор»). Ключ переносится в каждую новую страницу —
 * как синхронизированный ключ на устройствах владельца.
 */
let rootTotp = null;
let rootRecoveryCodes = [];
let rootPasskeys = [];
let passkeyCopies = 0;
const withPasskey = async (page) => {
  const key = await attachAuthenticator(page);
  // Счётчик подписей у каждой «копии» ключа — больше прежнего: сервер отвергает повтор счётчика (клон ключа).
  passkeyCopies += 1;
  if (rootPasskeys.length) await key.importCredentials(rootPasskeys.map((credential) => ({ ...credential, signCount: credential.signCount + passkeyCopies * 1000 })));
  return key;
};
/** Вход суперадминистратора в браузере: пароль, затем ключ доступа (или код, если ключа ещё нет). */
const rootSignIn = async (page) => {
  await signIn(page, ROOT_EMAIL, ROOT_PASSWORD);
  await page.waitForSelector('[data-testid=auth-step-mfa]');
  if (rootPasskeys.length) {
    await page.click('[data-testid=mfa-passkey]');
  } else {
    await page.fill('[data-testid=mfa-code]', await rootTotp.next());
  }
};

try {
  await startServer();
  const login = await adminApi('POST', '/api/auth/login', { email: ROOT_EMAIL, password: ROOT_PASSWORD });
  expect(login.status === 200, `вход администратора: ${login.status}`);
  // Сотруднику без второго фактора админ-панель закрыта — включаем приложение-аутентификатор через API.
  expect((await adminApi('GET', '/api/admin/users')).body?.code === 'mfa_setup_required', 'админ-панель открылась без второго фактора');
  const setup = await adminApi('POST', '/api/me/mfa/totp', {});
  expect(setup.status === 200 && setup.body?.secret, `настройка TOTP: ${setup.status}`);
  rootTotp = totpDevice(setup.body.secret);
  const confirmed = await adminApi('POST', '/api/me/mfa/totp/confirm', { factorId: setup.body.factorId, code: await rootTotp.next() });
  expect(confirmed.status === 200 && confirmed.body?.recoveryCodes?.length === 10, `подтверждение TOTP: ${confirmed.status}`);
  rootRecoveryCodes = confirmed.body.recoveryCodes;
  expect((await adminApi('GET', '/api/admin/users')).status === 200, 'после настройки MFA админ-панель закрыта');
  browser = await chromium.launch();
  const issuedTokens = [];

  console.log('Экраны (375 / 768 / 1440, светлая и тёмная тема):');
  for (const [width, dark] of [[375, false], [768, false], [1440, false], [375, true], [1440, true]]) {
    const tag = `${width}${dark ? '-dark' : ''}`;
    await step(`/login и /activate при ${tag}`, async () => {
      const page = await newPage({ width, dark });
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=login-email]');
      await settle(page);
      const before = await titleTop(page);
      await noOverflow(page, 'вход: email');
      await shot(page, `login-email-${tag}`);
      await page.fill('[data-testid=login-email]', `nobody.${tag}@medkarta.test`);
      await page.click('[data-testid=login-continue]');
      // Во время перехода тоже без горизонтальной прокрутки.
      await page.waitForTimeout(80);
      await noOverflow(page, 'вход: переход');
      await page.waitForSelector('[data-testid=login-password]');
      await settle(page);
      expect(Math.abs((await titleTop(page)) - before) <= 1, `заголовок сдвинулся при смене шага: ${before} → ${await titleTop(page)}`);
      await page.fill('[data-testid=login-password]', 'неверный-пароль');
      await page.click('[data-testid=login-submit]');
      await page.waitForSelector('[data-testid=auth-error]');
      await settle(page);
      await noOverflow(page, 'вход: ошибка');
      await shot(page, `login-error-${tag}`);
      await page.click('[data-testid=auth-no-password]');
      await page.waitForSelector('[data-testid=auth-step-access]');
      await settle(page);
      await noOverflow(page, 'вход: нет пароля');
      await shot(page, `login-access-${tag}`);

      const { link, token } = await invite('Вера');
      issuedTokens.push(token);
      await page.goto(link, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid=activation-confirm]');
      await settle(page);
      await noOverflow(page, 'приглашение');
      await shot(page, `activate-confirm-${tag}`);
      await page.click('[data-testid=activation-accept]');
      await page.waitForSelector('[data-testid=activation-password-input]');
      await page.fill('[data-testid=activation-password-input]', 'qwerty12');
      await settle(page);
      await noOverflow(page, 'пароль');
      await shot(page, `activate-password-${tag}`);
      await page.fill('[data-testid=activation-password-input]', 'Казань-клиника-2026');
      await page.click('[data-testid=activation-submit]');
      await page.waitForSelector('[data-testid=activation-success]');
      await page.waitForTimeout(250);
      await noOverflow(page, 'успех');
      await shot(page, `activate-success-${tag}`);
      await page.context().close();
    });
  }

  console.log('Вход:');
  console.log('Второй фактор:');
  await step('Вход кодом из приложения; ключ доступа добавляется в профиле', async () => {
    const page = await newPage();
    const key = await withPasskey(page);
    await page.goto(`${BASE}/login?next=${encodeURIComponent('/profile#security')}`, { waitUntil: 'domcontentloaded' });
    await signIn(page, ROOT_EMAIL, ROOT_PASSWORD);
    await page.waitForSelector('[data-testid=auth-step-mfa]');
    expect(await page.getAttribute('[data-testid=second-factor]', 'data-method') === 'totp', 'без ключа доступа первым должен быть код');
    await settle(page);
    await shot(page, 'mfa-totp-1440');
    await page.fill('[data-testid=mfa-code]', await rootTotp.next());
    await page.waitForURL((url) => url.pathname === '/profile', { timeout: 8000 });
    await page.waitForSelector('[data-testid=mfa-add-passkey]');
    await page.click('[data-testid=mfa-add-passkey]');
    await page.waitForSelector('[data-testid=mfa-factor][data-type=webauthn]');
    expect(await key.count() === 1, 'ключ не создан');
    expect(!(await page.$('[data-testid=recovery-codes]')), 'резервные коды выданы повторно без запроса');
    rootPasskeys = await key.exportCredentials();
    await settle(page);
    await shot(page, 'profile-security-1440');
    await page.context().close();
  });

  await step('Неверный код — ошибка; резервный код срабатывает один раз', async () => {
    const page = await newPage({ width: 375 });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(page, ROOT_EMAIL, ROOT_PASSWORD);
    await page.waitForSelector('[data-testid=auth-step-mfa]');
    // Ключа доступа в этом браузере нет: выбираем код из приложения.
    await page.click('[data-testid=mfa-use-totp]');
    await page.fill('[data-testid=mfa-code]', rootTotp.wrong());
    await page.waitForSelector('[data-testid=auth-error]');
    expect((await page.textContent('[data-testid=auth-error]')).includes('не подошёл') || (await page.textContent('[data-testid=auth-error]')).includes('Неверный'), 'нет понятной ошибки кода');
    await settle(page);
    await noOverflow(page, 'второй фактор: ошибка');
    await shot(page, 'mfa-error-375');
    await page.click('[data-testid=mfa-use-recovery]');
    await page.fill('[data-testid=mfa-recovery]', rootRecoveryCodes[0]);
    await page.click('[data-testid=mfa-submit]');
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 8000 });
    await page.context().clearCookies();
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await signIn(page, ROOT_EMAIL, ROOT_PASSWORD);
    await page.waitForSelector('[data-testid=auth-step-mfa]');
    await page.click('[data-testid=mfa-use-recovery]');
    await page.fill('[data-testid=mfa-recovery]', rootRecoveryCodes[0]);
    await page.click('[data-testid=mfa-submit]');
    await page.waitForSelector('[data-testid=auth-error]');
    expect(new URL(page.url()).pathname === '/login', 'повторный резервный код пустил в аккаунт');
    await page.context().close();
  });

  await step('Профиль: удаление способа входа — после подтверждения личности; последний способ сотрудник не удалит', async () => {
    const page = await newPage();
    await withPasskey(page);
    await page.goto(`${BASE}/login?next=%2Fprofile`, { waitUntil: 'domcontentloaded' });
    await rootSignIn(page);
    await page.waitForURL((url) => url.pathname === '/profile', { timeout: 8000 });
    await page.waitForSelector('[data-testid=mfa-factor][data-type=totp]');
    // Подтверждение личности «устарело» (как через 10 минут после входа).
    const { loadSqlite } = await import('../backend/accounts/sqliteStore.js');
    const DatabaseSync = await loadSqlite();
    const db = new DatabaseSync(env.ACCOUNTS_DB_PATH);
    db.prepare('UPDATE sessions SET reauth_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(ROOT_EMAIL);
    db.close();
    await page.click('[data-testid=mfa-factor][data-type=totp] [data-testid=mfa-factor-remove]');
    await page.click('[data-testid=confirm-action]');
    await page.waitForSelector('[data-testid=reauth-dialog]');
    await page.fill('[data-testid=reauth-password]', ROOT_PASSWORD);
    await page.click('[data-testid=reauth-submit]');
    await page.click('[data-testid=mfa-passkey]');
    await page.waitForSelector('[data-testid=mfa-factor][data-type=totp]', { state: 'detached' });
    expect(await page.isDisabled('[data-testid=mfa-factor][data-type=webauthn] [data-testid=mfa-factor-remove]'), 'последний способ входа сотрудника можно удалить');
    await page.setViewportSize({ width: 375, height: 812 });
    await settle(page);
    const overflow = await page.evaluate(() => document.querySelector('[data-testid=profile-page]').scrollWidth - window.innerWidth);
    expect(overflow <= 0, `профиль на 375 px: горизонтальная прокрутка ${overflow}`);
    await shot(page, 'profile-security-375');
    await page.context().close();
  });

  await step('Регистрация закрыта в режиме «только по приглашению»', async () => {
    const page = await newPage({ width: 375 });
    await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=register-closed]');
    await noOverflow(page, 'регистрация закрыта');
    await shot(page, 'register-closed-375');
    const answer = await publicApi('/api/auth/register', { email: 'new.person@medkarta.test' });
    expect(answer.status === 403, `регистрация ответила ${answer.status}`);
    await page.context().close();
  });

  await step('Существующий пользователь: ?next= ведёт обратно, сессия переживает перезагрузку', async () => {
    const page = await newPage();
    await withPasskey(page);
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('next') === '/admin/users');
    await rootSignIn(page);
    await page.waitForURL((url) => url.pathname === '/admin/users', { timeout: 8000 });
    await page.waitForSelector('[data-testid=user-row]');
    await page.reload();
    await page.waitForSelector('[data-testid=user-row]');
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=auth-signed-in]');
    await page.context().close();
  });

  await step('Открытого редиректа нет: ?next=//внешний-сайт игнорируется', async () => {
    const page = await newPage();
    await withPasskey(page);
    await page.goto(`${BASE}/login?next=${encodeURIComponent('//evil.example/x')}`, { waitUntil: 'domcontentloaded' });
    await rootSignIn(page);
    await page.waitForURL((url) => url.origin === BASE && url.pathname === '/admin', { timeout: 8000 });
    await page.context().close();
  });

  await step('Несуществующий email и неактивированный аккаунт неотличимы от неверного пароля', async () => {
    const pending = await invite('Ожидающий');
    issuedTokens.push(pending.token);
    const texts = [];
    const statuses = [];
    const ip = nextClientIp();
    for (const email of ['nobody.here@medkarta.test', pending.email, ROOT_EMAIL]) {
      const response = await publicApi('/api/auth/login', { email, password: 'точно-неверный-пароль' }, ip);
      statuses.push(response.status);
      texts.push(response.text);
    }
    expect(new Set(statuses).size === 1 && statuses[0] === 401, `коды разные: ${statuses}`);
    expect(new Set(texts).size === 1, 'тексты ответов различаются');
    const page = await newPage({ width: 375 });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const shown = [];
    for (const email of ['nobody.here@medkarta.test', pending.email]) {
      await signIn(page, email, 'точно-неверный-пароль');
      await page.waitForSelector('[data-testid=auth-error]');
      shown.push(await page.textContent('[data-testid=auth-error]'));
      await page.click('[data-testid=auth-change-email]');
    }
    expect(shown[0] === shown[1], 'в интерфейсе разный текст ошибки');
    await page.context().close();
  });

  await step('Запрос ссылки не выдаёт, есть ли аккаунт (почта не настроена — ответ одинаков)', async () => {
    const known = await publicApi('/api/auth/access-link', { email: ROOT_EMAIL });
    const unknown = await publicApi('/api/auth/access-link', { email: 'nobody.at.all@medkarta.test' });
    expect(known.status === unknown.status && known.text === unknown.text, `ответы различаются: ${known.status}/${unknown.status}`);
    const page = await newPage();
    await page.goto(`${BASE}/login?step=access`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=auth-step-access]');
    expect((await page.textContent('[data-testid=auth-step-access]')).includes('администратор'), 'нет подсказки про администратора');
    await page.context().close();
  });

  console.log('Ссылки:');
  await step('Токен уходит из адреса и истории сразу', async () => {
    const { link } = await invite();
    const page = await newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-confirm]');
    const state = await page.evaluate(() => ({ href: window.location.href, hash: window.location.hash }));
    expect(state.hash === '' && !state.href.includes('token'), `в адресе: ${state.href}`);
    await page.goBack().catch(() => null);
    expect(!page.url().includes('token'), 'токен вернулся кнопкой «Назад»');
    await page.context().close();
  });

  await step('Неверный и обрезанный токен', async () => {
    const page = await newPage();
    await page.goto(`${BASE}/activate#token=${randomBytes(32).toString('base64url')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-problem][data-code=invalid_link]');
    await settle(page);
    await shot(page, 'problem-invalid-1440');
    await page.goto(`${BASE}/activate#token=abc`, { waitUntil: 'domcontentloaded' });
    await page.reload();
    await page.waitForSelector('[data-testid=activation-problem][data-code=no_link]');
    await page.context().close();
  });

  await step('Просроченная ссылка', async () => {
    const { link, id } = await invite();
    const { loadSqlite } = await import('../backend/accounts/sqliteStore.js');
    const DatabaseSync = await loadSqlite();
    const db = new DatabaseSync(env.ACCOUNTS_DB_PATH);
    db.prepare('UPDATE access_tokens SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, id);
    db.close();
    const page = await newPage({ width: 375 });
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-problem][data-code=link_expired]');
    await settle(page);
    await shot(page, 'problem-expired-375');
    // Новая ссылка после истечения — работает.
    const again = await adminApi('POST', `/api/admin/users/${id}/invitations`, { delivery: 'manual' });
    expect(again.status === 200 && again.body?.link, `новая ссылка: ${again.status}`);
    await page.goto(again.body.link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-confirm]');
    await page.context().close();
  });

  await step('Отозванная ссылка (администратором) и после повторной выдачи', async () => {
    const first = await invite();
    const list = await adminApi('GET', `/api/admin/users/${first.id}/invitations`);
    const revoke = await adminApi('DELETE', `/api/admin/users/${first.id}/invitations/${list.body.items[0].id}`, {});
    expect(revoke.status === 200, `отзыв: ${revoke.status}`);
    const page = await newPage();
    await page.goto(first.link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-problem][data-code=link_revoked]');
    const second = await adminApi('POST', `/api/admin/users/${first.id}/invitations`, { delivery: 'manual' });
    const third = await adminApi('POST', `/api/admin/users/${first.id}/invitations`, { delivery: 'manual' });
    await page.goto(second.body.link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-problem][data-code=link_revoked]');
    await page.goto(third.body.link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-confirm]');
    await page.context().close();
  });

  await step('Заблокированный аккаунт не активируется; после разблокировки — новая ссылка', async () => {
    const user = await invite();
    const page = await newPage();
    await page.goto(user.link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    await page.waitForSelector('[data-testid=activation-password-input]');
    const block = await adminApi('POST', `/api/admin/users/${user.id}/block`, { reason: 'Проверка' });
    expect(block.status === 200, `блокировка: ${block.status}`);
    await page.fill('[data-testid=activation-password-input]', 'Казань-клиника-2026');
    await page.click('[data-testid=activation-submit]');
    await page.waitForSelector('[data-testid=activation-problem]');
    const code = await page.getAttribute('[data-testid=activation-problem]', 'data-code');
    expect(['activation_expired', 'account_blocked', 'link_revoked'].includes(code), `код: ${code}`);
    const refused = await adminApi('POST', `/api/admin/users/${user.id}/invitations`, { delivery: 'manual' });
    expect(refused.status === 409, `ссылка заблокированному: ${refused.status}`);
    await adminApi('POST', `/api/admin/users/${user.id}/unblock`, {});
    const fresh = await adminApi('POST', `/api/admin/users/${user.id}/invitations`, { delivery: 'manual' });
    await page.goto(fresh.body.link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    await page.fill('[data-testid=activation-password-input]', 'Казань-клиника-2026');
    await page.click('[data-testid=activation-submit]');
    await page.waitForSelector('[data-testid=activation-success]');
    await page.context().close();
  });

  await step('Две вкладки с одной ссылкой; другой браузер; повторное использование', async () => {
    const { link } = await invite();
    const first = await newPage();
    const second = await newPage({ context: first.context() });
    await first.goto(link, { waitUntil: 'domcontentloaded' });
    await first.click('[data-testid=activation-accept]');
    await first.waitForSelector('[data-testid=activation-password-input]');
    // Та же ссылка во второй вкладке того же браузера — продолжает создание пароля.
    await second.goto(link, { waitUntil: 'domcontentloaded' });
    await second.waitForSelector('[data-testid=activation-password-input]');
    // Другой браузер — уже нет.
    const stranger = await newPage();
    await stranger.goto(link, { waitUntil: 'domcontentloaded' });
    await stranger.waitForSelector('[data-testid=activation-problem][data-code=link_used]');
    await second.fill('[data-testid=activation-password-input]', 'Казань-клиника-2026');
    await second.click('[data-testid=activation-submit]');
    await second.waitForSelector('[data-testid=activation-success]');
    await first.fill('[data-testid=activation-password-input]', 'Другой-пароль-2026');
    await first.click('[data-testid=activation-submit]');
    await first.waitForSelector('[data-testid=activation-problem][data-code=activation_expired]');
    await settle(first);
    await shot(first, 'problem-second-tab-1440');
    await stranger.goto(link, { waitUntil: 'domcontentloaded' });
    await stranger.waitForSelector('[data-testid=activation-problem][data-code=link_used]');
    await first.context().close();
    await stranger.context().close();
  });

  await step('Перезагрузка на шаге пароля сохраняет контекст (cookie), без токена в адресе', async () => {
    const { link, email } = await invite();
    const page = await newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    await page.waitForSelector('[data-testid=activation-password-input]');
    await page.reload();
    await page.waitForSelector('[data-testid=activation-password-input]');
    expect((await page.textContent('[data-testid=activation-account]')).includes(email), 'после перезагрузки другой аккаунт');
    const cookies = await page.context().cookies();
    const context = cookies.find((item) => item.name === 'mk_activation');
    expect(!cookies.some((item) => item.name === 'mk_session'), 'осталась cookie прежнего формата');
    expect(context && context.httpOnly && context.sameSite === 'Strict' && context.path === '/api/auth/activation', `cookie контекста: ${JSON.stringify(context)}`);
    await page.context().close();
  });

  console.log('Пароль, клавиатура, движение:');
  await step('Требования к паролю: длина, частые пароли, email', async () => {
    const { link, email } = await invite();
    const page = await newPage({ width: 375 });
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    const input = '[data-testid=activation-password-input]';
    await page.fill(input, 'short');
    expect(await page.getAttribute('[data-testid=requirement-length]', 'data-ok') === 'false', 'длина: короткий принят');
    await page.fill(input, 'qwerty123');
    expect(await page.getAttribute('[data-testid=requirement-common]', 'data-ok') === 'false', 'частый пароль принят');
    await page.fill(input, `${email.split('@')[0]}-2026`);
    expect(await page.getAttribute('[data-testid=requirement-email]', 'data-ok') === 'false', 'пароль с email принят');
    await page.click('[data-testid=activation-submit]');
    await page.waitForSelector('[data-testid=auth-error]');
    await page.fill(input, 'Длинный-пароль-без-email');
    for (const key of ['length', 'common', 'email']) {
      expect(await page.getAttribute(`[data-testid=requirement-${key}]`, 'data-ok') === 'true', `требование ${key} не выполнено`);
    }
    await page.context().close();
  });

  await step('Только клавиатура: вход и приглашение, фокус видим', async () => {
    const { link } = await invite('Клава');
    const page = await newPage();
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid=activation-confirm]');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.dataset.testid) === 'activation-accept', 'Tab не ведёт к «Принять приглашение»');
    expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), 'нет видимого фокуса на кнопке');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=activation-password-input]');
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'activation-password-input');
    await page.keyboard.type('Клавиатура-2026-пароль');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid=activation-success]');
    await page.context().clearCookies();

    await withPasskey(page);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'login-email');
    await page.keyboard.type(ROOT_EMAIL);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'login-password');
    await page.keyboard.type(ROOT_PASSWORD);
    await page.keyboard.press('Enter');
    // Второй шаг: фокус — на кнопке ключа доступа, Enter подтверждает.
    await page.waitForFunction(() => document.activeElement?.dataset.testid === 'mfa-passkey');
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 8000 });
    await page.context().close();
  });

  await step('prefers-reduced-motion: шаги без сдвига, всё работает', async () => {
    const page = await newPage({ reducedMotion: 'reduce' });
    await withPasskey(page);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('[data-testid=login-email]', ROOT_EMAIL);
    await page.click('[data-testid=login-continue]');
    // Сразу после смены шага: у нового шага нет горизонтального сдвига.
    const transform = await page.evaluate(() => {
      const element = document.querySelector('[data-testid=auth-step-password]')?.parentElement;
      return element ? getComputedStyle(element).transform : 'missing';
    });
    expect(transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(transform), `сдвиг при reduced motion: ${transform}`);
    await page.fill('[data-testid=login-password]', ROOT_PASSWORD);
    await page.click('[data-testid=login-submit]');
    await page.click('[data-testid=mfa-passkey]');
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 8000 });
    await page.context().close();
  });

  await step('Токены не попали в журналы сервера', async () => {
    expect(issuedTokens.length > 0, 'нет выданных токенов');
    for (const token of issuedTokens) expect(!serverOutput.includes(token), 'токен найден в журнале сервера');
  });

  await step('Ошибок JavaScript на страницах нет', async () => {
    expect(pageErrors.length === 0, pageErrors.join('; '));
  });
} catch (error) {
  console.log(`  ✗ ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  fs.rmSync(WORK, { recursive: true, force: true });
  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed} из ${results.length} сценариев пройдено${process.exitCode ? ' — есть ошибки' : ''}.`);
}
