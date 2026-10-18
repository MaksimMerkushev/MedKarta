# 04. Фронтенд

SPA на React 19, собирается Vite 8 из каталога `frontend/`. Карта — Leaflet 1.9
через React-Leaflet 5, стили — Tailwind CSS 4. Всё, что зависит от
местоположения пользователя (расстояния, «три лучших», покрытие ДМС),
считается в браузере.

## Сборка

Конфигурация — [vite.config.js](../vite.config.js).

| Параметр | Значение | Зачем |
|---|---|---|
| `root` | `frontend/` | корень SPA; `shared/` и `data/` лежат выше |
| `envDir` | корень проекта | `.env` читается dev-сервером, но в бандл попадают только переменные `VITE_*`, а их в проекте нет |
| Алиасы | `@data/doctors` → `data/doctors.full.js`, если файл есть, иначе `data/doctors.js`; `@data/` → `data/`; `@shared/` → `shared/` | полная база врачей подменяет публичный срез при сборке |
| `build.outDir` | `dist/` | статика для сервера или nginx |
| `sourcemap` | `false` | исходники не публикуются рядом с бандлом |
| `manualChunks` | `facilities-data` (справочники), `map` (Leaflet) | правка интерфейса не инвалидирует кэш данных |
| `server.host` | `localhost` | dev-сервер не открыт в сеть |
| `server.fs.allow` / `deny` | только `frontend/`, `shared/`, `data/`, `node_modules/`; запрет `.env*`, ключей, `.git`, `var/`, `data/collected`, `data/review` | dev-сервер не отдаёт секреты |

Ленивые чанки: `AIAssistant`, `AccountPanel`, `BookingDialog` подключаются
через `React.lazy` в [App.jsx](../frontend/src/App.jsx); админ-панель
(`/admin…`, каждый раздел — свой чанк) и профиль (`/profile`) — в
[Root.jsx](../frontend/src/Root.jsx), карта их код не загружает. Демо-набор
загружается отдельным чанком из [demoMode.js](../frontend/src/demoMode.js).

> Важно: если `data/doctors.full.js` существует, он попадает в бандл и
> скачивается браузером. Это публичные сведения со страниц учреждений, но
> «закрытой» базу делает только отдельный API, которого нет
> ([deployment.md](deployment.md)).

### Dev-режим

`npm run dev` запускает Vite и подключает **те же обработчики API**, что и
боевой сервер, как middleware ([vite.config.js](../vite.config.js),
`devApiPlugin`):

- пути: `/api/chat`, `/api/route`, `/api/travel-times`, `/api/events`,
  `/api/config`, `/api/account`, `/api/auth`, `/api/me`, `/api/admin`,
  `/api/demo`;
- переменные из `.env` переносятся в `process.env` только для сервера
  (список ключей задан в плагине);
- **демо-режим включён по умолчанию**, если `DEMO_DATA` не задан;
- запросы с чужим `Host` отклоняются `403` (защита от DNS rebinding:
  обработчики подключены раньше проверки хоста самого Vite).

## Компоненты

| Модуль | Назначение |
|---|---|
| [App.jsx](../frontend/src/App.jsx) | главный компонент: карта, список, фильтры, маршрут, состояние в URL, геолокация, «время в пути», сортировки. Маршрут показывается строкой «время · расстояние» рядом с плашкой пользователя (`RoutePill`); точки, вид транспорта, Яндекс Карты и 2ГИС — в окне по нажатию на строку |
| [AIAssistant.jsx](../frontend/src/AIAssistant.jsx) | окно ассистента; кнопка нового разговора (`data-testid="ai-restart"`) |
| [TopPicks.jsx](../frontend/src/TopPicks.jsx), [bestPicks.js](../frontend/src/bestPicks.js) | «три лучших варианта» под ответом ассистента |
| [DemoOffers.jsx](../frontend/src/DemoOffers.jsx) | результат строгого подбора: варианты, вопросы, кнопки послаблений |
| [BookingDialog.jsx](../frontend/src/BookingDialog.jsx) | демо-запись: выбор времени → удержание → подтверждение → номер |
| [DemoDoctorSchedule.jsx](../frontend/src/DemoDoctorSchedule.jsx) | расписание демо-врача в окне подробностей |
| [MyBookingsPanel.jsx](../frontend/src/MyBookingsPanel.jsx) | «Мои демо-записи» |
| [PlaceDetailsModal.jsx](../frontend/src/PlaceDetailsModal.jsx) | окно подробностей врача или учреждения |
| [PlaceDoctorList.jsx](../frontend/src/PlaceDoctorList.jsx), [placeList.js](../frontend/src/placeList.js) | окно маркера с сотнями врачей (поиск, группы) |
| [SearchFilters.jsx](../frontend/src/SearchFilters.jsx) | панель фильтров |
| [DmsPanel.jsx](../frontend/src/DmsPanel.jsx) | «Мой ДМС»: страховая и программа |
| [AccountPanel.jsx](../frontend/src/AccountPanel.jsx), [hooks/useAccount.js](../frontend/src/hooks/useAccount.js) | личный кабинет на карте; плашка пользователя «Аватар · Имя · Профиль · Выйти» — в [App.jsx](../frontend/src/App.jsx) |
| [Root.jsx](../frontend/src/Root.jsx) | выбор приложения по пути: карта, `/profile` или `/admin…` |
| [profile/ProfilePage.jsx](../frontend/src/profile/ProfilePage.jsx) | профиль: фото, имя, пароль, свои сессии, история входов |
| [admin/AdminApp.jsx](../frontend/src/admin/AdminApp.jsx), [admin/pages/](../frontend/src/admin/pages/) | админ-панель: оболочка с меню по разрешениям, вход, разделы |
| [admin/charts.jsx](../frontend/src/admin/charts.jsx) | графики дашборда на SVG: подсказка, клавиатура, таблица вместо графика |
| [admin/api.js](../frontend/src/admin/api.js), [admin/model.js](../frontend/src/admin/model.js), [admin/common.jsx](../frontend/src/admin/common.jsx) | запросы к `/api/admin`, права и подписи журнала, общие окна |
| [ui/kit.jsx](../frontend/src/ui/kit.jsx), [ui/format.js](../frontend/src/ui/format.js), [ui/hooks.js](../frontend/src/ui/hooks.js) | общие компоненты профиля и панели, даты по Москве, уведомления, тема, загрузка данных |
| [ui/auth.jsx](../frontend/src/ui/auth.jsx) | форма входа, смена пароля, обязательная смена временного пароля |
| [ui/navigation.js](../frontend/src/ui/navigation.js), [ui/router.jsx](../frontend/src/ui/router.jsx) | переходы без перезагрузки (`history.pushState`) и ссылка `Link` |
| [ChatLoginNotice.jsx](../frontend/src/ChatLoginNotice.jsx) | предупреждение гостю вместо чата: ассистент только после входа |
| [FeedbackWidgets.jsx](../frontend/src/FeedbackWidgets.jsx) | «Нашли, куда обратиться?», «Данные неверны» |
| [ErrorBoundary.jsx](../frontend/src/ErrorBoundary.jsx) | понятный экран вместо белого при исключении |
| [Toast.jsx](../frontend/src/Toast.jsx) | неблокирующие уведомления вместо `window.alert` |
| [externalMaps.js](../frontend/src/externalMaps.js) | ссылки на маршрут в Яндекс Картах и 2ГИС |
| [booking.js](../frontend/src/booking.js) | переход к записи в реальной клинике: сайт, Госуслуги, подсказки по ОМС |

## Состояние и хранение в браузере

### Адресная строка

Фильтры отражаются в адресе страницы, чтобы ссылкой можно было поделиться
(`readUrlState` / `buildUrlQuery` в [App.jsx](../frontend/src/App.jsx)).

| Параметр | Значение |
|---|---|
| `q` | текст поиска (до 100 символов) |
| `clinic`, `district`, `type`, `profile` | клиника, район, тип учреждения, профиль врача |
| `owner` | `Государственная` или `Частная` |
| `show` | `all`, `doctor`, `facility` |
| `sort` | режим сортировки из `SORT_MODES` |
| `services` | услуги через `\|`, до 6 |
| `rating`, `exp`, `dist` | минимальный рейтинг, стаж, максимальное расстояние |
| `travel` | потолок времени в пути: 10, 15, 20, 30, 45 или 60 минут |
| `flags` | `open`, `fav`, `weekend`, `evening`, `online`, `wheelchair`, `children`, `dms` через запятую |
| `doc` | идентификатор выбранной карточки |
| `demo` | `1` или `0` — ручное переключение демо-режима ([demoMode.js](../frontend/src/demoMode.js)) |

Текст поиска в адресе — сведения о здоровье («невролог после инсульта»),
поэтому рекомендуемый формат журнала nginx пишет путь без строки запроса
([deployment.md](deployment.md)).

### localStorage и sessionStorage

| Ключ | Хранилище | Что | Модуль |
|---|---|---|---|
| `med-navigator-favorites` | localStorage | id избранных врачей и учреждений | [App.jsx](../frontend/src/App.jsx) |
| `med-navigator-dark-mode` | localStorage | тема | [App.jsx](../frontend/src/App.jsx), [theme-init.js](../frontend/public/theme-init.js) |
| `medkarta.dms.plan` | localStorage | **только id** программы ДМС | [App.jsx](../frontend/src/App.jsx) |
| `medkarta.demo` | localStorage | ручной выбор демо-режима | [demoMode.js](../frontend/src/demoMode.js) |
| `medkarta.demo-bookings` | localStorage | номера и токены отмены демо-записей гостя (записи кабинета хранит сервер) | [services/demoBooking.js](../frontend/src/services/demoBooking.js) |
| `medkarta.account-owned`, `medkarta.guest-stash` | localStorage | разделение избранного гостя и аккаунта | [App.jsx](../frontend/src/App.jsx) |
| `medkarta.ai.session` | sessionStorage | случайный id диалога ассистента; сбрасывается при входе и выходе | [services/ai.js](../frontend/src/services/ai.js) |
| `medkarta.analytics.sid` | sessionStorage | случайный id сессии аналитики | [services/analytics.js](../frontend/src/services/analytics.js) |

Всё прочитанное из `localStorage` проходит валидаторы
([hooks/useLocalStorageState.js](../frontend/src/hooks/useLocalStorageState.js)):
повреждённое значение заменяется значением по умолчанию.

## Обращения к серверу

| Клиентский модуль | Эндпоинты | Таймаут |
|---|---|---|
| [services/ai.js](../frontend/src/services/ai.js) | `POST /api/chat` | 30 с, действует до конца чтения тела |
| [services/travelTimes.js](../frontend/src/services/travelTimes.js) | `POST /api/travel-times` | 12 с |
| [App.jsx](../frontend/src/App.jsx) | `POST /api/route` | — |
| [services/demoBooking.js](../frontend/src/services/demoBooking.js) | `/api/demo/*` | 15 с |
| [services/account.js](../frontend/src/services/account.js) | `/api/account`, `/api/auth/*`, `/api/me/*` | — |
| [admin/api.js](../frontend/src/admin/api.js) | `/api/admin/*`; ответ `401` возвращает панель к форме входа | — |
| [services/analytics.js](../frontend/src/services/analytics.js) | `POST /api/events` | — |
| [demoMode.js](../frontend/src/demoMode.js) | `GET /api/config` | — |

Ответ ассистента повторно нормализуется на клиенте той же функцией
`sanitizeAiAction` из [shared/contract.js](../shared/contract.js): состояние
интерфейса не зависит от того, что пришло по сети.

### Что уходит в `/api/chat`

Клиент отправляет **только реплики пользователя** — до 20 последних, каждая
обрезана до 1000 символов (`packMessages` в
[services/ai.js](../frontend/src/services/ai.js), лимиты из
[shared/contract.js](../shared/contract.js)), и случайный `sessionId`.
Ответы ассистента не отправляются: сервер всё равно не учитывает их, потому
что не может проверить их подлинность ([07-privacy.md](07-privacy.md)).
Координаты и программа ДМС в `/api/chat` не уходят.

## Геолокация, расстояния, время в пути

- Положение — `navigator.geolocation.watchPosition`; без него точка по
  умолчанию — `[55.7963, 49.1088]` (центр Казани, `defaultLocation` в
  [App.jsx](../frontend/src/App.jsx)).
- Расстояние до карточек — по большому кругу (формула гаверсинуса,
  радиус 6371 км), в браузере.
- Фильтр «не дольше N минут»: браузер отправляет точку, режим, потолок и
  координаты уникальных адресов в `/api/travel-times`; пока ответа нет (или
  сервер недоступен), используется оценка с пометкой «≈»:

  ```text
  t ≈ d · 1,3 / v,   v = 28 км/ч (машина), 14 км/ч (велосипед), 4,5 км/ч (пешком)
  ```

  где `d` — расстояние по прямой, 1,3 — поправка на извилистость улиц
  (`DETOUR_FACTOR`, `FALLBACK_SPEED_KMH` в [App.jsx](../frontend/src/App.jsx)).

## Сортировка «по рекомендации»

Компаратор `compareByRecommendation` в [App.jsx](../frontend/src/App.jsx)
сравнивает последовательно:

1. открыто сейчас — выше;
2. в избранном — выше;
3. рейтинг — выше;
4. расстояние — ближе;
5. стаж — больше.

Другие режимы: `distance` (при включённом фильтре времени в пути — по
времени), `schedule` («сначала открытые», затем по началу приёма сегодня),
`name`, `clinic`, `price`; `rating` и `experience` доступны, если их выбрал
ассистент или ссылка: рейтингов и стажа в открытых источниках нет
([README.md](../README.md)).

## «Три лучших варианта»

[bestPicks.js](../frontend/src/bestPicks.js) берёт уже отфильтрованный и
отсортированный список и выбирает до трёх вариантов:

- сначала — лучшие из **разных мест** среди первых 12 (`DIVERSITY_WINDOW`):
  три врача одной поликлиники — одна поездка;
- один и тот же врач в двух филиалах — один вариант;
- точки, уже добавленные в маршрут, в подборку не идут;
- для каждого варианта формируется причина выбора (время в пути, «открыто
  сейчас», «по вашему ДМС», цена, стаж).

Подборка показывается, если запрос ассистента её подразумевает
(`wantsTopPicks`). Тесты — [best-picks.test.js](../tests/best-picks.test.js).

## Демо-режим в интерфейсе

- По умолчанию интерфейс следует серверу: `GET /api/config` возвращает
  `demo`, `booking`, `publicClinics` ([api/config.js](../backend/api/config.js)).
- `?demo=1` / `?demo=0` переключает режим вручную и запоминает выбор.
- Демо-карточки помечены «Демо»; карточки реальных частных клиник —
  «Реальная клиника» + «Демо»; при `publicClinics: false` государственные
  учреждения скрыты из выдачи.

## Продуктовая аналитика

[services/analytics.js](../frontend/src/services/analytics.js):

- события только из закрытого словаря [shared/analytics.js](../shared/analytics.js);
- пачки до 20 событий, отправка через 4 с или при уходе со страницы
  (`sendBeacon` на `pagehide` и `visibilitychange`);
- при Do Not Track или Global Privacy Control события не отправляются вовсе.

## Безопасность клиента

- Секретов в клиентском коде нет: правило ESLint `no-restricted-syntax`
  запрещает в `frontend/src/` обращения к переменным окружения
  (`import.meta.env.*`, `process.env.*`) и константам в верхнем регистре с
  `API_KEY`, `SECRET_KEY`, `ACCESS_TOKEN`, `PASSWORD` в имени
  ([eslint.config.js](../eslint.config.js)). Поля ответов API в camelCase
  (`mustChangePassword`, `temporaryPassword`) правило не трогает.
- Права в интерфейсе только прячут кнопки и разделы; каждое действие
  проверяет сервер. Временный пароль показывается один раз и не сохраняется
  ни в состоянии после закрытия окна, ни в хранилище браузера.
- CSP разрешает только `script-src 'self'`, поэтому скрипт выбора темы до
  первой отрисовки вынесен в отдельный файл
  [theme-init.js](../frontend/public/theme-init.js).
- Текст модели рендерится как текст; `dangerouslySetInnerHTML` в проекте не
  используется ([SECURITY.md](../SECURITY.md), раздел 3).
