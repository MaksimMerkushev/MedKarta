# 12. Справочник API

Все эндпоинты обслуживает [backend/server.js](../backend/server.js) по
**точному пути**. Тела запросов и ответов — JSON (`application/json;
charset=utf-8`); ответы API не кешируются (`Cache-Control: no-store`) и
помечены `X-Robots-Tag: noindex`.

## Как получены примеры

Примеры ниже — **реальные ответы** сервера на коммите `d9c0de6`, снятые при
аудите вспомогательным скриптом. Конфигурация: `DEMO_DATA=on`,
`DEMO_NOW=2026-10-12T12:00:00+03:00`, `ANALYTICS=off`, ключ модели не задан
(ответы ассистента — локальный планировщик), граф дорог загружен. Длинные
массивы сокращены (`…`), одноразовые токены заменены на `<holdToken>`,
`<cancelToken>`, `<token>`. Врачи в примерах — **вымышленные демо-врачи**,
в том числе в реальной клинике «Будь здоров» ([demo.md](demo.md)).

OpenAPI-спецификация не приводится: запросы `/api/chat` и `/api/demo/search`
определяются функциями нормализации с десятками условных полей
([shared/contract.js](../shared/contract.js), [shared/demoSearch.js](../shared/demoSearch.js)),
и вручную написанная схема быстро разошлась бы с кодом. Источник истины —
эти функции; ниже — их описание.

## Сводная таблица

| Метод | Путь | Назначение | Обработчик |
|---|---|---|---|
| POST | `/api/chat` | запрос к ассистенту | [chat.js](../backend/api/chat.js) |
| POST | `/api/route` | маршрут по дорогам через 2–6 точек | [route.js](../backend/api/route.js) |
| POST | `/api/travel-times` | время в пути от точки до многих | [travelTimes.js](../backend/api/travelTimes.js) |
| POST | `/api/events` | события аналитики | [events.js](../backend/api/events.js) |
| GET, HEAD | `/api/config` | флаги демо-режима | [config.js](../backend/api/config.js) |
| GET, PATCH, DELETE | `/api/account` | кабинет: профиль, программа ДМС, удаление | [account.js](../backend/api/account.js) |
| POST | `/api/account/favorites` | избранное | [account.js](../backend/api/account.js) |
| POST | `/api/auth/login`, `/api/auth/register`, `/api/auth/demo`, `/api/auth/logout` | вход, регистрация, демо-вход, выход | [account.js](../backend/api/account.js) |
| POST | `/api/demo/search` | строгий подбор | [demoBooking.js](../backend/api/demoBooking.js) |
| GET | `/api/demo/slots` | расписание демо-врача | [demoBooking.js](../backend/api/demoBooking.js) |
| POST | `/api/demo/hold`, `/api/demo/release` | удержание слота | [demoBooking.js](../backend/api/demoBooking.js) |
| POST | `/api/demo/bookings`, `/api/demo/bookings/cancel`, `/api/demo/bookings/lookup` | запись, отмена, статус | [demoBooking.js](../backend/api/demoBooking.js) |

Неизвестный путь под `/api/` — `404 {"error":"Not found"}`.

## Общие правила

- **Origin.** POST-эндпоинты проверяют `Origin` (`verifyOrigin` в
  [request.js](../backend/http/request.js)): чужой — `403 {"error":"Запрос отклонён."}`.
  Запрос без `Origin` пропускается. При заданном `ALLOWED_HOSTS` неизвестный
  `Host` отклоняется.
- **Изменяющие запросы кабинета и демо-записи** дополнительно требуют
  `Content-Type: application/json` и `Sec-Fetch-Site` равный `same-origin`
  или `none`, если заголовок есть.
- **Ограничение частоты** — `429` с заголовком `Retry-After` (секунды);
  перегрузка — `503` с `Retry-After` и `code: "busy"`. Значения лимитов —
  [05-backend.md](05-backend.md).
- **Тело больше лимита** — `413` и `Connection: close`; битый JSON — `400`.
- **Внутренняя ошибка** — `500 {"error":"Внутренняя ошибка сервера."}` без
  подробностей.

---

## POST /api/chat

Запрос к ассистенту. Подробно о конвейере — [06-ai-assistant.md](06-ai-assistant.md).

**Тело** (до 32 КБ):

| Поле | Тип | Обязательно | Правила |
|---|---|---|---|
| `messages` | массив `{role, content}` | да | 1–40 элементов; `role` — `user`, иначе считается `assistant`; `content` очищается от управляющих символов и обрезается до 1000 символов; последнее непустое — от пользователя. Сервер использует только реплики пользователя |
| `sessionId` | строка | нет | `^[A-Za-z0-9_-]{12,64}$`, иначе генерируется новый; связывает метки Token Vault |
| `origin` | `{lat, lng}` | нет | учитывается только при `ALLOW_COARSE_ORIGIN=on`, огрубляется до 2 знаков; интерфейс его не отправляет |

**Ответ 200** — объект действия интерфейса (`sanitizeAiAction`), заголовок
`X-RateLimit-Remaining`.

Пример: запрос, который превращается в строгий подбор.

```http
POST /api/chat
Content-Type: application/json

{"messages":[{"role":"user","content":"Нужен лор завтра после 18:00 не дороже 3000 рублей"}],
 "sessionId":"docsExampleSession01"}
```

```json
{
  "searchQuery": null,
  "specialty": "ЛОР",
  "service": null,
  "clinic": null,
  "facilityType": null,
  "doctorProfile": null,
  "district": null,
  "services": null,
  "targetStops": [],
  "ownership": null,
  "travelMode": null,
  "cardDisplayMode": "doctor",
  "sortMode": null,
  "isChild": false,
  "buildRoute": false,
  "clearRoute": false,
  "clearFilters": false,
  "openOnly": null,
  "favoritesOnly": null,
  "weekendOnly": null,
  "eveningOnly": null,
  "onlineOnly": null,
  "wheelchairOnly": null,
  "darkMode": null,
  "minRating": null,
  "minExperience": null,
  "maxDistance": null,
  "maxTravelMinutes": null,
  "dmsOnly": false,
  "booking": {
    "request": {
      "specialty": "lor",
      "date": { "kind": "tomorrow" },
      "timeFrom": "18:00",
      "maxPrice": 3000,
      "patient": "adult",
      "dms": { "required": false, "planId": null, "prefer": false },
      "travel": { "maxMinutes": null, "mode": "driving", "nearest": false },
      "origin": null,
      "limit": 5,
      "…": "остальные поля запроса подбора со значениями по умолчанию"
    },
    "summary": ["ЛОР", "завтра", "после 18:00", "до 3 000 ₽"]
  },
  "replyText": "Ищу свободное время: ЛОР, завтра, после 18:00, до 3 000 ₽. Показываю только варианты, которые подходят под все условия, — подбор ниже. Условия без вашего согласия не ослабляю. Запись демонстрационная: врачи и расписание вымышлены."
}
```

Пример уточняющего вопроса — запрос «терапевт после 7»:

```json
{
  "specialty": "Терапевт",
  "booking": {
    "request": { "specialty": "therapist", "timeChoice": [ "…два прочтения часа…" ], "…": "…" },
    "summary": ["Терапевт", "время: после 07:00 или после 19:00 (уточните)"]
  },
  "replyText": "Понял запрос: Терапевт, время: после 07:00 или после 19:00 (уточните). Уточните, пожалуйста: после 07:00 (утра) или после 19:00 (вечера)? Ответьте «утра» или «вечера» — или нажмите кнопку ниже. Выбирать за вас не буду. Запись демонстрационная: врачи и расписание вымышлены."
}
```

Экстренный случай — «сильная боль в груди, отдаёт в руку» (8 мс, без модели
и без поиска):

```json
{
  "specialty": null,
  "replyText": "Описанное похоже на состояние, при котором нужна неотложная помощь. Пожалуйста, немедленно позвоните 103 или 112 — не ждите и не ищите врача через приложение. Я не ставлю диагнозов, но в такой ситуации лучше перестраховаться."
}
```

### Ошибки /api/chat

| Код | Тело | Когда |
|---|---|---|
| 204 | — | `OPTIONS` |
| 400 | `{"error":"Ожидается непустой массив messages."}` | пустой или не массив |
| 400 | `{"error":"Слишком длинная история диалога."}` | больше 40 сообщений |
| 400 | `{"error":"Последнее сообщение должно быть от пользователя."}` | |
| 403 | `{"error":"Запрос отклонён."}` | чужой `Origin` или `Host` |
| 405 | `{"error":"Метод не поддерживается."}`, `Allow: POST, OPTIONS` | не POST |
| 413 | `{"error":"Тело запроса слишком большое."}` | больше 32 КБ |
| 429 | `{"error":"Слишком много запросов. Попробуйте через минуту.","retryAfter":N}` | лимит запросов или процессорного времени |
| 502 | `{"error":"Не удалось обработать запрос. Попробуйте ещё раз."}` | сбой конвейера |
| 503 | `{"error":"Ассистент сейчас перегружен. Попробуйте через минуту.","code":"busy"}` | предохранитель или очередь |

---

## POST /api/route

Маршрут по дорогам собственным движком ([09-routing-engine.md](09-routing-engine.md)).

**Тело:**

| Поле | Тип | Правила |
|---|---|---|
| `waypoints` | массив `{lat, lng}` (или `lon`) | 2–6 точек; координаты — числа (строки отклоняются); каждая точка в рамке широта 54,0–57,5, долгота 47,0–51,5 |
| `profile` | строка | `driving` (по умолчанию), `foot`, `bike`; иное — `400` |

**Ответ 200:**

| Поле | Смысл |
|---|---|
| `geometry` | массив `[lat, lng]` по дорогам |
| `distance` | метры |
| `time` | секунды, свободный поток |
| `profile` | профиль |
| `snaps` | точки выхода на дорогу `{lat, lng, distanceM}` — для пунктирной подводки от здания |

```http
POST /api/route
Content-Type: application/json

{"waypoints":[{"lat":55.7963,"lng":49.1088},{"lat":55.8304,"lng":49.0661}],"profile":"driving"}
```

```json
{
  "geometry": [[55.796347568953536, 49.10885657075076], [55.795988, 49.109328], "…", [55.830442247279684, 49.06609597204944]],
  "distance": 5823,
  "time": 399,
  "profile": "driving",
  "snaps": [
    { "lat": 55.796347568953536, "lng": 49.10885657075076, "distanceM": 6 },
    { "lat": 55.830442247279684, "lng": 49.06609597204944, "distanceM": 5 }
  ]
}
```

### Ошибки /api/route

| Код | `code` | Когда |
|---|---|---|
| 400 | `outside_region` | точка вне рамки региона |
| 400 | — | неверный список точек или профиль |
| 422 | `point_far_from_road_network` (+ `point` — номер точки), `no_route_between_points`, `route_too_complex` | маршрут не построен |
| 429 | `rate_limited` | лимит запросов или процессорного времени |
| 503 | `routing_graph_unavailable` | граф дорог не загружен |
| 503 | `busy` | общий предохранитель |

---

## POST /api/travel-times

Время в пути от одной точки до многих — для фильтра «не дольше N минут».

**Тело:**

| Поле | Тип | Правила |
|---|---|---|
| `origin` | `{lat, lng}` | числа, в рамке региона |
| `mode` | строка | `driving` (по умолчанию), `foot`, `bike` |
| `maxMinutes` | целое | 5–120 |
| `points` | массив `[lat, lng]` | 1–600; точка вне рамки не ломает запрос — для неё `null` |

**Ответ 200:** `{mode, maxMinutes, durations}`, где `durations[i]` — секунды
или `null` (вне сети, вне рамки, дальше потолка).

```json
{"origin":{"lat":55.7963,"lng":49.1088},"mode":"driving","maxMinutes":20,
 "points":[[55.8304,49.0661],[55.7448,49.2113],[56.5,50.9]]}
```

```json
{ "mode": "driving", "maxMinutes": 20, "durations": [399, 717, null] }
```

**Ошибки:** `400` с `code` из `bad_origin`, `outside_region`, `bad_mode`,
`bad_limit`, `bad_points`; `429 rate_limited`; `503 routing_graph_unavailable`;
`503 busy`.

---

## POST /api/events

Пачка событий продуктовой аналитики из закрытого словаря
([shared/analytics.js](../shared/analytics.js), [analytics.md](analytics.md)).

**Тело** (до 8 КБ): `{"events":[…]}` (1–20 событий) или одно событие.
Событие с любым лишним полем отбрасывается целиком. Сверх 1500 событий в
сутки с адреса — отбрасываются.

```json
{"events":[{"type":"route_build","mode":"driving","points":2,"outcome":"ok"}]}
```

**Ответ:** всегда `204` без тела, если запрос в целом корректен — даже если
часть событий отброшена. `400` — тело не JSON, пусто или больше 20 событий.

---

## GET /api/config

Публичные флаги для интерфейса.

```json
{ "demo": true, "booking": true, "publicClinics": false }
```

| Поле | Смысл |
|---|---|
| `demo` | `DEMO_DATA=on` |
| `booking` | демо-запись включена и доступен `node:sqlite` |
| `publicClinics` | показывать государственные учреждения (в демо по умолчанию `false`) |

---

## Кабинет: /api/account и /api/auth/*

Сессия — cookie `mk_session`: `HttpOnly; SameSite=Lax; Path=/api`, `Secure` в
продакшене. Подробности — [accounts.md](accounts.md).

| Метод и путь | Тело | Ответ | Лимит на адрес |
|---|---|---|---|
| `GET /api/account` | — | `{user, favorites, features}`; гость — `user: null` | 300 за 5 мин |
| `PATCH /api/account` | `{displayName}` или `{dmsPlanId}` (только из справочника) | `{user, favorites, features}` | 300 за 5 мин |
| `DELETE /api/account` | `{"confirm": true}` | `{user: null, …}`, cookie стирается | 300 за 5 мин |
| `POST /api/account/favorites` | `{action: "add" \| "remove" \| "merge", ids: [...]}` | `{favorites}` | 300 за 5 мин |
| `POST /api/auth/login` | `{email, password}` | `{user, favorites, features}` + cookie | 20 за 15 мин |
| `POST /api/auth/register` | `{email, password, displayName, consent: true}` | `201` + cookie; при выключенной регистрации — `403` | 20 за 15 мин |
| `POST /api/auth/demo` | `{account: "anna" \| "family" \| "kids" \| "basic"}` | демо-сессия на 12 часов; при выключенном демо — `403` | 200 за 15 мин |
| `POST /api/auth/logout` | `{}` | `{user: null, …}`, cookie стирается | 300 за 5 мин |

`features` — `{available, registration, demo, demoAccounts}`; в
`demoAccounts` — только ключ, имя и описание программы, без email.

Пример демо-входа:

```http
POST /api/auth/demo
Content-Type: application/json

{"account":"anna"}
```

```http
HTTP/1.1 200 OK
Set-Cookie: mk_session=<token>; Path=/api; HttpOnly; SameSite=Lax; Max-Age=43199
```

```json
{
  "user": {
    "email": "anna@medkarta.example",
    "displayName": "Анна (демо)",
    "dmsPlanId": "demo-standard",
    "isDemo": true,
    "createdAt": "2026-10-15T07:23:38.708Z"
  },
  "favorites": ["demo-doc-valeev-vadim--demo-yasen-centr", "demo-doc-zinnatullina-nailya--demo-yasen-centr"],
  "features": {
    "available": true,
    "registration": false,
    "demo": true,
    "demoAccounts": [
      { "key": "anna", "displayName": "Анна (демо)", "note": "Программа Demo Standard, Демо-Страхование" },
      "…"
    ]
  }
}
```

**Ошибки кабинета:** `401 {"error":"Войдите в личный кабинет."}` — изменение
без сессии; `403` — нарушена защита от CSRF или функция выключена; `429` —
лимит (`code: too_many_attempts` — 10 неудачных входов на email за 15 минут,
`Retry-After: 900`); `503` — кабинет недоступен (нет `node:sqlite` или
`ACCOUNTS=off`), при этом `GET /api/account` отвечает гостю `200`. Ошибки
сервиса кабинета возвращают `{error, code}` со статусом из
[service.js](../backend/accounts/service.js).

---

## Демо-запись: /api/demo/*

Только при `DEMO_DATA=on`, иначе `404 {"error":"Демо-запись выключена.","code":"demo_disabled"}`.
Тело — до 16 КБ. Логика — [11-demo-booking.md](11-demo-booking.md).

### POST /api/demo/search

**Тело:** `{"request": {…}}` или сам запрос. Поля запроса — таблица
«Запрос подбора» в [11-demo-booking.md](11-demo-booking.md); точка
отправления (`origin`) и программа ДМС (`dms.planId`) передаются только
здесь.

**Ответ 200** всегда содержит `status`:

| `status` | Дополнительные поля |
|---|---|
| `ok` | `total`, `options[]` (до 5), `funnel[]`, `notices[]` |
| `needs` | `needs[]`, `message`; для `dms_plan` — `plans[]`; для вопросов — `relax[]` с вариантами ответа |
| `empty` | `funnel[]`, `blocking {key, label, text}`, `relax[] {key, label, count, patch}`, `message` |
| `out_of_coverage` | `city`, `message`, `relax[]` |
| `unavailable` | `reason` (`routing_unavailable`, `origin_off_network`), `funnel[]`, `message`, `relax[]` |

Всегда есть `request` (нормализованный), `applied[]` (условия словами),
`today`, `timezone: "Europe/Moscow"`, `demo: true`.

Пример — запрос из примера `/api/chat` с точкой отправления:

```json
{
  "applied": ["ЛОР", "завтра", "после 18:00", "до 3 000 ₽"],
  "today": "2026-10-12",
  "timezone": "Europe/Moscow",
  "demo": true,
  "status": "ok",
  "notices": [],
  "total": 4,
  "options": [
    {
      "id": "demo-doc-gimadiev-lenar--demo-real-budzdorov-narimanova",
      "demo": true,
      "doctor": {
        "id": "demo-doc-gimadiev-lenar",
        "name": "Гимадиев Ленар Николаевич",
        "specialty": "ЛОР",
        "specialtyKey": "lor",
        "experienceYears": 21,
        "gender": "male",
        "ageGroups": ["adult"]
      },
      "clinic": {
        "id": "demo-real-budzdorov",
        "name": "Будь здоров",
        "branchId": "demo-real-budzdorov-narimanova",
        "branchName": "ул. Нариманова",
        "address": "улица Нариманова, Казань",
        "district": "Вахитовский",
        "lat": 55.780437,
        "lng": 49.1097644,
        "phone": null,
        "real": true
      },
      "service": { "id": "consult.lor.first", "name": "Приём оториноларинголога (ЛОР) первичный", "durationMinutes": 30 },
      "price": 2950,
      "coverage": null,
      "travel": { "minutes": 2, "distanceKm": 2.275, "mode": "driving" },
      "nextSlot": {
        "id": "demo-doc-gimadiev-lenar--demo-real-budzdorov-narimanova--20261013-1800",
        "day": "2026-10-13",
        "start": "18:00",
        "end": "18:30",
        "startAt": "2026-10-13T15:00:00.000Z",
        "endAt": "2026-10-13T15:30:00.000Z",
        "status": "FREE",
        "bookable": true,
        "past": false,
        "…": "clinicId, branchId, doctorId, serviceId, updatedAt"
      },
      "slots": ["…до 6 ближайших слотов…"],
      "today": "2026-10-12"
    },
    "…ещё 3 варианта…"
  ],
  "funnel": [
    { "key": "specialty", "label": "врачи нужного профиля", "count": 14 },
    { "key": "age", "label": "ведут приём для этого возраста", "count": 11 },
    { "key": "service", "label": "оказывают нужную услугу", "count": 11 },
    { "key": "price", "label": "укладываются в цену", "count": 11 },
    { "key": "dms", "label": "входят в программу ДМС", "count": 11 },
    { "key": "travel", "label": "укладываются во время в пути", "count": 11 },
    { "key": "slots", "label": "есть свободное время в нужные дни и часы", "count": 4 }
  ]
}
```

Без профиля (`{"request":{"date":{"kind":"tomorrow"}}}`):

```json
{ "applied": ["завтра"], "status": "needs", "needs": ["specialty"],
  "message": "Уточните, к какому специалисту нужно записаться.", "…": "…" }
```

### GET /api/demo/slots

Параметры строки запроса: `doctorId` (обязательно), `branchId`, `from`
(`ГГГГ-ММ-ДД`, не раньше сегодня), `days` (1–14, по умолчанию 7), `planId`,
`patient` (`child`). Ответ: `demo`, `timezone`, `now {day, time}`, `doctor`
(`id`, `name`, `specialty`, `ageGroups`, `branchIds`, `hoursByBranch`),
`services[]`, `prices{}`, `coverage{}` (при `planId`), `slots[]`,
`absences[]`. Ошибки: `404 doctor_not_found`, `404 branch_not_found`.

### POST /api/demo/hold

```json
{"slotId":"demo-doc-gimadiev-lenar--demo-real-budzdorov-narimanova--20261013-1800"}
```

```json
{
  "holdToken": "<holdToken>",
  "expiresAt": "2026-10-12T09:05:00.000Z",
  "ttlSeconds": 300,
  "slot": { "id": "…", "status": "HELD", "bookable": false, "…": "…" }
}
```

### POST /api/demo/release

`{slotId, holdToken}` → `{"released": true | false}`.

### POST /api/demo/bookings

**Тело:** `slotId`, `idempotencyKey` (16–80 символов `[A-Za-z0-9_-]`),
`holdToken` (если слот удержан), `planId` (необязательно, только из
справочника).

**Ответ:** `201` — новая запись; `200` — повтор с тем же ключом.

```json
{
  "booking": {
    "number": "DEMO-261012-W8U84",
    "status": "CONFIRMED",
    "createdAt": "2026-10-12T09:00:00.000Z",
    "cancelledAt": null,
    "planId": null,
    "slot": { "id": "…", "status": "BOOKED", "…": "…" },
    "cancelToken": "<cancelToken>",
    "repeated": false,
    "demo": true,
    "doctor": { "id": "demo-doc-gimadiev-lenar", "name": "Гимадиев Ленар Николаевич", "specialty": "ЛОР" },
    "clinic": { "id": "demo-real-budzdorov", "name": "Будь здоров", "branchName": "ул. Нариманова", "phone": null, "real": true, "…": "…" },
    "service": { "id": "consult.lor.first", "name": "Приём оториноларинголога (ЛОР) первичный", "durationMinutes": 30 },
    "price": 2950,
    "coverage": null
  }
}
```

### POST /api/demo/bookings/cancel

`{number, cancelToken}` → `{booking, slotReleased, alreadyCancelled}`;
неверный номер или токен — `404 booking_not_found`.

### POST /api/demo/bookings/lookup

`{items: [{number, cancelToken}, …]}` (до 20) → `{bookings: [...]}`; для
неизвестной пары — `{number, found: false}`.

**Коды ошибок записи** (`{error, code}`): `bad_request` 400;
`slot_not_found`, `booking_not_found` 404; `slot_taken`, `slot_held`,
`slot_unavailable`, `slot_past`, `slot_conflict`, `idempotency_conflict` 409.
