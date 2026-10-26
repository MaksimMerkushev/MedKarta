/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сборка кабинета: хранилище, настройки, почтовая очередь, счётчики
 * попыток входа, MFA, сервис входа, регистрация, приглашения, смена email и
 * административный сервис — один набор на процесс. Без node:sqlite или при
 * ACCOUNTS=off кабинет выключается (null), остальной сайт работает.
 *
 * При запуске: копия базы и миграции (sqliteStore.js), запуск почтовой
 * очереди, раз в час — уборка истёкших сессий, вызовов, счётчиков, писем и
 * журналов старше срока хранения.
 *
 * Суперадминистратор при обычном запуске не создаётся: только командой
 * `npm run accounts -- bootstrap` в терминале сервера. ADMIN_BOOTSTRAP_PASSWORD
 * при запуске сервера учитывается лишь вне production (локальная разработка
 * и автотесты) и только если такого аккаунта ещё нет.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoInsurance } from '../../data/demo/insurance.js';
import { createAdminService } from '../accounts/adminService.js';
import { bootstrapSuperadmin, DEFAULT_SUPERADMIN } from '../accounts/bootstrap.js';
import { createBreachChecker } from '../accounts/breachedPasswords.js';
import { createDelivery } from '../accounts/delivery.js';
import { createEmailChangeService } from '../accounts/emailChange.js';
import { createInvitationService } from '../accounts/invitations.js';
import { createMfaService, webauthnConfigFromEnv } from '../accounts/mfa.js';
import { createRegistrationService, registrationModeFromEnv } from '../accounts/registration.js';
import { createSecretBox, loadMfaKey } from '../accounts/secrets.js';
import { createAccountService } from '../accounts/service.js';
import { createSettingsService } from '../accounts/settings.js';
import { createSqliteAccountStore, loadSqlite } from '../accounts/sqliteStore.js';
import { createLoginThrottle } from '../accounts/throttle.js';
import { createMailer } from '../mail/outbox.js';
import { logger } from '../observability/safeLogger.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

export const KNOWN_PLANS = new Set((demoInsurance?.plans || []).map((plan) => plan.id));

export const defaultAccountsDbPath = () => process.env.ACCOUNTS_DB_PATH || path.join(ROOT, 'var', 'accounts', 'medkarta.sqlite');

/*
 * Удалённый аккаунт отвязывается от своих демо-записей: записи остаются
 * занятыми слотами, но больше ни с кем не связаны.
 */
export const forgetDemoBookings = async (userId) => {
  try {
    const { getDefaultDemoBookingService } = await import('./demoBooking.js');
    const service = await getDefaultDemoBookingService();
    service?.store.forgetAccount(userId);
  } catch (error) {
    logger.error('account.forget_bookings_failed', error);
  }
};

const componentHealth = async () => {
  const { collectComponentHealth } = await import('./systemInfo.js');
  return collectComponentHealth();
};

/** Набор сервисов поверх готового хранилища (тесты подставляют своё). */
export const createAccountContext = ({
  store,
  isKnownPlan = (planId) => KNOWN_PLANS.has(planId),
  onAccountDeleted = forgetDemoBookings,
  systemInfo = componentHealth,
  delivery = createDelivery(),
  env = process.env,
  mfaKey = null,
  registrationMode = registrationModeFromEnv(env),
  breachCheck = createBreachChecker({ env }),
  throttleRules = {},
  now = () => Date.now(),
}) => {
  const settings = createSettingsService({ store, now });
  // Статус доставки письма — в ссылку, к которой оно относится: «отправлено» только по факту.
  const onStatus = (ref, status) => {
    if (ref.type === 'access_token') store.setAccessTokenDelivery(ref.id, status);
    else if (ref.type === 'registration') store.setRegistrationDelivery(ref.id, status);
  };
  // Ссылка из письма ещё действует: не использована, не отозвана, не истекла.
  const refActive = (ref) => {
    const record = ref.type === 'access_token' ? store.getAccessTokenById(ref.id) : ref.type === 'registration' ? store.getRegistrationById(ref.id) : null;
    return Boolean(record && !record.usedAt && !record.revokedAt && record.expiresAt > now());
  };
  const masterKey = mfaKey || loadMfaKey({ env }).key;
  // Ключ писем — из того же главного ключа: письма со ссылками переживают перезапуск.
  const mailer = createMailer({ store, delivery, onStatus, masterKey, refActive, now });
  const throttle = createLoginThrottle({ store, settings, now, rules: throttleRules });
  const box = createSecretBox(masterKey);
  const mfa = createMfaService({ store, box, webauthn: webauthnConfigFromEnv(env, delivery.appUrl), now });
  const accounts = createAccountService({
    store, settings, isKnownPlan, mfa, mailer, throttle, breachCheck, appUrl: delivery.appUrl, now,
  });
  const invitations = createInvitationService({ store, accounts, delivery, mailer, now });
  const registration = createRegistrationService({ store, accounts, delivery, mailer, mode: registrationMode, now });
  const emailChange = createEmailChangeService({ store, accounts, delivery, mailer, now });
  const admin = createAdminService({ store, accounts, invitations, onAccountDeleted, systemInfo, throttle, now });
  return Object.freeze({ store, settings, accounts, invitations, registration, emailChange, delivery, mailer, throttle, mfa, admin });
};

/**
 * Суперадминистратор из ADMIN_BOOTSTRAP_PASSWORD при запуске сервера — только
 * вне production (локальная разработка, автотесты) и только если такого
 * аккаунта ещё нет. В production — лишь запись в журнал: суперадминистратор
 * создаётся командой `npm run accounts -- bootstrap` в терминале сервера.
 *
 * @returns {Promise<'ignored'|'created'|'exists'|'failed'|'skipped'>}
 */
export const startupBootstrap = async ({ store, env = process.env }) => {
  if (!env.ADMIN_BOOTSTRAP_PASSWORD) return 'skipped';
  const production = env.NODE_ENV === 'production' || env.APP_ENV === 'production';
  if (production) {
    logger.warn('account.bootstrap_ignored', { status: 'production' });
    return 'ignored';
  }
  try {
    const result = await bootstrapSuperadmin({
      store,
      email: env.ADMIN_BOOTSTRAP_EMAIL || DEFAULT_SUPERADMIN.email,
      password: env.ADMIN_BOOTSTRAP_PASSWORD,
    });
    logger.event('account.bootstrap', { status: result.status });
    return result.status;
  } catch (error) {
    // Слабый пароль и т. п.: сервер работает, администратора можно создать командой CLI.
    logger.error('account.bootstrap_failed', error, { code: 'bootstrap' });
    return 'failed';
  }
};

let defaultContext;

export const getAccountContext = async () => {
  if (defaultContext !== undefined) return defaultContext;
  defaultContext = (async () => {
    if (process.env.ACCOUNTS === 'off') return null;
    const DatabaseSync = await loadSqlite();
    if (!DatabaseSync) {
      logger.warn('account.unavailable', { reason: 'node_sqlite_missing' });
      return null;
    }
    let context;
    try {
      const file = defaultAccountsDbPath();
      const store = createSqliteAccountStore({ DatabaseSync, file });
      if (store.migrationBackup) logger.event('account.migration_backup', { status: 'created' });
      const key = loadMfaKey({ keyFile: path.join(path.dirname(file), 'secrets', 'mfa.key') });
      if (key.source === 'file') logger.warn('account.mfa_key_file', { status: 'file' });
      context = createAccountContext({ store, mfaKey: key.key });
      context.accounts.purgeExpiredSessions();
      context.mailer.start();
    } catch (error) {
      logger.error('account.store_failed', error);
      return null;
    }
    await startupBootstrap({ store: context.store });
    const timer = setInterval(() => {
      try {
        context.accounts.purgeExpiredSessions();
      } catch (error) {
        logger.error('account.maintenance_failed', error);
      }
    }, MAINTENANCE_INTERVAL_MS);
    timer.unref?.();
    return context;
  })();
  return defaultContext;
};

export const getDefaultAccountService = async () => (await getAccountContext())?.accounts || null;

/** Контекст, если его уже открыли (сервер открывает при запуске), — без открытия базы. */
export const peekAccountContext = () => (defaultContext === undefined ? Promise.resolve(null) : defaultContext);
