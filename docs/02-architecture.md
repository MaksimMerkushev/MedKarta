# 02. Архитектура

Документ описывает систему на четырёх уровнях: контекст (кто с кем
взаимодействует), контейнеры (что запускается и где хранятся данные),
компоненты сервера и потоки данных главного сценария. В конце — схема
развёртывания и принципы, на которых держится архитектура.

## Контекст системы

```mermaid
flowchart LR
    user(["Пользователь<br/>браузер на компьютере или телефоне"])

    subgraph mk["МедКарта"]
        spa["Веб-приложение<br/>React SPA"]
        api["API-сервер<br/>Node.js"]
    end

    llm["Провайдер языковой модели<br/>OpenAI-совместимый API<br/>необязательно"]
    proxy["HTTP CONNECT или SOCKS5 прокси<br/>необязательно"]
    tiles["tile.openstreetmap.org<br/>подложка карты"]
    ext["Яндекс Карты и 2ГИС"]
    overpass["Overpass API<br/>выгрузка OpenStreetMap"]
    sites["Сайты клиник и больниц"]
    upstash["Upstash Redis<br/>необязательно"]

    user --> spa
    spa -->|"JSON по HTTPS, тот же origin"| api
    spa -->|"тайлы карты"| tiles
    user -.->|"ссылка по нажатию,<br/>координаты в URL"| ext
    api -->|"обезличенное описание запроса"| proxy
    proxy --> llm
    api -.->|"токены сессии, если<br/>TOKEN_VAULT_BACKEND=upstash"| upstash
    overpass -.->|"разовая сборка графа<br/>npm run build:graph"| api
    sites -.->|"сборщик данных<br/>npm run data:collect / data:verify"| api
```

Сплошные стрелки — работа во время запросов пользователя, пунктир —
необязательные связи и офлайн-скрипты, которые запускаются вручную и не на
боевом сервере ([routing.md](routing.md), [data-pipeline.md](data-pipeline.md)).

Что важно на этом уровне:

- **Браузер ходит только в собственный API** — `connect-src 'self'` в CSP
  ([securityHeaders.js](../backend/http/securityHeaders.js)). Единственный
  внешний хост в политике — тайлы OpenStreetMap в `img-src`.
- **Внешняя модель необязательна.** Без ключа ассистент работает на
  локальном планировщике ([pipeline.js](../backend/pipeline.js)).
- **Координаты пользователя не уходят третьим лицам** при построении маршрута
  и расчёте времени в пути: их обрабатывает собственный движок
  ([api/route.js](../backend/api/route.js)). Исключения — тайлы карты (видно,
  какой участок открыт) и ссылки во внешние карты, которые пользователь
  открывает сам ([externalMaps.js](../frontend/src/externalMaps.js)).

## Контейнеры и хранилища

```mermaid
flowchart TB
    subgraph browser["Браузер"]
        spa["SPA: React 19 + Leaflet<br/>frontend/src"]
        ls[("localStorage<br/>избранное, тема, программа ДМС,<br/>демо-записи, флаг демо")]
        ss[("sessionStorage<br/>id диалога ассистента,<br/>id сессии аналитики")]
        spa --- ls
        spa --- ss
    end

    subgraph server["Сервер"]
        nginx["nginx<br/>TLS, статика dist/, limit_req<br/>рекомендуемая схема"]
        node["Node API<br/>backend/server.js<br/>127.0.0.1:3001"]
        mem[("Память процесса<br/>Token Vault, лимиты частоты,<br/>кеши маршрутов, метрики")]
        roadgraph[("data/graph/kazan.graph<br/>граф дорог, вне git")]
        catalog[("data/*.js, data/demo/*<br/>справочники, в git")]
        full[("data/doctors.full.js<br/>полная база врачей, вне git")]
        acc[("var/accounts/medkarta.sqlite<br/>кабинет")]
        demo[("var/demo/booking.sqlite<br/>демо-запись")]
        an[("var/analytics/*.jsonl<br/>события аналитики")]
    end

    spa -->|"HTTPS"| nginx
    nginx -->|"/api/*"| node
    node --- mem
    node --> roadgraph
    node --> catalog
    node -.-> full
    node --> acc
    node --> demo
    node --> an
```

| Контейнер | Технология | Ответственность | Код |
|---|---|---|---|
| SPA | React 19, Vite 8, Tailwind 4, Leaflet | карта, фильтры, ассистент, кабинет, демо-запись; расстояния, «топ-3» и покрытие ДМС считаются здесь | [frontend/src/](../frontend/src/App.jsx) |
| API-сервер | Node.js `node:http`, без фреймворков | все `/api/*`, при `SERVE_STATIC` — статика из `dist/`, заголовки безопасности | [backend/server.js](../backend/server.js) |
| nginx | конфигурация из документации | TLS, статика, ограничение частоты до Node | [deployment.md](deployment.md) |
| SQLite кабинета | `node:sqlite` | пользователи, сессии, избранное | [sqliteStore.js](../backend/accounts/sqliteStore.js) |
| SQLite демо-записи | `node:sqlite` | слоты, удержания, записи | [bookingStore.js](../backend/demo/bookingStore.js) |
| Журнал аналитики | файлы JSON Lines по дням | обезличенные продуктовые события | [eventStore.js](../backend/analytics/eventStore.js) |
| Граф дорог | бинарный файл `GMK1` | маршруты и время в пути | [format.js](../backend/routing/format.js) |

nginx в репозитории не конфигурируется — его настройки приведены в
[deployment.md](deployment.md). Без nginx `backend/server.js` сам отдаёт
`dist/` со сжатием gzip и `ETag` ([05-backend.md](05-backend.md)).

## Компоненты сервера

```mermaid
flowchart LR
    subgraph http["HTTP-слой: backend/http, backend/api"]
        chat["api/chat.js"]
        route["api/route.js"]
        tt["api/travelTimes.js"]
        demoapi["api/demoBooking.js"]
        account["api/account.js"]
        events["api/events.js"]
        config["api/config.js"]
        limits["http/rateLimit.js<br/>лимиты, бюджеты CPU"]
    end

    subgraph ai["Конвейер ассистента"]
        pipeline["pipeline.js"]
        gateway["privacy/gateway.js<br/>Privacy Gateway"]
        vault["storage/tokenVault.js"]
        planner["planner/client.js<br/>внешний планировщик"]
        local["planner/localPlanner.js"]
        validator["planner/validator.js"]
        policy["executor/policyEngine.js"]
        executor["executor/actions.js"]
        result["executor/resultBuilder.js"]
        bridge["demo/chatBridge.js"]
    end

    subgraph domain["Предметные модули"]
        engine["routing/engine.js<br/>граф, A*, Дейкстра"]
        search["demo/search.js<br/>строгий подбор"]
        store["demo/bookingStore.js"]
        accounts["accounts/service.js"]
        analytics["analytics/eventStore.js"]
        catalogmod["privacy/catalog.js<br/>справочник"]
    end

    obs["observability/<br/>safeLogger, metrics"]

    chat --> pipeline
    pipeline --> gateway
    gateway --> vault
    pipeline --> planner
    pipeline --> local
    planner --> validator
    pipeline --> policy
    policy --> vault
    pipeline --> executor
    executor --> engine
    pipeline --> result
    pipeline --> bridge
    gateway --> catalogmod
    route --> engine
    tt --> engine
    demoapi --> search
    demoapi --> store
    search --> engine
    search --> store
    account --> accounts
    events --> analytics
    chat --> limits
    route --> limits
    pipeline --> obs
```

| Компонент | Ответственность | Подробно |
|---|---|---|
| Privacy Gateway | разбор реплик: детекторы ПДн, связывание со справочником, классификатор жалоб, условия записи, решение «можно ли к модели», сборка `SanitizedPlannerRequest` | [07-privacy.md](07-privacy.md) |
| Token Vault | соответствия `@DOCTOR_A → id справочника`, ключ — HMAC от сессии и запроса, TTL | [07-privacy.md](07-privacy.md) |
| Внешний планировщик | единственный исходящий вызов модели; принимает только `SanitizedPlannerRequest`; повторная проверка тела перед отправкой | [06-ai-assistant.md](06-ai-assistant.md) |
| Локальный планировщик | детерминированный план по уже извлечённым структурам | [06-ai-assistant.md](06-ai-assistant.md) |
| Validator и Policy Engine | строгая проверка JSON-плана; авторизация токенов в сессии, бюджет сложности | [06-ai-assistant.md](06-ai-assistant.md), [08-security.md](08-security.md) |
| Executor и Result Builder | исполнение плана по справочнику, выбор ближайшего, шаблонный ответ | [06-ai-assistant.md](06-ai-assistant.md) |
| chatBridge и строгий подбор | превращение понятых условий в запрос подбора; исполнение подбора по демо-набору | [11-demo-booking.md](11-demo-booking.md) |
| Движок маршрутизации | граф в типизированных массивах, A*, «один ко многим», привязка к дороге | [09-routing-engine.md](09-routing-engine.md) |
| Кабинет | сессии в cookie, scrypt, SQLite | [accounts.md](accounts.md) |
| Наблюдаемость | журнал по белому списку полей, метрики с перечислимыми метками | [17-performance-and-observability.md](17-performance-and-observability.md) |

## Главный сценарий: от фразы до маршрута

Сценарий демо-режима: пользователь пишет «Нужен лор завтра после 18:00 не
дороже 3000 рублей», выбирает время, записывается и строит маршрут.

```mermaid
sequenceDiagram
    autonumber
    actor U as Пользователь
    participant SPA as SPA (браузер)
    participant API as /api/chat
    participant GW as Privacy Gateway
    participant LLM as Внешняя модель
    participant PE as Validator + Policy Engine
    participant EX as Executor + Result Builder
    participant BR as chatBridge
    participant DS as /api/demo/search
    participant BS as bookingStore (SQLite)
    participant RT as /api/route

    U->>SPA: текст запроса
    SPA->>API: POST messages (только реплики пользователя), sessionId
    API->>GW: разбор всех реплик диалога
    GW-->>API: решение, контекст, условия записи
    alt внешний вызов разрешён и настроен
        API->>LLM: обезличенное описание запроса + JSON Schema
        LLM-->>PE: JSON-план
    else локальный путь
        API->>PE: план локального планировщика
    end
    PE->>EX: авторизованный план
    EX-->>API: действие интерфейса (фильтры, ответ)
    API->>BR: условия записи из разбора текста
    BR-->>API: booking.request и summary
    API-->>SPA: action
    SPA->>DS: booking.request + точка отправления + программа ДМС
    DS-->>SPA: status ok, варианты со слотами
    U->>SPA: выбирает время
    SPA->>BS: POST /api/demo/hold, затем /api/demo/bookings
    BS-->>SPA: номер записи, токен отмены
    SPA->>RT: POST waypoints, profile
    RT-->>SPA: геометрия маршрута по дорогам
```

Ключевые свойства сценария (проверены тестами
[demo-scenarios.test.js](../tests/demo-scenarios.test.js) и
[pipeline.integration.test.js](../tests/pipeline.integration.test.js)):

- условия записи («завтра», «после 18:00», «до 3000 ₽») берутся из
  детерминированного разбора текста, а не из ответа модели — модель не может
  их потерять или ослабить ([chatBridge.js](../backend/demo/chatBridge.js));
- точка отправления и программа ДМС уходят только в `/api/demo/search`, в
  `/api/chat` их нет ([services/demoBooking.js](../frontend/src/services/demoBooking.js),
  [services/ai.js](../frontend/src/services/ai.js));
- запись — симуляция: ничего не отправляется в клиники, страховые и МИС.

## Потоки данных

```mermaid
flowchart LR
    subgraph client["Браузер"]
        text["Текст запроса"]
        geo["Геолокация"]
        plan["Программа ДМС"]
        fav["Избранное"]
    end

    subgraph trusted["Доверенный контур: сервер МедКарты"]
        gw["Privacy Gateway"]
        exec["Executor"]
        demo["Строгий подбор"]
        routing["Движок маршрутов"]
        accdb[("Кабинет")]
        log["Журнал по белому списку"]
    end

    llm["Внешняя модель"]

    text -->|"/api/chat"| gw
    gw -->|"только перечислимые значения и метки"| llm
    llm -->|"JSON-план"| exec
    geo -->|"/api/route, /api/travel-times,<br/>/api/demo/search"| routing
    geo --> demo
    plan -->|"/api/demo/search"| demo
    plan -->|"после входа"| accdb
    fav -->|"после входа"| accdb
    gw --> log
    routing --> log
```

| Данные | Куда попадают | Чего не происходит |
|---|---|---|
| Текст реплик | сервер (разбор в памяти) | не пишется в журнал; в режиме `structured` не уходит модели ни одним словом |
| Координаты пользователя | сервер — маршрут, время в пути, строгий подбор | не пишутся в журнал, не уходят модели; в `/api/chat` клиент их не отправляет |
| Программа ДМС | `localStorage`; `/api/demo/search`; кабинет после входа | не уходит в `/api/chat` |
| Email, имя, хэш пароля | SQLite кабинета | не связаны с ассистентом |
| События аналитики | файлы JSON Lines | без текста поиска, координат, IP |

Подробная модель — в [07-privacy.md](07-privacy.md).

## Развёртывание

Рекомендуемая схема из [deployment.md](deployment.md): одна машина, nginx
снаружи, Node только на `127.0.0.1`.

```mermaid
flowchart TB
    internet(["Интернет"])

    subgraph vps["VPS: рассчитано на 1 vCPU и 2 ГБ"]
        ufw["ufw: открыты 22, 80, 443"]
        subgraph nginxbox["nginx"]
            tls["TLS: Let's Encrypt"]
            static["dist/: статика,<br/>кеш assets/ на год"]
            proxyapi["location /api/: proxy_pass,<br/>limit_req, limit_conn"]
        end
        subgraph systemd["systemd: medkarta.service"]
            app["node backend/server.js<br/>HOST=127.0.0.1 PORT=3001<br/>SERVE_STATIC=off TRUST_PROXY=1"]
        end
        files[("var/, data/graph/,<br/>data/doctors.full.js, .env")]
    end

    internet --> ufw --> tls
    tls --> static
    tls --> proxyapi
    proxyapi --> app
    app --> files
```

Параметры unit-файла, nginx и порядок шагов — [15-deployment.md](15-deployment.md).

## Архитектурные принципы

Принципы ниже не декларация: у каждого есть механизм в коде.

| Принцип | Механизм | Где проверяется |
|---|---|---|
| Внешняя модель — недоверенный компонент | вход модели — только `SanitizedPlannerRequest`; выход — строгий валидатор и Policy Engine; текст ответа собирается шаблонами | [boundary.test.js](../tests/boundary.test.js), [planner-validation.test.js](../tests/planner-validation.test.js) |
| Fail-closed | при сомнении — локальный план, а не отправка | [policies.js](../backend/privacy/policies.js), [outbound-leakage.test.js](../tests/outbound-leakage.test.js) |
| Детерминированные условия | подбор исполняет код по разбору текста, модель выбирает только действие | [chatBridge.js](../backend/demo/chatBridge.js), [demo-scenarios.test.js](../tests/demo-scenarios.test.js) |
| Безопасность в коде, а не в настройках хостинга | заголовки ставит сервер; лимиты — в процессе | [securityHeaders.js](../backend/http/securityHeaders.js), [boundary.test.js](../tests/boundary.test.js) |
| Общий контракт фронтенда и сервера | `shared/` — единственное место общих правил; фронтенд и бэкенд не импортируют друг друга | проверено поиском по импортам при аудите; отдельного теста нет ([18-known-limitations.md](18-known-limitations.md)) |
| Слабый сервер как ограничение | один поток разбора, бюджеты процессорного времени, плоские массивы в движке | [rateLimit.js](../backend/http/rateLimit.js), [astar.js](../backend/routing/astar.js) |

Решения и рассмотренные альтернативы — в [adr/](adr/README.md).
