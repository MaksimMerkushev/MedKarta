/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сборка кабинета: хранилище, настройки, сервис входа, приглашения с
 * доставкой ссылок и административный сервис — один набор на процесс. Без node:sqlite или при ACCOUNTS=off
 * кабинет выключается (null), остальной сайт работает.
 *
 * При запуске: миграции базы, первый суперадминистратор из
 * ADMIN_BOOTSTRAP_PASSWORD (если задан и такого ещё нет), раз в час —
 * уборка истёкших сессий и журналов старше срока хранения.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoInsurance } from '../../data/demo/insurance.js';
import { createAdminService } from '../accounts/adminService.js';
import { bootstrapSuperadmin, DEFAULT_SUPERADMIN } from '../accounts/bootstrap.js';
import { createDelivery } from '../accounts/delivery.js';
import { createInvitationService } from '../accounts/invitations.js';
import { createAccountService } from '../accounts/service.js';
import { createSettingsService } from '../accounts/settings.js';
import { createSqliteAccountStore, loadSqlite } from '../accounts/sqliteStore.js';
import { setLimitSettings } from '../http/rateLimit.js';
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
  now = () => Date.now(),
}) => {
  const settings = createSettingsService({ store, now });
  const accounts = createAccountService({ store, settings, isKnownPlan, now });
  const invitations = createInvitationService({ store, accounts, delivery, now });
  const admin = createAdminService({ store, accounts, invitations, onAccountDeleted, systemInfo, now });
  return Object.freeze({ store, settings, accounts, invitations, delivery, admin });
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
      context = createAccountContext({ store: createSqliteAccountStore({ DatabaseSync, file: defaultAccountsDbPath() }) });
      context.accounts.purgeExpiredSessions();
    } catch (error) {
      logger.error('account.store_failed', error);
      return null;
    }
    // Лимиты нагрузки и бюджет модели из админ-панели — без перезапуска.
    setLimitSettings((key) => context.settings.get(key));
    if (process.env.ADMIN_BOOTSTRAP_PASSWORD) {
      try {
        const result = await bootstrapSuperadmin({
          store: context.store,
          email: process.env.ADMIN_BOOTSTRAP_EMAIL || DEFAULT_SUPERADMIN.email,
          password: process.env.ADMIN_BOOTSTRAP_PASSWORD,
        });
        logger.event('account.bootstrap', { status: result.status });
      } catch (error) {
        // Слабый пароль и т. п.: сервер работает, администратора можно создать командой CLI.
        logger.error('account.bootstrap_failed', error, { code: 'bootstrap' });
      }
    }
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
