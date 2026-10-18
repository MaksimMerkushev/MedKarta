/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Вход и смена пароля — одни и те же формы на карте, в профиле и в
 * админ-панели. Регистрации нет: аккаунты выдаёт администратор.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, LogIn, Mail, ShieldAlert } from 'lucide-react';

import { changePassword } from '../services/account';
import { Button, inputClass } from './kit';
import { formatDateTime } from './format';

function PasswordInput({ id, value, onChange, autoComplete, label, inputRef = null, testId }) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">{label}</label>
      <div className="relative">
        <Lock size={16} className="pointer-events-none absolute left-3 top-3 text-slate-400" aria-hidden="true" />
        <input
          id={id}
          ref={inputRef}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          maxLength={128}
          className={`${inputClass} pl-9 pr-11`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-testid={testId}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
        >
          {visible ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

/** Понятное сообщение об ошибке входа; о блокировке — с причиной и сроком. */
const loginErrorText = (error) => {
  if (!error) return '';
  if (error.code === 'account_blocked') {
    const until = error.payload?.blockedUntil ? ` до ${formatDateTime(error.payload.blockedUntil)} (МСК)` : '';
    const reason = error.payload?.reason ? ` Причина: ${error.payload.reason}` : '';
    return `Аккаунт заблокирован${until}.${reason}`;
  }
  return error.message || 'Не получилось войти.';
};

export function LoginForm({ onLogin, autoFocus = true, submitLabel = 'Войти' }) {
  const ids = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const emailRef = useRef(null);

  useEffect(() => {
    if (autoFocus) emailRef.current?.focus();
  }, [autoFocus]);

  const submit = async (event) => {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onLogin({ email: email.trim(), password });
    } catch (failure) {
      setError(failure);
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  const blocked = error?.code === 'account_blocked' || error?.code === 'account_inactive';
  return (
    <form className="space-y-3" onSubmit={submit} noValidate data-testid="login-form">
      <div>
        <label htmlFor={`${ids}-email`} className="mb-1 block text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">Email</label>
        <div className="relative">
          <Mail size={16} className="pointer-events-none absolute left-3 top-3 text-slate-400" aria-hidden="true" />
          <input
            id={`${ids}-email`}
            ref={emailRef}
            type="email"
            inputMode="email"
            autoComplete="username"
            maxLength={254}
            className={`${inputClass} pl-9`}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            data-testid="login-email"
          />
        </div>
      </div>
      <PasswordInput id={`${ids}-password`} label="Пароль" value={password} onChange={setPassword} autoComplete="current-password" testId="login-password" />
      {error && (
        <p className={`flex gap-2 rounded-xl px-3 py-2 text-[13px] leading-5 ${blocked ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200' : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'}`} role="alert" data-testid="login-error">
          {blocked && <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
          <span>{loginErrorText(error)}</span>
        </p>
      )}
      <Button type="submit" variant="primary" size="lg" icon={LogIn} loading={pending} disabled={!email || !password} className="w-full" data-testid="login-submit">
        {submitLabel}
      </Button>
      <p className="text-center text-[12px] leading-5 text-slate-500 dark:text-slate-400">
        Регистрации нет: аккаунт выдаёт администратор. Забыли пароль — обратитесь к нему.
      </p>
    </form>
  );
}

/** Подсказка к новому паролю — та же логика, что на сервере (passwords.js), чтобы ошибок было меньше. */
const hint = (password, repeat) => {
  if (!password) return '';
  if (password.length < 8) return 'Не короче 8 символов.';
  if (/^\d+$/.test(password)) return 'Не только цифры.';
  if (/^(.)\1+$/u.test(password)) return 'Не один повторяющийся символ.';
  if (repeat && repeat !== password) return 'Пароли не совпадают.';
  return '';
};

export function PasswordChangeForm({ onDone, temporary = false, autoFocus = temporary, submitLabel = 'Сменить пароль' }) {
  const ids = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => {
    // Фокус — только в обязательной смене пароля (модальное окно), не в профиле.
    if (autoFocus) firstRef.current?.focus();
  }, [autoFocus]);

  const problem = hint(next, repeat);
  const ready = current && next && repeat && !problem;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready || pending) return;
    setError('');
    setPending(true);
    try {
      const result = await changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setRepeat('');
      await onDone?.(result.user);
    } catch (failure) {
      setError(failure?.message || 'Не получилось сменить пароль.');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit} noValidate data-testid="password-form">
      <PasswordInput id={`${ids}-current`} inputRef={firstRef} label={temporary ? 'Временный пароль' : 'Текущий пароль'} value={current} onChange={setCurrent} autoComplete="current-password" testId="password-current" />
      <PasswordInput id={`${ids}-next`} label="Новый пароль" value={next} onChange={setNext} autoComplete="new-password" testId="password-next" />
      <PasswordInput id={`${ids}-repeat`} label="Повторите новый пароль" value={repeat} onChange={setRepeat} autoComplete="new-password" testId="password-repeat" />
      <p className={`text-[12px] ${problem ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}`}>
        {problem || 'Не короче 8 символов, не только цифры и не содержит email. После смены все другие сессии завершатся.'}
      </p>
      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/50 dark:text-red-300" role="alert">{error}</p>}
      <Button type="submit" variant="primary" icon={KeyRound} loading={pending} disabled={!ready} data-testid="password-submit">{submitLabel}</Button>
    </form>
  );
}

/** Экран вместо интерфейса, пока временный пароль не сменён. */
export function ForcedPasswordChange({ user, onDone, onLogout }) {
  return (
    <div className="fixed inset-0 z-[1500] flex items-center justify-center overflow-y-auto bg-slate-950/60 p-4 backdrop-blur-sm" data-testid="forced-password-change">
      <div role="dialog" aria-modal="true" aria-labelledby="forced-password-title" className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl dark:bg-slate-900">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" aria-hidden="true">
          <KeyRound size={22} />
        </span>
        <h2 id="forced-password-title" className="mt-3 text-[19px] font-extrabold text-slate-800 dark:text-white">Смените временный пароль</h2>
        <p className="mt-1 text-[13.5px] leading-5 text-slate-600 dark:text-slate-300">
          {user?.displayName ? `${user.displayName}, в` : 'В'}ы вошли с паролем, который выдал администратор. Придумайте свой — до этого остальные функции недоступны.
        </p>
        <div className="mt-4">
          <PasswordChangeForm temporary onDone={onDone} submitLabel="Сохранить и продолжить" />
        </div>
        {onLogout && (
          <button type="button" onClick={onLogout} className="mt-3 text-[12.5px] font-semibold text-slate-500 hover:underline dark:text-slate-400">Выйти</button>
        )}
      </div>
    </div>
  );
}
