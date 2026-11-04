/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Подробная статистика для суперадминистратора: запросы, ассистент, поиск и
 * карта, пользователи, запись и письма за выбранный период. Только сводные
 * числа из счётчиков и журналов, и где данных нет или они приблизительные,
 * это сказано прямо, а не нарисовано. Обращения к ассистенту по людям не
 * разбиваются намеренно: ассистент не связан с аккаунтом.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Download, Info, RefreshCw } from 'lucide-react';

import { SPECIALTY_CANON } from '@shared/specialties.js';

import { api, useApi } from '../api';
import { BarList, Heatmap, TimeChart } from '../charts';
import { Tile } from './Dashboard';
import { Button, Card, EmptyState, ErrorState, inputClass, SelectInput, Skeleton, Tabs } from '../../ui/kit';
import { formatDateTime, formatNumber } from '../../ui/format';

const PRESETS = [
  ['today', 'Сегодня'],
  ['yesterday', 'Вчера'],
  ['24h', '24 часа'],
  ['7d', '7 дней'],
  ['30d', '30 дней'],
  ['90d', '90 дней'],
  ['month', 'Этот месяц'],
  ['prev_month', 'Прошлый месяц'],
  ['year', 'Этот год'],
];

const BUCKETS = [
  { value: '', label: 'Шаг: авто' },
  { value: 'hour', label: 'По часам' },
  { value: 'day', label: 'По дням' },
  { value: 'week', label: 'По неделям' },
  { value: 'month', label: 'По месяцам' },
];

const TABS = [
  { value: 'requests', label: 'Запросы' },
  { value: 'assistant', label: 'Ассистент' },
  { value: 'product', label: 'Поиск и карта' },
  { value: 'users', label: 'Пользователи' },
  { value: 'booking', label: 'Запись' },
  { value: 'mail', label: 'Письма' },
];

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const MSK = { timeZone: 'Europe/Moscow' };

const DICTIONARY = {
  decision: { allow_external: 'Можно передать модели', local_only: 'Только локально', emergency: 'Срочный случай', reject: 'Отклонён' },
  reason: {
    hard_identifier_present: 'В запросе прямой идентификатор',
    medical_text_policy: 'Медицинский текст по правилам приватности',
    symptom_classifier_uncertain: 'Классификатор жалоб не уверен',
    residual_unredacted_risk: 'Остались необезличенные данные',
    redaction_ratio_too_high: 'Слишком много скрыто',
    token_budget_exceeded: 'Превышен лимит токенов',
    emergency_red_flag: 'Признак срочного случая',
    token_vault_unavailable: 'Хранилище меток недоступно',
    outbound_assertion_failed: 'Не прошла проверка перед отправкой',
    obfuscation_unresolved: 'Попытка обойти обезличивание',
    nothing_to_plan: 'Модели нечего планировать',
    doctor_not_in_catalog: 'Врача нет в справочнике',
    planner_failed: 'Модель не ответила',
  },
  triage: { specialty: 'Определён профиль врача', clarify: 'Уточняющий вопрос', emergency: 'Срочный случай', unknown: 'Не определено', invalid: 'Ответ модели не по формату' },
  source: { filters: 'Фильтры', assistant: 'Ассистент', url: 'Ссылка' },
  filter: {
    query: 'Текст поиска', profile: 'Профиль', facilityType: 'Тип учреждения', ownership: 'Форма собственности', clinic: 'Клиника', district: 'Район', services: 'Услуги',
    children: 'Детский приём', open: 'Открыто сейчас', weekend: 'Выходные', evening: 'Вечер', online: 'Онлайн', wheelchair: 'Доступная среда', favorites: 'Избранное',
    minRating: 'Рейтинг', minExperience: 'Стаж', maxDistance: 'Расстояние', maxTravel: 'Время в пути', dms: 'ДМС',
  },
  channel: { phone: 'Телефон', website: 'Сайт', gosuslugi: 'Госуслуги', source: 'Источник данных', pult: 'Пульт страховой' },
  surface: { list: 'Список', map: 'Карта' },
  kind: { doctor: 'Врач', facility: 'Учреждение' },
  ownership: { state: 'Государственная', private: 'Частная', unknown: 'Неизвестно' },
  mode: { driving: 'На машине', foot: 'Пешком', bike: 'На велосипеде' },
  mapMode: { auto: 'на машине', transit: 'транспортом', foot: 'пешком', bike: 'на велосипеде' },
  feedback: { no_doctor: 'Нет нужного врача', too_far: 'Далеко', bad_time: 'Неудобное время', too_expensive: 'Дорого', not_covered: 'Не входит в ОМС или ДМС', wrong_data: 'Неверные данные', other: 'Другое' },
  report: { closed: 'Закрыто', wrong_hours: 'Неверные часы', wrong_phone: 'Неверный телефон', wrong_address: 'Неверный адрес', doctor_left: 'Врач не работает', other: 'Другое' },
  mail: {
    register_confirm: 'Подтверждение регистрации', register_exists: 'Уже зарегистрированы', register_pending: 'Аккаунт уже создан', invite: 'Приглашение', reset: 'Восстановление пароля',
    password_changed: 'Пароль изменён', email_change_confirm: 'Подтверждение нового email', email_verify: 'Подтверждение email', email_change_requested: 'Запрошена смена email', email_changed: 'Email изменён',
    email_change_taken: 'Адрес уже используется', mfa_enabled: 'Включена защита', mfa_disabled: 'Удалён фактор входа', mfa_reset: 'Сброс факторов', recovery_codes: 'Новые резервные коды',
    recovery_code_used: 'Вход по резервному коду', new_login: 'Вход с нового устройства', login_locked: 'Подозрительные попытки входа', reset_link_issued: 'Выдана ссылка для пароля',
    privacy_request_received: 'Обращение по ПДн принято', privacy_request_update: 'Ответ на обращение по ПДн',
  },
  role: { superadmin: 'Суперадминистратор', admin: 'Администратор', moderator: 'Модератор', user: 'Пользователь' },
};

const label = (group, key) => DICTIONARY[group]?.[key] || key;
const specialtyName = (key) => SPECIALTY_CANON[key] || (key === 'other' ? 'Другое' : key);
const bars = (items, group) => items.map((item) => ({ label: group ? label(group, item.key) : item.key, value: item.value }));
const placeBars = (items) => items.map((item) => ({ label: item.name || item.id, value: item.value }));
const percent = (value) => (value === null || value === undefined ? '—' : `${value.toLocaleString('ru-RU')} %`);
const ms = (value) => (value === null || value === undefined ? '—' : `${formatNumber(value)} мс`);

/** «+12 % к прошлому периоду» — без цвета: рост запросов сам по себе не хорошо и не плохо. */
const changeText = (change, previous) => {
  if (change === null || change === undefined) return previous ? `прошлый период: ${formatNumber(previous)}` : 'в прошлом периоде данных нет';
  return `${change > 0 ? '+' : ''}${change.toLocaleString('ru-RU')} % к прошлому периоду`;
};

const bucketAxis = (iso, bucket) => {
  const date = new Date(iso);
  if (bucket === 'hour') return date.toLocaleTimeString('ru-RU', { ...MSK, hour: '2-digit', minute: '2-digit' });
  if (bucket === 'month') return date.toLocaleDateString('ru-RU', { ...MSK, month: 'short', year: '2-digit' });
  return date.toLocaleDateString('ru-RU', { ...MSK, day: '2-digit', month: '2-digit' });
};
const bucketFull = (iso, bucket) => {
  const date = new Date(iso);
  if (bucket === 'hour') return date.toLocaleString('ru-RU', { ...MSK, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  if (bucket === 'day') return date.toLocaleDateString('ru-RU', { ...MSK, weekday: 'short', day: 'numeric', month: 'long' });
  if (bucket === 'week') return `Неделя с ${date.toLocaleDateString('ru-RU', { ...MSK, day: 'numeric', month: 'long' })}`;
  return date.toLocaleDateString('ru-RU', { ...MSK, month: 'long', year: 'numeric' });
};
const dayFull = (day) => bucketFull(`${day}T12:00:00+03:00`, 'day');
const dayAxis = (day) => bucketAxis(`${day}T12:00:00+03:00`, 'day');

function Note({ children }) {
  return (
    <p className="flex items-start gap-2 rounded-xl bg-blue-50/70 px-3 py-2 text-[12px] leading-5 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
      <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function ListCard({ title, description, items, empty = 'За период нет данных' }) {
  return (
    <Card title={title} description={description}>
      {items.some((item) => item.value > 0) ? <BarList caption={title} items={items} /> : <EmptyState title={empty} />}
    </Card>
  );
}

function ChartCard({ title, description, ...chart }) {
  return (
    <Card title={title} description={description}>
      <TimeChart caption={title} {...chart} />
    </Card>
  );
}

/** Таблица с сортировкой по колонке и своей горизонтальной прокруткой. */
function SortableTable({ columns, rows, rowKey, initial, caption, testId }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const column = columns.find((item) => item.key === sort.key);
    const value = column?.sortValue || ((row) => row[sort.key]);
    return [...rows].sort((left, right) => {
      const a = value(left);
      const b = value(right);
      const order = typeof a === 'string' ? a.localeCompare(b, 'ru') : (a ?? -1) - (b ?? -1);
      return sort.desc ? -order : order;
    });
  }, [rows, columns, sort]);
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <table className="w-full min-w-[720px] text-left text-[12.5px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
          <tr>
            {columns.map((column) => {
              const active = sort.key === column.key;
              const Arrow = sort.desc ? ArrowDown : ArrowUp;
              return (
                <th key={column.key} scope="col" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'} className={`px-3 py-2 font-semibold ${column.numeric ? 'text-right' : ''}`}>
                  <button type="button" onClick={() => setSort(active ? { key: column.key, desc: !sort.desc } : { key: column.key, desc: Boolean(column.numeric) })} className="inline-flex items-center gap-1 rounded hover:text-slate-800 dark:hover:text-slate-100">
                    {column.label}
                    {active && <Arrow size={12} aria-hidden="true" />}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
          {sorted.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={`px-3 py-1.5 ${column.numeric ? 'text-right text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-300'} ${column.mono ? 'whitespace-nowrap font-mono text-[11.5px]' : ''}`}>
                  {column.render ? column.render(row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ENDPOINT_COLUMNS = [
  { key: 'name', label: 'Адрес', mono: true, render: (row) => (row.name === 'static' ? 'Статика (страницы, файлы)' : row.name === 'unknown' ? 'Несуществующие адреса' : row.name) },
  { key: 'group', label: 'Группа' },
  { key: 'count', label: 'Запросов', numeric: true, render: (row) => formatNumber(row.count) },
  { key: 'share', label: 'Доля', numeric: true, render: (row) => percent(row.share) },
  { key: 'ok', label: '2xx–3xx', numeric: true, render: (row) => formatNumber(row.ok) },
  { key: 's4xx', label: '4xx', numeric: true, render: (row) => formatNumber(row.s4xx) },
  { key: 's429', label: '429', numeric: true, render: (row) => formatNumber(row.s429) },
  { key: 's5xx', label: '5xx', numeric: true, render: (row) => formatNumber(row.s5xx) },
  { key: 'avgMs', label: 'Среднее', numeric: true, render: (row) => ms(row.avgMs) },
  { key: 'p50Ms', label: 'p50 до', numeric: true, render: (row) => ms(row.p50Ms) },
  { key: 'p95Ms', label: 'p95 до', numeric: true, render: (row) => ms(row.p95Ms) },
];

function RequestsTab({ data, chart }) {
  const { requests } = data;
  const [group, setGroup] = useState('');
  const groups = requests.byGroup.map((row) => row.name);
  const rows = group ? requests.byEndpoint.filter((row) => row.group === group) : requests.byEndpoint;
  const latencyLabels = [...requests.latency.bounds.map((bound) => `до ${formatNumber(bound)} мс`), `дольше ${formatNumber(requests.latency.bounds.at(-1))} мс`];
  const latencyAxis = [...requests.latency.bounds.map((bound) => formatNumber(bound)), `>${formatNumber(requests.latency.bounds.at(-1))}`];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="В среднем за час" value={formatNumber(requests.perHourAverage)} sub="запросов" />
        <Tile label="Самый загруженный час" value={requests.peakHour ? formatNumber(requests.peakHour.count) : '—'} sub={requests.peakHour ? formatDateTime(requests.peakHour.start) : 'нет данных'} />
        <Tile label="Самый загруженный день" value={requests.peakDay ? formatNumber(requests.peakDay.count) : '—'} sub={requests.peakDay ? dayFull(new Date(requests.peakDay.start).toLocaleDateString('sv-SE', MSK)) : 'нет данных'} />
        <Tile label="Отказы по лимиту (429)" value={formatNumber(requests.totals.s429)} sub={`Прочих 4xx: ${formatNumber(requests.totals.s4xx - requests.totals.s429)}`} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Запросы" description={`Всего за период: ${formatNumber(requests.totals.count)}`} {...chart} series={[{ key: 'count', label: 'Запросов', values: requests.series.count, color: '--viz-1' }]} emptyText="Запросов за период не было" />
        <ChartCard title="Ошибки" description="Клиента (4xx) и сервера (5xx)" {...chart} series={[{ key: '4xx', label: '4xx', values: requests.series.s4xx, color: '--viz-1' }, { key: '5xx', label: '5xx', values: requests.series.s5xx, color: '--viz-2' }]} emptyText="Ошибок за период не было" />
        <ChartCard title="Время ответа" description="Среднее и 95-й процентиль (приблизительно, по корзинам), мс" {...chart} series={[{ key: 'avg', label: 'Среднее', values: requests.series.avgMs.map((value) => value ?? 0), color: '--viz-1' }, { key: 'p95', label: 'p95', values: requests.series.p95Ms.map((value) => value ?? 0), color: '--viz-2' }]} />
        <ChartCard title="Распределение времени ответа" description="Сколько запросов уложилось в каждую границу, мс" labels={latencyLabels} axisLabels={latencyAxis} series={[{ key: 'latency', label: 'Запросов', values: requests.latency.counts, color: '--viz-1' }]} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <Card title="Часы пик" description="Запросы по дням недели и часам, время московское">
          <Heatmap caption="Запросы по дням недели и часам" rows={WEEKDAYS} columns={HOURS} values={requests.heatmap} unit="запросов" />
          <div className="mt-5">
            <TimeChart caption="Запросы по часам суток" labels={HOURS.map((hour) => `${hour}:00`)} axisLabels={HOURS} series={[{ key: 'hour', label: 'Запросов', values: requests.perHourOfDay, color: '--viz-1' }]} />
          </div>
        </Card>
        <ListCard title="По группам" items={requests.byGroup.map((row) => ({ label: row.name, value: row.count }))} />
      </div>
      <Card
        title="По адресам"
        description="Адрес обезличен: идентификаторы заменены на :id, параметров запроса нет"
        actions={<SelectInput aria-label="Группа" value={group} onChange={(event) => setGroup(event.target.value)} options={[{ value: '', label: 'Все группы' }, ...groups.map((name) => ({ value: name, label: name }))]} />}
        bodyClassName="p-0"
      >
        {rows.length ? <SortableTable caption="Запросы по адресам" testId="stats-endpoints" columns={ENDPOINT_COLUMNS} rows={rows} rowKey={(row) => row.name} initial={{ key: 'count', desc: true }} /> : <EmptyState title="За период запросов не было" />}
      </Card>
    </div>
  );
}

function AssistantTab({ data }) {
  const { assistant } = data;
  const dayLabels = assistant.daily.map((row) => dayFull(row.day));
  const dayAxisLabels = assistant.daily.map((row) => dayAxis(row.day));
  const { problems } = assistant;
  return (
    <div className="space-y-5">
      <Note>Счётчики ассистента хранятся только по суткам и не связаны с людьми: ассистент не привязан к аккаунту, а жалоба — сведения о здоровье. Тексты запросов нигде не сохраняются. Лимит обращений к модели: {assistant.dailyLimit === null ? 'не задан' : `${formatNumber(assistant.dailyLimit)} в сутки`}.</Note>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Запросов к ассистенту" value={formatNumber(assistant.requests?.count ?? 0)} sub={assistant.requests ? `среднее ${ms(assistant.requests.avgMs)} · ошибок 5xx: ${formatNumber(assistant.requests.s5xx)}` : 'нет данных'} />
        <Tile label="Обращений к модели" value={formatNumber(assistant.modelCalls)} sub={changeText(assistant.modelCallsChange)} />
        <Tile label="Ответов без модели" value={formatNumber(assistant.localAnswers)} sub="по локальному плану" />
        <Tile label="Токенов модели" value={formatNumber(assistant.tokens.total)} sub={`запрос: ${formatNumber(assistant.tokens.prompt)} · ответ: ${formatNumber(assistant.tokens.completion)}`} />
        <Tile label="Срочные случаи" value={formatNumber(assistant.emergency)} sub="показан совет обратиться за помощью" />
        <Tile label="Запросы на подбор записи" value={formatNumber(assistant.bookingRequests)} sub="из разговора с ассистентом" />
        <Tile label="Упёрлись в лимит модели" value={formatNumber(problems.budgetExhausted)} sub="ответили без модели" />
        <Tile label="Сервер был занят" value={formatNumber(problems.shed + problems.busy)} sub={`отклонено сразу: ${formatNumber(problems.shed)} · очередь: ${formatNumber(problems.busy)}`} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Обращения к модели и ответы без неё" description="По суткам" labels={dayLabels} axisLabels={dayAxisLabels} series={[{ key: 'model', label: 'Модель', values: assistant.daily.map((row) => row.modelCalls), color: '--viz-1' }, { key: 'local', label: 'Без модели', values: assistant.daily.map((row) => row.local), color: '--viz-2' }]} />
        <ChartCard title="Токены модели" description="По суткам: от них зависит расход" labels={dayLabels} axisLabels={dayAxisLabels} series={[{ key: 'tokens', label: 'Токенов', values: assistant.daily.map((row) => row.tokens), color: '--viz-1' }]} />
        <ListCard title="Решения приватности" description="Что можно передать модели" items={bars(assistant.gatewayDecisions, 'decision')} />
        <ListCard title="Почему ответ без модели" items={bars(assistant.localReasons, 'reason')} />
        <ListCard title="Выбор врача по жалобе" description={`Повторов из-за ответа не по формату: ${formatNumber(assistant.triage.retries)}`} items={bars(assistant.triage.results, 'triage')} />
        <ListCard
          title="Сбои"
          items={[
            ...bars(problems.plannerErrors).map((item) => ({ ...item, label: `Модель: ${item.label}` })),
            ...bars(assistant.triage.errors).map((item) => ({ ...item, label: `Выбор врача: ${item.label}` })),
            ...bars(problems.chatErrors).map((item) => ({ ...item, label: `Ассистент: ${item.label}` })),
            { label: 'План модели не прошёл проверку', value: problems.invalidPlans },
            { label: 'План отклонён правилами', value: problems.policyRejected },
            { label: 'Заблокирована отправка модели', value: problems.outboundBlocked },
          ]}
          empty="Сбоев за период не было"
        />
      </div>
    </div>
  );
}

function ProductTab({ data }) {
  const { product } = data;
  const { funnel, searches } = product;
  const dayLabels = product.daily.map((row) => dayFull(row.day));
  const dayAxisLabels = product.daily.map((row) => dayAxis(row.day));
  if (product.daysWithData === 0) {
    return <EmptyState icon={Info} title="За период нет событий" description="Журнал аналитики пишется, когда пользователи ищут врачей на сайте. Браузеры с запретом отслеживания (DNT, GPC) события не отправляют." />;
  }
  return (
    <div className="space-y-5">
      <Note>Из журнала аналитики, по полным суткам: {formatNumber(product.daysWithData)} дн. с данными из {formatNumber(data.period.days.length)}. Сессия — вкладка браузера, не человек; идущая через полночь считается в каждых сутках. Браузеры с запретом отслеживания не учитываются. Запросы, координаты и данные людей в журнал не пишутся.</Note>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Сессии" value={formatNumber(funnel.sessions)} sub={`событий: ${formatNumber(product.events)}`} />
        <Tile label="Поиски" value={formatNumber(searches.total)} sub={`с геопозицией: ${formatNumber(searches.withLocation)} · с ДМС: ${formatNumber(searches.withDms)}`} />
        <Tile label="Успешные поиски" value={percent(searches.successRate)} sub={`${formatNumber(searches.successful)} дошли до действия`} />
        <Tile label="Пустая выдача" value={percent(searches.zeroResultRate)} sub={`${formatNumber(searches.zeroResults)} поисков`} />
        <Tile label="Контакты" value={formatNumber(product.contacts.channels.reduce((sum, item) => sum + item.value, 0))} sub="звонки, сайты, Госуслуги" />
        <Tile label="Маршруты" value={formatNumber(product.routes.ok)} sub={`ошибок: ${formatNumber(product.routes.failed)} (${percent(product.routes.failureRate)})`} />
        <Tile label="Переходы во внешние карты" value={formatNumber(product.externalMaps.reduce((sum, item) => sum + item.value, 0))} sub="Яндекс Карты и 2ГИС" />
        <Tile label="Доволен результатом" value={percent(product.feedback.satisfaction)} sub={`да: ${formatNumber(product.feedback.yes)} · нет: ${formatNumber(product.feedback.no)}`} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <ListCard
          title="Воронка"
          description="Сессии, дошедшие до шага"
          items={[
            { label: 'Все сессии', value: funnel.sessions },
            { label: 'Искали', value: funnel.searched },
            { label: 'Открыли карточку или метку', value: funnel.opened },
            { label: 'Дошли до действия', value: funnel.acted },
            { label: 'Ответили «нашёл»', value: funnel.satisfied },
          ]}
        />
        <ChartCard title="Поиски и успешные поиски" description="По суткам" labels={dayLabels} axisLabels={dayAxisLabels} series={[{ key: 'searches', label: 'Поиски', values: product.daily.map((row) => row.searches), color: '--viz-1' }, { key: 'successful', label: 'Успешные', values: product.daily.map((row) => row.successful), color: '--viz-2' }]} />
        <ChartCard title="Поиски по часам суток" description="Сумма за период, время московское" labels={HOURS.map((hour) => `${hour}:00`)} axisLabels={HOURS} series={[{ key: 'hours', label: 'Поисков', values: product.searchesPerHour, color: '--viz-1' }]} />
        <ListCard title="Откуда поиск" items={product.bySource.map((row) => ({ label: `${label('source', row.source)} · успешных ${percent(row.successRate)}`, value: row.searches }))} />
      </div>
      <Card title="По специальностям" bodyClassName="p-0">
        {product.bySpecialty.length ? (
          <SortableTable
            caption="Поиски по специальностям"
            rows={product.bySpecialty}
            rowKey={(row) => row.specialty}
            initial={{ key: 'searches', desc: true }}
            columns={[
              { key: 'specialty', label: 'Специальность', render: (row) => specialtyName(row.specialty), sortValue: (row) => specialtyName(row.specialty) },
              { key: 'searches', label: 'Поисков', numeric: true, render: (row) => formatNumber(row.searches) },
              { key: 'successful', label: 'Успешных', numeric: true, render: (row) => formatNumber(row.successful) },
              { key: 'successRate', label: 'Доля успешных', numeric: true, render: (row) => percent(row.successRate) },
              { key: 'zeroResults', label: 'Пустая выдача', numeric: true, render: (row) => formatNumber(row.zeroResults) },
            ]}
          />
        ) : <EmptyState title="За период поисков не было" />}
      </Card>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        <ListCard title="Какие фильтры включают" items={bars(product.filters, 'filter')} />
        <ListCard
          title="Сколько нашлось"
          items={[
            { label: 'Ничего', value: product.resultCounts.zero },
            { label: 'От 1 до 5', value: product.resultCounts.few },
            { label: 'Больше 5', value: product.resultCounts.many },
          ]}
        />
        <ListCard title="Пустая выдача: профиль" items={product.zeroResults.bySpecialty.map((item) => ({ label: specialtyName(item.key), value: item.value }))} />
        <ListCard title="Пустая выдача: фильтры" items={bars(product.zeroResults.byFilter, 'filter')} />
        <ListCard title="Чаще всего открывают" items={placeBars(product.opens.topPlaces)} />
        <ListCard title="Где открывают" items={[...bars(product.opens.surface, 'surface'), ...bars(product.opens.kind, 'kind')]} />
        <ListCard title="Контакты по каналам" items={bars(product.contacts.channels, 'channel')} />
        <ListCard title="Чаще всего связываются" items={placeBars(product.contacts.topPlaces)} />
        <ListCard title="Маршруты по способу" items={bars(product.routes.modes, 'mode')} />
        <ListCard title="Внешние карты" items={product.externalMaps.map((item) => { const [provider, mode] = item.key.split(':'); return { label: `${provider === 'yandex' ? 'Яндекс Карты' : '2ГИС'} · ${label('mapMode', mode)}`, value: item.value }; })} />
        <ListCard title="Почему не нашли" items={bars(product.feedback.reasons, 'feedback')} />
        <ListCard title="Сообщения о неверных данных" items={bars(product.dataReports.reasons, 'report')} />
        <ListCard title="Какие записи проверить" description="Чаще всего сообщают об ошибках" items={placeBars(product.dataReports.topPlaces)} />
      </div>
    </div>
  );
}

function UsersTab({ data, chart }) {
  const { accounts, coverage } = data;
  const { users } = accounts;
  return (
    <div className="space-y-5">
      <Note>Числа из базы аккаунтов, демо-копии не учитываются. История входов хранится {formatNumber(coverage.authEventsDays)} дн.: за более ранний период входов на графике не будет. Активные — выполнили хотя бы один запрос с действующей сессией за московские сутки; по часам активность не считается.</Note>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Новые аккаунты" value={formatNumber(accounts.newAccounts)} sub={`прошлый период: ${formatNumber(accounts.newAccountsPrevious)}`} />
        <Tile label="Активные за период" value={formatNumber(accounts.uniqueActive)} sub="уникальные пользователи" />
        <Tile label="Активных в день" value={formatNumber(accounts.averageDailyActive)} sub={`в среднем · максимум: ${formatNumber(accounts.peakDailyActive)}`} />
        <Tile label="Всего аккаунтов" value={formatNumber(users.total)} sub={`активны: ${formatNumber(users.active)} · заблокированы: ${formatNumber(users.blocked)} · ждут активации: ${formatNumber(users.pending)}`} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Новые аккаунты" {...chart} series={[{ key: 'new', label: 'Новых', values: accounts.series.newAccounts, color: '--viz-1' }]} emptyText="Новых аккаунтов за период нет" />
        <ChartCard title="Входы" description="Успешные и неудачные" {...chart} series={[{ key: 'ok', label: 'Успешные', values: accounts.series.logins, color: '--viz-1' }, { key: 'failed', label: 'Неудачные', values: accounts.series.failedLogins, color: '--viz-2' }]} emptyText="Входов за период не было" />
        <Card title="Активные пользователи" description="Уникальные за каждый интервал">
          {accounts.series.activeUsers ? <TimeChart caption="Активные пользователи" {...chart} series={[{ key: 'active', label: 'Пользователей', values: accounts.series.activeUsers, color: '--viz-1' }]} /> : <EmptyState icon={Info} title="Недоступно при шаге «по часам»" description="Активность считается по суткам. Выберите шаг «по дням» или период длиннее двух суток." />}
        </Card>
        <ListCard title="События входа и защиты" items={accounts.auth.map((item) => ({ label: item.label, value: item.value }))} />
        <ListCard title="Аккаунты по ролям" items={bars(users.byRole, 'role')} />
      </div>
    </div>
  );
}

function BookingTab({ data, chart }) {
  const { booking } = data;
  if (!booking.available) return <EmptyState icon={Info} title="Запись выключена" description="Демо-запись работает при DEMO_DATA=on. Когда появится настоящая запись, её цифры будут здесь." />;
  return (
    <div className="space-y-5">
      <Note>Запись пока демонстрационная: врачи и расписание вымышлены, в клиники ничего не уходит. Цифры показывают, как пользуются сценарием.</Note>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Создано записей" value={formatNumber(booking.created)} sub={`из них ещё действуют: ${formatNumber(booking.stillActive)}`} />
        <Tile label="Отменено" value={formatNumber(booking.cancelled)} sub={`${percent(booking.cancelRate)} от созданных за период`} />
        <Tile label="С программой ДМС" value={formatNumber(booking.withPlan)} sub={`из личного кабинета: ${formatNumber(booking.withAccount)}`} />
        <Tile label="Запись заранее" value={booking.averageLeadHours === null ? '—' : `${booking.averageLeadHours.toLocaleString('ru-RU')} ч`} sub={`в среднем до приёма · предстоит: ${formatNumber(booking.upcomingActive)}`} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Записи и отмены" {...chart} series={[{ key: 'created', label: 'Созданы', values: booking.series.created, color: '--viz-1' }, { key: 'cancelled', label: 'Отменены', values: booking.series.cancelled, color: '--viz-2' }]} emptyText="Записей за период не было" />
        <ChartCard title="На какие часы записываются" description="Время приёма, московское" labels={HOURS.map((hour) => `${hour}:00`)} axisLabels={HOURS} series={[{ key: 'hour', label: 'Записей', values: booking.hourOfDay, color: '--viz-1' }]} />
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        <ListCard title="По специальностям" items={bars(booking.bySpecialty)} />
        <ListCard title="По клиникам" items={bars(booking.byClinic)} />
        <ListCard title="По врачам" items={bars(booking.byDoctor)} />
        <ListCard title="По услугам" items={bars(booking.byService)} />
        <ListCard title="По районам" items={bars(booking.byDistrict)} />
        <ListCard title="На какие дни записываются" items={WEEKDAYS.map((day, index) => ({ label: day, value: booking.weekday[index] }))} />
      </div>
    </div>
  );
}

function MailTab({ data, chart }) {
  const { mail } = data;
  return (
    <div className="space-y-5">
      <Note>Очередь писем хранит записи {formatNumber(mail.keepDays)} дн.: за более ранний период данных нет. «Отправлено» значит, что почтовый сервер принял письмо, а не что оно дошло.</Note>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Всего писем" value={formatNumber(mail.total)} sub={`в очереди: ${formatNumber(mail.pending)}`} />
        <Tile label="Отправлено" value={formatNumber(mail.sent)} sub={`${percent(mail.deliveryRate)} от завершённых`} />
        <Tile label="Не отправлено" value={formatNumber(mail.failed)} sub="после всех попыток" />
        <Tile label="Видов писем" value={formatNumber(mail.byKind.length)} sub="за период" />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
        <ChartCard title="Письма" {...chart} series={[{ key: 'sent', label: 'Отправлено', values: mail.series.sent, color: '--viz-1' }, { key: 'failed', label: 'Не отправлено', values: mail.series.failed, color: '--viz-2' }]} emptyText="Писем за период не было" />
        <ListCard title="Причины неотправки" description="Коды — в docs/mail-setup.md" items={bars(mail.errors)} empty="Сбоев за период не было" />
      </div>
      <Card title="По видам" bodyClassName="p-0">
        {mail.byKind.length ? (
          <SortableTable
            caption="Письма по видам"
            rows={mail.byKind}
            rowKey={(row) => row.kind}
            initial={{ key: 'total', desc: true }}
            columns={[
              { key: 'kind', label: 'Письмо', render: (row) => label('mail', row.kind), sortValue: (row) => label('mail', row.kind) },
              { key: 'total', label: 'Всего', numeric: true, render: (row) => formatNumber(row.total) },
              { key: 'sent', label: 'Отправлено', numeric: true, render: (row) => formatNumber(row.sent) },
              { key: 'failed', label: 'Не отправлено', numeric: true, render: (row) => formatNumber(row.failed) },
              { key: 'pending', label: 'В очереди', numeric: true, render: (row) => formatNumber(row.pending) },
            ]}
          />
        ) : <EmptyState title="За период писем не было" />}
      </Card>
    </div>
  );
}

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  // Точка с запятой — для русского Excel; формула из ячейки не исполнится.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[";\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** Строки CSV текущей вкладки: то, что на графиках и в таблицах. */
const csvRows = (tab, data) => {
  const { period } = data;
  const buckets = period.buckets.map((iso) => bucketFull(iso, period.bucket));
  const { requests, assistant, product, accounts, booking, mail } = data;
  const series = (columns) => [['Период', ...columns.map(([name]) => name)], ...buckets.map((name, index) => [name, ...columns.map(([, values]) => values?.[index] ?? '')])];
  switch (tab) {
    case 'assistant':
      return [['День', 'Обращений к модели', 'Ответов без модели', 'Токенов', 'Сбоев'], ...assistant.daily.map((row) => [row.day, row.modelCalls, row.local, row.tokens, row.errors])];
    case 'product':
      return [
        ['День', 'Событий', 'Сессий', 'Поисков', 'Успешных', 'Пустых', 'Открытий', 'Контактов', 'Маршрутов'],
        ...product.daily.map((row) => [row.day, row.events, row.sessions, row.searches, row.successful, row.zeroResults, row.opens, row.contacts, row.routes]),
        [],
        ['Специальность', 'Поисков', 'Успешных', 'Пустых'],
        ...product.bySpecialty.map((row) => [specialtyName(row.specialty), row.searches, row.successful, row.zeroResults]),
      ];
    case 'users':
      return [...series([['Новые аккаунты', accounts.series.newAccounts], ['Успешные входы', accounts.series.logins], ['Неудачные входы', accounts.series.failedLogins], ['Активные', accounts.series.activeUsers]]), [], ['Событие', 'Число'], ...accounts.auth.map((item) => [item.label, item.value])];
    case 'booking':
      return booking.available ? series([['Созданы', booking.series.created], ['Отменены', booking.series.cancelled]]) : [];
    case 'mail':
      return [...series([['Отправлено', mail.series.sent], ['Не отправлено', mail.series.failed]]), [], ['Письмо', 'Всего', 'Отправлено', 'Не отправлено', 'В очереди'], ...mail.byKind.map((row) => [label('mail', row.kind), row.total, row.sent, row.failed, row.pending])];
    default:
      return [
        ...series([['Запросов', requests.series.count], ['4xx', requests.series.s4xx], ['429', requests.series.s429], ['5xx', requests.series.s5xx], ['Среднее, мс', requests.series.avgMs], ['p95, мс', requests.series.p95Ms]]),
        [],
        ['Адрес', 'Группа', 'Запросов', 'Доля, %', '2xx-3xx', '4xx', '429', '5xx', 'Среднее, мс', 'p50, мс', 'p95, мс'],
        ...requests.byEndpoint.map((row) => [row.name, row.group, row.count, row.share, row.ok, row.s4xx, row.s429, row.s5xx, row.avgMs, row.p50Ms, row.p95Ms]),
      ];
  }
};

const downloadCsv = (tab, data) => {
  const text = csvRows(tab, data).map((row) => row.map(csvCell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `medkarta-stats-${tab}-${data.period.days[0]}_${data.period.days.at(-1)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const todayKey = () => new Date().toLocaleDateString('sv-SE', MSK);

export default function Stats() {
  const [selection, setSelection] = useState({ preset: '7d', from: '', to: '', bucket: '' });
  const [draft, setDraft] = useState({ from: '', to: '' });
  const [tab, setTab] = useState('requests');
  const query = selection.preset ? { preset: selection.preset, bucket: selection.bucket } : { from: selection.from, to: selection.to, bucket: selection.bucket };
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/stats', query), [selection]);

  const chart = useMemo(() => (data ? {
    labels: data.period.buckets.map((iso) => bucketFull(iso, data.period.bucket)),
    axisLabels: data.period.buckets.map((iso) => bucketAxis(iso, data.period.bucket)),
  } : null), [data]);

  const applyCustom = (event) => {
    event.preventDefault();
    setSelection((current) => ({ ...current, preset: '', from: draft.from, to: draft.to }));
  };

  const { requests, assistant, product, accounts, coverage, period } = data || {};
  return (
    <div className="space-y-5" data-testid="stats-page">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Период">
          {PRESETS.map(([value, name]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selection.preset === value}
              onClick={() => setSelection((current) => ({ ...current, preset: value }))}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${selection.preset === value ? 'bg-blue-600 text-white shadow-sm' : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              data-testid={`stats-preset-${value}`}
            >
              {name}
            </button>
          ))}
        </div>
        <form className="flex flex-wrap items-end gap-2" onSubmit={applyCustom}>
          <label className="text-[12px] font-semibold text-slate-500 dark:text-slate-400">
            С
            <input type="date" className={`${inputClass} mt-1 block !w-auto`} value={draft.from} max={draft.to || todayKey()} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} data-testid="stats-from" />
          </label>
          <label className="text-[12px] font-semibold text-slate-500 dark:text-slate-400">
            По
            <input type="date" className={`${inputClass} mt-1 block !w-auto`} value={draft.to} min={draft.from || undefined} max={todayKey()} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} data-testid="stats-to" />
          </label>
          <Button type="submit" variant="secondary" disabled={!draft.from || !draft.to} data-testid="stats-apply">Показать</Button>
          <SelectInput aria-label="Шаг графика" value={selection.bucket} onChange={(event) => setSelection((current) => ({ ...current, bucket: event.target.value }))} options={BUCKETS} className="!w-auto" data-testid="stats-bucket" />
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" icon={RefreshCw} onClick={reload} loading={loading}>Обновить</Button>
            <Button type="button" variant="secondary" icon={Download} disabled={!data} onClick={() => downloadCsv(tab, data)} data-testid="stats-csv">CSV</Button>
          </div>
        </form>
        {data && (
          <p className="text-[12px] text-slate-500 dark:text-slate-400" data-testid="stats-period">
            {period.label}: {formatDateTime(period.from)} — {formatDateTime(period.to)} (МСК) · сравнение с {formatDateTime(period.previousFrom)} — {formatDateTime(period.previousTo)}
            {period.bucketAdjusted && ' · шаг изменён: для такого периода выбранный слишком мелкий'}
          </p>
        )}
      </div>

      {error && <Card><ErrorState error={error} onRetry={reload} /></Card>}
      {!data && loading && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-[104px] rounded-2xl" />)}
        </div>
      )}

      {data && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {!coverage.collecting && <Note>Счётчики запросов не ведутся: сервер запущен без базы статистики (STATS=off, режим разработки или нет node:sqlite). Журнал поиска и база аккаунтов при этом работают.</Note>}
          {coverage.collecting && <Note>Запросы считаются {coverage.requestsSince ? `с ${formatDateTime(coverage.requestsSince)} (МСК)` : 'с этого момента'}, раньше истории нет: до этого счётчик жил только в памяти. Запись идёт раз в минуту. Людей, адресов и текстов запросов в статистике нет.</Note>}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Запросов к серверу" value={formatNumber(requests.totals.count)} sub={changeText(requests.change.count, requests.previous.count)} testId="stats-total" />
            <Tile label="Ошибки сервера (5xx)" value={formatNumber(requests.totals.s5xx)} sub={`${percent(requests.totals.errorRate)} запросов · ${changeText(requests.change.s5xx, requests.previous.s5xx)}`} />
            <Tile label="Время ответа" value={ms(requests.totals.avgMs)} sub={`в среднем · 95 % быстрее ${ms(requests.totals.p95Ms)}`} />
            <Tile label="Обращений к модели" value={formatNumber(assistant.modelCalls)} sub={`токенов: ${formatNumber(assistant.tokens.total)}`} />
            <Tile label="Запросов к ассистенту" value={formatNumber(assistant.requests?.count ?? 0)} sub={`без модели: ${formatNumber(assistant.localAnswers)}`} />
            <Tile label="Поиски врачей" value={formatNumber(product.searches.total)} sub={`сессий: ${formatNumber(product.funnel.sessions)} · успешных: ${percent(product.searches.successRate)}`} />
            <Tile label="Активные пользователи" value={formatNumber(accounts.uniqueActive)} sub={`в среднем в день: ${formatNumber(accounts.averageDailyActive)}`} />
            <Tile label="Новые аккаунты" value={formatNumber(accounts.newAccounts)} sub={`прошлый период: ${formatNumber(accounts.newAccountsPrevious)}`} />
          </div>

          <Tabs tabs={TABS} value={tab} onChange={setTab} label="Разделы статистики" />
          {tab === 'requests' && <RequestsTab data={data} chart={chart} />}
          {tab === 'assistant' && <AssistantTab data={data} />}
          {tab === 'product' && <ProductTab data={data} />}
          {tab === 'users' && <UsersTab data={data} chart={chart} />}
          {tab === 'booking' && <BookingTab data={data} chart={chart} />}
          {tab === 'mail' && <MailTab data={data} chart={chart} />}
        </div>
      )}
    </div>
  );
}
