/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Личный кабинет: вход, сессии, свой профиль, пароль, программа ДМС,
 * избранное, демо-аккаунты. Административные операции — в adminService.js.
 *
 * Сервис не знает ни про HTTP, ни про SQL: HTTP — в api/account.js и
 * api/me.js, хранилище — в sqliteStore.js (или любом другом с теми же
 * методами).
 *
 * Аккаунты создаёт только администратор: публичной регистрации нет.
 */

import { createHash, randomBytes } from 'node:crypto';

import { AvatarError, sanitizeAvatar } from './avatar.js';
import { generateTemporaryPassword, hashPassword, needsRehash, PasswordBusyError, passwordProblem, verifyPassword } from './passwords.js';
import { canManage, permissionsOf, ROLE_INFO } from './rbac.js';
import { createSettingsService } from './settings.js';
import { searchTextOf } from './sqliteStore.js';

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
});

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
 * Демо-аккаунты — вымышленные люди с программами ДМС из демо-набора.
 * Пароля у них нет: войти можно только кнопкой «Войти как …», и только
 * когда на сервере включён DEMO_DATA. Избранное — id демо-врачей.
 *
 * Каждый браузер получает свою копию каждого демо-аккаунта (cookie
 * mk_demo): избранное, программа ДМС и записи одного зрителя не видны
 * другому, а после выхода и повторного входа в том же браузере — на месте.
 */
export const DEMO_ACCOUNTS = Object.freeze([
  {
    key: 'anna',
    email: 'anna@medkarta.example',
    displayName: 'Анна (демо)',
    dmsPlanId: 'demo-standard',
    note: 'Программа Demo Standard, Демо-Страхование',
    favorites: ['demo-doc-valeev-vadim--demo-yasen-centr', 'demo-doc-zinnatullina-nailya--demo-yasen-centr'],
  },
  {
    key: 'family',
    email: 'family@medkarta.example',
    displayName: 'Семья Демо',
    dmsPlanId: 'demo-premium',
    note: 'Семейная программа Demo Premium',
    favorites: ['demo-doc-nikitina-guzel--demo-semya-moskovsky', 'demo-doc-ovchinnikova-mariya--demo-semya-moskovsky'],
  },
  {
    key: 'kids',
    email: 'kids@medkarta.example',
    displayName: 'Мама Тимура (демо)',
    dmsPlanId: 'demo-standard',
    note: 'Demo Standard: взрослые и дети',
    favorites: ['demo-doc-frolova-yuliya--demo-detstvo-derbyshki'],
  },
  {
    key: 'basic',
    email: 'ildar@medkarta.example',
    displayName: 'Ильдар (демо)',
    dmsPlanId: 'demo-basic',
    note: 'Базовая программа Demo Basic',
    favorites: [],
  },
]);

const DEMO_OWNER = /^[A-Za-z0-9_-]{32,64}$/;
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
  // У копии демо-аккаунта служебный email — показываем адрес шаблона.
  email: user.demoTemplate ? DEMO_ACCOUNTS.find((account) => account.key === user.demoTemplate)?.email || user.email : user.email,
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
  permissions,
});

export const sessionView = (session, { currentHash = null } = {}) => ({
  id: session.publicId,
  createdAt: iso(session.createdAt),
  lastSeenAt: iso(session.lastSeenAt),
  expiresAt: iso(session.expiresAt),
  client: session.client || 'Неизвестный клиент',
  network: session.ipPrefix || null,
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

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {object} [deps.settings] настройки (settings.js); по умолчанию — из того же хранилища
 * @param {(planId: string) => boolean} [deps.isKnownPlan] есть ли такая программа ДМС
 * @param {() => number} [deps.now]
 */
export const createAccountService = ({ store, settings = null, isKnownPlan = () => false, now = () => Date.now() }) => {
  const config = settings || createSettingsService({ store, now });
  const newId = () => randomBytes(16).toString('hex');
  // Дни, уже отмеченные в user_activity: не писать в базу на каждый запрос.
  const markedDays = new Map();

  let overridesCache = null;
  const roleOverrides = () => {
    overridesCache ||= Object.fromEntries(Object.entries(store.listRoleOverrides()).map(([role, row]) => [role, row.permissions]));
    return overridesCache;
  };
  const permissionsFor = (user) => (user && !isDemoUser(user) ? permissionsOf(user.role, roleOverrides()) : []);

  const sessionLimits = (user) => {
    if (isDemoUser(user)) return { idle: ACCOUNT_LIMITS.DEMO_SESSION_TTL_MS, max: ACCOUNT_LIMITS.DEMO_SESSION_TTL_MS, perUser: 10 };
    return {
      idle: config.get('sessions.idleDays') * DAY_MS,
      max: config.get('sessions.maxDays') * DAY_MS,
      perUser: config.get('sessions.maxPerUser'),
    };
  };

  const startSession = (user, { client = null, ipPrefix = null } = {}) => {
    const token = randomBytes(32).toString('base64url');
    const publicId = newPublicId();
    const created = now();
    const limits = sessionLimits(user);
    const expiresAt = created + Math.min(limits.idle, limits.max);
    store.createSession({
      tokenHash: hashToken(token),
      publicId,
      userId: user.id,
      now: created,
      expiresAt,
      maxPerUser: limits.perUser,
      client,
      ipPrefix,
    });
    return { token, expiresAt, publicId, tokenHash: hashToken(token) };
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

  const service = {
    settings: config,
    permissionsFor,
    reloadRoleOverrides() {
      overridesCache = null;
    },

    /**
     * Вход по email и паролю. Ответ одинаковый для несуществующего email и
     * неверного пароля; о блокировке сообщается только при верном пароле.
     *
     * @param {{email: string, password: string}} credentials
     * @param {{client?: string, ipPrefix?: string}} [context] для истории входов
     */
    async login({ email, password } = {}, context = {}) {
      const address = normalizeEmail(email);
      const found = address && address.length <= ACCOUNT_LIMITS.MAX_EMAIL ? store.getUserByEmail(address) : null;
      const user = found && !isDemoUser(found) ? found : null;
      // Проверка идёт и для несуществующего адреса — по времени ответа не понять, есть ли аккаунт.
      const valid = await verifyPassword(typeof password === 'string' ? password.slice(0, 256) : '', user?.passwordHash || null).catch(busy);
      const stamp = now();
      const event = { at: stamp, client: context.client || null, ipPrefix: context.ipPrefix || null };
      if (!user || !user.passwordHash || !valid) {
        if (user) store.recordFailedLogin(user.id, stamp);
        store.addAuthEvent({ ...event, type: 'login_failed', userId: user?.id || null, reason: user ? 'bad_password' : 'unknown_user' });
        fail('bad_credentials', 401, 'Неверный email или пароль.');
      }
      const current = releaseExpiredBlock(user, stamp);
      const problem = statusProblem(current);
      if (problem) {
        store.addAuthEvent({ ...event, type: 'login_denied', userId: user.id, reason: current.status });
        fail(problem.code, 403, problem.message, problem.extra);
      }
      if (needsRehash(current.passwordHash)) {
        const fresh = await hashPassword(password).catch(() => null);
        if (fresh) store.rehashPassword(current.id, fresh);
      }
      // Новый токен на каждый вход: сессия, известная до входа, не становится вошедшей (session fixation).
      const session = startSession(current, context);
      store.recordLogin(current.id, stamp);
      markActivity(current.id, stamp);
      store.addAuthEvent({ ...event, type: 'login_ok', userId: current.id, sessionId: session.publicId });
      const fresh = store.getUserById(current.id);
      return { user: publicUser(fresh, { permissions: permissionsFor(fresh) }), favorites: favoritesOf(fresh.id), session };
    },

    /**
     * Вход в копию демо-аккаунта этого браузера. Копии нет — она создаётся
     * из шаблона; есть — возвращается со всеми изменениями.
     *
     * @param {string} key ключ шаблона (DEMO_ACCOUNTS)
     * @param {{owner?: string, client?: string, ipPrefix?: string}} [options] owner — токен браузера из cookie mk_demo
     * @returns {{user: object, favorites: Array, session: object, owner: string}}
     *   owner — токен браузера: новый, если прежнего не было или он испорчен
     */
    demoLogin(key, { owner, client = null, ipPrefix = null } = {}) {
      const seed = DEMO_ACCOUNTS.find((account) => account.key === key);
      if (!seed) fail('unknown_demo', 404, 'Такого демо-аккаунта нет.');
      const ownerToken = typeof owner === 'string' && DEMO_OWNER.test(owner) ? owner : randomBytes(32).toString('base64url');
      const ownerHash = hashToken(`demo-owner|${ownerToken}`);
      const stamp = now();
      let user = store.getDemoCopy(seed.key, ownerHash);
      if (user) {
        store.touchUser(user.id, stamp);
      } else {
        store.purgeDemoCopies(stamp - ACCOUNT_LIMITS.DEMO_COPY_TTL_MS);
        const excess = store.countDemoCopies() - ACCOUNT_LIMITS.MAX_DEMO_COPIES + 1;
        if (excess > 0) store.deleteOldestDemoCopies(excess);
        const id = newId();
        user = store.createUser({
          id,
          email: `demo-${id}@medkarta.example`,
          firstName: seed.displayName,
          displayName: seed.displayName,
          dmsPlanId: seed.dmsPlanId && isKnownPlan(seed.dmsPlanId) ? seed.dmsPlanId : null,
          demoTemplate: seed.key,
          demoOwner: ownerHash,
          now: stamp,
        });
        store.addFavorites(user.id, seed.favorites.map(encodeItemId).filter(Boolean), stamp);
      }
      const fresh = store.getUserById(user.id);
      return { user: publicUser(fresh), favorites: favoritesOf(fresh.id), session: startSession(fresh, { client, ipPrefix }), owner: ownerToken };
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
      if (session.createdAt + limits.max <= stamp) {
        store.deleteSession(tokenHash);
        return null;
      }
      user = releaseExpiredBlock(user, stamp);
      if (statusProblem(user)) {
        store.deleteUserSessions(user.id);
        return null;
      }
      if (touch && stamp - session.lastSeenAt >= ACCOUNT_LIMITS.TOUCH_INTERVAL_MS) {
        const expiresAt = Math.min(stamp + limits.idle, session.createdAt + limits.max);
        store.touchSession(tokenHash, stamp, Math.max(expiresAt, session.expiresAt));
        session.lastSeenAt = stamp;
        if (!isDemoUser(user)) store.setLastSeen(user.id, stamp);
      }
      if (touch && !isDemoUser(user)) markActivity(user.id, stamp);
      return { user, session, permissions: permissionsFor(user) };
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
      if (user && !isDemoUser(user)) store.addAuthEvent({ at: now(), type: 'logout', userId: user.id, sessionId: session.publicId, client: session.client, ipPrefix: session.ipPrefix });
    },

    snapshot(user) {
      return { user: publicUser(user, { permissions: permissionsFor(user) }), favorites: favoritesOf(user.id) };
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
     * завершаются, и выдаётся новая: украденный раньше токен перестаёт работать.
     */
    async changePassword(user, { currentPassword, newPassword } = {}, context = {}) {
      if (isDemoUser(user)) fail('demo_account', 403, 'У демо-аккаунта нет пароля.');
      const valid = await verifyPassword(typeof currentPassword === 'string' ? currentPassword.slice(0, 256) : '', user.passwordHash).catch(busy);
      if (!valid) fail('bad_password', 400, 'Текущий пароль неверный.');
      const problem = passwordProblem(newPassword, { email: user.email });
      if (problem) fail('weak_password', 400, problem);
      if (newPassword === currentPassword) fail('weak_password', 400, 'Новый пароль должен отличаться от текущего.');
      const passwordHash = await hashPassword(newPassword).catch(busy);
      const stamp = now();
      const session = store.transaction(() => {
        store.setPassword(user.id, passwordHash, { mustChange: false, now: stamp });
        store.deleteUserSessions(user.id);
        return startSession(user, context);
      });
      store.addAuthEvent({ at: stamp, type: 'password_changed', userId: user.id, sessionId: session.publicId, client: context.client || null, ipPrefix: context.ipPrefix || null });
      return { session, user: publicUser(store.getUserById(user.id), { permissions: permissionsFor(user) }) };
    },

    listOwnSessions(user, currentHash) {
      return store.listUserSessions(user.id, now()).map((session) => sessionView(session, { currentHash }));
    },

    /** Завершить свою сессию по публичному id (чужие id не находятся). */
    revokeOwnSession(user, publicId) {
      const session = store.getSessionByPublicId(publicId);
      if (!session || session.userId !== user.id) fail('not_found', 404, 'Сессия не найдена.');
      store.deleteSession(session.tokenHash);
      store.addAuthEvent({ at: now(), type: 'session_revoked', userId: user.id, sessionId: session.publicId, reason: 'self' });
      return { revoked: 1 };
    },

    revokeOtherSessions(user, currentHash) {
      const revoked = store.deleteOtherSessions(user.id, currentHash);
      if (revoked > 0) store.addAuthEvent({ at: now(), type: 'sessions_revoked', userId: user.id, reason: 'self' });
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
     * блокировки, журналы старше срока хранения.
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
      return store.purgeExpiredSessions(stamp);
    },

    /* Для adminService: общие части без дублирования. */
    __internal: { startSession, releaseExpiredBlock, statusProblem, newId, permissionsFor, canManage, generateTemporaryPassword },
  };

  return Object.freeze(service);
};
