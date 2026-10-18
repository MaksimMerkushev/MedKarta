/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Настройки без перезапуска: только перечисленные на сервере ключи с
 * проверкой значений (backend/accounts/settings.js). Переменных окружения,
 * ключей API и секретов здесь нет и не будет.
 */
import { useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';

import { api, useApi } from '../api';
import { Badge, Button, Card, ConfirmDialog, ErrorState, inputClass, Skeleton, Toggle } from '../../ui/kit';
import { formatDateTime } from '../../ui/format';
import { useToast } from '../../ui/hooks';

export default function SettingsPage() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi(() => api.get('/api/admin/settings'), []);
  const [draft, setDraft] = useState({});
  const [errors, setErrors] = useState({});
  const [confirm, setConfirm] = useState(false);

  const items = useMemo(() => data?.items || [], [data]);
  const groups = useMemo(() => [...new Set(items.map((item) => item.group))], [items]);
  const value = (item) => (Object.hasOwn(draft, item.key) ? draft[item.key] : item.value);
  const changed = items.filter((item) => Object.hasOwn(draft, item.key) && draft[item.key] !== item.value);

  const set = (key, next) => {
    setDraft((current) => ({ ...current, [key]: next }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  if (error && !data) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;
  const editable = data.canEdit;

  const save = async () => {
    const values = Object.fromEntries(changed.map((item) => [item.key, item.type === 'number' ? Number(draft[item.key]) : draft[item.key]]));
    try {
      const result = await api.patch('/api/admin/settings', { values });
      setData(result);
      setDraft({});
      setErrors({});
      toast(`Сохранено: ${result.changed.length}. Изменения уже действуют.`);
    } catch (failure) {
      if (failure.payload?.errors) setErrors(failure.payload.errors);
      throw failure;
    }
  };

  return (
    <div className={`space-y-5 pb-20 ${loading ? 'opacity-70' : ''}`}>
      {!editable && (
        <p className="rounded-xl bg-slate-100 px-3 py-2 text-[13px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">Только просмотр: менять настройки может суперадминистратор.</p>
      )}
      {groups.map((group) => (
        <Card key={group} title={group}>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.filter((item) => item.group === group).map((item) => (
              <div key={item.key} className="py-3 first:pt-0 last:pb-0" data-testid={`setting-${item.key}`}>
                {item.type === 'boolean' ? (
                  <Toggle checked={Boolean(value(item))} disabled={!editable} onChange={(next) => set(item.key, next)} label={item.label} description={item.description} />
                ) : (
                  <label className="block">
                    <span className="block text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">{item.label}</span>
                    {item.description && <span className="mt-0.5 block text-[12px] text-slate-500 dark:text-slate-400">{item.description}</span>}
                    {item.type === 'textarea' ? (
                      <textarea className={`${inputClass} mt-1.5 min-h-[72px]`} disabled={!editable} maxLength={280} value={value(item) ?? ''} onChange={(event) => set(item.key, event.target.value)} />
                    ) : (
                      <input
                        className={`${inputClass} mt-1.5 ${item.type === 'number' ? 'max-w-[140px]' : ''}`}
                        type={item.type === 'number' ? 'number' : 'text'}
                        disabled={!editable}
                        value={value(item) ?? ''}
                        onChange={(event) => set(item.key, item.type === 'number' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value)}
                        data-testid={`setting-input-${item.key}`}
                      />
                    )}
                  </label>
                )}
                {errors[item.key] && <p className="mt-1 text-[12px] text-red-600 dark:text-red-400" role="alert">{errors[item.key]}</p>}
                <p className="mt-1 flex flex-wrap gap-2 text-[11.5px] text-slate-400">
                  <span className="font-mono">{item.key}</span>
                  {item.public && <Badge tone="blue">видно всем</Badge>}
                  {item.customized ? <span>изменено {formatDateTime(item.updatedAt)}</span> : <span>по умолчанию</span>}
                  {item.customized && <span>по умолчанию: {JSON.stringify(item.defaultValue)}</span>}
                </p>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {editable && (
        <div className="sticky bottom-0 -mx-3 flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 dark:border-slate-800 dark:bg-slate-900/95">
          <span className="mr-auto text-[13px] text-slate-500 dark:text-slate-400">{changed.length > 0 ? `Изменено: ${changed.length}` : 'Изменений нет'}</span>
          <Button icon={RotateCcw} disabled={changed.length === 0} onClick={() => {
            setDraft({});
            setErrors({});
          }}>Отменить</Button>
          <Button variant="primary" icon={Save} disabled={changed.length === 0} onClick={() => setConfirm(true)} data-testid="settings-save">Сохранить</Button>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title="Сохранить настройки?"
          message={`Изменения (${changed.map((item) => item.label).join(', ')}) подействуют сразу и попадут в журнал действий.`}
          confirmLabel="Сохранить"
          tone="primary"
          onClose={() => setConfirm(false)}
          onConfirm={save}
        />
      )}
    </div>
  );
}
