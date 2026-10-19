# 14. Конфигурация

Вся настройка — переменные окружения. Сервер читает `.env` из корня проекта
(`process.loadEnvFile`), переменные, заданные в окружении процесса, имеют
приоритет. Шаблон с комментариями — [.env.example](../.env.example).
Значения по умолчанию ниже взяты **из кода**; ссылка ведёт на модуль, где
переменная читается.

> Ни один секрет не должен начинаться с `VITE_`: такие переменные Vite
> встраивает в браузерный бандл. В проекте переменных `VITE_*` нет.

## Сервер

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `PORT` | `3001` | порт | [server.js](../backend/server.js) |
| `HOST` | `127.0.0.1` | адрес прослушивания | [server.js](../backend/server.js) |
| `SERVE_STATIC` | включено, если есть `dist/` | `off` — только API | [server.js](../backend/server.js) |
| `NODE_ENV` | — | `production`: cookie всегда `Secure`, `DEMO_NOW` игнорируется, тестовые пользователи запрещены; `test`: журнал выключен | [accountHttp.js](../backend/api/accountHttp.js), [time.js](../backend/demo/time.js), [safeLogger.js](../backend/observability/safeLogger.js) |
| `MAX_CONNECTIONS` | `512` | потолок соединений | [server.js](../backend/server.js) |
| `MAX_CONNECTIONS_PER_IP` | `32` | соединений с адреса (IPv6 — сеть /64), только при `TRUST_PROXY=0` | [server.js](../backend/server.js) |
| `TRUST_PROXY` | `0` | число прокси перед сервером, целое 0–5; иное — отказ запуска | [rateLimit.js](../backend/http/rateLimit.js) |
| `TRUSTED_PROXIES` | loopback | адреса прокси, которым верится `X-Forwarded-For` | [rateLimit.js](../backend/http/rateLimit.js) |
| `ALLOWED_HOSTS` | — | список имён хоста через запятую; другие `Host` получают `403` (DNS rebinding) | [request.js](../backend/http/request.js), [vite.config.js](../vite.config.js) |
| `ALLOWED_ORIGINS` | — | дополнительные доверенные `Origin` через запятую | [request.js](../backend/http/request.js) |
| `CHAT_MAX_CONCURRENCY` | `1` | одновременных разборов запросов ассистента | [chat.js](../backend/api/chat.js) |

## Внешняя модель

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `OPENROUTER_API_KEY` или `AI_API_KEY` | — | ключ; без него — только локальный планировщик | [pipeline.js](../backend/pipeline.js) |
| `AI_UPSTREAM_URL` | `https://modelhub.my/v1/chat/completions` | адрес OpenAI-совместимого `chat/completions`; только `https://` (или `http://localhost`) | [pipeline.js](../backend/pipeline.js), [client.js](../backend/planner/client.js) |
| `AI_MODEL` | `gpt-5.4-mini` | имя модели | [pipeline.js](../backend/pipeline.js) |
| `AI_REASONING_EFFORT` | не отправляется | `none`, `minimal`, `low`, `medium`, `high` | [client.js](../backend/planner/client.js) |
| `AI_PROXY_URL` | — | `login:password@host:port`, `host:port:login:password` или `socks5://…`; ошибка в адресе выключает внешнюю модель | [proxyFetch.js](../backend/planner/proxyFetch.js) |
| `AI_DAILY_CALL_LIMIT` | `2000` | вызовов модели в сутки на процесс | [rateLimit.js](../backend/http/rateLimit.js) |

> Если задан ключ, но не задан `AI_UPSTREAM_URL`, запросы с ключом уходят на
> адрес по умолчанию; в журнале запуска — предупреждение
> `planner.default_upstream`. Для ключа OpenRouter задайте
> `AI_UPSTREAM_URL=https://openrouter.ai/api/v1/chat/completions` явно.

## Приватность

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `PRIVACY_OUTBOUND_MODE` | `structured` | `structured` или `hybrid` ([07-privacy.md](07-privacy.md)) | [gateway.js](../backend/privacy/gateway.js) |
| `PRIVACY_TOKEN_SECRET` | случайный секрет процесса | ключ HMAC для Token Vault, не короче 16 символов | [tokenVault.js](../backend/storage/tokenVault.js) |
| `PRIVACY_TOKEN_TTL_SECONDS` | `120` | время жизни соответствия метки | [tokenVault.js](../backend/storage/tokenVault.js) |
| `TOKEN_VAULT_BACKEND` | `memory` | `upstash` (или `redis`) — Upstash Redis по REST | [tokenVault.js](../backend/storage/tokenVault.js) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | — | доступ к Upstash | [tokenVault.js](../backend/storage/tokenVault.js) |
| `PRIVACY_CATALOG_FACILITIES` | включено | `off` — не загружать учреждения OSM в справочник ассистента | [catalog.js](../backend/privacy/catalog.js) |
| `ALLOW_COARSE_ORIGIN` | выключено | `on` — принимать в `/api/chat` огрублённую точку (интерфейс её не шлёт) | [chat.js](../backend/api/chat.js) |

## Маршрутизация

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `ROUTING_PROVIDER` | `local` | `local`, `haversine`, `osrm` — для выбора «ближайшего» в ассистенте | [executor/routing.js](../backend/executor/routing.js) |
| `ROUTING_GRAPH_PATH` | `data/graph/kazan.graph` | путь к графу | [engine.js](../backend/routing/engine.js) |
| `ROUTING_OSRM_URL` | — | адрес OSRM; передаёт координаты третьей стороне | [executor/routing.js](../backend/executor/routing.js) |
| `OVERPASS_SLOW_MS` | `30000` | порог «медленного» ответа Overpass при сборке графа | [build-road-graph.mjs](../scripts/build-road-graph.mjs) |

## Демо-режим

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `DEMO_DATA` | выключено; в `npm run dev` — `on` | демо-набор, демо-запись, демо-аккаунты | [flags.js](../backend/demo/flags.js), [vite.config.js](../vite.config.js) |
| `DEMO_BOOKING` | включено вместе с `DEMO_DATA` | `off` — выключить симуляцию записи | [flags.js](../backend/demo/flags.js) |
| `DEMO_BOOKING_DB_PATH` | `var/demo/booking.sqlite` | файл базы демо-записи | [demoBooking.js](../backend/api/demoBooking.js) |
| `DEMO_NOW` | текущее время | «заморозить» время демо (ISO 8601); не действует при `NODE_ENV=production` | [time.js](../backend/demo/time.js) |
| `PUBLIC_CLINICS` | в демо — скрыты | `on` — показывать государственные учреждения в демо | [flags.js](../backend/demo/flags.js) |

## Аккаунты и админ-панель

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `ACCOUNTS` | включено | `off` — выключить аккаунты и админ-панель | [accountContext.js](../backend/api/accountContext.js) |
| `ACCOUNTS_DB_PATH` | `var/accounts/medkarta.sqlite` | файл базы | [accountContext.js](../backend/api/accountContext.js) |
| `ADMIN_BOOTSTRAP_PASSWORD` | — | пароль главного суперадминистратора; создаётся при запуске, **только если такого email ещё нет**, повторный запуск ничего не меняет. После первого входа уберите переменную | [accountContext.js](../backend/api/accountContext.js), [bootstrap.js](../backend/accounts/bootstrap.js) |
| `ADMIN_BOOTSTRAP_EMAIL` | `maximka2703@bk.ru` | email главного суперадминистратора | [bootstrap.js](../backend/accounts/bootstrap.js) |
| `APP_ENV` | — | `production` — как и `NODE_ENV=production`, запрещает `npm run accounts -- seed-test-users` без `--allow-production` | [accounts.mjs](../scripts/accounts.mjs) |
| `COOKIE_SECURE` | автоматически | `on` / `off` — принудительно ставить или не ставить `Secure` | [accountHttp.js](../backend/api/accountHttp.js) |
| `CHAT_REQUIRES_ACCOUNT` | включено | `off` — открыть ассистента гостям; значение по умолчанию для настройки «Ассистент только после входа» в админ-панели | [chatAccess.js](../backend/api/chatAccess.js), [settings.js](../backend/accounts/settings.js) |

Публичной регистрации нет (`ACCOUNTS_REGISTRATION` больше не читается).
Пароль новому пользователю не выдаётся — он задаёт его сам по приглашению
(почта — раздел ниже).
Сроки сессий, порог неудачных входов, сроки хранения журналов, сообщение о
технических работах, включение ассистента и демо-кнопок — **настройки в
админ-панели** (таблица `settings`), а не переменные окружения; секретов и
переменных окружения админ-панель не показывает и не меняет.

## Почта: приглашения и ссылки для входа

Письма с приглашениями и ссылками для смены пароля уходят, только если заданы
**все три**: SMTP (`SMTP_URL` или `SMTP_HOST`), `MAIL_FROM` и `APP_URL`. Иначе —
ручной режим: ссылку один раз видит администратор, который её выдал, а кнопка
«Нет пароля или забыли его?» объясняет, что ссылку присылает администратор.
Фиктивной отправки нет. Что не так с настройками — в разделе «Система»
админ-панели (компонент «Письма с приглашениями») и в `npm run accounts -- status`.

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `APP_URL` | — | публичный адрес приложения для ссылок в письмах: только `https://…` (или `http://localhost…` для отладки); заголовок `Host` для писем не используется | [delivery.js](../backend/accounts/delivery.js) |
| `MAIL_FROM` | — | отправитель: `МедКарта <noreply@домен>` или просто адрес | [delivery.js](../backend/accounts/delivery.js) |
| `SMTP_URL` | — | всё сразу: `smtps://логин:пароль@smtp.example.ru:465` (TLS) или `smtp://…:587` (STARTTLS, обязателен); спецсимволы в логине и пароле — в URL-кодировке | [smtp.js](../backend/mail/smtp.js) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | порт 465 для `tls`, 587 для `starttls` | то же по отдельности, если `SMTP_URL` не задан | [smtp.js](../backend/mail/smtp.js) |
| `SMTP_SECURE` | `starttls` | `tls` (сразу TLS, порт 465), `starttls` (обязательный STARTTLS) или `none` (без шифрования — пароль не отправляется) | [smtp.js](../backend/mail/smtp.js) |
| `SMTP_ALLOW_INSECURE` | — | `on` — вход без TLS, **только** для `localhost` (локальный тестовый сервер вроде MailHog) | [smtp.js](../backend/mail/smtp.js) |

Сертификат почтового сервера проверяется всегда; вход (AUTH) без TLS
запрещён. Пароль SMTP — секрет: только в `.env` или в окружении сервиса, не
в git и не в админ-панели. Сроки ссылок — настройки «Приглашения» в
админ-панели: `auth.inviteTtlHours` (24 ч) и `auth.resetTtlMinutes` (60 мин).

Пример для Яндекс 360 (пароль приложения, а не пароль от ящика):

```bash
APP_URL=https://medkarta.example.ru
MAIL_FROM="МедКарта <noreply@medkarta.example.ru>"
SMTP_URL=smtps://noreply%40medkarta.example.ru:ПАРОЛЬ_ПРИЛОЖЕНИЯ@smtp.yandex.ru:465
```

Проверка после перезапуска: создайте в админ-панели пользователя со своим
вторым адресом — в окне итога будет «Приглашение отправлено», письмо придёт
в течение минуты. Не пришло — «Система» → «Письма с приглашениями» и журнал
сервера (`mail.send_failed` с кодом ошибки, без адресов и текста письма).

## Аналитика

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `ANALYTICS` | включено | `off` — не писать события | [events.js](../backend/api/events.js) |
| `ANALYTICS_DIR` | `var/analytics` | каталог журнала | [events.js](../backend/api/events.js) |
| `ANALYTICS_MAX_EVENTS_PER_DAY` | `50000` | потолок записей в сутки | [eventStore.js](../backend/analytics/eventStore.js) |
| `ANALYTICS_MAX_TOTAL_MB` | `500` | потолок каталога | [eventStore.js](../backend/analytics/eventStore.js) |
| `ANALYTICS_RETENTION_DAYS` | `180` | срок хранения файлов | [eventStore.js](../backend/analytics/eventStore.js) |

## Сборщик данных

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `DATA_BOT_CONTACT` | — | контакт в User-Agent сборщика | [fetchSource.js](../tools/data/fetchSource.js) |
| `DATA_BOT_UA` | — | User-Agent целиком | [fetchSource.js](../tools/data/fetchSource.js) |

## Команды npm

Из [package.json](../package.json):

| Команда | Что делает |
|---|---|
| `npm run dev` | Vite с обработчиками API; демо включено по умолчанию |
| `npm run build` | сборка фронтенда в `dist/` |
| `npm start` | `node backend/server.js` |
| `npm run preview` | `vite preview` |
| `npm test` | все тесты `node --test tests/*.test.js` |
| `npm run test:hybrid` | то же при `PRIVACY_OUTBOUND_MODE=hybrid` |
| `npm run test:security` | оба прогона подряд |
| `npm run test:e2e` | сквозная проверка аккаунтов и админ-панели в Chromium ([e2e-admin.mjs](../scripts/e2e-admin.mjs)); нужны `dist/` и Playwright |
| `npm run accounts -- <команда>` | суперадминистратор, тестовые пользователи, сброс пароля, восстановление доступа, резервная копия ([accounts.md](accounts.md#первый-запуск)) |
| `npm run lint`, `npm run lint:fix` | ESLint |
| `npm run eval:privacy` | проверка обезличивания на размеченном наборе ([privacy-evaluation.md](privacy-evaluation.md)) |
| `npm run ai:check`, `ai:bench`, `ai:trace` | проверка связи, замер и трассировка внешней модели |
| `npm run build:graph` | сборка графа дорог из OpenStreetMap |
| `npm run demo:generate`, `demo:reset` | генерация демо-набора; сброс демо-записей |
| `npm run data:collect`, `data:review`, `data:build`, `data:verify` | сборщик данных и проверка госврачей |
| `npm run report:searches` | отчёт по поискам из журнала аналитики |
| `npm run audit:security` | `npm audit --omit=dev` |
| `npm run prices:doctors` | генерация цен услуг врачей ([generate-doctor-service-prices.mjs](../scripts/generate-doctor-service-prices.mjs)) |
| `npm run ownership:facilities` | переразметка формы собственности учреждений ([reclassify-facility-ownership.mjs](../scripts/reclassify-facility-ownership.mjs)) |

## Минимальные наборы

Локальная разработка — `.env` можно не создавать: `npm run dev` поднимет
интерфейс и API с демо-набором, ассистент будет работать на локальном
планировщике.

Сервер в продакшене (значения — заглушки):

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
SERVE_STATIC=off
TRUST_PROXY=1
ALLOWED_HOSTS=medkarta.example
PRIVACY_TOKEN_SECRET=<не короче 16 символов, случайная строка>
# внешняя модель — по желанию
OPENROUTER_API_KEY=<ключ>
AI_UPSTREAM_URL=https://openrouter.ai/api/v1/chat/completions
AI_MODEL=<имя модели у провайдера>
```

Демо-стенд добавляет `DEMO_DATA=on` и, для показа с фиксированным временем,
`DEMO_NOW=<ГГГГ-ММ-ДДTЧЧ:ММ:СС+03:00>`.
