/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Админ-панель → «Интеграции с МИС»: подключённые клиники, тип МИС,
 * состояние, последняя синхронизация, ошибки, справочники, технический
 * журнал без персональных данных. Проверка подключения и синхронизация —
 * с правом integrations.manage. Секреты не показываются.
 */

import { useState } from 'react';
import { PlugZap, RefreshCw, Stethoscope } from 'lucide-react';
import { api, useApi } from '../api';
import { useAdmin } from '../model';
import { Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '../../ui/kit';
import { formatDateTime } from '../../ui/format';
import { useToast } from '../../ui/hooks';

const STATUS = {
  ok: ['emerald', 'работает'],
  new: ['slate', 'ещё не синхронизирована'],
  error: ['red', 'ошибка синхронизации'],
  no_adapter: ['red', 'нет адаптера для этой МИС'],
  simulator_not_allowed: ['amber', 'симулятор не разрешён (MIS_SIMULATOR)'],
  real_booking_off: ['amber', 'настоящая запись выключена (REAL_BOOKING)'],
  secret_missing: ['red', 'не задан секрет'],
  config_error: ['red', 'ошибка конфигурации'],
};
const statusBadge = (status) => {
  const [tone, label] = STATUS[status] || ['slate', status];
  return <Badge tone={tone}>{label}</Badge>;
};
const OP_LABELS = { confirmed: 'подтверждены', pending_reconciliation: 'уточняются', failed: 'не удались', cancelled: 'отменены', booking_pending: 'отправляются', cancel_pending: 'отменяются', completed: 'состоялись' };

function Detail({ id, canManage, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const { data, error, loading, reload } = useApi(() => api.get(`/api/admin/integrations/${encodeURIComponent(id)}`), [id]);
  const act = async (kind) => {
    setBusy(kind);
    try {
      const result = await api.post(`/api/admin/integrations/${encodeURIComponent(id)}/${kind}`, {});
      toast(result.ok ? (kind === 'test' ? `Подключение работает (${result.ms} мс)` : 'Синхронизация выполнена') : `Не получилось: ${result.errorCode}`, result.ok ? 'success' : 'error');
      reload();
      onChanged();
    } catch (actionError) {
      toast(actionError.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (loading && !data) return <Skeleton className="h-40" />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div className="space-y-3" data-testid="admin-integration-detail">
      <div className="flex flex-wrap gap-2">
        {canManage && <Button icon={PlugZap} onClick={() => act('test')} disabled={busy !== null} data-testid="admin-integration-test">{busy === 'test' ? 'Проверяем…' : 'Проверить подключение'}</Button>}
        {canManage && data.running && <Button icon={RefreshCw} onClick={() => act('sync')} disabled={busy !== null} data-testid="admin-integration-sync">{busy === 'sync' ? 'Синхронизируем…' : 'Синхронизировать'}</Button>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-slate-500">Адрес API</dt><dd>{data.config.baseUrl || '—'}</dd>
        <dt className="text-slate-500">Секрет</dt><dd>{data.secretSet === null ? 'не нужен' : data.secretSet ? 'задан в окружении сервера' : 'НЕ задан'}</dd>
        <dt className="text-slate-500">Справочники</dt><dd>филиалов {data.catalog.branch}, врачей {data.catalog.doctor}, услуг {data.catalog.service}</dd>
        <dt className="text-slate-500">Соответствия</dt><dd>{Object.entries(data.stats.mappings).map(([kind, count]) => `${kind}: ${count}`).join(', ') || 'нет'}</dd>
        <dt className="text-slate-500">Записи</dt><dd>{Object.entries(data.stats.ops).map(([state, count]) => `${OP_LABELS[state] || state}: ${count}`).join(', ') || 'нет'}</dd>
      </dl>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Синхронизации</h3>
        {data.runs.length === 0 ? <p className="text-sm text-slate-500">Ещё не было.</p> : (
          <ul className="space-y-1 text-[13px]">
            {data.runs.map((run) => <li key={run.startedAt}>{formatDateTime(run.startedAt)} — {run.ok ? 'успешно' : `ошибка ${run.errorCode}`}{run.counts?.doctors !== undefined ? `, врачей ${run.counts.doctors}` : ''}</li>)}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Технический журнал</h3>
        {data.events.length === 0 ? <p className="text-sm text-slate-500">Пусто.</p> : (
          <ul className="max-h-64 space-y-1 overflow-y-auto text-[13px]" data-testid="admin-integration-events">
            {data.events.map((event, index) => (
              <li key={`${event.at}-${index}`}><Badge tone={event.level === 'error' ? 'red' : event.level === 'warn' ? 'amber' : 'slate'}>{event.code}</Badge> <span className="text-slate-500">{formatDateTime(event.at)}</span> {event.detail}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const { can } = useAdmin();
  const [open, setOpen] = useState(null);
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/integrations'), []);
  if (loading && !data) return <Skeleton className="h-48" />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div className="space-y-4" data-testid="admin-integrations-page">
      <Card>
        <h2 className="text-lg font-bold">Интеграции с МИС клиник</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          Запись к врачу клиники идёт через её МИС только после подключения по официальной документации и проверки на тестовом стенде МИС.
          Подтверждённой запись считается, только когда её подтвердила МИС.
        </p>
        {!data.enabled && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300" data-testid="admin-integrations-off">Интеграции выключены на сервере (MIS_INTEGRATIONS≠on). Работает только демо-запись.</p>}
        {data.enabled && <p className="mt-2 text-xs text-slate-500">Симулятор: {data.flags.simulator ? 'разрешён' : 'нет'} · настоящая запись: {data.flags.realBooking ? 'разрешена' : 'выключена'}</p>}
      </Card>
      {data.enabled && data.integrations.length === 0 && <EmptyState icon={Stethoscope} title="Подключённых клиник нет" description="Интеграция добавляется после получения документации и тестового доступа к МИС клиники." />}
      {data.integrations.map((item) => (
        <Card key={item.id}>
          <div data-testid="admin-integration">
          <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(open === item.id ? null : item.id)}>
            <span><strong>{item.title || item.id}</strong> <span className="text-sm text-slate-500">· {item.misType} · клиника {item.clinicId}</span></span>
            <span className="flex flex-wrap items-center gap-2">
              {statusBadge(item.status)}
              {item.stats.ops.pending_reconciliation ? <Badge tone="amber">уточняются: {item.stats.ops.pending_reconciliation}</Badge> : null}
              {item.stats.errors24h ? <Badge tone="red">ошибок за сутки: {item.stats.errors24h}</Badge> : null}
              <span className="text-xs text-slate-500">синхр.: {item.lastSyncAt ? formatDateTime(item.lastSyncAt) : 'не было'}</span>
            </span>
          </button>
          {open === item.id && <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-700"><Detail id={item.id} canManage={can('integrations.manage')} onChanged={reload} /></div>}
          </div>
        </Card>
      ))}
    </div>
  );
}
