/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Доставка ссылок для входа: приглашений и ссылок для смены пароля.
 *
 * Два режима, и третьего нет:
 *   smtp   — письмо уходит через настоящий SMTP-сервер (SMTP_URL, MAIL_FROM,
 *            APP_URL); пользователь может и сам запросить ссылку на почту;
 *   manual — почта не настроена: ссылку один раз видит администратор,
 *            который её создал, и передаёт человеку сам. Самостоятельный
 *            запрос ссылки выключен, интерфейс так и говорит.
 * Имитации отправки нет: если SMTP не настроен, писем нет.
 *
 * Токен живёт только в ссылке: в журналах, аналитике и аудите его нет.
 */

import { logger } from '../observability/safeLogger.js';
import { buildMessage, MailError, sendMail, smtpConfigFromEnv } from '../mail/smtp.js';

const MOSCOW = { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** «МедКарта <noreply@medkarta.ru>» или просто адрес. */
export const parseMailFrom = (value) => {
  const text = String(value || '').trim();
  const match = text.match(/^(.*?)\s*<([^<>]+)>$/);
  return match ? { name: match[1].replace(/^"|"$/g, '').trim(), address: match[2].trim() } : { name: '', address: text };
};

/** Публичный адрес приложения для ссылок в письмах: только из настроек, не из заголовка Host. */
export const appUrlFromEnv = (env = process.env) => {
  if (!env.APP_URL) return null;
  try {
    const url = new URL(env.APP_URL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.origin;
  } catch {
    return null;
  }
};

/** Ссылка: токен — во фрагменте (#), он не уходит на сервер, в журналы и в Referer. */
export const accessLink = (base, token) => `${base}/activate#token=${token}`;

const formatUntil = (ms) => new Date(ms).toLocaleString('ru-RU', MOSCOW);

/** Текст письма: приглашение или смена пароля. */
export const accessLinkMessage = ({ purpose, name = '', link, expiresAt, inviter = '' }) => {
  const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  const until = `${formatUntil(expiresAt)} (МСК)`;
  if (purpose === 'invite') {
    const who = inviter ? `${inviter} создал(а) для вас аккаунт` : 'Для вас создан аккаунт';
    const text = [
      greeting,
      '',
      `${who} в МедКарте. Чтобы войти, откройте ссылку и придумайте пароль:`,
      link,
      '',
      `Ссылка одноразовая и действует до ${until}.`,
      'Если вы не ждали этого письма, просто удалите его: без перехода по ссылке аккаунт не активируется.',
    ].join('\r\n');
    return { subject: 'Приглашение в МедКарту', text, html: htmlLetter({ greeting, lead: `${who} в МедКарте. Чтобы войти, придумайте пароль.`, button: 'Принять приглашение', link, note: `Ссылка одноразовая и действует до ${until}. Если вы не ждали этого письма, просто удалите его — без перехода по ссылке аккаунт не активируется.` }) };
  }
  const text = [
    greeting,
    '',
    'Вы (или кто-то от вашего имени) запросили смену пароля в МедКарте. Откройте ссылку и задайте новый пароль:',
    link,
    '',
    `Ссылка одноразовая и действует до ${until}.`,
    'Если вы ничего не запрашивали, ничего не делайте: пароль останется прежним.',
  ].join('\r\n');
  return { subject: 'Смена пароля в МедКарте', text, html: htmlLetter({ greeting, lead: 'Чтобы задать новый пароль в МедКарте, откройте ссылку.', button: 'Задать новый пароль', link, note: `Ссылка одноразовая и действует до ${until}. Если вы ничего не запрашивали, ничего не делайте — пароль останется прежним.` }) };
};

const htmlLetter = ({ greeting, lead, button, link, note }) => `<!doctype html>
<html lang="ru"><body style="margin:0;padding:24px;background:#f4f6f9;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1e293b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px">
<tr><td style="padding:28px 28px 8px;font-size:18px;font-weight:700;color:#1d4ed8">МедКарта</td></tr>
<tr><td style="padding:8px 28px 0;font-size:15px;line-height:22px">${escapeHtml(greeting)}</td></tr>
<tr><td style="padding:8px 28px 20px;font-size:15px;line-height:22px">${escapeHtml(lead)}</td></tr>
<tr><td style="padding:0 28px 20px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:10px">${escapeHtml(button)}</a></td></tr>
<tr><td style="padding:0 28px 24px;font-size:13px;line-height:19px;color:#64748b">${escapeHtml(note)}</td></tr>
</table></td></tr></table></body></html>`;

/**
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {Function} [options.send] транспорт ({from, fromName, to, message}) — по умолчанию SMTP; подменяется в тестах
 */
export const createDelivery = ({ env = process.env, send = null } = {}) => {
  const smtp = smtpConfigFromEnv(env);
  const from = parseMailFrom(env.MAIL_FROM);
  const appUrl = appUrlFromEnv(env);
  const problems = [];
  if (smtp?.error) problems.push(smtp.error);
  if (smtp && !smtp.error && !from.address) problems.push('MAIL_FROM не задан');
  if (smtp && !smtp.error && !appUrl) problems.push('APP_URL не задан или не https');
  const configured = Boolean((smtp && !smtp.error && from.address && appUrl) || (send && from.address && appUrl));
  if (problems.length > 0) logger.warn('mail.not_configured', { status: 'manual', count: problems.length });

  const transport = send || (async ({ to, message }) => sendMail({ ...smtp, from: from.address, to, message, tls: {} }));

  return Object.freeze({
    mode: configured ? 'smtp' : 'manual',
    /** Письма уходят: можно отправлять приглашения и давать пользователю запросить ссылку. */
    emailEnabled: configured,
    appUrl,
    problems,
    describe: () => ({
      mode: configured ? 'smtp' : 'manual',
      host: configured && smtp && !smtp.error ? smtp.host : null,
      from: configured ? from.address : null,
      appUrl,
      problems,
    }),

    /** Отправить письмо со ссылкой. Ошибка — MailError с кодом, без подробностей сервера. */
    async sendAccessLink({ to, purpose, name, link, expiresAt, inviter }) {
      if (!configured) throw new MailError('mail_disabled', 'Почта не настроена');
      const content = accessLinkMessage({ purpose, name, link, expiresAt, inviter });
      const message = buildMessage({ from: from.address, fromName: from.name || 'МедКарта', to, ...content });
      try {
        await transport({ to, message, content });
      } catch (error) {
        logger.warn('mail.send_failed', { status: 'failed', error_code: error instanceof MailError ? error.code : 'mail_error' });
        throw error instanceof MailError ? error : new MailError('mail_error', 'Письмо не отправлено');
      }
      logger.event('mail.sent', { status: 'sent', action: purpose });
    },
  });
};
