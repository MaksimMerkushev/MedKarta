/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Смена email самим пользователем.
 *
 *   1. В профиле человек вводит новый адрес. Нужна свежая проверка личности
 *      (пароль и, если включена, MFA — не старше 10 минут): одной украденной
 *      сессии мало.
 *   2. На новый адрес уходит одноразовая ссылка (/email/confirm#token=…,
 *      SHA-256 в базе, час по умолчанию), на прежний — уведомление «запрошена
 *      смена». Email в базе пока не меняется.
 *   3. По ссылке человек нажимает «Подтвердить» (POST): если адрес всё ещё
 *      свободен и прежний email не менялся, email заменяется, отмечается как
 *      подтверждённый, прежние ссылки отзываются, остальные сессии
 *      завершаются; на прежний адрес — письмо «email изменён».
 * Если новый адрес занят другим аккаунтом, ответ тот же («проверьте
 * почту»), а на новый адрес уходит письмо, что он уже используется: по
 * ответу API нельзя узнать, есть ли у адреса аккаунт.
 */

import { randomBytes } from 'node:crypto';

import { accessLink } from './delivery.js';
import { ACCOUNT_LIMITS, checkEmail, fail, hashToken, maskEmail, userLabel } from './service.js';
import { searchTextOf } from './sqliteStore.js';

const MINUTE = 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.accounts service.js
 * @param {object} deps.delivery accounts/delivery.js
 * @param {object|null} deps.mailer mail/outbox.js
 * @param {() => number} [deps.now]
 */
export const createEmailChangeService = ({ store, accounts, delivery, mailer, now = () => Date.now() }) => {
  const config = accounts.settings;
  const { notify } = accounts.__internal;

  const linkFailure = (code) => {
    if (code === 'expired') fail('link_expired', 410, 'Срок действия ссылки истёк. Запросите смену email заново в профиле.');
    if (code === 'used') fail('link_used', 410, 'Ссылка уже использована.');
    fail('link_revoked', 410, 'Ссылка больше не действует: email уже менялся или запрошена новая смена.');
  };

  const findActive = (token) => {
    if (typeof token !== 'string' || !TOKEN.test(token)) fail('invalid_link', 404, 'Ссылка недействительна. Проверьте, что она скопирована целиком.');
    const record = store.getAccessTokenByHash(hashToken(token));
    if (!record || record.purpose !== 'email_change' || !record.newEmail) fail('invalid_link', 404, 'Ссылка недействительна. Проверьте, что она скопирована целиком.');
    if (record.usedAt) linkFailure('used');
    if (record.revokedAt) linkFailure('revoked');
    if (record.expiresAt <= now()) linkFailure('expired');
    const user = store.getUserById(record.userId);
    if (!user || user.demoTemplate || user.status !== 'active' || user.email !== record.email) linkFailure('revoked');
    return { record, user };
  };

  return Object.freeze({
    get enabled() {
      return Boolean(delivery.emailEnabled && mailer && delivery.appUrl);
    },

    /** Запросить смену (личность уже подтверждена — проверяет HTTP-слой). */
    request(user, newEmail, { sourceKey = null } = {}) {
      if (!delivery.emailEnabled || !mailer || !delivery.appUrl) fail('mail_disabled', 409, 'Почта на сервере не настроена — сменить email может администратор.');
      const address = checkEmail(newEmail);
      if (address === user.email) fail('same_email', 400, 'Это ваш текущий email.');
      const stamp = now();
      const taken = store.getUserByEmail(address);
      if (taken) {
        if (mailer.allows({ kind: 'email_change_taken', to: address, sourceKey }).allowed) {
          mailer.enqueue({ kind: 'email_change_taken', to: address, sourceKey });
          mailer.kick();
        }
        store.addAuthEvent({ at: stamp, type: 'email_change_requested', userId: user.id, reason: 'taken' });
        return { sentTo: address };
      }
      if (!mailer.allows({ kind: 'email_change_confirm', to: address, sourceKey }).allowed) fail('rate_limited', 429, 'Слишком много писем на этот адрес. Попробуйте через час.');
      const token = randomBytes(32).toString('base64url');
      const expiresAt = stamp + config.get('auth.emailChangeTtlMinutes') * MINUTE;
      store.transaction(() => {
        store.revokeUserAccessTokens(user.id, 'replaced', stamp, { purpose: 'email_change' });
        const record = store.createAccessToken({
          id: randomBytes(12).toString('hex'), tokenHash: hashToken(token), userId: user.id, purpose: 'email_change', email: user.email,
          newEmail: address, source: 'self', delivery: 'email', deliveryStatus: 'pending', now: stamp, expiresAt,
        });
        mailer.enqueue({
          kind: 'email_change_confirm', to: address, sourceKey,
          params: { name: user.firstName || '', link: accessLink(delivery.appUrl, token, '/email/confirm'), expiresAt },
          ref: { type: 'access_token', id: record.id },
        });
        store.addAuthEvent({ at: stamp, type: 'email_change_requested', userId: user.id });
      });
      mailer.kick();
      notify(user, 'email_change_requested', { newEmail: maskEmail(address) });
      return { sentTo: address, expiresAt: iso(expiresAt) };
    },

    /**
     * Подтвердить текущий email (аккаунт создан до подтверждения адресов или
     * владельцем через CLI): та же ссылка, но адрес не меняется.
     */
    requestVerification(user, { sourceKey = null } = {}) {
      if (!delivery.emailEnabled || !mailer || !delivery.appUrl) fail('mail_disabled', 409, 'Почта на сервере не настроена.');
      if (user.emailVerifiedAt) fail('already_verified', 409, 'Email уже подтверждён.');
      if (!mailer.allows({ kind: 'email_verify', to: user.email, sourceKey }).allowed) fail('rate_limited', 429, 'Слишком много писем на этот адрес. Попробуйте через час.');
      const stamp = now();
      const token = randomBytes(32).toString('base64url');
      const expiresAt = stamp + config.get('auth.emailChangeTtlMinutes') * MINUTE;
      store.transaction(() => {
        store.revokeUserAccessTokens(user.id, 'replaced', stamp, { purpose: 'email_change' });
        const record = store.createAccessToken({
          id: randomBytes(12).toString('hex'), tokenHash: hashToken(token), userId: user.id, purpose: 'email_change', email: user.email,
          newEmail: user.email, source: 'self', delivery: 'email', deliveryStatus: 'pending', now: stamp, expiresAt,
        });
        mailer.enqueue({
          kind: 'email_verify', to: user.email, sourceKey,
          params: { name: user.firstName || '', link: accessLink(delivery.appUrl, token, '/email/confirm'), expiresAt },
          ref: { type: 'access_token', id: record.id },
        });
      });
      mailer.kick();
      return { sentTo: user.email, expiresAt: iso(expiresAt) };
    },

    /** Что за ссылка — ничего не меняя. */
    peek(token) {
      const { record, user } = findActive(token);
      return { newEmail: record.newEmail, currentEmail: maskEmail(user.email), expiresAt: iso(record.expiresAt) };
    },

    /**
     * Подтвердить: email заменён, остальные сессии завершены (кроме сессии
     * этого же пользователя в этом браузере, если она есть).
     */
    confirm(token, { currentSessionHash = null } = {}) {
      const { record, user } = findActive(token);
      const stamp = now();
      const result = store.transaction(() => {
        const again = store.getAccessTokenById(record.id);
        if (!again || again.usedAt || again.revokedAt || again.expiresAt <= stamp) linkFailure('used');
        if (!store.useAccessToken(again.id, stamp)) linkFailure('used');
        // Подтверждение текущего адреса: email не меняется, сессии не трогаем.
        if (again.newEmail === user.email) {
          store.updateUser(user.id, { emailVerifiedAt: stamp }, { now: stamp });
          store.addAuthEvent({ at: stamp, type: 'email_verified', userId: user.id });
          return { email: user.email, keptSession: true, verifiedOnly: true };
        }
        const owner = store.getUserByEmail(again.newEmail);
        if (owner) {
          store.revokeAccessToken(again.id, 'email_taken', stamp);
          fail('email_taken', 409, 'Этот адрес уже привязан к другому аккаунту.');
        }
        store.updateUser(user.id, {
          email: again.newEmail,
          emailVerifiedAt: stamp,
          searchText: searchTextOf({ firstName: user.firstName, lastName: user.lastName, email: again.newEmail, id: user.id }),
        }, { now: stamp });
        // Ссылки на прежний адрес и прочие запросы смены больше не нужны.
        store.revokeUserAccessTokens(user.id, 'email_changed', stamp);
        const current = currentSessionHash ? store.getSession(currentSessionHash) : null;
        const revoked = current && current.userId === user.id ? store.deleteOtherSessions(user.id, currentSessionHash) : store.deleteUserSessions(user.id);
        store.deleteUserDevices(user.id);
        store.addAudit({
          at: stamp, action: 'user.email_change', actorId: user.id, actorLabel: userLabel(user), targetId: user.id,
          targetLabel: userLabel({ ...user, email: again.newEmail }), result: 'ok',
          details: { email: { from: maskEmail(user.email), to: maskEmail(again.newEmail) }, sessionsRevoked: revoked },
        });
        store.addAuthEvent({ at: stamp, type: 'email_changed', userId: user.id });
        return { email: again.newEmail, keptSession: Boolean(current && current.userId === user.id) };
      });
      // Уведомление — на прежний адрес: если смену сделал не владелец, он узнает.
      if (!result.verifiedOnly) notify(user, 'email_changed', { newEmail: maskEmail(result.email) });
      return result;
    },

    MAX_EMAIL: ACCOUNT_LIMITS.MAX_EMAIL,
  });
};
