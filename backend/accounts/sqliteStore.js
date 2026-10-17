/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Хранилище личного кабинета на SQLite (node:sqlite, встроен в Node 22.13+).
 *
 * SQLite, а не PostgreSQL: сервер — 1 ядро и 2 ГБ, данных у кабинета немного,
 * отдельный процесс СУБД не нужен. Остальной код работает только через методы
 * ниже: для перехода на PostgreSQL достаточно модуля с теми же методами
 * (см. docs/accounts.md).
 *
 * Что хранится — и ничего больше:
 *   users     — email, имя, хэш пароля, id программы ДМС;
 *   sessions  — SHA-256 от токена сессии (сам токен — только в cookie);
 *   favorites — id врачей и учреждений из справочника.
 * Запросы к ассистенту, симптомы, координаты и история поиска сюда не пишутся.
 */

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

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
    passwordHash: row.password_hash,
    dmsPlanId: row.dms_plan_id,
    demoKey: row.demo_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  : null);

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
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000; PRAGMA secure_delete = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const statements = {
    insertUser: db.prepare(`INSERT INTO users (id, email, display_name, password_hash, dms_plan_id, demo_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userByDemoKey: db.prepare('SELECT * FROM users WHERE demo_key = ?'),
    updateName: db.prepare('UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?'),
    updatePlan: db.prepare('UPDATE users SET dms_plan_id = ?, updated_at = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    countUsers: db.prepare('SELECT COUNT(*) AS count FROM users'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionByHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    countUserSessions: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?'),
    oldestUserSession: db.prepare('SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at ASC LIMIT 1'),
    listFavorites: db.prepare('SELECT item_id FROM favorites WHERE user_id = ? ORDER BY created_at DESC, item_id ASC'),
    countFavorites: db.prepare('SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?'),
    addFavorite: db.prepare('INSERT OR IGNORE INTO favorites (user_id, item_id, created_at) VALUES (?, ?, ?)'),
    removeFavorite: db.prepare('DELETE FROM favorites WHERE user_id = ? AND item_id = ?'),
    clearFavorites: db.prepare('DELETE FROM favorites WHERE user_id = ?'),
  };

  const transaction = (work) => {
    db.exec('BEGIN');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return Object.freeze({
    kind: 'sqlite',

    createUser({ id, email, displayName, passwordHash = null, dmsPlanId = null, demoKey = null, now }) {
      statements.insertUser.run(id, email, displayName, passwordHash, dmsPlanId, demoKey, now, now);
      return toUser(statements.userById.get(id));
    },
    getUserById: (id) => toUser(statements.userById.get(id)),
    getUserByEmail: (email) => toUser(statements.userByEmail.get(email)),
    getUserByDemoKey: (key) => toUser(statements.userByDemoKey.get(key)),
    updateDisplayName: (id, displayName, now) => statements.updateName.run(displayName, now, id).changes > 0,
    updateDmsPlan: (id, planId, now) => statements.updatePlan.run(planId, now, id).changes > 0,
    deleteUser: (id) => statements.deleteUser.run(id).changes > 0,
    countUsers: () => statements.countUsers.get().count,

    createSession({ tokenHash, userId, now, expiresAt, maxPerUser }) {
      transaction(() => {
        // Не больше maxPerUser входов на аккаунт: самый старый вытесняется.
        while (statements.countUserSessions.get(userId).count >= maxPerUser) {
          statements.deleteSession.run(statements.oldestUserSession.get(userId).token_hash);
        }
        statements.insertSession.run(tokenHash, userId, now, expiresAt);
      });
    },
    getSession: (tokenHash) => {
      const row = statements.sessionByHash.get(tokenHash);
      return row ? { tokenHash: row.token_hash, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at } : null;
    },
    deleteSession: (tokenHash) => statements.deleteSession.run(tokenHash).changes > 0,
    deleteUserSessions: (userId) => statements.deleteUserSessions.run(userId).changes,
    purgeExpiredSessions: (now) => statements.purgeSessions.run(now).changes,

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

    close: () => db.close(),
  });
};
