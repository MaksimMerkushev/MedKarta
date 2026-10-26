/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Второй фактор входа: ключи доступа (passkeys, WebAuthn), коды из
 * приложения (TOTP) и одноразовые резервные коды.
 *
 *   - Ключ доступа — предпочтительный способ: устойчив к фишингу (привязан
 *     к домену), секрета на сервере нет — только открытый ключ.
 *   - TOTP — для тех, у кого нет устройства с ключами доступа. Секрет
 *     хранится зашифрованным (AES-256-GCM, secrets.js), код принимается
 *     один раз (store.acceptTotpStep).
 *   - Резервные коды — 10 штук по 50 бит, выдаются один раз при включении
 *     MFA (и по запросу — новый набор взамен старого); в базе — только
 *     HMAC с ключом сервера. Каждый срабатывает один раз.
 *
 * Фактор добавляется только после проверки владения: код из приложения
 * или подпись ключом. Незавершённая настройка TOTP живёт 10 минут.
 * Решения «нужен ли второй фактор» и «можно ли удалить последний» — в
 * service.js и HTTP-слое; здесь — только факторы.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';

import { cleanTotpCode, matchTotp, newTotpSecret, otpauthUri, base32Encode } from './totp.js';
import { ALGORITHMS, verifyAssertion, verifyRegistration, WebAuthnError } from './webauthn.js';

const MINUTE = 60 * 1000;
const PENDING_TOTP_MS = 10 * MINUTE;
const REGISTER_CHALLENGE_MS = 5 * MINUTE;
const RECOVERY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const RECOVERY_CODES = Object.freeze({ COUNT: 10, LENGTH: 10 });
export const MAX_FACTORS = 10;

export const FACTOR_LABELS = Object.freeze({ totp: 'Приложение-аутентификатор', webauthn: 'Ключ доступа' });

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

export class MfaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MfaError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new MfaError(code, message);
};

/** «AbCd E-fgh12…» → «abcdefgh12»; иначе null. */
export const cleanRecoveryCode = (value) => {
  const clean = String(value ?? '').toLowerCase().replace(/[\s-]/g, '');
  return new RegExp(`^[${RECOVERY_ALPHABET}]{${RECOVERY_CODES.LENGTH}}$`).test(clean) ? clean : null;
};

const newRecoveryCode = () => {
  const chars = Array.from({ length: RECOVERY_CODES.LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
};

const cleanLabel = (value, fallback) => {
  // eslint-disable-next-line no-control-regex
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f<>]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 40) : '';
  return text || fallback;
};

/** Идентификатор пользователя для WebAuthn: не email и не id из базы, а производное без смысла. */
export const webauthnUserHandle = (userId) => createHash('sha256').update(`medkarta:webauthn:user:${userId}`).digest().subarray(0, 32).toString('base64url');

/**
 * Настройки WebAuthn из окружения: rpId — домен из PUBLIC_BASE_URL (или
 * WEBAUTHN_RP_ID), разрешённые origin — сам PUBLIC_BASE_URL и WEBAUTHN_ORIGINS.
 * Без PUBLIC_BASE_URL ключи доступа выключены (TOTP работает).
 */
export const webauthnConfigFromEnv = (env = process.env, appUrl = null) => {
  const base = appUrl || env.PUBLIC_BASE_URL || env.APP_URL;
  if (!base) return null;
  try {
    const url = new URL(base);
    const rpId = env.WEBAUTHN_RP_ID || url.hostname;
    if (!url.hostname.endsWith(rpId)) return null;
    const extra = String(env.WEBAUTHN_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    return { rpId, rpName: 'МедКарта', origins: [url.origin, ...extra] };
  } catch {
    return null;
  }
};

/**
 * @param {object} deps
 * @param {object} deps.store
 * @param {object} deps.box secrets.createSecretBox(ключ)
 * @param {{rpId: string, rpName: string, origins: string[]}|null} [deps.webauthn]
 * @param {() => number} [deps.now]
 */
export const createMfaService = ({ store, box, webauthn = null, now = () => Date.now() }) => {
  const factorView = (factor) => ({
    id: factor.id,
    type: factor.type,
    typeLabel: FACTOR_LABELS[factor.type],
    label: factor.label,
    createdAt: iso(factor.confirmedAt || factor.createdAt),
    lastUsedAt: iso(factor.lastUsedAt),
    synced: factor.type === 'webauthn' ? Boolean(factor.backedUp) : null,
    // Ключ доступа проверяет человека (PIN, отпечаток, лицо); null — неизвестно (ключ добавлен до схемы 6).
    userVerified: factor.type === 'webauthn' ? factor.userVerified : null,
  });

  const recoveryState = (userId) => {
    const row = store.countRecoveryCodes(userId);
    return { total: row?.total || 0, unused: row?.unused || 0 };
  };

  const issueRecoveryCodes = (userId) => {
    const codes = Array.from({ length: RECOVERY_CODES.COUNT }, newRecoveryCode);
    store.replaceRecoveryCodes(userId, codes.map((code) => box.mac(`${userId}:${cleanRecoveryCode(code)}`)), now());
    return codes;
  };

  const ensureRoom = (userId) => {
    if (store.countActiveFactors(userId) >= MAX_FACTORS) fail('too_many_factors', `Можно добавить не больше ${MAX_FACTORS} факторов входа.`);
  };

  const challengeKey = (userId) => createHash('sha256').update(`webauthn_register:${userId}`).digest('hex');

  const service = {
    passkeysAvailable: Boolean(webauthn),

    hasMfa: (userId) => store.countActiveFactors(userId) > 0,

    /** Что включено у пользователя — для профиля и проверки входа. */
    status(userId) {
      const factors = store.listFactors(userId).map(factorView);
      const recovery = recoveryState(userId);
      const methods = [...new Set(factors.map((factor) => factor.type))];
      if (factors.length > 0 && recovery.unused > 0) methods.push('recovery');
      return { enabled: factors.length > 0, factors, recoveryCodes: recovery, methods, passkeysAvailable: Boolean(webauthn) };
    },

    /* ------------------------------- TOTP ------------------------------- */

    /** Начать настройку: новый секрет (живёт 10 минут до подтверждения). */
    beginTotp(user) {
      ensureRoom(user.id);
      store.deletePendingFactors(user.id);
      const secret = newTotpSecret();
      const id = randomBytes(12).toString('hex');
      store.insertFactor({
        id, userId: user.id, type: 'totp', label: FACTOR_LABELS.totp, status: 'pending',
        secretEnc: box.seal(secret, `totp:${id}`), now: now(), expiresAt: now() + PENDING_TOTP_MS,
      });
      return { factorId: id, secret: base32Encode(secret), uri: otpauthUri({ secret, account: user.email }), expiresAt: iso(now() + PENDING_TOTP_MS) };
    },

    /** Подтвердить настройку кодом из приложения. firstFactor — выдать резервные коды. */
    confirmTotp(user, { factorId, code, label } = {}) {
      const factor = store.getFactor(factorId);
      if (!factor || factor.userId !== user.id || factor.type !== 'totp' || factor.status !== 'pending' || factor.expiresAt < now()) {
        fail('setup_expired', 'Настройка устарела — начните заново.');
      }
      if (!cleanTotpCode(code)) fail('bad_code', 'Введите 6 цифр из приложения.');
      const secret = box.open(factor.secretEnc, `totp:${factor.id}`);
      if (!secret) fail('setup_expired', 'Настройка устарела — начните заново.');
      const step = matchTotp(secret, code, { now: now() });
      if (step === null) fail('bad_code', 'Код не подошёл. Проверьте время на телефоне и введите текущий код.');
      ensureRoom(user.id);
      const first = store.countActiveFactors(user.id) === 0;
      return store.transaction(() => {
        if (!store.activateFactor(factor.id, { now: now(), lastStep: step })) fail('setup_expired', 'Настройка устарела — начните заново.');
        if (label) store.renameFactor(factor.id, cleanLabel(label, FACTOR_LABELS.totp));
        const recoveryCodes = first || recoveryState(user.id).unused === 0 ? issueRecoveryCodes(user.id) : null;
        return { factor: factorView(store.getFactor(factor.id)), recoveryCodes };
      });
    },

    /** Проверить код TOTP при входе: true — принят (и больше не сработает). */
    verifyTotp(userId, code) {
      if (!cleanTotpCode(code)) return false;
      for (const factor of store.listFactors(userId).filter((item) => item.type === 'totp')) {
        const secret = box.open(factor.secretEnc, `totp:${factor.id}`);
        if (!secret) continue;
        const step = matchTotp(secret, code, { now: now(), lastStep: factor.lastStep });
        if (step !== null && store.acceptTotpStep(factor.id, step, now())) return { ok: true, factorId: factor.id };
      }
      return { ok: false };
    },

    /* --------------------------- ключи доступа --------------------------- */

    /**
     * Параметры для navigator.credentials.create(). requireUv — сотрудник:
     * ключ обязан проверить человека (PIN, отпечаток, лицо), а не только
     * присутствие. Touch ID, Face ID, Windows Hello, Android и ключи FIDO2
     * с PIN это умеют; старые ключи U2F без PIN — нет.
     */
    beginPasskey(user, { requireUv = false } = {}) {
      if (!webauthn) fail('passkeys_unavailable', 'Ключи доступа не настроены на сервере.');
      ensureRoom(user.id);
      const challenge = randomBytes(32).toString('base64url');
      const idHash = challengeKey(user.id);
      store.deleteChallenge(idHash);
      store.createChallenge({ idHash, userId: user.id, purpose: 'webauthn_register', now: now(), expiresAt: now() + REGISTER_CHALLENGE_MS, challenge });
      const existing = store.listFactors(user.id).filter((factor) => factor.type === 'webauthn');
      return {
        challenge,
        rp: { id: webauthn.rpId, name: webauthn.rpName },
        user: { id: webauthnUserHandle(user.id), name: user.email, displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email },
        pubKeyCredParams: [ALGORITHMS.ES256, ALGORITHMS.EdDSA, ALGORITHMS.RS256].map((alg) => ({ type: 'public-key', alg })),
        timeout: REGISTER_CHALLENGE_MS,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'preferred', userVerification: requireUv ? 'required' : 'preferred' },
        excludeCredentials: existing.map((factor) => ({ type: 'public-key', id: factor.credentialId, transports: factor.transports })),
      };
    },

    /** Проверить ответ браузера и сохранить ключ. */
    finishPasskey(user, { credential, label, requireUv = false } = {}) {
      if (!webauthn) fail('passkeys_unavailable', 'Ключи доступа не настроены на сервере.');
      const idHash = challengeKey(user.id);
      const record = store.getChallenge(idHash);
      if (!record || record.userId !== user.id || record.expiresAt < now() || record.consumedAt) fail('setup_expired', 'Время на добавление ключа истекло — начните заново.');
      // Вызов одноразовый: и удачная, и неудачная попытка его гасят.
      if (!store.consumeChallenge(idHash, now())) fail('setup_expired', 'Время на добавление ключа истекло — начните заново.');
      let verified;
      try {
        verified = verifyRegistration(credential, { challenge: record.challenge, rpId: webauthn.rpId, origins: webauthn.origins });
      } catch (error) {
        if (error instanceof WebAuthnError) fail('bad_passkey', 'Ключ не прошёл проверку. Попробуйте ещё раз.');
        throw error;
      }
      if (requireUv && !verified.userVerified) {
        fail('uv_required', 'Ключ не проверил вас: для сотрудника нужен ключ с PIN-кодом, отпечатком или распознаванием лица. Задайте PIN на аппаратном ключе или используйте Touch ID, Face ID, Windows Hello или телефон.');
      }
      if (store.getFactorByCredentialId(verified.credentialId)) fail('passkey_exists', 'Этот ключ уже добавлен.');
      ensureRoom(user.id);
      const first = store.countActiveFactors(user.id) === 0;
      return store.transaction(() => {
        const id = randomBytes(12).toString('hex');
        store.insertFactor({
          id, userId: user.id, type: 'webauthn', label: cleanLabel(label, FACTOR_LABELS.webauthn), status: 'active',
          credentialId: verified.credentialId, publicKey: verified.publicKey, algorithm: verified.algorithm,
          signCount: verified.signCount, transports: verified.transports.join(','), backedUp: verified.backedUp,
          userVerified: verified.userVerified, now: now(), confirmedAt: now(),
        });
        store.deleteChallenge(idHash);
        const recoveryCodes = first || recoveryState(user.id).unused === 0 ? issueRecoveryCodes(user.id) : null;
        return { factor: factorView(store.getFactor(id)), recoveryCodes };
      });
    },

    /**
     * Параметры для navigator.credentials.get() — ключи этого пользователя.
     * requireUv (сотрудник): «required», если все его ключи умеют проверять
     * человека; иначе «preferred», чтобы старый ключ без PIN не оставил без
     * входа, — но ключ, который хоть раз проверил человека, обязан делать
     * это всегда (проверяется в verifyPasskey).
     */
    assertionOptions(userId, challenge, { requireUv = false } = {}) {
      if (!webauthn) return null;
      const keys = store.listFactors(userId).filter((factor) => factor.type === 'webauthn');
      if (keys.length === 0) return null;
      const allVerify = keys.every((factor) => factor.userVerified === true);
      return {
        challenge,
        rpId: webauthn.rpId,
        timeout: 5 * MINUTE,
        userVerification: requireUv && allVerify ? 'required' : 'preferred',
        allowCredentials: keys.map((factor) => ({ type: 'public-key', id: factor.credentialId, transports: factor.transports })),
      };
    },

    /**
     * Проверить подпись ключом доступа. requireUv (сотрудник): если ключ
     * умеет проверять человека (так было при регистрации или раньше при
     * входе), ответ без проверки отвергается — нельзя «понизить» ключ,
     * просто не введя PIN.
     */
    verifyPasskey(userId, credential, challenge, { requireUv = false } = {}) {
      if (!webauthn || !challenge || !credential || typeof credential.id !== 'string') return { ok: false };
      const factor = store.getFactorByCredentialId(credential.id);
      if (!factor || factor.userId !== userId || factor.status !== 'active' || factor.type !== 'webauthn') return { ok: false };
      try {
        const result = verifyAssertion(credential, {
          challenge, rpId: webauthn.rpId, origins: webauthn.origins, publicKey: factor.publicKey, algorithm: factor.algorithm, signCount: factor.signCount,
        });
        if (requireUv && factor.userVerified === true && !result.userVerified) return { ok: false, reason: 'uv_required' };
        if (!store.acceptWebauthnCounter(factor.id, result.signCount, now())) return { ok: false, reason: 'counter_replay' };
        if (result.userVerified && factor.userVerified !== true) store.markFactorUserVerified(factor.id);
        return { ok: true, factorId: factor.id, userVerified: result.userVerified };
      } catch (error) {
        if (error instanceof WebAuthnError) return { ok: false, reason: error.code };
        throw error;
      }
    },

    /* --------------------------- резервные коды --------------------------- */

    /** Новый набор вместо старого. Возвращается один раз — в базе только HMAC. */
    regenerateRecoveryCodes(userId) {
      if (store.countActiveFactors(userId) === 0) fail('mfa_disabled', 'Сначала включите двухфакторную защиту.');
      return issueRecoveryCodes(userId);
    },

    verifyRecovery(userId, code) {
      const clean = cleanRecoveryCode(code);
      if (!clean || store.countActiveFactors(userId) === 0) return { ok: false };
      const ok = store.useRecoveryCode(userId, box.mac(`${userId}:${clean}`), now());
      return ok ? { ok: true, remaining: recoveryState(userId).unused } : { ok: false };
    },

    /* ----------------------------- управление ----------------------------- */

    rename(userId, factorId, label) {
      const factor = store.getFactor(factorId);
      if (!factor || factor.userId !== userId || factor.status !== 'active') fail('not_found', 'Фактор не найден.');
      store.renameFactor(factor.id, cleanLabel(label, FACTOR_LABELS[factor.type]));
      return factorView(store.getFactor(factor.id));
    },

    /**
     * Удалить фактор. Последний — только если keepOne=false; вместе с ним
     * удаляются и резервные коды (MFA выключена).
     */
    remove(userId, factorId, { keepOne = false } = {}) {
      const factor = store.getFactor(factorId);
      if (!factor || factor.userId !== userId || factor.status !== 'active') fail('not_found', 'Фактор не найден.');
      return store.transaction(() => {
        const active = store.countActiveFactors(userId);
        if (keepOne && active <= 1) fail('last_factor', 'Это последний фактор входа: для вашей роли двухфакторная защита обязательна. Сначала добавьте другой.');
        store.revokeFactor(factor.id, now());
        const remaining = store.countActiveFactors(userId);
        if (remaining === 0) store.deleteRecoveryCodes(userId);
        return { removed: factorView(factor), remaining };
      });
    },

    /** Сбросить всё (процедура восстановления через CLI): факторы, коды, незавершённые настройки. */
    resetAll(userId) {
      return store.transaction(() => {
        const revoked = store.revokeUserFactors(userId, now());
        store.deleteRecoveryCodes(userId);
        store.deleteUserChallenges(userId);
        store.deletePendingFactors(userId);
        return revoked;
      });
    },

    purge: () => store.purgeFactors(now()),
  };

  return Object.freeze(service);
};
