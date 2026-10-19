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

const SCHEMA_VERSION = 4;

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
];

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
  }
  : null);

const toAccessToken = (row) => (row
  ? {
    id: row.id,
    tokenHash: row.token_hash,
    userId: row.user_id,
    purpose: row.purpose,
    email: row.email,
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
      demo_template, demo_owner, role, status, must_change_password, password_changed_at, created_by, search_text, activated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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
      activated_at = COALESCE(activated_at, ?), failed_logins = 0, updated_at = ?, version = version + 1 WHERE id = ?`),

    insertAccessToken: db.prepare(`INSERT INTO access_tokens (id, token_hash, user_id, purpose, email, source, delivery, delivery_status,
      created_at, expires_at, created_by, created_by_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
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

    insertSession: db.prepare(`INSERT INTO sessions (token_hash, public_id, user_id, created_at, last_seen_at, expires_at, client, ip_prefix)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
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
      demoTemplate = null, demoOwner = null, role = 'user', status = 'active', mustChangePassword = false, createdBy = null, now,
    }) {
      const name = displayName || `${firstName} ${lastName}`.trim();
      const activatedAt = passwordHash || demoTemplate ? now : null;
      statements.insertUser.run(
        id, email, name, firstName, lastName, passwordHash, dmsPlanId, demoTemplate, demoOwner, role, status,
        mustChangePassword ? 1 : 0, passwordHash ? now : null, createdBy, searchTextOf({ firstName, lastName, email, id }), activatedAt, now, now,
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
    activateUser: (id, passwordHash, now) => statements.activateUser.run(passwordHash, now, now, now, id).changes > 0,
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

    createSession({ tokenHash, publicId, userId, now, expiresAt, maxPerUser, client = null, ipPrefix = null }) {
      transaction(() => {
        // Не больше maxPerUser входов на аккаунт: самый старый вытесняется.
        while (statements.countUserSessions.get(userId).count >= maxPerUser) {
          statements.deleteSession.run(statements.oldestUserSession.get(userId).token_hash);
        }
        statements.insertSession.run(tokenHash, publicId, userId, now, now, expiresAt, client, ipPrefix);
      });
    },
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

    createAccessToken({ id, tokenHash, userId, purpose, email, source, delivery, deliveryStatus, now, expiresAt, createdBy = null, createdByLabel = null }) {
      statements.insertAccessToken.run(id, tokenHash, userId, purpose, email, source, delivery, deliveryStatus, now, expiresAt, createdBy, createdByLabel);
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

    close: () => db.close(),
  });
};
