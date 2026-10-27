/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Вход в два шага: сначала email, потом пароль. Первый шаг ничего не
 * спрашивает у сервера — по нему нельзя узнать, есть ли аккаунт. Второй шаг
 * одинаков для всех: и для активированного аккаунта, и для ещё не
 * активированного, и для несуществующего. Кто ещё не задал пароль, проходит
 * по ссылке-приглашению; если её нет — «Нет пароля или забыли его?»:
 * ссылка на почту (если почта настроена) или к администратору.
 *
 * Если у аккаунта включена двухфакторная защита, после пароля — третий шаг:
 * ключ доступа, код из приложения или резервный код (SecondFactor.jsx).
 * Если открыта регистрация — ссылка «Создать аккаунт» на /register.
 *
 * Одна и та же форма — на странице /login, в окне кабинета на карте, в
 * профиле и на входе в админ-панель.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion as Motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, LogIn, Mail, MailCheck, Send, UserPlus } from 'lucide-react';

import { fetchMfaLoginOptions, requestAccessLink, verifyMfaLogin } from '../services/account';
import { navigate } from '../ui/navigation';
import AutoHeight from './AutoHeight';
import { AuthButton, FormError, PasswordField, SuccessMark, TextAction, TextField } from './parts';
import SecondFactorForm from './SecondFactor';
import { stepTransition, stepVariants } from './motion';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@]+\.[^\s@]{2,}$/u;
const RESEND_SECONDS = 60;

const formatUntil = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Текст ошибки входа: что случилось и что делать — без «извините» и без подробностей, которых не должно быть. */
const loginError = (error) => {
  switch (error?.code) {
    case 'bad_credentials':
      return 'Неверный email или пароль. Если вы ещё не задавали пароль, откройте ссылку из приглашения.';
    case 'account_blocked': {
      const until = error.payload?.blockedUntil ? ` до ${formatUntil(error.payload.blockedUntil)} (МСК)` : '';
      const reason = error.payload?.reason ? ` Причина: ${error.payload.reason}.` : '';
      return `Аккаунт заблокирован${until}.${reason} Обратитесь к администратору.`;
    }
    case 'too_many_attempts':
      return `${error.message || 'Слишком много неудачных попыток.'} Если пароль забыт — задайте новый по ссылке.`;
    case 'rate_limited':
      return 'Слишком много попыток с этого устройства. Подождите несколько минут.';
    default:
      return error?.message || 'Не получилось войти. Попробуйте ещё раз.';
  }
};

/** Фокус — в главное поле шага, как только шаг появился (без прокрутки страницы). */
const useFocusOnMount = (enabled = true) => {
  const ref = useRef(null);
  useEffect(() => {
    if (enabled) ref.current?.focus({ preventScroll: true });
  }, [enabled]);
  return ref;
};

const HEADING_SIZES = {
  1: 'text-[28px] leading-[34px]',
  2: 'text-[22px] leading-7',
  3: 'text-[19px] leading-[26px]',
};

function StepTitle({ level, children, description = null }) {
  const Heading = `h${level}`;
  return (
    <div className={level === 3 ? 'mb-4' : 'mb-6'}>
      <Heading className={`font-semibold tracking-[-0.015em] text-slate-900 dark:text-white ${HEADING_SIZES[level]}`}>{children}</Heading>
      {description && <p className="mt-2 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">{description}</p>}
    </div>
  );
}

/** Адрес, введённый на первом шаге, — с кнопкой «Изменить». */
function EmailChip({ email, onChange }) {
  return (
    <div className="mb-5 flex items-center justify-between gap-3 rounded-[10px] border border-slate-200 bg-slate-50 py-2 pl-3.5 pr-2 dark:border-slate-800 dark:bg-slate-900/60">
      <span className="flex min-w-0 items-center gap-2 text-[14.5px] text-slate-700 dark:text-slate-200">
        <Mail size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
        <span className="truncate" data-testid="auth-email-chip">{email}</span>
      </span>
      <TextAction onClick={onChange} className="shrink-0 px-2 py-1" data-testid="auth-change-email">Изменить</TextAction>
    </div>
  );
}

function EmailStep({ level, title, description, email, setEmail, onNext, autoFocus, registration }) {
  const errorId = useId();
  const inputRef = useFocusOnMount(autoFocus);
  const [error, setError] = useState('');
  const submit = (event) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setError(value ? 'Проверьте email: нужен адрес вида name@example.ru.' : 'Введите email.');
      inputRef.current?.focus();
      return;
    }
    setError('');
    onNext(value);
  };
  return (
    <form onSubmit={submit} noValidate data-testid="auth-step-email">
      <StepTitle level={level} description={description}>{title}</StepTitle>
      <div className="space-y-4">
        <TextField
          ref={inputRef}
          label="Email"
          type="email"
          name="username"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="name@example.ru"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError('');
          }}
          invalid={Boolean(error)}
          describedBy={error ? errorId : null}
          data-testid="login-email"
        />
        <FormError id={errorId} message={error} />
        <Motion.div layout="position" className="space-y-4">
          <AuthButton type="submit" data-testid="login-continue">Продолжить</AuthButton>
          {registration && (
            <p className="text-center text-[14px] text-slate-600 dark:text-slate-300">
              Нет аккаунта?{' '}
              <TextAction onClick={() => navigate('/register')} className="inline-flex items-center gap-1 px-1 py-1" data-testid="auth-register">
                <UserPlus size={15} aria-hidden="true" />Создать аккаунт
              </TextAction>
            </p>
          )}
        </Motion.div>
      </div>
    </form>
  );
}

function PasswordStep({ level, email, onBack, onLogin, onHelp, onDone }) {
  const errorId = useId();
  const inputRef = useFocusOnMount();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (!password || pending) {
      if (!password) setError({ message: 'Введите пароль.' });
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await onLogin({ email, password });
      setPassword('');
      onDone(result);
    } catch (failure) {
      setError({ message: loginError(failure), code: failure?.code });
      setPending(false);
      inputRef.current?.select();
    }
  };

  return (
    <form onSubmit={submit} noValidate data-testid="auth-step-password">
      <StepTitle level={level}>Введите пароль</StepTitle>
      <EmailChip email={email} onChange={onBack} />
      {/* Менеджер паролей сопоставляет пароль с адресом из этого поля. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <div className="space-y-4">
        <PasswordField
          ref={inputRef}
          label="Пароль"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (error) setError(null);
          }}
          invalid={Boolean(error)}
          describedBy={error ? errorId : null}
          data-testid="login-password"
        />
        <FormError id={errorId} message={error?.message} />
        <Motion.div layout="position" className="space-y-4">
          <AuthButton type="submit" icon={LogIn} loading={pending} loadingLabel="Входим…" data-testid="login-submit">Войти</AuthButton>
          <div className="text-center">
            <TextAction onClick={onHelp} className="px-2 py-1" data-testid="auth-no-password">Нет пароля или забыли его?</TextAction>
          </div>
        </Motion.div>
      </div>
    </form>
  );
}

function MfaStep({ level, email, methods, onBack, onVerified, onDone }) {
  return (
    <div data-testid="auth-step-mfa">
      <StepTitle level={level} description="Для этого аккаунта включена двухфакторная защита.">Подтвердите вход</StepTitle>
      <EmailChip email={email} onChange={onBack} />
      <SecondFactorForm
        methods={methods}
        submitLabel="Войти"
        getPasskeyOptions={async () => (await fetchMfaLoginOptions()).passkey}
        onSubmit={async (factor) => {
          const payload = await verifyMfaLogin(factor);
          onDone(await onVerified(payload));
        }}
        onFatal={onBack}
      />
    </div>
  );
}

function AccessStep({ level, email, setEmail, emailLinks, support, onBack, onSent }) {
  const errorId = useId();
  const inputRef = useFocusOnMount(emailLinks);
  const backRef = useFocusOnMount(!emailLinks);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setError('Проверьте email: нужен адрес вида name@example.ru.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await requestAccessLink(value);
      onSent(value);
    } catch (failure) {
      setError(failure?.message || 'Не получилось отправить ссылку. Попробуйте ещё раз.');
      setPending(false);
    }
  };

  if (!emailLinks) {
    return (
      <div data-testid="auth-step-access">
        <StepTitle level={level} description="Пароль задаётся по ссылке-приглашению, которую присылает администратор МедКарты.">Как войти без пароля</StepTitle>
        <ol className="mb-6 space-y-3 text-[15px] leading-[22px] text-slate-700 dark:text-slate-200">
          <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[13px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300" aria-hidden="true">1</span>Найдите письмо или сообщение с приглашением и откройте ссылку.</li>
          <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[13px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300" aria-hidden="true">2</span>Придумайте пароль — после этого вход по email и паролю.</li>
          <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[13px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300" aria-hidden="true">3</span>Ссылки нет, срок истёк или пароль забыт — попросите администратора прислать новую.</li>
        </ol>
        {(support?.email || support?.phone) && (
          <p className="mb-6 rounded-[10px] bg-slate-50 px-3.5 py-3 text-[14px] leading-5 text-slate-600 dark:bg-slate-900/60 dark:text-slate-300" data-testid="auth-support">
            Поддержка МедКарты:{' '}
            {support.email && <a className="font-medium text-blue-700 underline-offset-4 hover:underline dark:text-blue-300" href={`mailto:${support.email}`}>{support.email}</a>}
            {support.email && support.phone && ', '}
            {support.phone && <a className="font-medium text-blue-700 underline-offset-4 hover:underline dark:text-blue-300" href={`tel:${support.phone.replace(/[^\d+]/g, '')}`}>{support.phone}</a>}
          </p>
        )}
        <AuthButton ref={backRef} variant="secondary" icon={ArrowLeft} onClick={onBack} data-testid="auth-back">Вернуться ко входу</AuthButton>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate data-testid="auth-step-access">
      <StepTitle level={level} description="Пришлём на почту ссылку: по ней можно задать пароль — и при первом входе, и если пароль забыт.">Ссылка для входа</StepTitle>
      <div className="space-y-4">
        <TextField
          ref={inputRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError('');
          }}
          invalid={Boolean(error)}
          describedBy={error ? errorId : null}
          data-testid="access-email"
        />
        <FormError id={errorId} message={error} />
        <Motion.div layout="position" className="space-y-3">
          <AuthButton type="submit" icon={Send} loading={pending} loadingLabel="Отправляем…" data-testid="access-submit">Отправить ссылку</AuthButton>
          <AuthButton variant="secondary" icon={ArrowLeft} onClick={onBack} data-testid="auth-back">Вернуться ко входу</AuthButton>
        </Motion.div>
      </div>
    </form>
  );
}

function SentStep({ level, email, onBack }) {
  const backRef = useFocusOnMount();
  const [left, setLeft] = useState(RESEND_SECONDS);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  const resend = async () => {
    setPending(true);
    setNote('');
    try {
      await requestAccessLink(email);
      setNote('Отправили ещё раз.');
      setLeft(RESEND_SECONDS);
    } catch (failure) {
      setNote(failure?.message || 'Не получилось отправить. Попробуйте позже.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-testid="auth-step-sent">
      <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" aria-hidden="true">
        <MailCheck size={24} />
      </span>
      <StepTitle level={level}>Проверьте почту</StepTitle>
      <p className="-mt-3 mb-6 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        Если для <span className="font-medium text-slate-900 dark:text-white">{email}</span> есть аккаунт, мы отправили на этот адрес ссылку для входа. Письмо приходит в течение пары минут; проверьте и папку «Спам». Ссылка одноразовая.
      </p>
      <div className="space-y-3">
        <AuthButton ref={backRef} variant="secondary" icon={ArrowLeft} onClick={onBack} data-testid="auth-back">Вернуться ко входу</AuthButton>
        <div className="text-center text-[14px] text-slate-500 dark:text-slate-400" aria-live="polite">
          {left > 0
            ? <span>Отправить ещё раз можно через {left} с</span>
            : <TextAction onClick={resend} disabled={pending} className="px-2 py-1" data-testid="access-resend">{pending ? 'Отправляем…' : 'Отправить ещё раз'}</TextAction>}
          {note && <p className="mt-1">{note}</p>}
        </div>
      </div>
    </div>
  );
}

function SuccessStep({ level, title = 'Вы вошли', description = 'Открываем МедКарту…' }) {
  return (
    <div className="flex flex-col items-start" role="status" data-testid="auth-step-success">
      <div className="mb-5"><SuccessMark size={56} /></div>
      <StepTitle level={level} description={description}>{title}</StepTitle>
    </div>
  );
}

/**
 * @param {object} props
 * @param {(credentials: {email: string, password: string}) => Promise<any>} props.onLogin вход; ошибка — исключение с code;
 *   ответ {mfaRequired, methods} — нужен второй шаг
 * @param {(payload: any) => any} [props.onVerified] вход завершён вторым фактором (сообщить приложению о сессии)
 * @param {(result: any) => void} [props.onSuccess] после входа (на странице — после короткого «Вы вошли»)
 * @param {{emailLinks?: boolean}} [props.features]
 * @param {{email?: string, phone?: string}} [props.support] контакты поддержки из настроек
 * @param {'page'|'panel'} [props.variant] page — отдельная страница, panel — окно или карточка
 * @param {1|2|3} [props.headingLevel] уровень заголовков шагов (по умолчанию: page — 1, panel — 2)
 * @param {'email'|'access'} [props.initialStep] access — сразу «нет пароля / забыли» (из письма или со страницы ссылки)
 */
export default function AuthFlow({
  onLogin,
  onVerified = (payload) => payload,
  onSuccess = null,
  features = {},
  support = {},
  variant = 'panel',
  title = 'Вход в МедКарту',
  description = 'Введите email, на который создан ваш аккаунт.',
  autoFocus = true,
  footer = null,
  initialStep = 'email',
  headingLevel = null,
}) {
  const level = headingLevel || (variant === 'page' ? 1 : 2);
  const [step, setStep] = useState(initialStep === 'access' ? 'access' : 'email');
  const [direction, setDirection] = useState(1);
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [mfaMethods, setMfaMethods] = useState([]);
  // prefers-reduced-motion: шаг сменяется без сдвига, только прозрачностью.
  const shift = useReducedMotion() ? 0 : direction;
  const announce = { email: 'Шаг 1: email', password: 'Шаг 2: пароль', mfa: 'Шаг 3: подтверждение входа', access: 'Ссылка для входа', sent: 'Ссылка отправлена', success: 'Вход выполнен' }[step];

  const go = (next, dir = 1) => {
    setDirection(dir);
    setStep(next);
  };

  const done = (result) => {
    if (variant === 'page') {
      go('success');
      // Короткий знак успеха — и в приложение; при reduced motion пауза та же: это время прочитать «Вы вошли».
      setTimeout(() => onSuccess?.(result), 900);
    } else {
      onSuccess?.(result);
    }
  };

  let content;
  if (step === 'email') {
    content = <EmailStep level={level} title={title} description={description} email={email} setEmail={setEmail} autoFocus={autoFocus} registration={Boolean(features.registration)} onNext={(value) => { setEmail(value); go('password'); }} />;
  } else if (step === 'password') {
    const afterPassword = (result) => {
      if (result?.mfaRequired) {
        setMfaMethods(Array.isArray(result.methods) ? result.methods : []);
        go('mfa');
      } else {
        done(result);
      }
    };
    content = <PasswordStep level={level} email={email} onBack={() => go('email', -1)} onLogin={onLogin} onHelp={() => go('access')} onDone={afterPassword} />;
  } else if (step === 'mfa') {
    content = <MfaStep level={level} email={email} methods={mfaMethods} onBack={() => go('password', -1)} onVerified={onVerified} onDone={done} />;
  } else if (step === 'access') {
    content = <AccessStep level={level} email={email} setEmail={setEmail} emailLinks={Boolean(features.emailLinks)} support={support} onBack={() => go(email ? 'password' : 'email', -1)} onSent={(value) => { setSentTo(value); go('sent'); }} />;
  } else if (step === 'sent') {
    content = <SentStep level={level} email={sentTo} onBack={() => go('email', -1)} />;
  } else {
    content = <SuccessStep level={level} />;
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="w-full" data-testid="auth-flow" data-step={step}>
        <p className="sr-only" aria-live="polite">{announce}</p>
        <AutoHeight>
          <AnimatePresence mode="popLayout" initial={false} custom={shift}>
            <Motion.div
              key={step}
              custom={shift}
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stepTransition}
              className="w-full"
            >
              {content}
            </Motion.div>
          </AnimatePresence>
        </AutoHeight>
        {footer && step !== 'success' && <div className="mt-6">{footer}</div>}
      </div>
    </MotionConfig>
  );
}
