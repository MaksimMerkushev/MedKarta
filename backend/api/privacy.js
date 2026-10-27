/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Документы и права субъекта персональных данных.
 *
 * Публично (без входа):
 *   GET  /api/legal                      действующие редакции документов и их история
 *   GET  /api/legal/:document            текст действующей редакции (?version= — прежней)
 *
 * Вошедшему пользователю (только свои данные; id — из сессии):
 *   GET  /api/privacy                    что принято и когда, согласия, обращения, сведения об обработке
 *   POST /api/privacy/accept             принять действующие редакции ({documents: {terms, privacy_policy}})
 *   POST /api/privacy/consents/:purpose  {action: 'grant'|'withdraw', version} — согласия, основанные на согласии
 *   GET  /api/privacy/export             все свои данные в JSON (со свежим подтверждением личности)
 *   GET  /api/privacy/requests           свои обращения
 *   POST /api/privacy/requests           новое обращение {type, message}
 *
 * Изменяющие запросы — только JSON со своего Origin; выгрузка — только со
 * своей страницы (Sec-Fetch-Site), как экспорт в админ-панели.
 */

import { CONSENT_PURPOSES, LEGAL_DOCUMENT_KEYS, LEGAL_DOCUMENTS, PRIVACY_REQUEST_TYPES } from '../../shared/legal.js';
import { respondJson } from '../http/request.js';
import { createRateLimiter, getClientIp } from '../http/rateLimit.js';
import { createRouter } from '../http/router.js';
import { getLegalDocuments } from '../legal/documents.js';
import { PROCESSING_REGISTRY, PROCESSING_REGISTRY_VERSION } from '../legal/processing.js';
import { getAccountContext } from './accountContext.js';
import { isTrustedWrite, pathOf, queryOf, readJsonObject, requireFresh, requireSession, sendError } from './accountHttp.js';

export const LEGAL_PREFIX = '/api/legal';
export const PRIVACY_PREFIX = '/api/privacy';

const MAX_BODY_BYTES = 8 * 1024;
// Документы открывают при входе и регистрации — для зала на одном Wi-Fi лимит умножается из админ-панели.
const defaultLimit = createRateLimiter({ maxPerIp: 120, maxPerInstance: Number.POSITIVE_INFINITY, scaled: true });

const route = createRouter([
  ['GET', '/api/legal', 'documents'],
  ['GET', '/api/legal/:document', 'document'],
  ['GET', '/api/privacy', 'overview'],
  ['POST', '/api/privacy/accept', 'accept'],
  ['POST', '/api/privacy/consents/:purpose', 'consent'],
  ['GET', '/api/privacy/export', 'export'],
  ['GET', '/api/privacy/requests', 'requests'],
  ['POST', '/api/privacy/requests', 'createRequest'],
]);

const PUBLIC_OPERATIONS = new Set(['documents', 'document']);
const WITH_BODY = new Set(['accept', 'consent', 'createRequest']);

const documentView = (doc, { text = false } = {}) => ({
  key: doc.key,
  title: doc.title,
  slug: doc.slug,
  version: doc.version,
  publishedAt: doc.publishedAt,
  sha256: doc.sha256,
  draft: doc.draft,
  status: doc.status,
  ...(text ? { text: doc.text } : {}),
});

/** Согласия, которые человек может дать или отозвать сам (сейчас таких нет — см. shared/legal.js). */
const offeredConsents = (purposes) => Object.entries(purposes)
  .filter(([, purpose]) => purpose.kind === 'consent' && purpose.offered)
  .map(([key, purpose]) => ({ purpose: key, label: purpose.label, document: purpose.document }));

export const createPrivacyHandler = ({ getContext = getAccountContext, getDocuments = getLegalDocuments, limit = defaultLimit } = {}) =>
  async function privacyHandler(req, res) {
    const url = req.originalUrl || req.url;
    const match = route(req.method, pathOf(url));
    if (!match.operation) {
      if (match.allow) res.setHeader('Allow', match.allow.join(', '));
      respondJson(res, match.status, { error: match.status === 405 ? 'Метод не поддерживается.' : 'Not found' });
      return;
    }
    const { operation, params } = match;
    const allowed = limit(getClientIp(req));
    if (!allowed.allowed) {
      res.setHeader('Retry-After', String(allowed.retryAfterSeconds));
      respondJson(res, 429, { error: 'Слишком много запросов. Подождите немного.', code: 'rate_limited' });
      return;
    }
    if (req.method !== 'GET' && !isTrustedWrite(req)) {
      respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
      return;
    }

    try {
      if (PUBLIC_OPERATIONS.has(operation)) {
        const documents = getDocuments();
        if (operation === 'documents') {
          res.setHeader('Cache-Control', 'no-cache');
          respondJson(res, 200, { documents: documents.list(), readiness: documents.readiness() });
          return;
        }
        const key = LEGAL_DOCUMENT_KEYS.find((item) => item === params.document || LEGAL_DOCUMENTS[item].slug === params.document);
        const version = queryOf(url).version;
        const doc = key ? (version ? documents.get(key, version) : documents.current(key)) : null;
        if (!doc) {
          respondJson(res, 404, { error: 'Документ не найден.', code: 'not_found' });
          return;
        }
        res.setHeader('Cache-Control', version ? 'public, max-age=86400' : 'no-cache');
        respondJson(res, 200, { document: documentView(doc, { text: true }), history: documents.history(key) });
        return;
      }

      // Выгрузка — переход с чужого сайта не должен скачивать данные (SameSite=Lax пропускает GET-навигацию).
      const site = req.headers['sec-fetch-site'];
      if (req.method === 'GET' && site && site !== 'same-origin' && site !== 'none') {
        respondJson(res, 403, { error: 'Запрос отклонён.', code: 'csrf' });
        return;
      }

      const context = await getContext();
      if (!context?.consents) {
        respondJson(res, 503, { error: 'Личный кабинет сейчас недоступен.', code: 'accounts_unavailable' });
        return;
      }
      const auth = requireSession(req, res, context.accounts);
      if (!auth) return;
      const { user } = auth;
      const body = WITH_BODY.has(operation) ? await readJsonObject(req, MAX_BODY_BYTES) : {};
      const { consents, privacy } = context;

      switch (operation) {
        case 'overview': {
          respondJson(res, 200, {
            pending: consents.pendingFor(user),
            state: consents.stateOf(user.id),
            history: consents.history(user.id),
            consents: offeredConsents(consents.purposes()),
            requests: privacy.listMine(user),
            requestTypes: Object.entries(PRIVACY_REQUEST_TYPES).map(([key, item]) => ({ key, ...item })),
            processing: { version: PROCESSING_REGISTRY_VERSION, purposes: PROCESSING_REGISTRY },
            canDeleteAccount: user.role === 'user',
          });
          return;
        }
        case 'accept': {
          const extra = Object.keys(body).filter((key) => key !== 'documents');
          if (extra.length > 0) {
            respondJson(res, 400, { error: 'Лишние поля в запросе.', code: 'unexpected_field' });
            return;
          }
          const versions = body.documents && typeof body.documents === 'object' ? body.documents : {};
          const recorded = consents.acceptCurrent(user, versions, { method: 'documents_update' });
          respondJson(res, 200, { recorded: recorded.length, pending: consents.pendingFor(user), history: consents.history(user.id) });
          return;
        }
        case 'consent': {
          const extra = Object.keys(body).filter((key) => !['action', 'version'].includes(key));
          if (extra.length > 0 || !Object.hasOwn(CONSENT_PURPOSES, params.purpose)) {
            respondJson(res, extra.length > 0 ? 400 : 404, { error: extra.length > 0 ? 'Лишние поля в запросе.' : 'Такой цели обработки нет.', code: extra.length > 0 ? 'unexpected_field' : 'unknown_purpose' });
            return;
          }
          if (body.action === 'grant') consents.grant(user.id, params.purpose, body.version, { method: 'profile' });
          else if (body.action === 'withdraw') consents.withdraw(user.id, params.purpose, { method: 'profile' });
          else {
            respondJson(res, 400, { error: 'Действие: grant или withdraw.', code: 'bad_request' });
            return;
          }
          respondJson(res, 200, { state: consents.stateOf(user.id), history: consents.history(user.id) });
          return;
        }
        case 'export': {
          // Все свои данные одним файлом — только со свежим подтверждением личности (как смена email).
          if (!requireFresh(res, auth, context.accounts)) return;
          const data = await privacy.exportFor(user);
          context.store.addAuthEvent({ at: Date.now(), type: 'data_export', userId: user.id, sessionId: auth.session.publicId });
          const stamp = new Date().toISOString().slice(0, 10);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="medkarta-my-data-${stamp}.json"`);
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end(JSON.stringify(data, null, 2));
          return;
        }
        case 'requests':
          respondJson(res, 200, { items: privacy.listMine(user) });
          return;
        case 'createRequest':
          respondJson(res, 201, { request: privacy.create(user, body) });
          return;
        default:
          respondJson(res, 404, { error: 'Not found' });
      }
    } catch (error) {
      sendError(res, error, 'privacy.request_failed');
    }
  };

export default createPrivacyHandler();
