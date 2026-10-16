# 16. Тестирование

Тесты написаны на встроенном `node:test`, без сторонних фреймворков, и не
требуют сети: внешняя модель заменяется заглушкой, справочник — фикстурой
или настоящими файлами `data/`, граф — синтетической решёткой или настоящим
графом, если он есть.

## Результаты прогона при аудите

Все числа ниже получены запуском, а не взяты из документов.

| Среда | Режим | Тестов | Прошло | Упало | Пропущено наборов | Время |
|---|---|---:|---:|---:|---:|---:|
| Машина разработчика: Linux arm64 (ВМ на Apple Silicon), 4 vCPU, Node 22.23.2, **с графом** `data/graph/kazan.graph` | `structured` (по умолчанию) | 848 | 848 | 0 | 0 | 12,9 с |
| то же | `hybrid` (`PRIVACY_OUTBOUND_MODE=hybrid`) | 848 | 848 | 0 | 0 | — |
| Изолированная среда аудита: Linux x64, 2 vCPU, Node 22.22.2, **без графа** | `structured` | 840 | 840 | 0 | 3 | 46,7 с |
| то же | `hybrid` | 840 | 840 | 0 | 3 | 46,9 с |

- Команда: `node --test tests/*.test.js` в чистой копии коммита `d9c0de6`
  (`git archive`), без локальных изменений рабочей копии.
- Разница 848 − 840 = 8 тестов: три набора требуют настоящий граф и без
  него пропускаются целиком — «Демо-набор: точки филиалов на графе дорог»,
  «Демо-сценарии: время в пути по графу дорог», «Настоящий граф Казани».
- 147 наборов (`describe`) в обеих средах.

### Линтер и сборка

| Проверка | Результат |
|---|---|
| `eslint .` | 0 ошибок, 0 предупреждений (машина разработчика, 5,0 с) |
| `vite build` | **не выполнялась**: в Linux-ВМ нет нативного модуля `rolldown` для linux-arm64 (зависимости установлены под macOS), а у среды аудита нет доступа к реестру npm |
| `npm audit` | не выполнялся по той же причине |

## Состав набора

Числа тестов — из прогона в среде без графа; в скобках — сколько добавляется
при наличии графа.

| Файл | Тестов | Область |
|---|---:|---|
| [accounts.test.js](../tests/accounts.test.js) | 35 | кабинет: scrypt, сессии, лимиты входа, CSRF, cookie, демо-аккаунты |
| [analytics.test.js](../tests/analytics.test.js) | 26 | закрытый словарь событий, журнал, квоты, отчёт |
| [best-picks.test.js](../tests/best-picks.test.js) | 15 | «три лучших варианта» |
| [booking-constraints.test.js](../tests/booking-constraints.test.js) | 188 | разбор условий записи из текста: дни, часы, цена, ДМС, район, пол, стаж, согласия |
| [booking-fuzz.test.js](../tests/booking-fuzz.test.js) | 2 | генеративная проверка: 60 сочетаний одной фразой и 60 диалогом, фиксированное зерно |
| [boundary.test.js](../tests/boundary.test.js) | 8 | граница доверия по исходникам, заголовки безопасности, статика вне `dist/` |
| [data-collector.test.js](../tests/data-collector.test.js) | 24 | сборщик: загрузка, разбор, очередь проверки, запрет внутренних адресов |
| [demo-booking.test.js](../tests/demo-booking.test.js) | 16 | хранилище записи, гонки двух процессов, перезапуск, HTTP |
| [demo-data.test.js](../tests/demo-data.test.js) | 21 (+1) | демо-набор: объём, маркировка, согласованность, детерминированность |
| [demo-scenarios.test.js](../tests/demo-scenarios.test.js) | 79 (+5) | сценарии «текст → подбор → запись» при замороженном времени, контекст диалога, уточняющие вопросы |
| [external-links.test.js](../tests/external-links.test.js) | 11 | ссылки в Яндекс Карты, 2ГИС, Госуслуги |
| [logging.test.js](../tests/logging.test.js) | 8 | безопасный журнал и метрики |
| [obfuscation.test.js](../tests/obfuscation.test.js) | 46 | маскировка ПДн: гомоглифы, невидимые символы, разрыв, транслит |
| [opening-hours.test.js](../tests/opening-hours.test.js) | 6 | разбор часов работы OSM |
| [outbound-leakage.test.js](../tests/outbound-leakage.test.js) | 19 | что уходит внешней модели |
| [pipeline.integration.test.js](../tests/pipeline.integration.test.js) | 11 | конвейер ассистента целиком |
| [place-list.test.js](../tests/place-list.test.js) | 9 | список врачей в одной точке карты |
| [planner-schema.test.js](../tests/planner-schema.test.js) | 3 | JSON Schema плана для провайдера |
| [planner-validation.test.js](../tests/planner-validation.test.js) | 18 | валидатор плана, Policy Engine, инъекции |
| [privacy-audit.test.js](../tests/privacy-audit.test.js) | 49 | регрессии состязательных аудитов приватности |
| [privacy-eval.test.js](../tests/privacy-eval.test.js) | 32 | часть размеченного набора обезличивания |
| [privacy-redaction.test.js](../tests/privacy-redaction.test.js) | 14 | замена по исходным индексам |
| [private-data.test.js](../tests/private-data.test.js) | 22 | справочник услуг и частных клиник, покрытие ДМС, ДМС в запросе ассистенту, демо-набор на сервере |
| [proxy-fetch.test.js](../tests/proxy-fetch.test.js) | 19 | транспорт через HTTP CONNECT и SOCKS5 |
| [routing-coverage.test.js](../tests/routing-coverage.test.js) | 6 (+2) | рамка графа покрывает справочник; на настоящем графе — дорога у каждой точки |
| [routing-snap.test.js](../tests/routing-snap.test.js) | 17 | привязка к дороге, частичные отрезки |
| [routing.test.js](../tests/routing.test.js) | 37 | формат графа, привязка, A* против эталонного Дейкстры, профили и границы поиска, «один ко многим», разбор OSM и запрос Overpass |
| [second-audit.test.js](../tests/second-audit.test.js) | 37 | регрессии второго аудита: закрытый словарь, номера, данные в нескольких репликах, классификатор, Token Vault, ответ модели, журнал, лимиты, часы работы, файл графа |
| [sprint1-scenario.test.js](../tests/sprint1-scenario.test.js) | 11 | потолок времени в пути из текста, детский приём, целевой запрос через конвейер, красные флаги |
| [third-audit.test.js](../tests/third-audit.test.js) | 37 | регрессии третьего аудита: перебор в регулярных выражениях, адрес клиента, красные флаги |
| [token-vault.test.js](../tests/token-vault.test.js) | 6 | Token Vault: изоляция, TTL |
| [travel-times.test.js](../tests/travel-times.test.js) | 8 | `/api/travel-times` |
| **Итого** | **840 (+8)** | |

## Как устроены тесты

- [tests/helpers.js](../tests/helpers.js): конвейер на фикстуре справочника,
  Token Vault в памяти с тестовым секретом, **записывающий планировщик** — он
  сохраняет всё, что ушло бы в сеть, и именно эти записи проверяют тесты на
  утечку.
- Фикстуры: [fixtures/catalog.js](../tests/fixtures/catalog.js) (врачи с
  однофамильцами), [fixtures/roadGraph.js](../tests/fixtures/roadGraph.js)
  (синтетический граф), `fixtures/sites/` (страницы для сборщика),
  `fixtures/legacy-demo/` (прежний формат демо-данных).
- Время в сценариях демо-записи заморожено: понедельник 12.10.2026, 12:00 МСК.
- Режим исходящего запроса берётся из `PRIVACY_OUTBOUND_MODE`, поэтому
  `npm run test:security` прогоняет весь набор в обоих режимах; тесты одного
  режима задают его явно.
- Тесты с `node:sqlite` пропускаются на Node без него (`skip: 'нужен Node 22.13+'`).

## Команды

```bash
npm test                                 # все тесты, режим structured
npm run test:hybrid                      # все тесты, режим hybrid
npm run test:security                    # оба прогона подряд
node --test tests/demo-scenarios.test.js # один файл
npm run eval:privacy                     # полный размеченный набор (~минута)
npm run lint
```

## Чего тесты не покрывают

- **Интерфейс.** Автоматических тестов React-компонентов в репозитории нет;
  тестами покрыты только чистые модули фронтенда (`bestPicks.js`,
  `placeList.js`, `externalMaps.js`, `booking.js`).
- **Настоящая модель.** Качество плана реальной модели не проверяется —
  везде заглушка; для ручной проверки есть `npm run ai:check`, `ai:bench`,
  `ai:trace` ([06-ai-assistant.md](06-ai-assistant.md)).
- **Сборка фронтенда** в `npm test` не входит.
- **Нагрузка.** Отдельных нагрузочных тестов нет; лимиты и предохранители
  проверяются модульно.

## Проверка документации

Для этой документации добавлены вспомогательные скрипты в
[docs/tools/](tools/check-docs.mjs). Они ничего не меняют в коде проекта.

| Команда | Что проверяет |
|---|---|
| `node docs/tools/check-docs.mjs` | относительные ссылки и якоря, закрытость блоков кода, отсутствие похожих на секреты строк; `--mermaid-out <каталог>` сохраняет диаграммы для проверки синтаксиса |
| `node docs/tools/check-site.mjs` | что после перевода ссылок плагином сайта ([assets/site.js](assets/site.js)) каждая ссылка ведёт на существующую страницу, файл сайта или файл репозитория, и что `404.html` совпадает с `index.html` |
| `node docs/tools/bench-routing.mjs` | воспроизводимый замер движка маршрутизации ([09-routing-engine.md](09-routing-engine.md)); нужен граф |

Синтаксис диаграмм проверялся рендером каждой диаграммы через
`@mermaid-js/mermaid-cli` (Mermaid 11.14.0), разметка — `markdownlint-cli`
с конфигурацией [docs/.markdownlint.jsonc](.markdownlint.jsonc). Результаты —
в [18-known-limitations.md](18-known-limitations.md), раздел «Проверка
документации».
