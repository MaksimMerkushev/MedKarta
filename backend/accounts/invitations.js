/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Приглашения и ссылки для смены пароля — вместо временных паролей.
 *
 * Как это устроено:
 *   1. Администратор создаёт аккаунт без пароля («ожидает активации») —
 *      сервис выдаёт одноразовый токен: 32 случайных байта. В базе — только
 *      SHA-256 от него; сам токен уходит письмом или один раз показывается
 *      администратору, который передаёт ссылку человеку.
 *   2. Ссылка — /activate#token=…: токен во фрагменте не попадает в журналы
 *      сервера, прокси и в Referer. Страница сразу убирает его из адреса.
 *   3. Человек подтверждает приглашение — токен меняется на короткий
 *      «контекст активации» (cookie HttpOnly на /api/auth/activation, 30 минут)
 *      и больше не действует: открыть ссылку второй раз нельзя.
 *   4. В этом контексте человек задаёт пароль — аккаунт активирован, прочие
 *      ссылки отозваны, выдаётся обычная сессия.
 *
 * Тот же механизм — ссылка для смены пароля активированного аккаунта
 * (purpose 'reset'): её выдаёт администратор или, если настроена почта,
 * запрашивает сам пользователь. Ответ на запрос одинаков для любого адреса,
 * письмо уходит только владельцу ящика — по ответу не узнать, есть ли аккаунт.
 *
 * Активацию блокируют: блокировка и архив (токены отзываются), смена email
 * (токен выдан на прежний адрес), истечение срока, повторное использование.
 *
 * Письма уходят через почтовую очередь (mail/outbox.js): ссылка от
 * администратора — сразу, одной попыткой (не ушло — администратор получает
 * ссылку и передаёт сам); запрошенная самим пользователем — в фоне, с
 * повторами. Статус доставки пишется в ссылку только по факту отправки.
 *
 * Ссылку для смены пароля сотруднику (модератор, администратор,
 * суперадминистратор) почтой без второго фактора не отправляем: иначе доступ
 * к админ-панели восстанавливался бы одним письмом. Сотрудник без MFA
 * восстанавливает доступ через другого администратора или CLI на сервере
 * (docs/accounts.md, «Восстановление доступа»). После смены пароля по ссылке
 * второй фактор остаётся включённым.
 */

import { randomBytes } from 'node:crypto';

import { accessLink } from './delivery.js';
import { hashPassword, PasswordBusyError } from './passwords.js';
import { fail, hashToken, maskEmail, normalizeEmail, userLabel, EMAIL_PATTERN, ACCOUNT_LIMITS } from './service.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ACCESS_TOKEN_ID = /^[a-f0-9]{24}$/;

export const INVITATION_LIMITS = Object.freeze({
  // Время на создание пароля после подтверждения ссылки.
  CONTEXT_TTL_MS: 30 * MINUTE_MS,
  // Самостоятельных запросов ссылки на один аккаунт в час (письма в чужой ящик не завалить).
  SELF_REQUESTS_PER_HOUR: 3,
  // Истёкшие ссылки хранятся для истории ещё 30 дней.
  KEEP_EXPIRED_MS: 30 * 24 * HOUR_MS,
});

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export const ACCESS_STATE_LABELS = Object.freeze({
  active: 'Ждёт перехода',
  opened: 'Открыта, пароль ещё не задан',
  used: 'Использована',
  revoked: 'Отозвана',
  expired: 'Истекла',
});

const REVOKE_REASONS = Object.freeze({
  replaced: 'выдана новая ссылка',
  superseded: 'пароль задан по другой ссылке',
  admin: 'отозвана администратором',
  blocked: 'аккаунт заблокирован',
  archived: 'аккаунт в архиве',
  email_changed: 'изменён email',
  password_changed: 'пароль изменён',
  role_changed: 'изменена роль',
  sessions_revoked: 'администратор завершил все сессии',
  issuer: 'у выдавшего больше нет прав на этот аккаунт',
});

export const stateOf = (record, stamp) => {
  if (record.usedAt) return 'used';
  if (record.revokedAt) return 'revoked';
  if (record.openedAt) return record.contextExpiresAt && record.contextExpiresAt > stamp ? 'opened' : 'expired';
  return record.expiresAt <= stamp ? 'expired' : 'active';
};

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {object} deps.accounts сервис аккаунтов (service.js)
 * @param {object} deps.delivery доставка (delivery.js)
 * @param {() => number} [deps.now]
 */
export const createInvitationService = ({ store, accounts, delivery, mailer = null, now = () => Date.now() }) => {
  const config = accounts.settings;
  const { startSession, releaseExpiredBlock, statusProblem, permissionsFor, canManage, notify, checkNewPassword, isStaff, mfaEnabled } = accounts.__internal;

  const busy = (error) => {
    if (error instanceof PasswordBusyError) fail('busy', 503, 'Сервер сейчас занят — повторите через минуту.');
    throw error;
  };

  const audit = (entry) => store.addAudit({ at: now(), result: 'ok', ...entry });

  const view = (record, stamp = now()) => ({
    id: record.id,
    purpose: record.purpose,
    state: stateOf(record, stamp),
    stateLabel: ACCESS_STATE_LABELS[stateOf(record, stamp)],
    source: record.source,
    delivery: record.delivery,
    deliveryStatus: record.deliveryStatus,
    createdAt: iso(record.createdAt),
    expiresAt: iso(record.expiresAt),
    openedAt: iso(record.openedAt),
    usedAt: iso(record.usedAt),
    revokedAt: iso(record.revokedAt),
    revokedReason: record.revokedReason ? REVOKE_REASONS[record.revokedReason] || record.revokedReason : null,
    createdBy: record.createdByLabel || (record.source === 'self' ? 'сам пользователь' : record.source === 'cli' ? 'Система (CLI)' : null),
  });

  const ttlFor = (purpose) => (purpose === 'invite'
    ? config.get('auth.inviteTtlHours') * HOUR_MS
    : config.get('auth.resetTtlMinutes') * MINUTE_MS);

  /** Пользователь, которому вообще можно выдать ссылку: не демо, не заблокирован, не в архиве. */
  const eligible = (user) => {
    if (!user || user.demoTemplate) fail('not_found', 404, 'Пользователь не найден.');
    const current = releaseExpiredBlock(user, now());
    if (current.status === 'blocked') fail('account_blocked', 409, 'Аккаунт заблокирован — сначала разблокируйте его.');
    if (current.status === 'archived') fail('account_inactive', 409, 'Аккаунт в архиве — сначала восстановите его.');
    return current;
  };

  /** Ошибка по ссылке — её видит только тот, у кого есть сама ссылка. */
  const linkFailure = (state) => {
    if (state === 'expired') fail('link_expired', 410, 'Срок действия ссылки истёк. Попросите новую.');
    if (state === 'revoked') fail('link_revoked', 410, 'Ссылка отозвана: по ней больше нельзя войти. Попросите новую.');
    fail('link_used', 410, 'Ссылка уже использована. Если пароль не задан, попросите новую.');
  };

  const findByToken = (token) => {
    if (typeof token !== 'string' || !TOKEN.test(token)) fail('invalid_link', 404, 'Ссылка недействительна. Проверьте, что она скопирована целиком.');
    const record = store.getAccessTokenByHash(hashToken(token));
    // Ссылка подтверждения нового email — у неё своя страница и свой обработчик.
    if (!record || !['invite', 'reset'].includes(record.purpose)) fail('invalid_link', 404, 'Ссылка недействительна. Проверьте, что она скопирована целиком.');
    return record;
  };

  /** Владелец ссылки, проверенный заново: email не менялся, аккаунт можно активировать. */
  const ownerOf = (record) => {
    const found = store.getUserById(record.userId);
    if (!found || found.demoTemplate) fail('invalid_link', 404, 'Ссылка недействительна.');
    if (found.email !== record.email) linkFailure('revoked');
    const user = releaseExpiredBlock(found, now());
    const problem = statusProblem(user);
    if (problem) fail(problem.code, 403, problem.code === 'account_blocked' ? `${problem.message} Обратитесь к администратору.` : problem.message);
    if (record.purpose === 'invite' && user.activatedAt) linkFailure('used');
    if (record.purpose === 'reset' && !user.activatedAt) linkFailure('revoked');
    if (!issuerStillEntitled(record, user)) {
      // Гасим и в базе: вернувшиеся права выдавшего не должны оживлять ссылку.
      store.revokeAccessToken(record.id, 'issuer', now());
      linkFailure('revoked');
    }
    return user;
  };

  /*
   * Ссылку от администратора проверяем и в момент использования: выдавший
   * должен по-прежнему быть действующим сотрудником с правом выдавать ссылки
   * и стоять выше владельца по роли. Иначе ссылка, выданная до повышения
   * владельца (или до блокировки самого администратора), стала бы способом
   * получить аккаунт, которым он уже не управляет. Ссылки из CLI и
   * запрошенные самим пользователем выдавшего не имеют.
   */
  const issuerStillEntitled = (record, user) => {
    if (record.source !== 'admin') return true;
    const issuer = record.createdBy ? store.getUserById(record.createdBy) : null;
    if (!issuer || issuer.demoTemplate || !issuer.activatedAt) return false;
    if (releaseExpiredBlock(issuer, now()).status !== 'active') return false;
    const permissions = permissionsFor(issuer);
    const allowed = record.purpose === 'invite'
      ? permissions.includes('users.password') || permissions.includes('users.create')
      : permissions.includes('users.password');
    return allowed && canManage(issuer, user);
  };

  const contextView = (record, user) => ({
    purpose: record.purpose,
    email: user.email,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    expiresAt: iso(record.contextExpiresAt),
  });

  const service = {
    /** Можно ли отправлять письма — для интерфейса (не зависит от адреса). */
    emailEnabled: delivery.emailEnabled,
    describeDelivery: () => delivery.describe(),

    /**
     * Выдать ссылку: приглашение (аккаунт не активирован) или смену пароля.
     *
     * @param {object} options
     * @param {object} options.user кому
     * @param {object|null} options.actor кто выдаёт (null — CLI или сам пользователь)
     * @param {'admin'|'self'|'cli'} options.source
     * @param {'auto'|'email'|'manual'} [options.delivery] auto — письмом, если почта настроена
     * @param {string|null} [options.base] адрес приложения для ссылки, если APP_URL не задан (только manual)
     * @returns {Promise<{invitation: object, link: string|null}>} link — только для ручной передачи
     */
    async issue({ user, actor = null, source = 'admin', delivery: wanted = 'auto', base = null, sourceKey = null }) {
      const target = eligible(user);
      const purpose = target.activatedAt ? 'reset' : 'invite';
      const byEmail = wanted !== 'manual' && delivery.emailEnabled && Boolean(mailer);
      if (wanted === 'email' && !delivery.emailEnabled) fail('mail_disabled', 409, 'Почта не настроена — передайте ссылку вручную.');
      const linkBase = delivery.appUrl || base;
      if (!linkBase) fail('no_app_url', 500, 'Не задан адрес приложения (APP_URL).');
      const stamp = now();
      const token = randomBytes(32).toString('base64url');
      const link = accessLink(linkBase, token);
      const { record, mailId } = store.transaction(() => {
        // Новая ссылка от администратора или CLI заменяет прежнюю того же вида; самостоятельный запрос — нет,
        // иначе посторонний мог бы, запрашивая ссылки, «гасить» настоящее приглашение.
        if (source !== 'self') store.revokeUserAccessTokens(target.id, 'replaced', stamp, { purpose });
        const created = store.createAccessToken({
          id: randomBytes(12).toString('hex'),
          tokenHash: hashToken(token),
          userId: target.id,
          purpose,
          email: target.email,
          source,
          delivery: byEmail ? 'email' : 'manual',
          deliveryStatus: byEmail ? 'pending' : 'manual',
          now: stamp,
          expiresAt: stamp + ttlFor(purpose),
          createdBy: actor?.id || null,
          createdByLabel: actor ? userLabel(actor) : null,
        });
        if (source !== 'self') {
          audit({
            action: purpose === 'invite' ? 'user.invite' : 'user.reset_link',
            actorId: actor?.id || null,
            actorLabel: actor ? userLabel(actor) : 'Система (CLI)',
            targetId: target.id,
            targetLabel: userLabel(target),
            details: { delivery: byEmail ? 'email' : 'manual', expiresAt: iso(created.expiresAt) },
          });
        }
        // Письмо — в той же транзакции, что и ссылка: нет ссылки — нет письма, и наоборот.
        const queued = byEmail ? mailer.enqueue({
          kind: purpose,
          to: target.email,
          params: { name: target.firstName, link, expiresAt: created.expiresAt, inviter: actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : '' },
          ref: { type: 'access_token', id: created.id },
          sourceKey,
        }) : null;
        return { record: created, mailId: queued };
      });
      if (!byEmail) return { invitation: view(record, stamp), link };
      if (source === 'self') {
        // Сам пользователь: в фоне, с повторами. Ссылку он не видит — только письмо.
        mailer.kick();
        return { invitation: view(record, stamp), link: null };
      }
      const sent = await mailer.sendNow(mailId);
      if (sent) return { invitation: view({ ...record, deliveryStatus: 'sent' }, stamp), link: null };
      // Письмо не ушло: администратор (и только он, и только сейчас) получает ссылку, чтобы передать её сам.
      return { invitation: view({ ...record, deliveryStatus: 'failed' }, stamp), link };
    },

    /**
     * Пользователь сам просит ссылку на почту: «нет пароля» или «забыл пароль».
     * Результат для вызывающего всегда один и тот же; письмо уходит, только
     * если адрес принадлежит действующему аккаунту и лимит не исчерпан.
     * Работа идёт после ответа: время ответа не зависит от адреса.
     */
    async requestLink(email, { sourceKey = null } = {}) {
      if (!delivery.emailEnabled || !mailer) return { sent: false, reason: 'mail_disabled' };
      const address = normalizeEmail(email);
      if (!address || address.length > ACCOUNT_LIMITS.MAX_EMAIL || !EMAIL_PATTERN.test(address)) return { sent: false, reason: 'bad_email' };
      const user = store.getUserByEmail(address);
      if (!user || user.demoTemplate || user.status !== 'active') return { sent: false, reason: 'no_account' };
      const stamp = now();
      if (store.countRecentAccessTokens({ userId: user.id, source: 'self', since: stamp - HOUR_MS }) >= INVITATION_LIMITS.SELF_REQUESTS_PER_HOUR) return { sent: false, reason: 'limit' };
      // Сотрудник без второго фактора: доступ одним письмом не восстанавливается.
      if (user.activatedAt && isStaff(user) && !mfaEnabled(user)) {
        store.addAuthEvent({ at: stamp, type: 'access_link_requested', userId: user.id, reason: 'staff_without_mfa' });
        return { sent: false, reason: 'staff_without_mfa' };
      }
      const purpose = user.activatedAt ? 'reset' : 'invite';
      if (!mailer.allows({ kind: purpose, to: user.email, sourceKey }).allowed) return { sent: false, reason: 'mail_limit' };
      store.addAuthEvent({ at: stamp, type: 'access_link_requested', userId: user.id });
      await service.issue({ user, actor: null, source: 'self', delivery: 'email', sourceKey }).catch(() => null);
      return { sent: true, reason: null };
    },

    /** Что за ссылка — до подтверждения, ничего не меняя: имя и email маской, срок. */
    peek(token) {
      const record = findByToken(token);
      const state = stateOf(record, now());
      if (state !== 'active') linkFailure(state);
      const user = ownerOf(record);
      return {
        purpose: record.purpose,
        firstName: user.firstName || '',
        email: maskEmail(user.email),
        expiresAt: iso(record.expiresAt),
        invitedBy: record.purpose === 'invite' && record.createdByLabel ? record.createdByLabel.split(' · ')[0] : null,
      };
    },

    /**
     * Подтвердить ссылку: токен больше не действует, взамен — контекст на 30
     * минут. Тот же браузер с действующим контекстом получает его обратно
     * (перезагрузка страницы), любой другой — «ссылка уже использована».
     */
    start(token, { contextToken = null, client = null, ipPrefix = null } = {}) {
      const record = findByToken(token);
      const stamp = now();
      const state = stateOf(record, stamp);
      if (state === 'opened' && typeof contextToken === 'string' && TOKEN.test(contextToken) && hashToken(contextToken) === record.contextHash) {
        const user = ownerOf(record);
        return { contextToken, context: contextView(record, user) };
      }
      if (state !== 'active') linkFailure(state);
      const user = ownerOf(record);
      const fresh = randomBytes(32).toString('base64url');
      const contextExpiresAt = stamp + INVITATION_LIMITS.CONTEXT_TTL_MS;
      const opened = store.openAccessToken({ id: record.id, contextHash: hashToken(fresh), contextExpiresAt, now: stamp });
      // Две вкладки открыли ссылку одновременно: обменять токен успевает только одна.
      if (!opened) linkFailure('used');
      store.addAuthEvent({ at: stamp, type: 'access_link_opened', userId: user.id, client, ipPrefix, reason: record.purpose });
      return { contextToken: fresh, context: contextView({ ...record, contextExpiresAt }, user) };
    },

    /** Контекст активации по cookie — для перезагрузки страницы; null, если его нет или он истёк. */
    context(contextToken) {
      if (typeof contextToken !== 'string' || !TOKEN.test(contextToken)) return null;
      const record = store.getAccessTokenByContext(hashToken(contextToken));
      if (!record || stateOf(record, now()) !== 'opened') return null;
      try {
        return contextView(record, ownerOf(record));
      } catch {
        return null;
      }
    },

    /**
     * Задать пароль в контексте активации. Аккаунт активирован, все прочие
     * ссылки отозваны, прежние сессии завершены; выдаётся новая сессия.
     */
    async complete(contextToken, password, { client = null, ipPrefix = null } = {}) {
      const expired = () => fail('activation_expired', 410, 'Время на создание пароля истекло. Откройте ссылку заново или попросите новую.');
      if (typeof contextToken !== 'string' || !TOKEN.test(contextToken)) expired();
      const contextHash = hashToken(contextToken);
      const record = store.getAccessTokenByContext(contextHash);
      if (!record || stateOf(record, now()) !== 'opened') expired();
      const user = ownerOf(record);
      await checkNewPassword(password, user.email);
      const passwordHash = await hashPassword(password).catch(busy);
      const stamp = now();
      const session = store.transaction(() => {
        // Пока считался хэш, ссылку могли использовать в другой вкладке или отозвать.
        const again = store.getAccessTokenByContext(contextHash);
        if (!again || stateOf(again, stamp) !== 'opened') expired();
        // И аккаунт могли заблокировать: проверка владельца — заново, в той же транзакции.
        ownerOf(again);
        if (!store.useAccessToken(again.id, stamp)) expired();
        // Ссылка пришла письмом на этот адрес — владение ящиком подтверждено.
        store.activateUser(user.id, passwordHash, stamp, { emailVerified: record.delivery === 'email' });
        store.revokeUserAccessTokens(user.id, 'superseded', stamp);
        store.deleteUserSessions(user.id);
        const fresh = startSession(user, { client, ipPrefix });
        store.recordLogin(user.id, stamp);
        audit({
          action: record.purpose === 'invite' ? 'user.activate' : 'user.password_set',
          actorId: user.id,
          actorLabel: userLabel(user),
          targetId: user.id,
          targetLabel: userLabel(user),
          details: { via: record.source },
        });
        store.addAuthEvent({ at: stamp, type: record.purpose === 'invite' ? 'account_activated' : 'password_reset', userId: user.id, sessionId: fresh.publicId, client, ipPrefix });
        return fresh;
      });
      if (record.purpose === 'reset') notify(user, 'password_changed', { how: 'reset' });
      return { ...accounts.snapshot(store.getUserById(user.id)), session, purpose: record.purpose };
    },

    /** Ссылки пользователя для админ-панели: без токенов и хэшей. */
    list(userId) {
      const stamp = now();
      return store.listUserAccessTokens(userId, 20).map((record) => view(record, stamp));
    },

    /** Отозвать одну ссылку пользователя. */
    revoke(userId, id, reason = 'admin') {
      const record = typeof id === 'string' && ACCESS_TOKEN_ID.test(id) ? store.getAccessTokenById(id) : null;
      if (!record || record.userId !== userId) fail('not_found', 404, 'Ссылка не найдена.');
      if (!store.revokeAccessToken(record.id, reason, now())) fail('bad_state', 409, 'Ссылка уже использована или отозвана.');
      return view(store.getAccessTokenById(record.id));
    },

    /** Отозвать все действующие ссылки пользователя (блокировка, архив, смена email). */
    revokeAll: (userId, reason) => store.revokeUserAccessTokens(userId, reason, now()),

    /** Обслуживание: давно истёкшие ссылки удаляются. */
    purge: () => store.purgeAccessTokens(now() - INVITATION_LIMITS.KEEP_EXPIRED_MS),
  };

  return Object.freeze(service);
};
