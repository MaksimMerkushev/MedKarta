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
 *   npm run accounts -- seed-test-users [--base http://localhost:3001]
 *       три тестовых пользователя без паролей, с приглашениями: письмом,
 *       если настроена почта, иначе ссылки печатаются один раз.
 *       В production — только с --allow-production.
 *   npm run accounts -- access-link --email адрес [--base …]
 *       одноразовая ссылка для входа: приглашение (аккаунт не активирован)
 *       или смена пароля. Прежняя ссылка того же вида отзывается. Если у
 *       аккаунта включена MFA, пароль по ссылке меняется только вместе со
 *       вторым фактором владельца; утрачены все факторы — сначала mfa-reset.
 *   npm run accounts -- reset-password --email адрес
 *       то же, что access-link, плюс завершает все сессии пользователя.
 *   npm run accounts -- restore-admin --email адрес
 *       вернуть аккаунту роль superadmin и статус «активен» (потеря доступа).
 *   npm run accounts -- mfa-reset --email адрес [--yes]
 *       процедура восстановления при потере всех факторов входа (телефон,
 *       ключи и резервные коды): факторы и коды удаляются, все сессии и
 *       доверенные устройства завершаются. Только на сервере, с подтверждением:
 *       для сотрудника это единственный способ вернуть доступ без второго
 *       фактора — письма для этого недостаточно. После входа MFA нужно
 *       настроить заново (админ-панель потребует это сама).
 *   npm run accounts -- unlock --email адрес
 *       снять временные ограничения входа (счётчики неудачных попыток).
 *   npm run accounts -- list-staff | status
 *   npm run accounts -- backup --out файл.sqlite
 *
 * Ссылки выводятся только в терминал (TTY): при перенаправлении вывода в
 * файл или журнал команда откажется, если не передан --print-secrets.
 * Адрес в ссылке — APP_URL, иначе --base, иначе http://localhost:PORT.
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
const { normalizeEmail, userLabel } = await import('../backend/accounts/service.js');
const { createSqliteAccountStore, loadSqlite } = await import('../backend/accounts/sqliteStore.js');
const { createAccountContext, defaultAccountsDbPath } = await import('../backend/api/accountContext.js');
const { loadMfaKey } = await import('../backend/accounts/secrets.js');
const { emailKey } = await import('../backend/accounts/throttle.js');

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
// Ключ MFA — тот же, что у сервера (MFA_SECRET_KEY или файл рядом с базой).
const mfaKey = loadMfaKey({ keyFile: path.join(path.dirname(file), 'secrets', 'mfa.key') }).key;
const context = createAccountContext({ store, mfaKey, onAccountDeleted: async () => {}, systemInfo: async () => null });
const linkBase = () => {
  const base = option('base') || `http://localhost:${process.env.PORT || 3001}`;
  try {
    return new URL(base).origin;
  } catch {
    return die('--base: некорректный адрес');
  }
};
const printLink = (user, issued) => {
  const until = new Date(issued.invitation.expiresAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const kind = issued.invitation.purpose === 'invite' ? 'Приглашение' : 'Ссылка для смены пароля';
  // Письмо не ушло, а вывод перенаправлен в файл или журнал — ссылку туда не пишем.
  if (issued.link && !secretsAllowed()) {
    console.log(`${kind} для ${user.email}: письмо отправить не удалось, а вывод не в терминал — ссылка не показана. Повторите команду в терминале или с --print-secrets.`);
    return;
  }
  if (issued.link) {
    console.log(`${kind} для ${user.email} (действует до ${until} МСК, показывается один раз):`);
    console.log(`  ${issued.link}`);
    if (issued.invitation.deliveryStatus === 'failed') console.log('  Письмо отправить не удалось — передайте ссылку сами.');
  } else {
    console.log(`${kind} отправлено письмом на ${user.email} (действует до ${until} МСК).`);
  }
};
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
      console.log('Аккаунт уже есть — ничего не изменено. Ссылка для смены пароля: access-link --email …');
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
    if (!context.delivery.emailEnabled && !secretsAllowed()) die('Ссылки выводятся только в терминал. Запустите без перенаправления вывода или с --print-secrets.');
    const results = await createTestUsers({ store, invitations: context.invitations, base: linkBase() });
    console.log('Тестовые пользователи (без паролей: пароль каждый задаёт сам по приглашению):');
    for (const item of results) {
      if (item.status !== 'created') {
        console.log(`  ${item.email} — уже есть, ничего не изменено`);
      } else if (item.link && !secretsAllowed()) {
        console.log(`  ${item.email} — письмо не ушло, а вывод не в терминал: ссылка не показана (access-link --email …)`);
      } else if (item.link) {
        console.log(`  ${item.email}\n    ${item.link}`);
      } else {
        console.log(`  ${item.email} — приглашение отправлено письмом`);
      }
    }
    break;
  }
  case 'access-link':
  case 'reset-password': {
    if (!context.delivery.emailEnabled && !secretsAllowed()) die('Ссылка выводится только в терминал. Запустите без перенаправления вывода или с --print-secrets.');
    const user = findByEmail(option('email'));
    if (user.demoTemplate) die('У демо-копии нет пароля.');
    if (command === 'reset-password') {
      store.transaction(() => {
        store.deleteUserSessions(user.id);
        audit('user.sessions_revoke', user, { via: 'cli' });
      });
      console.log('Все сессии пользователя завершены.');
    }
    try {
      printLink(user, await context.invitations.issue({ user, actor: null, source: 'cli', base: linkBase() }));
      if (context.mfa?.hasMfa(user.id)) {
        console.log('У аккаунта включена двухфакторная защита: по ссылке пароль сменится только вместе со вторым фактором владельца. Утрачены все факторы — сначала mfa-reset --email ….');
      }
    } catch (error) {
      die(error.message);
    }
    break;
  }
  case 'restore-admin': {
    const user = findByEmail(option('email'));
    store.transaction(() => {
      store.updateUser(user.id, { role: 'superadmin', status: 'active', blockedUntil: null, blockReason: null }, { now: Date.now() });
      audit('user.role', user, { from: user.role, to: 'superadmin', status: { from: user.status, to: 'active' }, via: 'cli' });
    });
    console.log(`${user.email}: роль superadmin, статус «активен».`);
    if (!user.activatedAt) console.log('Аккаунт ещё не активирован — выдайте ссылку: npm run accounts -- access-link --email …');
    break;
  }
  case 'mfa-reset': {
    const user = findByEmail(option('email'));
    if (user.demoTemplate) die('У демо-копии нет факторов входа.');
    if (!flag('yes')) {
      if (!process.stdin.isTTY) die('Подтвердите в терминале или передайте --yes.');
      console.log(`Будут удалены все факторы входа и резервные коды ${user.email}, завершены все сессии.`);
      const answer = await ask('Введите email ещё раз для подтверждения: ');
      if (normalizeEmail(answer) !== user.email) die('Email не совпал — ничего не изменено.');
    }
    const revoked = store.transaction(() => {
      const count = context.mfa.resetAll(user.id);
      store.deleteUserSessions(user.id);
      store.deleteUserDevices(user.id);
      audit('user.mfa_reset', user, { factors: count, via: 'cli' });
      store.addAuthEvent({ at: Date.now(), type: 'mfa_reset', userId: user.id, reason: 'cli' });
      return count;
    });
    console.log(`${user.email}: удалено факторов — ${revoked}, резервные коды и сессии сброшены.`);
    console.log('Дальше: войдите паролем (если пароль тоже утрачен — access-link --email …) и сразу настройте второй фактор.');
    break;
  }
  case 'unlock': {
    const user = findByEmail(option('email'));
    const cleared = context.throttle.clearAccount(emailKey(user.email));
    audit('user.login_unlock', user, { cleared, via: 'cli' });
    store.addAuthEvent({ at: Date.now(), type: 'login_unlocked', userId: user.id, reason: 'cli' });
    console.log(`${user.email}: ограничения входа сняты (${cleared}).`);
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
    console.log(`Ожидают активации: ${store.countPendingUsers()}`);
    console.log(`Активных суперадминистраторов: ${store.countActiveSuperadmins()}`);
    console.log(`Регистрация: ${context.registration.mode === 'open' ? (context.registration.enabled ? 'открыта' : 'open, но почта не настроена — выключена') : 'только по приглашению'}`);
    const staff = store.listUsers({ filters: { roles: ['superadmin', 'admin', 'moderator'], kind: 'real' }, sort: 'role', dir: 'desc', limit: 100, now: Date.now() }).rows;
    const withoutMfa = staff.filter((user) => store.countActiveFactors(user.id) === 0);
    console.log(`Сотрудников без второго фактора: ${withoutMfa.length}${withoutMfa.length ? ` (${withoutMfa.map((user) => user.email).join(', ')}) — админ-панель попросит настроить при входе` : ''}`);
    if (store.migrationBackup) console.log(`Перед миграцией сделана копия базы: ${store.migrationBackup}`);
    const mail = context.delivery.describe();
    console.log(mail.mode === 'smtp' ? `Почта: SMTP ${mail.host}, ссылки ведут на ${mail.appUrl}` : `Почта: не настроена — ссылки передаются вручную${mail.problems.length ? ` (${mail.problems.join('; ')})` : ''}`);
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
    console.log('Команды: bootstrap, seed-test-users, access-link, reset-password, restore-admin, mfa-reset, unlock, list-staff, status, backup. Подробности — docs/accounts.md.');
    if (command) process.exitCode = 1;
}

store.close();
