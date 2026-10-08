/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Журнал событий аналитики: по файлу JSON Lines на день.
 *
 * Почему файлы, а не база: сервер — одно ядро и 2 ГБ, событий на этапе
 * пилота — тысячи в день, а отчёт читает их раз в день скриптом. Добавление
 * строки в файл не требует ни зависимостей, ни отдельного процесса.
 *
 * Что пишется: только проверенное событие из shared/analytics.js плюс время
 * сервера, округлённое до минуты. IP-адреса, заголовков и User-Agent здесь
 * нет: связать событие с человеком журнал не позволяет.
 *
 * Защита диска: потолок событий в сутки и срок хранения. Без потолка
 * один скрипт, шлющий события в цикле, заполнил бы диск сервера.
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const FILE_PATTERN = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** День по Казани: отчёт «за вчера» должен совпадать с календарём клиники. */
const kazanDay = (date) => {
  const shifted = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
};

/** Время до минуты: точнее для отчётов не нужно, а лишняя точность — лишний след. */
const minuteStamp = (date) => `${date.toISOString().slice(0, 16)}Z`;

/**
 * @param {object} options
 * @param {string} options.dir каталог журнала
 * @param {number} [options.maxEventsPerDay] потолок записей в сутки
 * @param {number} [options.retentionDays] сколько дней хранить файлы
 * @param {() => Date} [options.now]
 * @param {{warn: Function}} [options.logger]
 */
export const createEventStore = ({
  dir,
  // 50 тысяч в сутки — с запасом для пилота. Прежние 200 тысяч давали до
  // 90 МБ мусора в день, если журнал заливали скриптом.
  maxEventsPerDay = 50_000,
  retentionDays = 180,
  // Потолок на весь каталог: старые файлы удаляются раньше срока, если журнал
  // разросся. Диск сервера важнее полугода истории.
  maxTotalBytes = 500 * 1024 * 1024,
  now = () => new Date(),
  logger = null,
}) => {
  let queue = Promise.resolve();
  let currentDay = null;
  let writtenToday = 0;
  let dirReady = null;
  let lastPrunedDay = null;

  const ensureDir = () => {
    dirReady ||= fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch((error) => {
      dirReady = null;
      throw error;
    });
    return dirReady;
  };

  /** Удаляет файлы старше срока хранения. Чужие файлы в каталоге не трогает. */
  const prune = async (reference = now()) => {
    const cutoff = new Date(reference.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoffDay = kazanDay(cutoff);
    let removed = 0;
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    const kept = [];
    for (const name of entries) {
      const match = name.match(FILE_PATTERN);
      if (!match) continue;
      if (match[1] < cutoffDay) {
        await fs.rm(path.join(dir, name), { force: true });
        removed += 1;
      } else {
        kept.push(name);
      }
    }

    // Самые старые файлы уходят первыми, пока каталог не уложится в потолок.
    kept.sort();
    const sizes = await Promise.all(
      kept.map((name) => fs.stat(path.join(dir, name)).then((stats) => stats.size).catch(() => 0)),
    );
    let total = sizes.reduce((sum, size) => sum + size, 0);
    for (let index = 0; index < kept.length - 1 && total > maxTotalBytes; index += 1) {
      await fs.rm(path.join(dir, kept[index]), { force: true });
      total -= sizes[index];
      removed += 1;
    }
    return removed;
  };

  /** Сколько событий уже записано за день — после перезапуска сервера. */
  const countExisting = (day) =>
    /*
     * Потоком, а не readFile: файл за день может весить десятки мегабайт, и
     * при перезапуске он целиком читался в память.
     */
    new Promise((resolve) => {
      let count = 0;
      const stream = createReadStream(path.join(dir, `events-${day}.jsonl`));
      stream.on('data', (chunk) => {
        for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) count += 1;
      });
      stream.on('end', () => resolve(count));
      stream.on('error', () => resolve(count));
    });

  /**
   * Добавляет проверенные события. Записи идут строго по очереди: две
   * параллельные записи в один файл могли бы перемешать строки.
   *
   * @param {object[]} events уже прошедшие sanitizeEvent
   * @returns {Promise<{accepted: number, dropped: number}>}
   */
  const append = (events) => {
    const task = queue.then(async () => {
      if (!Array.isArray(events) || events.length === 0) return { accepted: 0, dropped: 0 };

      const date = now();
      const day = kazanDay(date);
      await ensureDir();

      if (day !== currentDay) {
        currentDay = day;
        writtenToday = await countExisting(day);
        if (lastPrunedDay !== day) {
          lastPrunedDay = day;
          prune(date).catch(() => {});
        }
      }

      const room = Math.max(0, maxEventsPerDay - writtenToday);
      const accepted = events.slice(0, room);
      const dropped = events.length - accepted.length;
      if (accepted.length > 0) {
        const ts = minuteStamp(date);
        const lines = accepted.map((event) => `${JSON.stringify({ ts, ...event })}\n`).join('');
        await fs.appendFile(path.join(dir, `events-${day}.jsonl`), lines, { mode: 0o600 });
        writtenToday += accepted.length;
      }
      if (dropped > 0) {
        logger?.warn?.('analytics.daily_cap_reached', { dropped });
      }
      return { accepted: accepted.length, dropped };
    });

    // Ошибка одной записи не должна ломать очередь для следующих.
    queue = task.catch(() => {});
    return task;
  };

  return Object.freeze({ append, prune, dir });
};

export const __private = { kazanDay, minuteStamp, FILE_PATTERN };
