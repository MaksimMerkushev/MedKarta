#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Проверка почты на настоящем SMTP-сервере (Yandex Cloud Postbox). Запускается
 * только вручную, в npm test не входит.
 *
 *   npm run mail:check
 *     настройки (без логина и пароля) и вход на сервер: соединение, TLS, AUTH.
 *     Письмо не отправляется, квота не тратится.
 *   npm run mail:check -- --send --to адрес
 *     одно проверочное письмо одному получателю. Адрес обязан быть в
 *     MAIL_TEST_RECIPIENTS (через запятую) — случайно написать реальному
 *     пользователю нельзя.
 *   --no-env-file — не читать .env (настройки только из окружения).
 *
 * Ответ 250 — письмо принято в очередь провайдера, а не доставлено: дошло ли
 * оно, видно только во входящих получателя (и в «Спаме»).
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

if (!flag('no-env-file')) {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // .env может не быть: настройки заданы в окружении
  }
}

const { createDelivery } = await import('../backend/accounts/delivery.js');
const { MailError, smtpConfigFromEnv } = await import('../backend/mail/smtp.js');
const { renderMail } = await import('../backend/mail/templates.js');

const HINTS = {
  smtp_auth: 'вход отклонён: проверьте идентификатор и секрет API-ключа (scope yc.postbox.send) и роль postbox.sender у сервисного аккаунта в том же каталоге',
  smtp_sender: 'отправитель не принят: адрес из SMTP_FROM должен быть создан и подтверждён в Postbox',
  smtp_quota: 'исчерпана суточная квота Postbox',
  smtp_rate: 'превышена скорость отправки: повторите через несколько секунд',
  smtp_tls: 'не удалось установить TLS или сертификат сервера не прошёл проверку',
  smtp_no_starttls: 'сервер не предложил STARTTLS: проверьте порт (587 — STARTTLS, 465 — SMTP_SECURE=tls)',
  smtp_connect: 'нет соединения: проверьте SMTP_HOST, SMTP_PORT и исходящий доступ с сервера',
  smtp_timeout: 'сервер не ответил вовремя: сеть или SMTP_TIMEOUT',
  smtp_closed: 'сервер закрыл соединение',
  smtp_uncertain: 'письмо передано, но ответа нет: могло и уйти — проверьте входящие, прежде чем повторять',
  smtp_temporary: 'временная ошибка сервера: повторите позже',
  smtp_rejected: 'сервер отказал (адрес получателя или содержимое)',
  bad_address: 'некорректный адрес отправителя или получателя',
};

const describeError = (error) => {
  if (!(error instanceof MailError)) return 'ошибка: mail_error';
  const parts = [`ошибка: ${error.code}`];
  if (error.status) parts.push(`SMTP ${error.status}${error.enhanced ? ` ${error.enhanced}` : ''}`);
  if (error.requestId) parts.push(`RequestID ${error.requestId}`);
  return `${parts.join(', ')}${HINTS[error.code] ? ` — ${HINTS[error.code]}` : ''}`;
};

const smtp = smtpConfigFromEnv(process.env);
const delivery = createDelivery({ env: process.env });
const info = delivery.describe();

console.log('Почта МедКарты');
console.log(`  режим:        ${info.mode === 'smtp' ? 'SMTP' : 'ручной (письма не уходят)'}`);
if (smtp && !smtp.error) {
  const transport = smtp.secure === 'none' ? 'без TLS (только localhost)' : `${smtp.secure === 'tls' ? 'TLS сразу' : 'STARTTLS'}, TLS не ниже 1.2, сертификат проверяется`;
  console.log(`  сервер:       ${smtp.host}:${smtp.port}, ${transport}`);
  console.log(`  вход:         ${smtp.user ? 'логин и пароль заданы' : 'без входа'}`);
  console.log(`  ожидание:     ${Math.round((smtp.timeoutMs || 20_000) / 1000)} с`);
}
console.log(`  отправитель:  ${delivery.fromAddress || '—'}`);
console.log(`  Reply-To:     ${delivery.replyTo || 'нет'}`);
console.log(`  ссылки:       ${delivery.appUrl || '—'}`);
console.log(`  квота:        ${delivery.quota.dailyLimit || 'без ограничения'} писем за 24 часа, пауза ${delivery.quota.minIntervalMs} мс`);
for (const problem of info.problems) console.log(`  проблема:     ${problem}`);

if (!smtp || smtp.error || !delivery.emailEnabled) {
  console.log('\nSMTP не настроен — проверять нечего (internal-docs/mail-setup.md).');
  process.exit(1);
}

try {
  const login = await delivery.verify();
  console.log(`\nВход на сервер: успешно${login.status ? ` (SMTP ${login.status})` : ''}.`);
} catch (error) {
  console.log(`\nВход на сервер: ${describeError(error)}.`);
  process.exit(1);
}

if (!flag('send')) {
  console.log('Письмо не отправлялось. Отправить одно проверочное: npm run mail:check -- --send --to <адрес из MAIL_TEST_RECIPIENTS>');
  process.exit(0);
}

const to = String(option('to') || '').trim().toLowerCase();
const allowed = String(process.env.MAIL_TEST_RECIPIENTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
if (!to || /[,;\s]/.test(to)) {
  console.log('Укажите одного получателя: --to адрес.');
  process.exit(2);
}
if (!allowed.includes(to)) {
  console.log('Адрес не в MAIL_TEST_RECIPIENTS: проверочное письмо уходит только на разрешённые тестовые адреса.');
  process.exit(2);
}

try {
  const accepted = await delivery.deliver({ to, content: renderMail('smtp_check', { sentAt: Date.now() }), messageId: `check-${randomBytes(8).toString('hex')}` });
  console.log(`Письмо принято сервером (SMTP ${accepted?.status || 250}): оно в очереди провайдера, но ещё не доставлено.`);
  if (accepted?.queuedAs) console.log(`  id у провайдера: ${accepted.queuedAs}`);
  if (accepted?.requestId) console.log(`  RequestID: ${accepted.requestId}`);
  console.log(`Проверьте входящие ${to} (и «Спам»): дошло ли письмо, отправитель «МедКарта <${delivery.fromAddress}>», русский текст без «кракозябр».`);
} catch (error) {
  console.log(`Письмо не отправлено: ${describeError(error)}.`);
  process.exit(1);
}
