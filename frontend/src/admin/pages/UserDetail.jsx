/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Карточка пользователя: профиль, управление, безопасность, аудит. Кнопки
 * действий показываются по разрешениям из ответа сервера (can), но каждое
 * действие сервер проверяет заново. Пароли, токены и cookie пользователя
 * сюда не приходят; ссылка-приглашение — только в ответе на её выдачу
 * (ручная передача) и только в окне итога.
 */
import { useState } from 'react';
import {
  Archive, ArrowLeft, Ban, Copy, KeyRound, Link2, Lock, LogOut, Mail, Monitor, RotateCcw, Save, Send, ShieldAlert, Trash2, Unlock, UserCog,
} from 'lucide-react';

import { api, useApi } from '../api';
import { BlockDialog, DeliveryChoice, InvitationResultDialog } from '../common';
import { describeAudit, useAdmin } from '../model';
import {
  Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Pagination, RoleBadge, SelectInput, Skeleton, StatusBadge, Tabs, TextInput,
} from '../../ui/kit';
import { formatDateTime, formatRelative, ROLE_LABELS } from '../../ui/format';
import { useToast } from '../../ui/hooks';
import { Link } from '../../ui/router';
import { navigate } from '../../ui/navigation';

const TABS = [
  { value: 'profile', label: 'Профиль' },
  { value: 'manage', label: 'Управление' },
  { value: 'security', label: 'Безопасность' },
  { value: 'audit', label: 'Аудит' },
];

function Row({ label, children }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-[12.5px] font-semibold text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 break-words text-[13.5px] text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

function ProfileTab({ user }) {
  const toast = useToast();
  return (
    <Card title="Данные аккаунта">
      <dl className="divide-y divide-slate-100 dark:divide-slate-800">
        <Row label="ID">
          <span className="inline-flex items-center gap-2 font-mono text-[12.5px]">
            {user.id}
            <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Скопировать ID" onClick={() => navigator.clipboard?.writeText(user.id).then(() => toast('ID скопирован.'), () => {})}>
              <Copy size={13} aria-hidden="true" />
            </button>
          </span>
        </Row>
        <Row label="Имя">{user.firstName || '—'}</Row>
        <Row label="Фамилия">{user.lastName || '—'}</Row>
        <Row label="Email">{user.email}</Row>
        <Row label="Аватар"><Avatar name={user.displayName} src={user.avatarUrl} seed={user.id} size={40} /></Row>
        <Row label="Роль"><RoleBadge role={user.role} /></Row>
        <Row label="Статус">
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={user.status} until={user.blockedUntil} pending={user.pending} />
            {user.blockReason && <span className="text-slate-500 dark:text-slate-400">Причина: {user.blockReason}</span>}
          </span>
        </Row>
        <Row label="Создан">{formatDateTime(user.createdAt)}{user.createdBy ? ` · ${user.createdBy}` : ''}</Row>
        <Row label="Изменён">{formatDateTime(user.updatedAt)}</Row>
        <Row label="Последний вход">{user.lastLoginAt ? `${formatDateTime(user.lastLoginAt)} (${formatRelative(user.lastLoginAt)})` : 'не входил'}</Row>
        <Row label="Последняя активность">{user.lastSeenAt ? `${formatDateTime(user.lastSeenAt)} (${formatRelative(user.lastSeenAt)})` : '—'}</Row>
        <Row label="Пароль изменён">{formatDateTime(user.passwordChangedAt)}</Row>
        <Row label="Смена пароля">{user.mustChangePassword ? <Badge tone="amber" icon={KeyRound}>Требуется при входе</Badge> : 'не требуется'}</Row>
        <Row label="Неудачные входы подряд">{user.failedLogins}{user.lastFailedLoginAt ? ` · последний ${formatDateTime(user.lastFailedLoginAt)}` : ''}</Row>
        <Row label="Активные сессии">{user.activeSessions}</Row>
      </dl>
    </Card>
  );
}

const Reason = ({ children }) => <p className="text-[12px] leading-5 text-slate-500 dark:text-slate-400">{children}</p>;

const LINK_TONES = { active: 'blue', opened: 'amber', used: 'green', revoked: 'slate', expired: 'slate' };
const PURPOSE_LABELS = { invite: 'Приглашение', reset: 'Смена пароля' };
const DELIVERY_LABELS = { sent: 'письмом', failed: 'письмо не ушло — передана вручную', manual: 'передана вручную', pending: 'отправляется' };

/** Когда и чем закончилась ссылка — одной строкой. */
const linkStatus = (item) => {
  if (item.state === 'used') return `использована ${formatDateTime(item.usedAt)}`;
  if (item.state === 'revoked') return `отозвана ${formatDateTime(item.revokedAt)}${item.revokedReason ? `: ${item.revokedReason}` : ''}`;
  if (item.state === 'expired') return `истекла ${formatDateTime(item.expiresAt)}`;
  if (item.state === 'opened') return `открыта ${formatDateTime(item.openedAt)}, пароль ещё не задан`;
  return `действует до ${formatDateTime(item.expiresAt)}`;
};

/**
 * Приглашение и ссылки для входа: выдать новую (письмом или вручную),
 * посмотреть историю, отозвать действующую. Пароль администратор не видит.
 */
function AccessLinksCard({ data, onChanged }) {
  const { me } = useAdmin();
  const toast = useToast();
  const { user, can } = data;
  const mailEnabled = Boolean(me?.mail?.enabled);
  const links = useApi(() => api.get(`/api/admin/users/${user.id}/invitations`), [user.id, user.version]);
  const [dialog, setDialog] = useState(null);
  // Итог выдачи — отдельно от окна подтверждения: то закрывается само после успеха.
  const [issued, setIssued] = useState(null);
  const [delivery, setDelivery] = useState('auto');
  const invite = user.pending;
  const live = links.data?.items.some((item) => item.state === 'active' || item.state === 'opened');
  const why = user.status === 'blocked'
    ? 'Аккаунт заблокирован: ссылку можно выдать после разблокировки.'
    : user.status === 'archived'
      ? 'Аккаунт в архиве: сначала восстановите его.'
      : 'Нужно право «Сброс пароля» и роль выше, чем у пользователя.';

  return (
    <Card
      title={invite ? 'Приглашение' : 'Пароль и ссылки для входа'}
      description={invite
        ? 'Аккаунт ждёт активации: пароль пользователь задаст сам, открыв ссылку.'
        : 'Пароль знает только пользователь. Если он его забыл — выдайте ссылку: по ней он задаст новый.'}
      className={invite ? 'xl:col-span-2' : ''}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={invite ? Send : Link2} disabled={!can.invite} onClick={() => setDialog({ type: 'issue' })} data-testid="issue-link">
            {invite ? (live ? 'Выслать новое приглашение' : 'Выслать приглашение') : 'Ссылка для смены пароля'}
          </Button>
          {!invite && (
            <Button variant="ghost" disabled={!can.password || user.mustChangePassword} onClick={() => setDialog({ type: 'require' })}>Потребовать смену при входе</Button>
          )}
          {!can.invite && <Reason>{why}</Reason>}
        </div>

        {links.error && <ErrorState error={links.error} onRetry={links.reload} />}
        {!links.data && links.loading && <Skeleton className="h-16" />}
        {links.data && links.data.items.length === 0 && (
          <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-[13px] text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">Ссылок для этого аккаунта ещё не выдавали.</p>
        )}
        {links.data && links.data.items.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800" data-testid="user-invitations">
            {links.data.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-[13px]" data-testid="invitation-row" data-state={item.state}>
                <span className="inline-flex items-center gap-2 font-semibold text-slate-700 dark:text-slate-200">
                  {item.delivery === 'email' ? <Mail size={15} className="text-slate-400" aria-hidden="true" /> : <Link2 size={15} className="text-slate-400" aria-hidden="true" />}
                  {PURPOSE_LABELS[item.purpose] || item.purpose}
                </span>
                <Badge tone={LINK_TONES[item.state] || 'slate'}>{item.stateLabel}</Badge>
                {/* На узком экране — своей строкой, а не столбиком по слову рядом с бейджем. */}
                <span className="w-full min-w-0 text-slate-500 sm:w-auto sm:flex-1 dark:text-slate-400">
                  {linkStatus(item)} · выдал {item.createdBy || '—'} {formatDateTime(item.createdAt)}, {DELIVERY_LABELS[item.deliveryStatus] || item.deliveryStatus}
                </span>
                {(item.state === 'active' || item.state === 'opened') && (
                  <Button size="sm" variant="dangerGhost" icon={Ban} disabled={!can.password} onClick={() => setDialog({ type: 'revoke', item })} data-testid="revoke-invitation">Отозвать</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialog?.type === 'issue' && (
        <ConfirmDialog
          title={invite ? 'Выслать приглашение?' : 'Выдать ссылку для смены пароля?'}
          message={invite
            ? 'Прежнее приглашение, если оно ещё действует, перестанет работать.'
            : 'Текущий пароль продолжит действовать, пока пользователь не задаст новый по ссылке. Прежняя ссылка для смены пароля перестанет работать.'}
          confirmLabel={mailEnabled && delivery === 'auto' ? 'Отправить письмо' : 'Показать ссылку'}
          tone="primary"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            const result = await api.post(`/api/admin/users/${user.id}/invitations`, { delivery: mailEnabled ? delivery : 'auto' });
            setIssued(result);
            links.reload();
          }}
        >
          <DeliveryChoice mailEnabled={mailEnabled} value={delivery} onChange={setDelivery} />
        </ConfirmDialog>
      )}
      {issued && (
        <InvitationResultDialog
          user={issued.user}
          invitation={issued.invitation}
          link={issued.link}
          onClose={() => {
            // Карточка обновляется после закрытия: иначе смена версии пересоздала бы вкладку вместе с окном.
            const { user: fresh, can: rights, permissions } = issued;
            setIssued(null);
            onChanged({ user: fresh, can: rights, permissions });
          }}
        />
      )}
      {dialog?.type === 'revoke' && (
        <ConfirmDialog
          title="Отозвать ссылку?"
          message="По ней больше нельзя будет задать пароль. Если пользователь уже открыл её, создание пароля прервётся."
          confirmLabel="Отозвать"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.del(`/api/admin/users/${user.id}/invitations/${dialog.item.id}`, {});
            toast('Ссылка отозвана.');
            links.reload();
          }}
        />
      )}
      {dialog?.type === 'require' && (
        <ConfirmDialog title="Потребовать смену пароля?" message="При следующем запросе пользователь увидит экран смены пароля; остальные функции будут недоступны до смены." confirmLabel="Потребовать" tone="primary" onClose={() => setDialog(null)}
          onConfirm={async () => {
            const result = await api.post(`/api/admin/users/${user.id}/password-require`, {});
            toast('Пользователь сменит пароль при следующем действии.');
            onChanged(result);
          }} />
      )}
    </Card>
  );
}

function ManageTab({ data, onChanged }) {
  const toast = useToast();
  const { user, can } = data;
  const [form, setForm] = useState({ firstName: user.firstName, lastName: user.lastName, email: user.email });
  const [role, setRole] = useState(user.role);
  const [dialog, setDialog] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const why = user.isSelf
    ? 'Это ваш аккаунт: имя и пароль меняются в профиле, а роль, блокировку и удаление нельзя применить к себе.'
    : user.isDemo
      ? 'Демо-копии создаются и удаляются автоматически.'
      : 'Аккаунт с такой же или более высокой ролью может менять только суперадминистратор.';
  const anything = Object.values(can).some((value) => (Array.isArray(value) ? value.length > 0 : value));
  const dirty = form.firstName.trim() !== user.firstName || form.lastName.trim() !== user.lastName || form.email.trim().toLowerCase() !== user.email;

  const act = async (request, message) => {
    const result = await request();
    if (message) toast(message);
    onChanged(result);
    return result;
  };

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await act(() => api.patch(`/api/admin/users/${user.id}`, { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim(), version: user.version }), 'Профиль сохранён.');
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {!anything && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-[13px] leading-5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{why}
        </p>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        {/* Аккаунт ждёт активации — приглашение главное, оно первым. */}
        {user.pending && <AccessLinksCard data={data} onChanged={onChanged} />}
        <Card title="Имя и email" description="Email — это логин для входа.">
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={save}>
            <TextInput label="Имя" value={form.firstName} disabled={!can.edit} maxLength={60} onChange={(event) => setForm({ ...form, firstName: event.target.value })} data-testid="edit-first-name" />
            <TextInput label="Фамилия" value={form.lastName} disabled={!can.edit} maxLength={60} onChange={(event) => setForm({ ...form, lastName: event.target.value })} data-testid="edit-last-name" />
            <div className="sm:col-span-2">
              <TextInput
                label="Email"
                type="email"
                value={form.email}
                disabled={!can.editEmail}
                maxLength={254}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                hint={can.edit && !can.editEmail ? 'Email — логин и адрес для ссылок входа: менять его может только тот, у кого есть право «Сброс пароля».' : undefined}
              />
            </div>
            {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700 sm:col-span-2 dark:bg-red-950/50 dark:text-red-300" role="alert">{error}</p>}
            <div className="flex items-center gap-2 sm:col-span-2">
              <Button type="submit" variant="primary" icon={Save} loading={saving} disabled={!can.edit || !dirty} data-testid="edit-save">Сохранить</Button>
              {!can.edit && <Reason>Нет права «Изменение имени и email» или {why.toLowerCase()}</Reason>}
            </div>
          </form>
        </Card>

        <Card title="Роль" description="Права роли — в разделе «Роли и права».">
          <div className="space-y-3">
            <SelectInput
              label="Роль пользователя"
              value={role}
              disabled={!can.changeRole}
              onChange={(event) => setRole(event.target.value)}
              options={(can.changeRole ? can.assignableRoles : [user.role]).map((value) => ({ value, label: ROLE_LABELS[value] }))}
              data-testid="role-select"
            />
            <Button icon={UserCog} disabled={!can.changeRole || role === user.role} onClick={() => setDialog('role')} data-testid="role-save">Назначить роль</Button>
            {!can.changeRole && <Reason>Назначать роли может пользователь с правом «Назначение ролей» и только ниже своей.</Reason>}
          </div>
        </Card>

        <Card title="Доступ" description="Блокировка сразу завершает все сессии пользователя.">
          <div className="flex flex-wrap gap-2">
            {user.status === 'blocked' ? (
              <Button icon={Unlock} disabled={!can.block} onClick={() => setDialog('unblock')} data-testid="unblock-user">Разблокировать</Button>
            ) : (
              <Button variant="dangerGhost" icon={Lock} disabled={!can.block || user.status === 'archived'} onClick={() => setDialog('block')} data-testid="block-user">Заблокировать</Button>
            )}
            <Button variant="ghost" icon={LogOut} disabled={!can.sessions || user.isSelf || user.activeSessions === 0} onClick={() => setDialog('sessions')} data-testid="revoke-sessions">Завершить все сессии</Button>
            {user.status === 'archived' ? (
              <Button icon={RotateCcw} disabled={!can.archive} onClick={() => setDialog('restore')}>Восстановить из архива</Button>
            ) : (
              <Button variant="ghost" icon={Archive} disabled={!can.archive} onClick={() => setDialog('archive')}>В архив</Button>
            )}
          </div>
          {user.status === 'blocked' && user.blockReason && <p className="mt-3 text-[13px] text-slate-600 dark:text-slate-300">Причина блокировки: {user.blockReason}</p>}
        </Card>

        {!user.pending && <AccessLinksCard data={data} onChanged={onChanged} />}
      </div>

      <Card title="Опасная зона">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] leading-5 text-slate-600 dark:text-slate-300">
            Удаление необратимо: стираются профиль, сессии, избранное, аватар и история входов; демо-записи отвязываются.
            В журнале действий остаётся запись с маской email. Если данные могут понадобиться — используйте архив.
          </p>
          <Button variant="danger" icon={Trash2} disabled={!can.delete} onClick={() => setDialog('delete')} data-testid="delete-user">Удалить аккаунт</Button>
        </div>
      </Card>

      {dialog === 'role' && (
        <ConfirmDialog
          title="Сменить роль?"
          message={`${user.displayName}: ${ROLE_LABELS[user.role]} → ${ROLE_LABELS[role]}. Права изменятся сразу, без повторного входа. ${user.pending ? 'Приглашение будет отозвано — после смены роли вышлите новое.' : 'Действующие ссылки для входа будут отозваны.'}`}
          confirmLabel="Назначить"
          tone="primary"
          onClose={() => setDialog(null)}
          onConfirm={() => act(() => api.post(`/api/admin/users/${user.id}/role`, { role, version: user.version }), 'Роль изменена.')}
        />
      )}
      {dialog === 'block' && (
        <BlockDialog onClose={() => setDialog(null)} onConfirm={(options) => act(() => api.post(`/api/admin/users/${user.id}/block`, options))} />
      )}
      {dialog === 'unblock' && (
        <ConfirmDialog title="Разблокировать?" message="Пользователь снова сможет войти." confirmLabel="Разблокировать" tone="primary" onClose={() => setDialog(null)}
          onConfirm={() => act(() => api.post(`/api/admin/users/${user.id}/unblock`, {}), 'Пользователь разблокирован.')} />
      )}
      {dialog === 'sessions' && (
        <ConfirmDialog title="Завершить все сессии?" message={`Активных сессий: ${user.activeSessions}. Пользователю придётся войти заново на всех устройствах.`} confirmLabel="Завершить" onClose={() => setDialog(null)}
          onConfirm={async () => {
            const result = await api.post(`/api/admin/users/${user.id}/sessions/revoke`, {});
            toast(`Завершено сессий: ${result.revoked}.`);
            onChanged(null);
          }} />
      )}
      {dialog === 'archive' && (
        <ConfirmDialog title="Отправить в архив?" message="Вход будет закрыт, сессии завершены. Данные сохранятся, аккаунт можно восстановить." confirmLabel="В архив" onClose={() => setDialog(null)}
          onConfirm={() => act(() => api.post(`/api/admin/users/${user.id}/archive`, {}), 'Аккаунт в архиве.')} />
      )}
      {dialog === 'restore' && (
        <ConfirmDialog title="Восстановить аккаунт?" message="Пользователь снова сможет войти." confirmLabel="Восстановить" tone="primary" onClose={() => setDialog(null)}
          onConfirm={() => act(() => api.post(`/api/admin/users/${user.id}/restore`, {}), 'Аккаунт восстановлен.')} />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title="Удалить аккаунт навсегда?"
          message={`${user.displayName} (${user.email}). Действие нельзя отменить.`}
          confirmLabel="Удалить навсегда"
          confirmText={user.email}
          confirmHint="Введите email пользователя для подтверждения"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.del(`/api/admin/users/${user.id}`, { confirmEmail: user.email });
            toast('Аккаунт удалён.');
            navigate('/admin/users');
          }}
        />
      )}
    </div>
  );
}

const EVENT_TONES = { login_ok: 'green', login_failed: 'red', login_denied: 'amber', password_changed: 'blue', logout: 'slate', session_revoked: 'slate', sessions_revoked: 'slate' };
const REASONS = { bad_password: 'неверный пароль', blocked: 'аккаунт заблокирован', archived: 'аккаунт в архиве', admin: 'администратором', self: 'самим пользователем' };

function SecurityTab({ data, onChanged }) {
  const { user, can } = data;
  const toast = useToast();
  const [loginsPage, setLoginsPage] = useState(1);
  const [filter, setFilter] = useState('all');
  const sessions = useApi(() => (can.sessions ? api.get(`/api/admin/users/${user.id}/sessions`) : Promise.resolve(null)), [user.id, user.version, user.activeSessions]);
  const logins = useApi(() => api.get(`/api/admin/users/${user.id}/logins`, { page: loginsPage, pageSize: 10, type: filter === 'failed' ? 'failed' : undefined }), [user.id, loginsPage, filter]);
  const blocks = useApi(() => api.get(`/api/admin/users/${user.id}/blocks`), [user.id, user.status]);
  const [revoking, setRevoking] = useState(null);

  return (
    <div className="space-y-5">
      <Card title="Активные сессии" description="Время — последней активности; это не признак «онлайн»." bodyClassName="p-0">
        {!can.sessions && <EmptyState title="Нет доступа к сессиям" description="Нужно право «Просмотр и отзыв сессий»." />}
        {can.sessions && sessions.loading && !sessions.data && <div className="p-4"><Skeleton className="h-10" /></div>}
        {can.sessions && sessions.error && <ErrorState error={sessions.error} onRetry={sessions.reload} />}
        {can.sessions && sessions.data && sessions.data.items.length === 0 && <EmptyState icon={Monitor} title="Активных сессий нет" />}
        {can.sessions && sessions.data && sessions.data.items.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="user-sessions">
            {sessions.data.items.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Monitor size={18} className="shrink-0 text-slate-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">{session.client}</p>
                  <p className="text-[12px] text-slate-500 dark:text-slate-400">
                    Вход {formatDateTime(session.createdAt)} · активность {formatRelative(session.lastSeenAt)} · истекает {formatDateTime(session.expiresAt)}{session.network ? ` · сеть ${session.network}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="dangerGhost" loading={revoking === session.id} disabled={!can.sessions} onClick={async () => {
                  setRevoking(session.id);
                  try {
                    await api.del(`/api/admin/sessions/${session.id}`, {});
                    toast('Сессия завершена.');
                    sessions.reload();
                    onChanged(null);
                  } catch (failure) {
                    toast(failure.message, 'error');
                  } finally {
                    setRevoking(null);
                  }
                }}>Завершить</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="История входов"
        description="Успешные и неудачные попытки, выходы, смены пароля. Хранится ограниченный срок (см. Настройки)."
        actions={(
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[12px] font-semibold dark:bg-slate-800">
            {[['all', 'Все'], ['failed', 'Неудачные']].map(([value, label]) => (
              <button key={value} type="button" onClick={() => {
                setFilter(value);
                setLoginsPage(1);
              }} className={`rounded-md px-2.5 py-1 ${filter === value ? 'bg-white text-slate-800 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500'}`} aria-pressed={filter === value}>{label}</button>
            ))}
          </div>
        )}
        bodyClassName="p-0"
      >
        {logins.error && <ErrorState error={logins.error} onRetry={logins.reload} />}
        {!logins.data && logins.loading && <div className="p-4"><Skeleton className="h-24" /></div>}
        {logins.data && logins.data.items.length === 0 && <EmptyState title="Записей нет" />}
        {logins.data && logins.data.items.length > 0 && (
          <>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="user-logins">
              {logins.data.items.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                  <span className="w-36 shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(event.at)}</span>
                  <Badge tone={EVENT_TONES[event.type] || 'slate'}>{event.label}</Badge>
                  {event.reason && <span className="text-slate-500 dark:text-slate-400">{REASONS[event.reason] || event.reason}</span>}
                  <span className="text-slate-600 dark:text-slate-300">{event.client || ''}</span>
                  {event.network && <span className="font-mono text-[12px] text-slate-400">{event.network}</span>}
                </li>
              ))}
            </ul>
            <Pagination page={logins.data.page} pageSize={logins.data.pageSize} total={logins.data.total} onPage={setLoginsPage} />
          </>
        )}
      </Card>

      <Card title="История блокировок" bodyClassName="p-0">
        {blocks.data?.items.length === 0 && <EmptyState title="Блокировок не было" />}
        {blocks.data?.items.length > 0 && (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="user-blocks">
            {blocks.data.items.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <span className="w-36 shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(event.at)}</span>
                <Badge tone={event.action === 'block' ? 'red' : 'green'}>{event.action === 'block' ? 'Блокировка' : event.action === 'expired' ? 'Срок истёк' : 'Разблокировка'}</Badge>
                <span className="text-slate-700 dark:text-slate-200">{event.actor || ''}</span>
                {event.until && <span className="text-slate-500 dark:text-slate-400">до {formatDateTime(event.until)}</span>}
                {event.reason && <span className="text-slate-500 dark:text-slate-400">«{event.reason}»</span>}
              </li>
            ))}
          </ul>
        )}
        {blocks.error && <ErrorState error={blocks.error} onRetry={blocks.reload} />}
      </Card>
    </div>
  );
}

function AuditTab({ user }) {
  const { can } = useAdmin();
  const [page, setPage] = useState(1);
  const audit = useApi(() => (can('audit.view') ? api.get(`/api/admin/users/${user.id}/audit`, { page, pageSize: 10 }) : Promise.resolve(null)), [user.id, page, user.version]);
  if (!can('audit.view')) return <Card><EmptyState title="Нет доступа к журналу" description="Нужно право «Журнал административных действий»." /></Card>;
  return (
    <Card title="Действия над аккаунтом" description="Кто, когда и что изменил. Пароли и токены в журнал не пишутся." bodyClassName="p-0">
      {audit.error && <ErrorState error={audit.error} onRetry={audit.reload} />}
      {audit.data && audit.data.items.length === 0 && <EmptyState title="Записей нет" />}
      {audit.data && audit.data.items.length > 0 && (
        <>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800" data-testid="user-audit">
            {audit.data.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <span className="w-36 shrink-0 tabular-nums text-slate-500 dark:text-slate-400">{formatDateTime(item.at)}</span>
                <Badge tone={item.result === 'ok' ? 'blue' : 'red'}>{item.actionLabel}</Badge>
                <span className="text-slate-700 dark:text-slate-200">{item.actor}</span>
                <span className="min-w-0 flex-1 text-slate-500 dark:text-slate-400">{describeAudit(item)}</span>
              </li>
            ))}
          </ul>
          <Pagination page={audit.data.page} pageSize={audit.data.pageSize} total={audit.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

export default function UserDetail({ params }) {
  const [tab, setTab] = useState('profile');
  const { data, error, loading, reload, setData } = useApi(() => api.get(`/api/admin/users/${params.id}`), [params.id]);

  const onChanged = (result) => {
    if (result?.user && result?.can) setData({ user: result.user, can: result.can, permissions: result.permissions });
    else reload();
  };

  if (error && !data) {
    return (
      <Card>
        {error.status === 404 ? <EmptyState title="Пользователь не найден" description="Возможно, аккаунт удалён." action={<Link to="/admin/users" className="font-semibold text-blue-600 hover:underline">К списку</Link>} /> : <ErrorState error={error} onRetry={reload} />}
      </Card>
    );
  }
  if (!data) return <div className="space-y-3"><Skeleton className="h-24 rounded-2xl" /><Skeleton className="h-64 rounded-2xl" /></div>;

  const { user } = data;
  return (
    <div className={`space-y-4 ${loading ? 'opacity-90' : ''}`}>
      <button type="button" onClick={() => (window.history.length > 1 ? window.history.back() : navigate('/admin/users'))} className="inline-flex items-center gap-1 text-[13px] font-semibold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white">
        <ArrowLeft size={15} aria-hidden="true" />Пользователи
      </button>
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <Avatar name={user.displayName} src={user.avatarUrl} seed={user.id} size={64} />
        <div className="min-w-0 flex-1">
          {/* На телефоне длинное имя переносится на вторую строку, а не обрезается до пары букв. */}
          <h2 className="line-clamp-2 break-words text-[20px] font-extrabold leading-tight text-slate-800 sm:line-clamp-none sm:truncate dark:text-white" title={user.displayName} data-testid="user-detail-name">{user.displayName}</h2>
          <p className="truncate text-[13px] text-slate-500 dark:text-slate-400">{user.email}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <RoleBadge role={user.role} />
            <StatusBadge status={user.status} until={user.blockedUntil} pending={user.pending} />
            {user.mustChangePassword && <Badge tone="amber" icon={KeyRound}>Сменит пароль</Badge>}
            {user.isSelf && <Badge tone="violet">Это вы</Badge>}
            {user.isDemo && <Badge tone="amber">Демо-копия</Badge>}
          </div>
        </div>
        {/* На телефоне — отдельной строкой: рядом с ней имя сжималось до одной буквы. */}
        <div className="w-full text-[12px] text-slate-500 sm:w-auto sm:text-right dark:text-slate-400">
          <p>Последний вход: {user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'не входил'}</p>
          <p>Активных сессий: {user.activeSessions}</p>
        </div>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Разделы карточки" />
      {tab === 'profile' && <ProfileTab user={user} />}
      {tab === 'manage' && <ManageTab key={user.version} data={data} onChanged={onChanged} />}
      {tab === 'security' && <SecurityTab data={data} onChanged={onChanged} />}
      {tab === 'audit' && <AuditTab user={user} />}
    </div>
  );
}
