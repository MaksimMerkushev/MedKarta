/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Обращения субъектов персональных данных (ст. 14, 20, 21 152-ФЗ) и
 * выгрузка «Мои данные».
 *
 * Сроки ответа — в рабочих днях со дня, следующего за днём получения:
 *   сведения об обработке (ч. 7 ст. 14, ч. 1 ст. 20)      — 10, продление +5;
 *   прекращение обработки (ч. 5.1 ст. 21)                  — 10, продление +5;
 *   исправление, уничтожение (ч. 3 ст. 20)                 — 7;
 *   отзыв согласия (ч. 5 ст. 21)                           — 30 календарных;
 *   прочее                                                  — 10, продление +5.
 * Рабочие дни — понедельник–пятница по Москве; нерабочие праздничные дни не
 * учитываются, поэтому расчётный срок может наступить раньше законного (с
 * запасом), но не позже него.
 *
 * Обращение рассматривает сотрудник с правом privacy.requests: взять в
 * работу, продлить (один раз, с причиной — её увидит заявитель), выполнить
 * или отказать (ответ обязателен). Заявителю — письмо о получении и об
 * ответе. Обращение не удаляет данные само: удаление аккаунта, исправление
 * и т. д. сотрудник выполняет штатными средствами, а здесь фиксирует итог.
 */

import { randomBytes } from 'node:crypto';

import { PRIVACY_LIMITS, PRIVACY_REQUEST_STATUS_LABELS, PRIVACY_REQUEST_TYPES } from '../../shared/legal.js';
import { PROCESSING_REGISTRY, PROCESSING_REGISTRY_VERSION } from '../legal/processing.js';
import { decodeItemId, fail, maskEmail, userLabel } from './service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const REQUEST_ID = /^[a-f0-9]{24}$/;

/** Сроки по видам обращений. */
export const PRIVACY_DEADLINES = Object.freeze({
  access: Object.freeze({ days: 10, unit: 'working', extension: 5 }),
  restrict: Object.freeze({ days: 10, unit: 'working', extension: 5 }),
  rectify: Object.freeze({ days: 7, unit: 'working', extension: 0 }),
  erase: Object.freeze({ days: 7, unit: 'working', extension: 0 }),
  withdraw: Object.freeze({ days: 30, unit: 'calendar', extension: 0 }),
  other: Object.freeze({ days: 10, unit: 'working', extension: 5 }),
});

/** Конец (23:59:59.999 МСК) N-го рабочего (или календарного) дня после дня получения. */
export const deadlineAfter = (from, days, unit = 'working') => {
  // Работаем с «московскими» сутками: сдвигаем время на +3 часа и считаем по UTC.
  let day = Math.floor((from + MSK_OFFSET_MS) / DAY_MS);
  let left = days;
  while (left > 0) {
    day += 1;
    const weekday = new Date(day * DAY_MS).getUTCDay();
    if (unit === 'calendar' || (weekday !== 0 && weekday !== 6)) left -= 1;
  }
  return (day + 1) * DAY_MS - MSK_OFFSET_MS - 1;
};

const iso = (value) => (value ? new Date(value).toISOString() : null);

const cleanText = (value, max) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') fail('bad_request', 400, 'Ожидается текст.');
  // Управляющие символы (кроме табуляции и переводов строк) не нужны ни в обращении, ни в ответе.
  const text = [...value].filter((char) => {
    const code = char.codePointAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join('').trim();
  if (text.length > max) fail('too_long', 400, `Не длиннее ${max} символов.`);
  return text;
};

const requestView = (request, { forStaff = false } = {}) => ({
  id: request.id,
  type: request.type,
  typeLabel: PRIVACY_REQUEST_TYPES[request.type]?.label || request.type,
  status: request.status,
  statusLabel: PRIVACY_REQUEST_STATUS_LABELS[request.status] || request.status,
  message: request.message,
  createdAt: iso(request.createdAt),
  dueAt: iso(request.dueAt),
  extendedAt: iso(request.extendedAt),
  extensionReason: request.extensionReason,
  closedAt: iso(request.closedAt),
  response: request.response,
  ...(forStaff ? {
    userId: request.userId,
    subject: request.subjectLabel,
    handledBy: request.handledLabel,
    overdue: ['received', 'in_progress'].includes(request.status) && request.dueAt < Date.now(),
  } : {}),
});

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.accounts сервис аккаунтов (уведомления, MFA, избранное)
 * @param {object} deps.consents журнал согласий
 * @param {object} [deps.mailer] очередь писем (для уведомлений заявителю)
 * @param {(userId: string) => Promise<object[]>} [deps.demoBookingsOf] демо-записи аккаунта (для выгрузки)
 * @param {() => number} [deps.now]
 */
export const createPrivacyService = ({ store, accounts, consents, demoBookingsOf = async () => [], now = () => Date.now() }) => {
  const notify = (user, kind, params) => accounts.__internal?.notify?.(user, kind, params);
  const has = (actor, permission) => Array.isArray(actor?.permissions) && actor.permissions.includes(permission);
  const audit = (actor, action, request, details = null) => store.addAudit({
    at: now(), action, actorId: actor.id, actorLabel: userLabel(actor), targetId: request.userId, targetLabel: request.subjectLabel,
    result: 'ok', details: { request: request.id, type: request.type, ...(details || {}) },
  });
  const requireStaff = (actor) => {
    if (!has(actor, 'privacy.requests')) fail('forbidden', 403, 'Недостаточно прав.');
  };
  const findRequest = (id) => {
    const request = typeof id === 'string' && REQUEST_ID.test(id) ? store.getPrivacyRequest(id) : null;
    if (!request) fail('not_found', 404, 'Обращение не найдено.');
    return request;
  };

  const service = {
    /** Обращение от вошедшего пользователя. Текст — по желанию; сведений о здоровье в нём не нужно. */
    create(user, body = {}) {
      const extra = Object.keys(body || {}).filter((key) => !['type', 'message'].includes(key));
      if (extra.length > 0) fail('unexpected_field', 400, 'Лишние поля в запросе.');
      const type = typeof body.type === 'string' && Object.hasOwn(PRIVACY_REQUEST_TYPES, body.type) ? body.type : null;
      if (!type) fail('bad_type', 400, 'Выберите, о чём обращение.');
      const message = cleanText(body.message, PRIVACY_LIMITS.MESSAGE_MAX);
      if (store.countOpenPrivacyRequests(user.id) >= PRIVACY_LIMITS.OPEN_REQUESTS_PER_USER) {
        fail('too_many_requests', 429, 'У вас уже есть несколько обращений в работе. Дождитесь ответа на них.');
      }
      const stamp = now();
      const deadline = PRIVACY_DEADLINES[type];
      const request = store.insertPrivacyRequest({
        id: randomBytes(12).toString('hex'), userId: user.id, subjectLabel: maskEmail(user.email), type, message: message || null,
        createdAt: stamp, dueAt: deadlineAfter(stamp, deadline.days, deadline.unit),
      });
      store.addAuthEvent({ at: stamp, type: 'privacy_request', userId: user.id, reason: type });
      notify(user, 'privacy_request_received', { requestId: request.id, typeLabel: PRIVACY_REQUEST_TYPES[type].label, dueAt: request.dueAt });
      return requestView(request);
    },

    listMine: (user) => store.listUserPrivacyRequests(user.id).map((request) => requestView(request)),

    /* ------------------------------ сотрудники ------------------------------ */

    list(actor, query = {}) {
      requireStaff(actor);
      const status = ['received', 'in_progress', 'completed', 'rejected'].includes(query.status) ? query.status : null;
      const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
      const pageSize = 25;
      const { rows, total, open } = store.listPrivacyRequests({ status, limit: pageSize, offset: (page - 1) * pageSize });
      return { items: rows.map((request) => requestView(request, { forStaff: true })), total, open, page, pageSize };
    },

    get(actor, id) {
      requireStaff(actor);
      const request = findRequest(id);
      const user = request.userId ? store.getUserById(request.userId) : null;
      return {
        request: requestView(request, { forStaff: true }),
        subject: user ? { id: user.id, label: userLabel(user), role: user.role, status: user.status, exists: true } : { exists: false, label: request.subjectLabel },
        consents: request.userId ? consents.history(request.userId) : [],
        deadline: PRIVACY_DEADLINES[request.type],
      };
    },

    /** take | extend | complete | reject. */
    act(actor, id, action, body = {}) {
      requireStaff(actor);
      const request = findRequest(id);
      const extra = Object.keys(body || {}).filter((key) => !['response', 'reason'].includes(key));
      if (extra.length > 0) fail('unexpected_field', 400, 'Лишние поля в запросе.');
      const stamp = now();
      const handler = { handledBy: actor.id, handledLabel: userLabel(actor) };
      let fields;
      let expected;
      if (action === 'take') {
        fields = { status: 'in_progress', ...handler };
        expected = ['received'];
      } else if (action === 'extend') {
        const deadline = PRIVACY_DEADLINES[request.type];
        if (!deadline.extension) fail('not_extendable', 400, 'Срок по этому виду обращений не продлевается.');
        if (request.extendedAt) fail('already_extended', 409, 'Срок уже продлевался.');
        const reason = cleanText(body.reason, PRIVACY_LIMITS.REASON_MAX);
        if (reason.length < 10) fail('bad_reason', 400, 'Укажите причину продления (её увидит заявитель).');
        fields = { dueAt: deadlineAfter(request.dueAt, deadline.extension, 'working'), extendedAt: stamp, extensionReason: reason, ...handler };
        expected = ['received', 'in_progress'];
      } else if (action === 'complete' || action === 'reject') {
        const response = cleanText(body.response, PRIVACY_LIMITS.RESPONSE_MAX);
        if (response.length < 10) fail('bad_response', 400, action === 'reject' ? 'Укажите мотивированную причину отказа со ссылкой на основание.' : 'Опишите, что сделано.');
        fields = { status: action === 'complete' ? 'completed' : 'rejected', response, closedAt: stamp, ...handler };
        expected = ['received', 'in_progress'];
      } else {
        fail('not_found', 404, 'Not found');
      }
      if (!store.updatePrivacyRequest(request.id, fields, { expected, now: stamp })) {
        fail('bad_state', 409, 'Обращение уже закрыто или изменилось — обновите страницу.');
      }
      const updated = store.getPrivacyRequest(request.id);
      audit(actor, `privacy.request_${action}`, updated);
      const user = updated.userId ? store.getUserById(updated.userId) : null;
      if (user && action !== 'take') {
        notify(user, 'privacy_request_update', {
          requestId: updated.id, typeLabel: PRIVACY_REQUEST_TYPES[updated.type].label, statusLabel: PRIVACY_REQUEST_STATUS_LABELS[updated.status],
          dueAt: updated.dueAt, extended: action === 'extend',
        });
      }
      return { request: requestView(updated, { forStaff: true }) };
    },

    /* ------------------------------ выгрузка ------------------------------ */

    /**
     * Все данные человека в машиночитаемом виде и сведения об обработке
     * (ч. 7 ст. 14): цели, основания, сроки, получатели. Без секретов:
     * хэшей паролей и токенов, секретов TOTP, резервных кодов.
     */
    async exportFor(user) {
      const sessions = store.listUserSessions(user.id, now());
      const { rows: logins } = store.listAuthEvents({ userId: user.id, limit: 500 });
      const mfa = accounts.mfa ? accounts.mfa.status(user.id) : { enabled: false, factors: [], recoveryCodes: { total: 0, unused: 0 } };
      let bookings = [];
      try {
        bookings = await demoBookingsOf(user.id);
      } catch {
        bookings = [];
      }
      return {
        format: 'medkarta.subject-export',
        generatedAt: iso(now()),
        account: {
          id: user.id,
          email: user.email,
          emailVerifiedAt: iso(user.emailVerifiedAt),
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          role: user.role,
          status: user.status,
          createdAt: iso(user.createdAt),
          activatedAt: iso(user.activatedAt),
          lastLoginAt: iso(user.lastLoginAt),
          passwordChangedAt: iso(user.passwordChangedAt),
          dmsPlanId: user.dmsPlanId || null,
          hasAvatar: Boolean(user.avatarEtag),
          signupSource: user.signupSource || null,
        },
        favorites: store.listFavorites(user.id).map(decodeItemId).filter((item) => item !== null),
        sessions: sessions.map((session) => ({
          createdAt: iso(session.createdAt), lastSeenAt: iso(session.lastSeenAt), expiresAt: iso(session.expiresAt),
          client: session.client || null, network: session.ipPrefix || null, secondFactor: (session.aal || 1) >= 2,
        })),
        loginHistory: logins.map((event) => ({ at: iso(event.at), type: event.type, client: event.client || null, network: event.ipPrefix || null, reason: event.reason || null })),
        secondFactor: {
          enabled: mfa.enabled,
          factors: (mfa.factors || []).map((factor) => ({ type: factor.type, label: factor.label, createdAt: factor.createdAt, lastUsedAt: factor.lastUsedAt })),
          recoveryCodes: mfa.recoveryCodes,
        },
        demoBookings: bookings,
        documentsAndConsents: consents.history(user.id),
        privacyRequests: store.listUserPrivacyRequests(user.id).map((request) => requestView(request)),
        processing: { version: PROCESSING_REGISTRY_VERSION, purposes: PROCESSING_REGISTRY },
        notIncluded: [
          'хэш пароля, токены сессий и ссылок, секреты приложения-аутентификатора и резервные коды — не выдаются, чтобы выгрузка не стала ключом к аккаунту',
          'аватар — скачивается отдельно в профиле',
          'запросы к ассистенту — не сохраняются',
        ],
      };
    },

    /** Обращения, закрытые больше 3 лет назад. */
    purge: () => store.purgePrivacyRequests(now() - 3 * 365 * DAY_MS),
  };
  return Object.freeze(service);
};
