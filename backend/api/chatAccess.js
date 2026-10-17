/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ассистент — только для вошедших в личный кабинет (CHAT_REQUIRES_ACCOUNT=off
 * открывает его гостям). Проверяется лишь факт входа: id, email, имя и
 * программа ДМС в конвейер ассистента и к модели не попадают.
 *
 * Проверка стоит перед обработчиком /api/chat, а не внутри него: сервер и
 * dev-сервер Vite подключают её одинаково (server.js, vite.config.js).
 */

import { chatRequiresAccount, getDefaultAccountService, parseCookies, SESSION_COOKIE } from './account.js';
import { respondJson } from '../http/request.js';
import { logger } from '../observability/safeLogger.js';

/**
 * true — запрос можно передать ассистенту; иначе ответ уже отправлен
 * (401 login_required или 503 accounts_unavailable).
 */
export const createChatAccessGate = ({ getService = getDefaultAccountService, isRequired = chatRequiresAccount } = {}) =>
  async function chatAccessGate(req, res) {
    // OPTIONS и неверный метод обработчик чата отклоняет сам.
    if (req.method !== 'POST' || !isRequired()) return true;

    let service;
    try {
      service = await getService();
    } catch (error) {
      logger.error('chat.account_lookup_failed', error);
      service = null;
    }
    if (!service) {
      respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен, поэтому ассистент тоже.', code: 'accounts_unavailable' });
      return false;
    }

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    let user = null;
    try {
      user = token ? service.sessionUser(token) : null;
    } catch (error) {
      logger.error('chat.account_lookup_failed', error);
    }
    if (!user) {
      respondJson(res, 401, { error: 'Ассистент доступен после входа в личный кабинет.', code: 'login_required' });
      return false;
    }
    return true;
  };

export const chatAccessGate = createChatAccessGate();

/** Обработчик /api/chat за проверкой входа. */
export const withChatAccess = (handler, gate = chatAccessGate) =>
  async function gatedChatHandler(req, res) {
    if (await gate(req, res)) await handler(req, res);
  };
