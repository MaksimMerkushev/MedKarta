/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Хранилище аккаунтов на SQLite (node:sqlite, встроен в Node 22.13+).
 *
 * SQLite, а не PostgreSQL: сервер — 1 ядро и 2 ГБ, данных у кабинета немного,
 * отдельный процесс СУБД не нужен. Остальной код работает только через методы
 * ниже: для перехода на PostgreSQL достаточно модуля с теми же методами
 * (см. docs/accounts.md).
 *
 * Что хранится — и ничего больше:
 *   users          — email, имя и фамилия, хэш пароля, роль, статус, даты
 *                    входа и активности, программа ДМС; у демо-аккаунтов —
 *                    шаблон и SHA-256 от токена браузера;
 *   sessions       — SHA-256 от токена (сам токен — только в cookie),
 *                    публичный id для отзыва, «Chrome · macOS», сеть /24;
 *   favorites      — id врачей и учреждений из справочника;
 *   auth_events    — история входов (срок хранения — в настройках);
 *   audit_log      — действия администраторов, без паролей и токенов;
 *   user_blocks    — история блокировок;
 *   user_activity  — дни, когда пользователь пользовался сервисом (DAU/MAU);
 *   avatars        — картинка до 256 КБ без метаданных;
 *   settings, role_overrides — настройки и матрица прав из админ-панели;
 *   access_tokens  — приглашения и ссылки для смены пароля: только SHA-256
 *                    от токена (сам токен — в письме или у администратора),
 *                    срок, кто выдал, когда открыт, использован или отозван.
 * Запросы к ассистенту, симптомы, координаты и история поиска сюда не пишутся.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 7;

/** Строка для поиска без учёта регистра: LIKE в SQLite не знает кириллицы. */
export const searchTextOf = ({ firstName = '', lastName = '', email = '', id = '' }) =>
  `${firstName} ${lastName} ${email} ${id}`.toLowerCase();

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT,
    dms_plan_id   TEXT,
    demo_key      TEXT UNIQUE,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expiry ON sessions(expires_at);
  CREATE TABLE favorites (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  `,
  // Демо-аккаунт — личная копия шаблона на браузер: зрители не видят данных друг друга.
  // Прежние общие демо-аккаунты (demo_key) удаляются вместе с сессиями: в общий кабинет больше не войти.
  // Столбец demo_key остаётся только потому, что SQLite не удаляет столбец с UNIQUE.
  `
  DELETE FROM users WHERE demo_key IS NOT NULL;
  ALTER TABLE users ADD COLUMN demo_template TEXT;
  ALTER TABLE users ADD COLUMN demo_owner TEXT;
  CREATE UNIQUE INDEX users_demo_copy ON users(demo_template, demo_owner) WHERE demo_template IS NOT NULL;
  CREATE INDEX users_demo_seen ON users(updated_at) WHERE demo_template IS NOT NULL;
  `,
  // Схема 3: роли, статусы, блокировки, история входов, аудит, активность, аватары, настройки.
  (db) => {
    db.exec(`
    ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin', 'superadmin'));
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'archived'));
    ALTER TABLE users ADD COLUMN blocked_until INTEGER;
    ALTER TABLE users ADD COLUMN block_reason TEXT;
    ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN password_changed_at INTEGER;
    ALTER TABLE users ADD COLUMN last_login_at INTEGER;
    ALTER TABLE users ADD COLUMN last_seen_at INTEGER;
    ALTER TABLE users ADD COLUMN failed_logins INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN last_failed_login_at INTEGER;
    ALTER TABLE users ADD COLUMN created_by TEXT;
    ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
    CREATE INDEX users_role ON users(role);
    CREATE INDEX users_status ON users(status);
    CREATE INDEX users_created ON users(created_at);

    ALTER TABLE sessions ADD COLUMN public_id TEXT;
    ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER;
    ALTER TABLE sessions ADD COLUMN client TEXT;
    ALTER TABLE sessions ADD COLUMN ip_prefix TEXT;
    UPDATE sessions SET public_id = lower(hex(randomblob(12))), last_seen_at = created_at;
    CREATE UNIQUE INDEX sessions_public ON sessions(public_id);

    CREATE TABLE auth_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      type        TEXT NOT NULL,
      user_id     TEXT,
      session_id  TEXT,
      client      TEXT,
      ip_prefix   TEXT,
      reason      TEXT
    );
    CREATE INDEX auth_events_user ON auth_events(user_id, at);
    CREATE INDEX auth_events_type ON auth_events(type, at);
    CREATE INDEX auth_events_at ON auth_events(at);

    CREATE TABLE audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      action       TEXT NOT NULL,
      actor_id     TEXT,
      actor_label  TEXT,
      target_id    TEXT,
      target_label TEXT,
      result       TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
      details      TEXT,
      search_text  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX audit_at ON audit_log(at);
    CREATE INDEX audit_target ON audit_log(target_id, at);
    CREATE INDEX audit_actor ON audit_log(actor_id, at);
    CREATE INDEX audit_action ON audit_log(action, at);

    CREATE TABLE user_blocks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at        INTEGER NOT NULL,
      action    TEXT NOT NULL CHECK (action IN ('block', 'unblock', 'expired')),
      until     INTEGER,
      reason    TEXT,
      actor_id  TEXT,
      actor_label TEXT
    );
    CREATE INDEX user_blocks_user ON user_blocks(user_id, at);

    CREATE TABLE user_activity (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day     TEXT NOT NULL,
      PRIMARY KEY (user_id, day)
    ) WITHOUT ROWID;
    CREATE INDEX user_activity_day ON user_activity(day);

    CREATE TABLE avatars (
      user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       BLOB NOT NULL,
      etag       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE role_overrides (
      role        TEXT PRIMARY KEY,
      permissions TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      updated_by  TEXT
    );
    `);
    // Имя переходит в first_name целиком; строка поиска — в JS: lower() в SQLite не знает кириллицы.
    const rows = db.prepare('SELECT id, email, display_name FROM users').all();
    const update = db.prepare('UPDATE users SET first_name = ?, search_text = ? WHERE id = ?');
    for (const row of rows) {
      update.run(row.display_name, searchTextOf({ firstName: row.display_name, email: row.email, id: row.id }), row.id);
    }
  },
  /*
   * Схема 4: приглашения вместо временных паролей. activated_at — когда
   * человек сам задал пароль; NULL — «ожидает активации». Все прежние
   * аккаунты с паролем (и демо-копии) считаются активированными — войти
   * они могут как раньше.
   */
  `
  ALTER TABLE users ADD COLUMN activated_at INTEGER;
  UPDATE users SET activated_at = COALESCE(password_changed_at, created_at) WHERE password_hash IS NOT NULL OR demo_template IS NOT NULL;
  CREATE INDEX users_pending ON users(created_at) WHERE activated_at IS NULL AND demo_template IS NULL;

  CREATE TABLE access_tokens (
    id                 TEXT PRIMARY KEY,
    token_hash         TEXT NOT NULL UNIQUE,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose            TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
    email              TEXT NOT NULL,
    source             TEXT NOT NULL CHECK (source IN ('admin', 'self', 'cli')),
    delivery           TEXT NOT NULL CHECK (delivery IN ('email', 'manual')),
    delivery_status    TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed', 'manual')),
    created_at         INTEGER NOT NULL,
    expires_at         INTEGER NOT NULL,
    created_by         TEXT,
    created_by_label   TEXT,
    opened_at          INTEGER,
    used_at            INTEGER,
    revoked_at         INTEGER,
    revoked_reason     TEXT,
    context_hash       TEXT UNIQUE,
    context_expires_at INTEGER
  );
  CREATE INDEX access_tokens_user ON access_tokens(user_id, created_at);
  CREATE INDEX access_tokens_expiry ON access_tokens(expires_at);
  `,
  /*
   * Схема 5: самостоятельная регистрация, MFA, постоянные счётчики попыток
   * входа, доверенные устройства, почтовая очередь, смена email.
   *
   * email_verified_at: прежние активированные аккаунты считаются
   * подтверждёнными — их создавал администратор, и они уже входили. Новые —
   * только после перехода по ссылке из письма.
   *
   * Все прежние сессии завершаются: у сессии появился уровень
   * аутентификации (aal), а cookie получает префикс __Host-. Каждому нужно
   * войти заново — один раз после обновления.
   */
  (db) => {
    db.exec(`
    ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
    ALTER TABLE users ADD COLUMN signup_source TEXT;
    UPDATE users SET email_verified_at = activated_at WHERE activated_at IS NOT NULL AND demo_template IS NULL;
    UPDATE users SET signup_source = CASE WHEN created_by IS NOT NULL THEN 'admin' ELSE 'legacy' END WHERE demo_template IS NULL;

    DELETE FROM sessions;
    ALTER TABLE sessions ADD COLUMN aal INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE sessions ADD COLUMN mfa_at INTEGER;
    ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
    ALTER TABLE sessions ADD COLUMN device_hash TEXT;

    CREATE TABLE access_tokens_v5 (
      id                 TEXT PRIMARY KEY,
      token_hash         TEXT NOT NULL UNIQUE,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose            TEXT NOT NULL CHECK (purpose IN ('invite', 'reset', 'email_change')),
      email              TEXT NOT NULL,
      new_email          TEXT,
      source             TEXT NOT NULL CHECK (source IN ('admin', 'self', 'cli')),
      delivery           TEXT NOT NULL CHECK (delivery IN ('email', 'manual')),
      delivery_status    TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed', 'manual')),
      created_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      created_by         TEXT,
      created_by_label   TEXT,
      opened_at          INTEGER,
      used_at            INTEGER,
      revoked_at         INTEGER,
      revoked_reason     TEXT,
      context_hash       TEXT UNIQUE,
      context_expires_at INTEGER
    );
    INSERT INTO access_tokens_v5 (id, token_hash, user_id, purpose, email, source, delivery, delivery_status, created_at, expires_at,
      created_by, created_by_label, opened_at, used_at, revoked_at, revoked_reason, context_hash, context_expires_at)
      SELECT id, token_hash, user_id, purpose, email, source, delivery, delivery_status, created_at, expires_at,
      created_by, created_by_label, opened_at, used_at, revoked_at, revoked_reason, context_hash, context_expires_at FROM access_tokens;
    DROP TABLE access_tokens;
    ALTER TABLE access_tokens_v5 RENAME TO access_tokens;
    CREATE INDEX access_tokens_user ON access_tokens(user_id, created_at);
    CREATE INDEX access_tokens_expiry ON access_tokens(expires_at);

    CREATE TABLE registrations (
      id                 TEXT PRIMARY KEY,
      token_hash         TEXT NOT NULL UNIQUE,
      email              TEXT NOT NULL COLLATE NOCASE,
      created_at         INTEGER NOT NULL,
      expires_at         INTEGER NOT NULL,
      opened_at          INTEGER,
      context_hash       TEXT UNIQUE,
      context_expires_at INTEGER,
      used_at            INTEGER,
      revoked_at         INTEGER,
      revoked_reason     TEXT,
      delivery_status    TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
      ip_prefix          TEXT,
      user_id            TEXT
    );
    CREATE INDEX registrations_email ON registrations(email, created_at);
    CREATE INDEX registrations_expiry ON registrations(expires_at);

    CREATE TABLE mfa_factors (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type          TEXT NOT NULL CHECK (type IN ('totp', 'webauthn')),
      label         TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked')),
      secret_enc    TEXT,
      last_step     INTEGER,
      credential_id TEXT UNIQUE,
      public_key    TEXT,
      algorithm     INTEGER,
      sign_count    INTEGER NOT NULL DEFAULT 0,
      transports    TEXT,
      backed_up     INTEGER,
      created_at    INTEGER NOT NULL,
      confirmed_at  INTEGER,
      last_used_at  INTEGER,
      revoked_at    INTEGER,
      expires_at    INTEGER
    );
    CREATE INDEX mfa_factors_user ON mfa_factors(user_id, status);

    CREATE TABLE mfa_recovery_codes (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash  TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      used_at    INTEGER,
      PRIMARY KEY (user_id, code_hash)
    ) WITHOUT ROWID;

    CREATE TABLE auth_challenges (
      id_hash     TEXT PRIMARY KEY,
      user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
      purpose     TEXT NOT NULL CHECK (purpose IN ('login', 'webauthn_register', 'reauth')),
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      challenge   TEXT,
      data        TEXT,
      consumed_at INTEGER
    );
    CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
    CREATE INDEX auth_challenges_user ON auth_challenges(user_id, purpose);

    CREATE TABLE auth_throttle (
      key          TEXT PRIMARY KEY,
      failures     INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      locked_until INTEGER,
      lock_count   INTEGER NOT NULL DEFAULT 0,
      data         TEXT,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX auth_throttle_updated ON auth_throttle(updated_at);

    CREATE TABLE trusted_devices (
      token_hash   TEXT NOT NULL,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      PRIMARY KEY (token_hash, user_id)
    ) WITHOUT ROWID;
    CREATE INDEX trusted_devices_user ON trusted_devices(user_id);
    CREATE INDEX trusted_devices_expiry ON trusted_devices(expires_at);

    CREATE TABLE mail_outbox (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      to_hash         TEXT NOT NULL,
      to_address      TEXT,
      payload         TEXT,
      key_id          TEXT,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      last_error      TEXT,
      source_key      TEXT,
      ref_type        TEXT,
      ref_id          TEXT,
      created_at      INTEGER NOT NULL,
      sent_at         INTEGER
    );
    CREATE INDEX mail_outbox_due ON mail_outbox(status, next_attempt_at);
    CREATE INDEX mail_outbox_to ON mail_outbox(to_hash, created_at);
    CREATE INDEX mail_outbox_source ON mail_outbox(source_key, created_at);
    `);
  },
  /*
   * Схема 6.
   *   mfa_factors.user_verified — проверил ли ключ доступа человека при
   *   регистрации (PIN, отпечаток, лицо). NULL — ключ добавлен до схемы 6:
   *   для него проверка не требуется задним числом (иначе сотрудник с
   *   таким ключом остался бы без входа), но первая же проверка запоминается.
   *   mail_outbox.expires_at — срок ссылки в письме: после него письмо не
   *   отправляется (мёртвая ссылка в ящике хуже, чем никакой).
   */
  `
  ALTER TABLE mfa_factors ADD COLUMN user_verified INTEGER;
  ALTER TABLE mail_outbox ADD COLUMN expires_at INTEGER;
  `,
  /*
   * Схема 7 — учёт по 152-ФЗ.
   *   consent_log — журнал принятия документов и согласий: только добавление
   *   (UPDATE запрещён триггером), у каждой записи — хэш, сцепленный с
   *   предыдущей записью того же человека (подмена или удаление записи из
   *   середины видны при проверке). Внешнего ключа на users нет: после
   *   удаления аккаунта записи остаются доказательством того, на каком
   *   основании шла обработка, и удаляются только через 3 года после
   *   последней записи (триггер не даёт удалить раньше и пока аккаунт есть).
   *   В записи нет email, IP и User-Agent — только id аккаунта, цель,
   *   редакция документа и её SHA-256, способ и время.
   *   privacy_requests — обращения субъектов ПДн со сроками ответа.
   */
  `
  CREATE TABLE consent_log (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE,
    user_id       TEXT NOT NULL,
    purpose       TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('acceptance', 'acknowledgement', 'consent')),
    action        TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn', 'closed')),
    document      TEXT,
    version       TEXT,
    document_hash TEXT,
    method        TEXT NOT NULL,
    at            INTEGER NOT NULL,
    prev_hash     TEXT NOT NULL,
    hash          TEXT NOT NULL UNIQUE
  );
  CREATE INDEX consent_log_user ON consent_log(user_id, seq);
  CREATE TRIGGER consent_log_append_only BEFORE UPDATE ON consent_log
  BEGIN
    SELECT RAISE(ABORT, 'consent_log is append-only');
  END;
  CREATE TRIGGER consent_log_retention BEFORE DELETE ON consent_log
  WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
    OR (SELECT MAX(at) FROM consent_log WHERE user_id = OLD.user_id) > CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 94608000000
  BEGIN
    SELECT RAISE(ABORT, 'consent_log retention: account exists or less than 3 years passed');
  END;

  CREATE TABLE privacy_requests (
    id               TEXT PRIMARY KEY,
    user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
    subject_label    TEXT NOT NULL,
    type             TEXT NOT NULL CHECK (type IN ('access', 'rectify', 'restrict', 'erase', 'withdraw', 'other')),
    status           TEXT NOT NULL CHECK (status IN ('received', 'in_progress', 'completed', 'rejected')),
    message          TEXT,
    created_at       INTEGER NOT NULL,
    due_at           INTEGER NOT NULL,
    extended_at      INTEGER,
    extension_reason TEXT,
    closed_at        INTEGER,
    response         TEXT,
    handled_by       TEXT,
    handled_label    TEXT,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX privacy_requests_user ON privacy_requests(user_id, created_at);
  CREATE INDEX privacy_requests_status ON privacy_requests(status, due_at);
  `,
];

/** Миграции по порядку — для тестов совместимости со старыми базами. */
export const ACCOUNT_MIGRATIONS = MIGRATIONS;
export const ACCOUNT_SCHEMA_VERSION = SCHEMA_VERSION;

// node:sqlite работает без флага с Node 22.13; на более старой версии
// возвращается null — кабинет выключается, остальной сайт работает.
export const loadSqlite = async () => {
  try {
    const module = await import('node:sqlite');
    return module.DatabaseSync || null;
  } catch {
    return null;
  }
};

const toUser = (row) => (row
  ? {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    passwordHash: row.password_hash,
    dmsPlanId: row.dms_plan_id,
    demoTemplate: row.demo_template || null,
    demoOwner: row.demo_owner || null,
    role: row.role || 'user',
    status: row.status || 'active',
    blockedUntil: row.blocked_until ?? null,
    blockReason: row.block_reason ?? null,
    mustChangePassword: Boolean(row.must_change_password),
    passwordChangedAt: row.password_changed_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    failedLogins: row.failed_logins || 0,
    lastFailedLoginAt: row.last_failed_login_at ?? null,
    createdBy: row.created_by ?? null,
    activatedAt: row.activated_at ?? null,
    emailVerifiedAt: row.email_verified_at ?? null,
    signupSource: row.signup_source ?? null,
    version: row.version || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.avatar_etag !== undefined ? { avatarEtag: row.avatar_etag || null } : {}),
    ...(row.active_sessions !== undefined ? { activeSessions: row.active_sessions } : {}),
  }
  : null);

const toSession = (row) => (row
  ? {
    tokenHash: row.token_hash,
    publicId: row.public_id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? row.created_at,
    expiresAt: row.expires_at,
    client: row.client || null,
    ipPrefix: row.ip_prefix || null,
    aal: row.aal || 1,
    mfaAt: row.mfa_at ?? null,
    reauthAt: row.reauth_at ?? null,
    deviceHash: row.device_hash ?? null,
  }
  : null);

const toAccessToken = (row) => (row
  ? {
    id: row.id,
    tokenHash: row.token_hash,
    userId: row.user_id,
    purpose: row.purpose,
    email: row.email,
    newEmail: row.new_email ?? null,
    source: row.source,
    delivery: row.delivery,
    deliveryStatus: row.delivery_status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: row.created_by ?? null,
    createdByLabel: row.created_by_label ?? null,
    openedAt: row.opened_at ?? null,
    usedAt: row.used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    revokedReason: row.revoked_reason ?? null,
    contextHash: row.context_hash ?? null,
    contextExpiresAt: row.context_expires_at ?? null,
  }
  : null);

const toRegistration = (row) => (row
  ? {
    id: row.id,
    tokenHash: row.token_hash,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    openedAt: row.opened_at ?? null,
    contextHash: row.context_hash ?? null,
    contextExpiresAt: row.context_expires_at ?? null,
    usedAt: row.used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    revokedReason: row.revoked_reason ?? null,
    deliveryStatus: row.delivery_status,
    ipPrefix: row.ip_prefix ?? null,
    userId: row.user_id ?? null,
  }
  : null);

const toConsentRecord = (row) => (row
  ? {
    seq: row.seq,
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    kind: row.kind,
    action: row.action,
    document: row.document ?? null,
    version: row.version ?? null,
    documentHash: row.document_hash ?? null,
    method: row.method,
    at: row.at,
    prevHash: row.prev_hash,
    hash: row.hash,
  }
  : null);

const toPrivacyRequest = (row) => (row
  ? {
    id: row.id,
    userId: row.user_id ?? null,
    subjectLabel: row.subject_label,
    type: row.type,
    status: row.status,
    message: row.message ?? null,
    createdAt: row.created_at,
    dueAt: row.due_at,
    extendedAt: row.extended_at ?? null,
    extensionReason: row.extension_reason ?? null,
    closedAt: row.closed_at ?? null,
    response: row.response ?? null,
    handledBy: row.handled_by ?? null,
    handledLabel: row.handled_label ?? null,
    updatedAt: row.updated_at,
  }
  : null);

const toFactor = (row) => (row
  ? {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    label: row.label,
    status: row.status,
    secretEnc: row.secret_enc ?? null,
    lastStep: row.last_step ?? null,
    credentialId: row.credential_id ?? null,
    publicKey: row.public_key ?? null,
    algorithm: row.algorithm ?? null,
    signCount: row.sign_count || 0,
    transports: row.transports ? row.transports.split(',').filter(Boolean) : [],
    backedUp: row.backed_up === null || row.backed_up === undefined ? null : Boolean(row.backed_up),
    userVerified: row.user_verified === null || row.user_verified === undefined ? null : Boolean(row.user_verified),
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    revokedAt: row.revoked_at ?? null,
    expiresAt: row.expires_at ?? null,
  }
  : null);

const toChallenge = (row) => (row
  ? {
    idHash: row.id_hash,
    userId: row.user_id ?? null,
    purpose: row.purpose,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attempts: row.attempts || 0,
    challenge: row.challenge ?? null,
    data: (() => {
      try {
        return row.data ? JSON.parse(row.data) : null;
      } catch {
        return null;
      }
    })(),
    consumedAt: row.consumed_at ?? null,
  }
  : null);

const toThrottle = (row) => (row
  ? {
    key: row.key,
    failures: row.failures || 0,
    windowStart: row.window_start,
    lockedUntil: row.locked_until ?? null,
    lockCount: row.lock_count || 0,
    data: (() => {
      try {
        return row.data ? JSON.parse(row.data) : null;
      } catch {
        return null;
      }
    })(),
    updatedAt: row.updated_at,
  }
  : null);

const toMail = (row) => (row
  ? {
    id: row.id,
    kind: row.kind,
    toHash: row.to_hash,
    toAddress: row.to_address ?? null,
    payload: row.payload ?? null,
    keyId: row.key_id ?? null,
    status: row.status,
    attempts: row.attempts || 0,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error ?? null,
    sourceKey: row.source_key ?? null,
    refType: row.ref_type ?? null,
    refId: row.ref_id ?? null,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? null,
    expiresAt: row.expires_at ?? null,
  }
  : null);

const parseJson = (text) => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const likePattern = (query) => `%${String(query).toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

// Сортировка — только по этим выражениям: имя столбца из запроса в SQL не попадает.
// Пустые даты (ни разу не входил) — всегда в конце списка, в любом направлении.
const USER_SORT = Object.freeze({
  createdAt: ['u.created_at'],
  updatedAt: ['u.updated_at'],
  lastLoginAt: ['u.last_login_at'],
  lastSeenAt: ['u.last_seen_at'],
  email: ['u.email COLLATE NOCASE'],
  name: ['u.last_name COLLATE NOCASE', 'u.first_name COLLATE NOCASE'],
  role: ["CASE u.role WHEN 'superadmin' THEN 3 WHEN 'admin' THEN 2 WHEN 'moderator' THEN 1 ELSE 0 END"],
  status: ['u.status'],
  sessions: ['active_sessions'],
  id: ['u.id'],
});
const NULLABLE_SORT = new Set(['lastLoginAt', 'lastSeenAt']);

const AUDIT_SORT = Object.freeze({ at: 'a.at', action: 'a.action', result: 'a.result', actor: 'a.actor_label COLLATE NOCASE', target: 'a.target_label COLLATE NOCASE' });

// Колонки, которые меняет updateUser; остальные — только своими методами.
const USER_COLUMNS = Object.freeze({
  email: 'email',
  firstName: 'first_name',
  lastName: 'last_name',
  displayName: 'display_name',
  role: 'role',
  status: 'status',
  blockedUntil: 'blocked_until',
  blockReason: 'block_reason',
  mustChangePassword: 'must_change_password',
  dmsPlanId: 'dms_plan_id',
  emailVerifiedAt: 'email_verified_at',
  searchText: 'search_text',
});

/**
 * @param {object} options
 * @param {Function} options.DatabaseSync конструктор из node:sqlite
 * @param {string} options.file путь к файлу базы или ':memory:'
 */
export const createSqliteAccountStore = ({ DatabaseSync, file }) => {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Файловая система без прав доступа (часть томов в контейнерах) — не повод падать.
    }
  }

  // secure_delete: «удалить аккаунт» стирает данные и из страниц файла базы, а не только помечает их свободными.
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    // База от более новой версии: молча работать с ней — значит портить данные.
    throw new Error(`accounts schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  /*
   * Перед миграцией существующей базы — её копия рядом с файлом
   * (VACUUM INTO, права 0600): если миграция пойдёт не так, базу можно
   * вернуть, остановив сервер и подменив файл копией (docs/accounts.md).
   * Копия не перезаписывается: имя включает версию схемы и время.
   */
  let migrationBackup = null;
  if (file !== ':memory:' && current > 0 && current < SCHEMA_VERSION) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
    migrationBackup = `${file}.before-v${SCHEMA_VERSION}-${stamp}.bak`;
    if (!fs.existsSync(migrationBackup)) {
      db.prepare('VACUUM INTO ?').run(migrationBackup);
      try {
        fs.chmodSync(migrationBackup, 0o600);
      } catch {
        // Права не меняются (том без прав доступа) — копия всё равно нужна.
      }
    }
  }
  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const migration = MIGRATIONS[version];
      if (typeof migration === 'function') migration(db);
      else db.exec(migration);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const statements = {
    insertUser: db.prepare(`INSERT INTO users (id, email, display_name, first_name, last_name, password_hash, dms_plan_id,
      demo_template, demo_owner, role, status, must_change_password, password_changed_at, created_by, search_text, activated_at,
      email_verified_at, signup_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    userById: db.prepare('SELECT u.*, a.etag AS avatar_etag FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.id = ?'),
    userByEmail: db.prepare('SELECT u.*, a.etag AS avatar_etag FROM users u LEFT JOIN avatars a ON a.user_id = u.id WHERE u.email = ?'),
    demoCopy: db.prepare('SELECT * FROM users WHERE demo_template = ? AND demo_owner = ?'),
    touchUser: db.prepare('UPDATE users SET updated_at = ? WHERE id = ?'),
    purgeDemoCopies: db.prepare('DELETE FROM users WHERE demo_template IS NOT NULL AND updated_at < ?'),
    countDemoCopies: db.prepare('SELECT COUNT(*) AS count FROM users WHERE demo_template IS NOT NULL'),
    deleteOldestDemoCopies: db.prepare(`DELETE FROM users WHERE id IN (
      SELECT id FROM users WHERE demo_template IS NOT NULL ORDER BY updated_at ASC LIMIT ?)`),
    setPassword: db.prepare(`UPDATE users SET password_hash = ?, must_change_password = ?, password_changed_at = ?,
      updated_at = ?, version = version + 1 WHERE id = ?`),
    rehashPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    activateUser: db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = ?,
      activated_at = COALESCE(activated_at, ?), email_verified_at = CASE WHEN ? = 1 THEN COALESCE(email_verified_at, ?) ELSE email_verified_at END,
      failed_logins = 0, updated_at = ?, version = version + 1 WHERE id = ?`),

    insertAccessToken: db.prepare(`INSERT INTO access_tokens (id, token_hash, user_id, purpose, email, new_email, source, delivery, delivery_status,
      created_at, expires_at, created_by, created_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    accessTokenByHash: db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?'),
    accessTokenById: db.prepare('SELECT * FROM access_tokens WHERE id = ?'),
    accessTokenByContext: db.prepare('SELECT * FROM access_tokens WHERE context_hash = ?'),
    userAccessTokens: db.prepare('SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    openAccessToken: db.prepare(`UPDATE access_tokens SET opened_at = ?, context_hash = ?, context_expires_at = ?
      WHERE id = ? AND opened_at IS NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`),
    useAccessToken: db.prepare(`UPDATE access_tokens SET used_at = ?, context_hash = NULL, context_expires_at = NULL
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`),
    revokeAccessToken: db.prepare(`UPDATE access_tokens SET revoked_at = ?, revoked_reason = ?, context_hash = NULL, context_expires_at = NULL
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`),
    revokeUserAccessTokens: db.prepare(`UPDATE access_tokens SET revoked_at = ?, revoked_reason = ?, context_hash = NULL, context_expires_at = NULL
      WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND (? IS NULL OR purpose = ?)`),
    setAccessTokenDelivery: db.prepare('UPDATE access_tokens SET delivery_status = ? WHERE id = ?'),
    countRecentAccessTokens: db.prepare('SELECT COUNT(*) AS count FROM access_tokens WHERE user_id = ? AND source = ? AND created_at >= ?'),
    purgeAccessTokens: db.prepare('DELETE FROM access_tokens WHERE expires_at < ? AND (context_expires_at IS NULL OR context_expires_at < ?)'),
    recordLogin: db.prepare('UPDATE users SET last_login_at = ?, last_seen_at = ?, failed_logins = 0 WHERE id = ?'),
    recordFailedLogin: db.prepare('UPDATE users SET failed_logins = failed_logins + 1, last_failed_login_at = ? WHERE id = ?'),
    setLastSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
    countActiveSuperadmins: db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'superadmin' AND status = 'active' AND activated_at IS NOT NULL AND id <> ?"),
    expiredBlocks: db.prepare("SELECT id FROM users WHERE status = 'blocked' AND blocked_until IS NOT NULL AND blocked_until <= ?"),

    insertSession: db.prepare(`INSERT INTO sessions (token_hash, public_id, user_id, created_at, last_seen_at, expires_at, client, ip_prefix,
      aal, mfa_at, reauth_at, device_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setSessionReauth: db.prepare('UPDATE sessions SET reauth_at = ? WHERE token_hash = ?'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    sessionByPublicId: db.prepare('SELECT * FROM sessions WHERE public_id = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    countUserSessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?'),
    oldestUserSession: db.prepare('SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at ASC LIMIT 1'),
    userSessions: db.prepare('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC'),

    listFavorites: db.prepare('SELECT item_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC, item_id ASC'),
    countFavorites: db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?'),
    addFavorite: db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?, ?, ?)'),
    removeFavorite: db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?'),
    clearFavorites: db.prepare('DELETE FROM favorites WHERE user_id = ?'),

    insertAuthEvent: db.prepare('INSERT INTO auth_events (at, type, user_id, session_id, client, ip_prefix, reason) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    purgeAuthEvents: db.prepare('DELETE FROM auth_events WHERE at < ?'),
    deleteUserAuthEvents: db.prepare('DELETE FROM auth_events WHERE user_id = ?'),

    insertAudit: db.prepare(`INSERT INTO audit_log (at, action, actor_id, actor_label, target_id, target_label, result, details, search_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    purgeAudit: db.prepare('DELETE FROM audit_log WHERE at < ?'),

    insertBlock: db.prepare('INSERT INTO user_blocks (user_id, at, action, until, reason, actor_id, actor_label) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    userBlocks: db.prepare('SELECT * FROM user_blocks WHERE user_id = ? ORDER BY at DESC, id DESC LIMIT ?'),

    markActive: db.prepare('INSERT OR IGNORE INTO user_activity (user_id, day) VALUES (?, ?)'),
    purgeActivity: db.prepare('DELETE FROM user_activity WHERE day < ?'),

    putAvatar: db.prepare(`INSERT INTO avatars (user_id, mime, data, etag, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, etag = excluded.etag, updated_at = excluded.updated_at`),
    getAvatar: db.prepare('SELECT mime, data, etag, updated_at FROM avatars WHERE user_id = ?'),
    deleteAvatar: db.prepare('DELETE FROM avatars WHERE user_id = ?'),

    listSettings: db.prepare('SELECT key, value, updated_at, updated_by FROM settings'),
    putSetting: db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    listRoleOverrides: db.prepare('SELECT role, permissions, updated_at, updated_by FROM role_overrides'),
    putRoleOverride: db.prepare(`INSERT INTO role_overrides (role, permissions, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(role) DO UPDATE SET permissions = excluded.permissions, updated_at = excluded.updated_at, updated_by = excluded.updated_by`),
    deleteRoleOverride: db.prepare('DELETE FROM role_overrides WHERE role = ?'),
  };

  // Вложенные вызовы выполняются внутри внешней транзакции, без второго BEGIN.
  let depth = 0;
  const transaction = (work) => {
    if (depth > 0) return work();
    db.exec('BEGIN IMMEDIATE');
    depth += 1;
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      depth -= 1;
    }
  };

  /** WHERE для списка пользователей; всё — параметрами, ничего из запроса не склеивается в SQL. */
  const userFilter = ({ q = '', roles = [], status = null, kind = 'real', ids = null } = {}) => {
    const where = [];
    const params = [];
    if (kind === 'real') where.push('u.demo_template IS NULL');
    else if (kind === 'demo') where.push('u.demo_template IS NOT NULL');
    if (roles.length > 0) {
      where.push(`u.role IN (${roles.map(() => '?').join(', ')})`);
      params.push(...roles);
    }
    if (status === 'pending') {
      // «Ожидает активации»: пароль ещё не задан, аккаунт не заблокирован и не в архиве.
      where.push("u.status = 'active' AND u.activated_at IS NULL AND u.demo_template IS NULL");
    } else if (status === 'active') {
      where.push("u.status = 'active' AND (u.activated_at IS NOT NULL OR u.demo_template IS NOT NULL)");
    } else if (status) {
      where.push('u.status = ?');
      params.push(status);
    }
    if (q) {
      where.push("u.search_text LIKE ? ESCAPE '\\'");
      params.push(likePattern(q));
    }
    if (Array.isArray(ids)) {
      where.push(`u.id IN (${ids.map(() => '?').join(', ') || "''"})`);
      params.push(...ids);
    }
    return { sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
  };

  const auditFilter = ({ action = null, actionPrefix = null, actorId = null, targetId = null, result = null, q = '', from = null, to = null } = {}) => {
    const where = [];
    const params = [];
    if (action) {
      where.push('a.action = ?');
      params.push(action);
    }
    if (actionPrefix) {
      where.push("a.action LIKE ? ESCAPE '\\'");
      params.push(`${actionPrefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    }
    if (actorId) {
      where.push('a.actor_id = ?');
      params.push(actorId);
    }
    if (targetId) {
      where.push('a.target_id = ?');
      params.push(targetId);
    }
    if (result) {
      where.push('a.result = ?');
      params.push(result);
    }
    if (q) {
      where.push("a.search_text LIKE ? ESCAPE '\\'");
      params.push(likePattern(q));
    }
    if (Number.isFinite(from)) {
      where.push('a.at >= ?');
      params.push(from);
    }
    if (Number.isFinite(to)) {
      where.push('a.at < ?');
      params.push(to);
    }
    return { sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
  };

  const toAudit = (row) => ({
    id: row.id,
    at: row.at,
    action: row.action,
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    targetId: row.target_id,
    targetLabel: row.target_label,
    result: row.result,
    details: parseJson(row.details),
  });

  return Object.freeze({
    kind: 'sqlite',
    transaction,

    /* ----------------------------- пользователи ----------------------------- */

    /*
     * Аккаунт без пароля (не демо) — «ожидает активации»: activated_at
     * появится, когда человек сам задаст пароль по приглашению.
     */
    createUser({
      id, email, firstName = '', lastName = '', displayName = null, passwordHash = null, dmsPlanId = null,
      demoTemplate = null, demoOwner = null, role = 'user', status = 'active', mustChangePassword = false, createdBy = null,
      emailVerifiedAt = null, signupSource = null, now,
    }) {
      const name = displayName || `${firstName} ${lastName}`.trim();
      const activatedAt = passwordHash || demoTemplate ? now : null;
      statements.insertUser.run(
        id, email, name, firstName, lastName, passwordHash, dmsPlanId, demoTemplate, demoOwner, role, status,
        mustChangePassword ? 1 : 0, passwordHash ? now : null, createdBy, searchTextOf({ firstName, lastName, email, id }), activatedAt,
        emailVerifiedAt, signupSource, now, now,
      );
      return toUser(statements.userById.get(id));
    },
    getUserById: (id) => (typeof id === 'string' ? toUser(statements.userById.get(id)) : null),
    getUserByEmail: (email) => toUser(statements.userByEmail.get(email)),
    getDemoCopy: (template, ownerHash) => toUser(statements.demoCopy.get(template, ownerHash)),
    touchUser: (id, now) => statements.touchUser.run(now, id).changes > 0,
    // Сессии, избранное, аватар и активность копий удаляются каскадом.
    purgeDemoCopies: (olderThan) => statements.purgeDemoCopies.run(olderThan).changes,
    countDemoCopies: () => statements.countDemoCopies.get().count,
    deleteOldestDemoCopies: (count) => statements.deleteOldestDemoCopies.run(count).changes,

    /**
     * Меняет перечисленные поля и версию записи. С expectedVersion — только
     * если запись с тех пор не меняли (иначе false: конфликт правок).
     */
    updateUser(id, fields, { now, expectedVersion = null } = {}) {
      const sets = [];
      const params = [];
      for (const [key, value] of Object.entries(fields)) {
        const column = USER_COLUMNS[key];
        if (!column) throw new Error(`updateUser: unknown field ${key}`);
        sets.push(`${column} = ?`);
        params.push(typeof value === 'boolean' ? Number(value) : value);
      }
      if (sets.length === 0) return true;
      sets.push('updated_at = ?', 'version = version + 1');
      params.push(now, id);
      let sql = `UPDATE users SET ${sets.join(', ')} WHERE id = ?`;
      if (expectedVersion !== null) {
        sql += ' AND version = ?';
        params.push(expectedVersion);
      }
      return db.prepare(sql).run(...params).changes > 0;
    },
    setPassword: (id, passwordHash, { mustChange = false, now }) =>
      statements.setPassword.run(passwordHash, mustChange ? 1 : 0, now, now, id).changes > 0,
    rehashPassword: (id, passwordHash) => statements.rehashPassword.run(passwordHash, id).changes > 0,
    /** Пароль задан по приглашению или ссылке: аккаунт активирован, требование смены снято. */
    /** emailVerified — ссылка пришла письмом на этот адрес: владение ящиком подтверждено. */
    activateUser: (id, passwordHash, now, { emailVerified = false } = {}) =>
      statements.activateUser.run(passwordHash, now, now, emailVerified ? 1 : 0, now, now, id).changes > 0,
    recordLogin: (id, now) => statements.recordLogin.run(now, now, id).changes > 0,
    recordFailedLogin: (id, now) => statements.recordFailedLogin.run(now, id).changes > 0,
    setLastSeen: (id, now) => statements.setLastSeen.run(now, id, now).changes > 0,
    deleteUser: (id) => statements.deleteUser.run(id).changes > 0,
    countUsers: () => statements.countUsers.get().count,
    countActiveSuperadmins: ({ excludeId = '' } = {}) => statements.countActiveSuperadmins.get(excludeId).count,
    expiredBlocks: (now) => statements.expiredBlocks.all(now).map((row) => row.id),

    listUsers({ filters = {}, sort = 'createdAt', dir = 'desc', limit = 25, offset = 0, now }) {
      const { sql, params } = userFilter(filters);
      const key = Object.hasOwn(USER_SORT, sort) ? sort : 'createdAt';
      const direction = dir === 'asc' ? 'ASC' : 'DESC';
      const orderSql = USER_SORT[key]
        .map((expression) => (NULLABLE_SORT.has(key) ? `(${expression} IS NULL), ${expression} ${direction}` : `${expression} ${direction}`))
        .join(', ');
      const rows = db.prepare(`SELECT u.*, a.etag AS avatar_etag,
          (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
        FROM users u LEFT JOIN avatars a ON a.user_id = u.id ${sql}
        ORDER BY ${orderSql}, u.id ASC LIMIT ? OFFSET ?`).all(now, ...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) AS count FROM users u ${sql}`).get(...params).count;
      return { rows: rows.map(toUser), total };
    },

    /* ------------------------------- сессии -------------------------------- */

    createSession({
      tokenHash, publicId, userId, now, expiresAt, maxPerUser, client = null, ipPrefix = null,
      aal = 1, mfaAt = null, reauthAt = null, deviceHash = null, createdAt = null,
    }) {
      transaction(() => {
        // Не больше maxPerUser входов на аккаунт: самый старый вытесняется.
        while (statements.countUserSessions.get(userId).count >= maxPerUser) {
          statements.deleteSession.run(statements.oldestUserSession.get(userId).token_hash);
        }
        statements.insertSession.run(tokenHash, publicId, userId, createdAt ?? now, now, expiresAt, client, ipPrefix, aal, mfaAt, reauthAt, deviceHash);
      });
    },
    setSessionReauth: (tokenHash, at) => statements.setSessionReauth.run(at, tokenHash).changes > 0,
    getSession: (tokenHash) => toSession(statements.sessionByHash.get(tokenHash)),
    getSessionByPublicId: (publicId) => (typeof publicId === 'string' ? toSession(statements.sessionByPublicId.get(publicId)) : null),
    touchSession: (tokenHash, now, expiresAt) => statements.touchSession.run(now, expiresAt, tokenHash).changes > 0,
    deleteSession: (tokenHash) => statements.deleteSession.run(tokenHash).changes > 0,
    deleteUserSessions: (userId) => statements.deleteUserSessions.run(userId).changes,
    deleteOtherSessions: (userId, keepTokenHash) => statements.deleteOtherSessions.run(userId, keepTokenHash).changes,
    purgeExpiredSessions: (now) => statements.purgeSessions.run(now).changes,
    listUserSessions: (userId, now) => statements.userSessions.all(userId, now).map(toSession),
    listSessions({ userId = null, kind = 'real', limit = 50, offset = 0, now }) {
      const where = ['s.expires_at > ?'];
      const params = [now];
      if (userId) {
        where.push('s.user_id = ?');
        params.push(userId);
      }
      if (kind === 'real') where.push('u.demo_template IS NULL');
      const sql = `FROM sessions s JOIN users u ON u.id = s.user_id WHERE ${where.join(' AND ')}`;
      const rows = db.prepare(`SELECT s.*, u.email, u.first_name, u.last_name, u.role ${sql}
        ORDER BY s.last_seen_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) AS count ${sql}`).get(...params).count;
      return {
        rows: rows.map((row) => ({ ...toSession(row), user: { id: row.user_id, email: row.email, firstName: row.first_name, lastName: row.last_name, role: row.role } })),
        total,
      };
    },
    countActiveSessions: (now, { kind = 'real' } = {}) => db.prepare(`SELECT COUNT(*) AS count FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > ? ${kind === 'real' ? 'AND u.demo_template IS NULL' : kind === 'demo' ? 'AND u.demo_template IS NOT NULL' : ''}`).get(now).count,

    /* ------------------------------ избранное ------------------------------- */

    listFavorites: (userId) => statements.listFavorites.all(userId).map((row) => row.item_id),
    countFavorites: (userId) => statements.countFavorites.get(userId).count,
    addFavorites(userId, itemIds, now) {
      transaction(() => {
        // Порядок «новые сверху»: позже в списке — новее.
        itemIds.forEach((itemId, index) => statements.addFavorite.run(userId, itemId, now + index));
      });
    },
    removeFavorite: (userId, itemId) => statements.removeFavorite.run(userId, itemId).changes > 0,
    replaceFavorites(userId, itemIds, now) {
      transaction(() => {
        statements.clearFavorites.run(userId);
        itemIds.forEach((itemId, index) => statements.addFavorite.run(userId, itemId, now - index));
      });
    },

    /* -------------------- приглашения и ссылки для пароля -------------------- */

    createAccessToken({ id, tokenHash, userId, purpose, email, newEmail = null, source, delivery, deliveryStatus, now, expiresAt, createdBy = null, createdByLabel = null }) {
      statements.insertAccessToken.run(id, tokenHash, userId, purpose, email, newEmail, source, delivery, deliveryStatus, now, expiresAt, createdBy, createdByLabel);
      return toAccessToken(statements.accessTokenById.get(id));
    },
    getAccessTokenByHash: (tokenHash) => toAccessToken(statements.accessTokenByHash.get(tokenHash)),
    getAccessTokenById: (id) => (typeof id === 'string' ? toAccessToken(statements.accessTokenById.get(id)) : null),
    getAccessTokenByContext: (contextHash) => toAccessToken(statements.accessTokenByContext.get(contextHash)),
    listUserAccessTokens: (userId, limit = 20) => statements.userAccessTokens.all(userId, limit).map(toAccessToken),
    /** Токен обменивается на контекст активации ровно один раз: второй вызов вернёт false. */
    openAccessToken: ({ id, contextHash, contextExpiresAt, now }) =>
      statements.openAccessToken.run(now, contextHash, contextExpiresAt, id, now).changes > 0,
    useAccessToken: (id, now) => statements.useAccessToken.run(now, id).changes > 0,
    revokeAccessToken: (id, reason, now) => statements.revokeAccessToken.run(now, reason, id).changes > 0,
    /** Отозвать все неиспользованные токены пользователя (purpose — только такого вида). */
    revokeUserAccessTokens: (userId, reason, now, { purpose = null } = {}) =>
      statements.revokeUserAccessTokens.run(now, reason, userId, purpose, purpose).changes,
    setAccessTokenDelivery: (id, status) => statements.setAccessTokenDelivery.run(status, id).changes > 0,
    countRecentAccessTokens: ({ userId, source, since }) => statements.countRecentAccessTokens.get(userId, source, since).count,
    /** Давно истёкшие токены не нужны даже для истории: удаляются при обслуживании. */
    purgeAccessTokens: (before) => statements.purgeAccessTokens.run(before, before).changes,
    countPendingUsers: () => db.prepare("SELECT COUNT(*) AS count FROM users WHERE activated_at IS NULL AND demo_template IS NULL AND status = 'active'").get().count,

    /* ---------------------------- история входов ---------------------------- */

    addAuthEvent: ({ at, type, userId = null, sessionId = null, client = null, ipPrefix = null, reason = null }) =>
      statements.insertAuthEvent.run(at, type, userId, sessionId, client, ipPrefix, reason),
    listAuthEvents({ userId = null, types = null, limit = 50, offset = 0 } = {}) {
      const where = [];
      const params = [];
      if (userId) {
        where.push('user_id = ?');
        params.push(userId);
      }
      if (Array.isArray(types) && types.length > 0) {
        where.push(`type IN (${types.map(() => '?').join(', ')})`);
        params.push(...types);
      }
      const sql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM auth_events ${sql} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) AS count FROM auth_events ${sql}`).get(...params).count;
      return {
        rows: rows.map((row) => ({ id: row.id, at: row.at, type: row.type, userId: row.user_id, sessionId: row.session_id, client: row.client, ipPrefix: row.ip_prefix, reason: row.reason })),
        total,
      };
    },
    countAuthEvents: ({ type, since, until = Number.MAX_SAFE_INTEGER }) =>
      db.prepare('SELECT COUNT(*) AS count FROM auth_events WHERE type = ? AND at >= ? AND at < ?').get(type, since, until).count,
    /** Число событий по корзинам [since + k*bucketMs, …): {type: [count, …]}. */
    authEventSeries({ since, bucketMs, buckets, types }) {
      const rows = db.prepare(`SELECT type, CAST((at - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS count FROM auth_events
        WHERE at >= ? AND at < ? AND type IN (${types.map(() => '?').join(', ')}) GROUP BY type, bucket`)
        .all(since, bucketMs, since, since + bucketMs * buckets, ...types);
      const series = Object.fromEntries(types.map((type) => [type, Array(buckets).fill(0)]));
      for (const row of rows) {
        if (row.bucket >= 0 && row.bucket < buckets) series[row.type][row.bucket] = row.count;
      }
      return series;
    },
    purgeAuthEvents: (before) => statements.purgeAuthEvents.run(before).changes,
    deleteUserAuthEvents: (userId) => statements.deleteUserAuthEvents.run(userId).changes,

    /* -------------------------------- аудит --------------------------------- */

    addAudit({ at, action, actorId = null, actorLabel = null, targetId = null, targetLabel = null, result = 'ok', details = null }) {
      const search = `${action} ${actorLabel || ''} ${targetLabel || ''} ${actorId || ''} ${targetId || ''}`.toLowerCase();
      return Number(statements.insertAudit.run(at, action, actorId, actorLabel, targetId, targetLabel, result, details ? JSON.stringify(details) : null, search).lastInsertRowid);
    },
    listAudit({ filters = {}, sort = 'at', dir = 'desc', limit = 25, offset = 0 } = {}) {
      const { sql, params } = auditFilter(filters);
      const order = Object.hasOwn(AUDIT_SORT, sort) ? AUDIT_SORT[sort] : AUDIT_SORT.at;
      const direction = dir === 'asc' ? 'ASC' : 'DESC';
      const rows = db.prepare(`SELECT * FROM audit_log a ${sql} ORDER BY ${order} ${direction}, a.id ${direction} LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const total = db.prepare(`SELECT COUNT(*) AS count FROM audit_log a ${sql}`).get(...params).count;
      return { rows: rows.map(toAudit), total };
    },
    auditActions: () => db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((row) => row.action),
    purgeAudit: (before) => statements.purgeAudit.run(before).changes,

    /* ------------------------------ блокировки ------------------------------ */

    addBlockEvent: ({ userId, at, action, until = null, reason = null, actorId = null, actorLabel = null }) =>
      statements.insertBlock.run(userId, at, action, until, reason, actorId, actorLabel),
    listBlockEvents: (userId, limit = 50) => statements.userBlocks.all(userId, limit).map((row) => ({
      id: row.id, at: row.at, action: row.action, until: row.until, reason: row.reason, actorId: row.actor_id, actorLabel: row.actor_label,
    })),

    /* ------------------------------ активность ------------------------------ */

    markActive: (userId, day) => statements.markActive.run(userId, day).changes > 0,
    /** Уникальные пользователи (без демо-копий) с активностью в днях [fromDay, toDay]. */
    countActiveUsers: (fromDay, toDay) => db.prepare(`SELECT COUNT(DISTINCT ua.user_id) AS count FROM user_activity ua
      JOIN users u ON u.id = ua.user_id WHERE u.demo_template IS NULL AND ua.day >= ? AND ua.day <= ?`).get(fromDay, toDay).count,
    dailyActiveUsers: (fromDay, toDay) => Object.fromEntries(db.prepare(`SELECT ua.day, COUNT(*) AS count FROM user_activity ua
      JOIN users u ON u.id = ua.user_id WHERE u.demo_template IS NULL AND ua.day >= ? AND ua.day <= ? GROUP BY ua.day`).all(fromDay, toDay)
      .map((row) => [row.day, row.count])),
    purgeActivity: (beforeDay) => statements.purgeActivity.run(beforeDay).changes,

    /* ------------------------------- аватары -------------------------------- */

    putAvatar: ({ userId, mime, data, etag, now }) => statements.putAvatar.run(userId, mime, data, etag, now),
    getAvatar(userId) {
      const row = statements.getAvatar.get(userId);
      return row ? { mime: row.mime, data: Buffer.from(row.data), etag: row.etag, updatedAt: row.updated_at } : null;
    },
    deleteAvatar: (userId) => statements.deleteAvatar.run(userId).changes > 0,

    /* ------------------------------ статистика ------------------------------ */

    userCounts() {
      const rows = db.prepare(`SELECT role, status, COUNT(*) AS count, SUM(must_change_password) AS must_change
        FROM users WHERE demo_template IS NULL GROUP BY role, status`).all();
      return rows.map((row) => ({ role: row.role, status: row.status, count: row.count, mustChange: row.must_change || 0 }));
    },
    countUsersCreated: ({ since, until = Number.MAX_SAFE_INTEGER }) =>
      db.prepare('SELECT COUNT(*) AS count FROM users WHERE demo_template IS NULL AND created_at >= ? AND created_at < ?').get(since, until).count,
    userCreationSeries({ since, bucketMs, buckets }) {
      const rows = db.prepare(`SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucket, COUNT(*) AS count FROM users
        WHERE demo_template IS NULL AND created_at >= ? AND created_at < ? GROUP BY bucket`).all(since, bucketMs, since, since + bucketMs * buckets);
      const series = Array(buckets).fill(0);
      for (const row of rows) if (row.bucket >= 0 && row.bucket < buckets) series[row.bucket] = row.count;
      return series;
    },
    recentUsers: (limit = 5) => db.prepare(`SELECT u.*, a.etag AS avatar_etag FROM users u LEFT JOIN avatars a ON a.user_id = u.id
      WHERE u.demo_template IS NULL ORDER BY u.created_at DESC LIMIT ?`).all(limit).map(toUser),
    /** Проверка базы для мониторинга: размер и целостность заголовка. */
    health() {
      const pages = db.prepare('PRAGMA page_count').get().page_count;
      const pageSize = db.prepare('PRAGMA page_size').get().page_size;
      const ok = db.prepare('PRAGMA quick_check(1)').get().quick_check === 'ok';
      return { ok, bytes: pages * pageSize, schemaVersion: db.prepare('PRAGMA user_version').get().user_version };
    },
    /** Горячая копия базы (VACUUM INTO): файл не должен существовать. */
    backupTo(target) {
      if (fs.existsSync(target)) throw new Error('backup target exists');
      db.prepare('VACUUM INTO ?').run(target);
    },

    /* ------------------------- настройки и права ---------------------------- */

    listSettings: () => statements.listSettings.all().map((row) => ({ key: row.key, value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by })),
    putSettings(rows, actorId, now) {
      transaction(() => rows.forEach((row) => statements.putSetting.run(row.key, row.value, now, actorId)));
    },
    listRoleOverrides: () => Object.fromEntries(statements.listRoleOverrides.all().map((row) => [row.role, {
      permissions: parseJson(row.permissions) || [], updatedAt: row.updated_at, updatedBy: row.updated_by,
    }])),
    putRoleOverride: (role, permissions, actorId, now) => statements.putRoleOverride.run(role, JSON.stringify(permissions), now, actorId),
    deleteRoleOverride: (role) => statements.deleteRoleOverride.run(role).changes > 0,

    /* --------------------------- самостоятельная регистрация --------------------------- */

    createRegistration({ id, tokenHash, email, now, expiresAt, ipPrefix = null }) {
      db.prepare(`INSERT INTO registrations (id, token_hash, email, created_at, expires_at, ip_prefix)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, tokenHash, email, now, expiresAt, ipPrefix);
      return toRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(id));
    },
    getRegistrationByHash: (tokenHash) => toRegistration(db.prepare('SELECT * FROM registrations WHERE token_hash = ?').get(tokenHash)),
    getRegistrationByContext: (contextHash) => toRegistration(db.prepare('SELECT * FROM registrations WHERE context_hash = ?').get(contextHash)),
    getRegistrationById: (id) => (typeof id === 'string' ? toRegistration(db.prepare('SELECT * FROM registrations WHERE id = ?').get(id)) : null),
    /** Ссылка обменивается на контекст ровно один раз: второй вызов вернёт false. */
    openRegistration: ({ id, contextHash, contextExpiresAt, now }) => db.prepare(`UPDATE registrations SET opened_at = ?, context_hash = ?, context_expires_at = ?
      WHERE id = ? AND opened_at IS NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`).run(now, contextHash, contextExpiresAt, id, now).changes > 0,
    useRegistration: (id, now, userId) => db.prepare(`UPDATE registrations SET used_at = ?, user_id = ?, context_hash = NULL, context_expires_at = NULL
      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`).run(now, userId, id).changes > 0,
    /** Отозвать все неиспользованные заявки на этот email (кроме exceptId). */
    revokeRegistrations: (email, reason, now, { exceptId = '' } = {}) => db.prepare(`UPDATE registrations SET revoked_at = ?, revoked_reason = ?,
      context_hash = NULL, context_expires_at = NULL WHERE email = ? AND id <> ? AND used_at IS NULL AND revoked_at IS NULL`).run(now, reason, email, exceptId).changes,
    setRegistrationDelivery: (id, status) => db.prepare('UPDATE registrations SET delivery_status = ? WHERE id = ?').run(status, id).changes > 0,
    countRecentRegistrations: ({ email, since }) => db.prepare('SELECT COUNT(*) AS count FROM registrations WHERE email = ? AND created_at >= ?').get(email, since).count,
    purgeRegistrations: (before) => db.prepare('DELETE FROM registrations WHERE expires_at < ? AND (context_expires_at IS NULL OR context_expires_at < ?)').run(before, before).changes,

    /* ----------------------------------- MFA ----------------------------------- */

    insertFactor({
      id, userId, type, label, status, secretEnc = null, credentialId = null, publicKey = null, algorithm = null, signCount = 0,
      transports = null, backedUp = null, userVerified = null, now, confirmedAt = null, expiresAt = null,
    }) {
      db.prepare(`INSERT INTO mfa_factors (id, user_id, type, label, status, secret_enc, credential_id, public_key, algorithm, sign_count,
        transports, backed_up, user_verified, created_at, confirmed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, userId, type, label, status, secretEnc, credentialId, publicKey, algorithm, signCount, transports,
          backedUp === null ? null : Number(backedUp), userVerified === null ? null : Number(userVerified), now, confirmedAt, expiresAt);
      return toFactor(db.prepare('SELECT * FROM mfa_factors WHERE id = ?').get(id));
    },
    getFactor: (id) => (typeof id === 'string' ? toFactor(db.prepare('SELECT * FROM mfa_factors WHERE id = ?').get(id)) : null),
    getFactorByCredentialId: (credentialId) => (typeof credentialId === 'string'
      ? toFactor(db.prepare('SELECT * FROM mfa_factors WHERE credential_id = ?').get(credentialId)) : null),
    listFactors: (userId, { status = 'active' } = {}) => db.prepare(`SELECT * FROM mfa_factors WHERE user_id = ? ${status ? 'AND status = ?' : ''}
      ORDER BY created_at ASC, id ASC`).all(...(status ? [userId, status] : [userId])).map(toFactor),
    countActiveFactors: (userId) => db.prepare("SELECT COUNT(*) AS count FROM mfa_factors WHERE user_id = ? AND status = 'active'").get(userId).count,
    activateFactor: (id, { now, lastStep = null }) => db.prepare(`UPDATE mfa_factors SET status = 'active', confirmed_at = ?, last_step = COALESCE(?, last_step),
      expires_at = NULL WHERE id = ? AND status = 'pending'`).run(now, lastStep, id).changes > 0,
    /*
     * Шаг TOTP принимается, только если он новее последнего принятого:
     * один и тот же код дважды не сработает (защита от повтора), даже из
     * двух вкладок одновременно — проверка и запись одним UPDATE.
     */
    acceptTotpStep: (id, step, now) => db.prepare(`UPDATE mfa_factors SET last_step = ?, last_used_at = ?
      WHERE id = ? AND status = 'active' AND (last_step IS NULL OR last_step < ?)`).run(step, now, id, step).changes > 0,
    acceptWebauthnCounter: (id, signCount, now) => db.prepare(`UPDATE mfa_factors SET sign_count = ?, last_used_at = ?
      WHERE id = ? AND status = 'active' AND (? = 0 OR sign_count < ?)`).run(signCount, now, id, signCount, signCount).changes > 0,
    /** Ключ доступа впервые проверил человека (PIN, биометрия): дальше для сотрудника проверка обязательна. */
    markFactorUserVerified: (id) => db.prepare("UPDATE mfa_factors SET user_verified = 1 WHERE id = ? AND type = 'webauthn' AND status = 'active'").run(id).changes > 0,
    renameFactor: (id, label) => db.prepare("UPDATE mfa_factors SET label = ? WHERE id = ? AND status = 'active'").run(label, id).changes > 0,
    revokeFactor: (id, now) => db.prepare("UPDATE mfa_factors SET status = 'revoked', revoked_at = ?, secret_enc = NULL WHERE id = ? AND status <> 'revoked'")
      .run(now, id).changes > 0,
    revokeUserFactors: (userId, now) => db.prepare("UPDATE mfa_factors SET status = 'revoked', revoked_at = ?, secret_enc = NULL WHERE user_id = ? AND status <> 'revoked'")
      .run(now, userId).changes,
    deletePendingFactors: (userId) => db.prepare("DELETE FROM mfa_factors WHERE user_id = ? AND status = 'pending'").run(userId).changes,
    purgeFactors: (now) => db.prepare("DELETE FROM mfa_factors WHERE (status = 'pending' AND expires_at < ?) OR (status = 'revoked' AND revoked_at < ?)")
      .run(now, now - 90 * 24 * 60 * 60 * 1000).changes,

    replaceRecoveryCodes(userId, hashes, now) {
      transaction(() => {
        db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId);
        const insert = db.prepare('INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)');
        for (const hash of hashes) insert.run(userId, hash, now);
      });
    },
    /** Код срабатывает один раз: второй вызов с тем же кодом вернёт false. */
    useRecoveryCode: (userId, hash, now) => db.prepare('UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
      .run(now, userId, hash).changes > 0,
    countRecoveryCodes: (userId) => db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS unused
      FROM mfa_recovery_codes WHERE user_id = ?`).get(userId),
    deleteRecoveryCodes: (userId) => db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(userId).changes,

    /* --------------------------- вызовы второго шага --------------------------- */

    createChallenge({ idHash, userId, purpose, now, expiresAt, challenge = null, data = null }) {
      db.prepare(`INSERT INTO auth_challenges (id_hash, user_id, purpose, created_at, expires_at, challenge, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(idHash, userId, purpose, now, expiresAt, challenge, data ? JSON.stringify(data) : null);
    },
    getChallenge: (idHash) => toChallenge(db.prepare('SELECT * FROM auth_challenges WHERE id_hash = ?').get(idHash)),
    /** Попытка засчитана; вернёт новое число попыток (атомарно). */
    addChallengeAttempt(idHash) {
      return transaction(() => {
        db.prepare('UPDATE auth_challenges SET attempts = attempts + 1 WHERE id_hash = ?').run(idHash);
        return db.prepare('SELECT attempts FROM auth_challenges WHERE id_hash = ?').get(idHash)?.attempts ?? Number.MAX_SAFE_INTEGER;
      });
    },
    setChallengeValue: (idHash, challenge) => db.prepare('UPDATE auth_challenges SET challenge = ? WHERE id_hash = ? AND consumed_at IS NULL')
      .run(challenge, idHash).changes > 0,
    /** Вызов используется один раз: второй вызов вернёт false (две вкладки, повтор запроса). */
    consumeChallenge: (idHash, now) => db.prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id_hash = ? AND consumed_at IS NULL AND expires_at > ?')
      .run(now, idHash, now).changes > 0,
    deleteChallenge: (idHash) => db.prepare('DELETE FROM auth_challenges WHERE id_hash = ?').run(idHash).changes > 0,
    deleteUserChallenges: (userId, purpose = null) => db.prepare(`DELETE FROM auth_challenges WHERE user_id = ? ${purpose ? 'AND purpose = ?' : ''}`)
      .run(...(purpose ? [userId, purpose] : [userId])).changes,
    purgeChallenges: (now) => db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(now).changes,

    /* ------------------------- счётчики попыток входа -------------------------- */

    getThrottle: (key) => toThrottle(db.prepare('SELECT * FROM auth_throttle WHERE key = ?').get(key)),
    putThrottle({ key, failures, windowStart, lockedUntil = null, lockCount = 0, data = null, now }) {
      db.prepare(`INSERT INTO auth_throttle (key, failures, window_start, locked_until, lock_count, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until,
        lock_count = excluded.lock_count, data = excluded.data, updated_at = excluded.updated_at`)
        .run(key, failures, windowStart, lockedUntil, lockCount, data ? JSON.stringify(data) : null, now);
    },
    deleteThrottle: (key) => db.prepare('DELETE FROM auth_throttle WHERE key = ?').run(key).changes > 0,
    /** Ключи с этим окончанием (например, все пары «адрес + этот аккаунт»). */
    listThrottleBySuffix: (suffix) => db.prepare("SELECT * FROM auth_throttle WHERE key LIKE ? ESCAPE '\\'")
      .all(`%${String(suffix).replace(/[\\%_]/g, (char) => `\\${char}`)}`).map(toThrottle),
    deleteThrottleBySuffix: (suffix) => db.prepare("DELETE FROM auth_throttle WHERE key LIKE ? ESCAPE '\\'")
      .run(`%${String(suffix).replace(/[\\%_]/g, (char) => `\\${char}`)}`).changes,
    purgeThrottle: (before, now) => db.prepare('DELETE FROM auth_throttle WHERE updated_at < ? AND (locked_until IS NULL OR locked_until < ?)')
      .run(before, now).changes,

    /* --------------------------- доверенные устройства --------------------------- */

    addTrustedDevice: ({ tokenHash, userId, now, expiresAt }) => db.prepare(`INSERT INTO trusted_devices (token_hash, user_id, created_at, last_used_at, expires_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_hash, user_id) DO UPDATE SET last_used_at = excluded.last_used_at, expires_at = excluded.expires_at`)
      .run(tokenHash, userId, now, now, expiresAt),
    /** Устройство, с которого этот пользователь уже входил (или null). */
    getTrustedDevice(tokenHash, userId) {
      const row = db.prepare('SELECT * FROM trusted_devices WHERE token_hash = ? AND user_id = ?').get(tokenHash, userId);
      return row ? { tokenHash: row.token_hash, userId: row.user_id, createdAt: row.created_at, lastUsedAt: row.last_used_at, expiresAt: row.expires_at } : null;
    },
    countTrustedDevices: (userId, now) => db.prepare('SELECT COUNT(*) AS count FROM trusted_devices WHERE user_id = ? AND expires_at > ?').get(userId, now).count,
    deleteUserDevices: (userId) => db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(userId).changes,
    purgeDevices: (now) => db.prepare('DELETE FROM trusted_devices WHERE expires_at < ?').run(now).changes,

    /* ------------------------------ почтовая очередь ------------------------------ */

    enqueueMail({ id, kind, toHash, toAddress, payload, keyId = null, nextAttemptAt, sourceKey = null, refType = null, refId = null, expiresAt = null, now }) {
      db.prepare(`INSERT INTO mail_outbox (id, kind, to_hash, to_address, payload, key_id, status, attempts, next_attempt_at, source_key, ref_type, ref_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`).run(id, kind, toHash, toAddress, payload, keyId, nextAttemptAt, sourceKey, refType, refId, expiresAt, now);
    },
    getMail: (id) => toMail(db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id)),
    /** Забрать до limit писем, которым пора уходить: статус sending ставится атомарно, второй обработчик их не получит. */
    claimDueMail(now, limit = 5) {
      return transaction(() => {
        const rows = db.prepare("SELECT * FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC LIMIT ?").all(now, limit);
        const claim = db.prepare("UPDATE mail_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'");
        return rows.filter((row) => claim.run(row.id).changes > 0).map((row) => toMail({ ...row, attempts: row.attempts + 1, status: 'sending' }));
      });
    },
    /** Забрать одно письмо по id (отправка сразу): null, если его уже взял цикл очереди. */
    claimMail(id) {
      const claimed = db.prepare("UPDATE mail_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").run(id).changes > 0;
      return claimed ? toMail(db.prepare('SELECT * FROM mail_outbox WHERE id = ?').get(id)) : null;
    },
    markMailSent: (id, now) => db.prepare("UPDATE mail_outbox SET status = 'sent', sent_at = ?, to_address = NULL, payload = NULL, last_error = NULL WHERE id = ?")
      .run(now, id).changes > 0,
    markMailRetry: (id, nextAttemptAt, error) => db.prepare("UPDATE mail_outbox SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?")
      .run(nextAttemptAt, error, id).changes > 0,
    markMailFailed: (id, error) => db.prepare("UPDATE mail_outbox SET status = 'failed', last_error = ?, to_address = NULL, payload = NULL WHERE id = ?")
      .run(error, id).changes > 0,
    /** Письма, «застрявшие» в sending после падения процесса, — обратно в очередь. */
    releaseStuckMail: (olderThan) => db.prepare("UPDATE mail_outbox SET status = 'pending' WHERE status = 'sending' AND next_attempt_at < ?").run(olderThan).changes,
    listPendingMail: () => db.prepare("SELECT * FROM mail_outbox WHERE status IN ('pending', 'sending')").all().map(toMail),
    countMailTo: ({ toHash, since, kinds = null }) => db.prepare(`SELECT COUNT(*) AS count FROM mail_outbox WHERE to_hash = ? AND created_at >= ?
      ${kinds ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : ''}`).get(toHash, since, ...(kinds || [])).count,
    countMailFromSource: ({ sourceKey, since }) => db.prepare('SELECT COUNT(*) AS count FROM mail_outbox WHERE source_key = ? AND created_at >= ?').get(sourceKey, since).count,
    countPendingMail: () => db.prepare("SELECT COUNT(*) AS count FROM mail_outbox WHERE status IN ('pending', 'sending')").get().count,
    mailStats: (since) => Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS count FROM mail_outbox WHERE created_at >= ? GROUP BY status').all(since)
      .map((row) => [row.status, row.count])),
    purgeMail: (before) => db.prepare("DELETE FROM mail_outbox WHERE created_at < ? AND status IN ('sent', 'failed')").run(before).changes,

    /** Копия базы, сделанная перед миграцией при этом запуске (или null). */
    migrationBackup,

    /* --------------------------- согласия и документы --------------------------- */

    /** Последняя запись журнала согласий человека (для сцепления хэшей). */
    lastConsentRecord: (userId) => toConsentRecord(db.prepare('SELECT * FROM consent_log WHERE user_id = ? ORDER BY seq DESC LIMIT 1').get(userId)),
    insertConsentRecord({ id, userId, purpose, kind, action, document = null, version = null, documentHash = null, method, at, prevHash, hash }) {
      db.prepare(`INSERT INTO consent_log (id, user_id, purpose, kind, action, document, version, document_hash, method, at, prev_hash, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, purpose, kind, action, document, version, documentHash, method, at, prevHash, hash);
      return toConsentRecord(db.prepare('SELECT * FROM consent_log WHERE id = ?').get(id));
    },
    listConsentRecords: (userId) => db.prepare('SELECT * FROM consent_log WHERE user_id = ? ORDER BY seq ASC').all(userId).map(toConsentRecord),
    /** Все записи по порядку — для проверки цепочек (CLI, тесты). */
    allConsentRecords: () => db.prepare('SELECT * FROM consent_log ORDER BY seq ASC').all().map(toConsentRecord),
    countConsentRecords: () => db.prepare('SELECT COUNT(*) AS count FROM consent_log').get().count,
    /**
     * Записи удалённых аккаунтов, срок хранения которых (3 года после
     * последней записи) истёк. Удаление раньше срока база не допустит.
     */
    purgeConsentRecords(before) {
      const users = db.prepare(`SELECT user_id FROM consent_log c WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id)
        GROUP BY user_id HAVING MAX(at) < ?`).all(before).map((row) => row.user_id);
      let removed = 0;
      for (const userId of users) {
        try {
          removed += db.prepare('DELETE FROM consent_log WHERE user_id = ?').run(userId).changes;
        } catch {
          // Триггер срока хранения считает по настоящему времени — не удаляем, если он против.
        }
      }
      return removed;
    },

    /* ------------------------- обращения субъектов ПДн ------------------------- */

    insertPrivacyRequest({ id, userId, subjectLabel, type, message = null, createdAt, dueAt }) {
      db.prepare(`INSERT INTO privacy_requests (id, user_id, subject_label, type, status, message, created_at, due_at, updated_at)
        VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?)`).run(id, userId, subjectLabel, type, message, createdAt, dueAt, createdAt);
      return toPrivacyRequest(db.prepare('SELECT * FROM privacy_requests WHERE id = ?').get(id));
    },
    getPrivacyRequest: (id) => (typeof id === 'string' ? toPrivacyRequest(db.prepare('SELECT * FROM privacy_requests WHERE id = ?').get(id)) : null),
    listUserPrivacyRequests: (userId, limit = 50) => db.prepare('SELECT * FROM privacy_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit).map(toPrivacyRequest),
    countOpenPrivacyRequests: (userId) => db.prepare("SELECT COUNT(*) AS count FROM privacy_requests WHERE user_id = ? AND status IN ('received', 'in_progress')")
      .get(userId).count,
    listPrivacyRequests({ status = null, limit = 50, offset = 0 } = {}) {
      const where = status ? 'WHERE status = ?' : '';
      const params = status ? [status] : [];
      const rows = db.prepare(`SELECT * FROM privacy_requests ${where} ORDER BY CASE WHEN status IN ('received', 'in_progress') THEN 0 ELSE 1 END, due_at ASC, created_at DESC
        LIMIT ? OFFSET ?`).all(...params, limit, offset).map(toPrivacyRequest);
      const total = db.prepare(`SELECT COUNT(*) AS count FROM privacy_requests ${where}`).get(...params).count;
      const open = db.prepare("SELECT COUNT(*) AS count FROM privacy_requests WHERE status IN ('received', 'in_progress')").get().count;
      return { rows, total, open };
    },
    /** Изменить обращение, только если его статус — один из expected (защита от гонки двух сотрудников). */
    updatePrivacyRequest(id, fields, { expected, now }) {
      const columns = {
        status: 'status', dueAt: 'due_at', extendedAt: 'extended_at', extensionReason: 'extension_reason', closedAt: 'closed_at',
        response: 'response', handledBy: 'handled_by', handledLabel: 'handled_label', message: 'message',
      };
      const sets = [];
      const params = [];
      for (const [key, column] of Object.entries(columns)) {
        if (key in fields) {
          sets.push(`${column} = ?`);
          params.push(fields[key]);
        }
      }
      sets.push('updated_at = ?');
      params.push(now);
      const placeholders = expected.map(() => '?').join(', ');
      return db.prepare(`UPDATE privacy_requests SET ${sets.join(', ')} WHERE id = ? AND status IN (${placeholders})`)
        .run(...params, id, ...expected).changes > 0;
    },
    /** Текст обращений удалённого человека не хранится: остаются вид, сроки и ответ. */
    /**
     * Удаление аккаунта: в записях журнала действий, где аккаунт сам был
     * автором (регистрация, удаление себя), имя и замаскированный email
     * заменяются меткой. Записи о действиях сотрудников над аккаунтом
     * сохраняют метку до срока хранения журнала — это подотчётность персонала.
     */
    pseudonymizeAuditActor(userId, label) {
      const rows = db.prepare('SELECT id, action, actor_id, target_id, target_label FROM audit_log WHERE actor_id = ?').all(userId);
      const update = db.prepare('UPDATE audit_log SET actor_label = ?, target_label = ?, search_text = ? WHERE id = ?');
      for (const row of rows) {
        const targetLabel = row.target_id === userId ? label : row.target_label;
        const search = `${row.action} ${label} ${targetLabel || ''} ${row.actor_id || ''} ${row.target_id || ''}`.toLowerCase();
        update.run(label, targetLabel, search, row.id);
      }
      return rows.length;
    },
    clearPrivacyRequestMessages: (userId) => db.prepare('UPDATE privacy_requests SET message = NULL WHERE user_id = ?').run(userId).changes,
    purgePrivacyRequests: (before) => db.prepare("DELETE FROM privacy_requests WHERE status IN ('completed', 'rejected') AND closed_at < ?").run(before).changes,

    /** Письма на адрес удалённого аккаунта: неотправленные и записи для лимитов. */
    deleteMailForAddress: (toHash) => db.prepare('DELETE FROM mail_outbox WHERE to_hash = ?').run(toHash).changes,
    /** Заявки на регистрацию с этим адресом (после удаления аккаунта они не нужны). */
    deleteRegistrationsForEmail: (email) => db.prepare('DELETE FROM registrations WHERE email = ?').run(email).changes,

    close: () => db.close(),
  });
};
