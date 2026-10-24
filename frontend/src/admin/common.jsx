/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общие компоненты страниц админ-панели: ячейка пользователя, окна
 * создания пользователя (с приглашением), итога выдачи ссылки и блокировки.
 * Права, роли и расшифровка журнала — в model.js.
 */
import { useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, Info, Link2, Mail, MailCheck, ShieldAlert, UserPlus } from 'lucide-react';

import { api } from './api';
import { assignableRoles } from './model';
import { Avatar, Button, ConfirmDialog, inputClass, Modal, SelectInput, TextInput } from '../ui/kit';
import { formatDateTime, ROLE_LABELS } from '../ui/format';
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

const DELIVERY_OPTIONS = [
  { key: 'auto', label: 'Письмом на email', icon: Mail },
  { key: 'manual', label: 'Показать ссылку', icon: Link2 },
];

/** Как передать ссылку: письмом (если почта настроена) или показать администратору один раз. */
export function DeliveryChoice({ mailEnabled, value, onChange }) {
  if (!mailEnabled) {
    return (
      <p className="flex gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[12.5px] leading-5 text-slate-600 dark:bg-slate-800/70 dark:text-slate-300" data-testid="delivery-manual-note">
        <Info size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
        Почта на сервере не настроена: ссылку покажем один раз — передайте её пользователю лично.
      </p>
    );
  }
  return (
    <div>
      <span className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300" id="delivery-label">Как передать приглашение</span>
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 text-[13px] font-semibold dark:bg-slate-800" role="radiogroup" aria-labelledby="delivery-label">
        {DELIVERY_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.key} type="button" role="radio" aria-checked={value === option.key} onClick={() => onChange(option.key)} className={`inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 transition ${value === option.key ? 'bg-white text-blue-700 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500 dark:text-slate-400'}`} data-testid={`delivery-${option.key}`}>
              <Icon size={15} aria-hidden="true" />
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Итог выдачи ссылки. Письмо ушло — сообщаем об этом. Ссылка показана
 * (ручная передача или письмо не ушло) — только здесь и только сейчас: в
 * ответах API, журнале и карточке пользователя её больше нет.
 */
export function InvitationResultDialog({ user, invitation, link = null, created = false, onClose }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);
  const invite = invitation.purpose === 'invite';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Буфер обмена недоступен (нет HTTPS или разрешения) — выделяем ссылку для ручного копирования.
      inputRef.current?.select();
      setCopied(false);
    }
  };
  const title = created ? 'Пользователь создан' : invite ? 'Новое приглашение' : 'Ссылка для смены пароля';
  return (
    <Modal title={title} description={`${user.displayName} · ${user.email}`} onClose={onClose} size="sm" footer={<Button variant="primary" onClick={onClose} data-testid="invitation-done">Готово</Button>}>
      {!link ? (
        <div className="flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-3.5 text-[13.5px] leading-5 text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="invitation-sent">
          <MailCheck size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            {invite ? 'Приглашение отправлено' : 'Ссылка отправлена'} на <b className="font-semibold">{user.email}</b>. Она действует до {formatDateTime(invitation.expiresAt)} и срабатывает один раз.
            {invite ? ' Когда пользователь задаст пароль, в панели появится уведомление.' : ''}
          </p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="invitation-link-box">
          {invitation.deliveryStatus === 'failed' && (
            <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-[12.5px] leading-5 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200" role="alert">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              Письмо не отправилось: почтовый сервер его не принял. Передайте ссылку сами.
            </p>
          )}
          <label className="block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">
            {invite ? 'Ссылка-приглашение' : 'Ссылка для смены пароля'}
            <span className="mt-1 flex gap-2">
              <input
                ref={inputRef}
                readOnly
                value={link}
                onClick={(event) => event.target.select()}
                className={`${inputClass} min-w-0 flex-1 font-mono text-[12.5px]`}
                spellCheck={false}
                data-testid="invitation-link"
              />
              <Button icon={copied ? Check : Copy} onClick={copy} data-testid="invitation-copy">{copied ? 'Скопировано' : 'Копировать'}</Button>
            </span>
          </label>
          <p className="flex gap-2 text-[12.5px] leading-5 text-slate-600 dark:text-slate-300">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span>
              Ссылка видна только сейчас — потом её не показать, можно лишь выпустить новую. Передайте её лично этому человеку, не в общий чат: по ней задаётся пароль. Действует до {formatDateTime(invitation.expiresAt)}, срабатывает один раз.
            </span>
          </p>
        </div>
      )}
    </Modal>
  );
}

export function CreateUserModal({ me, onClose, onCreated }) {
  const roles = assignableRoles(me);
  const mailEnabled = Boolean(me?.mail?.enabled);
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '', role: 'user', delivery: 'auto' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/api/admin/users', { ...form, email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim(), delivery: mailEnabled ? form.delivery : 'auto' });
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
      description="Без пароля: пользователь придумает его сам по ссылке-приглашению. До этого аккаунт «ожидает активации»."
      onClose={onClose}
      busy={busy}
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Отмена</Button>
          <Button variant="primary" icon={UserPlus} onClick={submit} loading={busy} disabled={!ready} data-testid="create-user-submit">
            {mailEnabled && form.delivery === 'auto' ? 'Создать и отправить' : 'Создать'}
          </Button>
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
        <div className="sm:col-span-2">
          <DeliveryChoice mailEnabled={mailEnabled} value={form.delivery} onChange={(delivery) => setForm((current) => ({ ...current, delivery }))} />
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
