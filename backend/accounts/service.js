/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Личный кабинет: вход (пароль и второй фактор), сессии, свой профиль,
 * пароль, программа ДМС, избранное. Административные операции — в
 * adminService.js, регистрация — в registration.js, приглашения и ссылки —
 * в invitations.js, факторы MFA — в mfa.js.
 *
 * Сервис не знает ни про HTTP, ни про SQL: HTTP — в api/account.js и
 * api/me.js, хранилище — в sqliteStore.js (или любом другом с теми же
 * методами).
 *
 * Сессия — случайный токен 256 бит, в базе только SHA-256. У сессии есть
 * уровень: aal 1 — вошли паролем, aal 2 — паролем и вторым фактором. Для
 * админ-панели нужен aal 2 (MFA обязательна сотрудникам). Сессии
 * сотрудников короче: 30 минут без активности и не дольше 12 часов.
 * Критические действия требуют свежего подтверждения личности (reauth):
 * пароль и, если включена MFA, второй фактор — не старше 10 минут.
 */

import { createHash, randomBytes } from 'node:crypto';

import { AvatarError, sanitizeAvatar } from './avatar.js';
import { BREACHED_MESSAGE } from './breachedPasswords.js';
import { generateTemporaryPassword, hashPassword, MAX_PASSWORD_INPUT, needsRehash, PasswordBusyError, passwordProblem, verifyPassword } from './passwords.js';
import { canManage, permissionsOf, ROLE_INFO } from './rbac.js';
import { createSettingsService } from './settings.js';
import { searchTextOf } from './sqliteStore.js';
import { emailKey } from './throttle.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const ACCOUNT_LIMITS = Object.freeze({
  DEMO_SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  // Копия демо-аккаунта живёт, пока браузер к ней возвращается; потолок
  // числа копий защищает базу от входов в цикле.
  DEMO_COPY_TTL_MS: 30 * DAY_MS,
  MAX_DEMO_COPIES: 10_000,
  MAX_FAVORITES: 500,
  MAX_NAME: 60,
  MAX_EMAIL: 254,
  MAX_ITEM_ID: 160,
  // Время последней активности пишется не чаще раза в минуту на сессию.
  TOUCH_INTERVAL_MS: 60 * 1000,
  ACTIVITY_RETENTION_DAYS: 400,
  // Второй шаг входа: 5 минут и 5 попыток на один вход паролем.
  MFA_CHALLENGE_TTL_MS: 5 * 60 * 1000,
  MFA_MAX_ATTEMPTS: 5,
  // Доверенное устройство (cookie mk_device) помнится полгода.
  DEVICE_TTL_MS: 180 * DAY_MS,
});

/*
 * Сотрудник — тот, у кого есть доступ к админ-панели (разрешение
 * admin.access: по умолчанию модератор, администратор, суперадминистратор).
 * Сотрудникам второй фактор обязателен для админ-панели, а их сессии короче.
 * Модератор тоже: он видит персональные данные пользователей и блокирует.
 */
export const isStaffPermissions = (permissions) => Array.isArray(permissions) && permissions.includes('admin.access');

export class AccountError extends Error {
  constructor(code, status, message, extra = null) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const fail = (code, status, message, extra = null) => {
  throw new AccountError(code, status, message, extra);
};

/*
 * Гостевых демо-аккаунтов («Войти как Анна») больше нет: вход только по email
 * и паролю. Прежние копии демо-аккаунтов (вымышленные, без пароля) удаляются
 * вместе с сессиями при запуске сервиса; проверки isDemoUser остаются как
 * защита для старых баз.
 */
export const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/iu;
const PLAN_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

export const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export const cleanDisplayName = (value) =>
  (typeof value === 'string' ? value.replace(CONTROL, '').replace(/\s+/gu, ' ').trim().slice(0, ACCOUNT_LIMITS.MAX_NAME) : '');

/** Имя или фамилия: буквы, пробел, дефис, апостроф, точка — без разметки и управляющих символов. */
export const cleanPersonName = (value) => {
  const clean = cleanDisplayName(value);
  return /^[\p{L}][\p{L}\p{M} .'’-]*$/u.test(clean) ? clean : null;
};

/** Проверенный email или ошибка 400. */
export const checkEmail = (value) => {
  const address = normalizeEmail(value);
  if (!address || address.length > ACCOUNT_LIMITS.MAX_EMAIL || !EMAIL_PATTERN.test(address)) fail('bad_email', 400, 'Проверьте email.');
  if (address.endsWith('.example')) fail('bad_email', 400, 'Этот адрес зарезервирован для демо-аккаунтов.');
  return address;
};

const HAS_CONTROL = new RegExp(CONTROL.source, 'u');

/*
 * id в избранном — строка или целое число, как в справочнике. Хранится как
 * JSON, чтобы число вернулось числом: интерфейс сравнивает id строго.
 */
export const encodeItemId = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return JSON.stringify(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ACCOUNT_LIMITS.MAX_ITEM_ID || HAS_CONTROL.test(trimmed)) return null;
  return JSON.stringify(trimmed);
};

export const decodeItemId = (stored) => {
  try {
    const value = JSON.parse(stored);
    return typeof value === 'string' || Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
};

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const newPublicId = () => randomBytes(12).toString('hex');

const isDemoUser = (user) => Boolean(user.demoTemplate);
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Московский день (UTC+3, без перехода на летнее время) для DAU/MAU. */
export const moscowDay = (ms) => new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Строка «Имя Фамилия · m***@bk.ru» для журналов: email не пишется целиком. */
export const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email || '').split('@');
  return local ? `${local[0]}***@${domain}` : '';
};
export const userLabel = (user) => (user ? `${`${user.firstName || ''} ${user.lastName || ''}`.trim() || user.displayName || 'Без имени'} · ${maskEmail(user.email)}` : null);

/** То, что уходит самому пользователю: без хэша пароля и служебных полей. */
export const publicUser = (user, { permissions = [] } = {}) => ({
  id: user.id,
  email: user.email,
  displayName: user.displayName,
  firstName: user.firstName || '',
  lastName: user.lastName || '',
  role: user.role,
  roleLabel: ROLE_INFO[user.role]?.label || user.role,
  status: user.status,
  dmsPlanId: user.dmsPlanId || null,
  isDemo: isDemoUser(user),
  mustChangePassword: Boolean(user.mustChangePassword),
  avatarUrl: user.avatarEtag ? `/api/me/avatar?v=${user.avatarEtag}` : null,
  createdAt: iso(user.createdAt),
  updatedAt: iso(user.updatedAt),
  lastLoginAt: iso(user.lastLoginAt),
  passwordChangedAt: iso(user.passwordChangedAt),
  emailVerified: Boolean(user.emailVerifiedAt),
  permissions,
});

export const sessionView = (session, { currentHash = null } = {}) => ({
  id: session.publicId,
  createdAt: iso(session.createdAt),
  lastSeenAt: iso(session.lastSeenAt),
  expiresAt: iso(session.expiresAt),
  client: session.client || 'Неизвестный клиент',
  network: session.ipPrefix || null,
  mfa: (session.aal || 1) >= 2,
  current: currentHash !== null && session.tokenHash === currentHash,
});

export const AUTH_EVENT_LABELS = Object.freeze({
  login_ok: 'Успешный вход',
  login_failed: 'Неудачный вход',
  login_denied: 'Вход отклонён',
  logout: 'Выход',
  password_changed: 'Смена пароля',
  session_revoked: 'Сессия завершена',
  sessions_revoked: 'Завершены все сессии',
  access_link_requested: 'Запрошена ссылка для входа',
  access_link_opened: 'Открыта ссылка для входа',
  account_activated: 'Аккаунт активирован',
  account_registered: 'Регистрация завершена',
  password_reset: 'Пароль задан по ссылке',
  login_locked: 'Вход с новых устройств приостановлен',
  login_throttled: 'Попытка входа отклонена лимитом',
  mfa_challenge: 'Пароль верный, ждём второй фактор',
  mfa_failed: 'Неверный второй фактор',
  mfa_enabled: 'Добавлен фактор входа',
  mfa_disabled: 'Удалён фактор входа',
  mfa_reset: 'Факторы входа сброшены',
  recovery_codes: 'Выпущены резервные коды',
  recovery_code_used: 'Вход по резервному коду',
  reauth: 'Подтверждение личности',
  reauth_failed: 'Неудачное подтверждение личности',
  email_change_requested: 'Запрошена смена email',
  email_changed: 'Email изменён',
  email_verified: 'Email подтверждён',
  login_unlocked: 'Сняты ограничения входа',
});

export const authEventView = (event) => ({
  id: event.id,
  at: iso(event.at),
  type: event.type,
  label: AUTH_EVENT_LABELS[event.type] || event.type,
  reason: event.reason || null,
  client: event.client || null,
  network: event.ipPrefix || null,
});

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

/** Ошибка второго фактора: сообщение — общее, без подсказок, какой из способов неверен. */
const MFA_FAILED = 'Код не подошёл. Проверьте и попробуйте ещё раз.';

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {object} [deps.settings] настройки (settings.js); по умолчанию — из того же хранилища
 * @param {(planId: string) => boolean} [deps.isKnownPlan] есть ли такая программа ДМС
 * @param {object|null} [deps.mfa] факторы MFA (mfa.js); без него вход только по паролю
 * @param {object|null} [deps.mailer] почтовая очередь (mail/outbox.js) — для уведомлений
 * @param {object|null} [deps.throttle] счётчики попыток (throttle.js)
 * @param {(password: string) => Promise<{breached: boolean}>} [deps.breachCheck] проверка по базе утечек
 * @param {() => number} [deps.now]
 */
export const createAccountService = ({
  store, settings = null, isKnownPlan = () => false, mfa = null, mailer = null, throttle = null,
  breachCheck = async () => ({ breached: false }), appUrl = null, now = () => Date.now(),
}) => {
  const config = settings || createSettingsService({ store, now });
  // Гостевые демо-аккаунты убраны: их прежние копии и сессии больше не нужны.
  store.purgeDemoCopies(Number.MAX_SAFE_INTEGER);
  const newId = () => randomBytes(16).toString('hex');
  // Дни, уже отмеченные в user_activity: не писать в базу на каждый запрос.
  const markedDays = new Map();

  let overridesCache = null;
  const roleOverrides = () => {
    overridesCache ||= Object.fromEntries(Object.entries(store.listRoleOverrides()).map(([role, row]) => [role, row.permissions]));
    return overridesCache;
  };
  const permissionsFor = (user) => (user && !isDemoUser(user) ? permissionsOf(user.role, roleOverrides()) : []);

  /** Сотрудник (есть доступ к админ-панели): его сессии короче и админ-панель — только с MFA. */
  const isStaff = (user) => Boolean(user && !isDemoUser(user) && isStaffPermissions(permissionsFor(user)));
  const mfaEnabled = (user) => Boolean(mfa && user && mfa.hasMfa(user.id));

  const sessionLimits = (user) => {
    if (isDemoUser(user)) return { idle: ACCOUNT_LIMITS.DEMO_SESSION_TTL_MS, max: ACCOUNT_LIMITS.DEMO_SESSION_TTL_MS, perUser: 10 };
    if (isStaff(user)) {
      return {
        idle: config.get('sessions.staffIdleMinutes') * 60 * 1000,
        max: config.get('sessions.staffMaxHours') * 60 * 60 * 1000,
        perUser: config.get('sessions.maxPerUser'),
      };
    }
    return {
      idle: config.get('sessions.idleDays') * DAY_MS,
      max: config.get('sessions.maxDays') * DAY_MS,
      perUser: config.get('sessions.maxPerUser'),
    };
  };

  /**
   * Новая сессия: всегда новый токен (защита от фиксации сессии). level —
   * aal (1 — пароль, 2 — пароль и второй фактор), reauthAt — когда личность
   * подтверждали последний раз.
   */
  const startSession = (user, { client = null, ipPrefix = null } = {}, { aal = 1, mfaAt = null, reauthAt = null, deviceHash = null, createdAt = null } = {}) => {
    const token = randomBytes(32).toString('base64url');
    const publicId = newPublicId();
    const created = now();
    const limits = sessionLimits(user);
    const startedAt = createdAt ?? created;
    const expiresAt = Math.min(created + limits.idle, startedAt + limits.max);
    store.createSession({
      tokenHash: hashToken(token),
      publicId,
      userId: user.id,
      now: created,
      createdAt: startedAt,
      expiresAt,
      maxPerUser: limits.perUser,
      client,
      ipPrefix,
      aal,
      mfaAt,
      reauthAt,
      deviceHash,
    });
    return { token, expiresAt, publicId, tokenHash: hashToken(token), aal };
  };

  const busy = (error) => {
    if (error instanceof PasswordBusyError) fail('busy', 503, 'Сервер сейчас занят — попробуйте войти через минуту.');
    throw error;
  };

  const favoritesOf = (userId) => store.listFavorites(userId).map(decodeItemId).filter((id) => id !== null);

  const checkPlan = (planId) => {
    if (planId === null) return null;
    if (typeof planId !== 'string' || !PLAN_ID.test(planId) || !isKnownPlan(planId)) {
      fail('unknown_plan', 400, 'Такой программы ДМС нет в справочнике.');
    }
    return planId;
  };

  const encodeAll = (ids) => {
    if (!Array.isArray(ids)) fail('bad_request', 400, 'Некорректный список.');
    const encoded = [...new Set(ids.map(encodeItemId))];
    if (encoded.includes(null)) fail('bad_item', 400, 'Некорректный id в избранном.');
    return encoded;
  };

  const audit = (entry) => store.addAudit({ at: now(), result: 'ok', ...entry });
  const authEvent = (entry) => store.addAuthEvent({ at: now(), ...entry });

  /**
   * Письмо-уведомление владельцу аккаунта. Без почты — молча: уведомления
   * не должны ломать само действие. Лимиты — общие для адреса (outbox.js).
   */
  const notify = (user, kind, params = {}) => {
    if (!mailer?.enabled || !user?.email || isDemoUser(user)) return false;
    try {
      if (!mailer.allows({ kind, to: user.email }).allowed) return false;
      mailer.enqueue({ kind, to: user.email, params: { name: user.firstName || '', at: now(), ...params } });
      mailer.kick();
      return true;
    } catch {
      return false;
    }
  };

  /** Новый пароль: правила политики, затем (если включено) база утечек. */
  const checkNewPassword = async (password, email) => {
    const problem = passwordProblem(password, { email });
    if (problem) fail('weak_password', 400, problem);
    const breach = await breachCheck(password).catch(() => ({ breached: false }));
    if (breach.breached) fail('weak_password', 400, BREACHED_MESSAGE);
  };

  /** Временная блокировка истекла — аккаунт снова активен (с записью в историю). */
  const releaseExpiredBlock = (user, stamp) => {
    if (user.status !== 'blocked' || !user.blockedUntil || user.blockedUntil > stamp) return user;
    store.transaction(() => {
      store.updateUser(user.id, { status: 'active', blockedUntil: null, blockReason: null }, { now: stamp });
      store.addBlockEvent({ userId: user.id, at: stamp, action: 'expired', actorLabel: 'Система' });
      audit({ action: 'user.unblock', actorLabel: 'Система', targetId: user.id, targetLabel: userLabel(user), details: { reason: 'Срок блокировки истёк' } });
    });
    return store.getUserById(user.id);
  };

  /** Пользователь не может работать: заблокирован (и срок не истёк) или в архиве. */
  const statusProblem = (user) => {
    if (user.status === 'archived') return { code: 'account_inactive', message: 'Аккаунт деактивирован. Обратитесь к администратору.' };
    if (user.status === 'blocked') {
      return {
        code: 'account_blocked',
        message: user.blockedUntil
          ? `Аккаунт заблокирован до ${new Date(user.blockedUntil).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК).`
          : 'Аккаунт заблокирован.',
        extra: { blockedUntil: iso(user.blockedUntil), reason: user.blockReason || null },
      };
    }
    return null;
  };

  const markActivity = (userId, stamp) => {
    const day = moscowDay(stamp);
    if (markedDays.get(userId) === day) return;
    store.markActive(userId, day);
    markedDays.set(userId, day);
    if (markedDays.size > 50_000) markedDays.clear();
  };

  /*
   * Доверенное устройство — cookie mk_device (её ставит HTTP-слой). Для
   * лимитов входа: с устройства, с которого этот пользователь уже входил,
   * чужие неудачные попытки вход не закрывают (throttle.js).
   */
  const deviceHashOf = (token) => (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? sha256hex(`device:${token}`) : null);
  const isTrustedDevice = (user, deviceHash) => Boolean(user && deviceHash && store.getTrustedDevice(deviceHash, user.id)?.expiresAt > now());

  const throttleParts = (address, context, user) => {
    const deviceHash = deviceHashOf(context.deviceToken);
    return {
      ipKey: context.ipKey || 'unknown',
      accountKey: emailKey(address),
      deviceKey: user && isTrustedDevice(user, deviceHash) ? deviceHash.slice(0, 32) : null,
    };
  };

  /** Вход завершён (пароль, а если нужно — и второй фактор): сессия, история, доверие устройству. */
  const finishLogin = (user, context, { aal, method = 'password' }) => {
    const stamp = now();
    const deviceHash = deviceHashOf(context.deviceToken);
    const knownDevice = isTrustedDevice(user, deviceHash);
    // Вход не считается подтверждением личности: для важных действий — отдельный шаг (reauthenticate).
    const session = startSession(user, context, { aal, mfaAt: aal >= 2 ? stamp : null, reauthAt: null, deviceHash });
    store.recordLogin(user.id, stamp);
    markActivity(user.id, stamp);
    if (deviceHash) store.addTrustedDevice({ tokenHash: deviceHash, userId: user.id, now: stamp, expiresAt: stamp + ACCOUNT_LIMITS.DEVICE_TTL_MS });
    authEvent({ type: 'login_ok', userId: user.id, sessionId: session.publicId, client: context.client || null, ipPrefix: context.ipPrefix || null, reason: method });
    // Сотрудник вошёл с устройства, которого раньше не было, — письмо владельцу.
    if (isStaff(user) && !knownDevice) notify(user, 'new_login', { client: context.client || '', network: context.ipPrefix || '' });
    const fresh = store.getUserById(user.id);
    return { user: publicUser(fresh, { permissions: permissionsFor(fresh) }), favorites: favoritesOf(fresh.id), session, security: securityOf(fresh, { aal }) };
  };

  /** Что интерфейсу знать о защите аккаунта. */
  const securityOf = (user, session = null) => ({
    mfaEnabled: mfaEnabled(user),
    mfaRequired: isStaff(user),
    sessionLevel: session ? session.aal || 1 : null,
    passkeysAvailable: Boolean(mfa?.passkeysAvailable),
  });

  const challengeHash = (token) => sha256hex(`challenge:${token}`);
  const CHALLENGE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

  /** Действующий вызов второго шага входа или ошибка «начните вход заново». */
  const loginChallenge = (token) => {
    const expired = () => fail('mfa_expired', 401, 'Время на подтверждение входа истекло. Войдите заново.');
    if (typeof token !== 'string' || !CHALLENGE_TOKEN.test(token)) expired();
    const record = store.getChallenge(challengeHash(token));
    if (!record || record.purpose !== 'login' || record.consumedAt || record.expiresAt <= now()) expired();
    const found = record.userId ? store.getUserById(record.userId) : null;
    if (!found) expired();
    const user = releaseExpiredBlock(found, now());
    const problem = statusProblem(user);
    if (problem) fail(problem.code, 403, problem.message, problem.extra);
    return { record, user };
  };

  /** Вызов второго фактора для ссылки из письма: живёт, пока открыт контекст ссылки (30 минут). */
  const LINK_MFA_TTL_MS = 30 * 60 * 1000;
  const linkChallenge = (user, linkKey) => {
    const idHash = sha256hex(`link-mfa:${linkKey}`);
    const existing = store.getChallenge(idHash);
    if (existing && existing.userId === user.id && existing.expiresAt > now() && !existing.consumedAt) return existing;
    if (existing) store.deleteChallenge(idHash);
    store.createChallenge({ idHash, userId: user.id, purpose: 'login', now: now(), expiresAt: now() + LINK_MFA_TTL_MS });
    return store.getChallenge(idHash);
  };

  /**
   * Проверка второго фактора: totp — код из приложения, recovery —
   * резервный код, webauthn — подпись ключом доступа (challenge выдан
   * раньше). Возвращает {ok, method, remaining?}.
   */
  const verifySecondFactor = (user, { method, code, credential }, challenge) => {
    if (!mfa) return { ok: false };
    if (method === 'totp') return { ...mfa.verifyTotp(user.id, code), method };
    if (method === 'recovery') return { ...mfa.verifyRecovery(user.id, code), method };
    if (method === 'webauthn') return { ...mfa.verifyPasskey(user.id, credential, challenge, { requireUv: isStaff(user) }), method };
    return { ok: false, method };
  };

  /*
   * Свежесть подтверждения личности для критических действий: только явное
   * подтверждение (пароль и, если включён, второй фактор) не старше
   * auth.reauthMinutes. Сам вход его не заменяет: украденная сессия — даже
   * только что созданная со вторым фактором — не даёт ни сменить email и
   * факторы, ни выдать ссылку для сброса пароля чужому аккаунту.
   */
  const reauthWindowMs = () => config.get('auth.reauthMinutes') * 60 * 1000;
  const isFresh = (session) => Boolean(session?.reauthAt && session.reauthAt > now() - reauthWindowMs());

  /** Замена сессии новой (новый токен, тот же срок жизни с начала входа): повышение уровня, подтверждение личности. */
  const rotateSession = (user, session, context, { aal = session.aal || 1, mfaAt = session.mfaAt, reauthAt = session.reauthAt } = {}) => store.transaction(() => {
    store.deleteSession(session.tokenHash);
    return startSession(user, { client: session.client || context.client || null, ipPrefix: context.ipPrefix || session.ipPrefix || null }, {
      aal, mfaAt, reauthAt, deviceHash: session.deviceHash, createdAt: session.createdAt,
    });
  });

  const service = {
    settings: config,
    permissionsFor,
    isStaff,
    mfa,
    securityOf,
    reloadRoleOverrides() {
      overridesCache = null;
    },

    /**
     * Вход по email и паролю. Ответ одинаковый для несуществующего email и
     * неверного пароля; о блокировке сообщается только при верном пароле.
     * Если у аккаунта включён второй фактор — вместо сессии вызов второго
     * шага ({mfaRequired, challengeToken}); сессии ещё нет.
     *
     * @param {{email: string, password: string}} credentials
     * @param {{client?: string, ipPrefix?: string, ipKey?: string, deviceToken?: string}} [context]
     */
    async login({ email, password } = {}, context = {}) {
      const address = normalizeEmail(email);
      const found = address && address.length <= ACCOUNT_LIMITS.MAX_EMAIL ? store.getUserByEmail(address) : null;
      const user = found && !isDemoUser(found) ? found : null;
      const parts = throttleParts(address, context, user);
      const event = { client: context.client || null, ipPrefix: context.ipPrefix || null };
      if (throttle) {
        const gate = throttle.check(parts);
        if (!gate.allowed) {
          authEvent({ ...event, type: 'login_throttled', userId: user?.id || null, reason: gate.scope });
          fail('too_many_attempts', 429, `Слишком много неудачных попыток входа. Повторите через ${Math.max(1, Math.ceil(gate.retryAfterSeconds / 60))} мин. или восстановите пароль.`, { retryAfterSeconds: gate.retryAfterSeconds });
        }
      }
      // Проверка идёт и для несуществующего адреса — по времени ответа не понять, есть ли аккаунт.
      const input = typeof password === 'string' && password.length <= MAX_PASSWORD_INPUT ? password : '';
      const valid = await verifyPassword(input, user?.passwordHash || null).catch(busy);
      if (!user || !user.passwordHash || !valid) {
        if (user) store.recordFailedLogin(user.id, now());
        authEvent({ ...event, type: 'login_failed', userId: user?.id || null, reason: user ? 'bad_password' : 'unknown_user' });
        const result = throttle ? throttle.recordFailure(parts) : { accountLocked: false };
        if (result.accountLocked && user) {
          authEvent({ ...event, type: 'login_locked', userId: user.id, reason: 'account' });
          notify(user, 'login_locked', { minutes: 15 });
        }
        fail('bad_credentials', 401, 'Неверный email или пароль.');
      }
      const current = releaseExpiredBlock(user, now());
      const problem = statusProblem(current);
      if (problem) {
        authEvent({ ...event, type: 'login_denied', userId: user.id, reason: current.status });
        fail(problem.code, 403, problem.message, problem.extra);
      }
      throttle?.recordSuccess(parts);
      if (needsRehash(current.passwordHash)) {
        const fresh = await hashPassword(input).catch(() => null);
        if (fresh) store.rehashPassword(current.id, fresh);
      }
      if (mfaEnabled(current)) {
        const token = randomBytes(32).toString('base64url');
        const stamp = now();
        store.deleteUserChallenges(current.id, 'login');
        store.createChallenge({
          idHash: challengeHash(token), userId: current.id, purpose: 'login', now: stamp, expiresAt: stamp + ACCOUNT_LIMITS.MFA_CHALLENGE_TTL_MS,
        });
        authEvent({ ...event, type: 'mfa_challenge', userId: current.id });
        return {
          mfaRequired: true,
          challengeToken: token,
          expiresAt: stamp + ACCOUNT_LIMITS.MFA_CHALLENGE_TTL_MS,
          methods: mfa.status(current.id).methods,
        };
      }
      return finishLogin(current, context, { aal: 1 });
    },

    /** Параметры второго шага: какие способы есть и вызов для ключа доступа. */
    mfaLoginOptions(challengeToken) {
      const { record, user } = loginChallenge(challengeToken);
      const status = mfa.status(user.id);
      let passkey = null;
      if (status.methods.includes('webauthn')) {
        const value = randomBytes(32).toString('base64url');
        store.setChallengeValue(record.idHash, value);
        passkey = mfa.assertionOptions(user.id, value, { requireUv: isStaff(user) });
      }
      return { methods: status.methods, passkey, expiresAt: iso(record.expiresAt) };
    },

    /** Второй шаг входа: код, резервный код или ключ доступа. Успех — сессия aal 2. */
    async completeMfaLogin(challengeToken, factor = {}, context = {}) {
      const { record, user } = loginChallenge(challengeToken);
      const accountKey = emailKey(user.email);
      if (throttle) {
        const gate = throttle.mfaCheck(accountKey);
        if (!gate.allowed) fail('too_many_attempts', 429, `Слишком много неверных кодов. Повторите через ${Math.max(1, Math.ceil(gate.retryAfterSeconds / 60))} мин.`, { retryAfterSeconds: gate.retryAfterSeconds });
      }
      const attempts = store.addChallengeAttempt(record.idHash);
      if (attempts > ACCOUNT_LIMITS.MFA_MAX_ATTEMPTS) {
        store.deleteChallenge(record.idHash);
        fail('mfa_expired', 401, 'Слишком много попыток. Войдите заново.');
      }
      const result = verifySecondFactor(user, factor, record.challenge);
      const event = { client: context.client || null, ipPrefix: context.ipPrefix || null };
      if (!result.ok) {
        throttle?.mfaFailure(accountKey);
        authEvent({ ...event, type: 'mfa_failed', userId: user.id, reason: String(factor.method || 'unknown').slice(0, 20) });
        fail('bad_mfa_code', 400, MFA_FAILED, { attemptsLeft: Math.max(0, ACCOUNT_LIMITS.MFA_MAX_ATTEMPTS - attempts) });
      }
      // Вызов одноразовый: вторая вкладка с тем же кодом сессию не получит.
      if (!store.consumeChallenge(record.idHash, now())) fail('mfa_expired', 401, 'Время на подтверждение входа истекло. Войдите заново.');
      throttle?.mfaSuccess(accountKey);
      if (result.method === 'recovery') {
        authEvent({ ...event, type: 'recovery_code_used', userId: user.id, reason: String(result.remaining) });
        notify(user, 'recovery_code_used', { remaining: result.remaining });
      }
      store.deleteChallenge(record.idHash);
      return { ...finishLogin(user, context, { aal: 2, method: `mfa:${result.method}` }), recoveryCodesLeft: result.method === 'recovery' ? result.remaining : null };
    },

    /*
     * Второй фактор вне входа — для смены пароля по ссылке, если у аккаунта
     * включена MFA: без него ссылка из письма давала бы вход в обход
     * второго фактора. linkKey — SHA-256 контекста ссылки: к нему привязаны
     * вызов для ключа доступа и счётчик попыток (5 на ссылку); счётчик
     * неверных кодов аккаунта — общий со входом.
     */
    linkSecondFactorOptions(user, linkKey) {
      const record = linkChallenge(user, linkKey);
      const status = mfa ? mfa.status(user.id) : { methods: [] };
      let passkey = null;
      if (status.methods.includes('webauthn')) {
        const value = randomBytes(32).toString('base64url');
        store.setChallengeValue(record.idHash, value);
        passkey = mfa.assertionOptions(user.id, value, { requireUv: isStaff(user) });
      }
      return { methods: status.methods, passkey };
    },

    /**
     * Проверить второй фактор для ссылки. Неверный код — bad_mfa_code (ничего
     * не меняется); исчерпаны попытки — exhausted: ссылку нужно погасить.
     */
    verifyLinkSecondFactor(user, factor = {}, linkKey, context = {}) {
      const accountKey = emailKey(user.email);
      if (throttle) {
        const gate = throttle.mfaCheck(accountKey);
        if (!gate.allowed) fail('too_many_attempts', 429, `Слишком много неверных кодов. Повторите через ${Math.max(1, Math.ceil(gate.retryAfterSeconds / 60))} мин.`, { retryAfterSeconds: gate.retryAfterSeconds });
      }
      const record = linkChallenge(user, linkKey);
      const attempts = store.addChallengeAttempt(record.idHash);
      if (attempts > ACCOUNT_LIMITS.MFA_MAX_ATTEMPTS) {
        store.deleteChallenge(record.idHash);
        return { ok: false, exhausted: true };
      }
      // Вызов для ключа доступа — одноразовый.
      const challenge = factor.method === 'webauthn' ? record.challenge : null;
      if (challenge) store.setChallengeValue(record.idHash, null);
      const result = verifySecondFactor(user, factor, challenge);
      const event = { client: context.client || null, ipPrefix: context.ipPrefix || null, userId: user.id };
      if (!result.ok) {
        throttle?.mfaFailure(accountKey);
        authEvent({ ...event, type: 'mfa_failed', reason: 'link' });
        fail('bad_mfa_code', 400, MFA_FAILED, { attemptsLeft: Math.max(0, ACCOUNT_LIMITS.MFA_MAX_ATTEMPTS - attempts) });
      }
      throttle?.mfaSuccess(accountKey);
      store.deleteChallenge(record.idHash);
      if (result.method === 'recovery') {
        authEvent({ ...event, type: 'recovery_code_used', reason: String(result.remaining) });
        notify(user, 'recovery_code_used', { remaining: result.remaining });
      }
      return result;
    },

    /**
     * Сессия и пользователь по токену из cookie, или null. Истёкшая сессия
     * удаляется; заблокированный или архивный аккаунт теряет все сессии.
     * touch — продлить сессию и отметить активность (не чаще раза в минуту).
     */
    authenticate(token, { touch = true } = {}) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const tokenHash = hashToken(token);
      const session = store.getSession(tokenHash);
      if (!session) return null;
      const stamp = now();
      if (session.expiresAt <= stamp) {
        store.deleteSession(tokenHash);
        return null;
      }
      let user = store.getUserById(session.userId);
      if (!user) {
        store.deleteSession(tokenHash);
        return null;
      }
      const limits = sessionLimits(user);
      // Роль могла смениться на сотрудника: короткие сроки действуют сразу, а не со следующего входа.
      if (session.createdAt + limits.max <= stamp || session.lastSeenAt + limits.idle <= stamp) {
        store.deleteSession(tokenHash);
        return null;
      }
      user = releaseExpiredBlock(user, stamp);
      if (statusProblem(user)) {
        store.deleteUserSessions(user.id);
        return null;
      }
      /*
       * Инвариант: у аккаунта с включённым вторым фактором не бывает
       * действующей сессии без него — откуда бы она ни взялась (вход до
       * включения MFA на другом устройстве, ссылка из письма, старая база).
       * Такая сессия завершается: войти можно только стандартным входом.
       */
      if ((session.aal || 1) < 2 && mfaEnabled(user)) {
        store.deleteSession(tokenHash);
        authEvent({ type: 'session_revoked', userId: user.id, sessionId: session.publicId, reason: 'mfa_required' });
        return null;
      }
      if (touch && stamp - session.lastSeenAt >= ACCOUNT_LIMITS.TOUCH_INTERVAL_MS) {
        const expiresAt = Math.min(stamp + limits.idle, session.createdAt + limits.max);
        store.touchSession(tokenHash, stamp, expiresAt);
        session.lastSeenAt = stamp;
        session.expiresAt = expiresAt;
        if (!isDemoUser(user)) store.setLastSeen(user.id, stamp);
      }
      if (touch && !isDemoUser(user)) markActivity(user.id, stamp);
      return { user, session, permissions: permissionsFor(user), security: securityOf(user, session) };
    },

    /** Пользователь по токену из cookie или null (совместимость со старым кодом). */
    sessionUser(token) {
      return this.authenticate(token)?.user || null;
    },

    logout(token) {
      if (typeof token !== 'string' || !token) return;
      const session = store.getSession(hashToken(token));
      if (!session) return;
      store.deleteSession(session.tokenHash);
      const user = store.getUserById(session.userId);
      if (user && !isDemoUser(user)) authEvent({ type: 'logout', userId: user.id, sessionId: session.publicId, client: session.client, ipPrefix: session.ipPrefix });
    },

    snapshot(user, session = null) {
      return { user: publicUser(user, { permissions: permissionsFor(user) }), favorites: favoritesOf(user.id), security: securityOf(user, session) };
    },

    /* ------------------------ подтверждение личности ------------------------ */

    /** Свежее ли подтверждение личности (для критических действий). */
    isFresh,

    /** Вызов для ключа доступа при подтверждении личности (вошедший пользователь). */
    reauthOptions(user, session) {
      if (!mfa) return { methods: [], passkey: null };
      const status = mfa.status(user.id);
      let passkey = null;
      if (status.methods.includes('webauthn')) {
        const value = randomBytes(32).toString('base64url');
        const idHash = sha256hex(`reauth:${session.tokenHash}`);
        store.deleteChallenge(idHash);
        store.createChallenge({ idHash, userId: user.id, purpose: 'reauth', now: now(), expiresAt: now() + ACCOUNT_LIMITS.MFA_CHALLENGE_TTL_MS, challenge: value });
        passkey = mfa.assertionOptions(user.id, value, { requireUv: isStaff(user) });
      }
      return { methods: status.methods, passkey };
    },

    /**
     * Подтвердить личность в текущей сессии: пароль и — если включена MFA —
     * второй фактор. Сессия заменяется новой (новый токен) с отметкой
     * reauthAt; со вторым фактором — уровень aal 2.
     */
    async reauthenticate(user, session, { password, method, code, credential } = {}, context = {}) {
      const parts = throttleParts(user.email, context, user);
      if (throttle) {
        const gate = throttle.check(parts);
        if (!gate.allowed) fail('too_many_attempts', 429, 'Слишком много неудачных попыток. Подождите и попробуйте снова.', { retryAfterSeconds: gate.retryAfterSeconds });
      }
      const input = typeof password === 'string' && password.length <= MAX_PASSWORD_INPUT ? password : '';
      const valid = await verifyPassword(input, user.passwordHash).catch(busy);
      const event = { client: context.client || null, ipPrefix: context.ipPrefix || null, userId: user.id, sessionId: session.publicId };
      if (!valid) {
        throttle?.recordFailure(parts);
        authEvent({ ...event, type: 'reauth_failed', reason: 'password' });
        fail('bad_password', 400, 'Пароль неверный.');
      }
      let aal = session.aal || 1;
      let mfaAt = session.mfaAt;
      if (mfaEnabled(user)) {
        const accountKey = emailKey(user.email);
        if (throttle && !throttle.mfaCheck(accountKey).allowed) fail('too_many_attempts', 429, 'Слишком много неверных кодов. Подождите 15 минут.');
        let challenge = null;
        if (method === 'webauthn') {
          const idHash = sha256hex(`reauth:${session.tokenHash}`);
          const record = store.getChallenge(idHash);
          if (record && record.userId === user.id && record.expiresAt > now() && store.consumeChallenge(idHash, now())) challenge = record.challenge;
          store.deleteChallenge(idHash);
        }
        const result = verifySecondFactor(user, { method, code, credential }, challenge);
        if (!result.ok) {
          throttle?.mfaFailure(accountKey);
          authEvent({ ...event, type: 'reauth_failed', reason: 'mfa' });
          fail('bad_mfa_code', 400, method ? MFA_FAILED : 'Подтвердите вход вторым фактором.');
        }
        throttle?.mfaSuccess(accountKey);
        if (result.method === 'recovery') notify(user, 'recovery_code_used', { remaining: result.remaining });
        aal = 2;
        mfaAt = now();
      }
      const fresh = rotateSession(user, session, context, { aal, mfaAt, reauthAt: now() });
      authEvent({ ...event, type: 'reauth', sessionId: fresh.publicId, reason: aal >= 2 ? 'mfa' : 'password' });
      return { session: fresh, security: securityOf(user, { aal }) };
    },

    /** Повысить уровень сессии после добавления первого фактора (настройка MFA сотрудником). */
    elevateAfterSetup(user, session, context = {}) {
      // Добавить фактор можно было только после подтверждения личности: его отметка сохраняется, но не продлевается.
      return store.transaction(() => {
        const fresh = rotateSession(user, session, context, { aal: 2, mfaAt: now() });
        // Сессии на других устройствах вошли без второго фактора — с включённой MFA они не действуют.
        const revoked = store.deleteOtherSessions(user.id, fresh.tokenHash);
        if (revoked > 0) authEvent({ type: 'sessions_revoked', userId: user.id, reason: 'mfa_enabled' });
        return fresh;
      });
    },

    /** Своё имя и программа ДМС (PATCH /api/account). Других полей нет. */
    updateProfile(user, { displayName, firstName, lastName, dmsPlanId } = {}) {
      const stamp = now();
      const nameChange = displayName !== undefined || firstName !== undefined || lastName !== undefined;
      if (nameChange && isDemoUser(user)) fail('demo_account', 403, 'Имя демо-аккаунта не меняется.');
      if (nameChange) {
        const first = cleanPersonName(firstName !== undefined ? firstName : displayName);
        const last = lastName !== undefined ? (lastName === '' ? '' : cleanPersonName(lastName)) : (displayName !== undefined ? '' : user.lastName);
        if (!first) fail('bad_name', 400, 'Укажите имя: буквы, пробел, дефис.');
        if (last === null) fail('bad_name', 400, 'Фамилия: буквы, пробел, дефис.');
        store.updateUser(user.id, {
          firstName: first,
          lastName: last,
          displayName: `${first} ${last}`.trim(),
          searchText: searchTextOf({ firstName: first, lastName: last, email: user.email, id: user.id }),
        }, { now: stamp });
      }
      if (dmsPlanId !== undefined) store.updateUser(user.id, { dmsPlanId: checkPlan(dmsPlanId) }, { now: stamp });
      return this.snapshot(store.getUserById(user.id));
    },

    /**
     * Смена своего пароля с проверкой текущего. Все сессии, включая текущую,
     * завершаются, и выдаётся новая (уровень сохраняется): украденный раньше
     * токен перестаёт работать. Владельцу — письмо.
     */
    async changePassword(user, { currentPassword, newPassword } = {}, context = {}, session = null) {
      if (isDemoUser(user)) fail('demo_account', 403, 'У демо-аккаунта нет пароля.');
      const input = typeof currentPassword === 'string' && currentPassword.length <= MAX_PASSWORD_INPUT ? currentPassword : '';
      const parts = throttleParts(user.email, context, user);
      if (throttle && !throttle.check(parts).allowed) fail('too_many_attempts', 429, 'Слишком много неудачных попыток. Подождите и попробуйте снова.');
      const valid = await verifyPassword(input, user.passwordHash).catch(busy);
      if (!valid) {
        throttle?.recordFailure(parts);
        fail('bad_password', 400, 'Текущий пароль неверный.');
      }
      if (typeof newPassword === 'string' && newPassword === currentPassword) fail('weak_password', 400, 'Новый пароль должен отличаться от текущего.');
      await checkNewPassword(newPassword, user.email);
      const passwordHash = await hashPassword(newPassword).catch(busy);
      const stamp = now();
      const fresh = store.transaction(() => {
        store.setPassword(user.id, passwordHash, { mustChange: false, now: stamp });
        store.deleteUserSessions(user.id);
        // Ссылки для смены пароля, выданные раньше, после смены не нужны.
        store.revokeUserAccessTokens(user.id, 'password_changed', stamp, { purpose: 'reset' });
        return startSession(user, context, {
          aal: session?.aal || 1, mfaAt: session?.mfaAt || null, reauthAt: session?.reauthAt || null, deviceHash: session?.deviceHash || null,
        });
      });
      authEvent({ type: 'password_changed', userId: user.id, sessionId: fresh.publicId, client: context.client || null, ipPrefix: context.ipPrefix || null });
      notify(user, 'password_changed', { how: 'change' });
      return { session: fresh, user: publicUser(store.getUserById(user.id), { permissions: permissionsFor(user) }) };
    },

    listOwnSessions(user, currentHash) {
      return store.listUserSessions(user.id, now()).map((session) => sessionView(session, { currentHash }));
    },

    /** Завершить свою сессию по публичному id (чужие id не находятся). */
    revokeOwnSession(user, publicId) {
      const session = store.getSessionByPublicId(publicId);
      if (!session || session.userId !== user.id) fail('not_found', 404, 'Сессия не найдена.');
      store.deleteSession(session.tokenHash);
      authEvent({ type: 'session_revoked', userId: user.id, sessionId: session.publicId, reason: 'self' });
      return { revoked: 1 };
    },

    revokeOtherSessions(user, currentHash) {
      const revoked = store.deleteOtherSessions(user.id, currentHash);
      if (revoked > 0) authEvent({ type: 'sessions_revoked', userId: user.id, reason: 'self' });
      return { revoked };
    },

    /** «Выйти на всех устройствах»: все сессии, включая текущую, и доверенные устройства. */
    revokeAllSessions(user) {
      const revoked = store.transaction(() => {
        const count = store.deleteUserSessions(user.id);
        store.deleteUserDevices(user.id);
        return count;
      });
      authEvent({ type: 'sessions_revoked', userId: user.id, reason: 'self_all' });
      return { revoked };
    },

    ownLogins(user, { limit = 20 } = {}) {
      return store.listAuthEvents({ userId: user.id, limit: Math.min(Math.max(limit, 1), 50) }).rows.map(authEventView);
    },

    setAvatar(user, dataUrl) {
      let image;
      try {
        image = sanitizeAvatar(dataUrl);
      } catch (error) {
        if (error instanceof AvatarError) fail('bad_image', 400, error.message);
        throw error;
      }
      const etag = createHash('sha256').update(image.data).digest('hex').slice(0, 16);
      store.putAvatar({ userId: user.id, mime: image.mime, data: image.data, etag, now: now() });
      return this.snapshot(store.getUserById(user.id));
    },

    deleteAvatar(user) {
      store.deleteAvatar(user.id);
      return this.snapshot(store.getUserById(user.id));
    },

    getAvatar: (userId) => store.getAvatar(userId),

    /** add — добавить, remove — убрать, merge — слить избранное этого браузера с аккаунтом. */
    updateFavorites(user, { action, ids } = {}) {
      const encoded = encodeAll(ids);
      if (encoded.length > ACCOUNT_LIMITS.MAX_FAVORITES) fail('too_many', 400, 'Слишком много избранного.');
      if (action === 'remove') {
        encoded.forEach((itemId) => store.removeFavorite(user.id, itemId));
      } else if (action === 'add' || action === 'merge') {
        const existing = new Set(store.listFavorites(user.id));
        const fresh = encoded.filter((itemId) => !existing.has(itemId));
        if (existing.size + fresh.length > ACCOUNT_LIMITS.MAX_FAVORITES) {
          fail('too_many', 400, `В избранном можно хранить до ${ACCOUNT_LIMITS.MAX_FAVORITES} записей.`);
        }
        store.addFavorites(user.id, fresh, now());
      } else {
        fail('bad_request', 400, 'Неизвестное действие.');
      }
      return { favorites: favoritesOf(user.id) };
    },

    /**
     * Удаление своего аккаунта. Только обычный пользователь: сотрудника
     * удаляет другой администратор, а последнего суперадминистратора — никто.
     */
    deleteAccount(user) {
      if (isDemoUser(user)) fail('demo_account', 403, 'Демо-аккаунт удалить нельзя.');
      if (user.role !== 'user') fail('staff_account', 403, 'Аккаунт сотрудника удаляет администратор.');
      store.transaction(() => {
        store.deleteUserAuthEvents(user.id);
        store.deleteUser(user.id);
        audit({ action: 'user.delete', actorId: user.id, actorLabel: userLabel(user), targetId: user.id, targetLabel: userLabel(user), details: { self: true } });
      });
    },

    /**
     * Обслуживание раз в час: истёкшие сессии, давние демо-копии, истёкшие
     * блокировки, журналы старше срока хранения, вызовы MFA, счётчики
     * попыток, доверенные устройства.
     */
    purgeExpiredSessions() {
      const stamp = now();
      store.purgeDemoCopies(stamp - ACCOUNT_LIMITS.DEMO_COPY_TTL_MS);
      for (const id of store.expiredBlocks(stamp)) {
        const user = store.getUserById(id);
        if (user) releaseExpiredBlock(user, stamp);
      }
      store.purgeAuthEvents(stamp - config.get('retention.authEventsDays') * DAY_MS);
      store.purgeAudit(stamp - config.get('retention.auditDays') * DAY_MS);
      store.purgeActivity(moscowDay(stamp - ACCOUNT_LIMITS.ACTIVITY_RETENTION_DAYS * DAY_MS));
      // Ссылки для входа, истёкшие больше 30 дней назад, — и для истории уже не нужны.
      store.purgeAccessTokens?.(stamp - 30 * DAY_MS);
      store.purgeRegistrations?.(stamp - 30 * DAY_MS);
      store.purgeChallenges?.(stamp);
      store.purgeDevices?.(stamp);
      throttle?.purge();
      mfa?.purge();
      mailer?.purge();
      return store.purgeExpiredSessions(stamp);
    },

    /* Для adminService, invitations и registration: общие части без дублирования. */
    __internal: {
      startSession, releaseExpiredBlock, statusProblem, newId, permissionsFor, canManage, generateTemporaryPassword,
      notify, checkNewPassword, isStaff, mfaEnabled, appUrl, authEvent,
    },
  };

  return Object.freeze(service);
};
