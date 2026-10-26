#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка аккаунтов и админ-панели в настоящем браузере: вход,
 * имя и роль в интерфейсе, дашборд, поиск, карточка, правка имени и роли,
 * активация по приглашению, блокировка с отзывом сессии, разблокировка,
 * новое приглашение (прежнее отзывается), история входов, журнал, создание
 * пользователя с приглашением, вход обычного пользователя, правка профиля,
 * завершение сессии, перезапуск сервера, закрытая регистрация (режим
 * invite_only), повторное использование ссылки. Обязательная двухфакторная
 * защита сотрудника: настройка ключа доступа (виртуальный ключ WebAuthn в
 * Chromium) при первом входе в панель, резервные коды, подтверждение
 * личности перед сменой роли и сбросом второго фактора пользователя,
 * потерявшего телефон. Экраны входа и приглашения подробно —
 * scripts/e2e-auth.mjs, регистрация и письма — scripts/e2e-register.mjs.
 *
 * Нужны собранный фронтенд (npm run build) и Playwright с Chromium
 * (npm i --no-save playwright && npx playwright install chromium).
 * Сервер поднимается сам — на временной базе, рабочие данные не трогаются.
 *
 *   node scripts/e2e-admin.mjs [--shots каталог]
 */

/* global window, document -- код внутри page.evaluate выполняется в браузере */
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

const PORT = Number(process.env.E2E_PORT) || 4200;
// localhost, а не 127.0.0.1: ключи доступа (WebAuthn) работают только на доменном имени.
const BASE = `http://localhost:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-e2e-'));
const ROOT_EMAIL = 'maximka2703@bk.ru';
const ROOT_PASSWORD = `Е2Е-${Math.random().toString(36).slice(2)}-корень`;
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
  // Адрес сайта для ссылок и ключей доступа; почта не настроена — ссылки передаются вручную.
  PUBLIC_BASE_URL: BASE,
  APP_URL: '',
  SMTP_URL: '',
  SMTP_HOST: '',
  REGISTRATION_MODE: 'invite_only',
  MFA_SECRET_KEY: randomBytes(32).toString('base64'),
};

let server = null;
// Журнал сервера — чтобы проверить, что в него не попали жалобы на здоровье.
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
    throw error;
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

let browser;
try {
  await startServer();
  // Тестовые пользователи — как командой CLI: без паролей, со ссылками-приглашениями,
  // которые знает только этот процесс (почта не настроена — ручная передача).
  const { createSqliteAccountStore, loadSqlite } = await import('../backend/accounts/sqliteStore.js');
  const { createTestUsers } = await import('../backend/accounts/bootstrap.js');
  const { createAccountContext } = await import('../backend/api/accountContext.js');
  const { createDelivery } = await import('../backend/accounts/delivery.js');
  const seedStore = createSqliteAccountStore({ DatabaseSync: await loadSqlite(), file: env.ACCOUNTS_DB_PATH });
  const seedContext = createAccountContext({ store: seedStore, delivery: createDelivery({ env: {} }), env: {} });
  const invites = Object.fromEntries((await createTestUsers({ store: seedStore, invitations: seedContext.invitations, base: BASE })).map((item) => [item.email, item.link]));
  seedStore.close();

  browser = await chromium.launch();
  const admin = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // Ключ доступа администратора — виртуальный (WebAuthn через протокол отладки Chromium).
  const { acceptTermsIfShown, attachAuthenticator } = await import('./e2e-lib.mjs');
  const adminKey = await attachAuthenticator(admin);
  const pageErrors = [];
  admin.on('pageerror', (error) => pageErrors.push(String(error)));
  const shot = async (page, name) => {
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };
  const goto = async (page, to) => {
    await page.evaluate((target) => {
      window.history.pushState({}, '', target);
      window.dispatchEvent(new Event('medkarta:navigate'));
    }, to);
  };
  // Вход в два шага: email → пароль.
  const signIn = async (page, email, password) => {
    await page.fill('[data-testid=login-email]', email);
    await page.click('[data-testid=login-continue]');
    await page.fill('[data-testid=login-password]', password);
    await page.click('[data-testid=login-submit]');
  };
  // Приглашение: открыть ссылку, принять, задать пароль — вход выполнен.
  const activate = async (page, link, password) => {
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.click('[data-testid=activation-accept]');
    await page.fill('[data-testid=activation-password-input]', password);
    await acceptTermsIfShown(page);
    await page.click('[data-testid=activation-submit]');
    await page.waitForSelector('[data-testid=activation-success]');
    expect(!page.url().includes('token='), 'токен остался в адресе');
  };
  const openUser = async (email) => {
    await goto(admin, `/admin/users?q=${encodeURIComponent(email)}`);
    await admin.waitForSelector(`[data-testid=user-row] >> text=${email}`);
    await admin.click(`[data-testid=user-row] >> text=${email}`);
    await admin.waitForSelector('[data-testid=user-detail-name]');
  };
  const tab = (page, label) => page.click(`[role=tab]:has-text("${label}")`);

  console.log('Сценарии:');
  // На компьютере аккаунт — в левой панели (кнопка в шапке), правый верхний угол карты свободен.
  const accountDialog = '[role=dialog][aria-label="Личный кабинет"]';
  await step('1–3. Открыть МедКарту, войти администратором, увидеть имя и роль', async () => {
    await admin.goto(BASE, { waitUntil: 'domcontentloaded' });
    await admin.click('[data-testid=account-button]');
    await signIn(admin, ROOT_EMAIL, ROOT_PASSWORD);
    await admin.waitForSelector('[data-testid=account-admin-link]');
    const header = await admin.textContent(`${accountDialog} header`);
    expect(header.includes('Максим'), 'нет имени в кабинете');
    expect(header.includes('Суперадминистратор'), 'нет роли в кабинете');
    expect(!(await admin.$('[data-testid=user-chip]')), 'на компьютере в углу карты осталась плашка аккаунта');
    expect((await admin.getAttribute('[data-testid=account-button]', 'aria-label')).includes('Максим'), 'кнопка аккаунта не знает, кто вошёл');
    await shot(admin, '01-map-signed-in');
  });

  await step('4. Админ-панель без второго фактора не открывается: настройка ключа доступа и резервные коды', async () => {
    await admin.click('[data-testid=account-admin-link]');
    await admin.waitForSelector('[data-testid=admin-mfa-setup]');
    const denied = await admin.evaluate(() => fetch('/api/admin/users').then(async (response) => ({ status: response.status, code: (await response.json()).code })));
    expect(denied.status === 403 && denied.code === 'mfa_setup_required', `API без MFA: ${JSON.stringify(denied)}`);
    await shot(admin, '01b-mfa-setup');
    await admin.click('[data-testid=mfa-add-passkey]');
    // Первый фактор — тоже после явного подтверждения личности: вход его не заменяет
    // (иначе укравший сессию привязал бы свой ключ). Факторов ещё нет — достаточно пароля.
    await admin.waitForSelector('[data-testid=reauth-dialog]');
    await admin.fill('[data-testid=reauth-password]', ROOT_PASSWORD);
    await admin.click('[data-testid=reauth-submit]');
    await admin.waitForSelector('[data-testid=recovery-codes]');
    const codes = await admin.$$eval('[data-testid=recovery-codes] li', (items) => items.map((item) => item.textContent.trim()));
    expect(codes.length === 10 && codes.every((code) => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(code)), `резервные коды: ${codes.length}`);
    expect(await adminKey.count() === 1, 'ключ не создан в виртуальном устройстве');
    await shot(admin, '01c-recovery-codes');
    await admin.click('[data-testid=recovery-done]');
  });

  await step('5. Открыть /admin и увидеть дашборд из базы', async () => {
    await admin.waitForSelector('[data-testid=tile-total]');
    const total = await admin.textContent('[data-testid=tile-total]');
    expect(/4/.test(total), `всего пользователей: ${total}`);
    await admin.click('[data-testid=period-30d]');
    expect(await admin.$('[data-testid=admin-mfa-setup]') === null, 'экран настройки MFA не исчез');
    await admin.waitForTimeout(400);
    await shot(admin, '02-dashboard');
  });

  await step('6. Найти трёх тестовых пользователей; у администратора — отметка 2FA', async () => {
    await goto(admin, '/admin/users');
    await admin.fill('[data-testid=users-search]', 'medkarta.test');
    await admin.waitForFunction(() => document.querySelectorAll('[data-testid=user-row]').length === 3);
    await shot(admin, '03-users');
    await admin.fill('[data-testid=users-search]', ROOT_EMAIL);
    await admin.waitForSelector(`[data-testid=user-row] >> text=${ROOT_EMAIL}`);
    expect((await admin.textContent('[data-testid=user-row]')).includes('2FA'), 'нет отметки 2FA у суперадминистратора');
  });

  await step('7–8. Открыть профиль, изменить имя и роль (смена роли — после подтверждения личности паролем и ключом)', async () => {
    await openUser('anna.smirnova@medkarta.test');
    await tab(admin, 'Управление');
    await admin.fill('[data-testid=edit-first-name]', 'Анна-Мария');
    await admin.click('[data-testid=edit-save]');
    await admin.waitForFunction(() => document.querySelector('[data-testid=user-detail-name]')?.textContent.includes('Анна-Мария'));
    // Подтверждение личности «устарело» (как через 10 минут): смена роли попросит пароль и ключ.
    await sqlite((db) => db.prepare('UPDATE sessions SET reauth_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(ROOT_EMAIL));
    await admin.selectOption('[data-testid=role-select]', 'moderator');
    await admin.click('[data-testid=role-save]');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForSelector('[data-testid=reauth-dialog]');
    await admin.fill('[data-testid=reauth-password]', ROOT_PASSWORD);
    await admin.click('[data-testid=reauth-submit]');
    await admin.waitForSelector('[data-testid=mfa-passkey]');
    await shot(admin, '04a-reauth');
    await admin.click('[data-testid=mfa-passkey]');
    await admin.waitForSelector('[data-testid=reauth-dialog]', { state: 'detached' });
    await admin.waitForFunction(() => document.querySelector('[data-testid=user-detail-name]')?.parentElement.textContent.includes('Модератор'));
    await shot(admin, '04-user-manage');
  });

  const timur = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await step('9–11. Активировать по приглашению; заблокировать — сессия перестаёт работать; разблокировать', async () => {
    await activate(timur, invites['timur.khairullin@medkarta.test'], 'Тимур-пароль-2026');
    await timur.waitForURL((url) => url.pathname === '/');
    await timur.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    await timur.waitForSelector('[data-testid=profile-name]');

    await openUser('timur.khairullin@medkarta.test');
    await tab(admin, 'Управление');
    await admin.click('[data-testid=block-user]');
    await admin.fill('[data-testid=block-reason]', 'Проверка блокировки');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForSelector('[data-testid=unblock-user]');

    const status = await timur.evaluate(() => fetch('/api/me').then((response) => response.status));
    expect(status === 401, `сессия заблокированного ответила ${status}`);
    // Профиль без сессии ведёт на /login?next=/profile.
    await timur.reload();
    await timur.waitForURL((url) => url.pathname === '/login');
    await signIn(timur, 'timur.khairullin@medkarta.test', 'Тимур-пароль-2026');
    await timur.waitForSelector('[data-testid=auth-error]');
    expect((await timur.textContent('[data-testid=auth-error]')).includes('Проверка блокировки'), 'нет причины блокировки');
    await shot(timur, '05-blocked-login');

    await admin.click('[data-testid=unblock-user]');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForSelector('[data-testid=block-user]');
    await timur.fill('[data-testid=login-password]', 'Тимур-пароль-2026');
    await timur.click('[data-testid=login-submit]');
    await timur.waitForURL((url) => url.pathname === '/profile');
    await timur.waitForSelector('[data-testid=profile-name]');
  });

  await step('12. Выслать новое приглашение — прежнее отзывается', async () => {
    await openUser('elena.kovaleva@medkarta.test');
    expect((await admin.textContent('[data-testid=user-detail-name] + p + div')).includes('Ожидает активации'), 'нет статуса «Ожидает активации»');
    await tab(admin, 'Управление');
    await admin.click('[data-testid=issue-link]');
    await admin.click('[data-testid=confirm-action]');
    const link = await admin.inputValue('[data-testid=invitation-link]');
    expect(/\/activate#token=[\w-]{43}$/.test(link), `ссылка: ${link.replace(/token=.*/, 'token=…')}`);
    await shot(admin, '06-invitation-link');
    await admin.click('[data-testid=invitation-done]');
    await admin.waitForSelector('[data-testid=invitation-row][data-state=revoked]');
    expect(await admin.$('[data-testid=invitation-row][data-state=active]'), 'нет нового приглашения');
    const old = await browser.newPage();
    await old.goto(invites['elena.kovaleva@medkarta.test'], { waitUntil: 'domcontentloaded' });
    await old.waitForSelector('[data-testid=activation-problem][data-code=link_revoked]');
    await old.close();
  });

  // На 375 px имя в шапке карточки сжималось до «Ж…», а текст приглашения — до узкой колонки.
  await step('12а. Карточка пользователя на телефоне: имя и приглашение не сжимаются', async () => {
    await admin.setViewportSize({ width: 375, height: 812 });
    try {
      await admin.waitForTimeout(300);
      const nameWidth = await admin.locator('[data-testid=user-detail-name]').evaluate((el) => el.getBoundingClientRect().width);
      expect(nameWidth > 150, `имя сжато до ${Math.round(nameWidth)} px`);
      const row = await admin.locator('[data-testid=invitation-row][data-state=active]').evaluate((el) => ({
        row: el.getBoundingClientRect().width,
        text: Math.max(...[...el.querySelectorAll('span')].map((span) => span.getBoundingClientRect().width)),
      }));
      expect(row.text > row.row * 0.7, `текст приглашения ${Math.round(row.text)} из ${Math.round(row.row)} px`);
      expect(await admin.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth), 'горизонтальная прокрутка');
      await shot(admin, '06b-user-detail-375');
    } finally {
      await admin.setViewportSize({ width: 1440, height: 900 });
    }
  });

  await step('13. История входов', async () => {
    await openUser('timur.khairullin@medkarta.test');
    await tab(admin, 'Безопасность');
    await admin.waitForSelector('[data-testid=user-logins] >> text=Вход отклонён');
    await admin.waitForSelector('[data-testid=user-logins] >> text=Успешный вход');
    await admin.waitForSelector('[data-testid=user-blocks] >> text=Блокировка');
    await shot(admin, '07-security');
  });

  await step('14. Журнал своих действий', async () => {
    await goto(admin, '/admin/audit');
    await admin.waitForSelector('[data-testid=audit-table]');
    const text = await admin.textContent('[data-testid=audit-table]');
    for (const label of ['Изменение профиля', 'Изменение роли', 'Блокировка', 'Разблокировка', 'Приглашение', 'Активация аккаунта']) {
      expect(text.includes(label), `в журнале нет «${label}»`);
    }
    expect(text.includes('Максим'), 'в журнале нет инициатора');
    await shot(admin, '08-audit');
  });

  let olgaLink = '';
  await step('15. Создать пользователя — без пароля, с приглашением', async () => {
    await goto(admin, '/admin/users');
    await admin.click('[data-testid=create-user]');
    await admin.fill('[data-testid=create-user-email]', 'olga.petrova@medkarta.test');
    await admin.fill('[data-testid=create-user-first-name]', 'Ольга');
    await admin.fill('[data-testid=create-user-last-name]', 'Петрова');
    await admin.click('[data-testid=create-user-submit]');
    olgaLink = await admin.inputValue('[data-testid=invitation-link]');
    await admin.click('[data-testid=invitation-done]');
    await admin.waitForSelector('[data-testid=user-detail-name] >> text=Ольга Петрова');
    // Ссылка видна один раз: в карточке и журнале её нет.
    expect(!(await admin.content()).includes(olgaLink.split('#token=')[1]), 'токен остался на странице');
  });

  const olga = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await step('16–17. Активировать аккаунт обычного пользователя и изменить профиль', async () => {
    await activate(olga, olgaLink, 'Ольга-пароль-2026');
    await olga.waitForURL((url) => url.pathname === '/');
    await olga.click('[data-testid=account-button]');
    await olga.waitForSelector(`${accountDialog} header >> text=Ольга Петрова`);
    expect(!(await olga.$('[data-testid=account-admin-link]')), 'обычному пользователю видна админ-панель');
    await olga.click('[data-testid=account-profile-link]');
    await olga.waitForSelector('[data-testid=profile-name]');
    await olga.fill('[data-testid=profile-last-name]', 'Петрова-Смирнова');
    await olga.click('[data-testid=profile-save]');
    await olga.waitForSelector('[data-testid=profile-name] >> text=Ольга Петрова-Смирнова');
    const adminStatus = await olga.evaluate(() => fetch('/api/admin/users').then((response) => response.status));
    expect(adminStatus === 403, `обычный пользователь получил ${adminStatus} от /api/admin`);
    await shot(olga, '09-profile');
  });

  await step('18. Завершить сессию пользователя', async () => {
    await goto(admin, '/admin/sessions');
    await admin.waitForSelector('[data-testid=sessions-table] >> text=olga.petrova@medkarta.test');
    const row = admin.locator('[data-testid=sessions-table] tr', { hasText: 'olga.petrova@medkarta.test' });
    await row.locator('button:has-text("Завершить")').click();
    await admin.waitForSelector('[data-testid=sessions-table] >> text=olga.petrova@medkarta.test', { state: 'detached' });
    const status = await olga.evaluate(() => fetch('/api/me').then((response) => response.status));
    expect(status === 401, `завершённая сессия ответила ${status}`);
  });

  await step('18а. Пользователь потерял телефон с приложением: сброс второго фактора — с email, причиной и подтверждением личности администратора', async () => {
    // Ольга входит и включает приложение-аутентификатор (API своей страницы; экран настройки — в e2e-register).
    const { totpDevice } = await import('./e2e-lib.mjs');
    const password = 'Ольга-пароль-2026';
    const started = await olga.evaluate(async (secret) => {
      const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (response) => ({ status: response.status, body: await response.json() }));
      await post('/api/auth/login', { email: 'olga.petrova@medkarta.test', password: secret });
      await post('/api/me/reauth', { password: secret });
      return post('/api/me/mfa/totp', {});
    }, password);
    expect(started.status === 200 && started.body.secret, `настройка TOTP: ${started.status}`);
    const code = await totpDevice(started.body.secret).next();
    const confirmed = await olga.evaluate(({ factorId, value }) => fetch('/api/me/mfa/totp/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ factorId, code: value }),
    }).then((response) => response.status), { factorId: started.body.factorId, value: code });
    expect(confirmed === 200, `подтверждение TOTP: ${confirmed}`);

    await openUser('olga.petrova@medkarta.test');
    await tab(admin, 'Управление');
    await admin.waitForSelector('[data-testid=mfa-reset]');
    // Подтверждение личности администратора «устарело»: сброс попросит пароль и ключ доступа.
    await sqlite((db) => db.prepare('UPDATE sessions SET reauth_at = 1 WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(ROOT_EMAIL));
    await admin.click('[data-testid=mfa-reset]');
    expect(await admin.isDisabled('[data-testid=confirm-action]'), 'сброс доступен без ввода email');
    await admin.fill('[data-testid=confirm-input]', 'olga.petrova@medkarta.test');
    await admin.fill('[data-testid=mfa-reset-reason]', 'Позвонила в поддержку, данные сверены по видеосвязи');
    await shot(admin, '04b-mfa-reset');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForSelector('[data-testid=reauth-dialog]');
    await admin.fill('[data-testid=reauth-password]', ROOT_PASSWORD);
    await admin.click('[data-testid=reauth-submit]');
    await admin.waitForSelector('[data-testid=mfa-passkey]');
    await admin.click('[data-testid=mfa-passkey]');
    await admin.waitForSelector('[data-testid=reauth-dialog]', { state: 'detached' });
    await admin.waitForSelector('[data-testid=mfa-reset]', { state: 'detached' });
    const status = await olga.evaluate(() => fetch('/api/me').then((response) => response.status));
    expect(status === 401, `сессия владельца после сброса ответила ${status}`);
    await tab(admin, 'Профиль');
    await admin.waitForSelector('text=Не включена');
  });

  await step('19. Перезапустить сервер — данные и сессия со вторым фактором на месте', async () => {
    await stopServer();
    await startServer();
    await admin.reload();
    expect(await admin.$('[data-testid=admin-mfa-setup]') === null && await admin.$('[data-testid=admin-mfa-verify]') === null, 'после перезапуска снова просит второй фактор');
    await goto(admin, '/admin/users?q=medkarta.test');
    await admin.waitForFunction(() => document.querySelectorAll('[data-testid=user-row]').length === 4);
    const text = await admin.textContent('[data-testid=users-table]');
    expect(text.includes('Петрова-Смирнова') && text.includes('Анна-Мария'), 'изменения пропали после перезапуска');
  });

  await step('20. Режим «только по приглашению»: регистрация закрыта и не предлагается', async () => {
    const answer = await admin.evaluate(() => fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"x@y.ru"}' })
      .then(async (response) => ({ status: response.status, code: (await response.json()).code })));
    expect(answer.status === 403 && answer.code === 'registration_closed', `регистрация ответила ${JSON.stringify(answer)}`);
    const guest = await browser.newPage();
    await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
    await guest.click('[data-testid=account-button]');
    await guest.waitForSelector('[data-testid=login-form]');
    expect(!(await guest.$('[data-testid=auth-register]')), 'в интерфейсе есть регистрация');
    await guest.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await guest.waitForSelector('[data-testid=register-closed]');
    await guest.close();
  });

  await step('21. Ссылку нельзя использовать повторно', async () => {
    const again = await browser.newPage();
    await again.goto(olgaLink, { waitUntil: 'domcontentloaded' });
    await again.waitForSelector('[data-testid=activation-problem][data-code=link_used]');
    await again.close();
  });

  await step('22. Обращение по персональным данным (отправлено через API кабинета; форма профиля — в e2e-register): в панели взято в работу и закрыто с ответом', async () => {
    const created = await admin.evaluate(() => fetch('/api/privacy/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'access', message: 'Проверка обращения из сквозного теста' }),
    }).then((response) => response.status));
    expect(created === 201, `обращение: ${created}`);
    await goto(admin, '/admin/privacy');
    await admin.waitForSelector('[data-testid=privacy-requests-table]');
    await admin.locator('[data-testid=privacy-requests-table] tbody tr').first().click();
    await admin.waitForSelector('[data-testid=privacy-request-detail]');
    await admin.click('[data-testid=privacy-take]');
    await admin.waitForSelector('[data-testid=privacy-request-detail] >> text=В работе');
    await admin.click('[data-testid=privacy-complete]');
    await admin.fill('[data-testid=privacy-action-text]', 'Сведения об обработке направлены: см. «Мои данные» в профиле.');
    await admin.click('[data-testid=privacy-action-submit]');
    await admin.waitForSelector('[data-testid=privacy-request-detail] >> text=Выполнено');
    await shot(admin, '11-privacy-request');
    await admin.keyboard.press('Escape');
    const audit = await sqlite((db) => db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'privacy.request_complete'").get().count);
    expect(audit === 1, 'закрытие обращения не записано в журнал действий');
  });

  await step('23. Ассистент: пропуск без id аккаунта (только для /api/chat); жалоба разобрана локально и не попала в журнал', async () => {
    const result = await admin.evaluate(async () => {
      const chat = () => fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'третий день болит горло, нужен врач' }], sessionId: 'e2e-session-0123456789' }),
      }).then(async (response) => ({ status: response.status, body: await response.json() }));
      const before = await chat();
      const pass = await fetch('/api/account/assistant-pass', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((response) => response.status);
      const after = await chat();
      return { before, pass, after };
    });
    expect(result.before.status === 401 && result.before.body.code === 'assistant_pass_required', `без пропуска: ${JSON.stringify(result.before)}`);
    expect(result.pass === 200, `пропуск: ${result.pass}`);
    expect(result.after.status === 200 && /ЛОР|оториноларинголог|терапевт/i.test(result.after.body.replyText || ''), `ответ: ${JSON.stringify(result.after.body).slice(0, 200)}`);
    // Без фильтра по адресу: cookie пропуска — только для пути /api/chat.
    const cookies = await admin.context().cookies();
    const pass = cookies.find((cookie) => cookie.name === 'mk_ai');
    const me = await admin.evaluate(() => fetch('/api/me').then((response) => response.json()));
    expect(pass && pass.path === '/api/chat' && pass.httpOnly && pass.sameSite === 'Strict', `cookie пропуска: ${JSON.stringify(pass && { path: pass.path, httpOnly: pass.httpOnly, sameSite: pass.sameSite })}`);
    expect(!pass.value.includes(me.user.id), 'в пропуске id аккаунта');
    expect(!/горло|болит/.test(serverOutput), 'жалоба попала в журнал сервера');
  });

  await step('Ошибок JavaScript на страницах нет', async () => {
    expect(pageErrors.length === 0, pageErrors.join('; '));
  });
} catch {
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  fs.rmSync(WORK, { recursive: true, force: true });
  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed} из ${results.length} сценариев пройдено${process.exitCode ? ' — есть ошибки' : ''}.`);
}
