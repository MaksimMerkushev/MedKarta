/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общие элементы профиля и админ-панели: кнопки, карточки, бейджи, окна
 * подтверждения, уведомления, состояния загрузки и ошибок. Стиль — как у
 * карты: синий-фиолетовый акцент, slate-нейтральные, скругления 2xl.
 * Здесь только компоненты (и строковые классы): форматтеры — в format.js,
 * хуки — в hooks.js, чтобы работал Fast Refresh.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, Moon, Sun, X, XCircle } from 'lucide-react';

import { formatDate, formatNumber, initialsOf, ROLE_LABELS } from './format';
import { ToastContext } from './hooks';

/* --------------------------------- кнопки ---------------------------------- */

const VARIANTS = {
  primary: 'bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-sm hover:brightness-110 focus-visible:ring-blue-300',
  secondary: 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 focus-visible:ring-slate-300',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 focus-visible:ring-slate-300',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 focus-visible:ring-red-300',
  dangerGhost: 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 focus-visible:ring-red-300',
};
const SIZES = {
  sm: 'h-8 gap-1.5 rounded-lg px-2.5 text-[12.5px]',
  md: 'h-10 gap-2 rounded-xl px-3.5 text-[13.5px]',
  lg: 'h-11 gap-2 rounded-xl px-4 text-[14px]',
};

export function Button({ variant = 'secondary', size = 'md', icon: Icon = null, loading = false, className = '', children, disabled, type = 'button', ...rest }) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={`inline-flex shrink-0 items-center justify-center font-semibold outline-none transition focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-55 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 14 : 16} className="animate-spin" aria-hidden="true" /> : Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className = '', size = 18, ...rest }) {
  const Icon = icon;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 outline-none transition hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-300 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 ${className}`}
      {...rest}
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}

/* -------------------------------- карточки --------------------------------- */

export function Card({ title, description, actions, children, className = '', bodyClassName = 'p-4 sm:p-5', id }) {
  return (
    <section id={id} className={`rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-800">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-bold text-slate-800 dark:text-white">{title}</h2>}
            {description && <p className="mt-0.5 text-[12.5px] leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/* --------------------------------- бейджи ---------------------------------- */

const BADGE_TONES = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300',
};

export function Badge({ tone = 'slate', icon: Icon = null, children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${BADGE_TONES[tone]} ${className}`}>
      {Icon && <Icon size={12} aria-hidden="true" />}
      {children}
    </span>
  );
}

const ROLE_TONES = { superadmin: 'violet', admin: 'blue', moderator: 'amber', user: 'slate' };
export const RoleBadge = ({ role, short = false }) => (
  <Badge tone={ROLE_TONES[role] || 'slate'}>{short && role === 'superadmin' ? 'Суперадмин' : ROLE_LABELS[role] || role}</Badge>
);

export function StatusBadge({ status, until = null }) {
  if (status === 'active') return <Badge tone="green" icon={CheckCircle2}>Активен</Badge>;
  if (status === 'blocked') return <Badge tone="red" icon={XCircle}>{until ? `Заблокирован до ${formatDate(until)}` : 'Заблокирован'}</Badge>;
  if (status === 'archived') return <Badge tone="slate">В архиве</Badge>;
  return <Badge>{status}</Badge>;
}

/* --------------------------------- аватар ---------------------------------- */

const GRADIENTS = ['from-sky-500 to-indigo-500', 'from-violet-500 to-fuchsia-500', 'from-emerald-500 to-teal-500', 'from-amber-500 to-orange-500', 'from-rose-500 to-pink-500'];

const hashOf = (text) => [...String(text || '')].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

export function Avatar({ name, src = null, seed = '', size = 36, className = '' }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  if (src && !failed) {
    return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} className={`shrink-0 rounded-full object-cover ring-1 ring-black/5 ${className}`} style={style} />;
  }
  return (
    <span aria-hidden="true" style={style} className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold text-white ${GRADIENTS[hashOf(seed || name) % GRADIENTS.length]} ${className}`}>
      {initialsOf(name)}
    </span>
  );
}

/* --------------------------------- поля ------------------------------------ */

/** Поле без ширины — для фильтров в строку; inputClass — то же на всю ширину. */
export const controlClass =
  'rounded-xl border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-200 disabled:bg-slate-50 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-blue-900 dark:disabled:bg-slate-900 dark:disabled:text-slate-400';
export const inputClass = `w-full ${controlClass}`;

export function Field({ label, hint, error, children, htmlFor }) {
  return (
    <div>
      {label && <label htmlFor={htmlFor} className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">{label}</label>}
      {children}
      {error ? <p className="mt-1 text-[12px] text-red-600 dark:text-red-400" role="alert">{error}</p> : hint && <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export function TextInput({ label, hint, error, id, className = '', ...rest }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId}>
      <input id={inputId} className={`${inputClass} ${className}`} aria-invalid={Boolean(error)} {...rest} />
    </Field>
  );
}

export function SelectInput({ label, hint, id, options, className = '', ...rest }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <Field label={label} hint={hint} htmlFor={inputId}>
      <select id={inputId} className={`${inputClass} pr-8 ${className}`} {...rest}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </Field>
  );
}

export function Toggle({ checked, onChange, label, description, disabled = false }) {
  const id = useId();
  return (
    <label htmlFor={id} className={`flex cursor-pointer items-start justify-between gap-4 ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold text-slate-700 dark:text-slate-200">{label}</span>
        {description && <span className="mt-0.5 block text-[12px] leading-5 text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-300 dark:bg-slate-700" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/* --------------------------------- окна ------------------------------------ */

export function Modal({ title, description, onClose, children, footer, size = 'md', busy = false }) {
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement;
    const first = panelRef.current?.querySelector('input, select, textarea, button:not([data-close])');
    (first || panelRef.current)?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) closeRef.current?.();
      if (event.key === 'Tab' && panelRef.current) {
        // Фокус не уходит из окна.
        const items = [...panelRef.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const firstItem = items[0];
        const lastItem = items.at(-1);
        if (event.shiftKey && document.activeElement === firstItem) {
          event.preventDefault();
          lastItem.focus();
        } else if (!event.shiftKey && document.activeElement === lastItem) {
          event.preventDefault();
          firstItem.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [busy]);

  const width = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl' }[size];
  return (
    <div
      className="fixed inset-0 z-[1300] flex items-end justify-center bg-slate-950/50 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none dark:bg-slate-900 sm:rounded-3xl ${width}`}>
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="text-[16px] font-bold text-slate-800 dark:text-white">{title}</h2>
            {description && <p className="mt-1 text-[13px] leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          <IconButton icon={X} label="Закрыть" data-close onClick={onClose} disabled={busy} />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">{footer}</footer>}
      </div>
    </div>
  );
}

/**
 * Подтверждение опасного действия. confirmText — что нужно ввести дословно
 * (например, email при удалении), иначе кнопка неактивна.
 */
export function ConfirmDialog({ title, message, confirmLabel = 'Подтвердить', tone = 'danger', confirmText = null, confirmHint = '', onConfirm, onClose, children }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = confirmText === null || typed.trim().toLowerCase() === String(confirmText).toLowerCase();
  const submit = async (event) => {
    event?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(failure?.message || 'Не получилось.');
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      size="sm"
      footer={(
        <>
          <Button onClick={onClose} disabled={busy}>Отмена</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={submit} loading={busy} disabled={!ready} data-testid="confirm-action">{confirmLabel}</Button>
        </>
      )}
    >
      <form onSubmit={submit} className="space-y-3">
        {message && <p className="text-[13.5px] leading-6 text-slate-600 dark:text-slate-300">{message}</p>}
        {children}
        {confirmText !== null && (
          <TextInput label={confirmHint || `Введите «${confirmText}» для подтверждения`} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" data-testid="confirm-input" />
        )}
        {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/50 dark:text-red-300" role="alert">{error}</p>}
      </form>
    </Modal>
  );
}

/* ------------------------------ уведомления -------------------------------- */


const TOAST_TONES = {
  success: ['border-emerald-200 dark:border-emerald-800', CheckCircle2, 'text-emerald-600 dark:text-emerald-400'],
  error: ['border-red-200 dark:border-red-800', XCircle, 'text-red-600 dark:text-red-400'],
  warning: ['border-amber-200 dark:border-amber-800', AlertTriangle, 'text-amber-600 dark:text-amber-400'],
  info: ['border-blue-200 dark:border-blue-800', Info, 'text-blue-600 dark:text-blue-400'],
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const push = useCallback((message, tone = 'success') => {
    const id = nextId.current;
    nextId.current += 1;
    setItems((current) => [...current.slice(-3), { id, message, tone }]);
    setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4500);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[1400] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-4 sm:items-end" role="status" aria-live="polite">
        {items.map((item) => {
          const [border, Icon, iconColor] = TOAST_TONES[item.tone] || TOAST_TONES.info;
          return (
            <div key={item.id} className={`toast-enter pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border bg-white px-4 py-3 shadow-xl dark:bg-slate-900 ${border}`} data-testid="toast">
              <Icon size={18} className={`mt-0.5 shrink-0 ${iconColor}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-5 text-slate-700 dark:text-slate-200">{item.message}</span>
              <button type="button" onClick={() => dismiss(item.id)} className="-mr-1 rounded-lg p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Закрыть уведомление">
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------- состояния --------------------------------- */

export const Spinner = ({ label = 'Загрузка…' }) => (
  <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-slate-500 dark:text-slate-400" role="status">
    <Loader2 size={18} className="animate-spin" aria-hidden="true" />
    {label}
  </div>
);

export const Skeleton = ({ className = 'h-4 w-full' }) => <span className={`block animate-pulse rounded-lg bg-slate-200/80 dark:bg-slate-800 ${className}`} aria-hidden="true" />;

export function EmptyState({ icon = Info, title, description, action }) {
  const Icon = icon;
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">
        <Icon size={22} aria-hidden="true" />
      </span>
      <p className="mt-3 text-[14px] font-semibold text-slate-700 dark:text-slate-200">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] leading-5 text-slate-500 dark:text-slate-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center" role="alert">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-50 text-red-500 dark:bg-red-950/50 dark:text-red-400">
        <AlertTriangle size={22} aria-hidden="true" />
      </span>
      <p className="mt-3 text-[14px] font-semibold text-slate-700 dark:text-slate-200">Не удалось загрузить данные</p>
      <p className="mt-1 max-w-sm text-[13px] leading-5 text-slate-500 dark:text-slate-400">{error?.message || 'Попробуйте ещё раз.'}</p>
      {onRetry && <Button className="mt-4" onClick={onRetry}>Повторить</Button>}
    </div>
  );
}

/* --------------------------------- вкладки --------------------------------- */

export function Tabs({ tabs, value, onChange, label }) {
  const refs = useRef({});
  const onKeyDown = (event) => {
    const index = tabs.findIndex((tab) => tab.value === value);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    onChange(next.value);
    refs.current[next.value]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800" onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            ref={(node) => {
              refs.current[tab.value] = node;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-[13.5px] font-semibold outline-none transition focus-visible:bg-slate-100 dark:focus-visible:bg-slate-800 ${selected ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'}`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count !== null && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">{tab.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------- пагинация -------------------------------- */

export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [10, 25, 50, 100] }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-[12.5px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
      <div className="flex items-center gap-2">
        <span>{from}–{to} из {formatNumber(total)}</span>
        {onPageSize && (
          <label className="flex items-center gap-1.5">
            <span className="sr-only sm:not-sr-only">по</span>
            <select value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" aria-label="Записей на странице">
              {sizes.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-1">
        <IconButton icon={ChevronLeft} label="Предыдущая страница" onClick={() => onPage(page - 1)} disabled={page <= 1} className="disabled:opacity-40" />
        <span className="px-2 tabular-nums">{page} / {pages}</span>
        <IconButton icon={ChevronRight} label="Следующая страница" onClick={() => onPage(page + 1)} disabled={page >= pages} className="disabled:opacity-40" />
      </div>
    </div>
  );
}

/* ---------------------------------- тема ----------------------------------- */

export function ThemeToggle({ theme }) {
  return <IconButton icon={theme.dark ? Sun : Moon} label={theme.dark ? 'Светлая тема' : 'Тёмная тема'} onClick={theme.toggle} />;
}
