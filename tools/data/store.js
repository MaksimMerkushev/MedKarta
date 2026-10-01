/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Хранилище сборщика: снимки источников и очередь ручной проверки.
 *
 *   data/collected/<источник>.json   последний принятый снимок источника
 *   data/review/pending.json         изменения, которые ждут человека
 *   data/review/rejected.json        отклонённые — повторно не предлагаются
 *
 * Файлы, а не база: их удобно смотреть в git diff — видно, что именно
 * поменялось в справочнике и кто это принял.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { applyChanges, EMPTY_RECORDS } from './collector.js';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** Запись через временный файл: оборванная запись не портит прежний снимок. */
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
};

export const createFileStore = ({ root }) => {
  const collected = path.join(root, 'data', 'collected');
  const reviewDir = path.join(root, 'data', 'review');
  const pendingFile = path.join(reviewDir, 'pending.json');
  const rejectedFile = path.join(reviewDir, 'rejected.json');

  const snapshotFile = (id) => {
    if (!SAFE_ID.test(id)) throw new Error(`недопустимый id источника: ${id}`);
    return path.join(collected, `${id}.json`);
  };

  const store = {
    readSnapshot: (id) => readJson(snapshotFile(id), null),
    saveSnapshot: (snapshot) => writeJson(snapshotFile(snapshot.sourceId), snapshot),
    listSnapshots: async () => {
      const names = await fs.readdir(collected).catch(() => []);
      const snapshots = await Promise.all(
        names.filter((name) => name.endsWith('.json')).map((name) => readJson(path.join(collected, name), null)),
      );
      return snapshots.filter(Boolean);
    },
    readPending: () => readJson(pendingFile, []),
    readRejected: async () => new Set(await readJson(rejectedFile, [])),
    enqueue: async (items) => {
      if (items.length === 0) return;
      const pending = await readJson(pendingFile, []);
      const known = new Set(pending.map((item) => item.id));
      await writeJson(pendingFile, [...pending, ...items.filter((item) => !known.has(item.id))]);
    },

    /** Принять изменение: применить к снимку и убрать из очереди. */
    accept: async (id) => {
      const pending = await readJson(pendingFile, []);
      const item = pending.find((entry) => entry.id === id);
      if (!item) return null;
      if (['clinic', 'doctor', 'price', 'unmatched_price'].includes(item.kind)) {
        const snapshot = await store.readSnapshot(item.sourceId);
        const records = snapshot?.records || EMPTY_RECORDS;
        await store.saveSnapshot({ ...snapshot, sourceId: item.sourceId, records: applyChanges(records, [item]) });
      }
      await writeJson(pendingFile, pending.filter((entry) => entry.id !== id));
      return item;
    },

    /** Отклонить: убрать из очереди и больше не предлагать то же самое. */
    reject: async (id) => {
      const pending = await readJson(pendingFile, []);
      const item = pending.find((entry) => entry.id === id);
      if (!item) return null;
      const rejected = await readJson(rejectedFile, []);
      await writeJson(rejectedFile, [...new Set([...rejected, id])]);
      await writeJson(pendingFile, pending.filter((entry) => entry.id !== id));
      return item;
    },
  };
  return store;
};

/** Хранилище в памяти — для тестов. */
export const createMemoryStore = () => {
  const snapshots = new Map();
  let pending = [];
  const rejected = new Set();
  const store = {
    readSnapshot: async (id) => structuredClone(snapshots.get(id) ?? null),
    saveSnapshot: async (snapshot) => { snapshots.set(snapshot.sourceId, structuredClone(snapshot)); },
    listSnapshots: async () => [...snapshots.values()].map((snapshot) => structuredClone(snapshot)),
    readPending: async () => structuredClone(pending),
    readRejected: async () => new Set(rejected),
    enqueue: async (items) => {
      const known = new Set(pending.map((item) => item.id));
      pending = [...pending, ...items.filter((item) => !known.has(item.id))];
    },
    accept: async (id) => {
      const item = pending.find((entry) => entry.id === id);
      if (!item) return null;
      const snapshot = snapshots.get(item.sourceId);
      if (snapshot && ['clinic', 'doctor', 'price', 'unmatched_price'].includes(item.kind)) snapshot.records = applyChanges(snapshot.records, [item]);
      pending = pending.filter((entry) => entry.id !== id);
      return item;
    },
    reject: async (id) => {
      const item = pending.find((entry) => entry.id === id);
      if (!item) return null;
      rejected.add(id);
      pending = pending.filter((entry) => entry.id !== id);
      return item;
    },
  };
  return store;
};
