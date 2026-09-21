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
const BACKEND_DIR = path.join(ROOT, 'backend');

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
    const files = await walk(BACKEND_DIR);
    const offenders = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/import[^;]*mintSanitizedPlannerRequest/s.test(source)) continue;
      const relative = path.relative(ROOT, file);
      if (relative !== path.join('backend', 'privacy', 'gateway.js')) {
        offenders.push(relative);
      }
    }

    assert.deepEqual(offenders, [], `создание SanitizedPlannerRequest вне gateway: ${offenders.join(', ')}`);
  });

  it('исходящий сетевой вызов к модели существует ровно в одном модуле', async () => {
    const files = await walk(BACKEND_DIR);
    const callers = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      // Ищем реальный вызов fetch, а не упоминание в комментарии.
      if (/^\s*(?:const|let)?[^/\n]*\bfetchImpl\(|^\s*await fetch\(/m.test(source)) {
        callers.push(path.relative(ROOT, file));
      }
    }

    const allowed = [
      path.join('backend', 'planner', 'client.js'),
      path.join('backend', 'storage', 'tokenVault.js'),
      path.join('backend', 'executor', 'routing.js'),
    ];

    for (const caller of callers) {
      assert.ok(allowed.includes(caller), `неожиданный исходящий вызов в ${caller}`);
    }
  });

  it('в api/ не осталось прямого console-логирования', async () => {
    const files = await walk(BACKEND_DIR);
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
    const { ACTIONS, DENIED_ACTIONS } = await import('../backend/planner/schema.js');

    for (const action of ACTIONS) {
      assert.ok(
        !/SQL|QUERY|DATABASE|PATIENT|RECORD|EXPORT|ADMIN|DELETE|UPDATE/i.test(action),
        `действие ${action} подразумевает доступ к данным`,
      );
      assert.ok(!DENIED_ACTIONS.includes(action), `${action} одновременно разрешено и запрещено`);
    }
  });

  it('безопасность не зависит от системного промпта', async () => {
    const { validatePlan } = await import('../backend/planner/validator.js');

    // Промпт в проверке не участвует вовсе: валидатор отклоняет запрещённое
    // действие независимо от того, что и как было сказано модели.
    const result = validatePlan(
      { action: 'GET_ALL_PATIENTS', steps: [], constraints: {} },
      { allowedTokens: new Set(), allowedDistricts: [] },
    );
    assert.equal(result.ok, false);
  });
});

describe('Заголовки безопасности живут в коде', () => {
  it('набор заголовков определён в backend, а не в конфигурации хостинга', async () => {
    const { SECURITY_HEADERS } = await import('../backend/http/securityHeaders.js');

    // Раньше весь набор жил в vercel.json. После переезда на собственный
    // сервер он перестал применяться, и заметить это по коду было нельзя.
    for (const header of [
      'Content-Security-Policy',
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
    ]) {
      assert.ok(SECURITY_HEADERS[header], `потерян заголовок ${header}`);
    }

    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), 'в CSP появился unsafe-eval');
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'в CSP появился unsafe-inline для скриптов');
  });

  it('сервер выставляет заголовки на каждый ответ', async () => {
    const source = await readFile(path.join(BACKEND_DIR, 'server.js'), 'utf8');
    assert.match(source, /applySecurityHeaders\(res/, 'сервер не применяет заголовки');
  });

  it('статика не отдаётся за пределами dist', async () => {
    const source = await readFile(path.join(BACKEND_DIR, 'server.js'), 'utf8');
    // Без проверки выхода за каталог `GET /../.env` отдал бы ключ API.
    assert.match(source, /startsWith\(DIST \+ path\.sep\)/, 'нет защиты от обхода каталога');
  });
});
