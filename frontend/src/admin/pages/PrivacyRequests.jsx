/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Обращения субъектов персональных данных (ст. 14, 20, 21 152-ФЗ).
 * Право privacy.requests: взять в работу, продлить срок (один раз, с
 * причиной, которую увидит заявитель), выполнить или отказать (ответ
 * обязателен). Само обращение данные не меняет: исправление, удаление
 * аккаунта и т. п. — штатными средствами, здесь фиксируется итог.
 * Порядок — docs/privacy/06-subject-requests.md.
 */
import { useId, useState } from 'react';
import { AlertTriangle, Inbox } from 'lucide-react';

import { api, useApi } from '../api';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Modal, Pagination, SelectInput, Skeleton, inputClass } from '../../ui/kit';
import { formatDateTime } from '../../ui/format';
import { useToast } from '../../ui/hooks';
import { Link } from '../../ui/router';

const STATUS_OPTIONS = [
  { value: '', label: 'Все' },
  { value: 'received', label: 'Получено' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'completed', label: 'Выполнено' },
  { value: 'rejected', label: 'Отказано' },
];
const STATUS_TONES = { received: 'blue', in_progress: 'amber', completed: 'green', rejected: 'red' };
const ACTION_TITLES = {
  extend: 'Продлить срок ответа',
  complete: 'Обращение выполнено',
  reject: 'Отказать',
};
const ACTION_HINTS = {
  extend: 'Срок продлевается на 5 рабочих дней один раз; причину увидит заявитель (ч. 3 ст. 14, ч. 5.1 ст. 21).',
  complete: 'Опишите, что сделано. Ответ увидит заявитель в профиле; на почту придёт только уведомление.',
  reject: 'Мотивированный отказ со ссылкой на основание (например, ч. 8 ст. 14 или иной федеральный закон).',
};

function RequestDialog({ id, onClose, onChanged }) {
  const toast = useToast();
  const textId = useId();
  const { data, error, loading, reload } = useApi(() => api.get(`/api/admin/privacy-requests/${id}`), [id]);
  const [action, setAction] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (name, body = {}) => {
    setBusy(true);
    try {
      await api.post(`/api/admin/privacy-requests/${id}/${name}`, body);
      toast(name === 'take' ? 'Обращение взято в работу.' : 'Сохранено. Заявителю отправлено уведомление.');
      setAction(null);
      setText('');
      reload();
      onChanged();
    } catch (failure) {
      toast(failure.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const request = data?.request;
  const open = request && ['received', 'in_progress'].includes(request.status);
  return (
    <Modal title="Обращение по персональным данным" onClose={onClose} busy={busy} size="lg">
      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {!data && loading && <Skeleton className="h-24" />}
      {request && (
        <div className="space-y-4 text-[13.5px]" data-testid="privacy-request-detail">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONES[request.status] || 'slate'}>{request.statusLabel}</Badge>
            {request.overdue && <Badge tone="red" icon={AlertTriangle}>Срок прошёл</Badge>}
            <span className="font-semibold text-slate-800 dark:text-white">{request.typeLabel}</span>
          </div>
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-slate-600 dark:text-slate-300">
            <dt className="text-slate-500">Заявитель</dt>
            <dd>
              {data.subject.exists
                ? <Link to={`/admin/users/${data.subject.id}`} className="text-blue-700 hover:underline dark:text-blue-300">{data.subject.label}</Link>
                : <span>{data.subject.label || '—'} (аккаунт удалён)</span>}
            </dd>
            <dt className="text-slate-500">Получено</dt>
            <dd>{formatDateTime(request.createdAt)}</dd>
            <dt className="text-slate-500">Ответить до</dt>
            <dd>{formatDateTime(request.dueAt)}{request.extendedAt ? ` (продлён: ${request.extensionReason})` : ''}</dd>
            {request.handledBy && (
              <>
                <dt className="text-slate-500">Сотрудник</dt>
                <dd>{request.handledBy}</dd>
              </>
            )}
          </dl>
          {request.message && <p className="whitespace-pre-line rounded-xl bg-slate-50 px-3 py-2 text-slate-700 dark:bg-slate-800/60 dark:text-slate-200">{request.message}</p>}
          {request.response && (
            <div>
              <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-500">Ответ</p>
              <p className="whitespace-pre-line rounded-xl bg-emerald-50 px-3 py-2 text-slate-700 dark:bg-emerald-950/40 dark:text-slate-200">{request.response}</p>
            </div>
          )}
          {data.consents.length > 0 && (
            <details className="rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-800">
              <summary className="cursor-pointer font-semibold text-slate-700 dark:text-slate-200">Журнал согласий заявителя ({data.consents.length})</summary>
              <ul className="mt-2 space-y-1 text-[12.5px] text-slate-600 dark:text-slate-300">
                {data.consents.map((item) => (
                  <li key={item.id}>{formatDateTime(item.at)} — {item.purpose} {item.version ? `(${item.version})` : ''}: {item.action}, {item.method}</li>
                ))}
              </ul>
            </details>
          )}
          {open && !action && (
            <div className="flex flex-wrap gap-2">
              {request.status === 'received' && <Button size="sm" variant="primary" loading={busy} onClick={() => run('take')} data-testid="privacy-take">Взять в работу</Button>}
              {data.deadline?.extension > 0 && !request.extendedAt && <Button size="sm" onClick={() => setAction('extend')}>Продлить срок</Button>}
              <Button size="sm" variant="primary" onClick={() => setAction('complete')} data-testid="privacy-complete">Выполнено</Button>
              <Button size="sm" variant="dangerGhost" onClick={() => setAction('reject')}>Отказать</Button>
            </div>
          )}
          {action && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                run(action, action === 'extend' ? { reason: text.trim() } : { response: text.trim() });
              }}
            >
              <Field label={ACTION_TITLES[action]} htmlFor={textId} hint={ACTION_HINTS[action]}>
                <textarea id={textId} className={`${inputClass} min-h-[110px]`} value={text} maxLength={action === 'extend' ? 500 : 4000} onChange={(event) => setText(event.target.value)} data-testid="privacy-action-text" />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" variant={action === 'reject' ? 'danger' : 'primary'} loading={busy} disabled={text.trim().length < 10} data-testid="privacy-action-submit">Сохранить</Button>
                <Button size="sm" onClick={() => setAction(null)} disabled={busy}>Отмена</Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function PrivacyRequestsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const { data, error, loading, reload } = useApi(() => api.get('/api/admin/privacy-requests', { status, page }), [status, page]);

  return (
    <Card
      title="Обращения по персональным данным"
      description="Запросы сведений, исправления, прекращения обработки и удаления. Срок — 10 рабочих дней (+5 с причиной), исправление и удаление — 7 рабочих дней."
      actions={<div className="w-44"><SelectInput label="" value={status} options={STATUS_OPTIONS} onChange={(event) => {
        setStatus(event.target.value);
        setPage(1);
      }} aria-label="Статус" /></div>}
      bodyClassName="p-0"
    >
      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {!data && loading && <div className="space-y-2 p-4"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>}
      {data && data.items.length === 0 && <EmptyState icon={Inbox} title="Обращений нет" />}
      {data && data.items.length > 0 && (
        <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
          <table className="w-full min-w-[760px] text-left text-[13px]" data-testid="privacy-requests-table">
            <thead className="bg-slate-50 text-[12px] uppercase tracking-wide text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-semibold">Заявитель</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Вид</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Статус</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Получено</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Ответить до</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {data.items.map((item) => (
                <tr key={item.id} className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40" onClick={() => setSelected(item.id)}>
                  <td className="px-4 py-2.5">
                    <button type="button" className="text-left font-medium text-blue-700 hover:underline dark:text-blue-300" onClick={() => setSelected(item.id)}>{item.subject || '—'}</button>
                  </td>
                  <td className="px-3 py-2.5 text-slate-700 dark:text-slate-200">{item.typeLabel}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={STATUS_TONES[item.status] || 'slate'}>{item.statusLabel}</Badge>
                    {item.overdue && <Badge tone="red" className="ml-1">просрочено</Badge>}
                  </td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-500">{formatDateTime(item.createdAt)}</td>
                  <td className="px-3 py-2.5 tabular-nums text-slate-500">{formatDateTime(item.dueAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-slate-100 px-4 py-2 dark:border-slate-800">
            <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} sizes={[data.pageSize]} onPageSize={() => {}} />
          </div>
        </div>
      )}
      {selected && <RequestDialog id={selected} onClose={() => setSelected(null)} onChanged={reload} />}
    </Card>
  );
}
