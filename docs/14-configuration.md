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
| `AI_SYMPTOM_TRIAGE` | включён | `off` — жалобы только локально: модель-триаж (врач по симптомам и уточняющий вопрос) не вызывается | [policies.js](../backend/privacy/policies.js), [triage.js](../backend/planner/triage.js) |
| `AI_TRIAGE_MODEL` | `AI_MODEL` | модель для триажа жалоб | [pipeline.js](../backend/pipeline.js) |
| `AI_REASONING_EFFORT` | не отправляется | `none`, `minimal`, `low`, `medium`, `high` | [client.js](../backend/planner/client.js) |
| `AI_PROXY_URL` | — | `login:password@host:port`, `host:port:login:password` или `socks5://…`; ошибка в адресе выключает внешнюю модель | [proxyFetch.js](../backend/planner/proxyFetch.js) |
| `AI_DAILY_CALL_LIMIT` | `2000` | вызовов модели в сутки на процесс; значение из админ-панели («Обращений к ИИ-модели в сутки») важнее | [rateLimit.js](../backend/http/rateLimit.js) |

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
| `TOKEN_VAULT_BACKEND` | `memory` | `upstash` (или `redis`) — Redis по REST. Адреса облачного Upstash (`*.upstash.io`) **не используются**: хранилище вне РФ (ч. 5 ст. 18 152-ФЗ) — сервер берёт память процесса и пишет в журнал `token_vault.foreign_storage_blocked` ([privacy/10](privacy/10-processors-and-localization.md)) | [tokenVault.js](../backend/storage/tokenVault.js) |
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
| `DEMO_DATA` | выключено; в `npm run dev` — `on` | демо-набор и демо-запись | [flags.js](../backend/demo/flags.js), [vite.config.js](../vite.config.js) |
| `DEMO_BOOKING` | включено вместе с `DEMO_DATA` | `off` — выключить симуляцию записи | [flags.js](../backend/demo/flags.js) |
| `DEMO_BOOKING_DB_PATH` | `var/demo/booking.sqlite` | файл базы демо-записи | [demoBooking.js](../backend/api/demoBooking.js) |
| `DEMO_NOW` | текущее время | «заморозить» время демо (ISO 8601); не действует при `NODE_ENV=production` | [time.js](../backend/demo/time.js) |
| `PUBLIC_CLINICS` | в демо — скрыты | `on` — показывать государственные учреждения в демо | [flags.js](../backend/demo/flags.js) |
| `DEMO_ONLY` | выкл. | `on` (вместе с `DEMO_DATA=on`) — только вымышленные клиники и врачи: на карте, в подборе и в ответах ассистента нет реальных клиник из OSM, реальных клиник с демо-врачами и справочника врачей; «Выключить демо» в интерфейсе нет | [flags.js](../backend/demo/flags.js) |

## Аккаунты и админ-панель

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `ACCOUNTS` | включено | `off` — выключить аккаунты и админ-панель | [accountContext.js](../backend/api/accountContext.js) |
| `ACCOUNTS_DB_PATH` | `var/accounts/medkarta.sqlite` | файл базы | [accountContext.js](../backend/api/accountContext.js) |
| `LEGAL_DRAFTS_ALLOWED` | выключено | `on` — открыть регистрацию, хотя в политике и соглашении остались метки `[ТРЕБУЕТСЯ ЗАПОЛНИТЬ ОПЕРАТОРОМ]`. **Только для тестового стенда и автотестов**: при `NODE_ENV=production` или `APP_ENV=production` не действует ([privacy/13](privacy/13-operator-checklist.md)) | [registration.js](../backend/accounts/registration.js) |
| `BACKUP_ENCRYPTION_KEY` | — | 32 байта (base64 или hex): ключ для `npm run accounts -- backup --encrypt` и `decrypt-backup` (AES-256-GCM). Храните **отдельно** от копий и от `MFA_SECRET_KEY`; нужен только там, где делают и восстанавливают копии | [backupCrypto.js](../backend/accounts/backupCrypto.js) |
| `REGISTRATION_MODE` | `invite_only` | `open` — регистрация по email (нужна настроенная почта), `invite_only` — аккаунты только по приглашению; другое значение — `invite_only` | [registration.js](../backend/accounts/registration.js) |
| `MFA_SECRET_KEY` | файл `var/accounts/secrets/mfa.key` | 32 байта (base64 или hex, `openssl rand -base64 32`): шифрование секретов приложений-аутентификаторов и HMAC резервных кодов; из него же выводится ключ писем со ссылками в очереди (письма переживают перезапуск). Без переменной ключ создаётся в файле (права 600) рядом с базой. **Храните копию отдельно от базы**; смена ключа делает существующие коды недействительными, а неотправленные письма со ссылками — неотправляемыми (`key_changed`) | [secrets.js](../backend/accounts/secrets.js) |
| `WEBAUTHN_RP_ID` | домен из `PUBLIC_BASE_URL` | домен ключей доступа (passkeys); ключ, созданный для домена, работает только на нём и его поддоменах | [mfa.js](../backend/accounts/mfa.js) |
| `WEBAUTHN_ORIGINS` | — | дополнительные адреса страниц (через запятую), с которых принимаются ключи доступа, например `https://www.navimed.tech` | [mfa.js](../backend/accounts/mfa.js) |
| `PASSWORD_BREACH_CHECK` | выключено | `hibp` — проверять новый пароль по базе утечек Have I Been Pwned: уходят только первые 5 символов SHA-1, пароль и email — нет; сервис недоступен — проверка пропускается | [breachedPasswords.js](../backend/accounts/breachedPasswords.js) |
| `ADMIN_BOOTSTRAP_PASSWORD` | — | **только вне production** (разработка, автотесты): создать главного суперадминистратора при запуске, если его ещё нет. В production игнорируется — суперадминистратор создаётся командой `npm run accounts -- bootstrap` | [accountContext.js](../backend/api/accountContext.js), [bootstrap.js](../backend/accounts/bootstrap.js) |
| `ADMIN_BOOTSTRAP_EMAIL` | `maximka2703@bk.ru` | email главного суперадминистратора | [bootstrap.js](../backend/accounts/bootstrap.js) |
| `APP_ENV` | — | `production` — как и `NODE_ENV=production`: игнорировать `ADMIN_BOOTSTRAP_PASSWORD`, запрещать `seed-test-users` без `--allow-production` | [accounts.mjs](../scripts/accounts.mjs) |
| `COOKIE_SECURE` | автоматически | `on` / `off` — принудительно считать запрос HTTPS (cookie `__Host-mk_sid` с `Secure`) или HTTP (`mk_sid`) | [accountHttp.js](../backend/api/accountHttp.js) |
| `TRUST_PROXY`, `TRUSTED_PROXIES` | 0; только `127.0.0.1` | сколько прокси перед сервером и с каких адресов принимать `X-Forwarded-For` — от этого зависят счётчики подбора по адресу | [rateLimit.js](../backend/http/rateLimit.js) |
| `CHAT_REQUIRES_ACCOUNT` | включено | `off` — открыть ассистента гостям; значение по умолчанию для настройки «Ассистент только после входа» в админ-панели | [chatAccess.js](../backend/api/chatAccess.js), [settings.js](../backend/accounts/settings.js) |

Сроки сессий (в том числе сотрудников), порог неудачных входов, срок
подтверждения личности, сроки ссылок, сроки хранения журналов, сообщение о
технических работах и включение ассистента — **настройки в админ-панели**
(таблица `settings`), а не переменные окружения; секретов и переменных
окружения админ-панель не показывает и не меняет.

## Почта: регистрация, приглашения, восстановление

Письма уходят, только если заданы **все три**: SMTP (`SMTP_URL` или
`SMTP_HOST`), отправитель (`SMTP_FROM` или `MAIL_FROM`) и адрес сайта
(`PUBLIC_BASE_URL` или `APP_URL`). Иначе — ручной режим: ссылку один раз
видит администратор, который её выдал; регистрация и «Нет пароля или забыли
его?» выключены. Фиктивной отправки нет. Что не так с настройками — раздел
«Система» админ-панели и `npm run accounts -- status`. Подробно, с SPF, DKIM
и DMARC, — [mail-setup.md](mail-setup.md).

| Переменная | По умолчанию | Что делает | Где |
|---|---|---|---|
| `PUBLIC_BASE_URL` (или `APP_URL`) | — | публичный адрес сайта для всех ссылок в письмах и для ключей доступа: только `https://…` (или `http://localhost…` для отладки); заголовок `Host` не используется; при заданном `ALLOWED_HOSTS` — только из этого списка | [delivery.js](../backend/accounts/delivery.js) |
| `SMTP_FROM` (или `MAIL_FROM`) | — | отправитель: `МедКарта <noreply@navimed.tech>` или просто адрес | [delivery.js](../backend/accounts/delivery.js) |
| `SMTP_URL` | — | всё сразу: `smtps://логин:пароль@smtp.example.ru:465` (TLS) или `smtp://…:587` (STARTTLS, обязателен); спецсимволы — в URL-кодировке | [smtp.js](../backend/mail/smtp.js) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | порт 465 для `tls`, 587 для `starttls` | то же по отдельности, если `SMTP_URL` не задан | [smtp.js](../backend/mail/smtp.js) |
| `SMTP_SECURE` | `starttls` | `tls` (сразу TLS, порт 465), `starttls` (обязательный STARTTLS) или `none` (без шифрования — пароль не отправляется) | [smtp.js](../backend/mail/smtp.js) |
| `SMTP_ALLOW_INSECURE` | — | `on` — без TLS, **только** для `localhost` (учебный SMTP-сервер в тестах) | [smtp.js](../backend/mail/smtp.js) |

Сертификат почтового сервера проверяется всегда; вход (AUTH) без TLS
запрещён. Пароль SMTP — секрет: только в `.env` или в окружении сервиса, не
в git и не в админ-панели.

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
| `npm start` | `node backend/server.js`; демо-набор и демо-запись **выключены**, пока не задан `DEMO_DATA=on` |
| `npm run start:demo` | то же с `DEMO_DATA=on`: демо-клиники и симуляция записи — для локальной проверки и демо-стенда, не для production с настоящими пользователями |
| `npm run preview` | `vite preview` |
| `npm test` | все тесты `node --test tests/*.test.js` |
| `npm run test:hybrid` | то же при `PRIVACY_OUTBOUND_MODE=hybrid` |
| `npm run test:security` | оба прогона подряд |
| `npm run test:e2e` | сквозные проверки в Chromium: админ-панель ([e2e-admin.mjs](../scripts/e2e-admin.mjs)) и вход с приглашениями ([e2e-auth.mjs](../scripts/e2e-auth.mjs)); нужны `dist/` и Playwright |
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
# аккаунты
PUBLIC_BASE_URL=https://medkarta.example
MFA_SECRET_KEY=<openssl rand -base64 32>
REGISTRATION_MODE=invite_only
# почта — по желанию (без неё ссылки передаются вручную), см. mail-setup.md
# SMTP_URL=smtps://<логин>:<пароль приложения>@<smtp-сервер>:465
# SMTP_FROM="МедКарта <noreply@medkarta.example>"
# внешняя модель — по желанию
OPENROUTER_API_KEY=<ключ>
AI_UPSTREAM_URL=https://openrouter.ai/api/v1/chat/completions
AI_MODEL=<имя модели у провайдера>
```

Демо-стенд добавляет `DEMO_DATA=on` и, для показа с фиксированным временем,
`DEMO_NOW=<ГГГГ-ММ-ДДTЧЧ:ММ:СС+03:00>`.
