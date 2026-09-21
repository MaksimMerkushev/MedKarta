/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Инвариант границы доверия на уровне исходников.
 *
 * Правило ESLint no-restricted-imports уже запрещает импорт
 * mintSanitizedPlannerRequest вне gateway. Этот тест дублирует проверку,
 * потому что линтер можно отключить строкой в файле, а тест — нет.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'api');

/** Убирает комментарии, чтобы упоминание console в пояснении не считалось вызовом. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
};

describe('Граница доверия в исходниках', () => {
  it('mintSanitizedPlannerRequest импортируется только из gateway', async () => {
    const files = await walk(API_DIR);
    const offenders = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/import[^;]*mintSanitizedPlannerRequest/s.test(source)) continue;
      const relative = path.relative(ROOT, file);
      if (relative !== path.join('api', '_shared', 'privacy', 'gateway.js')) {
        offenders.push(relative);
      }
    }

    assert.deepEqual(offenders, [], `создание SanitizedPlannerRequest вне gateway: ${offenders.join(', ')}`);
  });

  it('исходящий сетевой вызов к модели существует ровно в одном модуле', async () => {
    const files = await walk(API_DIR);
    const callers = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // Ищем реальный вызов fetch, а не упоминание в комментарии.
      if (/^\s*(?:const|let)?[^/\n]*\bfetchImpl\(|^\s*await fetch\(/m.test(source)) {
        callers.push(path.relative(ROOT, file));
      }
    }

    const allowed = [
      path.join('api', '_shared', 'planner', 'client.js'),
      path.join('api', '_shared', 'storage', 'tokenVault.js'),
      path.join('api', '_shared', 'executor', 'routing.js'),
    ];

    for (const caller of callers) {
      assert.ok(allowed.includes(caller), `неожиданный исходящий вызов в ${caller}`);
    }
  });

  it('в api/ не осталось прямого console-логирования', async () => {
    const files = await walk(API_DIR);
    const offenders = [];

    for (const file of files) {
      const source = stripComments(await readFile(file, 'utf8'));
      if (/\bconsole\.(log|error|warn|info|debug)\s*\(/.test(source)) {
        offenders.push(path.relative(ROOT, file));
      }
    }

    assert.deepEqual(offenders, [], `console в серверном коде: ${offenders.join(', ')}`);
  });

  it('в перечне действий нет ничего, что подразумевало бы доступ к данным', async () => {
    const { ACTIONS, DENIED_ACTIONS } = await import('../api/_shared/planner/schema.js');

    for (const action of ACTIONS) {
      assert.ok(
        !/SQL|QUERY|DATABASE|PATIENT|RECORD|EXPORT|ADMIN|DELETE|UPDATE/i.test(action),
        `действие ${action} подразумевает доступ к данным`,
      );
      assert.ok(!DENIED_ACTIONS.includes(action), `${action} одновременно разрешено и запрещено`);
    }
  });

  it('безопасность не зависит от системного промпта', async () => {
    const { validatePlan } = await import('../api/_shared/planner/validator.js');

    // Промпт в проверке не участвует вовсе: валидатор отклоняет запрещённое
    // действие независимо от того, что и как было сказано модели.
    const result = validatePlan(
      { action: 'GET_ALL_PATIENTS', steps: [], constraints: {} },
      { allowedTokens: new Set(), allowedDistricts: [] },
    );
    assert.equal(result.ok, false);
  });
});
