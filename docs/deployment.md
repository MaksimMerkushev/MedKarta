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
  analytics/        журнал продуктовых событий и отчёт по поискам
  http/             приём запросов: лимит частоты, заголовки безопасности

frontend/         всё, что попадает в браузер
  index.html
  public/
  src/

shared/           контракт между фронтендом и бекендом
  contract.js       лимиты, перечисления, нормализация ответа
  analytics.js      закрытый словарь событий аналитики
  specialties.js    канонические специальности, признак детского приёма

data/             справочники; это данные, а не код
  doctors.js        публичный срез
  doctors.full.js   полная база (вне git, но попадает в бандл — см. ниже)
  clinics.js
  facilities.js

tools/data/       сборщик данных: загрузка, разбор, сравнение, очередь (docs/data-pipeline.md)

data/demo/        вымышленные клиники и программы ДМС для демо-режима
data/private/     справочник частных клиник, собранный npm run data:build
data/sources.json источники сборщика

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
| `TRUST_PROXY` | 0; за nginx — 1 |
| `AI_DAILY_CALL_LIMIT` | 2000 обращений к модели в сутки |
| `CHAT_MAX_CONCURRENCY` | 1 |

## Сервер (VPS) пошагово

Рассчитано на одну машину с 1 ядром и 2 ГБ: nginx отдаёт статику и TLS,
Node обслуживает только `/api/`. Так статика не конкурирует за ядро с
расчётом маршрутов, а Node не виден из интернета напрямую.

### 1. Пользователь, код, секреты

```bash
sudo adduser --system --group --home /srv/medkarta medkarta
sudo -u medkarta git clone https://github.com/MaksimMerkushev/MedKarta.git /srv/medkarta/app
cd /srv/medkarta/app
sudo -u medkarta npm ci && sudo -u medkarta npm run build
sudo -u medkarta cp .env.example .env && sudo chmod 600 .env   # заполнить .env
```

Node — 22 LTS (`.nvmrc`). Граф `data/graph/kazan.graph` и
`data/doctors.full.js` копируются отдельно (их нет в git).

> **Важно про `data/doctors.full.js`.** Файла нет в git, но при сборке он
> попадает в бандл (`vite.config.js` подставляет его вместо публичного среза):
> карта показывает этих врачей, значит, браузер их скачивает. Это не утечка
> секрета — данные публичные, со страниц больниц, — но «закрытой» базу
> делает только отдельный API с выдачей по запросу.

### 2. systemd

`/etc/systemd/system/medkarta.service`:

```ini
[Unit]
Description=MedKarta API
After=network-online.target
Wants=network-online.target

[Service]
User=medkarta
Group=medkarta
WorkingDirectory=/srv/medkarta/app
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3001
Environment=SERVE_STATIC=off
Environment=TRUST_PROXY=1
ExecStart=/usr/bin/node backend/server.js
Restart=always
RestartSec=2
# Сервер выходит при необработанном исключении и рассчитывает на перезапуск.
MemoryMax=1200M
LimitNOFILE=8192
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/medkarta/app/var /srv/medkarta/app/data/collected /srv/medkarta/app/data/review /srv/medkarta/app/data/private
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

```bash
sudo -u medkarta mkdir -p /srv/medkarta/app/var /srv/medkarta/app/data/collected /srv/medkarta/app/data/review
sudo systemctl daemon-reload && sudo systemctl enable --now medkarta
journalctl -u medkarta -f        # «server.started», routing_provider: local
```

### 3. nginx и HTTPS

Сертификат — Let's Encrypt: `sudo apt install certbot python3-certbot-nginx`,
затем `sudo certbot --nginx -d medkarta.example` (продление certbot ставит сам).

`/etc/nginx/snippets/medkarta-headers.conf` — заголовки страницы. nginx не
наследует `add_header` в `location` со своими `add_header`, поэтому файл
подключается в каждом таком блоке:

```nginx
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; upgrade-insecure-requests" always;
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=(), browsing-topics=()" always;
```

`/etc/nginx/sites-available/medkarta`:

```nginx
# Журнал без строки запроса: в ?q= лежит текст поиска («невролог после
# инсульта»), а это сведения о здоровье. Тела запросов nginx не пишет.
log_format medkarta '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent $request_time';

limit_req_zone  $binary_remote_addr zone=chat:10m   rate=1r/s;
limit_req_zone  $binary_remote_addr zone=route:10m  rate=5r/s;
limit_req_zone  $binary_remote_addr zone=events:10m rate=2r/s;
limit_conn_zone $binary_remote_addr zone=perip:10m;

server {
    listen 80;
    listen [::]:80;
    server_name medkarta.example;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name medkarta.example;
    # ssl_certificate … — добавит certbot

    server_tokens off;
    access_log /var/log/nginx/medkarta.access.log medkarta;

    client_header_timeout 10s;
    client_body_timeout   10s;
    client_max_body_size  64k;
    limit_conn perip 20;

    gzip on;
    gzip_types text/css application/javascript text/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    root /srv/medkarta/app/dist;
    include snippets/medkarta-headers.conf;

    location / {
        try_files $uri /index.html;
        add_header Cache-Control "no-cache" always;
        include snippets/medkarta-headers.conf;
    }

    # Имена файлов в assets/ содержат хэш содержимого — их можно кэшировать навсегда.
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        include snippets/medkarta-headers.conf;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        # Cache-Control, X-Robots-Tag и заголовки безопасности для API
        # ставит сам сервер — здесь их не дублируем.
        limit_req zone=route burst=20 nodelay;
    }
    location = /api/chat {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 30s;
        limit_req zone=chat burst=5;
    }
    location = /api/events {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        limit_req zone=events burst=10 nodelay;
    }
}
```

HSTS с `preload` включайте только когда HTTPS работает на всех поддоменах:
из списка предзагрузки браузеров домен выводится месяцами.

### 4. Межсетевой экран

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable                 # порт 3001 снаружи закрыт: Node слушает 127.0.0.1
```

Вход по SSH — только по ключу (`PasswordAuthentication no` в `sshd_config`).

### 5. Журналы и резервные копии

- Журналы сервиса — `journald`; ограничьте размер: `SystemMaxUse=200M` в
  `/etc/systemd/journald.conf`. Журналы nginx ротирует пакетный logrotate.
- Аналитика сама удаляет файлы старше `ANALYTICS_RETENTION_DAYS` и держит
  каталог в пределах `ANALYTICS_MAX_TOTAL_MB`.
- Раз в сутки копируйте на другую машину: `.env`, `data/doctors.full.js`,
  `data/graph/`, `data/collected/`, `var/analytics/`. Без копии `.env` и
  полной базы восстановление после потери VPS займёт дни.

### 6. Обновление

```bash
cd /srv/medkarta/app && sudo -u medkarta git pull && sudo -u medkarta npm ci \
  && sudo -u medkarta npm test && sudo -u medkarta npm run build && sudo systemctl restart medkarta
```

### Ограничения внутри приложения

nginx отсекает поток запросов и медленные соединения до Node, но сервер
защищается и сам:

- **Ассистент:** 20 запросов за 5 минут с адреса, бюджет процессорного
  времени на адрес (3 с, пополняется на 30 мс/с) и очередь на разбор
  (`CHAT_MAX_CONCURRENCY`, по умолчанию 1). Обращения к модели — не больше
  300 за 5 минут и `AI_DAILY_CALL_LIMIT` за сутки; сверх этого ответ строится
  локально.
- **Маршруты и время в пути:** бюджет процессорного времени на адрес.
- **Общий предохранитель:** если тяжёлые запросы заняли больше 60 % ядра за
  10 секунд, ассистент отвечает 503 «перегружен»; маршруты — при 85 %.
  Статика и лёгкие запросы при этом отвечают.
- **Аналитика:** 120 запросов за 5 минут и 1500 событий в сутки с адреса.

`X-Forwarded-For` нужен ограничителю частоты: без него все запросы придут
с адреса прокси, и лимит на адрес станет общим на всех. **Задайте
`TRUST_PROXY=1`** — число прокси перед сервером. Адрес клиента берётся из
последнего значения `X-Forwarded-For`, которое дописал nginx, и только если
соединение пришло от самого nginx (`127.0.0.1`; другой адрес прокси —
`TRUSTED_PROXIES`). Значение вроде `TRUST_PROXY=true` — ошибка запуска, а не
тихий ноль.

Без `TRUST_PROXY` сервер заголовкам `X-Forwarded-*` и `X-Real-IP` не верит и
берёт адрес из сокета. Так и должно быть, если сервер открыт в интернет
напрямую: тогда он сам ограничивает число соединений с одного адреса
(`MAX_CONNECTIONS_PER_IP`, по умолчанию 32; IPv6 считается по сети /64),
сжимает статику и отдаёт `304` по `ETag`. Задайте также `ALLOWED_HOSTS` —
имена сайта, на которые отвечает API.

## Карта: тайлы

Подложка карты сейчас берётся с `tile.openstreetmap.org`. Правила OSM
запрещают нагружать их серверы коммерческим проектом без договорённости и
не дают гарантий доступности. Для продакшена нужен свой поставщик тайлов
(или свой тайл-сервер); после смены адреса поправьте `img-src` в CSP
(`backend/http/securityHeaders.js` и сниппет nginx) и `preconnect` в
`frontend/index.html`.

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

## Аналитика

Сервер пишет продуктовые события в `var/analytics/events-ГГГГ-ММ-ДД.jsonl`
(каталог меняется `ANALYTICS_DIR`). Что в событиях есть и чего нет —
`docs/analytics.md`. На сервере каталог должен быть доступен на запись
пользователю сервиса и **не** отдаваться nginx наружу.

```bash
npm run report:searches                # отчёт за 7 дней
npm run report:searches -- --days 30
npm run report:searches -- --json      # для таблиц и графиков
```

## Что проверить перед выкладкой

1. `npm test` — все тесты, включая проверки границы доверия.
2. `npm run lint` и `npm audit` (Vite — не старше 8.0.16: в более ранних
   версиях dev-сервер с `--host` отдавал файлы вне проекта).
3. `PRIVACY_TOKEN_SECRET` задан в окружении.
4. В сборке нет секретов: `grep -R "sk-\|ghp_" dist/ || echo чисто`.
5. `data/doctors.full.js` не попал в git: `git check-ignore data/doctors.full.js`.
6. Граф скопирован: `ls -lh data/graph/kazan.graph`.
7. Обратный прокси **не пишет тела запросов** в логи. Privacy Gateway
   бессмыслен, если исходный текст оседает в логах nginx.
8. Sentry или APM не подключён с автоматическим захватом тела запроса.
