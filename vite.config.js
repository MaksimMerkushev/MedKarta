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
const CHAT_ACCESS_URL = new URL('./backend/api/chatAccess.js', import.meta.url)
const ROUTE_HANDLER_URL = new URL('./backend/api/route.js', import.meta.url)
const TRAVEL_TIMES_HANDLER_URL = new URL('./backend/api/travelTimes.js', import.meta.url)
const EVENTS_HANDLER_URL = new URL('./backend/api/events.js', import.meta.url)
const CONFIG_HANDLER_URL = new URL('./backend/api/config.js', import.meta.url)
const ACCOUNT_HANDLER_URL = new URL('./backend/api/account.js', import.meta.url)
const DEMO_BOOKING_HANDLER_URL = new URL('./backend/api/demoBooking.js', import.meta.url)
const ME_HANDLER_URL = new URL('./backend/api/me.js', import.meta.url)
const ADMIN_HANDLER_URL = new URL('./backend/api/admin.js', import.meta.url)
const ACTIVATION_HANDLER_URL = new URL('./backend/api/activation.js', import.meta.url)
const PRIVACY_HANDLER_URL = new URL('./backend/api/privacy.js', import.meta.url)
const FULL_DB_PATH = fileURLToPath(new URL('./data/doctors.full.js', import.meta.url))
const PUBLIC_DB_PATH = fileURLToPath(new URL('./data/doctors.js', import.meta.url))
const HAS_FULL_DB = fs.existsSync(FULL_DB_PATH)

const isLocalHost = (host) =>
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(String(host || '')) ||
  (process.env.ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean).includes(String(host || '').toLowerCase())

/*
 * `vite dev` не поднимает backend, поэтому те же обработчики подключаются как
 * middleware. Ключи читаются из .env через loadEnv без префикса VITE_ — остаются
 * в dev-сервере и не попадают в бандл. Модули backend — чистый Node-код, поэтому
 * обычный dynamic import, а не ssrLoadModule; query-параметр сбрасывает кеш модулей,
 * чтобы правки подхватывались без перезапуска.
 */
const devApiPlugin = (env) => ({
  name: 'medkarta-dev-api',
  apply: 'serve',
  configureServer(server) {
    for (const key of ['OPENROUTER_API_KEY', 'AI_API_KEY', 'AI_UPSTREAM_URL', 'AI_MODEL', 'AI_PROXY_URL', 'AI_REASONING_EFFORT', 'ALLOWED_ORIGINS', 'PRIVACY_TOKEN_SECRET', 'ANALYTICS', 'ANALYTICS_DIR', 'DEMO_DATA', 'ACCOUNTS', 'ACCOUNTS_DB_PATH', 'COOKIE_SECURE', 'CHAT_REQUIRES_ACCOUNT', 'ADMIN_BOOTSTRAP_EMAIL', 'ADMIN_BOOTSTRAP_PASSWORD', 'APP_ENV', 'APP_URL', 'MAIL_FROM', 'SMTP_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_SECURE', 'SMTP_FROM', 'SMTP_ALLOW_INSECURE', 'PUBLIC_BASE_URL', 'REGISTRATION_MODE', 'MFA_SECRET_KEY', 'PASSWORD_BREACH_CHECK', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGINS', 'DEMO_BOOKING', 'DEMO_BOOKING_DB_PATH', 'DEMO_NOW', 'PUBLIC_CLINICS']) {
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

    /*
     * Кабинет и демо-запись держат открытую базу SQLite (stateful): их модули
     * грузятся один раз, без сброса кеша, иначе каждый запрос открывал бы новое
     * соединение с базой. Проверка входа перед чатом (gateUrl) — тоже: она
     * читает ту же базу кабинета.
     */
    for (const [mount, handlerUrl, label, stateful = false, gateUrl = null] of [
      ['/api/chat', CHAT_HANDLER_URL, 'чата', false, CHAT_ACCESS_URL],
      ['/api/route', ROUTE_HANDLER_URL, 'маршрута'],
      ['/api/travel-times', TRAVEL_TIMES_HANDLER_URL, 'времени в пути'],
      ['/api/events', EVENTS_HANDLER_URL, 'аналитики'],
      ['/api/config', CONFIG_HANDLER_URL, 'конфигурации'],
      ['/api/account', ACCOUNT_HANDLER_URL, 'кабинета', true],
      // Приглашения и ссылки для входа — раньше общего /api/auth (connect сопоставляет по префиксу).
      ['/api/auth/activation', ACTIVATION_HANDLER_URL, 'активации', true],
      ['/api/auth/access-link', ACTIVATION_HANDLER_URL, 'ссылок для входа', true],
      ['/api/auth/register', ACTIVATION_HANDLER_URL, 'регистрации', true],
      ['/api/auth/email-change', ACTIVATION_HANDLER_URL, 'смены email', true],
      ['/api/auth', ACCOUNT_HANDLER_URL, 'входа', true],
      ['/api/me', ME_HANDLER_URL, 'профиля', true],
      ['/api/admin', ADMIN_HANDLER_URL, 'админ-панели', true],
      ['/api/legal', PRIVACY_HANDLER_URL, 'документов', true],
      ['/api/privacy', PRIVACY_HANDLER_URL, 'персональных данных', true],
      ['/api/demo', DEMO_BOOKING_HANDLER_URL, 'демо-записи', true],
    ]) {
      try {
        server.watcher?.add(fileURLToPath(handlerUrl))
      } catch {
        // не критично
      }

      server.middlewares.use(mount, async (req, res, next) => {
        /*
         * Обработчики стоят раньше проверки Host самого Vite: без своей проверки
         * страница с чужого домена, указавшего на 127.0.0.1 (DNS rebinding),
         * могла бы звать /api/chat с вашим ключом модели.
         */
        if (!isLocalHost(req.headers.host)) {
          res.statusCode = 403
          res.end()
          return
        }
        try {
          if (gateUrl) {
            const { chatAccessGate } = await import(gateUrl.href)
            if (!(await chatAccessGate(req, res))) return
          }
          const { default: handler } = await import(stateful ? handlerUrl.href : `${handlerUrl.href}?t=${Date.now()}`)
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
  // envDir задан явно: корень проекта не совпадает с root Vite (frontend/).
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
        // root — frontend/, а shared/ и data/ лежат выше; весь корень проекта
        // (с .env, backend/ и var/) не открывается.
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
          // Крупные справочники — отдельным чанком: правка интерфейса не
          // инвалидирует полмегабайта данных в кэше браузера.
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
