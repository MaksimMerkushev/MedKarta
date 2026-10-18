/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Состояние приложения: компоненты, процесс, запросы, справочники. Только
 * то, что безопасно показать: ни переменных окружения, ни ключей, ни
 * внутренних адресов. Кнопок перезапуска и выполнения команд нет намеренно.
 */
import { RefreshCw } from 'lucide-react';

import { api, useApi } from '../api';
import { TimeChart } from '../charts';
import { HealthList } from './Dashboard';
import { Button, Card, ErrorState, Skeleton } from '../../ui/kit';
import { formatDateTime, formatNumber, formatRelative } from '../../ui/format';

const uptime = (seconds) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days} д` : '', hours ? `${hours} ч` : '', `${minutes} мин`].filter(Boolean).join(' ');
};

const bytes = (value) => (value === null || value === undefined ? '—' : value > 1048576 ? `${(value / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(value / 1024))} КБ`);

function Stat({ label, value }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-[13px]">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="text-right font-semibold text-slate-800 dark:text-slate-100">{value}</span>
    </div>
  );
}

export default function SystemPage() {
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/system'), []);
  if (error && !data) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (!data) return <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-64 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;

  const { process: info, requests, data: catalogs } = data;
  const hourLabels = requests.perHour.map((item) => new Date(item.start).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const hourAxis = requests.perHour.map((item) => new Date(item.start).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }));

  return (
    <div className={`space-y-5 ${loading ? 'opacity-70' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12.5px] text-slate-500 dark:text-slate-400">Проверено {formatDateTime(data.checkedAt, { seconds: true })} (МСК)</p>
        <Button size="sm" icon={RefreshCw} onClick={reload} loading={loading}>Обновить</Button>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Компоненты">
          <HealthList components={data.components} />
        </Card>
        <Card title="Процесс">
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            <Stat label="Версия приложения" value={info.appVersion || '—'} />
            <Stat label="Коммит" value={info.commit ? <span className="font-mono">{info.commit}</span> : 'не определён'} />
            <Stat label="Node.js" value={info.nodeVersion} />
            <Stat label="Окружение" value={info.environment} />
            <Stat label="Демо-режим" value={info.demoMode ? 'включён' : 'выключен'} />
            <Stat label="Запущен" value={`${formatDateTime(info.startedAt)} · ${uptime(info.uptimeSeconds)}`} />
            <Stat label="Память (RSS / heap)" value={`${info.memoryMb.rss} / ${info.memoryMb.heapUsed} МБ`} />
          </div>
        </Card>
      </div>

      <Card title="Запросы" description={`С запуска процесса (${formatRelative(requests.since)}); после перезапуска счётчики обнуляются. Задержка — по последним 500 запросам группы.`}>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-950"><p className="text-[12px] text-slate-500">Всего</p><p className="text-[22px] font-extrabold text-slate-800 dark:text-white">{formatNumber(requests.total)}</p></div>
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-950"><p className="text-[12px] text-slate-500">Ошибки сервера 5xx</p><p className="text-[22px] font-extrabold text-slate-800 dark:text-white">{formatNumber(requests.errors5xx)}</p></div>
          <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-950"><p className="text-[12px] text-slate-500">Ответы 4xx</p><p className="text-[22px] font-extrabold text-slate-800 dark:text-white">{formatNumber(requests.errors4xx)}</p></div>
        </div>
        <TimeChart
          labels={hourLabels}
          axisLabels={hourAxis}
          caption="Запросы по часам"
          height={180}
          series={[
            { key: 'count', label: 'Запросы', values: requests.perHour.map((item) => item.count), color: '--viz-1' },
            { key: 'errors', label: 'Ошибки 5xx', values: requests.perHour.map((item) => item.errors), color: '--viz-2' },
          ]}
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="text-[12px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <tr>
                <th scope="col" className="py-2 font-semibold">Группа</th>
                <th scope="col" className="py-2 text-right font-semibold">Запросов</th>
                <th scope="col" className="py-2 text-right font-semibold">2xx</th>
                <th scope="col" className="py-2 text-right font-semibold">4xx</th>
                <th scope="col" className="py-2 text-right font-semibold">5xx</th>
                <th scope="col" className="py-2 text-right font-semibold">Средняя, мс</th>
                <th scope="col" className="py-2 text-right font-semibold">p50 / p95, мс</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
              {requests.groups.map((group) => (
                <tr key={group.group}>
                  <td className="py-1.5 text-slate-700 dark:text-slate-200">{group.group}</td>
                  <td className="py-1.5 text-right">{formatNumber(group.count)}</td>
                  <td className="py-1.5 text-right">{formatNumber(group.status['2xx'])}</td>
                  <td className="py-1.5 text-right">{formatNumber(group.status['4xx'])}</td>
                  <td className="py-1.5 text-right">{formatNumber(group.status['5xx'])}</td>
                  <td className="py-1.5 text-right">{group.avgMs ?? '—'}</td>
                  <td className="py-1.5 text-right">{group.p50Ms} / {group.p95Ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.counters.length > 0 && (
          <div className="mt-4">
            <p className="mb-1 text-[12.5px] font-semibold text-slate-500 dark:text-slate-400">Счётчики сбоев и отказов</p>
            <ul className="grid gap-x-6 text-[12.5px] sm:grid-cols-2">
              {data.counters.map((counter) => (
                <li key={counter.key} className="flex justify-between gap-2 border-b border-slate-100 py-1 dark:border-slate-800">
                  <span className="truncate font-mono text-slate-600 dark:text-slate-300">{counter.key}</span>
                  <span className="tabular-nums font-semibold">{formatNumber(counter.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Справочники" description="Число записей в загруженных справочниках ассистента и карты.">
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            <Stat label="Врачи (справочник ассистента)" value={catalogs.catalog ? formatNumber(catalogs.catalog.doctors) : 'не загружен'} />
            <Stat label="Клиники и учреждения" value={catalogs.catalog ? formatNumber(catalogs.catalog.clinics) : '—'} />
            <Stat label="Специальности" value={catalogs.catalog ? formatNumber(catalogs.catalog.specialties) : '—'} />
            {catalogs.demo && <Stat label="Демо-набор" value={`${catalogs.demo.clinics} клиник, ${catalogs.demo.branches} филиалов, ${catalogs.demo.doctors} врачей`} />}
            <Stat label="Источников сборщика" value={catalogs.sources ?? '—'} />
            <Stat label="Собранный справочник" value={catalogs.collectedCounts ? `${catalogs.collectedCounts.clinics} клиник, ${catalogs.collectedCounts.doctors} врачей, ${catalogs.collectedCounts.prices} цен` : 'нет'} />
            <Stat label="Последняя проверка данных" value={catalogs.verifiedAt ? formatDateTime(catalogs.verifiedAt) : 'не проводилась'} />
            <Stat label="Проверка собранного справочника" value={catalogs.collectedVerifiedAt ? formatDateTime(catalogs.collectedVerifiedAt) : 'не проводилась'} />
          </div>
        </Card>
        <Card title="Файлы данных" description="Время изменения файла на сервере — обычно время выпуска версии." bodyClassName="p-0">
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {catalogs.files.map((file) => (
              <li key={file.file} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-[13px]">
                <span>
                  <span className="block text-slate-700 dark:text-slate-200">{file.label}</span>
                  <span className="block font-mono text-[11px] text-slate-400">{file.file}</span>
                </span>
                <span className="text-right text-slate-500 dark:text-slate-400">{file.exists ? `${bytes(file.bytes)} · ${formatDateTime(file.modifiedAt)}` : 'нет файла'}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
