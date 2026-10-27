/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Настройка почты и транспорт писем. Очередь, повторы и лимиты — в
 * backend/mail/outbox.js, тексты — в backend/mail/templates.js.
 *
 * Два режима, и третьего нет:
 *   smtp   — письма уходят через настоящий SMTP-сервер; пользователь может
 *            сам регистрироваться (если REGISTRATION_MODE=open) и запрашивать
 *            ссылку для смены пароля;
 *   manual — почта не настроена: ссылку-приглашение один раз видит
 *            администратор, который её создал, и передаёт человеку сам.
 *            Самостоятельные регистрация и восстановление выключены.
 * Имитации отправки нет: если SMTP не настроен, писем нет.
 *
 * Переменные (старые имена тоже работают):
 *   SMTP_URL или SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE;
 *   SMTP_FROM (или MAIL_FROM) — «МедКарта <noreply@navimed.tech>»;
 *   PUBLIC_BASE_URL (или APP_URL) — https://navimed.tech: от него строятся
 *   все ссылки в письмах. Заголовок Host запроса для ссылок не используется.
 *   Если задан ALLOWED_HOSTS, адрес обязан быть в этом списке.
 *
 * Токен живёт только в ссылке: в журналах, аналитике и аудите его нет.
 */

import { logger } from '../observability/safeLogger.js';
import { buildMessage, MailError, sendMail, smtpConfigFromEnv } from '../mail/smtp.js';
import { renderMail } from '../mail/templates.js';

/** «МедКарта <noreply@navimed.tech>» или просто адрес. */
export const parseMailFrom = (value) => {
  const text = String(value || '').trim();
  const match = text.match(/^(.*?)\s*<([^<>]+)>$/);
  return match ? { name: match[1].replace(/^"|"$/g, '').trim(), address: match[2].trim() } : { name: '', address: text };
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Публичный адрес приложения для ссылок в письмах: только из настроек, не из
 * заголовка Host. https (или http для localhost при разработке); при заданном
 * ALLOWED_HOSTS — только из этого списка. Иначе null.
 */
export const appUrlFromEnv = (env = process.env) => {
  const raw = env.PUBLIC_BASE_URL || env.APP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    if (url.username || url.password) return null;
    const allowed = String(env.ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    if (allowed.length > 0 && !local && !allowed.includes(url.host.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
};

/** Ссылка: токен — во фрагменте (#), он не уходит на сервер, в журналы и в Referer. */
export const accessLink = (base, token, page = '/activate') => `${base}${page}#token=${token}`;

/** Текст письма со ссылкой (приглашение или смена пароля) — для совместимости и тестов. */
export const accessLinkMessage = ({ purpose, name = '', link, expiresAt, inviter = '' }) =>
  renderMail(purpose === 'invite' ? 'invite' : 'reset', { name, link, expiresAt, inviter });

/**
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.send] транспорт ({to, message, content}) — по умолчанию SMTP; подменяется в тестах
 */
export const createDelivery = ({ env = process.env, send = null } = {}) => {
  const smtp = smtpConfigFromEnv(env);
  const from = parseMailFrom(env.SMTP_FROM || env.MAIL_FROM);
  const appUrl = appUrlFromEnv(env);
  const problems = [];
  if (smtp?.error) problems.push(smtp.error);
  if (smtp && !smtp.error && !from.address) problems.push('SMTP_FROM (MAIL_FROM) не задан');
  if (smtp && !smtp.error && !appUrl) problems.push('PUBLIC_BASE_URL (APP_URL) не задан, не https или не входит в ALLOWED_HOSTS');
  const configured = Boolean((smtp && !smtp.error && from.address && appUrl) || (send && from.address && appUrl));
  if (problems.length > 0) logger.warn('mail.not_configured', { status: 'manual', count: problems.length });

  // TLS всегда с проверкой сертификата (по умолчанию в node:tls); отключить её из настроек нельзя.
  const smtpSend = async ({ to, message }) => sendMail({ ...smtp, from: from.address, to, message, tls: {} });
  const transport = send || smtpSend;

  return Object.freeze({
    mode: configured ? 'smtp' : 'manual',
    /** Письма уходят: можно отправлять приглашения и давать пользователю запросить ссылку. */
    emailEnabled: configured,
    appUrl,
    problems,
    fromAddress: from.address || null,
    describe: () => ({
      mode: configured ? 'smtp' : 'manual',
      host: configured && smtp && !smtp.error ? smtp.host : null,
      from: configured ? from.address : null,
      appUrl,
      problems,
    }),

    /** Отправить готовое письмо ({subject, text, html}). Ошибка — MailError с кодом, без подробностей сервера. */
    async deliver({ to, content }) {
      if (!configured) throw new MailError('mail_disabled', 'Почта не настроена');
      const message = buildMessage({ from: from.address, fromName: from.name || 'МедКарта', to, ...content });
      try {
        await transport({ to, message, content });
      } catch (error) {
        throw error instanceof MailError ? error : new MailError('mail_error', 'Письмо не отправлено');
      }
    },
  });
};
