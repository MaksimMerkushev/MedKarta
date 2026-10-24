/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Роли и права: матрица разрешений, настройка admin и moderator
 * (superadmin), журнал изменений ролей. Разрешения и правила конфликтов
 * определены на сервере (backend/accounts/rbac.js); здесь — та же проверка
 * для подсказки до сохранения.
 */
import { Fragment, useMemo, useState } from 'react';
import { AlertTriangle, Lock, RotateCcw, Save, ShieldCheck } from 'lucide-react';

import { api, useApi } from '../api';
import { describeAudit } from '../model';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, RoleBadge, Skeleton } from '../../ui/kit';
import { formatDateTime, formatNumber } from '../../ui/format';
import { useToast } from '../../ui/hooks';
import { Link } from '../../ui/router';

/** Конфликты набора — те же правила, что checkRolePermissions на сервере. */
const localConflicts = (role, set, permissions) => {
  const errors = [];
  const byKey = new Map(permissions.map((item) => [item.key, item]));
  for (const key of set) {
    const meta = byKey.get(key);
    if (!meta) continue;
    if (meta.superadminOnly && role !== 'superadmin') errors.push(`«${meta.label}» — только суперадминистратору.`);
    for (const required of meta.requires) {
      if (!set.has(required)) errors.push(`«${meta.label}» требует «${byKey.get(required)?.label}».`);
    }
    if (key !== 'admin.access' && !set.has('admin.access')) errors.push(`«${meta.label}» бесполезно без входа в панель.`);
  }
  return [...new Set(errors)];
};

export default function RolesPage() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi(() => api.get('/api/admin/roles'), []);
  const changes = useApi(async () => {
    const [roles, assignments] = await Promise.all([
      api.get('/api/admin/audit', { action: 'roles.update', pageSize: 10 }).catch(() => ({ items: [] })),
      api.get('/api/admin/audit', { action: 'user.role', pageSize: 10 }).catch(() => ({ items: [] })),
    ]);
    return [...roles.items, ...assignments.items].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 15);
  }, []);
  const [draft, setDraft] = useState({});
  const [confirm, setConfirm] = useState(null);

  const roles = useMemo(() => data?.roles || [], [data]);
  const current = (role) => draft[role.key] || new Set(role.permissions);
  const dirty = (role) => Boolean(draft[role.key]) && (draft[role.key].size !== role.permissions.length || role.permissions.some((key) => !draft[role.key].has(key)));

  const toggle = (role, key) => {
    setDraft((previous) => {
      const set = new Set(previous[role.key] || role.permissions);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...previous, [role.key]: set };
    });
  };

  if (error && !data) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (!data) return <Skeleton className="h-96 rounded-2xl" />;

  const groups = [...new Set(data.permissions.map((item) => item.group))];
  const editable = roles.filter((role) => role.editable && data.canEdit);

  return (
    <div className={`space-y-5 ${loading ? 'opacity-70' : ''}`}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {roles.map((role) => (
          <div key={role.key} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between gap-2">
              <RoleBadge role={role.key} />
              {role.customized && <Badge tone="violet">Настроена</Badge>}
              {!role.editable && <Lock size={14} className="text-slate-400" aria-label="Системная роль" />}
            </div>
            <p className="mt-2 text-[12.5px] leading-5 text-slate-500 dark:text-slate-400">{role.description}</p>
            <p className="mt-2 text-[13px] text-slate-700 dark:text-slate-200">
              Пользователей: <b>{formatNumber(role.users.total)}</b> (активных {formatNumber(role.users.active)}) · разрешений: <b>{role.permissions.length}</b>
            </p>
            {role.conflicts.length > 0 && <p className="mt-2 text-[12px] text-red-600 dark:text-red-400">{role.conflicts[0]}</p>}
            {role.warnings.length > 0 && <p className="mt-2 flex gap-1 text-[12px] text-amber-700 dark:text-amber-300"><AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{role.warnings[0]}</p>}
          </div>
        ))}
      </div>

      <p className="flex items-start gap-2 rounded-xl bg-slate-100 px-3 py-2 text-[12.5px] leading-5 text-slate-600 dark:bg-slate-900 dark:text-slate-300">
        <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Права проверяет сервер. Роль назначается в карточке пользователя. Менять можно только аккаунты ниже своей роли; суперадминистратор — любые, кроме своего.
          Активных суперадминистраторов: <b>{data.superadmins}</b> — последнего нельзя понизить, заблокировать, архивировать или удалить.
        </span>
      </p>

      <Card
        title="Матрица разрешений"
        description={data.canEdit ? 'Настраиваются роли «Администратор» и «Модератор». ⚠ — опасное разрешение, 🔒 — только суперадминистратору.' : 'Только просмотр: менять матрицу может суперадминистратор.'}
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[13px]" data-testid="permission-matrix">
            <thead className="bg-slate-50 text-[12px] text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">Разрешение</th>
                {roles.map((role) => <th key={role.key} scope="col" className="w-36 px-3 py-2.5 text-center font-semibold">{role.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group}>
                  <tr className="bg-slate-50/60 dark:bg-slate-900/40">
                    <th colSpan={roles.length + 1} scope="colgroup" className="px-4 py-1.5 text-left text-[11.5px] font-bold uppercase tracking-wider text-slate-400">{group}</th>
                  </tr>
                  {data.permissions.filter((item) => item.group === group).map((permission) => (
                    <tr key={permission.key} className="border-t border-slate-100 dark:border-slate-800">
                      <th scope="row" className="px-4 py-2 text-left font-normal">
                        <span className="flex items-center gap-1.5 text-slate-700 dark:text-slate-200">
                          {permission.label}
                          {permission.danger && <AlertTriangle size={13} className="text-amber-600 dark:text-amber-400" aria-label="Опасное разрешение" />}
                          {permission.superadminOnly && <Lock size={13} className="text-violet-600 dark:text-violet-400" aria-label="Только суперадминистратору" />}
                        </span>
                        <span className="font-mono text-[11px] text-slate-400">{permission.key}</span>
                      </th>
                      {roles.map((role) => {
                        const set = current(role);
                        const canToggle = role.editable && data.canEdit && !permission.superadminOnly;
                        return (
                          <td key={role.key} className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-blue-600 disabled:opacity-60"
                              checked={set.has(permission.key)}
                              disabled={!canToggle}
                              onChange={() => toggle(role, permission.key)}
                              aria-label={`${role.label}: ${permission.label}`}
                              data-testid={`perm-${role.key}-${permission.key}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {editable.length > 0 && (
          <div className="grid gap-3 border-t border-slate-100 p-4 sm:grid-cols-2 dark:border-slate-800">
            {editable.map((role) => {
              const set = current(role);
              const conflicts = localConflicts(role.key, set, data.permissions);
              return (
                <div key={role.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-800">
                  <p className="text-[13px] font-bold text-slate-700 dark:text-slate-200">{role.label}</p>
                  {conflicts.length > 0 && <ul className="mt-1 list-disc pl-5 text-[12px] text-red-600 dark:text-red-400">{conflicts.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" icon={Save} disabled={!dirty(role) || conflicts.length > 0} onClick={() => setConfirm({ type: 'save', role })} data-testid={`save-role-${role.key}`}>Сохранить</Button>
                    {dirty(role) && <Button size="sm" variant="ghost" onClick={() => setDraft((previous) => ({ ...previous, [role.key]: undefined }))}>Отменить</Button>}
                    {role.customized && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setConfirm({ type: 'reset', role })}>По умолчанию</Button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Журнал изменений ролей" description="Назначения ролей и изменения матрицы" bodyClassName="p-0">
        {changes.data?.length === 0 && <EmptyState title="Изменений пока не было" />}
        {changes.data?.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {changes.data.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <span className="w-36 shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(item.at)}</span>
                <Badge tone={item.result === 'ok' ? 'violet' : 'red'}>{item.actionLabel}</Badge>
                <span className="text-slate-700 dark:text-slate-200">{item.actor}</span>
                {item.target && <span className="text-slate-500 dark:text-slate-400">→ {item.targetId ? <Link to={`/admin/users/${item.targetId}`} className="hover:underline">{item.target}</Link> : item.target}</span>}
                <span className="text-slate-500 dark:text-slate-400">{describeAudit(item)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {confirm?.type === 'save' && (
        <ConfirmDialog
          title={`Сохранить разрешения роли «${confirm.role.label}»?`}
          message="Изменения подействуют сразу на всех пользователей с этой ролью, без повторного входа."
          confirmLabel="Сохранить"
          tone="primary"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const result = await api.put(`/api/admin/roles/${confirm.role.key}`, { permissions: [...current(confirm.role)] });
            setData(result);
            setDraft((previous) => ({ ...previous, [confirm.role.key]: undefined }));
            toast(result.warnings?.length ? `Сохранено. ${result.warnings[0]}` : 'Разрешения сохранены.', result.warnings?.length ? 'warning' : 'success');
            changes.reload();
          }}
        />
      )}
      {confirm?.type === 'reset' && (
        <ConfirmDialog
          title={`Вернуть разрешения «${confirm.role.label}» по умолчанию?`}
          confirmLabel="Вернуть"
          tone="primary"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            setData(await api.post(`/api/admin/roles/${confirm.role.key}/reset`, {}));
            setDraft((previous) => ({ ...previous, [confirm.role.key]: undefined }));
            toast('Разрешения возвращены по умолчанию.');
            changes.reload();
          }}
        />
      )}
    </div>
  );
}
