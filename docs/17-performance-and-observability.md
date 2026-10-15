# 17. Производительность и наблюдаемость

## Правило для чисел

В этой документации приводятся только числа, которые **получены запуском**
при аудите и сопровождаются конфигурацией: коммит, данные, железо, команда.
Числа из других документов проекта, которые при аудите не
воспроизводились, перечислены в конце раздела как непроверенные.

## Замеры

### Движок маршрутизации

Полные таблицы и методика — [09-routing-engine.md](09-routing-engine.md),
раздел «Замеры». Кратко (граф 299 833 узла, Linux arm64, 4 vCPU, Node 22.23.2,
`node docs/tools/bench-routing.mjs --pairs 1000 --seed 42`):

| Показатель | Значение |
|---|---|
| Загрузка и подготовка графа | 125 мс |
| Память: граф с индексами / состояние поиска | 14,0 МБ / 6,0 МБ |
| Маршрут между учреждениями, машина: медиана / p95 / максимум | 4,7 / 18,2 / 37,7 мс |
| Маршрут, пешком: медиана / p95 / максимум | 3,1 / 14,8 / 52,2 мс |
| Построено маршрутов из 1000 пар, все профили | 100 % |
| Время в пути от центра до 487 учреждений, машина, потолок 30 мин: первый запрос / повтор | 91,9 / 38,5 мс |

### Разбор запроса ассистента

Из прогона `node scripts/privacy-eval.mjs --split all` (22 549 примеров,
полный конвейер с заглушкой модели и настоящим справочником; публичный срез
врачей; Linux x64, 2 vCPU, Node 22.22.2):

| Режим | p50 | p95 | максимум |
|---|---:|---:|---:|
| `structured` | 3,6 мс | 5,8 мс | 826,4 мс |
| `hybrid` | 3,5 мс | 5,8 мс | 767,9 мс |

Время ответа внешней модели сюда не входит и при аудите не измерялось.
Хвост до сотен миллисекунд — длинные запросы с нечётким поиском фамилий; его
ограничивают бюджет нечётких сравнений и «ведро» процессорного времени на
адрес ([05-backend.md](05-backend.md)).

### Тесты

| Среда | Тестов | Время |
|---|---:|---:|
| Linux arm64, 4 vCPU, с графом | 848 | 12,9 с |
| Linux x64, 2 vCPU, без графа | 840 | 46,7 с |

`node --test` запускает файлы параллельно, поэтому время зависит от числа ядер.

## Что сделано ради производительности

| Мера | Где |
|---|---|
| Граф в типизированных массивах, состояние поиска выделяется один раз, счётчик поколений вместо очистки | [astar.js](../backend/routing/astar.js) |
| Один обход Дейкстры на все цели с потолком времени | [astar.js](../backend/routing/astar.js) |
| Кеш участков маршрута (256) и привязок (4096) | [engine.js](../backend/routing/engine.js) |
| Конвейер ассистента и справочник создаются один раз; одновременные первые запросы ждут одного обещания | [pipeline.js](../backend/pipeline.js), [catalog.js](../backend/privacy/catalog.js) |
| Уступка циклу событий между репликами при разборе | [gateway.js](../backend/privacy/gateway.js) |
| Очередь разбора ассистента: CPU-работа по одному запросу, ожидание модели вне очереди | [api/chat.js](../backend/api/chat.js) |
| Сжатие статики gzip с кешем в памяти, `ETag`, долгий кеш для хэшированных ассетов | [server.js](../backend/server.js) |
| Отдельные чанки для справочников и карты, ленивые компоненты | [vite.config.js](../vite.config.js), [App.jsx](../frontend/src/App.jsx) |
| Задержка поиска при вводе (debounce) | [useDebouncedValue.js](../frontend/src/hooks/useDebouncedValue.js) |

## Журнал

[safeLogger.js](../backend/observability/safeLogger.js) пишет в stdout по
одной JSON-строке на событие:

```json
{"ts":"2026-10-15T07:22:36.159Z","level":"info","event":"server.started","status":"api-only","routing_provider":"none","vault_backend":"memory"}
```

Поля — только из белого списка, строки проверяются детекторами ПДн
([07-privacy.md](07-privacy.md)). При `NODE_ENV=test` журнал выключен.
Последние 500 записей держатся в памяти процесса для тестов.

Основные события:

| Группа | События |
|---|---|
| Запуск | `server.started`, `server.bad_config`, `routing.graph_loaded`, `routing.graph_unavailable`, `routing.graph_reloaded`, `demo.booking_ready`, `account.demo_seeded`, `planner.default_upstream`, `planner.proxy`, `planner.proxy_invalid` |
| Ассистент | `gateway.decision`, `planner.usage`, `planner.invalid_plan`, `planner.not_configured`, `planner.error`, `planner.upstream_error`, `planner.transport_error`, `planner.outbound_blocked`, `policy.rejected`, `pipeline.done`, `api.chat.failed` |
| Маршруты | `routing.request`, `travel_times.request` |
| Демо-запись | `demo.search`, `demo.hold`, `demo.booking`, `demo.cancel`, `demo.booking_rejected`, `demo.booking_error` |
| Кабинет | `account.login`, `account.register`, `account.deleted`, `account.unavailable`, `account.store_failed` |
| Сбои | `server.handler_failed`, `server.request_failed`, `process.unhandled_rejection`, `process.uncaught_exception`, `analytics.write_failed` |

Пример события решения Privacy Gateway — в
[privacy-architecture.md](privacy-architecture.md), раздел 8.

## Метрики

[metrics.js](../backend/observability/metrics.js) считает счётчики и
задержки (последние 1000 значений на ключ, p50 и p95) с метками только из
перечислимых значений. Имена: `gateway.decision`, `gateway.emergency`,
`gateway.outbound_blocked`, `planner.latency_ms`, `planner.usage`,
`planner.error`, `planner.invalid_plan`, `planner.local_fallback`,
`planner.budget_exhausted`, `policy.rejected`, `policy.rejected_final`,
`pipeline.latency_ms`, `pipeline.booking_request`, `api.chat.busy`,
`api.chat.shed`, `api.chat.error`, `routing.latency_ms`, `routing.failed`,
`routing.unavailable`, `travel_times.latency_ms`, `travel_times.unavailable`,
`analytics.accepted`, `analytics.rejected`, `analytics.quota_exceeded`.

**Статус: Partially Implemented.** Метрики собираются в памяти процесса, но
наружу не отдаются: у экземпляра по умолчанию нет приёмника (`sink`), а
`snapshot()` в коде нигде не вызывается — эндпоинта метрик нет
([18-known-limitations.md](18-known-limitations.md)).

## Продуктовая аналитика

Браузер отправляет события из закрытого словаря в `/api/events`, сервер пишет
их в `var/analytics/events-ГГГГ-ММ-ДД.jsonl`; отчёт —
`npm run report:searches` (успешные и пустые поиски, воронка по сессиям,
причины «не нашёл», каналы контактов). Что собирается и чего нет — в
[analytics.md](analytics.md).

## Числа, которые при аудите не воспроизводились

| Утверждение | Где | Почему не проверено |
|---|---|---|
| «2–80 мс на маршрут через весь город» (прежняя формулировка README; заменена замером) | [README.md](../README.md) | другой набор маршрутов; при аудите получено 4,7 мс медиана и 37,7 мс максимум для машины на 1000 парах учреждений |
| Замеры на синтетической решётке 640×640 и на графе 255 386 узлов | [routing.md](routing.md) | другая сборка графа; синтетический прогон не повторялся |
| «Время в пути: первый запрос 70–200 мс, повторные 5–90 мс» | [routing.md](routing.md) | при аудите — 38–94 мс для машины и 3–63 мс пешком (таблица в 09) |
| «Ответ модели около 2 с, ~2000 токенов на входе, ~100 на выходе, около $2 за 1000 запросов» | [deployment.md](deployment.md) | требует ключа и прокси; внешняя модель при аудите не вызывалась |
| «0 утечек на 14 728 примерах» | [README.md](../README.md), [privacy-evaluation.md](privacy-evaluation.md) | получено на полной базе врачей; на публичном срезе при аудите — 0 утечек на 14 622 примерах ([07-privacy.md](07-privacy.md)) |
