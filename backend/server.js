/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Автономный HTTP-сервер для развёртывания на собственном сервере.
 *
 * Отдаёт два вида ответов:
 *   /api/chat  — конвейер приватности (backend/api/chat.js);
 *   всё прочее — собранный фронтенд из dist/, если он есть.
 *
 * Заголовки безопасности выставляются ЗДЕСЬ, а не в конфигурации хостинга:
 * раньше они жили только в vercel.json и после переезда перестали
 * применяться совсем (см. backend/http/securityHeaders.js).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import handler from './api/chat.js';
import { applySecurityHeaders } from './http/securityHeaders.js';
import { logger } from './observability/safeLogger.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = path.join(ROOT, 'dist');

// Автозагрузка .env для автономной работы на сервере.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // .env может отсутствовать, если переменные заданы в окружении
  }
}

const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '127.0.0.1';
const SERVE_STATIC = process.env.SERVE_STATIC !== 'off' && fs.existsSync(DIST);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/**
 * Приводит URL к пути внутри dist/.
 *
 * Возвращает null, если путь пытается выйти за пределы каталога: без этой
 * проверки `GET /../.env` отдал бы файл с ключом API.
 */
const resolveStaticPath = (requestUrl) => {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  const candidate = path.resolve(DIST, `.${pathname}`);
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) {
    return null;
  }
  return candidate;
};

const sendFile = (res, filePath, status = 200) => {
  const extension = path.extname(filePath);
  res.statusCode = status;
  res.setHeader('Content-Type', MIME[extension] || 'application/octet-stream');
  // Хэшированные ассеты кэшируются надолго, HTML — никогда.
  res.setHeader(
    'Cache-Control',
    filePath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  );
  fs.createReadStream(filePath).pipe(res);
};

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res, { api: req.url?.startsWith('/api/') });

  if (req.url?.startsWith('/api/chat')) {
    try {
      await handler(req, res);
    } catch (error) {
      // Ни текст ошибки, ни стек наружу и в логи не идут: и то, и другое
      // может содержать фрагменты пользовательского ввода.
      logger.error('server.handler_failed', error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Внутренняя ошибка сервера.' }));
      }
    }
    return;
  }

  if (!SERVE_STATIC) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const filePath = resolveStaticPath(req.url || '/');
  if (!filePath) {
    res.statusCode = 400;
    res.end();
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(res, filePath);
      return;
    }
    // SPA: любой неизвестный путь отдаёт index.html, маршрутизацию делает клиент.
    const index = path.join(DIST, 'index.html');
    fs.access(index, fs.constants.R_OK, (indexError) => {
      if (indexError) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      sendFile(res, index, 200);
    });
  });
});

server.listen(PORT, HOST, () => {
  logger.event('server.started', {
    status: SERVE_STATIC ? 'api+static' : 'api-only',
    routing_provider: process.env.ROUTING_PROVIDER || 'haversine',
    vault_backend: process.env.TOKEN_VAULT_BACKEND || 'memory',
  });
});

export default server;
