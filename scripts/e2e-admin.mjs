#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка аккаунтов и админ-панели в настоящем браузере: вход,
 * имя и роль в интерфейсе, дашборд, поиск, карточка, правка имени и роли,
 * блокировка с отзывом сессии, разблокировка, сброс пароля, история входов,
 * журнал, создание пользователя, вход обычного пользователя со сменой
 * временного пароля, правка профиля, завершение сессии, перезапуск сервера,
 * отсутствие регистрации.
 *
 * Нужны собранный фронтенд (npm run build) и Playwright с Chromium
 * (npm i --no-save playwright && npx playwright install chromium).
 * Сервер поднимается сам — на временной базе, рабочие данные не трогаются.
 *
 *   node scripts/e2e-admin.mjs [--shots каталог]
 */

/* global window, document -- код внутри page.evaluate выполняется в браузере */
import { spawn } from 'node:child_process';
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
const BASE = `http://127.0.0.1:${PORT}`;
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
};

let server = null;
const startServer = async () => {
  server = spawn(process.execPath, ['backend/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.resume();
  server.stderr.resume();
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
    throw error;
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

let browser;
try {
  await startServer();
  // Тестовые пользователи — как командой CLI: пароли знает только этот процесс.
  const { createSqliteAccountStore, loadSqlite } = await import('../backend/accounts/sqliteStore.js');
  const { createTestUsers } = await import('../backend/accounts/bootstrap.js');
  const seedStore = createSqliteAccountStore({ DatabaseSync: await loadSqlite(), file: env.ACCOUNTS_DB_PATH });
  const testUsers = Object.fromEntries((await createTestUsers({ store: seedStore })).map((item) => [item.email, item.password]));
  seedStore.close();

  browser = await chromium.launch();
  const admin = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  const changeTemporaryPassword = async (page, temporary, next) => {
    await page.waitForSelector('[data-testid=forced-password-change]');
    await page.fill('[data-testid=password-current]', temporary);
    await page.fill('[data-testid=password-next]', next);
    await page.fill('[data-testid=password-repeat]', next);
    await page.click('[data-testid=password-submit]');
    await page.waitForSelector('[data-testid=forced-password-change]', { state: 'detached' });
  };
  const openUser = async (email) => {
    await goto(admin, `/admin/users?q=${encodeURIComponent(email)}`);
    await admin.waitForSelector(`[data-testid=user-row] >> text=${email}`);
    await admin.click(`[data-testid=user-row] >> text=${email}`);
    await admin.waitForSelector('[data-testid=user-detail-name]');
  };
  const tab = (page, label) => page.click(`[role=tab]:has-text("${label}")`);

  console.log('Сценарии:');
  await step('1–3. Открыть МедКарту, войти администратором, увидеть имя и роль', async () => {
    await admin.goto(BASE, { waitUntil: 'domcontentloaded' });
    await admin.click('[data-testid=sign-in-button]');
    await admin.fill('[data-testid=login-email]', ROOT_EMAIL);
    await admin.fill('[data-testid=login-password]', ROOT_PASSWORD);
    await admin.click('[data-testid=login-submit]');
    await admin.waitForSelector('[data-testid=user-chip-name]');
    await admin.keyboard.press('Escape');
    expect((await admin.textContent('[data-testid=user-chip-name]')).includes('Максим'), 'нет имени в шапке');
    expect((await admin.textContent('[data-testid=user-chip]')).includes('Суперадминистратор'), 'нет роли в шапке');
    await shot(admin, '01-map-signed-in');
  });

  await step('4–5. Открыть /admin и увидеть дашборд из базы', async () => {
    await admin.click('[data-testid=user-chip-admin]');
    await admin.waitForSelector('[data-testid=tile-total]');
    const total = await admin.textContent('[data-testid=tile-total]');
    expect(/4/.test(total), `всего пользователей: ${total}`);
    await admin.click('[data-testid=period-30d]');
    await admin.waitForTimeout(400);
    await shot(admin, '02-dashboard');
  });

  await step('6. Найти трёх тестовых пользователей', async () => {
    await goto(admin, '/admin/users');
    await admin.fill('[data-testid=users-search]', 'medkarta.test');
    await admin.waitForFunction(() => document.querySelectorAll('[data-testid=user-row]').length === 3);
    await shot(admin, '03-users');
  });

  await step('7–8. Открыть профиль, изменить имя и роль', async () => {
    await openUser('anna.smirnova@medkarta.test');
    await tab(admin, 'Управление');
    await admin.fill('[data-testid=edit-first-name]', 'Анна-Мария');
    await admin.click('[data-testid=edit-save]');
    await admin.waitForFunction(() => document.querySelector('[data-testid=user-detail-name]')?.textContent.includes('Анна-Мария'));
    await admin.selectOption('[data-testid=role-select]', 'moderator');
    await admin.click('[data-testid=role-save]');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForFunction(() => document.querySelector('[data-testid=user-detail-name]')?.parentElement.textContent.includes('Модератор'));
    await shot(admin, '04-user-manage');
  });

  const timur = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await step('9–11. Заблокировать — сессия перестаёт работать; разблокировать', async () => {
    await timur.goto(`${BASE}/profile`, { waitUntil: 'domcontentloaded' });
    await timur.fill('[data-testid=login-email]', 'timur.khairullin@medkarta.test');
    await timur.fill('[data-testid=login-password]', testUsers['timur.khairullin@medkarta.test']);
    await timur.click('[data-testid=login-submit]');
    await changeTemporaryPassword(timur, testUsers['timur.khairullin@medkarta.test'], 'Тимур-пароль-2026');
    await timur.waitForSelector('[data-testid=profile-name]');

    await openUser('timur.khairullin@medkarta.test');
    await tab(admin, 'Управление');
    await admin.click('[data-testid=block-user]');
    await admin.fill('[data-testid=block-reason]', 'Проверка блокировки');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForSelector('[data-testid=unblock-user]');

    const status = await timur.evaluate(() => fetch('/api/me').then((response) => response.status));
    expect(status === 401, `сессия заблокированного ответила ${status}`);
    await timur.reload();
    await timur.waitForSelector('[data-testid=login-form]');
    await timur.fill('[data-testid=login-email]', 'timur.khairullin@medkarta.test');
    await timur.fill('[data-testid=login-password]', 'Тимур-пароль-2026');
    await timur.click('[data-testid=login-submit]');
    await timur.waitForSelector('[data-testid=login-error]');
    expect((await timur.textContent('[data-testid=login-error]')).includes('Проверка блокировки'), 'нет причины блокировки');
    await shot(timur, '05-blocked-login');

    await admin.click('[data-testid=unblock-user]');
    await admin.click('[data-testid=confirm-action]');
    await admin.waitForSelector('[data-testid=block-user]');
    await timur.fill('[data-testid=login-password]', 'Тимур-пароль-2026');
    await timur.click('[data-testid=login-submit]');
    await timur.waitForSelector('[data-testid=profile-name]');
  });

  await step('12. Сбросить пароль пользователя', async () => {
    await openUser('elena.kovaleva@medkarta.test');
    await tab(admin, 'Управление');
    await admin.click('[data-testid=reset-password]');
    await admin.click('[data-testid=confirm-action]');
    const password = (await admin.textContent('[data-testid=temporary-password]')).trim();
    expect(/^\w{4}(-\w{4}){4}$/.test(password), `временный пароль: ${password}`);
    await shot(admin, '06-temporary-password');
    await admin.keyboard.press('Escape');
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
    for (const label of ['Изменение профиля', 'Изменение роли', 'Блокировка', 'Разблокировка', 'Сброс пароля']) {
      expect(text.includes(label), `в журнале нет «${label}»`);
    }
    expect(text.includes('Максим'), 'в журнале нет инициатора');
    await shot(admin, '08-audit');
  });

  let newPassword = '';
  await step('15. Создать пользователя вручную', async () => {
    await goto(admin, '/admin/users');
    await admin.click('[data-testid=create-user]');
    await admin.fill('[data-testid=create-user-email]', 'olga.petrova@medkarta.test');
    await admin.fill('[data-testid=create-user-first-name]', 'Ольга');
    await admin.fill('[data-testid=create-user-last-name]', 'Петрова');
    await admin.click('[data-testid=create-user-submit]');
    newPassword = (await admin.textContent('[data-testid=temporary-password]')).trim();
    await admin.click('text=Готово');
    await admin.waitForSelector('[data-testid=user-detail-name] >> text=Ольга Петрова');
  });

  const olga = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await step('16–17. Войти обычным пользователем и изменить профиль', async () => {
    await olga.goto(BASE, { waitUntil: 'domcontentloaded' });
    await olga.click('[data-testid=sign-in-button]');
    await olga.fill('[data-testid=login-email]', 'olga.petrova@medkarta.test');
    await olga.fill('[data-testid=login-password]', newPassword);
    await olga.click('[data-testid=login-submit]');
    await changeTemporaryPassword(olga, newPassword, 'Ольга-пароль-2026');
    await olga.keyboard.press('Escape');
    await olga.waitForSelector('[data-testid=user-chip-name] >> text=Ольга Петрова');
    expect(!(await olga.$('[data-testid=user-chip-admin]')), 'обычному пользователю видна админ-панель');
    await olga.click('[data-testid=user-chip-profile]');
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

  await step('19. Перезапустить сервер — данные на месте', async () => {
    await stopServer();
    await startServer();
    await admin.reload();
    await goto(admin, '/admin/users?q=medkarta.test');
    await admin.waitForFunction(() => document.querySelectorAll('[data-testid=user-row]').length === 4);
    const text = await admin.textContent('[data-testid=users-table]');
    expect(text.includes('Петрова-Смирнова') && text.includes('Анна-Мария'), 'изменения пропали после перезапуска');
  });

  await step('20. Публичной регистрации нет', async () => {
    const status = await admin.evaluate(() => fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email":"x@y.ru","password":"пароль-пароль"}' }).then((response) => response.status));
    expect(status === 404, `регистрация ответила ${status}`);
    const guest = await browser.newPage();
    await guest.goto(BASE, { waitUntil: 'domcontentloaded' });
    await guest.click('[data-testid=sign-in-button]');
    await guest.waitForSelector('[data-testid=login-form]');
    expect(!(await guest.$('text=Создать аккаунт')), 'в интерфейсе есть регистрация');
    await guest.close();
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
