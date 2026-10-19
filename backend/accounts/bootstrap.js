/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Первый суперадминистратор и тестовые пользователи.
 *
 * Суперадминистратор создаётся один раз: из ADMIN_BOOTSTRAP_PASSWORD при
 * запуске сервера или командой `npm run accounts -- bootstrap`. Повторный
 * запуск ничего не меняет — ни пароль, ни имя, ни роль существующего
 * аккаунта. Пароль нигде не хранится в открытом виде и не пишется в журнал.
 *
 * Тестовые пользователи — только командой CLI: без паролей, с приглашениями;
 * ссылки (если почта не настроена) показываются один раз в терминале.
 */

import { randomBytes } from 'node:crypto';

import { hashPassword, passwordProblem } from './passwords.js';
import { checkEmail, userLabel } from './service.js';

export const DEFAULT_SUPERADMIN = Object.freeze({ email: 'maximka2703@bk.ru', firstName: 'Максим', lastName: '' });

export const TEST_USERS = Object.freeze([
  { email: 'anna.smirnova@medkarta.test', firstName: 'Анна', lastName: 'Смирнова' },
  { email: 'timur.khairullin@medkarta.test', firstName: 'Тимур', lastName: 'Хайруллин' },
  { email: 'elena.kovaleva@medkarta.test', firstName: 'Елена', lastName: 'Ковалёва' },
]);

const newId = () => randomBytes(16).toString('hex');

/**
 * @returns {Promise<{status: 'created'|'exists', user: object}>}
 */
export const bootstrapSuperadmin = async ({ store, email = DEFAULT_SUPERADMIN.email, firstName = DEFAULT_SUPERADMIN.firstName, lastName = DEFAULT_SUPERADMIN.lastName, password, now = () => Date.now() }) => {
  const address = checkEmail(email);
  const existing = store.getUserByEmail(address);
  if (existing) return { status: 'exists', user: existing };
  const problem = passwordProblem(password, { email: address });
  if (problem) throw new Error(`ADMIN_BOOTSTRAP_PASSWORD: ${problem}`);
  const passwordHash = await hashPassword(password);
  const stamp = now();
  const user = store.transaction(() => {
    // Повторная проверка внутри транзакции: два процесса не создадут двух.
    const again = store.getUserByEmail(address);
    if (again) return null;
    const created = store.createUser({ id: newId(), email: address, firstName, lastName, passwordHash, role: 'superadmin', now: stamp });
    store.addAudit({ at: stamp, action: 'account.bootstrap', actorLabel: 'Система', targetId: created.id, targetLabel: userLabel(created), result: 'ok', details: { role: 'superadmin' } });
    return created;
  });
  return user ? { status: 'created', user } : { status: 'exists', user: store.getUserByEmail(address) };
};

/**
 * Три тестовых пользователя — «ожидают активации», как созданные в
 * админ-панели: для каждого выдаётся приглашение (письмом, если настроена
 * почта, иначе ссылкой для ручной передачи). Существующие пропускаются.
 */
export const createTestUsers = async ({ store, invitations, base = null, now = () => Date.now(), users = TEST_USERS }) => {
  const results = [];
  for (const seed of users) {
    if (store.getUserByEmail(seed.email)) {
      results.push({ email: seed.email, status: 'exists' });
      continue;
    }
    const stamp = now();
    const user = store.transaction(() => {
      const created = store.createUser({ id: newId(), email: seed.email, firstName: seed.firstName, lastName: seed.lastName, now: stamp });
      store.addAudit({ at: stamp, action: 'user.create', actorLabel: 'Система (CLI)', targetId: created.id, targetLabel: userLabel(created), result: 'ok', details: { role: 'user', test: true } });
      return created;
    });
    const issued = await invitations.issue({ user, actor: null, source: 'cli', base });
    results.push({ email: seed.email, status: 'created', id: user.id, link: issued.link, delivery: issued.invitation.deliveryStatus, expiresAt: issued.invitation.expiresAt });
  }
  return results;
};
