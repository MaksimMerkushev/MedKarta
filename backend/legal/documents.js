/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Редакции документов для пользователей (политика обработки ПДн,
 * пользовательское соглашение, проекты согласий).
 *
 * Каждая редакция — отдельный файл в legal/<документ>/<версия>.md, список
 * редакций и SHA-256 их текста — legal/manifest.json. Опубликованная
 * редакция не перезаписывается: журнал согласий хранит хэш текста, который
 * видел человек, и по нему можно доказать, что именно он принял. При запуске
 * хэш каждого файла сверяется с манифестом; файл, изменённый задним числом,
 * не выдаётся (и тест tests/privacy-152fz.test.js это ловит раньше).
 *
 * Документ с меткой «[ТРЕБУЕТСЯ ЗАПОЛНИТЬ ОПЕРАТОРОМ]» — черновик: на
 * странице он помечен, а открыть публичную регистрацию с ним нельзя
 * (backend/accounts/registration.js).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGAL_DOCUMENTS, LEGAL_PLACEHOLDER } from '../../shared/legal.js';
import { logger } from '../observability/safeLogger.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../legal', import.meta.url));
const VERSION = /^\d{4}-\d{2}-\d{2}(\.\d{1,2})?$/;

export const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * @param {object} [options]
 * @param {string} [options.dir] каталог legal/
 * @returns {{list, current, get, readiness, verify}}
 */
export const createLegalDocuments = ({ dir = DEFAULT_DIR } = {}) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const documents = new Map();
  const problems = [];

  for (const [key, entry] of Object.entries(manifest.documents || {})) {
    const info = LEGAL_DOCUMENTS[key];
    if (!info) {
      problems.push({ key, problem: 'unknown_document' });
      continue;
    }
    const versions = new Map();
    for (const item of entry.versions || []) {
      if (!VERSION.test(item.version)) {
        problems.push({ key, version: item.version, problem: 'bad_version' });
        continue;
      }
      const file = path.join(dir, item.file);
      if (!file.startsWith(dir + path.sep)) {
        problems.push({ key, version: item.version, problem: 'bad_path' });
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        problems.push({ key, version: item.version, problem: 'missing_file' });
        continue;
      }
      const hash = sha256Text(text);
      if (hash !== item.sha256) {
        // Опубликованную редакцию изменили задним числом: её текст больше не тот, что принимали.
        problems.push({ key, version: item.version, problem: 'hash_mismatch' });
        continue;
      }
      versions.set(item.version, Object.freeze({
        key,
        title: info.title,
        slug: info.slug,
        version: item.version,
        publishedAt: item.publishedAt || null,
        sha256: hash,
        draft: text.includes(LEGAL_PLACEHOLDER),
        status: entry.status || 'published',
        text,
      }));
    }
    documents.set(key, { current: entry.current, status: entry.status || 'published', versions });
  }

  for (const problem of problems) {
    logger.error('legal.document_invalid', { code: problem.problem });
  }

  const meta = (doc) => ({
    key: doc.key, title: doc.title, slug: doc.slug, version: doc.version, publishedAt: doc.publishedAt, sha256: doc.sha256, draft: doc.draft, status: doc.status,
  });

  const service = {
    /** Действующие редакции всех документов (без текста). */
    list() {
      return [...documents.entries()]
        .map(([key, entry]) => {
          const doc = entry.versions.get(entry.current);
          return doc ? { ...meta(doc), history: [...entry.versions.values()].map(meta).reverse() } : { key, missing: true };
        });
    },
    /** Действующая редакция документа или null. */
    current(key) {
      const entry = documents.get(key);
      return entry ? entry.versions.get(entry.current) || null : null;
    },
    /** Конкретная редакция (для истории и проверки принятого текста). */
    get(key, version) {
      const entry = documents.get(key);
      return entry && typeof version === 'string' ? entry.versions.get(version) || null : null;
    },
    history(key) {
      const entry = documents.get(key);
      return entry ? [...entry.versions.values()].map(meta).reverse() : [];
    },
    /**
     * Готовы ли документы для открытой регистрации: действующие редакции
     * политики и соглашения есть, сверены с манифестом и без меток
     * незаполненных сведений об операторе.
     */
    readiness() {
      const missing = [];
      const drafts = [];
      for (const key of ['privacy_policy', 'terms']) {
        const doc = service.current(key);
        if (!doc) missing.push(key);
        else if (doc.draft) drafts.push(key);
      }
      return { ready: missing.length === 0 && drafts.length === 0, missing, drafts };
    },
    /** Расхождения файлов с манифестом (для проверки при запуске и CLI). */
    problems: () => problems.map((item) => ({ ...item })),
  };
  return Object.freeze(service);
};

let defaultDocuments;
/** Документы из legal/ этого репозитория (один раз на процесс). */
export const getLegalDocuments = () => {
  defaultDocuments ||= createLegalDocuments();
  return defaultDocuments;
};
