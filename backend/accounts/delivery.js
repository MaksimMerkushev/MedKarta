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
 *   SMTP_TIMEOUT — секунд на ответ сервера;
 *   SMTP_FROM (или MAIL_FROM) — «МедКарта <notifications@navimed.tech>»;
 *   SMTP_REPLY_TO — адрес для ответов (support@navimed.tech), только когда
 *   этот ящик действительно принимает письма; не задан — Reply-To нет;
 *   PUBLIC_BASE_URL (или APP_URL) — https://navimed.tech: от него строятся
 *   все ссылки в письмах. Заголовок Host запроса для ссылок не используется.
 *   Если задан ALLOWED_HOSTS, адрес обязан быть в этом списке;
 *   MAIL_DAILY_LIMIT — не больше писем за 24 часа (по умолчанию 200, квота
 *   Postbox); MAIL_MIN_INTERVAL_MS — пауза между письмами (по умолчанию
 *   1000 мс для SMTP: Postbox принимает не больше письма в секунду).
 *
 * Токен живёт только в ссылке: в журналах, аналитике и аудите его нет.
 */

import { logger } from '../observability/safeLogger.js';
import { buildMessage, checkAddress, MailError, sendMail, smtpConfigFromEnv } from '../mail/smtp.js';
import { renderMail } from '../mail/templates.js';

export const MAIL_QUOTA_DEFAULTS = Object.freeze({ DAILY_LIMIT: 200, MIN_INTERVAL_MS: 1000 });

/**
 * Квоты отправки: суточный потолок и пауза между письмами. Пауза по умолчанию
 * — только для настоящего SMTP: подменённый транспорт (тесты) её не ждёт.
 * Неверное значение — проблема настройки, а не молчаливое «без лимита».
 */
export const mailQuotaFromEnv = (env = process.env, { smtp = true } = {}) => {
  const problems = [];
  const integer = (key, fallback, max) => {
    if (env[key] === undefined || env[key] === '') return fallback;
    const value = Number(env[key]);
    if (Number.isInteger(value) && value >= 0 && value <= max) return value;
    problems.push(`${key}: целое число от 0 до ${max}`);
    return fallback;
  };
  return {
    dailyLimit: integer('MAIL_DAILY_LIMIT', MAIL_QUOTA_DEFAULTS.DAILY_LIMIT, 100_000),
    minIntervalMs: integer('MAIL_MIN_INTERVAL_MS', smtp ? MAIL_QUOTA_DEFAULTS.MIN_INTERVAL_MS : 0, 60_000),
    problems,
  };
};

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
  const quota = mailQuotaFromEnv(env, { smtp: !send });
  const problems = [...quota.problems];
  if (smtp?.error) problems.push(smtp.error);
  if (smtp && !smtp.error && !from.address) problems.push('SMTP_FROM (MAIL_FROM) не задан');
  if (smtp && !smtp.error && !appUrl) problems.push('PUBLIC_BASE_URL (APP_URL) не задан, не https или не входит в ALLOWED_HOSTS');
  let replyTo = null;
  if (env.SMTP_REPLY_TO) {
    try {
      replyTo = checkAddress(env.SMTP_REPLY_TO);
    } catch {
      // Опечатка в Reply-To не должна ломать все письма: без него, с предупреждением.
      problems.push('SMTP_REPLY_TO: некорректный адрес, письма уходят без Reply-To');
    }
  }
  const configured = Boolean((smtp && !smtp.error && from.address && appUrl) || (send && from.address && appUrl));
  if (problems.length > 0) logger.warn('mail.not_configured', { status: configured ? 'smtp' : 'manual', count: problems.length });

  // TLS всегда не ниже 1.2 и с проверкой сертификата (smtp.js); отключить проверку из настроек нельзя.
  const smtpSend = async ({ to, message }) => sendMail({ ...smtp, from: from.address, to, message, tls: {} });
  const transport = send || smtpSend;

  return Object.freeze({
    mode: configured ? 'smtp' : 'manual',
    /** Письма уходят: можно отправлять приглашения и давать пользователю запросить ссылку. */
    emailEnabled: configured,
    appUrl,
    problems,
    fromAddress: from.address || null,
    replyTo,
    quota: Object.freeze({ dailyLimit: quota.dailyLimit, minIntervalMs: quota.minIntervalMs }),
    describe: () => ({
      mode: configured ? 'smtp' : 'manual',
      host: configured && smtp && !smtp.error ? smtp.host : null,
      from: configured ? from.address : null,
      replyTo: configured ? replyTo : null,
      dailyLimit: quota.dailyLimit,
      appUrl,
      problems,
    }),

    /**
     * Отправить готовое письмо ({subject, text, html}). Ошибка — MailError с
     * кодом, без подробностей сервера. messageId — id письма в очереди: у
     * повторов тот же Message-ID.
     *
     * @returns {Promise<{status: number, queuedAs: string|null, requestId: string|null}|null>}
     */
    async deliver({ to, content, messageId = null }) {
      if (!configured) throw new MailError('mail_disabled', 'Почта не настроена', { transient: false });
      const message = buildMessage({ from: from.address, fromName: from.name || 'МедКарта', to, replyTo, messageId, ...content });
      try {
        const result = await transport({ to, message, content });
        return result && typeof result === 'object' ? result : null;
      } catch (error) {
        throw error instanceof MailError ? error : new MailError('mail_error', 'Письмо не отправлено');
      }
    },

    /** Проверка настроек без письма: соединение, TLS и вход (npm run mail:check). */
    async verify() {
      if (!smtp || smtp.error) throw new MailError('mail_disabled', 'SMTP не настроен', { transient: false });
      return sendMail({ ...smtp, from: from.address, tls: {}, verifyOnly: true });
    },
  });
};
