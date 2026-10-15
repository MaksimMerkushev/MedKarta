# 01. Обзор проекта

## Назначение

МедКарта помогает жителю Казани найти, **куда обратиться**: врача нужного
профиля или медицинское учреждение — с учётом расписания, района, детского
приёма, программы ДМС, цены и реального времени в пути, — и построить до него
маршрут.

Два способа задать запрос:

1. **Карта и фильтры** — классический поиск по справочнику с картой Leaflet.
2. **Ассистент** — запрос обычными словами («у ребёнка болит ухо, нужен лор
   по ДМС, не дальше 20 минут»). Ассистент превращает его в фильтры, маршрут
   или — в демо-режиме — в строгий подбор свободного времени для записи.

Чего продукт **не делает** (это зафиксировано в коде и интерфейсе):

- не ставит диагнозы и не назначает лечение — классификатор жалоб выбирает
  только профиль врача ([symptoms.js](../backend/privacy/symptoms.js));
  при «красных флагах» ассистент советует звонить 103 или 112;
- не записывает в реальные клиники: запись в демо-режиме — симуляция внутри
  МедКарты ([bookingStore.js](../backend/demo/bookingStore.js)), для реальных
  учреждений интерфейс ведёт на сайт клиники или Госуслуги
  ([booking.js](../frontend/src/booking.js));
- не хранит медицинские данные пользователя и не передаёт внешней модели его
  слова в режиме по умолчанию (подробно — [07-privacy.md](07-privacy.md)).

## Возможности и их статус

Статусы — см. [README](README.md). Ссылка «Код» указывает на главный модуль;
полная трассировка — в [traceability.md](traceability.md).

### Поиск и карта

| Возможность | Статус | Код | Примечание |
|---|---|---|---|
| Карта врачей и учреждений, кластеры, тёмная тема, мобильная вёрстка | Implemented | [App.jsx](../frontend/src/App.jsx) | Leaflet + `react-leaflet-cluster` |
| Фильтры: специальность, район, клиника, тип учреждения, форма собственности, «открыто сейчас», вечер, выходные, онлайн-запись, доступная среда, детский приём, «Мой ДМС», избранное, рейтинг, стаж, расстояние | Implemented | [App.jsx](../frontend/src/App.jsx), [SearchFilters.jsx](../frontend/src/SearchFilters.jsx) | состояние фильтров отражается в адресе страницы |
| Сортировки: по рекомендации, расстоянию, «сначала открытые», имени, клинике, цене | Implemented | [shared/contract.js](../shared/contract.js) (`SORT_MODES`), [App.jsx](../frontend/src/App.jsx) | «сначала дешевле» — когда в выдаче есть цены; «по рейтингу» и «по стажу» в списке появляются, только если их выбрал ассистент или ссылка |
| Фильтр «не дольше N минут в пути» по дорогам | Implemented | [travelTimes.js](../backend/api/travelTimes.js) | нужен граф дорог; пока сервер считает — оценка «≈» в браузере |
| Маршрут до 5 точек (машина, пешком, велосипед) | Implemented | [backend/routing/](../backend/routing/engine.js) | собственный движок; без графа — честный отказ, не прямая линия |
| Ссылки «Открыть в Яндекс Картах / 2ГИС» | Implemented | [externalMaps.js](../frontend/src/externalMaps.js) | координаты уходят в эти сервисы только по нажатию |
| «Мой ДМС»: программа и отметки покрытия | Implemented (данные — Demo) | [DmsPanel.jsx](../frontend/src/DmsPanel.jsx), [shared/dms.js](../shared/dms.js) | в репозитории только вымышленные программы «Демо-Страхования» |
| Обратная связь «Нашли, куда обратиться?» и «Данные неверны» | Implemented | [FeedbackWidgets.jsx](../frontend/src/FeedbackWidgets.jsx) | только готовые варианты, без свободного текста |

### Ассистент

| Возможность | Статус | Код | Примечание |
|---|---|---|---|
| Privacy Gateway: детекторы ПДн, entity linking, токенизация, классификатор жалоб | Implemented | [gateway.js](../backend/privacy/gateway.js) | правила и словари, не ML-модель |
| Внешняя модель как планировщик (JSON-план по схеме) | Implemented, включается конфигурацией | [planner/client.js](../backend/planner/client.js) | без ключа работает локальный планировщик |
| Локальный детерминированный планировщик | Implemented | [localPlanner.js](../backend/planner/localPlanner.js) | обязательный путь fail-closed |
| Контекст диалога (до 20 реплик пользователя), сброс словами и кнопкой | Implemented | [gateway.js](../backend/privacy/gateway.js), [services/ai.js](../frontend/src/services/ai.js) | |
| Уточняющие вопросы (утро/вечер, «следующая пятница», профиль, программа ДМС, точка отправления) | Implemented | [bookingConstraints.js](../backend/privacy/bookingConstraints.js), [chatBridge.js](../backend/demo/chatBridge.js) | в основном для демо-записи |
| «Три лучших варианта» под ответом | Implemented | [bestPicks.js](../frontend/src/bestPicks.js) | отбор в браузере |
| Экстренные «красные флаги» → 103/112 | Implemented | [symptoms.js](../backend/privacy/symptoms.js) | список правил, не медицинская экспертиза |
| Цепочка резервных провайдеров модели | Partially Implemented | [planner/client.js](../backend/planner/client.js) (`createFallbackPlanner`) | функция есть, в сборке конвейера не используется |
| Локальная LLM вместо внешней | Planned | [privacy-architecture.md](privacy-architecture.md), раздел 11 | |

### Демо-режим (`DEMO_DATA=on`)

| Возможность | Статус | Код |
|---|---|---|
| Вымышленные и реальные частные клиники с вымышленными врачами, ценами, расписанием | Demo | [generator.js](../backend/demo/generator.js), [data/demo/](../data/demo/index.js) |
| Строгий подбор свободного времени по всем условиям запроса | Demo | [search.js](../backend/demo/search.js) |
| Удержание слота, запись, отмена, «Мои демо-записи» | Demo | [bookingStore.js](../backend/demo/bookingStore.js), [BookingDialog.jsx](../frontend/src/BookingDialog.jsx) |
| Демо-аккаунты без пароля | Demo | [accounts/service.js](../backend/accounts/service.js) |
| Скрытие государственных клиник в демо | Implemented | [flags.js](../backend/demo/flags.js) |

### Аккаунты, данные, эксплуатация

| Возможность | Статус | Код | Примечание |
|---|---|---|---|
| Личный кабинет: вход, программа ДМС, избранное, удаление аккаунта | Implemented | [api/account.js](../backend/api/account.js) | SQLite через `node:sqlite` (Node 22.13+) |
| Регистрация | Implemented, выключена по умолчанию | [api/account.js](../backend/api/account.js) | `ACCOUNTS_REGISTRATION=on`; до включения нужна юридическая подготовка ([accounts.md](accounts.md)) |
| Продуктовая аналитика без ПДн и отчёт по поискам | Implemented | [api/events.js](../backend/api/events.js), [report.js](../backend/analytics/report.js) | |
| Сборщик данных частных клиник с ручной проверкой | Partially Implemented | [tools/data/](../tools/data/collector.js) | конвейер работает, но в `data/sources.json` только два демо-источника, `data/private/catalog.json` пуст |
| Проверка госврачей на сайтах учреждений | Partially Implemented | [data-verify.mjs](../scripts/data-verify.mjs) | скрипт есть; в коммите `data/verification.json` без результатов |
| Метрики конвейера | Partially Implemented | [metrics.js](../backend/observability/metrics.js) | собираются в памяти процесса, наружу не отдаются |
| Хранилище токенов в Upstash Redis | Implemented, не проверено в аудите | [tokenVault.js](../backend/storage/tokenVault.js) | по умолчанию — память процесса |
| Провайдер маршрутизации OSRM | Implemented, выключен | [executor/routing.js](../backend/executor/routing.js) | передаёт координаты третьей стороне; только явным флагом |
| PostgreSQL для кабинета | Planned | [accounts.md](accounts.md) | |
| Лимиты частоты во внешнем хранилище | Planned | [SECURITY.md](../SECURITY.md), раздел 7 | сейчас — память процесса |

## Технологический стек

| Слой | Технологии | Источник |
|---|---|---|
| Сервер | Node.js, ES-модули, `node:http`; **без npm-зависимостей в рантайме** | [package.json](../package.json), [backend/server.js](../backend/server.js) |
| Хранилища | `node:sqlite` (кабинет, демо-запись), файлы JSON Lines (аналитика), память процесса (токены, лимиты, кеши) | [sqliteStore.js](../backend/accounts/sqliteStore.js), [eventStore.js](../backend/analytics/eventStore.js) |
| Маршрутизация | собственный движок на типизированных массивах, граф из OpenStreetMap | [backend/routing/](../backend/routing/astar.js) |
| Интерфейс | React 19, Vite 8, Tailwind CSS 4, Leaflet 1.9, React-Leaflet 5, lucide-react | [package.json](../package.json) |
| Внешняя модель | OpenAI-совместимый `chat/completions` с `response_format: json_schema` | [planner/client.js](../backend/planner/client.js) |
| Тесты и качество | `node:test`, ESLint 9 (flat config) | [package.json](../package.json), [eslint.config.js](../eslint.config.js) |

Версии Node: `engines` — `^20.19.0 || >=22.12.0`; `.nvmrc` — `22`. Кабинет и
демо-запись требуют `node:sqlite` без флага, то есть Node **22.13+**; на более
старом Node они выключаются сами, остальное работает
([accounts.md](accounts.md), [demo.md](demo.md)).

Значения по умолчанию для внешней модели заданы в коде
([pipeline.js](../backend/pipeline.js)): адрес
`https://modelhub.my/v1/chat/completions`, модель `gpt-5.4-mini`. Без ключа
(`OPENROUTER_API_KEY` или `AI_API_KEY`) запросы к модели не выполняются.

## Режимы работы и деградация

Приложение спроектировано так, чтобы отсутствие внешних ресурсов не ломало
основной сценарий, а честно сужало его.

| Условие | Что происходит | Где в коде |
|---|---|---|
| Нет ключа модели или исчерпан бюджет вызовов | ассистент отвечает по локальному плану | [pipeline.js](../backend/pipeline.js) |
| Ответ модели не прошёл валидацию или Policy Engine | один раз заменяется локальным планом | [pipeline.js](../backend/pipeline.js) |
| Нет файла графа дорог | `/api/route` и `/api/travel-times` отвечают `503 routing_graph_unavailable`; выбор «ближайшего» в ассистенте — по прямой; строгий подбор с ограничением времени в пути — статус `unavailable` | [api/route.js](../backend/api/route.js), [executor/routing.js](../backend/executor/routing.js), [demo/search.js](../backend/demo/search.js) |
| Node без `node:sqlite` | кабинет и демо-запись выключены, остальное работает | [api/account.js](../backend/api/account.js), [api/demoBooking.js](../backend/api/demoBooking.js) |
| `DEMO_DATA` не задан | демо-набор, демо-запись и демо-аккаунты выключены | [demo/flags.js](../backend/demo/flags.js) |

## Данные

- Учреждения — снимок OpenStreetMap (лицензия ODbL), 487 записей в
  [data/facilities.js](../data/facilities.js) (131 с признаком
  «Государственная», 356 — «Частная»; признак выставлен эвристикой и
  скриптом [reclassify-facility-ownership.mjs](../scripts/reclassify-facility-ownership.mjs)).
- Врачи — публичный срез [data/doctors.js](../data/doctors.js) (6 записей).
  Полная база `data/doctors.full.js` в git не хранится; при сборке она
  подменяет публичный срез ([vite.config.js](../vite.config.js)). На машине
  разработчика в ней 681 запись (подсчитано при аудите), её содержимое в
  документации не описывается.
- Демо-набор — 19 клиник (12 вымышленных и 7 реальных частных), 27 филиалов,
  118 вымышленных врачей, 16 специальностей, 38 услуг, 314 цен, 3 программы
  ДМС ([data/demo/generated.js](../data/demo/generated.js), подсчитано скриптом).

Подробно — [10-medical-search-and-data.md](10-medical-search-and-data.md) и
[13-data-model.md](13-data-model.md).

## Авторы и права

- Правообладатель — «МедКарта», все права защищены: код распространяется
  **без открытой лицензии**, использование требует разрешения правообладателя
  ([LICENSE](../LICENSE), `"license": "UNLICENSED"` в `package.json`).
- Авторы коммитов в истории ветки (по `git shortlog`): Maksim Merkushev и
  MaXiMka2703. Распределение ролей в репозитории не зафиксировано.
