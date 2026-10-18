/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Журнал административных действий: фильтры, поиск, сортировка по
 * времени, страницы — на сервере. Паролей, токенов и запросов к
 * ассистенту в журнале нет; email — маской.
 */
import { Fragment, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, FileClock, Search } from 'lucide-react';

import { api, useApi } from '../api';
import { describeAudit } from '../model';
import { Badge, Card, EmptyState, ErrorState, controlClass, inputClass, Pagination, Skeleton } from '../../ui/kit';
import { formatDateTime } from '../../ui/format';
import { Link } from '../../ui/router';

const RESULT = { ok: ['green', 'Выполнено'], denied: ['red', 'Отклонено'], failed: ['amber', 'Ошибка'] };

export default function AuditPage() {
  const [filters, setFilters] = useState({ action: '', result: '', q: '', from: '', to: '' });
  const [text, setText] = useState('');
  const [dir, setDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [open, setOpen] = useState(null);
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/audit', { ...filters, sort: 'at', dir, page, pageSize }), [filters, dir, page, pageSize]);

  const update = (patch) => {
    setFilters((current) => (Object.entries(patch).every(([key, value]) => current[key] === value) ? current : { ...current, ...patch }));
    setPage(1);
  };

  return (
    <Card bodyClassName="p-0">
      <form className="flex flex-wrap items-end gap-2 border-b border-slate-100 p-3 sm:p-4 dark:border-slate-800" onSubmit={(event) => {
        event.preventDefault();
        update({ q: text.trim() });
      }}>
        <label className="relative min-w-[200px] flex-1">
          <span className="sr-only">Поиск по администратору, пользователю или действию</span>
          <Search size={16} className="pointer-events-none absolute left-3 top-3 text-slate-400" aria-hidden="true" />
          <input type="search" className={`${inputClass} pl-9`} placeholder="Кто, над кем, действие — Enter" value={text} onChange={(event) => setText(event.target.value)} onBlur={() => update({ q: text.trim() })} data-testid="audit-search" />
        </label>
        <select className={`${controlClass} max-sm:flex-1`} value={filters.action} onChange={(event) => update({ action: event.target.value })} aria-label="Тип действия" data-testid="audit-action">
          <option value="">Все действия</option>
          {(data?.actions || []).map((action) => <option key={action.key} value={action.key}>{action.label}</option>)}
        </select>
        <select className={`${controlClass} max-sm:flex-1`} value={filters.result} onChange={(event) => update({ result: event.target.value })} aria-label="Результат">
          <option value="">Любой результат</option>
          <option value="ok">Выполнено</option>
          <option value="denied">Отклонено</option>
        </select>
        <label className="text-[12px] font-semibold text-slate-500 max-sm:flex-1 dark:text-slate-400">
          С
          <input type="date" className={`${controlClass} mt-0.5 block font-normal max-sm:w-full`} value={filters.from} onChange={(event) => update({ from: event.target.value })} />
        </label>
        <label className="text-[12px] font-semibold text-slate-500 max-sm:flex-1 dark:text-slate-400">
          По
          <input type="date" className={`${controlClass} mt-0.5 block font-normal max-sm:w-full`} value={filters.to} onChange={(event) => update({ to: event.target.value })} />
        </label>
      </form>

      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {!data && loading && <div className="space-y-2 p-4">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-8" />)}</div>}
      {data && data.items.length === 0 && <EmptyState icon={FileClock} title="Записей не найдено" description="Измените фильтры или период." />}
      {data && data.items.length > 0 && (
        <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full min-w-[900px] text-left text-[13px]" data-testid="audit-table">
            <thead className="bg-slate-50 text-[12px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                <th scope="col" className="w-8 px-2 py-2.5" />
                <th scope="col" className="px-3 py-2.5 font-semibold" aria-sort={dir === 'asc' ? 'ascending' : 'descending'}>
                  <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}>
                    Время {dir === 'asc' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}
                  </button>
                </th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Действие</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Инициатор</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Цель</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Результат</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Подробности</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.items.map((item) => {
                const [tone, label] = RESULT[item.result] || RESULT.failed;
                const expanded = open === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-2 py-2">
                        <button type="button" onClick={() => setOpen(expanded ? null : item.id)} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-expanded={expanded} aria-label="Технические сведения">
                          {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">{formatDateTime(item.at, { seconds: true })}</td>
                      <td className="px-3 py-2"><Badge tone="blue">{item.actionLabel}</Badge></td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{item.actorId ? <Link to={`/admin/users/${item.actorId}`} className="hover:underline">{item.actor}</Link> : item.actor}</td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{item.targetId ? <Link to={`/admin/users/${item.targetId}`} className="hover:underline">{item.target}</Link> : item.target || '—'}</td>
                      <td className="px-3 py-2"><Badge tone={tone}>{label}</Badge></td>
                      <td className="max-w-[320px] px-3 py-2 text-slate-500 dark:text-slate-400">{describeAudit(item)}</td>
                    </tr>
                    {expanded && (
                      <tr className="bg-slate-50/60 dark:bg-slate-900/40">
                        <td />
                        <td colSpan={6} className="px-3 py-2">
                          <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                            <div><dt className="inline text-slate-500">ID события: </dt><dd className="inline font-mono">{item.id}</dd></div>
                            <div><dt className="inline text-slate-500">Код действия: </dt><dd className="inline font-mono">{item.action}</dd></div>
                            {item.actorId && <div><dt className="inline text-slate-500">ID инициатора: </dt><dd className="inline font-mono">{item.actorId}</dd></div>}
                            {item.targetId && <div><dt className="inline text-slate-500">ID цели: </dt><dd className="inline font-mono">{item.targetId}</dd></div>}
                          </dl>
                          {item.details && <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-white p-2 font-mono text-[11.5px] text-slate-600 dark:bg-slate-950 dark:text-slate-300">{JSON.stringify(item.details, null, 2)}</pre>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} onPageSize={(size) => {
        setPageSize(size);
        setPage(1);
      }} />}
    </Card>
  );
}
