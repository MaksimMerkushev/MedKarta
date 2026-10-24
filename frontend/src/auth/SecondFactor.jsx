/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Второй фактор: ключ доступа, код из приложения-аутентификатора или
 * резервный код. Одна форма — для входа, для подтверждения личности перед
 * важным действием и для админ-панели. Сам запрос делает вызывающий
 * (onSubmit); здесь — выбор способа, ввод и понятные ошибки.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { motion as Motion } from 'motion/react';
import { Fingerprint, KeyRound, LifeBuoy, ShieldCheck, Smartphone } from 'lucide-react';

import { AuthButton, FormError, TextAction, TextField } from './parts';
import { getPasskeyAssertion, passkeyErrorMessage, passkeysSupported } from './webauthn';

export const METHOD_LABELS = {
  webauthn: 'Ключ доступа',
  totp: 'Приложение-аутентификатор',
  recovery: 'Резервный код',
};

/** Текст ошибки второго шага: что не так и сколько попыток осталось. */
export const secondFactorError = (error) => {
  switch (error?.code) {
    case 'bad_mfa_code': {
      const left = error.payload?.attemptsLeft;
      return `${error.message}${Number.isInteger(left) && left <= 3 ? ` Осталось попыток: ${left}.` : ''}`;
    }
    case 'too_many_attempts':
      return error.message || 'Слишком много неверных кодов. Подождите 15 минут.';
    case 'mfa_expired':
      return 'Время на подтверждение вышло. Войдите заново.';
    default:
      return error?.message || 'Не получилось проверить. Попробуйте ещё раз.';
  }
};

const firstMethod = (methods) => {
  if (methods.includes('webauthn') && passkeysSupported()) return 'webauthn';
  if (methods.includes('totp')) return 'totp';
  if (methods.includes('recovery')) return 'recovery';
  return methods[0] || 'totp';
};

/**
 * @param {object} props
 * @param {string[]} props.methods доступные способы: webauthn, totp, recovery
 * @param {() => Promise<object|null>} props.getPasskeyOptions свежий вызов для ключа доступа
 * @param {(factor: {method: string, code?: string, credential?: object}) => Promise<any>} props.onSubmit проверка на сервере
 * @param {(error: any) => void} [props.onFatal] ошибка, после которой форма бессмысленна (истёк вызов)
 * @param {string} [props.submitLabel]
 * @param {boolean} [props.autoFocus]
 */
export default function SecondFactorForm({ methods = [], getPasskeyOptions, onSubmit, onFatal = null, submitLabel = 'Подтвердить', autoFocus = true }) {
  const errorId = useId();
  const [method, setMethod] = useState(() => firstMethod(methods));
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const passkeyRef = useRef(null);
  const supported = passkeysSupported();

  useEffect(() => {
    if (!autoFocus) return;
    if (method === 'webauthn') passkeyRef.current?.focus({ preventScroll: true });
    else inputRef.current?.focus({ preventScroll: true });
  }, [method, autoFocus]);

  const fail = (failure) => {
    if (failure?.code === 'mfa_expired' && onFatal) {
      onFatal(failure);
      return;
    }
    setError(secondFactorError(failure));
    setPending(false);
  };

  const send = async (factor) => {
    setPending(true);
    setError('');
    try {
      await onSubmit(factor);
    } catch (failure) {
      fail(failure);
      if (factor.method !== 'webauthn') {
        setCode('');
        inputRef.current?.focus();
      }
    }
  };

  const usePasskey = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    let credential;
    try {
      const options = await getPasskeyOptions();
      if (!options) {
        setError('Ключи доступа для этого аккаунта недоступны. Выберите другой способ.');
        setPending(false);
        return;
      }
      credential = await getPasskeyAssertion(options);
    } catch (failure) {
      // Ошибка браузера (отмена, нет ключа) — без запроса на сервер.
      if (failure?.status) fail(failure);
      else {
        setError(passkeyErrorMessage(failure));
        setPending(false);
      }
      return;
    }
    await send({ method: 'webauthn', credential });
  };

  const submitCode = (event) => {
    event.preventDefault();
    if (pending) return;
    const clean = method === 'totp' ? code.replace(/\D/gu, '') : code.trim();
    if (method === 'totp' && clean.length !== 6) {
      setError('Введите 6 цифр из приложения.');
      inputRef.current?.focus();
      return;
    }
    if (method === 'recovery' && clean.replace(/[\s-]/gu, '').length < 10) {
      setError('Резервный код — 10 символов, например abcde-23456.');
      inputRef.current?.focus();
      return;
    }
    send({ method, code: clean });
  };

  const switchTo = (next) => {
    setMethod(next);
    setCode('');
    setError('');
  };

  const others = ['webauthn', 'totp', 'recovery'].filter((item) => item !== method && methods.includes(item) && (item !== 'webauthn' || supported));

  return (
    <div data-testid="second-factor" data-method={method}>
      {method === 'webauthn' ? (
        <div className="space-y-4">
          <p className="text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
            Подтвердите отпечатком, лицом, PIN-кодом устройства или аппаратным ключом.
          </p>
          <FormError id={errorId} message={error} />
          <AuthButton ref={passkeyRef} icon={Fingerprint} loading={pending} loadingLabel="Ждём подтверждения…" onClick={usePasskey} data-testid="mfa-passkey">
            Использовать ключ доступа
          </AuthButton>
        </div>
      ) : (
        <form onSubmit={submitCode} noValidate className="space-y-4">
          {method === 'totp' ? (
            <TextField
              ref={inputRef}
              label="Код из приложения"
              hint="6 цифр из Яндекс Ключа, Google Authenticator или другого приложения. Код меняется каждые 30 секунд."
              name="one-time-code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={7}
              placeholder="123456"
              value={code}
              onChange={(event) => {
                const value = event.target.value.replace(/[^\d ]/gu, '');
                setCode(value);
                if (error) setError('');
                // Шесть цифр набраны (или вставлены) — проверяем сразу.
                if (value.replace(/\D/gu, '').length === 6 && !pending) send({ method: 'totp', code: value.replace(/\D/gu, '') });
              }}
              invalid={Boolean(error)}
              describedBy={error ? errorId : null}
              className="[&_input]:tracking-[0.3em]"
              data-testid="mfa-code"
            />
          ) : (
            <TextField
              ref={inputRef}
              label="Резервный код"
              hint="Один из кодов, сохранённых при настройке защиты. Каждый срабатывает один раз."
              name="recovery-code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={24}
              placeholder="abcde-23456"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                if (error) setError('');
              }}
              invalid={Boolean(error)}
              describedBy={error ? errorId : null}
              data-testid="mfa-recovery"
            />
          )}
          <FormError id={errorId} message={error} />
          <Motion.div layout="position">
            <AuthButton type="submit" icon={method === 'totp' ? ShieldCheck : KeyRound} loading={pending} loadingLabel="Проверяем…" data-testid="mfa-submit">{submitLabel}</AuthButton>
          </Motion.div>
        </form>
      )}
      {others.length > 0 && (
        <div className="mt-4 flex flex-col items-center gap-1 text-center" data-testid="mfa-other-methods">
          {others.map((item) => (
            <TextAction key={item} onClick={() => switchTo(item)} className="inline-flex items-center gap-1.5 px-2 py-1" data-testid={`mfa-use-${item}`}>
              {item === 'webauthn' ? <Fingerprint size={15} aria-hidden="true" /> : item === 'totp' ? <Smartphone size={15} aria-hidden="true" /> : <LifeBuoy size={15} aria-hidden="true" />}
              {item === 'webauthn' ? 'Войти с ключом доступа' : item === 'totp' ? 'Ввести код из приложения' : 'Использовать резервный код'}
            </TextAction>
          ))}
        </div>
      )}
      {methods.includes('webauthn') && !supported && method !== 'webauthn' && (
        <p className="mt-3 text-center text-[13px] leading-5 text-slate-500 dark:text-slate-400">Ключ доступа на этом устройстве недоступен — используйте код.</p>
      )}
    </div>
  );
}
