/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Личный кабинет: аккаунты, сессии, программа ДМС, избранное.
 *
 * Сервис не знает ни про HTTP, ни про SQL: HTTP — в api/account.js,
 * хранилище — в sqliteStore.js (или любом другом с теми же методами).
 */

import { createHash, randomBytes } from 'node:crypto';

import { hashPassword, PasswordBusyError, passwordProblem, verifyPassword } from './passwords.js';

export const ACCOUNT_LIMITS = Object.freeze({
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  MAX_SESSIONS_PER_USER: 10,
  DEMO_SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  // Копия демо-аккаунта живёт, пока браузер к ней возвращается; потолок
  // числа копий защищает базу от входов в цикле.
  DEMO_COPY_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  MAX_DEMO_COPIES: 10_000,
  MAX_FAVORITES: 500,
  MAX_NAME: 60,
  MAX_EMAIL: 254,
  MAX_ITEM_ID: 160,
});

export class AccountError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status, message) => {
  throw new AccountError(code, status, message);
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
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/iu;
const PLAN_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

export const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export const cleanDisplayName = (value) =>
  (typeof value === 'string' ? value.replace(CONTROL, '').replace(/\s+/gu, ' ').trim().slice(0, ACCOUNT_LIMITS.MAX_NAME) : '');

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

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const isDemoUser = (user) => Boolean(user.demoTemplate);

/** То, что уходит в браузер: без хэша пароля и служебных полей. */
export const publicUser = (user) => ({
  // У копии демо-аккаунта служебный email — показываем адрес шаблона.
  email: user.demoTemplate ? DEMO_ACCOUNTS.find((account) => account.key === user.demoTemplate)?.email || user.email : user.email,
  displayName: user.displayName,
  dmsPlanId: user.dmsPlanId || null,
  isDemo: isDemoUser(user),
  createdAt: new Date(user.createdAt).toISOString(),
});

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {(planId: string) => boolean} [deps.isKnownPlan] есть ли такая программа ДМС
 * @param {() => number} [deps.now]
 */
export const createAccountService = ({ store, isKnownPlan = () => false, now = () => Date.now() }) => {
  const newId = () => randomBytes(16).toString('hex');

  const startSession = (user) => {
    const token = randomBytes(32).toString('base64url');
    const created = now();
    const ttl = isDemoUser(user) ? ACCOUNT_LIMITS.DEMO_SESSION_TTL_MS : ACCOUNT_LIMITS.SESSION_TTL_MS;
    store.createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      now: created,
      expiresAt: created + ttl,
      maxPerUser: ACCOUNT_LIMITS.MAX_SESSIONS_PER_USER,
    });
    return { token, expiresAt: created + ttl };
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

  return Object.freeze({
    async register({ email, password, displayName, consent }) {
      const address = normalizeEmail(email);
      const name = cleanDisplayName(displayName);
      if (consent !== true) fail('consent_required', 400, 'Нужно согласие на обработку данных.');
      if (!address || address.length > ACCOUNT_LIMITS.MAX_EMAIL || !EMAIL.test(address)) fail('bad_email', 400, 'Проверьте email.');
      if (address.endsWith('.example')) fail('bad_email', 400, 'Этот адрес зарезервирован для демо-аккаунтов.');
      if (!name) fail('bad_name', 400, 'Как к вам обращаться?');
      const problem = passwordProblem(password);
      if (problem) fail('weak_password', 400, problem);

      const passwordHash = await hashPassword(password).catch(busy);
      if (store.getUserByEmail(address)) {
        // «email занят» раскрывает, кто зарегистрирован, но ответить как при
        // успехе нельзя: пользователь ждёт вход. При открытой регистрации
        // нужно подтверждение по почте.
        fail('email_taken', 409, 'С этим email уже есть аккаунт — войдите.');
      }
      const user = store.createUser({ id: newId(), email: address, displayName: name, passwordHash, now: now() });
      return { user: publicUser(user), favorites: [], session: startSession(user) };
    },

    async login({ email, password }) {
      const address = normalizeEmail(email);
      const user = address ? store.getUserByEmail(address) : null;
      // Проверка идёт и для несуществующего адреса — по времени ответа не понять, есть ли аккаунт.
      const valid = await verifyPassword(typeof password === 'string' ? password : '', user?.passwordHash || null).catch(busy);
      if (!user || !user.passwordHash || !valid) fail('bad_credentials', 401, 'Неверный email или пароль.');
      return { user: publicUser(user), favorites: favoritesOf(user.id), session: startSession(user) };
    },

    /**
     * Вход в копию демо-аккаунта этого браузера. Копии нет — она создаётся
     * из шаблона; есть — возвращается со всеми изменениями.
     *
     * @param {string} key ключ шаблона (DEMO_ACCOUNTS)
     * @param {{owner?: string}} [options] токен браузера из cookie mk_demo
     * @returns {{user: object, favorites: Array, session: object, owner: string}}
     *   owner — токен браузера: новый, если прежнего не было или он испорчен
     */
    demoLogin(key, { owner } = {}) {
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
          displayName: seed.displayName,
          dmsPlanId: seed.dmsPlanId && isKnownPlan(seed.dmsPlanId) ? seed.dmsPlanId : null,
          demoTemplate: seed.key,
          demoOwner: ownerHash,
          now: stamp,
        });
        store.addFavorites(user.id, seed.favorites.map(encodeItemId).filter(Boolean), stamp);
      }
      const fresh = store.getUserById(user.id);
      return { user: publicUser(fresh), favorites: favoritesOf(fresh.id), session: startSession(fresh), owner: ownerToken };
    },

    /** Пользователь по токену из cookie или null. Истёкшая сессия удаляется. */
    sessionUser(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const session = store.getSession(hashToken(token));
      if (!session) return null;
      if (session.expiresAt <= now()) {
        store.deleteSession(session.tokenHash);
        return null;
      }
      return store.getUserById(session.userId);
    },

    logout(token) {
      if (typeof token === 'string' && token) store.deleteSession(hashToken(token));
    },

    snapshot(user) {
      return { user: publicUser(user), favorites: favoritesOf(user.id) };
    },

    updateProfile(user, { displayName, dmsPlanId } = {}) {
      const stamp = now();
      if (displayName !== undefined && isDemoUser(user)) fail('demo_account', 403, 'Имя демо-аккаунта не меняется.');
      if (displayName !== undefined) {
        const name = cleanDisplayName(displayName);
        if (!name) fail('bad_name', 400, 'Имя не может быть пустым.');
        store.updateDisplayName(user.id, name, stamp);
      }
      if (dmsPlanId !== undefined) store.updateDmsPlan(user.id, checkPlan(dmsPlanId), stamp);
      return this.snapshot(store.getUserById(user.id));
    },

    /** add — добавить, remove — убрать, merge — слить избранное этого браузера с аккаунтом. */
    updateFavorites(user, { action, ids }) {
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

    deleteAccount(user) {
      if (isDemoUser(user)) fail('demo_account', 403, 'Демо-аккаунт удалить нельзя.');
      store.deleteUser(user.id);
    },

    /** Убирает истёкшие сессии и копии демо-аккаунтов, к которым давно не возвращались. */
    purgeExpiredSessions() {
      const stamp = now();
      store.purgeDemoCopies(stamp - ACCOUNT_LIMITS.DEMO_COPY_TTL_MS);
      return store.purgeExpiredSessions(stamp);
    },
  });
};
