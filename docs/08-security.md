# 08. Безопасность

Документ сводит модель угроз и **подтверждённые по коду** механизмы защиты.
Операционные правила и история решений — в [SECURITY.md](../SECURITY.md);
приватность ассистента — в [07-privacy.md](07-privacy.md).

Ниже «подтверждено» означает: механизм найден в коде, и для него указан тест
или проверка запуском. Сведения, которые зависят от настроек сервера и
поэтому не проверяются по репозиторию, помечены **Unknown**.

## Активы

| Актив | Где | Почему ценен |
|---|---|---|
| Текст запросов к ассистенту | память процесса во время запроса | может содержать ПДн и сведения о здоровье |
| Ключ модели, пароль прокси | `.env` на сервере | расходы и доступ к аккаунту провайдера |
| `PRIVACY_TOKEN_SECRET`, Token Vault | `.env`, память или Upstash | обратимость псевдонимов |
| Координаты пользователя | запросы маршрутов и подбора | местоположение человека |
| База кабинета | `var/accounts/medkarta.sqlite` | email, имя, хэши паролей |
| Справочник врачей | `data/`, `doctors.full.js` | ФИО врачей — персональные данные, даже опубликованные |
| Доступность сервиса | одна машина, одно ядро | любой перебор бьёт по всем пользователям |

## Модель угроз и меры

| # | Угроза | Мера | Подтверждение |
|---|---|---|---|
| S1 | Сырой текст пользователя уходит провайдеру модели | тип `SanitizedPlannerRequest`, режим `structured`, повторная проверка перед `fetch` | [boundary.test.js](../tests/boundary.test.js), [outbound-leakage.test.js](../tests/outbound-leakage.test.js), [privacy-eval.test.js](../tests/privacy-eval.test.js) |
| S2 | Инъекция в промпт меняет поведение | безопасность не зависит от промпта: строгий валидатор, Policy Engine, шаблонный текст ответа, белые списки `sanitizeAiAction` | [planner-validation.test.js](../tests/planner-validation.test.js), [boundary.test.js](../tests/boundary.test.js) |
| S3 | Модель ссылается на чужие или выдуманные сущности | токены только выданные этому запросу; разыменование по ключу сессии и запроса | [planner-validation.test.js](../tests/planner-validation.test.js), [token-vault.test.js](../tests/token-vault.test.js) |
| S4 | Маскировка ПДн: гомоглифы, невидимые символы, разрыв по буквам, транслит, эмодзи | скан-вид с картой индексов, склейка, fail-closed при неразрешённом разрыве | [obfuscation.test.js](../tests/obfuscation.test.js), [privacy-audit.test.js](../tests/privacy-audit.test.js) |
| S5 | Утечка через журнал | белый список полей, запрет поверх, проверка строк детекторами, ошибки только кодом | [logging.test.js](../tests/logging.test.js) |
| S6 | Утечка через тело ошибки провайдера | тело не читается в журнал и не пересылается; в журнал — только HTTP-статус | код [planner/client.js](../backend/planner/client.js); отдельного теста нет |
| S7 | XSS через текст модели или данные | текст рендерится React как текст; `dangerouslySetInnerHTML` не используется (проверено поиском при аудите); CSP `script-src 'self'`; значения в `L.divIcon` маркеров проходят `sanitizeColor` / `sanitizeLabel` | [securityHeaders.js](../backend/http/securityHeaders.js), [App.jsx](../frontend/src/App.jsx) |
| S8 | Кликджекинг, MIME-sniffing, утечка Referer | `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy` | [boundary.test.js](../tests/boundary.test.js) |
| S9 | Обход каталога статики (`GET /../.env`) | нормализация пути и проверка префикса `dist/`; битая кодировка — `400` | [boundary.test.js](../tests/boundary.test.js) |
| S10 | CSRF на изменяющие запросы кабинета и демо-записи | `SameSite=Lax`, обязательный `application/json`, проверка `Origin` и `Sec-Fetch-Site` | [accounts.test.js](../tests/accounts.test.js), [demo-booking.test.js](../tests/demo-booking.test.js) |
| S11 | Подбор пароля | 20 попыток за 15 мин с адреса; 10 неудачных на email за 15 мин; scrypt N=16384 | [accounts.test.js](../tests/accounts.test.js) |
| S12 | Кража сессии из базы | в базе только SHA-256 токена; cookie `HttpOnly`, `SameSite=Lax`, `Path=/api`, `Secure` в продакшене | код [accounts/service.js](../backend/accounts/service.js); флаги cookie — [accounts.test.js](../tests/accounts.test.js) |
| S13 | Подмена адреса клиента через `X-Forwarded-For` | заголовок учитывается только при `TRUST_PROXY>0` и соединении от доверенного прокси; берётся N-е значение с конца; `X-Real-IP` не читается | [third-audit.test.js](../tests/third-audit.test.js) |
| S14 | DNS rebinding к API | `ALLOWED_HOSTS`; в dev-режиме — проверка `Host` перед обработчиками | [request.js](../backend/http/request.js), [vite.config.js](../vite.config.js) |
| S15 | Отказ в обслуживании | лимиты частоты, «вёдра» процессорного времени, общий предохранитель, очередь разбора, потолки тела, таймауты сокетов, потолок соединений с адреса | [second-audit.test.js](../tests/second-audit.test.js), [third-audit.test.js](../tests/third-audit.test.js) |
| S16 | Катастрофический перебор в регулярных выражениях | ограничение длин и якоря в детекторах; тест держит время разбора враждебного ввода | [third-audit.test.js](../tests/third-audit.test.js) |
| S17 | Секрет в браузерном бандле | секреты без префикса `VITE_`; правило ESLint на `*API_KEY*` и др. в `frontend/src` | [eslint.config.js](../eslint.config.js) |
| S18 | Запросы сборщика на внутренние адреса | только http(s) из `data/sources.json`, запрет локальных и частных адресов, редиректы — в пределах сайта, потолок 3 МБ | [data-collector.test.js](../tests/data-collector.test.js), [fetchSource.js](../tools/data/fetchSource.js) |
| S19 | Огромный ответ провайдера модели или OSRM | потоковое чтение с потолком 256 КБ / 1 МБ, отказ от редиректов | [planner/client.js](../backend/planner/client.js), [executor/routing.js](../backend/executor/routing.js) |
| S20 | Подмена данных клиники через взломанную страницу | телефон, сайт, адрес, координаты — только через ручную проверку; массовые изменения отправляют весь прогон на проверку | [data-pipeline.md](data-pipeline.md), [data-collector.test.js](../tests/data-collector.test.js) |

## Заголовки ответа

Выставляются сервером на каждый ответ ([securityHeaders.js](../backend/http/securityHeaders.js)):

| Заголовок | Значение |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | геолокация только `self`; камера, микрофон, платежи, USB, датчики, `browsing-topics` запрещены |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin` |
| `X-DNS-Prefetch-Control` | `off` |
| Для `/api/*` дополнительно | `Cache-Control: no-store, max-age=0`, `X-Robots-Tag: noindex` |

`style-src 'unsafe-inline'` нужен инлайновым стилям Leaflet и React. Если
статику отдаёт nginx, заголовки страницы должен ставить он (сниппет — в
[deployment.md](deployment.md)); заголовки на ответах API страницу не защищают.

## Секреты

- Все секреты — переменные окружения без префикса `VITE_`; шаблон —
  [.env.example](../.env.example) (значения пустые). `.env` и `.env.*` в
  `.gitignore`.
- Ключ модели уходит только по HTTPS (`isAllowedUpstreamUrl`); HTTP — только
  для модели на `localhost`.
- Адрес и пароль прокси в журнал не пишутся; при ошибке в адресе прокси
  внешняя модель выключается, а не идёт напрямую ([pipeline.js](../backend/pipeline.js),
  `plannerTransportFromEnv`).
- Если `AI_UPSTREAM_URL` не задан, запросы с ключом уходят на адрес по
  умолчанию `modelhub.my`; при старте пишется предупреждение
  `planner.default_upstream`. Для ключа OpenRouter адрес нужно задать явно
  ([deployment.md](deployment.md)).
- [SECURITY.md](../SECURITY.md) (раздел 7) требует отозвать ключи, которые
  ранее попадали в бандл или переписку, и проверить историю git. Выполнено ли
  это — по репозиторию установить нельзя: **Unknown**.

## Зависимости

- Серверный код не имеет npm-зависимостей в рантайме: только встроенные
  модули Node (`node:http`, `node:crypto`, `node:sqlite`, `node:net`,
  `node:tls`, `node:zlib`).
- Фронтенд: React, React-Leaflet, Leaflet, lucide-react, Tailwind; dev —
  Vite, ESLint и плагины ([package.json](../package.json)).
- `npm run audit:security` — `npm audit --omit=dev`. В рамках аудита не
  запускался: нет доступа к реестру npm из среды аудита.
- `package-lock.json` фиксирует **Vite 8.0.0**, тогда как
  [SECURITY.md](../SECURITY.md) (п. 10) требует 8.0.16+ из-за уязвимости
  dev-сервера при запуске с `--host`. Dev-сервер по умолчанию слушает только
  `localhost`, но рекомендация не выполнена — см.
  [18-known-limitations.md](18-known-limitations.md).

## Что зависит от развёртывания (Unknown по репозиторию)

| Пункт | Почему важно |
|---|---|
| `PRIVACY_TOKEN_SECRET` задан | иначе случайный секрет процесса и потеря соответствий при рестарте |
| `TRUST_PROXY=1` за nginx | иначе все клиенты в одном ведре лимита |
| `ALLOWED_HOSTS` задан | защита от DNS rebinding |
| Журналы nginx без тел и строки запроса | иначе текст поиска оседает в журналах |
| APM или Sentry без автозахвата тел | иначе Privacy Gateway теряет смысл |
| Права `.env` — 600 | файл с ключами |
| Свой поставщик тайлов карты | правила OSM и раскрытие в политике конфиденциальности |
| Лимит расходов в кабинете провайдера модели | второй, независимый от кода предохранитель |

## Остаточные риски

| Риск | Комментарий |
|---|---|
| Лимиты и предохранители в памяти процесса | при нескольких экземплярах суммарный лимит выше; нужен внешний стор |
| Проверка `Origin` пропускает запросы без заголовка | это осознанное решение (часть браузеров не шлёт `Origin` для same-origin); не защищает от не-браузерных клиентов |
| Защита сборщика от внутренних адресов проверяет имя хоста из URL, а не адрес после DNS | имя, указывающее на внутренний адрес, проверку пройдёт; источники задаются в репозитории вручную |
| Ключ удержания слота в демо хэшируется HMAC с постоянным ключом в коде | демо-данные без ценности; для настоящей записи так делать нельзя ([bookingStore.js](../backend/demo/bookingStore.js)) |
| Полная база врачей попадает в браузерный бандл | публичные сведения, но «закрытой» базу делает только отдельный API |

Найденные при аудите проблемы и их статус — [18-known-limitations.md](18-known-limitations.md).
