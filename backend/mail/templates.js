/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Тексты писем МедКарты: HTML в фирменном стиле и такая же текстовая версия.
 *
 * Что в письмах есть и чего нет:
 *   - есть: зачем пришло письмо, кнопка-ссылка (если нужна), срок действия,
 *     что делать, если это были не вы;
 *   - нет: симптомов, запросов к ассистенту, истории поиска, записей к
 *     врачам, паролей, кодов MFA и полного адреса другого ящика (маска).
 * Все подставляемые значения экранируются; ссылки строятся только от
 * PUBLIC_BASE_URL (delivery.js), не от заголовка Host.
 */

const MOSCOW_DATE = { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' };

export const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export const formatMoscow = (ms) => `${new Date(ms).toLocaleString('ru-RU', MOSCOW_DATE)} (МСК)`;

const minutesText = (minutes) => {
  const value = Math.round(minutes);
  if (value % 60 === 0 && value >= 60) {
    const hours = value / 60;
    const word = hours % 10 === 1 && hours % 100 !== 11 ? 'час' : [2, 3, 4].includes(hours % 10) && ![12, 13, 14].includes(hours % 100) ? 'часа' : 'часов';
    return `${hours} ${word}`;
  }
  const word = value % 10 === 1 && value % 100 !== 11 ? 'минуту' : [2, 3, 4].includes(value % 10) && ![12, 13, 14].includes(value % 100) ? 'минуты' : 'минут';
  return `${value} ${word}`;
};

const greetingOf = (name) => (name ? `Здравствуйте, ${name}!` : 'Здравствуйте!');

const FOOTER = 'Это автоматическое письмо сервиса «МедКарта». Отвечать на него не нужно.';

/**
 * Письмо из частей: заголовок, абзацы, кнопка, заметка мелким шрифтом.
 * HTML — таблицы и встроенные стили: так письмо одинаково выглядит в
 * почтовых клиентах; ширина до 520 px, на телефоне — во всю ширину.
 */
const compose = ({ subject, greeting, paragraphs = [], button = null, note = [], preheader = '' }) => {
  const text = [
    greeting,
    '',
    ...paragraphs.flatMap((paragraph) => [paragraph, '']),
    ...(button ? [`${button.label}: ${button.link}`, ''] : []),
    ...note.flatMap((line) => [line, '']),
    '—',
    'Команда «МедКарты»',
    FOOTER,
  ].join('\r\n');

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader || paragraphs[0] || '')}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a">
<tr><td style="padding:24px 28px 0">
<table role="presentation" cellspacing="0" cellpadding="0"><tr>
<td style="width:32px;height:32px;border-radius:9px;background:#1d4ed8;color:#ffffff;font-size:17px;font-weight:700;text-align:center;line-height:32px">М</td>
<td style="padding-left:10px;font-size:17px;font-weight:700;color:#1d4ed8;letter-spacing:-0.01em">МедКарта</td>
</tr></table></td></tr>
<tr><td style="padding:22px 28px 0;font-size:20px;line-height:28px;font-weight:700;color:#0f172a">${escapeHtml(subject.replace(/\s+—\s+МедКарта$/u, ''))}</td></tr>
<tr><td style="padding:14px 28px 0;font-size:15px;line-height:23px">${escapeHtml(greeting)}</td></tr>
${paragraphs.map((paragraph) => `<tr><td style="padding:10px 28px 0;font-size:15px;line-height:23px;color:#1e293b">${escapeHtml(paragraph)}</td></tr>`).join('\n')}
${button ? `<tr><td style="padding:22px 28px 4px"><a href="${escapeHtml(button.link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;padding:13px 22px;border-radius:10px">${escapeHtml(button.label)}</a></td></tr>
<tr><td style="padding:10px 28px 0;font-size:12.5px;line-height:18px;color:#64748b">Если кнопка не работает, скопируйте ссылку в адресную строку браузера:<br><span style="word-break:break-all;color:#334155">${escapeHtml(button.link)}</span></td></tr>` : ''}
${note.length ? `<tr><td style="padding:18px 28px 0"><div style="border-top:1px solid #e2e8f0"></div></td></tr>
${note.map((line) => `<tr><td style="padding:12px 28px 0;font-size:13.5px;line-height:20px;color:#475569">${escapeHtml(line)}</td></tr>`).join('\n')}` : ''}
<tr><td style="padding:22px 28px 26px;font-size:13.5px;line-height:20px;color:#475569">Команда «МедКарты»</td></tr>
</table>
<p style="max-width:520px;margin:14px auto 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:12px;line-height:17px;color:#94a3b8;text-align:center">${escapeHtml(FOOTER)}</p>
</td></tr></table></body></html>`;
  return { subject, text, html };
};

const NOT_YOU_SECURITY = 'Если это были не вы, срочно смените пароль и завершите все сессии в разделе «Безопасность» профиля или напишите в поддержку МедКарты.';

const TEMPLATES = {
  register_confirm: ({ link, expiresAt, ttlMinutes }) => compose({
    subject: 'Подтверждение электронной почты — МедКарта',
    greeting: 'Здравствуйте!',
    paragraphs: [
      'Вы получили это письмо, потому что для вашего адреса электронной почты запрошена регистрация в сервисе «МедКарта».',
      'Чтобы завершить регистрацию, подтвердите email и установите пароль.',
    ],
    button: { label: 'Подтвердить email', link },
    note: [
      `Ссылка действительна в течение ${minutesText(ttlMinutes)} — до ${formatMoscow(expiresAt)} — и срабатывает один раз.`,
      'Если вы не запрашивали регистрацию, просто проигнорируйте письмо: без перехода по ссылке аккаунт не будет создан.',
    ],
  }),

  register_exists: ({ loginLink, resetLink }) => compose({
    subject: 'Вы уже зарегистрированы — МедКарта',
    greeting: 'Здравствуйте!',
    paragraphs: [
      'Для вашего адреса запросили регистрацию в «МедКарте», но аккаунт с этим email уже есть — второй создать нельзя.',
      'Чтобы войти, используйте свой пароль. Если вы его не помните, задайте новый по ссылке «Забыли пароль?» на странице входа.',
    ],
    button: { label: 'Войти в МедКарту', link: loginLink },
    note: [
      `Восстановить пароль: ${resetLink}`,
      'Если регистрацию запрашивали не вы, ничего делать не нужно: пароль и аккаунт не изменились.',
    ],
  }),

  register_pending: ({ loginLink }) => compose({
    subject: 'Для вас уже создан аккаунт — МедКарта',
    greeting: 'Здравствуйте!',
    paragraphs: [
      'Для вашего адреса запросили регистрацию в «МедКарте», но аккаунт с этим email уже создан администратором и ждёт активации.',
      'Откройте ссылку из письма-приглашения. Если его нет или срок истёк, на странице входа нажмите «Нет пароля или забыли его?» — мы пришлём новую ссылку.',
    ],
    button: { label: 'Открыть страницу входа', link: loginLink },
    note: ['Если регистрацию запрашивали не вы, просто проигнорируйте письмо.'],
  }),

  invite: ({ name, link, expiresAt, inviter }) => compose({
    subject: 'Приглашение в МедКарту',
    greeting: greetingOf(name),
    paragraphs: [
      `${inviter ? `${inviter} создал(а) для вас аккаунт` : 'Для вас создан аккаунт'} в сервисе «МедКарта». Чтобы войти, откройте ссылку и придумайте пароль.`,
    ],
    button: { label: 'Принять приглашение', link },
    note: [
      `Ссылка одноразовая и действует до ${formatMoscow(expiresAt)}.`,
      'Если вы не ждали этого письма, просто удалите его: без перехода по ссылке аккаунт не активируется.',
    ],
  }),

  reset: ({ name, link, expiresAt }) => compose({
    subject: 'Восстановление пароля — МедКарта',
    greeting: greetingOf(name),
    paragraphs: ['Вы (или кто-то от вашего имени) запросили смену пароля в «МедКарте». Откройте ссылку и задайте новый пароль.'],
    button: { label: 'Задать новый пароль', link },
    note: [
      `Ссылка одноразовая и действует до ${formatMoscow(expiresAt)}. После смены пароля все сессии завершатся.`,
      'Если вы ничего не запрашивали, ничего не делайте — пароль останется прежним.',
    ],
  }),

  password_changed: ({ name, at, how }) => compose({
    subject: 'Пароль изменён — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [
      `Пароль от вашего аккаунта в «МедКарте» изменён ${formatMoscow(at)}${how === 'reset' ? ' по ссылке из письма' : ''}. Все прежние сессии завершены.`,
    ],
    note: [NOT_YOU_SECURITY],
  }),

  email_change_confirm: ({ name, link, expiresAt }) => compose({
    subject: 'Подтвердите новый email — МедКарта',
    greeting: greetingOf(name),
    paragraphs: ['Вы указали этот адрес как новый email для входа в «МедКарту». Чтобы завершить смену, подтвердите его.'],
    button: { label: 'Подтвердить новый email', link },
    note: [
      `Ссылка одноразовая и действует до ${formatMoscow(expiresAt)}. До подтверждения входить нужно по прежнему адресу.`,
      'Если вы ничего не меняли, просто проигнорируйте письмо: адрес не изменится.',
    ],
  }),

  email_verify: ({ name, link, expiresAt }) => compose({
    subject: 'Подтверждение электронной почты — МедКарта',
    greeting: greetingOf(name),
    paragraphs: ['Подтвердите, что этот адрес принадлежит вам: так мы сможем присылать на него ссылки для восстановления доступа и уведомления о безопасности.'],
    button: { label: 'Подтвердить email', link },
    note: [`Ссылка одноразовая и действует до ${formatMoscow(expiresAt)}.`, 'Если вы ничего не запрашивали, просто проигнорируйте письмо.'],
  }),

  email_change_requested: ({ name, newEmail, at }) => compose({
    subject: 'Запрошена смена email — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} для вашего аккаунта в «МедКарте» запрошена смена email на ${newEmail}. Адрес изменится только после подтверждения по ссылке, отправленной на новый ящик.`],
    note: [NOT_YOU_SECURITY],
  }),

  email_change_taken: () => compose({
    subject: 'Адрес уже используется — МедКарта',
    greeting: 'Здравствуйте!',
    paragraphs: ['Этот адрес пытались указать как новый email для другого аккаунта «МедКарты». Он уже привязан к аккаунту, поэтому ничего не изменилось.'],
    note: ['Если это были вы, войдите в аккаунт с этим адресом. Если нет — просто проигнорируйте письмо.'],
  }),

  email_changed: ({ name, newEmail, at }) => compose({
    subject: 'Email изменён — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} email для входа в «МедКарту» изменён на ${newEmail}. Письма теперь приходят на новый адрес, остальные сессии завершены.`],
    note: [NOT_YOU_SECURITY],
  }),

  mfa_enabled: ({ name, method, at }) => compose({
    subject: 'Включена двухфакторная защита — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} к вашему аккаунту добавлен второй фактор входа: ${method}. Теперь после пароля нужно подтверждать вход.`],
    note: ['Сохраните резервные коды в надёжном месте: они понадобятся, если телефон или ключ потеряется.', NOT_YOU_SECURITY],
  }),

  mfa_disabled: ({ name, method, at, remaining }) => compose({
    subject: 'Удалён фактор входа — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} из вашего аккаунта удалён фактор входа: ${method}. ${remaining > 0 ? `Осталось факторов: ${remaining}.` : 'Двухфакторная защита выключена.'}`],
    note: [NOT_YOU_SECURITY],
  }),

  mfa_reset: ({ name, at }) => compose({
    subject: 'Двухфакторная защита сброшена — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [
      `${formatMoscow(at)} администратор МедКарты по вашему обращению сбросил двухфакторную защиту аккаунта: ключи доступа, приложения-аутентификаторы и резервные коды удалены, все сеансы завершены.`,
      'Войдите по email и паролю и сразу включите защиту снова в разделе «Безопасность аккаунта» профиля.',
    ],
    note: ['Если вы не обращались в поддержку — немедленно свяжитесь с ней и смените пароль: кто-то мог выдать себя за вас.'],
  }),

  reset_link_issued: ({ name, at }) => compose({
    subject: 'Администратор выдал ссылку для смены пароля — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} администратор МедКарты выдал ссылку для смены пароля вашего аккаунта и передаёт её лично. Прежний пароль действует, пока по ссылке не задан новый.`],
    note: ['Если вы не просили помочь со входом — свяжитесь с поддержкой.'],
  }),

  /*
   * Обращения по персональным данным. Текст обращения и ответ в письмо не
   * вставляются: они могут содержать лишнее, а письмо проходит через
   * почтовые серверы. Человек читает ответ в профиле после входа.
   */
  privacy_request_received: ({ name, requestId, typeLabel, dueAt }) => compose({
    subject: 'Обращение по персональным данным получено — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [
      `Мы получили ваше обращение «${typeLabel}» (№ ${String(requestId || '').slice(0, 8)}).`,
      `Ответим не позже ${formatMoscow(dueAt)}. Ответ появится в профиле, в разделе «Мои данные», — мы пришлём письмо, когда он будет готов.`,
    ],
    note: ['Если вы не отправляли обращение — смените пароль и завершите другие сеансы в профиле.'],
  }),

  privacy_request_update: ({ name, requestId, typeLabel, statusLabel, dueAt, extended }) => compose({
    subject: extended ? 'Срок ответа на обращение продлён — МедКарта' : 'Ответ на обращение по персональным данным — МедКарта',
    greeting: greetingOf(name),
    paragraphs: extended
      ? [`Срок ответа на обращение «${typeLabel}» (№ ${String(requestId || '').slice(0, 8)}) продлён до ${formatMoscow(dueAt)}. Причина указана в профиле, в разделе «Мои данные».`]
      : [`Обращение «${typeLabel}» (№ ${String(requestId || '').slice(0, 8)}): ${String(statusLabel || '').toLowerCase()}. Ответ — в профиле, в разделе «Мои данные».`],
    note: ['Письмо отправлено автоматически, отвечать на него не нужно.'],
  }),

  recovery_codes: ({ name, at }) => compose({
    subject: 'Новые резервные коды — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} для вашего аккаунта выпущены новые резервные коды. Прежние коды больше не действуют.`],
    note: [NOT_YOU_SECURITY],
  }),

  recovery_code_used: ({ name, at, remaining }) => compose({
    subject: 'Вход по резервному коду — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} в ваш аккаунт вошли с резервным кодом. Неиспользованных кодов осталось: ${remaining}.`],
    note: ['Если коды заканчиваются, выпустите новые в разделе «Безопасность» профиля.', NOT_YOU_SECURITY],
  }),

  new_login: ({ name, at, client, network }) => compose({
    subject: 'Вход с нового устройства — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [`${formatMoscow(at)} в ваш аккаунт «МедКарты» вошли с устройства, которое мы раньше не видели: ${client || 'неизвестный браузер'}${network ? `, сеть ${network}` : ''}.`],
    note: [NOT_YOU_SECURITY],
  }),

  login_locked: ({ name, at, minutes }) => compose({
    subject: 'Подозрительные попытки входа — МедКарта',
    greeting: greetingOf(name),
    paragraphs: [
      `${formatMoscow(at)} в ваш аккаунт много раз подряд пытались войти с неверным паролем. Вход с незнакомых устройств приостановлен на ${minutesText(minutes)}.`,
      'С устройства, с которого вы уже входили, войти можно как обычно.',
    ],
    note: ['Если это были вы — просто подождите или восстановите пароль. Если нет — пароль, скорее всего, пытаются подобрать: проверьте, что он длинный и не используется на других сайтах, и включите двухфакторную защиту.'],
  }),
};

export const MAIL_KINDS = Object.freeze(Object.keys(TEMPLATES));

/** Письма со ссылками-ключами: их тело хранится в очереди только зашифрованным. */
export const SECRET_KINDS = Object.freeze(new Set(['register_confirm', 'invite', 'reset', 'email_change_confirm', 'email_verify']));

/** Уведомления о действиях с аккаунтом (их вызывает сам владелец): свой лимит, не общий с информационными. */
export const ACCOUNT_NOTICE_KINDS = Object.freeze(new Set([
  'password_changed', 'email_changed', 'email_change_requested', 'mfa_enabled', 'mfa_disabled', 'recovery_codes', 'recovery_code_used',
  'mfa_reset', 'reset_link_issued', 'privacy_request_received', 'privacy_request_update',
]));

/** Письмо по виду: {subject, text, html}. */
export const renderMail = (kind, params = {}) => {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`unknown mail kind ${kind}`);
  return template(params);
};
