# Развёртывание

Проект разворачивается на собственном сервере. Конфигурации хостинг-платформ
в репозитории больше нет — всё, что влияет на безопасность, живёт в коде
(см. `docs/legacy/README.md`, почему это важно).

## Структура репозитория

```
backend/          серверный код; в браузер не попадает никогда
  api/chat.js       точка входа HTTP
  server.js         автономный сервер: API + статика + заголовки
  pipeline.js       сборка конвейера
  privacy/          Privacy Gateway: детекторы, entity linking, редактура
  planner/          контракт плана, валидатор, адаптер модели
  executor/         авторизация, справочник, маршрутизация, шаблоны ответа
  storage/          хранилище session-токенов
  observability/    безопасное логирование и метрики
  http/             приём запросов: лимит частоты, заголовки безопасности

frontend/         всё, что попадает в браузер
  index.html
  public/
  src/

shared/           контракт между фронтендом и бекендом
  contract.js       лимиты, перечисления, нормализация ответа

data/             справочники; это данные, а не код
  doctors.js        публичный срез
  doctors.full.js   полная база (вне git)
  clinics.js
  facilities.js

tests/  docs/  scripts/
```

Почему `shared/` отдельно: раньше `frontend/src` импортировал файл из папки
серверного кода. Это не только некрасиво — серверный модуль попадал
в браузерный бандл. Теперь у обеих сторон общий контракт, и направление
зависимостей однозначно: фронтенд и бекенд зависят от `shared/`,
друг от друга — нет. Правило проверяется тестом.

## Запуск

```bash
npm ci
npm run build          # собирает frontend/ в dist/
npm start              # backend/server.js: API + статика из dist/
```

Переменные окружения — в `.env` в корне, шаблон в `.env.example`.
Обязательная для продакшена: `PRIVACY_TOKEN_SECRET` (не короче 16 символов).
Без неё берётся случайный секрет процесса, и соответствия токенов
не переживают рестарт.

| Переменная | Значение по умолчанию |
|---|---|
| `PORT` | 3001 |
| `HOST` | 127.0.0.1 |
| `SERVE_STATIC` | включено, если существует `dist/`; `off` — только API |

## Если статику отдаёт nginx

`backend/server.js` выставляет заголовки безопасности сам. Но если HTML
отдаёт nginx, а сервер работает только как API (`SERVE_STATIC=off`), то
**заголовки для страницы обязан выставлять nginx** — на ответах API они
страницу не защищают.

```nginx
server {
    listen 443 ssl http2;
    server_name medkarta.example;

    add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=(), browsing-topics=()" always;

    root /srv/medkarta/dist;

    location / {
        try_files $uri /index.html;
    }

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        add_header Cache-Control "no-store, max-age=0" always;
        add_header X-Robots-Tag "noindex" always;
    }
}
```

**Ограничьте частоту и соединения на уровне nginx.** У сервера одно ядро,
и расчёт маршрута идёт в основном потоке. Приложение само ограничивает
маршруты по затраченному процессорному времени на адрес и обращения к
модели общим бюджетом (когда он исчерпан, ассистент отвечает по локальному
плану, а не отказом). Но медленные соединения и поток запросов с многих
адресов дешевле отсечь до Node:

```nginx
limit_req_zone  $binary_remote_addr zone=api:10m rate=5r/s;
limit_conn_zone $binary_remote_addr zone=perip:10m;

server {
    # …
    client_header_timeout 10s;
    client_body_timeout   10s;
    client_max_body_size  64k;
    limit_conn perip 20;

    location /api/ {
        limit_req zone=api burst=20 nodelay;
        # … proxy_pass как выше
    }
}
```

Если сервер открыт в интернет напрямую, без nginx, он сам ограничивает
число соединений с одного адреса (`MAX_CONNECTIONS_PER_IP`, по умолчанию 32).
Задайте также `ALLOWED_HOSTS` — имена сайта, на которые отвечает API.

`X-Forwarded-For` нужен ограничителю частоты: без него все запросы придут
с адреса прокси и лимит на адрес станет общим на всех. **Задайте в `.env`
`TRUST_PROXY=1`** — число прокси перед сервером. Тогда адрес клиента берётся
из последнего значения `X-Forwarded-For`, которое дописал nginx.

Без `TRUST_PROXY` сервер заголовкам `X-Forwarded-*` не верит и берёт адрес
из сокета. Так и должно быть, если сервер открыт в интернет напрямую:
заголовок пишет клиент, и раньше, меняя его в каждом запросе, любой обходил
лимит «20 запросов с адреса». Первое значение заголовка подделывается даже
за nginx, поэтому берётся последнее.

Оговорка про `add_header` в nginx: директивы не наследуются в блок `location`,
если в нём есть собственный `add_header`. Поэтому в `/api/` и `/assets/`
заголовки безопасности придётся перечислить повторно либо вынести их
в подключаемый файл и `include` его в каждом блоке.

## Провайдер модели

Планировщик отправляет обезличенный запрос по адресу из `AI_UPSTREAM_URL`
с ключом из `OPENROUTER_API_KEY` (или `AI_API_KEY`). **Если `AI_UPSTREAM_URL`
не задан, используется `https://modelhub.my/v1/chat/completions`** — так было
настроено в проекте изначально. Если ключ выпущен OpenRouter, задайте
явно `AI_UPSTREAM_URL=https://openrouter.ai/api/v1/chat/completions`:
иначе ключ OpenRouter уходит стороннему сервису.

## Дорожный граф

Маршрутизация работает на собственном движке и требует собранного графа.
Сборка делается один раз и не на боевом сервере:

```bash
node scripts/build-road-graph.mjs
```

Файл `data/graph/kazan.graph` (~20 МБ) копируется на сервер рядом
с приложением. Без него приложение работает, но маршруты рисуются
прямыми линиями — подробности в `docs/routing.md`.

## Что проверить перед выкладкой

1. `npm test` — 161 тест, включая проверки границы доверия.
2. `npm run lint`.
3. `PRIVACY_TOKEN_SECRET` задан в окружении.
4. В сборке нет секретов: `grep -R "sk-\|ghp_" dist/ || echo чисто`.
5. `data/doctors.full.js` не попал в git: `git check-ignore data/doctors.full.js`.
6. Граф скопирован: `ls -lh data/graph/kazan.graph`.
7. Обратный прокси **не пишет тела запросов** в логи. Privacy Gateway
   бессмыслен, если исходный текст оседает в логах nginx.
8. Sentry или APM не подключён с автоматическим захватом тела запроса.
