/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Дашборд: только числа из базы и счётчики процесса. Где данных нет или
 * они приблизительные, это сказано прямо, а не нарисовано.
 */
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Info, ShieldAlert, UserPlus, Users, XCircle } from 'lucide-react';

import { api, useApi } from '../api';
import { BarList, TimeChart } from '../charts';
import { UserCell } from '../common';
import { describeAudit, useAdmin } from '../model';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '../../ui/kit';
import { formatDateTime, formatNumber, formatRelative, ROLE_LABELS } from '../../ui/format';
import { Link } from '../../ui/router';

const PERIODS = [
  ['24h', '24 часа'],
  ['7d', '7 дней'],
  ['30d', '30 дней'],
  ['90d', '90 дней'],
];

const bucketLabel = (iso, hourly) => {
  const date = new Date(iso);
  return hourly
    ? date.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
};
const bucketFull = (iso, hourly) => {
  const date = new Date(iso);
  return hourly
    ? date.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'short', day: 'numeric', month: 'long' });
};

function Tile({ label, value, sub, icon: Icon, tone = 'blue', testId }) {
  const tones = {
    blue: 'bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-300',
    green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-300',
    red: 'bg-red-50 text-red-600 dark:bg-red-950/60 dark:text-red-300',
    violet: 'bg-violet-50 text-violet-600 dark:bg-violet-950/60 dark:text-violet-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900" data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12.5px] font-semibold text-slate-500 dark:text-slate-400">{label}</p>
        {Icon && <span className={`flex h-8 w-8 items-center justify-center rounded-xl ${tones[tone]}`}><Icon size={16} aria-hidden="true" /></span>}
      </div>
      <p className="mt-1 text-[28px] font-extrabold leading-tight text-slate-800 dark:text-white">{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">{sub}</p>}
    </div>
  );
}

const HEALTH = {
  ok: [CheckCircle2, 'text-emerald-600 dark:text-emerald-400', 'Работает'],
  error: [XCircle, 'text-red-600 dark:text-red-400', 'Ошибка'],
  degraded: [AlertTriangle, 'text-amber-600 dark:text-amber-400', 'С ограничениями'],
  off: [CircleSlash, 'text-slate-400', 'Выключено'],
};

export function HealthList({ components }) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {components.map((component) => {
        const [Icon, color, label] = HEALTH[component.status] || HEALTH.off;
        return (
          <li key={component.key} className="flex items-start gap-3 py-2.5">
            <Icon size={18} className={`mt-0.5 shrink-0 ${color}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">{component.label}</p>
              <p className="text-[12px] text-slate-500 dark:text-slate-400">{component.detail}</p>
            </div>
            <span className={`shrink-0 text-[12px] font-semibold ${color}`}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Dashboard() {
  const { can } = useAdmin();
  const [period, setPeriod] = useState('7d');
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/dashboard', { period }), [period]);
  const hourly = data?.series.bucketMs === 3600000;
  const labels = data ? data.series.buckets.map((iso) => bucketFull(iso, hourly)) : [];
  const axis = data ? data.series.buckets.map((iso) => bucketLabel(iso, hourly)) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900" role="radiogroup" aria-label="Период">
          {PERIODS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={period === value}
              onClick={() => setPeriod(value)}
              className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition ${period === value ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
              data-testid={`period-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
        {data && <p className="text-[12px] text-slate-500 dark:text-slate-400">Обновлено {formatDateTime(data.generatedAt)} (МСК) · демо-копии не учитываются</p>}
      </div>

      {error && !data && <Card><ErrorState error={error} onRetry={reload} /></Card>}
      {!data && loading && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-[104px] rounded-2xl" />)}
        </div>
      )}

      {data && (
        <div className={`space-y-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Всего пользователей" value={formatNumber(data.users.total)} sub={`Ждут активации ${formatNumber(data.users.pending ?? 0)} · в архиве ${formatNumber(data.users.archived)}`} icon={Users} testId="tile-total" />
            <Tile label="Заблокированы" value={formatNumber(data.users.blocked)} sub={`Должны сменить пароль: ${formatNumber(data.users.mustChangePassword)}`} icon={ShieldAlert} tone="red" />
            <Tile label="Новые аккаунты" value={formatNumber(data.newAccounts.day)} sub={`за 24 часа · 7 дней: ${formatNumber(data.newAccounts.week)} · 30 дней: ${formatNumber(data.newAccounts.month)}`} icon={UserPlus} tone="green" />
            <Tile label="Активные пользователи" value={`${formatNumber(data.activity.dau)} / ${formatNumber(data.activity.wau)} / ${formatNumber(data.activity.mau)}`} sub="DAU / WAU / MAU" icon={Users} tone="violet" />
            <Tile label="Успешные входы" value={formatNumber(data.auth.logins)} sub={`за ${data.periodLabel}`} tone="blue" />
            <Tile label="Неудачные попытки" value={formatNumber(data.auth.failed)} sub={`за ${data.periodLabel} · отклонено заблокированным: ${formatNumber(data.auth.denied)}`} tone="amber" />
            <Tile label="Активные сессии" value={formatNumber(data.sessions.active)} sub={`демо-копий: ${formatNumber(data.sessions.demo)}`} tone="blue" />
            <Tile label="Ошибки сервера 5xx" value={data.health ? formatNumber(data.health.errors.errors5xx) : '—'} sub={data.health ? `4xx: ${formatNumber(data.health.errors.errors4xx)} · с запуска ${formatRelative(data.health.errors.since)}` : 'нет данных'} tone="red" />
          </div>

          <p className="flex items-start gap-2 rounded-xl bg-blue-50/70 px-3 py-2 text-[12px] leading-5 text-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
            <Info size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Точные значения — из базы аккаунтов. DAU/WAU/MAU: {data.activity.definition} Сессия ≠ «онлайн». Ошибки — счётчик процесса с момента запуска, после перезапуска обнуляется. История входов хранится {data.auth.retentionDays} дн.</span>
          </p>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Число аккаунтов" description={`На конец каждого интервала · ${data.periodLabel}`}>
              <TimeChart type="area" labels={labels} axisLabels={axis} caption="Число аккаунтов" series={[{ key: 'total', label: 'Аккаунтов', values: data.series.totalAccounts, color: '--viz-1' }]} />
            </Card>
            <Card title="Новые аккаунты" description="Созданы администраторами или через CLI">
              <TimeChart labels={labels} axisLabels={axis} caption="Новые аккаунты" series={[{ key: 'new', label: 'Новых', values: data.series.newAccounts, color: '--viz-1' }]} emptyText="Новых аккаунтов за период нет" />
            </Card>
            <Card title="Входы" description="Успешные и неудачные попытки входа по паролю">
              <TimeChart
                labels={labels}
                axisLabels={axis}
                caption="Входы"
                series={[
                  { key: 'ok', label: 'Успешные', values: data.series.logins, color: '--viz-1' },
                  { key: 'failed', label: 'Неудачные', values: data.series.failedLogins, color: '--viz-2' },
                ]}
                emptyText="Входов за период не было"
              />
            </Card>
            <Card title="Активные пользователи по дням" description="Уникальные пользователи за сутки (МСК)">
              {data.series.activeUsers ? (
                <TimeChart labels={labels} axisLabels={axis} caption="Активные пользователи по дням" series={[{ key: 'dau', label: 'Пользователей', values: data.series.activeUsers, color: '--viz-1' }]} />
              ) : (
                <EmptyState icon={Info} title="Недоступно для 24 часов" description={data.series.activeUsersNote} />
              )}
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Пользователи по ролям">
              <BarList caption="Пользователи по ролям" items={['user', 'moderator', 'admin', 'superadmin'].map((role) => ({ label: ROLE_LABELS[role], value: data.users.byRole[role] || 0 }))} />
            </Card>
            <Card title="Последние созданные" description="Пять новых аккаунтов" bodyClassName="p-0">
              {data.recentUsers.length === 0 ? <EmptyState title="Пока никого" /> : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.recentUsers.map((user) => (
                    <li key={user.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                      <UserCell user={user} size={30} />
                      <span className="shrink-0 text-[12px] text-slate-500 dark:text-slate-400">{formatRelative(user.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Состояние компонентов" description={data.health ? `Проверено ${formatRelative(data.health.checkedAt)}` : 'Нет данных'}>
              {data.health ? <HealthList components={data.health.components} /> : <EmptyState title="Не удалось получить состояние" />}
            </Card>
          </div>

          {can('audit.view') && (
            <Card title="Последние действия администраторов" actions={<Link to="/admin/audit" className="text-[12.5px] font-semibold text-blue-600 hover:underline dark:text-blue-400">Весь журнал</Link>} bodyClassName="p-0">
              {data.recentAudit?.length ? (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.recentAudit.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                      <span className="w-32 shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(item.at)}</span>
                      <Badge tone={item.result === 'ok' ? 'blue' : 'red'}>{item.actionLabel}</Badge>
                      <span className="text-slate-700 dark:text-slate-200">{item.actor}</span>
                      {item.target && <span className="text-slate-500 dark:text-slate-400">→ {item.targetId ? <Link to={`/admin/users/${item.targetId}`} className="hover:underline">{item.target}</Link> : item.target}</span>}
                      <span className="min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400">{describeAudit(item)}</span>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="Действий пока не было" />}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
