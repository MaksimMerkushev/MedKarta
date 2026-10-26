/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Самостоятельная регистрация обычного пользователя по email.
 *
 *   1. Человек вводит email. Ответ всегда один и тот же («проверьте почту»)
 *      — по нему нельзя узнать, есть ли такой аккаунт. Вся работа идёт
 *      после ответа.
 *   2. Нет аккаунта — создаётся заявка (таблица registrations, не users:
 *      без подтверждения ящика пользователя нет вовсе), прежние заявки на
 *      этот адрес отзываются, на почту уходит одноразовая ссылка
 *      /register/confirm#token=… (256 бит, в базе — SHA-256, 30 минут).
 *      Аккаунт уже есть — на почту уходит письмо «вы уже зарегистрированы»
 *      (или «для вас создан аккаунт» — приглашение администратора), без
 *      ссылки-ключа.
 *   3. Открытие ссылки ничего не меняет (её проверяют и почтовые сканеры):
 *      страница показывает адрес и просит нажать «Продолжить» — только этот
 *      POST обменивает ссылку на контекст (cookie HttpOnly, 30 минут).
 *   4. В контексте человек задаёт пароль (POST). В одной транзакции:
 *      адрес ещё свободен → создаётся пользователь с ролью user (только
 *      user: роль из запроса не читается), email подтверждён, заявка
 *      использована, остальные заявки отозваны; выдаётся сессия.
 *
 * Режимы (REGISTRATION_MODE):
 *   open        — регистрация открыта;
 *   invite_only — только по приглашению администратора (по умолчанию).
 * Без настроенной почты регистрация выключена в любом режиме: подтвердить
 * владение ящиком нечем.
 */

import { randomBytes } from 'node:crypto';

import { addressHash } from '../mail/outbox.js';
import { accessLink } from './delivery.js';
import { hashPassword, PasswordBusyError } from './passwords.js';
import { ACCOUNT_LIMITS, cleanPersonName, EMAIL_PATTERN, fail, hashToken, maskEmail, normalizeEmail, userLabel } from './service.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const REGISTRATION_LIMITS = Object.freeze({
  // Время на пароль после нажатия «Продолжить».
  CONTEXT_TTL_MS: 30 * MINUTE,
  // Заявок на один адрес в час и в сутки (сверх — письма не уходят, ответ тот же).
  PER_EMAIL_HOUR: 3,
  PER_EMAIL_DAY: 6,
  // Письмо «вы уже зарегистрированы» — не чаще раза в 6 часов на адрес.
  EXISTS_NOTICE_MS: 6 * HOUR,
});

/**
 * Режим регистрации из окружения. В production без явного значения —
 * invite_only: публичная регистрация не открывается неявно.
 */
export const registrationModeFromEnv = (env = process.env) => {
  const value = String(env.REGISTRATION_MODE || '').trim().toLowerCase();
  if (value === 'open' || value === 'invite_only') return value;
  return 'invite_only';
};

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const stateOf = (record, stamp) => {
  if (record.usedAt) return 'used';
  if (record.revokedAt) return 'revoked';
  if (record.openedAt) return record.contextExpiresAt && record.contextExpiresAt > stamp ? 'opened' : 'expired';
  return record.expiresAt <= stamp ? 'expired' : 'active';
};

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.accounts сервис аккаунтов (service.js)
 * @param {object} deps.delivery accounts/delivery.js
 * @param {object|null} deps.mailer mail/outbox.js
 * @param {'open'|'invite_only'} [deps.mode]
 * @param {() => number} [deps.now]
 */
export const createRegistrationService = ({ store, accounts, delivery, mailer, mode = registrationModeFromEnv(), now = () => Date.now() }) => {
  const config = accounts.settings;
  const { startSession, checkNewPassword } = accounts.__internal;

  const enabled = () => mode === 'open' && Boolean(delivery.emailEnabled && mailer && delivery.appUrl);

  const busy = (error) => {
    if (error instanceof PasswordBusyError) fail('busy', 503, 'Сервер сейчас занят — повторите через минуту.');
    throw error;
  };

  const linkFailure = (state) => {
    if (state === 'expired') fail('link_expired', 410, 'Срок действия ссылки истёк. Зарегистрируйтесь ещё раз — мы пришлём новую.');
    if (state === 'revoked') fail('link_revoked', 410, 'Эта ссылка больше не действует: на адрес отправлена более новая. Откройте последнее письмо.');
    fail('link_used', 410, 'Ссылка уже использована. Если вы задали пароль — просто войдите.');
  };

  const findByToken = (token) => {
    if (typeof token !== 'string' || !TOKEN.test(token)) fail('invalid_link', 404, 'Ссылка недействительна. Проверьте, что она скопирована целиком.');
    const record = store.getRegistrationByHash(hashToken(token));
    if (!record) fail('invalid_link', 404, 'Ссылка недействительна. Проверьте, что она скопирована целиком.');
    return record;
  };

  const ttlMs = () => config.get('auth.registrationTtlMinutes') * MINUTE;

  // Письмо «вы уже зарегистрированы» на этот адрес уходило недавно?
  const recentNotice = (address, kind, stamp) =>
    store.countMailTo({ toHash: addressHash(address), since: stamp - REGISTRATION_LIMITS.EXISTS_NOTICE_MS, kinds: [kind] }) > 0;

  const service = {
    get mode() {
      return mode;
    },
    get enabled() {
      return enabled();
    },

    /**
     * Запрос регистрации. Ничего не возвращает наружу (ответ HTTP одинаков
     * для всех); результат — для тестов и журнала.
     *
     * @param {string} email
     * @param {{sourceKey?: string, ipPrefix?: string}} [context]
     */
    async request(email, { sourceKey = null, ipPrefix = null } = {}) {
      if (!enabled()) return { status: 'disabled' };
      const address = normalizeEmail(email);
      if (!address || address.length > ACCOUNT_LIMITS.MAX_EMAIL || !EMAIL_PATTERN.test(address) || address.endsWith('.example')) return { status: 'bad_email' };
      const stamp = now();
      const existing = store.getUserByEmail(address);
      const appUrl = delivery.appUrl;
      if (existing) {
        if (existing.demoTemplate || existing.status !== 'active') return { status: 'skipped' };
        const kind = existing.activatedAt ? 'register_exists' : 'register_pending';
        // Не чаще раза в 6 часов: иначе формой регистрации можно было бы засыпать чужой ящик.
        if (mailer.allows({ kind, to: address, sourceKey }).allowed && !recentNotice(address, kind, stamp)) {
          mailer.enqueue({ kind, to: address, params: { loginLink: `${appUrl}/login`, resetLink: `${appUrl}/login?step=access` }, sourceKey });
          mailer.kick();
          return { status: 'notice_sent', kind };
        }
        return { status: 'limited' };
      }
      if (store.countRecentRegistrations({ email: address, since: stamp - HOUR }) >= REGISTRATION_LIMITS.PER_EMAIL_HOUR
        || store.countRecentRegistrations({ email: address, since: stamp - 24 * HOUR }) >= REGISTRATION_LIMITS.PER_EMAIL_DAY) {
        return { status: 'limited' };
      }
      if (!mailer.allows({ kind: 'register_confirm', to: address, sourceKey }).allowed) return { status: 'limited' };
      const token = randomBytes(32).toString('base64url');
      const expiresAt = stamp + ttlMs();
      store.transaction(() => {
        const record = store.createRegistration({ id: randomBytes(12).toString('hex'), tokenHash: hashToken(token), email: address, now: stamp, expiresAt, ipPrefix });
        // Новая ссылка заменяет прежние: работает только последняя.
        store.revokeRegistrations(address, 'replaced', stamp, { exceptId: record.id });
        mailer.enqueue({
          kind: 'register_confirm',
          to: address,
          params: { link: accessLink(appUrl, token, '/register/confirm'), expiresAt, ttlMinutes: config.get('auth.registrationTtlMinutes') },
          ref: { type: 'registration', id: record.id },
          sourceKey,
        });
      });
      mailer.kick();
      return { status: 'sent' };
    },

    /** Что за ссылка — ничего не меняя (её открывают и сканеры почты): адрес маской, срок. */
    peek(token) {
      const record = findByToken(token);
      const state = stateOf(record, now());
      if (state !== 'active') linkFailure(state);
      return { email: maskEmail(record.email), expiresAt: iso(record.expiresAt) };
    },

    /**
     * Подтвердить ссылку («Продолжить»): токен больше не действует, взамен —
     * контекст на 30 минут. Тот же браузер с действующим контекстом получает
     * его обратно (перезагрузка), любой другой — «ссылка уже использована».
     */
    start(token, { contextToken = null } = {}) {
      const record = findByToken(token);
      const stamp = now();
      const state = stateOf(record, stamp);
      if (state === 'opened' && typeof contextToken === 'string' && TOKEN.test(contextToken) && hashToken(contextToken) === record.contextHash) {
        return { contextToken, context: { email: record.email, expiresAt: iso(record.contextExpiresAt) } };
      }
      if (state !== 'active') linkFailure(state);
      const fresh = randomBytes(32).toString('base64url');
      const contextExpiresAt = stamp + REGISTRATION_LIMITS.CONTEXT_TTL_MS;
      if (!store.openRegistration({ id: record.id, contextHash: hashToken(fresh), contextExpiresAt, now: stamp })) linkFailure('used');
      return { contextToken: fresh, context: { email: record.email, expiresAt: iso(contextExpiresAt) } };
    },

    /** Контекст по cookie — для перезагрузки страницы; null, если его нет. */
    context(contextToken) {
      if (typeof contextToken !== 'string' || !TOKEN.test(contextToken)) return null;
      const record = store.getRegistrationByContext(hashToken(contextToken));
      if (!record || stateOf(record, now()) !== 'opened') return null;
      return { email: record.email, expiresAt: iso(record.contextExpiresAt) };
    },

    /**
     * Задать пароль: пользователь с ролью user создан, email подтверждён,
     * вход выполнен. Имя — по желанию (его можно указать позже в профиле).
     */
    async complete(contextToken, { password, firstName = '' } = {}, { client = null, ipPrefix = null } = {}) {
      const expired = () => fail('activation_expired', 410, 'Время на создание пароля истекло. Откройте ссылку из письма заново или зарегистрируйтесь ещё раз.');
      if (typeof contextToken !== 'string' || !TOKEN.test(contextToken)) expired();
      const contextHash = hashToken(contextToken);
      const record = store.getRegistrationByContext(contextHash);
      if (!record || stateOf(record, now()) !== 'opened') expired();
      const first = firstName ? cleanPersonName(firstName) : '';
      if (first === null) fail('bad_name', 400, 'Имя: буквы, пробел, дефис.');
      await checkNewPassword(password, record.email);
      const passwordHash = await hashPassword(password).catch(busy);
      const stamp = now();
      const { user, session } = store.transaction(() => {
        // Пока считался хэш, заявку могли использовать в другой вкладке.
        const again = store.getRegistrationByContext(contextHash);
        if (!again || stateOf(again, stamp) !== 'opened') expired();
        if (store.getUserByEmail(again.email)) {
          store.revokeRegistrations(again.email, 'email_taken', stamp);
          fail('email_taken', 409, 'Аккаунт с этим email уже есть. Войдите или восстановите пароль.');
        }
        const id = accounts.__internal.newId();
        // Роль — только user: из запроса она не читается и выбрать её нельзя.
        const created = store.createUser({
          id, email: again.email, firstName: first || '', lastName: '', passwordHash, role: 'user',
          emailVerifiedAt: stamp, signupSource: 'self', now: stamp,
        });
        if (!store.useRegistration(again.id, stamp, created.id)) expired();
        store.revokeRegistrations(again.email, 'superseded', stamp);
        store.addAudit({ at: stamp, action: 'user.register', actorId: created.id, actorLabel: userLabel(created), targetId: created.id, targetLabel: userLabel(created), result: 'ok', details: { role: 'user' } });
        const fresh = startSession(created, { client, ipPrefix }, { aal: 1 });
        store.recordLogin(created.id, stamp);
        store.addAuthEvent({ at: stamp, type: 'account_registered', userId: created.id, sessionId: fresh.publicId, client, ipPrefix });
        return { user: created, session: fresh };
      });
      return { ...accounts.snapshot(store.getUserById(user.id)), session };
    },

    purge: () => store.purgeRegistrations(now() - 30 * 24 * HOUR),
  };

  return Object.freeze(service);
};