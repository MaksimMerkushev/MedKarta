# 15. Развёртывание

Пошаговая инструкция: локальный запуск, сервер и публикация документации.
Полные конфигурации nginx и systemd с пояснениями — в
[deployment.md](deployment.md); здесь — порядок действий и проверки. Все
адреса и секреты ниже — заглушки.

## Требования

| Что | Версия или условие | Зачем |
|---|---|---|
| Node.js | 22 (`.nvmrc`); не ниже **22.13** для кабинета и демо-записи | `node:sqlite` без флага |
| npm | поставляется с Node | установка зависимостей фронтенда |
| Граф дорог `data/graph/kazan.graph` | собирается отдельно, не в git | маршруты и время в пути |
| Полная база врачей `data/doctors.full.js` | необязательно, не в git | без неё — публичный срез из 6 врачей |
| Ключ модели | необязательно | без него ассистент работает на локальном планировщике |

Серверный код не имеет npm-зависимостей в рантайме; `npm ci` нужен для
сборки фронтенда и для разработки.

## Локально

### Режим разработки

```bash
npm ci
npm run dev            # Vite + обработчики API; демо-набор включён по умолчанию
```

Откройте адрес, который напечатает Vite (dev-сервер слушает только
`localhost`). `.env` не обязателен.

### Как на сервере

```bash
npm ci
npm run build                                   # dist/
cp .env.example .env                            # при необходимости заполнить
DEMO_DATA=on npm start                          # http://127.0.0.1:3001 (то же: npm run start:demo)
```

С «замороженным» временем демо:

```bash
DEMO_NOW=2026-10-12T12:00:00+03:00 npm run demo:reset
DEMO_DATA=on DEMO_NOW=2026-10-12T12:00:00+03:00 npm start
```

### Граф дорог

Собирается один раз, на машине с сетью, **не** на боевом сервере
([routing.md](routing.md)):

```bash
npm run build:graph                 # Казань и все точки справочника
ls -lh data/graph/kazan.graph
```

Без графа приложение работает: маршруты и фильтр времени в пути отвечают
«карта дорог недоступна» (`503`), а не рисуют прямые линии.

### Проверка, что всё поднялось

В журнале запуска (stdout, JSON по строке) ищите:

- `routing.graph_loaded` с числом узлов — граф загружен
  (`routing.graph_unavailable` — нет файла или он повреждён);
- `server.started` с `routing_provider: local` и `status: api+static`
  или `api-only`.

Выделенного эндпоинта проверки здоровья нет; лёгкий запрос для проверки —
`GET /api/config`:

```bash
curl -s http://127.0.0.1:3001/api/config
# {"demo":true,"booking":true,"publicClinics":false,"settings":{"appName":"МедКарта",…}}
```

## Сервер (VPS)

Рекомендуемая схема — одна машина: nginx снаружи (TLS, статика, ограничение
частоты), Node только на `127.0.0.1:3001`
([02-architecture.md](02-architecture.md), раздел «Развёртывание»).

1. **Системный пользователь и код:**

   ```bash
   sudo adduser --system --group --home /srv/medkarta medkarta
   sudo -u medkarta git clone <URL репозитория> /srv/medkarta/app
   cd /srv/medkarta/app
   sudo -u medkarta npm ci && sudo -u medkarta npm run build
   ```

2. **Секреты:** `cp .env.example .env`, заполнить, `chmod 600 .env`.
   Обязательно — `PRIVACY_TOKEN_SECRET`; за nginx — `TRUST_PROXY=1`;
   рекомендуется — `ALLOWED_HOSTS` ([14-configuration.md](14-configuration.md)).
3. **Данные вне git:** скопировать `data/graph/kazan.graph` и, при наличии,
   `data/doctors.full.js`.
4. **Каталоги для записи:**

   ```bash
   sudo -u medkarta mkdir -p var data/collected data/review
   ```

5. **systemd:** unit-файл `medkarta.service` из [deployment.md](deployment.md)
   (`NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3001`,
   `SERVE_STATIC=off`, `TRUST_PROXY=1`, `Restart=always`, `MemoryMax=1200M`,
   песочница `ProtectSystem=strict` с `ReadWritePaths` для `var/` и каталогов
   сборщика). Затем:

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now medkarta
   journalctl -u medkarta -f
   ```

6. **nginx и HTTPS:** сертификат Let's Encrypt (`certbot --nginx`), сниппет
   заголовков безопасности и конфигурация сайта из [deployment.md](deployment.md):
   статика из `dist/`, `location /api/` с `proxy_pass` и `limit_req`,
   журнал **без строки запроса** и без тел.
7. **Межсетевой экран:** открыть только SSH, 80 и 443; порт 3001 снаружи
   закрыт. Вход по SSH — только по ключу.
8. **Проверка:** `curl -s https://<домен>/api/config`; в браузере — карта,
   ассистент, построение маршрута.

### Обновление

```bash
cd /srv/medkarta/app && sudo -u medkarta git pull && sudo -u medkarta npm ci \
  && sudo -u medkarta npm test && sudo -u medkarta npm run build \
  && sudo systemctl restart medkarta
```

Граф обновляется без перезапуска: замените файл — сервер подхватит его в
течение 30 секунд ([09-routing-engine.md](09-routing-engine.md)).

### Выпуск с аккаунтами и админ-панелью

Первый выпуск, где база аккаунтов переходит на схему 3 (роли, статусы,
журналы). Миграция необратима, поэтому порядок такой:

1. **Копия базы до обновления** (сервис работает; на старом коде команды
   `npm run accounts` ещё нет):

   ```bash
   sqlite3 /srv/medkarta/app/var/accounts/medkarta.sqlite ".backup '/backup/accounts-before-v3.sqlite'"
   ```
2. **Код и проверки:** `git pull`, `npm ci`, `npm test`, `npm run lint`,
   `npm run build` — как в «Обновлении», но **без** перезапуска.
3. **Перезапуск:** `sudo systemctl restart medkarta` — миграция применяется
   при открытии базы; в журнале `server.started` — `action: accounts_ready`.
   Прежние аккаунты получают роль «Пользователь», демо-аккаунты работают как
   раньше.
4. **Главный администратор** — в терминале сервера (пароль вводится вручную,
   не отображается и в `.env` не попадает; сервер останавливать не нужно):

   ```bash
   cd /srv/medkarta/app && sudo -u medkarta npm run accounts -- bootstrap
   ```

   Вариант — один раз запустить сервис с `ADMIN_BOOTSTRAP_PASSWORD` в
   окружении и сразу убрать переменную.
5. **Проверка:** вход на `https://<домен>/admin`, дашборд открывается,
   `npm run accounts -- status` показывает схему 3 и одного
   суперадминистратора; `POST /api/auth/register` отвечает `404`.
6. **Тестовые пользователи в production не создаются** (`seed-test-users`
   откажется при `NODE_ENV=production`); настоящие аккаунты — в разделе
   «Пользователи».
7. **По желанию — доступ к `/admin` только из своих сетей** в nginx
   (`location /admin` и `location /api/admin/` с `allow … ; deny all;`): второго
   фактора у входа нет. Это изменение конфигурации сервера — делайте его
   осознанно.

Откат: остановить сервис, вернуть прежний код и файл базы из копии шага 1
(`chmod 600`), запустить. Всё, что изменилось после копии, будет потеряно.

### Выпуск с приглашениями (схема 4)

Пароли больше не выдаются администратором: новый пользователь получает
ссылку-приглашение и задаёт пароль сам. Порядок:

1. **Копия базы** до `git pull`: `sudo -u medkarta npm run accounts -- backup
   --out /backup/accounts-before-v4.sqlite` (миграция необратима).
2. **Код и проверки:** `git pull`, `npm ci` (появилась зависимость `motion`),
   `npm test`, `npm run lint`, `npm run build` — без перезапуска.
3. **Почта (по желанию, можно позже)** — в `/srv/medkarta/app/.env`:
   `APP_URL=https://<домен>`, `MAIL_FROM`, `SMTP_URL` (или `SMTP_HOST` и
   др.) — [14-configuration.md](14-configuration.md#почта-приглашения-и-ссылки-для-входа).
   Без почты приглашения работают в ручном режиме: ссылку видит
   администратор и передаёт сам.
4. **Перезапуск** — миграция при открытии базы: у всех аккаунтов с паролем
   заполняется «активирован», входы не меняются.
5. **Проверка:** `npm run accounts -- status` — схема 4, «ожидают активации: 0»,
   строка «Почта: …»; в «Системе» — компонент «Письма с приглашениями».
   Создайте пользователя на свой второй адрес и пройдите приглашение до входа.
6. **nginx** менять не нужно: `/login` и `/activate` — пути SPA, токен во
   фрагменте адреса в журналы не попадает.

Откат — как выше: прежний код и файл базы из копии шага 1.

Потеря доступа к админ-панели — `npm run accounts -- access-link --email …`
(ссылка в терминал, если почта не настроена), `reset-password --email …`
(то же и завершить все сессии) или `restore-admin --email …` на сервере
([accounts.md](accounts.md#потеря-доступа)).

### Резервные копии

Раз в сутки на другую машину: `.env`, `data/doctors.full.js`, `data/graph/`,
`data/collected/`, `var/analytics/`, базы `var/accounts/medkarta.sqlite` и
`var/demo/booking.sqlite`. Горячая копия базы аккаунтов (целостный снимок
через `VACUUM INTO`, права 600):

```bash
sudo -u medkarta npm run accounts -- backup --out /backup/accounts-$(date +%F).sqlite
```

### Перед выкладкой

1. `npm test` и `npm run lint` проходят.
2. `npm run audit:security`; версия Vite — не ниже рекомендованной в
   [SECURITY.md](../SECURITY.md).
3. Задан `PRIVACY_TOKEN_SECRET`.
4. В сборке нет секретов: `grep -R "sk-" dist/ || echo "чисто"`.
5. `data/doctors.full.js` не попал в git: `git check-ignore data/doctors.full.js`.
6. Граф на месте: `ls -lh data/graph/kazan.graph`.
7. Обратный прокси, APM и Sentry не пишут тела запросов.
8. `ADMIN_BOOTSTRAP_PASSWORD` нет в `.env` и окружении сервиса.
9. Есть свежая копия базы аккаунтов.

## Модель за рубежом через прокси

Если сервер в РФ, а провайдер модели не принимает российские адреса, запрос
к модели (и только он) идёт через прокси `AI_PROXY_URL`: туннель HTTP CONNECT
или SOCKS5, внутри — TLS до провайдера с проверкой сертификата. Проверка
связи — `npm run ai:check`; подробности и замечания по стране прокси — в
[deployment.md](deployment.md).

## Публикация документации (GitHub Pages)

Каталог `docs/` опубликован как сайт на [docsify](https://docsify.js.org):
<https://docs.navimed.tech>. `index.html` загружает docsify и Mermaid с CDN
`cdn.jsdelivr.net`, файл `.nojekyll` отключает обработку Jekyll.

1. В репозитории: **Settings → Pages → Build and deployment → Source: Deploy
   from a branch**, ветка `main`, папка **`/docs`**, Save.
2. В DNS домена — запись `CNAME docs → <владелец>.github.io` (без пути и
   протокола).
3. В **Settings → Pages → Custom domain** — `docs.navimed.tech`, Save. GitHub
   хранит домен в файле `docs/CNAME`. Когда проверка DNS пройдёт и сертификат
   будет выпущен, включите **Enforce HTTPS**.

Адреса страниц — без «#» (режим `history` в docsify, настройка в
[assets/site.js](assets/site.js)): `docs.navimed.tech/09-routing-engine`.
Статический хостинг не знает таких адресов, поэтому прямой заход на
внутреннюю страницу обслуживает `docs/404.html` — копия `index.html`, которая
открывает ту же страницу. Следствия:

- внутренние страницы GitHub отдаёт с кодом ответа 404: браузер показывает их
  как обычно, но поисковики такие страницы не индексируют;
- сайт рассчитан на корень домена: по адресу
  `<владелец>.github.io/<репозиторий>/` без своего домена он в этом режиме
  не работает;
- после правки `index.html` скопируйте его в `404.html`; расхождение находит
  `node docs/tools/check-site.mjs`;
- старые адреса с «#» (`docs.navimed.tech/#/09-routing-engine`) переводятся
  в новые автоматически.

Если GitHub пишет «DNS check unsuccessful» (`InvalidDNSError`), а `dig`
показывает правильную запись, — проверка GitHub не получает ответ от
DNS-серверов домена. Так было, пока DNS `navimed.tech` обслуживали серверы
Рег.ру; решение — перенос DNS домена в Cloudflare (записи в режиме «DNS
only», регистрация домена осталась в Рег.ру).

Ссылки на исходный код на сайте ведут на файлы коммита `d9c0de6` в
репозитории GitHub; если репозиторий закрыт, они открываются только у тех,
у кого есть к нему доступ. Публикация Pages из закрытого репозитория
доступна не на всех тарифах GitHub.
