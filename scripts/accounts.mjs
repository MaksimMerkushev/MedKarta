#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Управление аккаунтами с сервера — для первого запуска и восстановления
 * доступа. Работает с той же базой, что и сервер (ACCOUNTS_DB_PATH или
 * var/accounts/medkarta.sqlite); сервер можно не останавливать.
 *
 *   npm run accounts -- bootstrap [--email адрес] [--name Имя]
 *       главный суперадминистратор; пароль — из ADMIN_BOOTSTRAP_PASSWORD
 *       или вводится в терминале (не отображается). Повторный запуск
 *       ничего не меняет.
 *   npm run accounts -- seed-test-users
 *       три тестовых пользователя; пароли показываются один раз, при входе
 *       их нужно сменить. В production — только с --allow-production.
 *   npm run accounts -- reset-password --email адрес
 *       временный пароль (показывается один раз), все сессии завершаются.
 *   npm run accounts -- restore-admin --email адрес
 *       вернуть аккаунту роль superadmin и статус «активен» (потеря доступа).
 *   npm run accounts -- list-staff | status
 *   npm run accounts -- backup --out файл.sqlite
 *
 * Пароли выводятся только в терминал (TTY): при перенаправлении вывода в
 * файл или журнал команда откажется, если не передан --print-secrets.
 */

import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // .env может отсутствовать.
  }
}

const { bootstrapSuperadmin, createTestUsers, DEFAULT_SUPERADMIN } = await import('../backend/accounts/bootstrap.js');
const { generateTemporaryPassword, hashPassword } = await import('../backend/accounts/passwords.js');
const { normalizeEmail, userLabel } = await import('../backend/accounts/service.js');
const { createSqliteAccountStore, loadSqlite } = await import('../backend/accounts/sqliteStore.js');
const { defaultAccountsDbPath } = await import('../backend/api/accountContext.js');

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const secretsAllowed = () => process.stdout.isTTY || flag('print-secrets');

const ask = (question, { hidden = false } = {}) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    // Ввод не отображается: вместо символов — ничего.
    rl._writeToOutput = (text) => {
      if (text.includes(question)) process.stdout.write(text);
    };
  }
  rl.question(question, (answer) => {
    rl.close();
    if (hidden) process.stdout.write('\n');
    resolve(answer);
  });
});

const isProduction = () => process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';

const DatabaseSync = await loadSqlite();
if (!DatabaseSync) die('Нужен Node 22.13+ (node:sqlite).');
const file = defaultAccountsDbPath();
const store = createSqliteAccountStore({ DatabaseSync, file });
const audit = (action, target, details = null) => store.addAudit({ at: Date.now(), action, actorLabel: 'Система (CLI)', targetId: target?.id || null, targetLabel: target ? userLabel(target) : null, result: 'ok', details });

const findByEmail = (email) => {
  const address = normalizeEmail(email);
  if (!address) die('Укажите --email.');
  const user = store.getUserByEmail(address);
  if (!user) die('Пользователь не найден.');
  return user;
};

switch (command) {
  case 'bootstrap': {
    const email = option('email') || process.env.ADMIN_BOOTSTRAP_EMAIL || DEFAULT_SUPERADMIN.email;
    if (store.getUserByEmail(normalizeEmail(email))) {
      console.log('Аккаунт уже есть — ничего не изменено. Для сброса пароля: reset-password --email …');
      break;
    }
    let password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!password) {
      if (!process.stdin.isTTY) die('Задайте ADMIN_BOOTSTRAP_PASSWORD или запустите команду в терминале.');
      password = await ask('Пароль суперадминистратора: ', { hidden: true });
      const again = await ask('Ещё раз: ', { hidden: true });
      if (password !== again) die('Пароли не совпадают.');
    }
    try {
      const result = await bootstrapSuperadmin({ store, email, firstName: option('name') || DEFAULT_SUPERADMIN.firstName, password });
      console.log(result.status === 'created' ? `Суперадминистратор создан: ${result.user.email}` : 'Аккаунт уже есть — ничего не изменено.');
    } catch (error) {
      die(error.message);
    }
    break;
  }
  case 'seed-test-users': {
    if (isProduction() && !flag('allow-production')) {
      die('Это production: тестовых пользователей создают вручную в админ-панели или с флагом --allow-production.');
    }
    if (!secretsAllowed()) die('Пароли выводятся только в терминал. Запустите без перенаправления вывода или с --print-secrets.');
    const results = await createTestUsers({ store });
    console.log('Тестовые пользователи (пароль показывается один раз, при первом входе его нужно сменить):');
    for (const item of results) {
      console.log(item.status === 'created' ? `  ${item.email}  ${item.password}` : `  ${item.email}  — уже есть, пароль не менялся`);
    }
    break;
  }
  case 'reset-password': {
    if (!secretsAllowed()) die('Пароль выводится только в терминал. Запустите без перенаправления вывода или с --print-secrets.');
    const user = findByEmail(option('email'));
    if (user.demoTemplate) die('У демо-копии нет пароля.');
    const password = generateTemporaryPassword();
    const passwordHash = await hashPassword(password);
    store.transaction(() => {
      store.setPassword(user.id, passwordHash, { mustChange: true, now: Date.now() });
      store.deleteUserSessions(user.id);
      audit('user.password_reset', user, { via: 'cli', sessionsRevoked: true });
    });
    console.log(`Временный пароль для ${user.email} (показывается один раз): ${password}`);
    console.log('Все сессии пользователя завершены; при входе потребуется новый пароль.');
    break;
  }
  case 'restore-admin': {
    const user = findByEmail(option('email'));
    store.transaction(() => {
      store.updateUser(user.id, { role: 'superadmin', status: 'active', blockedUntil: null, blockReason: null }, { now: Date.now() });
      audit('user.role', user, { from: user.role, to: 'superadmin', status: { from: user.status, to: 'active' }, via: 'cli' });
    });
    console.log(`${user.email}: роль superadmin, статус «активен».`);
    break;
  }
  case 'list-staff': {
    const { rows } = store.listUsers({ filters: { roles: ['superadmin', 'admin', 'moderator'], kind: 'real' }, sort: 'role', dir: 'desc', limit: 100, now: Date.now() });
    for (const user of rows) console.log(`${user.role.padEnd(11)} ${user.status.padEnd(9)} ${user.email}`);
    if (rows.length === 0) console.log('Сотрудников нет. Создайте суперадминистратора: npm run accounts -- bootstrap');
    break;
  }
  case 'status': {
    const health = store.health();
    const counts = store.userCounts();
    console.log(`База: ${file}`);
    console.log(`Схема: ${health.schemaVersion}, размер ${(health.bytes / 1024).toFixed(0)} КБ, проверка: ${health.ok ? 'ок' : 'ОШИБКА'}`);
    for (const row of counts) console.log(`  ${row.role.padEnd(11)} ${row.status.padEnd(9)} ${row.count}`);
    console.log(`Активных суперадминистраторов: ${store.countActiveSuperadmins()}`);
    break;
  }
  case 'backup': {
    const out = option('out');
    if (!out) die('Укажите --out путь/к/копии.sqlite');
    try {
      store.backupTo(path.resolve(out));
    } catch (error) {
      die(`Не получилось: ${error.message}`);
    }
    console.log(`Копия сохранена: ${path.resolve(out)} (храните её так же бережно, как саму базу).`);
    break;
  }
  default:
    console.log('Команды: bootstrap, seed-test-users, reset-password, restore-admin, list-staff, status, backup. Подробности — docs/accounts.md.');
    if (command) process.exitCode = 1;
}

store.close();
