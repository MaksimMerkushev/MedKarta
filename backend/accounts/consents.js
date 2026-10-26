/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Журнал согласий и принятия документов (ст. 9 152-ФЗ: оператор обязан
 * доказать, что согласие получено, либо что есть иное основание).
 *
 * Что фиксируется: id аккаунта, цель, вид (принятие соглашения,
 * ознакомление с политикой, согласие), действие (дано, отозвано, закрыто при
 * удалении аккаунта), редакция документа и SHA-256 её текста, способ и
 * время. Email, IP и User-Agent в журнал не пишутся: для доказательства
 * достаточно связи с аккаунтом и редакцией документа.
 *
 * Защита от незаметного изменения:
 *   - в базе — только добавление (UPDATE запрещён триггером, удаление —
 *     только через 3 года после последней записи удалённого аккаунта);
 *   - API для правки нет ни у пользователя, ни у сотрудников;
 *   - записи одного человека сцеплены хэшами: hash = SHA-256(prev_hash +
 *     содержимое). Подмена, вставка или удаление записи из середины видны
 *     при проверке (verify). Тот, у кого есть доступ к файлу базы на
 *     сервере, может переписать цепочку целиком — поэтому «отпечаток»
 *     журнала (anchor) стоит периодически сохранять вне сервера
 *     (docs/privacy/09-security-measures.md).
 */

import { createHash, randomBytes } from 'node:crypto';

import { CONSENT_PURPOSES, SIGNUP_PURPOSES } from '../../shared/legal.js';
import { fail } from './service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Срок хранения записей после удаления аккаунта (совпадает с триггером в схеме 7). */
export const CONSENT_RETENTION_MS = 3 * 365 * DAY_MS;

const METHODS = new Set([
  'registration_form', 'activation_form', 'documents_update', 'profile', 'account_deleted', 'admin_deleted', 'cli', 'migration',
]);


const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
export const genesisHash = (userId) => sha256(`medkarta:consent:genesis:${userId}`);

/** Содержимое записи в фиксированном порядке — то, что защищает хэш. */
const canonical = (record) => JSON.stringify([
  record.id, record.userId, record.purpose, record.kind, record.action, record.document ?? null, record.version ?? null,
  record.documentHash ?? null, record.method, record.at,
]);
export const recordHash = (prevHash, record) => sha256(`${prevHash}\n${canonical(record)}`);

/**
 * @param {object} deps
 * @param {object} deps.store хранилище (sqliteStore.js)
 * @param {object} deps.documents редакции документов (backend/legal/documents.js)
 * @param {object} [deps.purposes] цели (по умолчанию shared/legal.js; тесты подставляют свои)
 * @param {() => number} [deps.now]
 */
export const createConsentRegistry = ({ store, documents, purposes = CONSENT_PURPOSES, now = () => Date.now() }) => {
  const purposeOf = (key) => {
    const purpose = Object.hasOwn(purposes, key) ? purposes[key] : null;
    if (!purpose) fail('unknown_purpose', 404, 'Такой цели обработки нет.');
    return purpose;
  };

  const append = (userId, purposeKey, action, { method, version = null }) => {
    const purpose = purposeOf(purposeKey);
    if (!METHODS.has(method)) fail('bad_method', 400, 'Неизвестный способ подтверждения.');
    let doc = null;
    if (purpose.document && action === 'granted') {
      doc = documents.get(purpose.document, version);
      if (!doc) fail('unknown_version', 409, 'Этой редакции документа нет.');
    } else if (purpose.document && version) {
      doc = documents.get(purpose.document, version);
    }
    return store.transaction(() => {
      const last = store.lastConsentRecord(userId);
      const prevHash = last ? last.hash : genesisHash(userId);
      const record = {
        id: randomBytes(12).toString('hex'),
        userId,
        purpose: purposeKey,
        kind: purpose.kind,
        action,
        document: purpose.document || null,
        version: doc ? doc.version : null,
        documentHash: doc ? doc.sha256 : null,
        method,
        at: Math.max(now(), last ? last.at : 0),
      };
      return store.insertConsentRecord({ ...record, prevHash, hash: recordHash(prevHash, record) });
    });
  };

  /** Текущее состояние по каждой цели: последнее действие решает. */
  const stateOf = (userId) => {
    const state = {};
    for (const record of store.listConsentRecords(userId)) {
      state[record.purpose] = {
        status: record.action === 'granted' ? 'granted' : record.action,
        version: record.version,
        documentHash: record.documentHash,
        at: record.at,
        method: record.method,
      };
    }
    return state;
  };

  const registry = {
    purposes: () => purposes,

    /**
     * Принятие при регистрации или активации: соглашение и политика тех
     * редакций, что видел человек. Если пока форма была открыта, вышла новая
     * редакция, — 409 documents_changed: показать новую и спросить снова.
     */
    recordSignup(userId, accepted, { method }) {
      if (!accepted || accepted.acceptTerms !== true) {
        fail('terms_required', 400, 'Чтобы создать аккаунт, примите пользовательское соглашение.');
      }
      const versions = accepted.documents || {};
      for (const key of SIGNUP_PURPOSES) {
        const purpose = purposeOf(key);
        const current = documents.current(purpose.document);
        if (!current) fail('documents_unavailable', 503, 'Документы временно недоступны. Попробуйте позже.');
        if (versions[purpose.document] !== current.version) {
          fail('documents_changed', 409, 'Документы обновились. Ознакомьтесь с новой редакцией и подтвердите снова.', {
            current: { document: purpose.document, version: current.version },
          });
        }
      }
      return SIGNUP_PURPOSES.map((key) => append(userId, key, 'granted', { method, version: versions[purposeOf(key).document] }));
    },

    /** Проверить без записи (до создания аккаунта): те же правила, что у recordSignup. */
    checkSignup(accepted) {
      if (!accepted || accepted.acceptTerms !== true) {
        fail('terms_required', 400, 'Чтобы создать аккаунт, примите пользовательское соглашение.');
      }
      for (const key of SIGNUP_PURPOSES) {
        const purpose = purposeOf(key);
        const current = documents.current(purpose.document);
        if (!current) fail('documents_unavailable', 503, 'Документы временно недоступны. Попробуйте позже.');
        if ((accepted.documents || {})[purpose.document] !== current.version) {
          fail('documents_changed', 409, 'Документы обновились. Ознакомьтесь с новой редакцией и подтвердите снова.', {
            current: { document: purpose.document, version: current.version },
          });
        }
      }
    },

    /**
     * Что аккаунту «Пользователь» нужно принять: соглашение и политика в
     * действующей редакции. Сотрудники работают по внутренним документам
     * оператора (docs/privacy/02-legal-bases.md) — им пусто.
     */
    pendingFor(user) {
      if (!user || user.role !== 'user' || user.demoTemplate) return [];
      const state = stateOf(user.id);
      const pending = [];
      for (const key of SIGNUP_PURPOSES) {
        const purpose = purposeOf(key);
        const current = documents.current(purpose.document);
        if (!current) continue;
        const item = state[key];
        if (!item || item.status !== 'granted' || item.version !== current.version) {
          pending.push({ purpose: key, document: purpose.document, version: current.version, title: current.title, draft: current.draft });
        }
      }
      return pending;
    },

    /** Принять действующие редакции из раздела «Мои данные» (или окна «Документы обновились»). */
    acceptCurrent(user, versions, { method = 'documents_update' } = {}) {
      const pending = registry.pendingFor(user);
      const recorded = [];
      for (const item of pending) {
        if ((versions || {})[item.document] !== item.version) {
          fail('documents_changed', 409, 'Документы обновились. Ознакомьтесь с новой редакцией и подтвердите снова.', {
            current: { document: item.document, version: item.version },
          });
        }
      }
      for (const item of pending) recorded.push(append(user.id, item.purpose, 'granted', { method, version: item.version }));
      return recorded;
    },

    /** Дать согласие по цели, основанной на согласии (только предлагаемые цели). */
    grant(userId, purposeKey, version, { method = 'profile' } = {}) {
      const purpose = purposeOf(purposeKey);
      if (purpose.kind !== 'consent') fail('not_consent', 400, 'Это не согласие.');
      if (!purpose.offered) fail('not_offered', 403, 'Это согласие сейчас не принимается.');
      if (purpose.writtenForm) fail('written_form_required', 403, 'Для этой цели нужно согласие в письменной форме; отметка на сайте его не заменяет.');
      const current = purpose.document ? documents.current(purpose.document) : null;
      if (purpose.document && (!current || current.version !== version)) {
        fail('documents_changed', 409, 'Текст согласия обновился. Ознакомьтесь с новой редакцией.', {
          current: current ? { document: purpose.document, version: current.version } : null,
        });
      }
      return append(userId, purposeKey, 'granted', { method, version });
    },

    /**
     * Отозвать согласие (ч. 2 ст. 9): обработка по этой цели прекращается
     * сразу. Обработка по другим основаниям (договор — аккаунт и вход)
     * продолжается: отзыв одного согласия не удаляет аккаунт.
     */
    withdraw(userId, purposeKey, { method = 'profile' } = {}) {
      const purpose = purposeOf(purposeKey);
      if (purpose.kind !== 'consent') fail('not_consent', 400, 'Принятие соглашения не отзывается: чтобы расторгнуть его, удалите аккаунт.');
      const state = stateOf(userId)[purposeKey];
      if (!state || state.status !== 'granted') fail('not_granted', 409, 'Согласие не было дано или уже отозвано.');
      return append(userId, purposeKey, 'withdrawn', { method, version: state.version });
    },

    /**
     * Можно ли сейчас обрабатывать данные по цели, основанной на согласии:
     * последнее действие — «дано» и редакция документа совпадает с той, на
     * которую было получено согласие. После отзыва — нет, пока человек не
     * даст согласие заново.
     */
    allows(userId, purposeKey) {
      const purpose = purposeOf(purposeKey);
      const state = stateOf(userId)[purposeKey];
      if (!state || state.status !== 'granted') return false;
      if (purpose.kind !== 'consent') return true;
      return !purpose.writtenForm;
    },

    /** Удаление аккаунта: по всем действующим целям — запись «закрыто». */
    closeAll(userId, { method = 'account_deleted' } = {}) {
      const state = stateOf(userId);
      return Object.entries(state)
        .filter(([, item]) => item.status === 'granted')
        .map(([purposeKey, item]) => append(userId, purposeKey, 'closed', { method, version: item.version }));
    },

    stateOf,

    /** История для самого человека и для выгрузки данных. */
    history(userId) {
      return store.listConsentRecords(userId).map((record) => ({
        id: record.id,
        purpose: record.purpose,
        kind: record.kind,
        action: record.action,
        document: record.document,
        version: record.version,
        documentHash: record.documentHash,
        method: record.method,
        at: new Date(record.at).toISOString(),
      }));
    },

    /**
     * Проверка всех цепочек: хэш каждой записи и сцепление с предыдущей
     * записью того же человека. broken — id записей, на которых цепочка
     * рвётся (после них доверять журналу этого человека нельзя).
     *
     * anchor — отпечаток журнала на момент asOf (по умолчанию — сейчас):
     * хэш последних записей каждого человека, сделанных не позже asOf.
     * Сохранённую вне сервера пару «время, отпечаток» можно позже сверить:
     * verify({asOf: то же время}) должен дать тот же отпечаток, если записи
     * до этого времени не меняли (удаление по сроку хранения его меняет).
     */
    verify({ asOf = null } = {}) {
      const heads = new Map();
      const anchorHeads = new Map();
      const broken = [];
      let records = 0;
      const limit = asOf === null ? Number.POSITIVE_INFINITY : asOf;
      for (const record of store.allConsentRecords()) {
        records += 1;
        const expectedPrev = heads.has(record.userId) ? heads.get(record.userId) : genesisHash(record.userId);
        if (record.prevHash !== expectedPrev || recordHash(record.prevHash, record) !== record.hash) broken.push(record.id);
        heads.set(record.userId, record.hash);
        if (record.at <= limit) anchorHeads.set(record.userId, record.hash);
      }
      const anchor = sha256([...anchorHeads.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([user, hash]) => `${user}:${hash}`).join('\n'));
      return { ok: broken.length === 0, records, subjects: heads.size, broken, anchor, asOf: asOf === null ? now() : asOf };
    },

    /** Записи удалённых аккаунтов старше срока хранения (3 года после последней записи). */
    purge: () => store.purgeConsentRecords(now() - CONSENT_RETENTION_MS),
  };
  return Object.freeze(registry);
};
