/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Проверка нового пароля по базе утечек Have I Been Pwned — по
 * k-анонимности: наружу уходят только первые 5 знаков SHA-1 от пароля, сам
 * пароль и его полный хэш сервер не покидают. В ответе — несколько сотен
 * суффиксов, совпадение ищется здесь. Заголовок Add-Padding: ответ дополнен
 * пустыми строками, и по его размеру не понять, какой был префикс.
 *
 * Включается явно: PASSWORD_BREACH_CHECK=hibp. По умолчанию выключено — это
 * внешний запрос с сервера. Если сервис недоступен (тайм-аут 2,5 с, ошибка),
 * пароль не отклоняется: доступность регистрации важнее, а основные меры —
 * длина, словарь и лимиты входа — работают без сети. Сбой пишется в журнал.
 */

import { createHash } from 'node:crypto';

import { normalizePassword } from '../../shared/passwordPolicy.js';
import { logger } from '../observability/safeLogger.js';

const RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2_500;

export const breachCheckMode = (env = process.env) => (env.PASSWORD_BREACH_CHECK === 'hibp' ? 'hibp' : 'off');

/**
 * @param {object} [options]
 * @param {object} [options.env]
 * @param {typeof fetch} [options.fetchImpl] подменяется в тестах
 * @returns {(password: string) => Promise<{breached: boolean, count: number, checked: boolean}>}
 */
export const createBreachChecker = ({ env = process.env, fetchImpl = globalThis.fetch } = {}) => {
  const mode = breachCheckMode(env);
  return async (password) => {
    if (mode !== 'hibp' || typeof fetchImpl !== 'function') return { breached: false, count: 0, checked: false };
    const digest = createHash('sha1').update(normalizePassword(password), 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${RANGE_URL}${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'MedKarta-password-check' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = await response.text();
      for (const line of body.split('\n')) {
        const [hash, count] = line.trim().split(':');
        if (hash === suffix) {
          const times = Number.parseInt(count, 10) || 0;
          // Строки с нулём — дополнение (Add-Padding), а не совпадение.
          if (times > 0) return { breached: true, count: times, checked: true };
        }
      }
      return { breached: false, count: 0, checked: true };
    } catch (error) {
      logger.warn('password.breach_check_failed', { status: 'skipped', error_code: error?.name === 'AbortError' ? 'timeout' : 'error' });
      return { breached: false, count: 0, checked: false };
    } finally {
      clearTimeout(timer);
    }
  };
};

export const BREACHED_MESSAGE = 'Этот пароль встречался в утечках данных — его подбирают первым. Придумайте другой.';
