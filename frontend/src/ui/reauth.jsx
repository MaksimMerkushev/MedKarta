/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Окно «Подтвердите, что это вы»: пароль и — если включена двухфакторная
 * защита — второй фактор. Нужно перед сменой пароля и email, изменением
 * факторов входа, новыми резервными кодами и критичными действиями в
 * админ-панели. Подтверждение действует несколько минут; сессия при этом
 * заменяется новой (новый токен).
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';

import { fetchReauthOptions, reauthenticate } from '../services/account';
import { AuthButton, FormError, PasswordField } from '../auth/parts';
import SecondFactorForm from '../auth/SecondFactor';
import { ReauthContext } from './hooks';
import { Modal } from './kit';

function ReauthDialog({ onDone, onCancel }) {
  const errorId = useId();
  const [step, setStep] = useState('password');
  const [password, setPassword] = useState('');
  const [methods, setMethods] = useState([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const submitPassword = async (event) => {
    event.preventDefault();
    if (pending) return;
    if (!password) {
      setError('Введите пароль.');
      inputRef.current?.focus();
      return;
    }
    setPending(true);
    setError('');
    try {
      const options = await fetchReauthOptions();
      if (options.methods?.length) {
        setMethods(options.methods);
        setStep('factor');
        setPending(false);
        return;
      }
      await reauthenticate({ password });
      onDone();
    } catch (failure) {
      setError(failure?.message || 'Не получилось подтвердить.');
      setPending(false);
      inputRef.current?.select();
    }
  };

  return (
    <Modal
      title="Подтвердите, что это вы"
      description={step === 'password' ? 'Это важное действие. Введите пароль от аккаунта.' : 'И подтвердите вторым фактором.'}
      onClose={onCancel}
      busy={pending}
      size="sm"
    >
      <div className="mk-auth" data-testid="reauth-dialog" data-step={step}>
        {step === 'password' ? (
          <form onSubmit={submitPassword} noValidate className="space-y-4">
            <PasswordField
              ref={inputRef}
              label="Пароль"
              name="current-password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) setError('');
              }}
              invalid={Boolean(error)}
              describedBy={error ? errorId : null}
              data-testid="reauth-password"
            />
            <FormError id={errorId} message={error} />
            <AuthButton type="submit" icon={ShieldCheck} loading={pending} loadingLabel="Проверяем…" data-testid="reauth-submit">Продолжить</AuthButton>
          </form>
        ) : (
          <SecondFactorForm
            methods={methods}
            getPasskeyOptions={async () => (await fetchReauthOptions()).passkey}
            onSubmit={async (factor) => {
              try {
                await reauthenticate({ password, ...factor });
              } catch (failure) {
                // Пароль сменили в другой вкладке или он оказался неверным — назад к паролю.
                if (failure?.code === 'bad_password') {
                  setStep('password');
                  setPassword('');
                  setError(failure.message);
                  return;
                }
                throw failure;
              }
              onDone();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

export function ReauthProvider({ children }) {
  const [open, setOpen] = useState(false);
  const pending = useRef(null);

  const confirm = useCallback(() => new Promise((resolve) => {
    pending.current = resolve;
    setOpen(true);
  }), []);

  const finish = useCallback((ok) => {
    setOpen(false);
    pending.current?.(ok);
    pending.current = null;
  }, []);

  const withReauth = useCallback(async (work) => {
    try {
      return await work();
    } catch (error) {
      if (error?.code !== 'reauth_required') throw error;
      const ok = await confirm();
      if (!ok) {
        const cancelled = new Error('Действие отменено: личность не подтверждена.');
        cancelled.code = 'reauth_cancelled';
        throw cancelled;
      }
      return work();
    }
  }, [confirm]);

  const value = useMemo(() => ({ confirm, withReauth }), [confirm, withReauth]);
  return (
    <ReauthContext.Provider value={value}>
      {children}
      {open && <ReauthDialog onDone={() => finish(true)} onCancel={() => finish(false)} />}
    </ReauthContext.Provider>
  );
}
