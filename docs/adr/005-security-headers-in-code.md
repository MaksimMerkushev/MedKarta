# ADR 005. Заголовки безопасности и лимиты — в коде сервера

- **Статус:** принято (реконструировано по коду)
- **Дата появления кода:** 2026-09-21 (`backend/http/securityHeaders.js`, коммит `6207ef4`)

## Контекст

Весь набор заголовков (CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`) жил только в `vercel.json`. После переезда на
собственный сервер этот файл перестал применяться, и в продакшене не было ни
защиты от кликджекинга, ни CSP, ни HSTS — по коду это было незаметно
(заголовочный комментарий [securityHeaders.js](../../backend/http/securityHeaders.js);
прежняя конфигурация — [legacy/README.md](../legacy/README.md)).

## Решение

- Заголовки выставляет сам сервер на каждый ответ
  ([server.js](../../backend/server.js), `applySecurityHeaders`).
- Ограничения частоты, бюджеты процессорного времени, потолки тела и
  таймауты — тоже в коде ([rateLimit.js](../../backend/http/rateLimit.js)).
- nginx дублирует заголовки страницы, если статику отдаёт он
  ([deployment.md](../deployment.md)).

## Последствия

- Настройки переживают смену хостинга и проверяются тестом.
- Лимиты живут в памяти процесса — при нескольких экземплярах нужен внешний
  стор ([18-known-limitations.md](../18-known-limitations.md), R1).

## Как проверяется

[boundary.test.js](../../tests/boundary.test.js) («Заголовки безопасности
живут в коде»), [second-audit.test.js](../../tests/second-audit.test.js),
[third-audit.test.js](../../tests/third-audit.test.js).
