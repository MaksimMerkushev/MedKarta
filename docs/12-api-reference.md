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
| POST | `/api/chat` | запрос к ассистенту (только после входа в кабинет) | [chat.js](../backend/api/chat.js), [chatAccess.js](../backend/api/chatAccess.js) |
| POST | `/api/route` | маршрут по дорогам через 2–6 точек | [route.js](../backend/api/route.js) |
| POST | `/api/travel-times` | время в пути от точки до многих | [travelTimes.js](../backend/api/travelTimes.js) |
| POST | `/api/events` | события аналитики | [events.js](../backend/api/events.js) |
| GET, HEAD | `/api/config` | флаги демо-режима и публичные настройки | [config.js](../backend/api/config.js) |
| GET, PATCH, DELETE | `/api/account` | кабинет: профиль, программа ДМС, удаление | [account.js](../backend/api/account.js) |
| POST | `/api/account/favorites` | избранное | [account.js](../backend/api/account.js) |
| POST | `/api/auth/login`, `/api/auth/demo`, `/api/auth/logout` | вход, демо-вход, выход (регистрации нет) | [account.js](../backend/api/account.js) |
| POST | `/api/auth/access-link` | «нет пароля или забыли его?» — ссылка на почту; ответ одинаков для любого адреса | [activation.js](../backend/api/activation.js) |
| GET, POST | `/api/auth/activation`, `/api/auth/activation/peek`, `/start`, `/complete` | приглашение и ссылка для смены пароля: проверить, принять, задать пароль | [activation.js](../backend/api/activation.js) |
| GET, PATCH, POST, PUT, DELETE | `/api/me/*` | свой профиль, пароль, сессии, история входов, аватар | [me.js](../backend/api/me.js) |
| GET, POST, PATCH, PUT, DELETE | `/api/admin/*` | админ-панель (по разрешениям роли) | [admin.js](../backend/api/admin.js) |
| POST | `/api/demo/search` | строгий подбор | [demoBooking.js](../backend/api/demoBooking.js) |
| GET | `/api/demo/slots` | расписание демо-врача | [demoBooking.js](../backend/api/demoBooking.js) |
| POST | `/api/demo/hold`, `/api/demo/release` | удержание слота | [demoBooking.js](../backend/api/demoBooking.js) |
| POST | `/api/demo/bookings`, `/api/demo/bookings/cancel`, `/api/demo/bookings/lookup` | запись, отмена, статус | [demoBooking.js](../backend/api/demoBooking.js) |
| GET | `/api/demo/bookings/mine` | записи вошедшего пользователя | [demoBooking.js](../backend/api/demoBooking.js) |

Неизвестный путь под `/api/` — `404 {"error":"Not found"}`. `/api/me/*` и
`/api/admin/*` — единственные маршруты с параметрами в пути (`:id` —
`[A-Za-z0-9_-]{1,64}`), их сопоставляет [router.js](../backend/http/router.js).

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

Нужна действующая сессия (cookie `mk_session`) без временного пароля; если
в настройках админ-панели выключено «Ассистент только после входа» (по
умолчанию — из `CHAT_REQUIRES_ACCOUNT`), — не нужна. Выключенный в
настройках ассистент отвечает `503 assistant_disabled`, гость — `401
login_required`, временный пароль — `403 password_change_required`. Из
аккаунта в конвейер ничего не передаётся.

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
| 401 | `{"error":"Ассистент доступен после входа в личный кабинет.","code":"login_required"}` | нет входа или сессия истекла |
| 400 | `{"error":"Ожидается непустой массив messages."}` | пустой или не массив |
| 400 | `{"error":"Слишком длинная история диалога."}` | больше 40 сообщений |
| 400 | `{"error":"Последнее сообщение должно быть от пользователя."}` | |
| 403 | `{"error":"Запрос отклонён."}` | чужой `Origin` или `Host` |
| 405 | `{"error":"Метод не поддерживается."}`, `Allow: POST, OPTIONS` | не POST |
| 413 | `{"error":"Тело запроса слишком большое."}` | больше 32 КБ |
| 429 | `{"error":"Слишком много запросов. Попробуйте через минуту.","retryAfter":N}` | лимит запросов или процессорного времени |
| 502 | `{"error":"Не удалось обработать запрос. Попробуйте ещё раз."}` | сбой конвейера |
| 503 | `{"error":"Ассистент сейчас перегружен. Попробуйте через минуту.","code":"busy"}` | предохранитель или очередь |
| 503 | `{"error":"Личный кабинет сейчас недоступен, поэтому ассистент тоже.","code":"accounts_unavailable"}` | кабинет выключен или нет `node:sqlite` |

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
{
  "demo": true,
  "booking": true,
  "publicClinics": false,
  "settings": {
    "appName": "МедКарта",
    "supportEmail": null,
    "supportPhone": null,
    "maintenance": null,
    "assistant": true
  }
}
```

| Поле | Смысл |
|---|---|
| `demo` | `DEMO_DATA=on` |
| `booking` | демо-запись включена и доступен `node:sqlite` |
| `publicClinics` | показывать государственные учреждения (в демо по умолчанию `false`) |
| `settings` | настройки из админ-панели с пометкой «публичная»: название, контакты поддержки, текст о технических работах (`null` — выключено), ассистент включён; `null`, если база аккаунтов недоступна |

---

## Кабинет: /api/account и /api/auth/*

Сессия — cookie `mk_session`: `HttpOnly; SameSite=Lax; Path=/api`, `Secure` в
продакшене. Подробности — [accounts.md](accounts.md).

| Метод и путь | Тело | Ответ | Лимит на адрес |
|---|---|---|---|
| `GET /api/account` | — | `{user, favorites, features}`; гость — `user: null` | 300 за 5 мин |
| `PATCH /api/account` | `{displayName}`, `{firstName, lastName}` или `{dmsPlanId}` (только из справочника) | `{user, favorites, features}` | 300 за 5 мин |
| `DELETE /api/account` | `{"confirm": true}`; только роль `user`, у сотрудников — `403 staff_account` | `{user: null, …}`, cookie стирается | 300 за 5 мин |
| `POST /api/account/favorites` | `{action: "add" \| "remove" \| "merge", ids: [...]}` | `{favorites}` | 300 за 5 мин |
| `POST /api/auth/login` | `{email, password}` | `{user, favorites, features}` + cookie | 20 за 15 мин |
| `POST /api/auth/demo` | `{account: "anna" \| "family" \| "kids" \| "basic"}` | демо-сессия на 12 часов в копии профиля этого браузера + cookie `mk_demo` (30 дней); при выключенном демо — `403` | 200 за 15 мин |
| `POST /api/auth/logout` | `{}` | `{user: null, …}`, cookie стирается | 300 за 5 мин |

`features` — `{available, registration, demo, assistant, chatRequiresAccount,
demoAccounts, emailLinks}`; `registration` всегда `false` (`POST /api/auth/register` —
`404`), в `demoAccounts` — только ключ, имя и описание программы, без email;
`emailLinks` — настроена ли почта (свойство сервера, не адреса).

Вход заблокированного аккаунта (пароль верный) — `403 account_blocked` с
`blockedUntil` и причиной, архивного — `403 account_inactive`; при неверном
пароле, несуществующем email и **неактивированном** аккаунте — одинаково
`401 bad_credentials`, статус аккаунта не раскрывается.
У пользователя, которому до схемы 4 выдали временный пароль или для которого
администратор включил «Потребовать смену при входе», `user.mustChangePassword: true`:
до смены пароля остальные маршруты `/api/me/*` и `/api/admin/*` отвечают
`403 password_change_required`.

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
    "chatRequiresAccount": true,
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

### Приглашения и ссылки для входа

Логика — [invitations.js](../backend/accounts/invitations.js), устройство и
гарантии — [accounts.md](accounts.md#приглашения-и-ссылки-для-входа). Токен
ссылки (`/activate#token=…`, 43 символа base64url) передаётся только в теле
`POST`. Все `POST` — с той же защитой от CSRF, что и вход (`application/json`,
свой `Origin`).

| Метод и путь | Тело | Ответ | Лимит на адрес |
|---|---|---|---|
| `POST /api/auth/access-link` | `{email}` | `202 {ok, message}` — **одинаково** для любого адреса; письмо (приглашение или смена пароля) уходит после ответа и только владельцу действующего аккаунта. Почта не настроена — `409 mail_disabled` для всех | 5 за 15 мин; 3 в час на email |
| `POST /api/auth/activation/peek` | `{token}` | `{link: {purpose: "invite"\|"reset", firstName, email (маской), expiresAt, invitedBy}}` — ничего не меняет | 30 за 15 мин |
| `POST /api/auth/activation/start` | `{token}` | `{context: {purpose, email, firstName, lastName, expiresAt}}` + cookie `mk_activation` (`HttpOnly; SameSite=Strict; Path=/api/auth/activation`, 30 мин; по HTTPS — `__Secure-mk_activation`). Токен больше не действует; тот же браузер с действующей cookie получает контекст снова | 30 за 15 мин |
| `GET /api/auth/activation` | — | `{context}` по cookie или `404 no_context` | 30 за 15 мин |
| `POST /api/auth/activation/complete` | `{password}` | `{user, favorites, purpose}` + cookie сессии; cookie контекста стирается, прежняя сессия этого браузера завершается | 30 за 15 мин |

Ошибки: `404 invalid_link` — токена нет или он искажён; `410 link_expired`,
`410 link_revoked`, `410 link_used`; `410 activation_expired` — 30 минут на
пароль истекли, пароль уже задан в другой вкладке или cookie контекста
подменена; `403 account_blocked` / `account_inactive` — аккаунт заблокирован
или в архиве (ошибку видит только тот, у кого есть сама ссылка);
`400 weak_password` — пароль не прошёл правила
([passwordPolicy.js](../shared/passwordPolicy.js)); `429 rate_limited`.

---

## Профиль: /api/me/*

Только с сессией (иначе `401 unauthenticated`). Лимит — 300 запросов за 5
минут с адреса, смена пароля — 10 за 15 минут.

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /api/me` | — | `{user, favorites, session: {id}}`; `user` с ролью, статусом, `permissions`, `avatarUrl` |
| `PATCH /api/me` | `{firstName, lastName}` — другие поля: `400 unexpected_field` | `{user, favorites}` |
| `POST /api/me/password` | `{currentPassword, newPassword}` | `{user}`; все прежние сессии завершены, выдаётся новая cookie. Доступен и с временным паролем |
| `GET /api/me/sessions` | — | `{items: [{id, createdAt, lastSeenAt, expiresAt, client, network, current}]}` |
| `DELETE /api/me/sessions/:id` | `{}` | `{revoked, current}`; своя текущая — выход |
| `POST /api/me/sessions/revoke-others` | `{}` | `{revoked}` |
| `GET /api/me/logins?limit=20` | — (не больше 50) | `{items: [{at, type, label, client, network, reason}]}` |
| `GET /api/me/avatar` | — | изображение; `404`, если фото нет |
| `PUT /api/me/avatar` | `{image: "data:image/webp;base64,…"}` до 256 КБ | `{user, favorites}` |
| `DELETE /api/me/avatar` | `{}` | `{user, favorites}` |

Пример сессии:

```json
{
  "items": [
    {
      "id": "184999a2c16c5a3591ca92d6",
      "createdAt": "2026-10-18T15:40:43.422Z",
      "lastSeenAt": "2026-10-18T15:40:43.422Z",
      "expiresAt": "2026-11-01T15:40:43.422Z",
      "client": "Chrome 129 · macOS",
      "network": "127.0.0.0/24",
      "current": true
    }
  ]
}
```

---

## Админ-панель: /api/admin/*

Каждый маршрут проверяет разрешение роли на сервере (список и умолчания —
[accounts.md](accounts.md#роли-и-разрешения)). Без сессии — `401`, без
`admin.access` или нужного разрешения — `403 forbidden`. Лимит — 600 запросов
за 5 минут с адреса. Тела — только перечисленные поля: лишнее поле —
`400 unexpected_field` (например, `role` в `PATCH`).

| Метод и путь | Разрешение | Тело или параметры | Ответ |
|---|---|---|---|
| `GET /api/admin/me` | `admin.access` | — | `{user, permissions, roles, mail: {enabled}}` |
| `GET /api/admin/dashboard` | `dashboard.view` | `?period=24h\|7d\|30d\|90d` | счётчики, ряды для графиков, последние пользователи и действия, состояние компонентов |
| `GET /api/admin/users` | `users.view` | `?q&role&status=active\|pending\|blocked\|archived&kind=real\|demo\|all&sort&dir&page&pageSize=10\|25\|50\|100` | `{items, total, page, pageSize, sort, dir}`; у каждого `pending` — ждёт ли активации |
| `POST /api/admin/users` | `users.create` (роль выше `user` — и `roles.assign`) | `{email, firstName, lastName, role, delivery: "auto"\|"manual"}` | `201 {user, invitation, link}` — аккаунт без пароля («ожидает активации»); `link` — только при ручной передаче или если письмо не ушло, **один раз** |
| `GET /api/admin/users/export` | `users.export` | те же фильтры или `?ids=a,b` | CSV (UTF-8 с BOM, `;`), до 10 000 строк |
| `POST /api/admin/users/bulk` | `users.block` | `{action: "block"\|"unblock", ids, reason, until}` до 100 id | `{succeeded, failed, results: [{id, ok, error}]}` |
| `GET /api/admin/users/:id` | `users.view` | — | `{user, can, permissions}`: что текущий сотрудник может сделать с этим аккаунтом |
| `PATCH /api/admin/users/:id` | `users.edit`; смена email — ещё и `users.password` | `{firstName, lastName, email, version}` | `{user, can, …}`; устаревшая `version` — `409 conflict`; смена email отзывает ссылки |
| `DELETE /api/admin/users/:id` | `users.delete` | `{confirmEmail}` | `{deleted: true}` |
| `POST /api/admin/users/:id/role` | `roles.assign` | `{role, version}` | `{user, can, …}`; ссылки пользователя отзываются |
| `POST /api/admin/users/:id/block` | `users.block` | `{reason, until}` (`until` — ISO-дата или `null` — бессрочно) | `{user, can, …}`; все сессии завершены |
| `POST /api/admin/users/:id/unblock` | `users.block` | `{}` | `{user, can, …}` |
| `POST /api/admin/users/:id/archive`, `/restore` | `users.archive` | `{}` | `{user, can, …}` |
| `GET /api/admin/users/:id/invitations` | `users.view` | — | `{items: [{id, purpose, state, stateLabel, delivery, deliveryStatus, createdAt, expiresAt, openedAt, usedAt, revokedAt, revokedReason, createdBy}], delivery}` — без токенов и хэшей |
| `POST /api/admin/users/:id/invitations` | `users.password` | `{delivery: "auto"\|"manual"}` | `{user, can, …, invitation, link}` — приглашение (не активирован) или ссылка для смены пароля; прежняя того же вида отозвана; заблокированному или архивному — `409` |
| `DELETE /api/admin/users/:id/invitations/:invitation` | `users.password` | `{}` | `{invitation}`; уже использованная или отозванная — `409 bad_state` |
| `GET /api/admin/notifications` | `users.view` | `?since=ISO` | `{now, items: [{id, at, userId, user}]}` — активации после `since` (не раньше суток) |
| `POST /api/admin/users/:id/password-require` | `users.password` | `{}` | `{user, can, …}` |
| `POST /api/admin/users/:id/sessions/revoke` | `users.sessions` | `{}` | `{revoked}`; ссылки для смены пароля отозваны |
| `GET /api/admin/users/:id/sessions` | `users.sessions` | — | `{items}` |
| `GET /api/admin/users/:id/logins` | `users.view` | `?page&type=failed` | `{items, total, page, pageSize}` |
| `GET /api/admin/users/:id/blocks` | `users.view` | — | `{items}` |
| `GET /api/admin/users/:id/audit` | `audit.view` | `?page` | `{items, total, …}` |
| `GET /api/admin/users/:id/avatar` | `users.view` | — | изображение |
| `GET /api/admin/sessions` | `users.sessions` | `?userId&kind&page&pageSize` | `{items, total, …}` |
| `DELETE /api/admin/sessions/:id` | `users.sessions` | `{}` | `{revoked: 1}` |
| `GET /api/admin/roles` | `roles.assign` или `roles.manage` | — | роли, разрешения, матрица, число пользователей по ролям, история изменений |
| `PUT /api/admin/roles/:role` | `roles.manage` | `{permissions: [...]}` — только `admin`, `moderator` | то же, что `GET`, и `warnings`; нарушенные зависимости — `400` |
| `POST /api/admin/roles/:role/reset` | `roles.manage` | `{}` | набор по умолчанию |
| `GET /api/admin/audit` | `audit.view` | `?q&action&result=ok\|denied&from&to&page&pageSize` | `{items, total, page, pageSize, actions}` |
| `GET /api/admin/system` | `system.view` | — | компоненты, процесс, запросы и ошибки, каталог, файлы данных |
| `GET /api/admin/settings` | `settings.view` | — | `{items: [{key, group, label, type, value, default, …}], canEdit}` |
| `PATCH /api/admin/settings` | `settings.edit` | `{values: {"sessions.idleDays": 7, …}}` | `{items, canEdit, changed}`; неизвестный ключ или значение вне границ — `400` |

Отказы по иерархии: `403 self_action` (над собой), `403 forbidden` (роль не
ниже своей или нет разрешения), `403 last_superadmin` (последний активный
суперадминистратор) — каждый записывается в журнал с результатом `denied`.
Демо-копии не управляются: `409 demo_account`.

Пример — блокировка самого себя:

```json
{ "error": "Это действие нельзя выполнить над своим аккаунтом.", "code": "self_action" }
```

Пример записи журнала:

```json
{
  "id": 3,
  "at": "2026-10-18T15:40:43.833Z",
  "action": "user.block",
  "actionLabel": "Блокировка",
  "actor": "Максим · m***@bk.ru",
  "actorId": "5b99eb3ba0be65c123f57c936ecb78b6",
  "target": "Ольга Петрова · o***@medkarta.test",
  "targetId": "5d060dd2c4d01cd2a8af62274b7645bc",
  "result": "ok",
  "details": { "reason": "Проверка", "until": null, "from": "active" }
}
```

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
    "coverage": null,
    "owned": false
  }
}
```

`owned: true` — запись сделана после входа и привязана к аккаунту; иначе
номер и `cancelToken` хранит браузер.

### POST /api/demo/bookings/cancel

`{number, cancelToken}` → `{booking, slotReleased, alreadyCancelled}`;
неверный номер или токен — `404 booking_not_found`.

### POST /api/demo/bookings/lookup

`{items: [{number, cancelToken}, …]}` (до 20) → `{bookings: [...]}`; для
неизвестной пары — `{number, found: false}`.

### GET /api/demo/bookings/mine

Записи вошедшего пользователя, новые сверху, до 50: `{bookings: [...]}` в том
же виде, что ответ записи, с `cancelToken`. Без входа — `401`.

**Коды ошибок записи** (`{error, code}`): `bad_request` 400;
`slot_not_found`, `booking_not_found` 404; `slot_taken`, `slot_held`,
`slot_unavailable`, `slot_past`, `slot_conflict`, `idempotency_conflict` 409.
