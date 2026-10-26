/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Документы для пользователей и цели обработки, которые учитываются в журнале
 * согласий. Один источник для сервера (проверка при регистрации, журнал,
 * выгрузка данных) и интерфейса (ссылки, отметки, раздел «Мои данные»).
 *
 * Тексты документов — в каталоге legal/ (по файлу на редакцию, редакции не
 * перезаписываются), список редакций и их SHA-256 — legal/manifest.json.
 *
 * Правовые основания расписаны в docs/privacy/02-legal-bases.md. Здесь —
 * только то, что нужно коду:
 *   acceptance       — принятие пользовательского соглашения (договор,
 *                      п. 5 ч. 1 ст. 6 152-ФЗ). Не согласие на обработку.
 *   acknowledgement  — ознакомление с политикой обработки ПДн (ч. 2 ст. 18.1).
 *   consent          — согласие (ст. 9): отдельным документом, без заранее
 *                      поставленной отметки, с возможностью отзыва.
 */

/** Метка незаполненных сведений об операторе: документ с ней — черновик. */
export const LEGAL_PLACEHOLDER = '[ТРЕБУЕТСЯ ЗАПОЛНИТЬ ОПЕРАТОРОМ]';

export const LEGAL_DOCUMENTS = Object.freeze({
  privacy_policy: Object.freeze({
    title: 'Политика обработки персональных данных',
    short: 'Политика обработки ПДн',
    slug: 'privacy',
  }),
  terms: Object.freeze({
    title: 'Пользовательское соглашение',
    short: 'Пользовательское соглашение',
    slug: 'terms',
  }),
  health_consent: Object.freeze({
    title: 'Согласие на обработку сведений о состоянии здоровья (проект, не применяется)',
    short: 'Проект согласия на обработку сведений о здоровье',
    slug: 'health-consent',
  }),
});

export const LEGAL_DOCUMENT_KEYS = Object.freeze(Object.keys(LEGAL_DOCUMENTS));

/** /legal/<slug> → ключ документа. */
export const documentBySlug = (slug) => LEGAL_DOCUMENT_KEYS.find((key) => LEGAL_DOCUMENTS[key].slug === slug) || null;

export const legalPath = (key, version = null) => {
  const info = LEGAL_DOCUMENTS[key];
  if (!info) return '/';
  return version ? `/legal/${info.slug}?version=${encodeURIComponent(version)}` : `/legal/${info.slug}`;
};

/*
 * Цели в журнале согласий.
 *   required — без этого аккаунт «Пользователь» не создаётся (договор);
 *   offered  — показывается ли пользователю. Согласие на сведения о здоровье
 *              требует письменной формы (ч. 4 ст. 9, п. 1 ч. 2 ст. 10):
 *              отметка в веб-форме её не заменяет, поэтому цель не
 *              предлагается, а соответствующая обработка не ведётся
 *              (docs/privacy/04-health-data.md).
 */
export const CONSENT_PURPOSES = Object.freeze({
  terms: Object.freeze({ kind: 'acceptance', document: 'terms', required: true, offered: true, label: 'Принятие пользовательского соглашения' }),
  privacy_policy: Object.freeze({ kind: 'acknowledgement', document: 'privacy_policy', required: true, offered: true, label: 'Ознакомление с политикой обработки ПДн' }),
  health_data: Object.freeze({
    kind: 'consent', document: 'health_consent', required: false, offered: false, writtenForm: true,
    label: 'Согласие на обработку сведений о состоянии здоровья',
  }),
});

/** Цели, которые фиксируются при регистрации и активации аккаунта «Пользователь». */
export const SIGNUP_PURPOSES = Object.freeze(['terms', 'privacy_policy']);

/** Виды обращений субъекта ПДн (ст. 14, 20, 21 152-ФЗ). */
export const PRIVACY_REQUEST_TYPES = Object.freeze({
  access: Object.freeze({ label: 'Сведения об обработке моих данных', hint: 'Какие данные, зачем, на каком основании, кому передаются и как долго хранятся (ч. 7 ст. 14).' }),
  rectify: Object.freeze({ label: 'Исправить мои данные', hint: 'Если данные неполные, неточные или устарели. Имя и email можно изменить в профиле сразу.' }),
  restrict: Object.freeze({ label: 'Прекратить обработку', hint: 'Требование прекратить обработку (ч. 5.1 ст. 21). Если для неё есть иное законное основание, ответ это объяснит.' }),
  erase: Object.freeze({ label: 'Удалить мои данные', hint: 'Аккаунт «Пользователь» можно удалить сразу в профиле; здесь — если нужно что-то ещё или удаление недоступно.' }),
  withdraw: Object.freeze({ label: 'Отозвать согласие', hint: 'Отзыв согласия на обработку, основанную на согласии.' }),
  other: Object.freeze({ label: 'Другой вопрос о персональных данных', hint: 'Например, о передаче данных или о сроках хранения.' }),
});

export const PRIVACY_REQUEST_TYPE_KEYS = Object.freeze(Object.keys(PRIVACY_REQUEST_TYPES));

export const PRIVACY_REQUEST_STATUS_LABELS = Object.freeze({
  received: 'Получено',
  in_progress: 'В работе',
  completed: 'Выполнено',
  rejected: 'Отказано',
});

export const PRIVACY_LIMITS = Object.freeze({
  MESSAGE_MAX: 2000,
  RESPONSE_MAX: 4000,
  REASON_MAX: 500,
  OPEN_REQUESTS_PER_USER: 5,
});

/** Ключ в localStorage: не отправлять обезличенную статистику использования. */
export const ANALYTICS_OPT_OUT_KEY = 'medkarta.analytics.optout';
