/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Список пользователей: поиск, фильтры, сортировка и страницы — на
 * сервере (в браузер приходит только текущая страница). Фильтры живут в
 * адресе страницы: ссылкой можно поделиться, «Назад» возвращает к ним.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, KeyRound, Lock, Search, ShieldAlert, ShieldCheck, Unlock, UserPlus, Users as UsersIcon } from 'lucide-react';

import { api, queryString, useApi } from '../api';
import { BlockDialog, CreateUserModal, InvitationResultDialog, UserCell } from '../common';
import { useAdmin } from '../model';
import {
  Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, controlClass, inputClass, Pagination, RoleBadge, Skeleton, StatusBadge,
} from '../../ui/kit';
import { formatDateTime, formatRelative, ROLE_LABELS } from '../../ui/format';
import { useToast } from '../../ui/hooks';
import { navigate, useLocation } from '../../ui/navigation';

const DEFAULTS = { q: '', role: '', status: '', kind: 'real', sort: 'createdAt', dir: 'desc', page: '1', pageSize: '25' };

const readQuery = (search) => {
  const params = new URLSearchParams(search);
  return Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, params.get(key) ?? value]));
};

const EMPTY_SELECTION = new Set();

const COLUMNS = [
  { key: 'name', label: 'Пользователь', sortable: true },
  { key: 'role', label: 'Роль', sortable: true },
  { key: 'status', label: 'Статус', sortable: true },
  { key: 'createdAt', label: 'Регистрация', sortable: true },
  { key: 'lastLoginAt', label: 'Последний вход', sortable: true },
  { key: 'lastSeenAt', label: 'Активность', sortable: true },
  { key: 'sessions', label: 'Сессии', sortable: true, align: 'right' },
];

export default function UsersPage() {
  const { me, can } = useAdmin();
  const toast = useToast();
  const { search } = useLocation();
  const query = useMemo(() => readQuery(search), [search]);
  const [text, setText] = useState(query.q);
  // Выделение относится к конкретной выборке: смена фильтров, страницы или поиска его сбрасывает.
  const [selection, setSelection] = useState(() => ({ search, ids: new Set() }));
  const selected = selection.search === search ? selection.ids : EMPTY_SELECTION;
  const setSelected = (update) => setSelection((current) => {
    const ids = current.search === search ? current.ids : EMPTY_SELECTION;
    return { search, ids: typeof update === 'function' ? update(ids) : update };
  });
  const [dialog, setDialog] = useState(null);
  const debounce = useRef(null);

  const setQuery = (patch, { resetPage = true } = {}) => {
    const next = { ...query, ...patch, ...(resetPage ? { page: '1' } : {}) };
    const clean = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== DEFAULTS[key]));
    navigate(`/admin/users${queryString(clean)}`, { replace: true });
  };

  // Поиск из адреса (назад/вперёд, ссылка) — в поле ввода; правится прямо при рендере, без эффекта.
  const [shownQ, setShownQ] = useState(query.q);
  if (shownQ !== query.q) {
    setShownQ(query.q);
    setText(query.q);
  }

  // Ушли со страницы, не дождавшись паузы в наборе, — отложенный поиск не должен вернуть сюда.
  useEffect(() => () => clearTimeout(debounce.current), []);

  const onSearch = (value) => {
    setText(value);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      // Пока ждали паузу, могли уйти в другой раздел (страница ещё не размонтирована
      // из-за ленивой загрузки следующей) — тогда поиск уже не нужен.
      if (window.location.pathname === '/admin/users') setQuery({ q: value.trim() });
    }, 300);
  };

  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/users', query), [search]);
  const items = data?.items || [];

  // Новый порядок — с первой страницы: вторая страница прежнего порядка в новом ничего не значит.
  const toggleSort = (key) => {
    if (query.sort === key) setQuery({ dir: query.dir === 'asc' ? 'desc' : 'asc' });
    else setQuery({ sort: key, dir: key === 'name' || key === 'email' ? 'asc' : 'desc' });
  };

  const selectable = items.filter((user) => !user.isSelf && !user.isDemo);
  const allSelected = selectable.length > 0 && selectable.every((user) => selected.has(user.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((user) => user.id)));
  const toggleOne = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const runBulk = async (action, extra = {}) => {
    const result = await api.post('/api/admin/users/bulk', { action, ids: [...selected], ...extra });
    if (result.failed > 0) {
      const reasons = [...new Set(result.results.filter((item) => !item.ok).map((item) => item.error))].join(' ');
      toast(`Выполнено: ${result.succeeded}, пропущено: ${result.failed}. ${reasons}`, 'warning');
    } else if (action === 'unblock') {
      toast(`Разблокировано: ${result.succeeded}.`);
    }
    setSelected(new Set());
    reload();
  };

  const exportHref = `/api/admin/users/export${queryString({ q: query.q, role: query.role, status: query.status, kind: query.kind, ...(selected.size > 0 ? { ids: [...selected] } : {}) })}`;

  return (
    <div className="space-y-4">
      <Card bodyClassName="p-0">
        <div className="flex flex-wrap items-end gap-2 border-b border-slate-100 p-3 sm:p-4 dark:border-slate-800">
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Поиск по ID, имени или email</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-3 text-slate-400" aria-hidden="true" />
            <input type="search" className={`${inputClass} pl-9`} placeholder="Поиск по ID, имени или email" value={text} onChange={(event) => onSearch(event.target.value)} data-testid="users-search" />
          </label>
          <select className={`${controlClass} max-sm:flex-1`} value={query.role} onChange={(event) => setQuery({ role: event.target.value })} aria-label="Роль" data-testid="users-role-filter">
            <option value="">Все роли</option>
            {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className={`${controlClass} max-sm:flex-1`} value={query.status} onChange={(event) => setQuery({ status: event.target.value })} aria-label="Статус" data-testid="users-status-filter">
            <option value="">Все статусы</option>
            <option value="active">Активные</option>
            <option value="pending">Ожидают активации</option>
            <option value="blocked">Заблокированные</option>
            <option value="archived">В архиве</option>
          </select>
          <div className="flex gap-2">
            {can('users.export') && (
              <a href={exportHref} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 text-[13.5px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200" download data-testid="users-export">
                <Download size={16} aria-hidden="true" />CSV{selected.size > 0 ? ` (${selected.size})` : ''}
              </a>
            )}
            {can('users.create') && <Button variant="primary" icon={UserPlus} onClick={() => setDialog({ type: 'create' })} data-testid="create-user">Создать</Button>}
          </div>
        </div>

        {selected.size > 0 && can('users.block') && (
          <div className="flex flex-wrap items-center gap-2 border-b border-blue-100 bg-blue-50/70 px-4 py-2 text-[13px] dark:border-blue-900 dark:bg-blue-950/40" data-testid="bulk-bar">
            <span className="font-semibold text-blue-900 dark:text-blue-200">Выбрано: {selected.size}</span>
            <Button size="sm" variant="dangerGhost" icon={Lock} onClick={() => setDialog({ type: 'bulk-block' })} data-testid="bulk-block">Заблокировать</Button>
            <Button size="sm" variant="ghost" icon={Unlock} onClick={() => setDialog({ type: 'bulk-unblock' })} data-testid="bulk-unblock">Разблокировать</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Снять выделение</Button>
          </div>
        )}

        {error && !data ? <ErrorState error={error} onRetry={reload} /> : (
          <div className={`overflow-x-auto transition-opacity ${loading && data ? 'opacity-60' : ''}`}>
            <table className="w-full min-w-[860px] text-left text-[13px]" data-testid="users-table">
              <thead className="bg-slate-50 text-[12px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                <tr>
                  <th scope="col" className="w-10 px-4 py-2.5">
                    <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={allSelected} onChange={toggleAll} disabled={selectable.length === 0} aria-label="Выбрать всех на странице" />
                  </th>
                  {COLUMNS.map((column) => (
                    <th key={column.key} scope="col" className={`whitespace-nowrap px-3 py-2.5 font-semibold ${column.align === 'right' ? 'text-right' : ''}`} aria-sort={query.sort === column.key ? (query.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggleSort(column.key)} className="inline-flex items-center gap-1 rounded uppercase hover:text-slate-800 dark:hover:text-white" data-testid={`sort-${column.key}`}>
                        {column.label}
                        {query.sort === column.key && (query.dir === 'asc' ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {!data && loading && Array.from({ length: 6 }, (_, index) => (
                  <tr key={index}><td colSpan={COLUMNS.length + 1} className="px-4 py-3"><Skeleton className="h-8" /></td></tr>
                ))}
                {data && items.length === 0 && (
                  <tr><td colSpan={COLUMNS.length + 1}><EmptyState icon={UsersIcon} title="Никого не нашлось" description="Измените поиск или фильтры." /></td></tr>
                )}
                {items.map((user) => (
                  <tr key={user.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${selected.has(user.id) ? 'bg-blue-50/50 dark:bg-blue-950/30' : ''}`} data-testid="user-row">
                    <td className="px-4 py-2.5">
                      <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={selected.has(user.id)} onChange={() => toggleOne(user.id)} disabled={user.isSelf || user.isDemo} aria-label={`Выбрать ${user.email}`} />
                    </td>
                    <td className="max-w-[300px] px-3 py-2">
                      <UserCell user={user} />
                      <span className="mt-0.5 block font-mono text-[10.5px] text-slate-400">ID {user.id.slice(0, 12)}…{user.isSelf ? ' · это вы' : ''}</span>
                    </td>
                    <td className="px-3 py-2"><RoleBadge role={user.role} short /></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={user.status} until={user.blockedUntil} pending={user.pending} />
                        {user.mustChangePassword && <Badge tone="amber" icon={KeyRound}>Сменит пароль</Badge>}
                        {user.mfa?.enabled && <Badge tone="green" icon={ShieldCheck}>2FA</Badge>}
                        {user.mfa?.required && !user.mfa.enabled && !user.pending && <Badge tone="red" icon={ShieldAlert}>Без 2FA</Badge>}
                        {!user.emailVerified && !user.pending && !user.isDemo && <Badge tone="slate">Email не подтверждён</Badge>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{formatDateTime(user.createdAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : <span className="text-slate-400">не входил</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{formatRelative(user.lastSeenAt)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">{user.activeSessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={(page) => setQuery({ page: String(page) }, { resetPage: false })}
            onPageSize={(pageSize) => setQuery({ pageSize: String(pageSize) })}
          />
        )}
      </Card>

      {dialog?.type === 'create' && (
        <CreateUserModal
          me={me}
          onClose={() => setDialog(null)}
          onCreated={(result) => {
            setDialog({ type: 'invited', result });
            reload();
          }}
        />
      )}
      {dialog?.type === 'invited' && (
        <InvitationResultDialog
          user={dialog.result.user}
          invitation={dialog.result.invitation}
          link={dialog.result.link}
          created
          onClose={() => {
            const { id } = dialog.result.user;
            setDialog(null);
            navigate(`/admin/users/${id}`);
          }}
        />
      )}
      {dialog?.type === 'bulk-block' && (
        <BlockDialog title="Заблокировать выбранных" count={selected.size} onClose={() => setDialog(null)} onConfirm={(options) => runBulk('block', options)} />
      )}
      {dialog?.type === 'bulk-unblock' && (
        <ConfirmDialog title="Разблокировать выбранных?" message={`Выбрано: ${selected.size}. Вход снова станет доступен.`} confirmLabel="Разблокировать" tone="primary" onClose={() => setDialog(null)} onConfirm={() => runBulk('unblock')} />
      )}
    </div>
  );
}
