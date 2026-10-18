/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Активные сессии. «Последняя активность» — время последнего запроса с
 * сессией, а не признак «онлайн»: механизма присутствия нет.
 */
import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';

import { api, useApi } from '../api';
import { UserCell } from '../common';
import { useAdmin } from '../model';
import { Badge, Button, Card, EmptyState, ErrorState, Pagination, RoleBadge, Skeleton, Toggle } from '../../ui/kit';
import { formatDateTime, formatRelative } from '../../ui/format';
import { useToast } from '../../ui/hooks';

export default function SessionsPage() {
  const { me } = useAdmin();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(null);
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/sessions', { page, pageSize, userId: mine ? me.user.id : undefined }), [page, pageSize, mine]);

  const revoke = async (session) => {
    setBusy(session.id);
    try {
      await api.del(`/api/admin/sessions/${session.id}`, {});
      toast(session.own ? 'Ваша сессия завершена.' : 'Сессия завершена.');
      reload();
    } catch (failure) {
      toast(failure.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Активные сессии"
      description="Создание, последняя активность и срок. Активность ≠ «онлайн»: это время последнего запроса."
      actions={<div className="w-56"><Toggle checked={mine} onChange={(value) => {
        setMine(value);
        setPage(1);
      }} label="Только мои" /></div>}
      bodyClassName="p-0"
    >
      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {!data && loading && <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
      {data && data.items.length === 0 && <EmptyState icon={MonitorSmartphone} title="Активных сессий нет" />}
      {data && data.items.length > 0 && (
        <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full min-w-[860px] text-left text-[13px]" data-testid="sessions-table">
            <thead className="bg-slate-50 text-[12px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Пользователь</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Устройство</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Создана</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Активность</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Истекает</th>
                <th scope="col" className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.items.map((session) => (
                <tr key={session.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <UserCell user={session.user} size={28} />
                      <RoleBadge role={session.user.role} short />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                    {session.client}
                    {session.network && <span className="block font-mono text-[11px] text-slate-400">{session.network}</span>}
                    {session.own && <Badge tone="violet" className="mt-0.5">Ваша</Badge>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{formatDateTime(session.createdAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{formatRelative(session.lastSeenAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300">{formatDateTime(session.expiresAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="dangerGhost" loading={busy === session.id} disabled={!session.canRevoke} onClick={() => revoke(session)} title={session.canRevoke ? '' : 'Аккаунт с такой же или более высокой ролью'}>Завершить</Button>
                  </td>
                </tr>
              ))}
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
