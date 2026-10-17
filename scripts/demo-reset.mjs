#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * npm run demo:reset — удаляет все демо-записи и возвращает слоты расписания к
 * исходному (детерминированному) состоянию на 14 дней вперёд от «сегодня».
 * Трогает только базу демо-записи (var/demo/booking.sqlite или DEMO_BOOKING_DB_PATH).
 * Сервер можно не останавливать: сброс идёт одной транзакцией.
 *
 *   npm run demo:reset
 *   DEMO_NOW=2026-10-12T12:00:00+03:00 npm run demo:reset   # «замороженное» время
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { getDemoCatalog } from '../backend/demo/catalog.js';
import { demoNow, moscowParts } from '../backend/demo/time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // .env может не быть — работаем на переменных окружения.
  }
}

const DatabaseSync = await loadSqlite();
if (!DatabaseSync) {
  console.error(`Демо-запись требует Node 22.13+ (модуль node:sqlite). Сейчас: ${process.version}.`);
  process.exit(1);
}

const file = process.env.DEMO_BOOKING_DB_PATH || path.join(ROOT, 'var', 'demo', 'booking.sqlite');
const index = await getDemoCatalog();
const at = demoNow();
const store = createBookingStore({ DatabaseSync, file, index, now: () => at });
store.reset(at);
const stats = store.stats();
store.close();

const moment = moscowParts(at);
console.log(`Демо-записи сброшены: ${file.startsWith(ROOT) ? path.relative(ROOT, file) : file}`);
console.log(`Окно расписания: 14 дней от ${moment.day} (сейчас ${moment.time} МСК${process.env.DEMO_NOW ? ', время задано DEMO_NOW' : ''}).`);
console.log(`Слоты: свободно ${stats.FREE || 0}, занято ${stats.BOOKED || 0}, закрыто ${stats.BLOCKED || 0}.`);
