# Каталог диаграмм

Диаграммы написаны на Mermaid прямо в документах, где они объясняются: так у
каждой диаграммы один источник, и она не расходится с текстом. GitHub рисует
их при просмотре файла; сайт документации — через Mermaid в
[index.html](../index.html).

| Диаграмма | Тип | Где |
|---|---|---|
| Контекст системы | flowchart | [02-architecture.md](../02-architecture.md), «Контекст системы» |
| Контейнеры и хранилища | flowchart | [02-architecture.md](../02-architecture.md), «Контейнеры и хранилища» |
| Компоненты сервера | flowchart | [02-architecture.md](../02-architecture.md), «Компоненты сервера» |
| Главный сценарий: от фразы до маршрута | sequence | [02-architecture.md](../02-architecture.md) |
| Потоки данных | flowchart | [02-architecture.md](../02-architecture.md), «Потоки данных» |
| Развёртывание | flowchart | [02-architecture.md](../02-architecture.md), «Развёртывание» |
| Направление зависимостей | flowchart | [03-repository-structure.md](../03-repository-structure.md) |
| Маршрутизация запросов в сервере | flowchart | [05-backend.md](../05-backend.md) |
| Конвейер ассистента | flowchart | [06-ai-assistant.md](../06-ai-assistant.md) |
| Границы доверия (DFD) | flowchart | [07-privacy.md](../07-privacy.md) |
| Решение политики Privacy Gateway | flowchart | [07-privacy.md](../07-privacy.md) |
| Цикл A* | flowchart | [09-routing-engine.md](../09-routing-engine.md) |
| Время в пути «один ко многим» | sequence | [09-routing-engine.md](../09-routing-engine.md) |
| От текста к профилю и кандидатам | flowchart | [10-medical-search-and-data.md](../10-medical-search-and-data.md) |
| Поток демо-записи | sequence | [11-demo-booking.md](../11-demo-booking.md) |
| Воронка строгого подбора | flowchart | [11-demo-booking.md](../11-demo-booking.md) |
| Состояния слота | state | [11-demo-booking.md](../11-demo-booking.md) |
| Модель данных | ER | [13-data-model.md](../13-data-model.md) |

Диаграммы, которые были в проекте раньше: поток данных и последовательность
одного запроса в [privacy-architecture.md](../privacy-architecture.md),
раздел 1.

Проверка синтаксиса: `node docs/tools/check-docs.mjs --mermaid-out <каталог>`
сохраняет каждую диаграмму в отдельный файл `.mmd`, после чего их можно
отрисовать `@mermaid-js/mermaid-cli` (`mmdc -i файл.mmd -o файл.svg`).
