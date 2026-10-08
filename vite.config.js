import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
const FRONTEND = fileURLToPath(new URL('./frontend', import.meta.url))
const SHARED = fileURLToPath(new URL('./shared', import.meta.url))
const DATA = fileURLToPath(new URL('./data', import.meta.url))
const NODE_MODULES = fileURLToPath(new URL('./node_modules', import.meta.url))

const CHAT_HANDLER_URL = new URL('./backend/api/chat.js', import.meta.url)
const ROUTE_HANDLER_URL = new URL('./backend/api/route.js', import.meta.url)
const TRAVEL_TIMES_HANDLER_URL = new URL('./backend/api/travelTimes.js', import.meta.url)
const EVENTS_HANDLER_URL = new URL('./backend/api/events.js', import.meta.url)
const CONFIG_HANDLER_URL = new URL('./backend/api/config.js', import.meta.url)
const FULL_DB_PATH = fileURLToPath(new URL('./data/doctors.full.js', import.meta.url))
const PUBLIC_DB_PATH = fileURLToPath(new URL('./data/doctors.js', import.meta.url))
const HAS_FULL_DB = fs.existsSync(FULL_DB_PATH)

/**
 * Dev-режим: `vite dev` не поднимает backend, поэтому тот же обработчик
 * подключается как middleware. Ключ читается из .env через loadEnv БЕЗ
 * префикса VITE_ — то есть остаётся на стороне dev-сервера и не попадает
 * в бандл.
 *
 * Модуль грузится обычным dynamic import, а не через server.ssrLoadModule:
 * backend/api/chat.js — чистый Node-код без JSX и import.meta.env, поэтому
 * конвейер Vite ему не нужен. Query-параметр сбрасывает кеш модулей, чтобы
 * правки подхватывались без перезапуска.
 */
const isLocalHost = (host) =>
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(String(host || '')) ||
  (process.env.ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean).includes(String(host || '').toLowerCase())

const devApiPlugin = (env) => ({
  name: 'medkarta-dev-api',
  apply: 'serve',
  configureServer(server) {
    for (const key of ['OPENROUTER_API_KEY', 'AI_API_KEY', 'AI_UPSTREAM_URL', 'AI_MODEL', 'ALLOWED_ORIGINS', 'PRIVACY_TOKEN_SECRET', 'ANALYTICS', 'ANALYTICS_DIR', 'DEMO_DATA']) {
      if (env[key] && !process.env[key]) {
        process.env[key] = env[key]
      }
    }

    // В режиме разработки демо-набор включён, если в .env не сказано иное:
    // иначе ассистент и карта показывали бы разные данные.
    if (!process.env.DEMO_DATA) {
      process.env.DEMO_DATA = 'on'
    }

    if (!process.env.OPENROUTER_API_KEY && !process.env.AI_API_KEY) {
      server.config.logger.warn(
        '[dev-api] OPENROUTER_API_KEY не найден в .env — планировщик недоступен, конвейер уйдёт в локальный план. Остальное приложение работает.',
      )
    }

    // Все обработчики API: без /api/route в dev-режиме маршрут не строился
    // вовсе, и казалось, что сломан движок.
    for (const [mount, handlerUrl, label] of [
      ['/api/chat', CHAT_HANDLER_URL, 'чата'],
      ['/api/route', ROUTE_HANDLER_URL, 'маршрута'],
      ['/api/travel-times', TRAVEL_TIMES_HANDLER_URL, 'времени в пути'],
      ['/api/events', EVENTS_HANDLER_URL, 'аналитики'],
      ['/api/config', CONFIG_HANDLER_URL, 'конфигурации'],
    ]) {
      try {
        server.watcher?.add(fileURLToPath(handlerUrl))
      } catch {
        // не критично
      }

      server.middlewares.use(mount, async (req, res, next) => {
        /*
         * Эти обработчики подключены раньше проверки Host самого Vite. Без
         * своей проверки страница с чужого домена, указавшего на 127.0.0.1
         * (DNS rebinding), могла бы звать /api/chat с вашим ключом модели.
         */
        if (!isLocalHost(req.headers.host)) {
          res.statusCode = 403
          res.end()
          return
        }
        try {
          const { default: handler } = await import(`${handlerUrl.href}?t=${Date.now()}`)
          await handler(req, res)
        } catch (error) {
          server.config.logger.error(`[dev-api] ${error?.stack || error?.message || error}`)
          if (!res.writableEnded) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: `Ошибка dev-обработчика ${label}.` }))
            return
          }
          next(error)
        }
      })
    }
  },
})

export default defineConfig(({ mode }) => {
  // envDir задан явно: корень проекта больше не совпадает с root Vite.
  const env = loadEnv(mode, ROOT, '')

  return {
    root: FRONTEND,
    envDir: ROOT,
    plugins: [react(), devApiPlugin(env)],
    resolve: {
      /*
       * Алиасы — регулярные выражения, а не строки: строковый алиас '@data/doctors'
       * совпал бы и с '@data/doctors.legacy.js' по префиксу и подменил бы не тот
       * файл. Порядок тоже важен — точное совпадение идёт первым.
       */
      alias: [
        { find: /^@data\/doctors$/, replacement: HAS_FULL_DB ? FULL_DB_PATH : PUBLIC_DB_PATH },
        { find: /^@data\//, replacement: `${DATA}/` },
        { find: /^@shared\//, replacement: `${SHARED}/` },
      ],
    },
    server: {
      /*
       * Только эта машина. Если открыть сервер в сеть (`--host`, например
       * для проверки с телефона), dev-сервер отдаёт исходники и данные всем
       * в сети — делайте это только в доверенной сети и на свежем Vite.
       */
      host: 'localhost',
      fs: {
        // root — frontend/, а shared/ и data/ лежат выше. Раньше разрешался
        // весь корень проекта — вместе с .env, backend/ и var/.
        allow: [FRONTEND, SHARED, DATA, NODE_MODULES],
        deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/data/collected/**', '**/data/review/**', '**/var/**'],
      },
    },
    build: {
      outDir: fileURLToPath(new URL('./dist', import.meta.url)),
      emptyOutDir: true,
      // Sourcemap в проде отдаёт читаемый исходник рядом с бандлом.
      sourcemap: false,
      rollupOptions: {
        output: {
          // Крупные справочники — отдельным чанком: правка интерфейса больше
          // не инвалидирует полмегабайта данных в кэше браузера.
          manualChunks(id) {
            const normalized = id.split('\\').join('/')
            if (
              normalized.includes('/data/facilities.js') ||
              normalized.includes('/data/doctors.js') ||
              normalized.includes('/data/doctors.full.js') ||
              normalized.includes('/data/doctors.legacy.js') ||
              normalized.includes('/data/clinics.js')
            ) {
              return 'facilities-data'
            }
            if (normalized.includes('node_modules/leaflet') || normalized.includes('node_modules/react-leaflet')) {
              return 'map'
            }
            return undefined
          },
        },
      },
    },
  }
})
