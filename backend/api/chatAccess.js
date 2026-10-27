/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ассистент — только для вошедших в личный кабинет (CHAT_REQUIRES_ACCOUNT=off
 * или настройка assistant.requiresAccount=false открывают его гостям).
 *
 * Сессия здесь НЕ читается. Запрос к ассистенту может содержать сведения о
 * здоровье, и связывать его с аккаунтом нельзя (ст. 10 152-ФЗ,
 * docs/privacy/04-health-data.md). Вместо сессии проверяется пропуск
 * (cookie mk_ai): вошедший получает его отдельным запросом
 * POST /api/account/assistant-pass, а в пропуске нет id аккаунта — только
 * срок и подпись (api/assistantPass.js). Нет пропуска — 401
 * assistant_pass_required: интерфейс запросит пропуск и повторит запрос,
 * а гостя попросит войти.
 *
 * Проверка стоит перед обработчиком /api/chat, а не внутри него: сервер и
 * dev-сервер Vite подключают её одинаково (server.js, vite.config.js).
 */

import { chatRequiresAccount, getDefaultAccountService } from './account.js';
import { getAccountContext } from './accountContext.js';
import { isTrustedWrite, parseCookies } from './accountHttp.js';
import { ASSISTANT_PASS_COOKIE } from './assistantPass.js';
import { respondJson } from '../http/request.js';
import { logger } from '../observability/safeLogger.js';

const passOf = (req) => {
  const header = String(req.headers.cookie || '');
  // Две cookie пропуска — одну подбросили: не угадываем.
  if (header.split(';').filter((part) => part.trim().startsWith(`${ASSISTANT_PASS_COOKIE}=`)).length !== 1) return '';
  return parseCookies(header)[ASSISTANT_PASS_COOKIE] || '';
};

/**
 * true — запрос можно передать ассистенту; иначе ответ уже отправлен:
 * 403 csrf (не JSON или с чужого сайта), 401 assistant_pass_required (нет
 * действующего пропуска), 503 accounts_unavailable или assistant_disabled
 * (выключен в настройках админ-панели).
 */
export const createChatAccessGate = ({
  getService = getDefaultAccountService,
  isRequired = chatRequiresAccount,
  getPass = async () => (await getAccountContext())?.assistantPass || null,
} = {}) =>
  async function chatAccessGate(req, res) {
    // OPTIONS и неверный метод обработчик чата отклоняет сам.
    if (req.method !== 'POST') return true;
    /*
     * Та же защита от CSRF, что у кабинета: только JSON со своей страницы.
     * Cookie сессии и так не уходит с чужого сайта (SameSite=Lax), но
     * запрос с текстом жалобы не должен приниматься из формы чужой страницы.
     */
    if (!isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
      return false;
    }

    let service;
    try {
      service = await getService();
    } catch (error) {
      logger.error('chat.account_lookup_failed', error);
      service = null;
    }
    try {
      if (service?.settings && service.settings.get('assistant.enabled') === false) {
        respondJson(res, 503, { error: 'Ассистент временно отключён администратором.', code: 'assistant_disabled' });
        return false;
      }
    } catch (error) {
      logger.error('chat.settings_failed', error);
    }
    if (!isRequired(service)) return true;
    if (!service) {
      respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен, поэтому ассистент тоже.', code: 'accounts_unavailable' });
      return false;
    }

    let pass = null;
    try {
      pass = await getPass();
    } catch (error) {
      logger.error('chat.pass_unavailable', error);
    }
    if (!pass) {
      respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен, поэтому ассистент тоже.', code: 'accounts_unavailable' });
      return false;
    }
    if (!pass.verify(passOf(req))) {
      respondJson(res, 401, { error: 'Ассистент доступен после входа в личный кабинет.', code: 'assistant_pass_required' });
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
