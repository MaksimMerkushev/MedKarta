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
друг от друга — нет. Отдельного теста на это правило нет; при аудите
документации (15.10.2026) оно соблюдалось.

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
| `PUBLIC_BASE_URL` | — ; адрес сайта для ссылок в письмах и ключей доступа (`https://…`) |
| `MFA_SECRET_KEY` | файл `var/accounts/secrets/mfa.key`; ключ двухфакторной защиты, копию хранить отдельно от базы |
| `REGISTRATION_MODE` | `invite_only`; `open` — регистрация по email (нужна почта) |
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

Node — 22 LTS (`.nvmrc`), для личного кабинета не ниже **22.13** (`node:sqlite`).
Граф `data/graph/kazan.graph` и `data/doctors.full.js` копируются отдельно
(их нет в git).

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
add_header Permissions-Policy "geolocation=(self), camera=(), microphone=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=(), browsing-topics=(), publickey-credentials-get=(self), publickey-credentials-create=(self)" always;
```

`publickey-credentials-*` — ключи доступа (passkeys) только на своём сайте.

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

    # Страницы, открываемые по ссылке из письма (#token=…): не кэшировать и не
    # отправлять Referer. Токен во фрагменте и так не уходит в Referer — это
    # вторая линия защиты. Последнее значение Referrer-Policy действует.
    location ~ ^/(activate|register/confirm|email/confirm)/?$ {
        try_files /index.html =404;
        add_header Cache-Control "no-store" always;
        include snippets/medkarta-headers.conf;
        add_header Referrer-Policy "no-referrer" always;
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
        # Кабинет ставит cookie с флагом Secure, если запрос пришёл по HTTPS.
        proxy_set_header X-Forwarded-Proto $scheme;
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
  `/etc/systemd/journald.conf`. Журналы nginx ротирует пакетный logrotate:
  в журнале доступа — полный IP посетителя, поэтому задайте короткий срок
  (например, `rotate 14` при `daily` в `/etc/logrotate.d/nginx`) и впишите
  его в политику (п. 4.10) — [privacy/05](privacy/05-retention-and-destruction.md).
- Аналитика сама удаляет файлы старше `ANALYTICS_RETENTION_DAYS` и держит
  каталог в пределах `ANALYTICS_MAX_TOTAL_MB`.
- Раз в сутки копируйте на другую машину (в РФ —
  [privacy/10](privacy/10-processors-and-localization.md)): `data/doctors.full.js`,
  `data/graph/`, `data/collected/`, `var/analytics/`, **зашифрованную** копию
  базы кабинета и `var/accounts/erasures.jsonl`. Секреты из `.env`
  (`MFA_SECRET_KEY`, `PRIVACY_TOKEN_SECRET`, пароль SMTP, ключ модели,
  `BACKUP_ENCRYPTION_KEY`) храните **отдельно** от копий базы — в менеджере
  секретов или другом хранилище: копия базы рядом с ключом перестаёт быть
  защищённой. Без секретов и полной базы восстановление после потери VPS
  займёт дни.
- База аккаунтов — `var/accounts/medkarta.sqlite`. Копия без остановки
  сервиса, зашифрованная (ключ `BACKUP_ENCRYPTION_KEY`, 32 байта):
  `sudo -u medkarta npm run accounts -- backup --encrypt --out /backup/accounts-$(date +%F).enc`.
  После восстановления из копии — `npm run accounts -- reapply-erasures`
  (повторить удаления аккаунтов, сделанные после копии).
- Раз в сутки сохраняйте вне сервера вывод `npm run accounts -- consents-verify`
  (отпечаток журнала согласий).
  Каталог `var/` уже открыт на запись в unit-файле (`ReadWritePaths`).
  Первый выпуск с админ-панелью (миграция схемы 3, главный администратор) —
  по порядку из [15-deployment.md](15-deployment.md#выпуск-с-аккаунтами-и-админ-панелью).

### 6. Обновление

```bash
cd /srv/medkarta/app && sudo -u medkarta git pull && sudo -u medkarta npm ci \
  && sudo -u medkarta npm test && sudo -u medkarta npm run build && sudo systemctl restart medkarta
```

### Ограничения внутри приложения

nginx отсекает поток запросов и медленные соединения до Node, но сервер
защищается и сам:

- **Ассистент:** 40 запросов за 5 минут с адреса (кнопки уточнений — тоже реплики), бюджет процессорного
  времени на адрес (3 с, пополняется на 30 мс/с) и очередь на разбор
  (`CHAT_MAX_CONCURRENCY`, по умолчанию 1). Обращения к модели — не больше
  300 за 5 минут и `AI_DAILY_CALL_LIMIT` за сутки; сверх этого ответ строится
  локально.
- **Маршруты и время в пути:** бюджет процессорного времени на адрес.
- **Общий предохранитель:** если тяжёлые запросы заняли больше 60 % ядра за
  10 секунд, ассистент отвечает 503 «перегружен»; маршруты — при 85 %.
  Статика и лёгкие запросы при этом отвечают.
- **Аналитика:** 120 запросов за 5 минут и 1500 событий в сутки с адреса.

### Показ в зале: много людей с одного Wi-Fi

Все, кто в одной сети, выходят в интернет с одного адреса, и лимиты «на адрес»
делятся на весь зал: 40 сообщений ассистенту за 5 минут — на всех. Перед
показом суперадминистратор открывает `/admin` → «Настройки» → «Нагрузка и
лимиты» и нажимает **«Для показа»**, затем «Сохранить» — действует сразу, без
перезапуска:

| Настройка | Обычно | «Для показа» | Что меняет |
|---|---|---|---|
| Множитель лимитов на один адрес | ×1 | ×20 | лимиты ассистента (сообщения и время разбора), подбора и записи, маршрутов, времени в пути, входа и регистрации на адрес (порог ошибок адреса, письма и ссылки с адреса) |
| Очередь к ассистенту | 16 | 64 | сколько сообщений ждут разбора, прежде чем ответ «перегружен» |
| Обращений к ИИ-модели за 5 минут | 300 | 600 | на весь сервер; сверх — ответ по локальному плану, не отказ |
| Обращений к ИИ-модели в сутки | `AI_DAILY_CALL_LIMIT` (2000) | 5000 | то же; «Для показа» не снижает уже поднятое значение |

После показа — **«Обычный режим»** и «Сохранить». Сервер при этом не упадёт и
под множителем ×50: общий предохранитель (60 % ядра на ассистента, 85 % на
маршруты) от множителя не зависит — в пике часть сообщений получит
«перегружен, повторите через минуту», статика и карта продолжат отвечать.
Защита от подбора пароля к одному аккаунту (5 ошибок с адреса, 10 с
незнакомых устройств) и лимиты писем на один email от множителя не зависят.

nginx из примера выше тоже считает «на адрес», и его лимиты из админ-панели
не меняются. На время показа поднимите их в конфигурации и выполните
`sudo nginx -t && sudo systemctl reload nginx`:

```nginx
limit_req_zone  $binary_remote_addr zone=chat:10m   rate=10r/s;   # было 1r/s
limit_req_zone  $binary_remote_addr zone=route:10m  rate=50r/s;   # было 5r/s
limit_req_zone  $binary_remote_addr zone=events:10m rate=20r/s;   # было 2r/s
limit_conn perip 300;                                             # было 20
limit_req zone=chat burst=50;                                     # в location = /api/chat
limit_req zone=route burst=200 nodelay;                           # в location /api/
```

Без этого nginx отклонит соединения сверх 20 с одного адреса (`503`) раньше,
чем запрос дойдёт до сервера.

`X-Forwarded-For` нужен ограничителю частоты: без него все запросы придут
с адреса прокси, и лимит на адрес станет общим на всех. **Задайте
`TRUST_PROXY=1`** — число прокси перед сервером. Адрес клиента берётся из
последнего значения `X-Forwarded-For`, которое дописал nginx, и только если
соединение пришло от самого nginx (`127.0.0.1`; другой адрес прокси —
`TRUSTED_PROXIES`). Значение вроде `TRUST_PROXY=true` — ошибка запуска, а не
тихий ноль.

`X-Forwarded-Proto` нужен личному кабинету: по нему сервер понимает, что
посетитель пришёл по HTTPS, и ставит cookie сессии с флагом `Secure`. При
`NODE_ENV=production` флаг ставится всегда; `COOKIE_SECURE=off` — только для
стенда без HTTPS.

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

### Модель с российского сервера: прокси

OpenRouter не принимает запросы с российских адресов, поэтому сервер в РФ
обращается к модели через прокси за рубежом. Через прокси идёт только запрос
к модели; карта, маршруты и кабинет работают напрямую.

```ini
AI_UPSTREAM_URL=https://openrouter.ai/api/v1/chat/completions
AI_MODEL=openai/gpt-5.4-mini
AI_PROXY_URL=login:password@203.0.113.10:8000
```

Замер на реальных запросах через прокси (октябрь 2026, `openai/gpt-5.4-mini`):
ответ модели — около 2 с, рассуждений нет (0 токенов), на входе ~2 000
токенов, на выходе ~100 — примерно $2 за 1000 запросов ассистента.
`AI_REASONING_EFFORT` для этой модели не нужен.

- **Формат прокси** — как выдают продавцы: `login:password@ip:port`
  (HTTP-прокси), `ip:port:login:password` или
  `socks5://login:password@ip:port`. Если в пароле есть `@ : / #` и адрес
  записан со схемой, их нужно закодировать (`%40 %3A %2F %23`).
- **Страна прокси** — не Россия и не другие страны, которые не поддерживает
  OpenRouter. Подойдут Нидерланды, Германия, Финляндия.
- **Что видит прокси.** Внутри туннеля — TLS до самого `openrouter.ai` с
  проверкой сертификата. Прокси видит только имя хоста и объём трафика;
  ключа и текста запроса он не видит. Если проверка покажет ошибку `tls`,
  прокси подменяет HTTPS — использовать его нельзя.
- **Ошибка в адресе прокси** выключает внешнюю модель: запрос не уйдёт
  напрямую с российского адреса, ассистент ответит по локальному плану.
  В журнале — событие `planner.proxy_invalid`.
- **Проверка:** `npm run ai:check` делает один запрос той же формы, что и
  ассистент, и пишет, что не так: логин прокси, страна, ключ, баланс, имя
  модели или параметры.
- **Замер:** `npm run ai:bench` прогоняет шесть типичных запросов через весь
  конвейер с разной глубиной рассуждений (`default`, `none`, `low`, `medium`)
  и печатает время ответа, токены рассуждений, долю принятых планов и цену
  за 1000 запросов. По нему выбирается `AI_REASONING_EFFORT`. Прогон стоит
  несколько центов.
- **Что уходит в модель:** `npm run ai:trace` (или `npm run ai:trace -- "свой
  запрос"`) прогоняет сообщения с настоящей моделью и показывает исходный
  текст, ровно то, что ушло в модель, ответ, задержку и проверку: нет ли в
  исходящем запросе имён, телефонов, адресов и номеров из исходного текста.

Прокси решает только вопрос адреса. Платёжный адрес аккаунта OpenRouter
проверяется отдельно: если доступ к модели закрыт для аккаунта, проверка
покажет 403 без слова «region».

## Дорожный граф

Маршрутизация работает на собственном движке и требует собранного графа.
Сборка делается один раз и не на боевом сервере:

```bash
node scripts/build-road-graph.mjs
```

Файл `data/graph/kazan.graph` (размер зависит от сборки; граф, замеренный
при аудите документации, — около 10 МБ) копируется на сервер рядом с
приложением. Без него приложение работает, но маршруты и фильтр времени в
пути недоступны: `/api/route` отвечает `503`, интерфейс сообщает, что карта
дорог не загружена, и прямые линии не рисует — подробности в `docs/routing.md`.

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
