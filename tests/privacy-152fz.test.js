/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Требования 152-ФЗ, которые проверяются кодом (docs/privacy/README.md):
 * документы и их редакции, раздельное принятие соглашения и политики, отказ
 * без отметки, журнал согласий (только добавление, цепочка хэшей), отзыв
 * согласия и прекращение обработки, удаление аккаунта и следы в почте и
 * регистрациях, обращения субъектов и сроки, выгрузка без секретов, права
 * сотрудников, сведения о здоровье — только локально и не в журналах,
 * пропуск к ассистенту без id аккаунта, хранилище токенов вне РФ,
 * шифрование резервных копий, миграция 6 → 7.
 *
 * Данные — вымышленные. База — SQLite в памяти или во временном файле;
 * рабочую базу тесты не открывают.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createConsentRegistry, genesisHash } from '../backend/accounts/consents.js';
import { createDelivery } from '../backend/accounts/delivery.js';
import { createErasureLog } from '../backend/accounts/erasureLog.js';
import { decryptBackup, encryptBackup, isEncryptedBackup } from '../backend/accounts/backupCrypto.js';
import { hashPassword } from '../backend/accounts/passwords.js';
import { deadlineAfter, PRIVACY_DEADLINES } from '../backend/accounts/privacyRequests.js';
import { legalDraftsAllowed } from '../backend/accounts/registration.js';
import { ACCOUNT_MIGRATIONS, createSqliteAccountStore, loadSqlite } from '../backend/accounts/sqliteStore.js';
import { createAccountContext } from '../backend/api/accountContext.js';
import { createAssistantPass } from '../backend/api/assistantPass.js';
import { createBookingStore, OWNER_RETENTION_DAYS } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createLegalDocuments, sha256Text } from '../backend/legal/documents.js';
import { PROCESSING_REGISTRY } from '../backend/legal/processing.js';
import { renderMail } from '../backend/mail/templates.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { GATEWAY_DECISION } from '../backend/privacy/models.js';
import { medicalTextModeFromEnv, POLICY } from '../backend/privacy/policies.js';
import { createMemoryStore, createStoreFromEnv } from '../backend/storage/tokenVault.js';
import { CONSENT_PURPOSES, LEGAL_PLACEHOLDER, SIGNUP_PURPOSES } from '../shared/legal.js';
import { browserFor, capture, linkIn, softAuthenticator, startAuthServer, TEST_ORIGIN, tokenOfLink } from './helpers/authKit.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const skip = !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEGAL_DIR = path.join(ROOT, 'legal');
const ROOT_EMAIL = 'root@medkarta.test';
const ROOT_PASSWORD = 'Корневой пароль для тестов 2026';
const USER_PASSWORD = 'Зелёный чай без сахара по утрам';
const ENV = { SMTP_FROM: 'МедКарта <noreply@medkarta.test>', PUBLIC_BASE_URL: TEST_ORIGIN, LEGAL_DRAFTS_ALLOWED: 'on' };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Копия legal/ во временной папке — чтобы подменять тексты и редакции, не трогая репозиторий. */
const copyLegal = () => {
  const dir = tempDir('mk-legal-');
  fs.cpSync(LEGAL_DIR, dir, { recursive: true });
  return dir;
};

const makeContext = ({ file = ':memory:', documents = createLegalDocuments(), env = ENV, outbox = [], erasureLog = createErasureLog(), demoBookings, now } = {}) => {
  const delivery = createDelivery({ env, send: capture(outbox) });
  const context = createAccountContext({
    store: createSqliteAccountStore({ DatabaseSync, file }),
    delivery,
    env,
    mfaKey: randomBytes(32),
    registrationMode: 'open',
    breachCheck: async () => ({ breached: false }),
    onAccountDeleted: async () => {},
    systemInfo: async () => ({}),
    documents,
    erasureLog,
    ...(demoBookings ? { demoBookings } : {}),
    ...(now ? { now } : {}),
  });
  return { context, outbox };
};

const settle = async (context) => {
  await wait(30);
  await context.mailer.drain();
};
const lastMailTo = (outbox, to) => [...outbox].reverse().find((mail) => mail.to === to) || null;
const accepted = (context) => ({
  acceptTerms: true,
  documents: { terms: context.documents.current('terms').version, privacy_policy: context.documents.current('privacy_policy').version },
});

/** Регистрация по ссылке из письма до формы пароля; complete(body) — отправить форму. */
const openRegistration = async (context, outbox, base, email) => {
  const tab = browserFor(base);
  const response = await tab.call('/api/auth/register', { method: 'POST', body: { email } });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  await settle(context);
  const token = tokenOfLink(linkIn(lastMailTo(outbox, email).text));
  const start = await tab.call('/api/auth/register/start', { method: 'POST', body: { token } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return {
    tab,
    start,
    complete: (body) => tab.call('/api/auth/register/complete', { method: 'POST', body: { password: USER_PASSWORD, ...body } }),
  };
};

const registerUser = async (context, outbox, base, email) => {
  const flow = await openRegistration(context, outbox, base, email);
  const done = await flow.complete(accepted(context));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  flow.tab.password = USER_PASSWORD;
  return { tab: flow.tab, user: context.store.getUserByEmail(email) };
};

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: документы и редакции', () => {
  it('редакции сверяются с манифестом по SHA-256; проект с метками не считается готовым', () => {
    const documents = createLegalDocuments();
    assert.deepEqual(documents.problems(), [], 'файлы совпадают с манифестом');
    for (const key of ['privacy_policy', 'terms', 'health_consent']) {
      const doc = documents.current(key);
      assert.ok(doc, key);
      assert.equal(doc.sha256, sha256Text(doc.text));
    }
    // Реквизиты оператора не заполнены — документы честно помечены проектом.
    assert.equal(documents.current('terms').draft, true);
    assert.ok(documents.current('privacy_policy').text.includes(LEGAL_PLACEHOLDER));
    assert.deepEqual(documents.readiness(), { ready: false, missing: [], drafts: ['privacy_policy', 'terms'] });
    // Согласие на сведения о здоровье — проект письменной формы, на сайте не запрашивается.
    assert.equal(documents.current('health_consent').status, 'not_offered');
    assert.equal(CONSENT_PURPOSES.health_data.offered, false);
    assert.equal(CONSENT_PURPOSES.health_data.writtenForm, true);
  });

  it('изменённый после публикации текст не выдаётся и не принимается', () => {
    const dir = copyLegal();
    try {
      const file = path.join(dir, 'terms', `${createLegalDocuments().current('terms').version}.md`);
      fs.appendFileSync(file, '\nПриписка задним числом.\n');
      const documents = createLegalDocuments({ dir });
      assert.equal(documents.current('terms'), null, 'подменённая редакция не действует');
      assert.ok(documents.problems().some((item) => item.key === 'terms' && item.problem === 'hash_mismatch'));
      assert.deepEqual(documents.readiness().missing, ['terms']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('пока в документах метки, регистрация закрыта; LEGAL_DRAFTS_ALLOWED — только вне production', () => {
    assert.equal(legalDraftsAllowed({}), false);
    assert.equal(legalDraftsAllowed({ LEGAL_DRAFTS_ALLOWED: 'on' }), true);
    assert.equal(legalDraftsAllowed({ LEGAL_DRAFTS_ALLOWED: 'on', NODE_ENV: 'production' }), false);
    assert.equal(legalDraftsAllowed({ LEGAL_DRAFTS_ALLOWED: 'on', APP_ENV: 'production' }), false);
    if (!DatabaseSync) return;
    const closed = makeContext({ env: { ...ENV, LEGAL_DRAFTS_ALLOWED: '' } }).context;
    assert.equal(closed.registration.closedReason, 'legal_documents_incomplete');
    const prod = makeContext({ env: { ...ENV, NODE_ENV: 'production' } }).context;
    assert.equal(prod.registration.closedReason, 'legal_documents_incomplete');
    const dev = makeContext().context;
    assert.equal(dev.registration.closedReason, null);
  });

  it('реестр обработки: у каждой цели — основание, срок и получатели; сведений о здоровье нет среди целей', () => {
    assert.ok(PROCESSING_REGISTRY.length >= 6);
    for (const entry of PROCESSING_REGISTRY) {
      for (const field of ['id', 'purpose', 'data', 'basis', 'retention', 'recipients']) assert.ok(entry[field], `${entry.id}: ${field}`);
    }
    const account = PROCESSING_REGISTRY.find((entry) => entry.id === 'account');
    assert.match(account.basis, /п\. 5 ч\. 1 ст\. 6/, 'аккаунт — исполнение договора, а не согласие');
    const assistant = PROCESSING_REGISTRY.find((entry) => entry.id === 'assistant');
    assert.match(assistant.basis, /без связи с аккаунтом/);
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: регистрация и журнал согласий', { skip }, () => {
  let context;
  let outbox;
  let server;
  let base;

  before(async () => {
    ({ context, outbox } = makeContext());
    ({ server, base } = await startAuthServer(context));
  });
  after(() => server?.close());

  it('форма показывает действующие редакции; без отметки или с устаревшей редакцией аккаунт не создаётся', async () => {
    const flow = await openRegistration(context, outbox, base, 'no.terms@medkarta.test');
    const shown = flow.start.body.context.documents;
    assert.equal(shown.terms.version, context.documents.current('terms').version);
    assert.equal(shown.privacy_policy.version, context.documents.current('privacy_policy').version);
    assert.equal(shown.terms.draft, true, 'форма знает, что документ — проект');

    for (const body of [{}, { acceptTerms: false, documents: accepted(context).documents }, { acceptTerms: 'yes', documents: accepted(context).documents }]) {
      const refused = await flow.complete(body);
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.equal(refused.body.code, 'terms_required');
    }
    const stale = await flow.complete({ acceptTerms: true, documents: { terms: '2020-01-01', privacy_policy: accepted(context).documents.privacy_policy } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'documents_changed');
    assert.equal(stale.body.current.document, 'terms');
    assert.equal(context.store.getUserByEmail('no.terms@medkarta.test'), null, 'аккаунт не создан');
    assert.equal(context.store.countConsentRecords(), 0, 'и записей в журнале нет');
  });

  it('принятие соглашения и ознакомление с политикой — две отдельные записи; согласий «на всё» не появляется', async () => {
    const { user } = await registerUser(context, outbox, base, 'olga.consent@medkarta.test');
    const history = context.consents.history(user.id);
    assert.deepEqual(history.map((item) => [item.purpose, item.kind, item.action]), [
      ['terms', 'acceptance', 'granted'],
      ['privacy_policy', 'acknowledgement', 'granted'],
    ]);
    assert.deepEqual(SIGNUP_PURPOSES, ['terms', 'privacy_policy']);
    assert.equal(history.some((item) => item.kind === 'consent'), false, 'при регистрации согласие не собирается');
    for (const item of history) {
      const doc = context.documents.get(item.document, item.version);
      assert.equal(item.documentHash, doc.sha256, 'хэш принятого текста');
      assert.equal(item.method, 'registration_form');
      assert.ok(Date.parse(item.at) > 0);
    }
  });

  it('в журнале нет email, IP и User-Agent — только аккаунт, цель, редакция, хэш, способ и время', () => {
    const record = context.store.allConsentRecords()[0];
    assert.deepEqual(Object.keys(record).sort(), ['action', 'at', 'document', 'documentHash', 'hash', 'id', 'kind', 'method', 'prevHash', 'purpose', 'seq', 'userId', 'version'].sort());
    assert.equal(JSON.stringify(context.store.allConsentRecords()).includes('@'), false);
  });

  it('журнал: изменить запись нельзя, удалить при живом аккаунте нельзя, цепочка хэшей и отпечаток сходятся', async () => {
    const verified = context.consents.verify();
    assert.equal(verified.ok, true);
    assert.ok(verified.records >= 2);
    assert.match(verified.anchor, /^[a-f0-9]{64}$/);
    const [first] = context.store.allConsentRecords();
    assert.equal(first.prevHash, genesisHash(first.userId));
    const file = path.join(tempDir('mk-consent-'), 'accounts.sqlite');
    const local = makeContext({ file }).context;
    const userId = randomBytes(16).toString('hex');
    local.store.createUser({ id: userId, email: 'chain@medkarta.test', firstName: 'Цепь', passwordHash: 'x', now: Date.now() });
    local.consents.recordSignup(userId, accepted(local), { method: 'registration_form' });
    const savedAnchor = local.consents.verify();
    // Новые записи после сохранения отпечатка не меняют отпечаток «на то время».
    const later = randomBytes(16).toString('hex');
    local.store.createUser({ id: later, email: 'later@medkarta.test', firstName: 'Позже', passwordHash: 'x', now: Date.now() });
    await wait(5);
    local.consents.recordSignup(later, accepted(local), { method: 'registration_form' });
    assert.equal(local.consents.verify({ asOf: savedAnchor.asOf }).anchor, savedAnchor.anchor);
    assert.notEqual(local.consents.verify().anchor, savedAnchor.anchor);
    local.store.close();
    const db = new DatabaseSync(file);
    try {
      const columns = db.prepare('PRAGMA table_info(consent_log)').all().map((column) => column.name).sort();
      assert.deepEqual(columns, ['action', 'at', 'document', 'document_hash', 'hash', 'id', 'kind', 'method', 'prev_hash', 'purpose', 'seq', 'user_id', 'version'].sort(), 'ни email, ни IP, ни User-Agent');
      assert.throws(() => db.prepare("UPDATE consent_log SET version = '2099-01-01'").run(), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM consent_log').run(), /retention/);
      // Кто-то с доступом к файлу снял защиту и «поправил» запись — проверка цепочки это видит.
      db.exec('DROP TRIGGER consent_log_append_only');
      db.prepare("UPDATE consent_log SET version = '2099-01-01' WHERE purpose = 'terms' AND user_id = ?").run(userId);
    } finally {
      db.close();
    }
    let reopened = makeContext({ file }).context;
    const tampered = reopened.consents.verify();
    assert.equal(tampered.ok, false);
    assert.equal(tampered.broken.length, 1);
    reopened.store.close();

    // Тот же человек пересчитал всю цепочку: цепочка снова «цела», но отпечаток, сохранённый вне сервера, не сходится.
    const { recordHash } = await import('../backend/accounts/consents.js');
    const rewrite = new DatabaseSync(file);
    try {
      const rows = rewrite.prepare('SELECT * FROM consent_log WHERE user_id = ? ORDER BY seq').all(userId);
      let prev = genesisHash(userId);
      for (const row of rows) {
        const record = { id: row.id, userId: row.user_id, purpose: row.purpose, kind: row.kind, action: row.action, document: row.document, version: row.version, documentHash: row.document_hash, method: row.method, at: row.at };
        const hash = recordHash(prev, record);
        rewrite.prepare('UPDATE consent_log SET prev_hash = ?, hash = ? WHERE seq = ?').run(prev, hash, row.seq);
        prev = hash;
      }
    } finally {
      rewrite.close();
    }
    reopened = makeContext({ file }).context;
    assert.equal(reopened.consents.verify().ok, true, 'переписанная целиком цепочка внутренне согласована');
    assert.notEqual(reopened.consents.verify({ asOf: savedAnchor.asOf }).anchor, savedAnchor.anchor, 'но отпечаток на сохранённое время другой');
    reopened.store.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('согласие на сведения о здоровье веб-отметкой не принимается; принятие соглашения не «отзывается»', async () => {
    const { tab } = await registerUser(context, outbox, base, 'health.web@medkarta.test');
    const health = await tab.call('/api/privacy/consents/health_data', { method: 'POST', body: { action: 'grant', version: context.documents.current('health_consent').version } });
    assert.equal(health.status, 403);
    assert.ok(['not_offered', 'written_form_required'].includes(health.body.code));
    const terms = await tab.call('/api/privacy/consents/terms', { method: 'POST', body: { action: 'withdraw' } });
    assert.equal(terms.status, 400);
    assert.equal(terms.body.code, 'not_consent');
    const overview = await tab.call('/api/privacy');
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.consents, [], 'сейчас сайт не собирает ни одного согласия');
    assert.deepEqual(overview.body.pending, []);
  });

  it('отзыв согласия: обработка по цели прекращается, договорная — продолжается; повторно — снова только по согласию', () => {
    // Цель на согласии — тестовая: в продукте таких сейчас нет (shared/legal.js).
    const purposes = {
      ...CONSENT_PURPOSES,
      newsletter_test: { label: 'Тестовая рассылка', kind: 'consent', offered: true, writtenForm: false, document: null },
    };
    const registry = createConsentRegistry({ store: context.store, documents: context.documents, purposes });
    const user = context.store.getUserByEmail('olga.consent@medkarta.test');
    const processed = [];
    const sendNewsletter = () => {
      if (registry.allows(user.id, 'newsletter_test')) processed.push(user.id);
    };
    sendNewsletter();
    assert.equal(processed.length, 0, 'без согласия — не обрабатывается');
    registry.grant(user.id, 'newsletter_test', null);
    sendNewsletter();
    assert.equal(processed.length, 1);
    registry.withdraw(user.id, 'newsletter_test');
    sendNewsletter();
    sendNewsletter();
    assert.equal(processed.length, 1, 'после отзыва повторной обработки нет');
    assert.throws(() => registry.withdraw(user.id, 'newsletter_test'), (error) => error.code === 'not_granted');
    assert.equal(registry.allows(user.id, 'terms'), true, 'договорное основание не зависит от отзыва');
    assert.equal(registry.verify().ok, true);
  });

  it('новая редакция: вход не блокируется, страница просит принять; старая редакция остаётся доступной', async () => {
    const dir = copyLegal();
    try {
      const old = context.documents.current('terms');
      const nextVersion = `${old.version}.1`;
      fs.writeFileSync(path.join(dir, 'terms', `${nextVersion}.md`), `${old.text}\n## 8. Новый раздел\n\n8.1. Текст новой редакции для теста.\n`);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      manifest.documents.terms.versions.push({ version: nextVersion, file: `terms/${nextVersion}.md`, sha256: sha256Text(fs.readFileSync(path.join(dir, 'terms', `${nextVersion}.md`), 'utf8')), publishedAt: old.publishedAt });
      manifest.documents.terms.current = nextVersion;
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      const documents = createLegalDocuments({ dir });
      const { context: local } = makeContext({ documents, outbox });
      const { server: localServer, base: localBase } = await startAuthServer(local);
      try {
        // Аккаунт принял прежнюю редакцию соглашения (журнал — тот же, документы — до обновления).
        const second = randomBytes(16).toString('hex');
        local.store.createUser({ id: second, email: 'second.terms@medkarta.test', firstName: 'Вторая', passwordHash: await hashPassword(USER_PASSWORD), now: Date.now() });
        createConsentRegistry({ store: local.store, documents: context.documents }).recordSignup(second, accepted(context), { method: 'registration_form' });
        const tab = browserFor(localBase);
        const login = await tab.login('second.terms@medkarta.test', USER_PASSWORD);
        assert.equal(login.status, 200, JSON.stringify(login.body));
        const me = await tab.call('/api/account');
        assert.deepEqual(me.body.legalPending.map((item) => [item.document, item.version]), [['terms', nextVersion]]);
        assert.equal((await tab.call('/api/account/favorites', { method: 'POST', body: { action: 'add', ids: ['x'] } })).status, 200, 'сервис работает до принятия');
        const wrong = await tab.call('/api/privacy/accept', { method: 'POST', body: { documents: { terms: old.version } } });
        assert.equal(wrong.status, 409);
        const ok = await tab.call('/api/privacy/accept', { method: 'POST', body: { documents: { terms: nextVersion } } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.deepEqual(ok.body.pending, []);
        assert.deepEqual(ok.body.history.filter((item) => item.purpose === 'terms').map((item) => item.version), [old.version, nextVersion]);
        const previous = await browserFor(localBase).call(`/api/legal/terms?version=${old.version}`);
        assert.equal(previous.status, 200);
        assert.equal(previous.body.document.sha256, old.sha256, 'прежняя редакция доступна и не изменена');
        assert.equal(previous.body.history.length, 2);
      } finally {
        localServer.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: удаление аккаунта', { skip }, () => {
  it('удаление: аккаунт, журнал входов, письма и заявки на регистрацию — стёрты; согласия закрыты; метка для повторного удаления после восстановления копии', async () => {
    const erasureLog = createErasureLog();
    const dir = tempDir('mk-erase-');
    const file = path.join(dir, 'accounts.sqlite');
    const { context, outbox } = makeContext({ file, erasureLog });
    const { server, base } = await startAuthServer(context);
    try {
      const { tab, user } = await registerUser(context, outbox, base, 'erase.me@medkarta.test');
      // Обращение с текстом — текст при удалении стирается, сам факт обращения остаётся без привязки.
      const request = await tab.call('/api/privacy/requests', { method: 'POST', body: { type: 'erase', message: 'Прошу удалить мои данные, вымышленный текст' } });
      assert.equal(request.status, 201, JSON.stringify(request.body));
      await settle(context);
      // Вторая заявка на регистрацию тем же адресом (например, человек забыл, что уже зарегистрирован).
      await browserFor(base).call('/api/auth/register', { method: 'POST', body: { email: 'erase.me@medkarta.test' } });
      await settle(context);

      const refused = await tab.call('/api/account', { method: 'DELETE', body: { confirm: true } });
      assert.equal(refused.status, 403, 'удаление — со свежим подтверждением личности');
      await tab.reauth();
      const deleted = await tab.call('/api/account', { method: 'DELETE', body: { confirm: true } });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

      assert.equal(context.store.getUserById(user.id), null);
      assert.equal(context.store.listAuthEvents({ userId: user.id, limit: 50 }).rows.length, 0, 'журнал входов');
      const db = new DatabaseSync(file);
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM registrations WHERE email = ?').get('erase.me@medkarta.test').count, 0, 'заявки на регистрацию');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
        // Свои действия удалённого аккаунта в журнале — без имени и email.
        const own = db.prepare('SELECT * FROM audit_log WHERE actor_id = ?').all(user.id);
        assert.ok(own.length >= 2, 'регистрация и удаление записаны');
        assert.equal(JSON.stringify(own).includes('erase.me') || JSON.stringify(own).includes('e***@'), false);
        for (const table of tables.filter((name) => !['consent_log', 'audit_log'].includes(name))) {
          const rows = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());
          assert.equal(rows.includes('erase.me@medkarta.test'), false, `email остался в ${table}`);
          assert.equal(rows.includes(user.id), false, `id аккаунта остался в ${table}`);
        }
      } finally {
        db.close();
      }
      const [stored] = context.store.listPrivacyRequests({}).rows;
      assert.equal(stored.userId, null);
      assert.equal(stored.message, null, 'текст обращения стёрт');
      const history = context.store.listConsentRecords(user.id);
      assert.deepEqual(history.slice(-2).map((item) => item.action), ['closed', 'closed'], 'основания закрыты, история доказательств сохранена');
      assert.equal(context.consents.verify().ok, true);
      assert.deepEqual(erasureLog.list().map((item) => item.userId), [user.id]);
      assert.equal(JSON.stringify(erasureLog.list()).includes('erase.me'), false, 'в метке нет email');
      assert.equal((await tab.call('/api/account')).body.user, null);
    } finally {
      server.close();
      context.store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('демо-записи: привязка к аккаунту снимается через 30 дней после даты приёма', { skip }, async () => {
    const index = await getDemoCatalog();
    let clock = moscowMoment('2026-10-12', '12:00');
    const store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => clock });
    try {
      const pairs = index.catalog.doctors.flatMap((doctor) => doctor.branchIds.map((branchId) => ({ doctorId: doctor.id, branchId })));
      const slot = [...store.freeSlots({ pairs, fromDay: '2026-10-13', toDay: '2026-10-14' }).values()].flat()[0];
      const accountId = randomBytes(16).toString('hex');
      store.book({ slotId: slot.id, idempotencyKey: 'privacy-test-key-0001', accountId });
      assert.equal(store.accountBookings(accountId).length, 1);
      assert.equal(OWNER_RETENTION_DAYS, 30);
      clock = moscowMoment('2026-11-10', '12:00');
      store.freeSlots({ pairs: pairs.slice(0, 1), fromDay: '2026-11-11', toDay: '2026-11-11' });
      assert.equal(store.accountBookings(accountId).length, 1, 'через 27 дней после приёма — ещё видна в кабинете');
      clock = moscowMoment('2026-11-14', '12:00');
      store.freeSlots({ pairs: pairs.slice(0, 1), fromDay: '2026-11-15', toDay: '2026-11-15' });
      assert.equal(store.accountBookings(accountId).length, 0, 'через 30+ дней — привязки нет');
    } finally {
      store.close();
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: обращения субъектов, выгрузка, права сотрудников', { skip }, () => {
  let context;
  let outbox;
  let server;
  let base;
  let root;
  let rootKey;

  before(async () => {
    ({ context, outbox } = makeContext());
    ({ server, base } = await startAuthServer(context));
    const { bootstrapSuperadmin } = await import('../backend/accounts/bootstrap.js');
    await bootstrapSuperadmin({ store: context.store, email: ROOT_EMAIL, password: ROOT_PASSWORD });
    root = browserFor(base);
    await root.login(ROOT_EMAIL, ROOT_PASSWORD);
    rootKey = softAuthenticator();
    await root.enrollPasskey(rootKey);
    root = browserFor(base);
    await root.signIn(ROOT_EMAIL, ROOT_PASSWORD, rootKey);
  });
  after(() => server?.close());

  it('сроки: 10 рабочих дней (+5), исправление и уничтожение — 7 рабочих, отзыв — 30 календарных', () => {
    // Пятница 23.10.2026, 15:00 МСК → 10 рабочих дней со следующего дня → пятница 06.11.2026, конец дня.
    const friday = Date.parse('2026-10-23T12:00:00Z');
    assert.equal(new Date(deadlineAfter(friday, 10, 'working')).toISOString(), '2026-11-06T20:59:59.999Z');
    assert.equal(new Date(deadlineAfter(friday, 7, 'working')).toISOString(), '2026-11-03T20:59:59.999Z');
    assert.equal(new Date(deadlineAfter(friday, 30, 'calendar')).toISOString(), '2026-11-22T20:59:59.999Z');
    assert.deepEqual([PRIVACY_DEADLINES.access.days, PRIVACY_DEADLINES.access.extension], [10, 5]);
    assert.equal(PRIVACY_DEADLINES.rectify.extension, 0);
    assert.equal(PRIVACY_DEADLINES.erase.days, 7);
  });

  it('пользователь видит только свои обращения; письмо — без текста обращения', async () => {
    const anna = await registerUser(context, outbox, base, 'anna.request@medkarta.test');
    const boris = await registerUser(context, outbox, base, 'boris.request@medkarta.test');
    const created = await anna.tab.call('/api/privacy/requests', { method: 'POST', body: { type: 'access', message: 'Какие данные обо мне хранятся? Текст вымышленный.' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.request.status, 'received');
    assert.ok(Date.parse(created.body.request.dueAt) > Date.now());
    const bad = await anna.tab.call('/api/privacy/requests', { method: 'POST', body: { type: 'access', userId: boris.user.id } });
    assert.equal(bad.status, 400, 'чужой id в запросе не принимается');
    assert.equal((await boris.tab.call('/api/privacy/requests')).body.items.length, 0);
    assert.equal((await anna.tab.call('/api/privacy/requests')).body.items.length, 1);
    await settle(context);
    const mail = lastMailTo(outbox, 'anna.request@medkarta.test');
    assert.match(mail.subject, /Обращение по персональным данным получено/);
    assert.equal(mail.text.includes('Какие данные'), false);
    assert.equal((await anna.tab.call('/api/admin/privacy-requests')).status, 403, 'пользователю — нет');
  });

  it('сотрудник с правом privacy.requests ведёт обращение; продление — один раз и с причиной', async () => {
    const list = await root.call('/api/admin/privacy-requests');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const [item] = list.body.items;
    assert.equal(item.type, 'access');
    assert.equal(item.subject.includes('anna.request@'), false, 'в списке адрес замаскирован');
    const taken = await root.call(`/api/admin/privacy-requests/${item.id}/take`, { method: 'POST', body: {} });
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    const noReason = await root.call(`/api/admin/privacy-requests/${item.id}/extend`, { method: 'POST', body: { reason: 'надо' } });
    assert.equal(noReason.status, 400);
    const extended = await root.call(`/api/admin/privacy-requests/${item.id}/extend`, { method: 'POST', body: { reason: 'Нужно собрать сведения из резервных копий' } });
    assert.equal(extended.status, 200);
    assert.ok(Date.parse(extended.body.request.dueAt) > Date.parse(item.dueAt));
    assert.equal((await root.call(`/api/admin/privacy-requests/${item.id}/extend`, { method: 'POST', body: { reason: 'Ещё раз продлить срок ответа' } })).status, 409);
    const done = await root.call(`/api/admin/privacy-requests/${item.id}/complete`, { method: 'POST', body: { response: 'Сведения направлены: см. выгрузку в профиле.' } });
    assert.equal(done.status, 200);
    assert.equal((await root.call(`/api/admin/privacy-requests/${item.id}/reject`, { method: 'POST', body: { response: 'Повторное закрытие не допускается' } })).status, 409);
    const audit = context.store.listAudit({ filters: { action: 'privacy.request_complete' } });
    assert.equal(audit.rows.length, 1);
    const consents = await root.call(`/api/admin/users/${item.userId}/consents`);
    assert.equal(consents.status, 200, JSON.stringify(consents.body));
  });

  it('модератор без права privacy.requests не видит обращения и журнал согласий', async () => {
    await root.reauth(rootKey);
    const created = await root.call('/api/admin/users', { method: 'POST', body: { email: 'mod.privacy@medkarta.test', firstName: 'Мод', lastName: 'Тест', role: 'moderator', delivery: 'manual' } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const tab = browserFor(base);
    await tab.call('/api/auth/activation/start', { method: 'POST', body: { token: tokenOfLink(created.body.link) } });
    const password = 'Модератор без доступа к обращениям';
    assert.equal((await tab.call('/api/auth/activation/complete', { method: 'POST', body: { password } })).status, 200);
    tab.password = password;
    const key = softAuthenticator();
    await tab.enrollPasskey(key);
    const moderator = browserFor(base);
    await moderator.signIn('mod.privacy@medkarta.test', password, key);
    assert.equal((await moderator.call('/api/admin/me')).status, 200);
    assert.equal((await moderator.call('/api/admin/privacy-requests')).status, 403);
    const anna = context.store.getUserByEmail('anna.request@medkarta.test');
    assert.equal((await moderator.call(`/api/admin/users/${anna.id}/consents`)).status, 403);
  });

  it('выгрузка «Мои данные»: только со свежим подтверждением, без хэшей, токенов и секретов', async () => {
    const tab = browserFor(base);
    await tab.login('anna.request@medkarta.test', USER_PASSWORD);
    const cross = await tab.call('/api/privacy/export', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.status, 403);
    const stale = await tab.call('/api/privacy/export');
    assert.equal(stale.status, 403);
    assert.equal(stale.body.code, 'reauth_required', 'выгрузка — только после подтверждения личности');
    await tab.reauth();
    const fresh = await tab.call('/api/privacy/export');
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.match(fresh.headers.get('content-disposition'), /attachment; filename="medkarta-my-data-/);
    const data = fresh.body;
    assert.equal(data.account.email, 'anna.request@medkarta.test');
    assert.ok(data.documentsAndConsents.length >= 2);
    assert.ok(data.privacyRequests.length >= 1);
    assert.ok(Array.isArray(data.processing.purposes));
    const text = fresh.text;
    // «scrypt» встречается в описании обработки (реестр), поэтому ищем префикс самого хэша.
    for (const secret of ['passwordHash', 'password_hash', 'tokenHash', 'token_hash', 'secretEnc', 'scrypt2$', 'mk_sid']) {
      assert.equal(text.includes(secret), false, secret);
    }
    const user = context.store.getUserByEmail('anna.request@medkarta.test');
    assert.equal(text.includes(user.passwordHash), false);
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: сведения о здоровье', () => {
  const COMPLAINTS = [
    'неделю болит живот и тошнит',
    'у меня диабет, нужен эндокринолог',
    'беременность 8 недель нужен гинеколог',
    'муж пьёт нужен нарколог анонимно',
    'после химиотерапии слабость, к терапевту',
  ];

  /*
   * С политики 2026-10-28.1 профиль врача по жалобе выбирает модель-триаж
   * (tests/symptom-triage.test.js) — отдельным вызовом, по обезличенному
   * тексту. Планировщику маршрута и записи жалоба по-прежнему не уходит
   * (проверки ниже: триаж здесь не подключён). AI_SYMPTOM_TRIAGE=off
   * возвращает режим «только локально».
   */
  it('политика: жалоба — триажу модели, планировщику — ничего; триаж выключается', () => {
    assert.equal(POLICY.medicalTextMode, 'external_triage');
    assert.equal(medicalTextModeFromEnv({ AI_SYMPTOM_TRIAGE: 'off' }), 'local_only');
  });

  for (const text of COMPLAINTS) {
    it(`«${text}» — внешней модели не уходит ничего, ответ строится локально`, async () => {
      const { pipeline, sent, logger } = makeTestPipeline();
      const result = await pipeline.handle({ messages: [{ role: 'user', content: text }], sessionId: TEST_SESSION });
      assert.equal(sent.length, 0, 'запрос ушёл внешней модели');
      assert.equal(result.diagnostics.decision, GATEWAY_DECISION.LOCAL_ONLY);
      assert.ok(result.action.replyText.length > 0);
      // В журнале — ни слов жалобы, ни профиля, ни признака «медицинский текст».
      const logged = JSON.stringify(logger.__records);
      for (const word of text.split(/[\s,]+/).filter((item) => item.length > 4)) {
        assert.equal(logged.toLowerCase().includes(word.toLowerCase()), false, `в журнале «${word}»`);
      }
      assert.doesNotMatch(logged, /medical|specialt|symptom|diagnos|gastro|endocrin|gynec|psychiat/i);
    });
  }

  it('журнал: поля со сведениями о здоровье отбрасываются, даже если их передали', () => {
    const logger = createSafeLogger({ enabled: false });
    const record = logger.event('test.event', {
      status: 'ok', medical_text: 'болит живот', medicalText: true, specialties: ['gastroenterologist'], specialty: 'therapist',
      symptoms: 'тошнота', diagnosis: 'гастрит', emergency: true, missing_specialties: ['x'],
    });
    assert.deepEqual(Object.keys(record).sort(), ['event', 'level', 'status', 'ts']);
  });

  it('письма об обращениях не содержат текста обращения и ответа', () => {
    const received = renderMail('privacy_request_received', { name: 'Анна', requestId: 'a'.repeat(24), typeLabel: 'Сведения об обработке', dueAt: Date.now() });
    const update = renderMail('privacy_request_update', { name: 'Анна', requestId: 'a'.repeat(24), typeLabel: 'Сведения об обработке', statusLabel: 'Выполнено', dueAt: Date.now() });
    for (const mail of [received, update]) {
      assert.doesNotMatch(mail.text, /болит|диагноз/);
      assert.match(mail.text, /разделе «Мои данные»/);
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: ассистент, хранилища, резервные копии', () => {
  it('пропуск к ассистенту не содержит id аккаунта и проверяется без базы аккаунтов', () => {
    let clock = Date.now();
    const pass = createAssistantPass({ key: randomBytes(32), now: () => clock });
    const token = pass.issue();
    const [payload] = token.split('.');
    assert.equal(Buffer.from(payload, 'base64url').length, 20, 'только срок и случайное число');
    assert.equal(pass.verify(token), true);
    assert.equal(pass.verify(`${payload}.${'A'.repeat(43)}`), false, 'подпись проверяется');
    assert.equal(createAssistantPass({ key: randomBytes(32), now: () => clock }).verify(token), false, 'чужой ключ');
    clock += pass.ttlMs + 1000;
    assert.equal(pass.verify(token), false, 'истёкший пропуск');
  });

  it('хранилище токенов вне РФ (Upstash) не используется: память и сигнал в журнал', () => {
    const calls = [];
    const store = createStoreFromEnv(
      { TOKEN_VAULT_BACKEND: 'upstash', UPSTASH_REDIS_REST_URL: 'https://eu1-test.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'test-token-not-real' },
      { onForeign: () => calls.push('foreign') },
    );
    assert.deepEqual(calls, ['foreign']);
    assert.deepEqual(Object.keys(store).sort(), Object.keys(createMemoryStore()).sort(), 'используется память процесса');
  });

  it('резервная копия: AES-256-GCM, подмена и чужой ключ обнаруживаются', () => {
    const key = randomBytes(32);
    const plain = Buffer.from('SQLite format 3\u0000 вымышленное содержимое базы');
    const sealed = encryptBackup(plain, key);
    assert.equal(isEncryptedBackup(sealed), true);
    assert.equal(sealed.includes(Buffer.from('SQLite format 3')), false);
    assert.deepEqual(decryptBackup(sealed, key), plain);
    const broken = Buffer.from(sealed);
    broken[broken.length - 1] ^= 1;
    assert.throws(() => decryptBackup(broken, key));
    assert.throws(() => decryptBackup(sealed, randomBytes(32)));
    assert.throws(() => decryptBackup(plain, key), /не зашифрованная/);
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: резервная копия и повторное удаление (CLI)', { skip }, () => {
  it('зашифрованная копия → удаление аккаунта → восстановление копии → reapply-erasures удаляет снова', async () => {
    const dir = tempDir('mk-restore-');
    const file = path.join(dir, 'accounts.sqlite');
    const env = {
      ...process.env,
      ACCOUNTS_DB_PATH: file,
      MFA_SECRET_KEY: randomBytes(32).toString('base64'),
      BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      NODE_ENV: 'test',
    };
    const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'accounts.mjs'), ...args], { env, cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const erasureLog = createErasureLog({ file: path.join(dir, 'erasures.jsonl') });
      let { context } = makeContext({ file, erasureLog });
      const userId = randomBytes(16).toString('hex');
      context.store.createUser({ id: userId, email: 'restored@medkarta.test', firstName: 'Копия', passwordHash: await hashPassword(USER_PASSWORD), now: Date.now() });
      context.consents.recordSignup(userId, accepted(context), { method: 'registration_form' });
      context.store.close();

      const sealed = path.join(dir, 'backup.enc');
      assert.match(cli('backup', '--encrypt', '--out', sealed), /Зашифрованная копия/);
      assert.equal(fs.readFileSync(sealed).includes(Buffer.from('restored@medkarta.test')), false, 'в зашифрованной копии email не виден');

      ({ context } = makeContext({ file, erasureLog }));
      context.accounts.deleteAccount(context.store.getUserById(userId));
      assert.equal(context.store.getUserById(userId), null);
      context.store.close();
      assert.deepEqual(erasureLog.list().map((item) => item.userId), [userId]);

      // «Восстановили» базу из копии: аккаунт вернулся.
      const restored = path.join(dir, 'restored.sqlite');
      assert.match(cli('decrypt-backup', '--in', sealed, '--out', restored), /reapply-erasures/);
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
      fs.renameSync(restored, file);
      ({ context } = makeContext({ file, erasureLog }));
      assert.ok(context.store.getUserById(userId), 'после восстановления аккаунт снова в базе');
      context.store.close();

      assert.match(cli('reapply-erasures', '--yes'), /Удалено повторно: 1/);
      ({ context } = makeContext({ file, erasureLog }));
      assert.equal(context.store.getUserById(userId), null, 'удаление повторено');
      assert.equal(context.consents.verify().ok, true);
      context.store.close();
      assert.match(cli('reapply-erasures', '--yes'), /снова есть в базе \(восстановлены из копии\): 0/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------ */

describe('152-ФЗ: миграция 6 → 7', { skip }, () => {
  it('существующие аккаунты сохраняются; пользователю предлагают принять документы при входе, сотрудникам — нет', async () => {
    const dir = tempDir('mk-migrate7-');
    const file = path.join(dir, 'accounts.sqlite');
    try {
      const legacy = new DatabaseSync(file);
      for (let version = 0; version < 6; version += 1) {
        const migration = ACCOUNT_MIGRATIONS[version];
        legacy.exec('BEGIN');
        if (typeof migration === 'function') migration(legacy);
        else legacy.exec(migration);
        legacy.exec(`PRAGMA user_version = ${version + 1}`);
        legacy.exec('COMMIT');
      }
      const now = Date.now();
      const hash = await hashPassword(USER_PASSWORD);
      const insert = legacy.prepare(`INSERT INTO users (id, email, display_name, first_name, password_hash, role, status, activated_at, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`);
      insert.run('1'.repeat(32), 'old.user@medkarta.test', 'Старый', 'Старый', hash, 'user', now, now, now, now);
      insert.run('2'.repeat(32), 'old.admin@medkarta.test', 'Админ', 'Админ', hash, 'admin', now, now, now, now);
      legacy.close();

      const { context } = makeContext({ file });
      assert.equal(context.store.health().schemaVersion, 7);
      assert.equal(context.store.countUsers(), 2, 'аккаунты не удалены');
      assert.equal(context.store.getUserByEmail('old.user@medkarta.test').passwordHash, hash, 'пароль не изменён');
      assert.equal(context.store.countConsentRecords(), 0, 'записей задним числом нет');
      assert.deepEqual(context.consents.pendingFor(context.store.getUserByEmail('old.user@medkarta.test')).map((item) => item.purpose), ['terms', 'privacy_policy']);
      assert.deepEqual(context.consents.pendingFor(context.store.getUserByEmail('old.admin@medkarta.test')), []);
      const login = await context.accounts.login({ email: 'old.user@medkarta.test', password: USER_PASSWORD }, { ipKey: 'k' });
      assert.ok(login.session, 'вход не блокируется');
      context.store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
