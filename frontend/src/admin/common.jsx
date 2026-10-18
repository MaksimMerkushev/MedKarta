/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общие компоненты страниц админ-панели: ячейка пользователя, окна
 * создания пользователя, блокировки и показа временного пароля.
 * Права, роли и расшифровка журнала — в model.js.
 */
import { useState } from 'react';
import { Check, Copy, KeyRound, ShieldAlert, UserPlus } from 'lucide-react';

import { api } from './api';
import { assignableRoles } from './model';
import { Avatar, Button, ConfirmDialog, inputClass, Modal, SelectInput, TextInput } from '../ui/kit';
import { ROLE_LABELS } from '../ui/format';
import { useToast } from '../ui/hooks';
import { Link } from '../ui/router';

export function UserCell({ user, link = true, size = 34 }) {
  const content = (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar name={user.displayName || user.email} src={user.avatarUrl} seed={user.id} size={size} />
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold text-slate-800 dark:text-slate-100">{user.displayName || 'Без имени'}</span>
        <span className="block truncate text-[12px] text-slate-500 dark:text-slate-400">{user.email}</span>
      </span>
    </span>
  );
  return link ? <Link to={`/admin/users/${user.id}`} className="block min-w-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-300">{content}</Link> : content;
}

/** Временный пароль — показывается один раз; при закрытии окна его больше нигде нет. */
export function TemporaryPasswordDialog({ email, password, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal title="Временный пароль" description={`Для ${email}. Передайте его пользователю лично — при первом входе пароль нужно будет сменить.`} onClose={onClose} size="sm" footer={<Button variant="primary" onClick={onClose}>Готово</Button>}>
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950">
        <KeyRound size={18} className="shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" />
        <code className="flex-1 select-all whitespace-nowrap font-mono text-[15px] font-semibold text-slate-800 dark:text-white" data-testid="temporary-password">{password}</code>
        <Button size="sm" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Скопировано' : 'Копировать'}</Button>
      </div>
      <p className="mt-3 flex gap-2 text-[12.5px] leading-5 text-amber-800 dark:text-amber-300">
        <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        Пароль показывается один раз и нигде не хранится в открытом виде. Не отправляйте его в общий чат.
      </p>
    </Modal>
  );
}

export function CreateUserModal({ me, onClose, onCreated }) {
  const roles = assignableRoles(me);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'user' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/api/admin/users', { ...form, email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim() });
      onCreated(result);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };
  const ready = form.email.includes('@') && form.firstName.trim() && form.lastName.trim();
  return (
    <Modal
      title="Новый пользователь"
      description="Пароль сгенерируется автоматически и будет показан один раз. При первом входе его нужно сменить."
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Отмена</Button>
          <Button variant="primary" icon={UserPlus} onClick={submit} loading={busy} disabled={!ready} data-testid="create-user-submit">Создать</Button>
        </>
      )}
    >
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <div className="sm:col-span-2">
          <TextInput label="Email (логин)" type="email" autoComplete="off" value={form.email} onChange={set('email')} maxLength={254} data-testid="create-user-email" />
        </div>
        <TextInput label="Имя" value={form.firstName} onChange={set('firstName')} maxLength={60} data-testid="create-user-first-name" />
        <TextInput label="Фамилия" value={form.lastName} onChange={set('lastName')} maxLength={60} data-testid="create-user-last-name" />
        <div className="sm:col-span-2">
          <SelectInput
            label="Роль"
            value={form.role}
            onChange={set('role')}
            options={roles.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
            hint={roles.length === 1 ? 'Назначать другие роли может пользователь с правом «Назначение ролей».' : 'Можно назначить только роль ниже своей (суперадминистратор — любую).'}
            data-testid="create-user-role"
          />
        </div>
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700 sm:col-span-2 dark:bg-red-950/50 dark:text-red-300" role="alert">{error}</p>}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** Блокировка: постоянная или до даты, с причиной (её увидит пользователь при входе). */
export function BlockDialog({ title = 'Заблокировать', count = 1, onConfirm, onClose }) {
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState('permanent');
  const [until, setUntil] = useState('');
  const toast = useToast();
  const untilIso = mode === 'temporary' && until ? new Date(until).toISOString() : null;
  return (
    <ConfirmDialog
      title={title}
      message={count > 1 ? `Выбрано пользователей: ${count}. Их сессии будут завершены сразу, вход — закрыт.` : 'Все сессии пользователя будут завершены сразу, вход — закрыт.'}
      confirmLabel="Заблокировать"
      onClose={onClose}
      onConfirm={async () => {
        if (mode === 'temporary' && !untilIso) throw new Error('Укажите дату окончания блокировки.');
        await onConfirm({ reason: reason.trim() || null, until: untilIso });
        toast(count > 1 ? 'Блокировка выполнена.' : 'Пользователь заблокирован.');
      }}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-[13px] font-semibold dark:bg-slate-800" role="radiogroup" aria-label="Срок блокировки">
          {[['permanent', 'Бессрочно'], ['temporary', 'До даты']].map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => setMode(value)} className={`rounded-lg py-1.5 transition ${mode === value ? 'bg-white text-blue-700 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 dark:text-slate-400'}`}>{label}</button>
          ))}
        </div>
        {mode === 'temporary' && (
          <label className="block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">
            Разблокировать автоматически
            <input type="datetime-local" className={`${inputClass} mt-1`} value={until} onChange={(event) => setUntil(event.target.value)} data-testid="block-until" />
          </label>
        )}
        <label className="block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">
          Причина (видна пользователю при попытке входа)
          <textarea className={`${inputClass} mt-1 min-h-[72px]`} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} data-testid="block-reason" />
        </label>
      </div>
    </ConfirmDialog>
  );
}
