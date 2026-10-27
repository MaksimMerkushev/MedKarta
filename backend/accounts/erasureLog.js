/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Журнал удалений аккаунтов вне базы: строка JSON на удаление — только
 * случайный id аккаунта и время, без email и имени.
 *
 * Зачем: резервная копия базы, сделанная до удаления, содержит аккаунт.
 * Если базу восстановят из такой копии, удаление нужно повторить —
 * `npm run accounts -- reapply-erasures` берёт id отсюда (файл лежит рядом
 * с базой, но не внутри неё, поэтому восстановление старой копии его не
 * откатывает). Файл стоит копировать вместе с копиями базы
 * (docs/privacy/05-retention-and-destruction.md).
 */

import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-f0-9]{32}$/;

/**
 * @param {object} [options]
 * @param {string|null} [options.file] путь к файлу; null — только в памяти (тесты)
 */
export const createErasureLog = ({ file = null } = {}) => {
  const memory = [];
  return Object.freeze({
    file,
    append(userId, at = Date.now()) {
      if (typeof userId !== 'string' || !ID.test(userId)) return;
      const entry = { userId, at: new Date(at).toISOString() };
      if (!file) {
        memory.push(entry);
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    },
    list() {
      if (!file) return memory.map((entry) => ({ ...entry }));
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      return text.split('\n').filter(Boolean).flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return typeof entry?.userId === 'string' && ID.test(entry.userId) ? [{ userId: entry.userId, at: entry.at }] : [];
        } catch {
          return [];
        }
      });
    },
  });
};
