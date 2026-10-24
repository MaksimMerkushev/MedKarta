/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Смена пароля — в профиле и (для старых временных паролей) обязательным
 * окном. Вход — auth/AuthFlow.jsx, регистрация — auth/RegisterPage.jsx.
 * Если включена двухфакторная защита, сервер попросит подтвердить личность
 * (reauth_required) — окно подтверждения откроет ReauthProvider.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock } from 'lucide-react';

import { PASSWORD_LIMITS, passwordProblem } from '@shared/passwordPolicy.js';
import { PasswordStrength } from '../auth/parts';
import { changePassword } from '../services/account';
import { useReauth } from './hooks';
import { Button, inputClass } from './kit';

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
          maxLength={PASSWORD_LIMITS.MAX}
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

/** Подсказка к новому паролю — те же правила, что на сервере (shared/passwordPolicy.js). */
const hint = (password, repeat, email) => {
  if (!password) return '';
  const problem = passwordProblem(password, { email });
  if (problem) return problem;
  if (repeat && repeat !== password) return 'Пароли не совпадают.';
  return '';
};

export function PasswordChangeForm({ onDone, temporary = false, autoFocus = temporary, submitLabel = 'Сменить пароль', email = '' }) {
  const ids = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const firstRef = useRef(null);
  const { withReauth } = useReauth();

  useEffect(() => {
    // Фокус — только в обязательной смене пароля (модальное окно), не в профиле.
    if (autoFocus) firstRef.current?.focus();
  }, [autoFocus]);

  const problem = hint(next, repeat, email);
  const ready = current && next && repeat && !problem;

  const submit = async (event) => {
    event.preventDefault();
    if (!ready || pending) return;
    setError('');
    setPending(true);
    try {
      const result = await withReauth(() => changePassword({ currentPassword: current, newPassword: next }));
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
      <div>
        <PasswordInput id={`${ids}-next`} label="Новый пароль" value={next} onChange={setNext} autoComplete="new-password" testId="password-next" />
        <PasswordStrength password={next} email={email} />
      </div>
      <PasswordInput id={`${ids}-repeat`} label="Повторите новый пароль" value={repeat} onChange={setRepeat} autoComplete="new-password" testId="password-repeat" />
      <p className={`text-[12px] ${problem ? 'text-amber-700 dark:text-amber-300' : 'text-slate-500 dark:text-slate-400'}`}>
        {problem || `Не короче ${PASSWORD_LIMITS.MIN} символов — удобно взять фразу из 3–4 слов; не из частых паролей и без email. После смены все другие сессии завершатся.`}
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
          <PasswordChangeForm temporary email={user?.email} onDone={onDone} submitLabel="Сохранить и продолжить" />
        </div>
        {onLogout && (
          <button type="button" onClick={onLogout} className="mt-3 text-[12.5px] font-semibold text-slate-500 hover:underline dark:text-slate-400">Выйти</button>
        )}
      </div>
    </div>
  );
}
