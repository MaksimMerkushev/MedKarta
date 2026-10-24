/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Регистрация по email.
 *
 *   /register                  — адрес почты → письмо со ссылкой. Ответ сервера
 *                                одинаков для любого адреса: по нему не узнать,
 *                                есть ли уже аккаунт (владельцу придёт письмо
 *                                «вы уже зарегистрированы»).
 *   /register/confirm#token=…  — «Продолжить» (ссылка гаснет, взамен cookie
 *                                контекста на 30 минут) → пароль и имя →
 *                                аккаунт создан с ролью «Пользователь», вход.
 *
 * Открытие ссылки (peek) ничего не меняет: почтовые сканеры, переходящие по
 * ссылкам, её не «сжигают». Роль из браузера не передаётся вообще.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion as Motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, LogIn, MailCheck, Send, UserPlus } from 'lucide-react';

import { passwordProblem } from '@shared/passwordPolicy.js';
import {
  completeRegistration, fetchRegistrationContext, peekRegistration, requestRegistration, startRegistration,
} from '../services/account';
import { navigate, useLocation } from '../ui/navigation';
import AuthLayout from './AuthLayout';
import AutoHeight from './AutoHeight';
import { AuthSkeleton } from './LoginPage';
import { AuthButton, FormError, PasswordField, PasswordRequirements, PasswordStrength, SuccessMark, TextAction, TextField } from './parts';
import { homeFor, useAuthEnvironment } from './environment';
import { AccountRow, cleanUrl, formatMoscow, Heading, LinkProblem, readTokenFromUrl } from './linkParts';
import { stepTransition, stepVariants } from './motion';

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@]+\.[^\s@]{2,}$/u;
const RESEND_SECONDS = 60;
const REDIRECT_MS = 1400;

const AGAIN = { label: 'Зарегистрироваться заново', to: '/register' };
const PROBLEMS = {
  invalid_link: { title: 'Ссылка не подходит', text: 'Возможно, она скопирована не полностью. Откройте ссылку из письма ещё раз — целиком.', again: AGAIN },
  link_expired: { title: 'Срок действия ссылки истёк', text: 'Ссылка из письма действует ограниченное время. Зарегистрируйтесь ещё раз — придёт новое письмо.', again: AGAIN },
  link_revoked: { title: 'Ссылка больше не действует', text: 'Вы запросили новое письмо — работает ссылка из последнего. Или аккаунт уже создан: тогда просто войдите.', login: true, again: AGAIN },
  link_used: { title: 'Ссылка уже использована', text: 'Каждая ссылка срабатывает один раз. Если вы уже задали пароль — войдите.', login: true, again: AGAIN },
  activation_expired: { title: 'Время на создание пароля истекло', text: 'На пароль даётся 30 минут после подтверждения email — или регистрация уже завершена в другой вкладке.', login: true, again: AGAIN },
  email_taken: { title: 'Аккаунт уже существует', text: 'С этим email уже есть аккаунт. Войдите — или задайте новый пароль через «Нет пароля или забыли его?».', login: true },
  no_link: { title: 'Откройте ссылку из письма', text: 'Эта страница работает только по ссылке из письма с подтверждением email.', again: AGAIN },
  rate_limited: { title: 'Слишком много попыток', text: 'Подождите несколько минут и попробуйте снова.', retry: true },
};

const problemOf = (error) => {
  const known = PROBLEMS[error?.code];
  if (known) return { code: error.code, ...known };
  return { code: error?.code || 'network', title: 'Не получилось открыть ссылку', text: error?.message || 'Проверьте интернет и попробуйте ещё раз.', retry: true };
};

const Steps = ({ stepKey, children }) => {
  const shift = useReducedMotion() ? 0 : 1;
  return (
    <MotionConfig reducedMotion="user">
      <AutoHeight>
        <AnimatePresence mode="popLayout" initial={false} custom={shift}>
          <Motion.div key={stepKey} custom={shift} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={stepTransition}>
            {children}
          </Motion.div>
        </AnimatePresence>
      </AutoHeight>
    </MotionConfig>
  );
};

/* ------------------------------ /register ------------------------------ */

function RequestForm({ initialEmail, onSent }) {
  const errorId = useId();
  const inputRef = useRef(null);
  const [email, setEmail] = useState(initialEmail);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setError(value ? 'Проверьте email: нужен адрес вида name@example.ru.' : 'Введите email.');
      inputRef.current?.focus();
      return;
    }
    setPending(true);
    setError('');
    try {
      await requestRegistration(value);
      onSent(value);
    } catch (failure) {
      setError(failure?.code === 'rate_limited' ? 'Слишком много запросов. Подождите несколько минут.' : failure?.message || 'Не получилось отправить письмо. Попробуйте ещё раз.');
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate data-testid="register-request">
      <Heading focus={false}>Создать аккаунт</Heading>
      <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        Укажите email — пришлём ссылку для подтверждения. Пароль вы зададите после перехода по ней.
      </p>
      <div className="space-y-4">
        <TextField
          ref={inputRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="name@example.ru"
          maxLength={254}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            if (error) setError('');
          }}
          invalid={Boolean(error)}
          describedBy={error ? errorId : null}
          data-testid="register-email"
        />
        <FormError id={errorId} message={error} />
        <Motion.div layout="position" className="space-y-4">
          <AuthButton type="submit" icon={Send} loading={pending} loadingLabel="Отправляем…" data-testid="register-submit">Получить ссылку</AuthButton>
          <p className="text-center text-[14px] text-slate-600 dark:text-slate-300">
            Уже есть аккаунт?{' '}
            <TextAction onClick={() => navigate('/login')} className="px-1 py-1" data-testid="register-to-login">Войти</TextAction>
          </p>
        </Motion.div>
      </div>
      <p className="mt-6 text-[13px] leading-5 text-slate-500 dark:text-slate-400">
        МедКарта — справочный сервис: в аккаунте хранятся избранное, программа ДМС и демо-записи. Медицинские документы сюда не загружаются.
      </p>
    </form>
  );
}

function SentNotice({ email, onChangeEmail }) {
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
      await requestRegistration(email);
      setNote('Отправили ещё раз. Действует ссылка из последнего письма.');
      setLeft(RESEND_SECONDS);
    } catch (failure) {
      setNote(failure?.message || 'Не получилось отправить. Попробуйте позже.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-testid="register-sent">
      <span className="mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" aria-hidden="true">
        <MailCheck size={24} />
      </span>
      <Heading>Проверьте почту</Heading>
      <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        Мы отправили письмо на <span className="font-medium text-slate-900 dark:text-white" data-testid="register-sent-email">{email}</span>. Откройте ссылку из него, чтобы подтвердить адрес и задать пароль. Письмо приходит в течение пары минут; проверьте и папку «Спам».
      </p>
      <div className="space-y-3">
        <AuthButton variant="secondary" icon={ArrowLeft} onClick={onChangeEmail} data-testid="register-change-email">Изменить email</AuthButton>
        <div className="text-center text-[14px] text-slate-500 dark:text-slate-400" aria-live="polite">
          {left > 0
            ? <span>Отправить ещё раз можно через {left} с</span>
            : <TextAction onClick={resend} disabled={pending} className="px-2 py-1" data-testid="register-resend">{pending ? 'Отправляем…' : 'Отправить письмо ещё раз'}</TextAction>}
          {note && <p className="mt-1">{note}</p>}
        </div>
      </div>
    </div>
  );
}

function RegistrationClosed({ mode }) {
  return (
    <div data-testid="register-closed">
      <Heading>{mode === 'open' ? 'Регистрация временно недоступна' : 'Регистрация по приглашению'}</Heading>
      <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        {mode === 'open'
          ? 'Сейчас не работает отправка писем, без неё подтвердить email нельзя. Попробуйте позже.'
          : 'Аккаунты в МедКарте выдаёт администратор: он пришлёт приглашение на вашу почту. Карта, поиск и избранное в браузере работают и без аккаунта.'}
      </p>
      <div className="space-y-3">
        <AuthButton icon={LogIn} onClick={() => navigate('/login')}>Ко входу</AuthButton>
        <AuthButton variant="secondary" onClick={() => navigate('/')}>Открыть карту</AuthButton>
      </div>
    </div>
  );
}

function RequestPage() {
  const env = useAuthEnvironment();
  const [sentTo, setSentTo] = useState('');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    document.title = 'Регистрация — МедКарта';
  }, []);

  let content;
  let key;
  if (env.status === 'loading') {
    key = 'loading';
    content = <AuthSkeleton />;
  } else if (env.user) {
    key = 'signed';
    content = (
      <div data-testid="register-signed-in">
        <Heading>Вы уже вошли</Heading>
        <AccountRow email={env.user.email} name={env.user.displayName} />
        <AuthButton onClick={() => navigate(homeFor(env.user), { replace: true })}>Продолжить</AuthButton>
      </div>
    );
  } else if (env.status === 'error' || !env.features.registration) {
    key = 'closed';
    content = <RegistrationClosed mode={env.features.registrationMode} />;
  } else if (sentTo) {
    key = 'sent';
    content = <SentNotice email={sentTo} onChangeEmail={() => { setDraft(sentTo); setSentTo(''); }} />;
  } else {
    key = 'form';
    content = <RequestForm initialEmail={draft} onSent={setSentTo} />;
  }
  return (
    <AuthLayout support={env.support}>
      <div data-testid="register-flow" data-phase={key}>
        <Steps stepKey={key}>{content}</Steps>
      </div>
    </AuthLayout>
  );
}

/* --------------------------- /register/confirm --------------------------- */

function ConfirmEmail({ link, onContinue }) {
  const [pending, setPending] = useState(false);
  const accept = async () => {
    setPending(true);
    const ok = await onContinue();
    if (!ok) setPending(false);
  };
  return (
    <div data-testid="register-confirm">
      <Heading>Подтвердите email</Heading>
      <p className="mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">Это ваш адрес? Нажмите «Продолжить», чтобы подтвердить его и задать пароль.</p>
      <AccountRow email={link.email} testId="register-account" />
      <AuthButton icon={UserPlus} loading={pending} loadingLabel="Открываем…" onClick={accept} data-testid="register-continue">Продолжить</AuthButton>
      <p className="mt-4 text-[13.5px] leading-5 text-slate-500 dark:text-slate-400">
        Ссылка действует до {formatMoscow(link.expiresAt)} (МСК) и срабатывает один раз. Если вы не регистрировались в МедКарте — просто закройте страницу: без перехода аккаунт не создаётся.
      </p>
    </div>
  );
}

function PasswordForm({ context, onDone, onProblem }) {
  const requirementsId = useId();
  const errorId = useId();
  const nameRef = useRef(null);
  const passwordRef = useRef(null);
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const problem = passwordProblem(password, { email: context.email });
    if (problem) {
      setError(problem);
      passwordRef.current?.focus();
      return;
    }
    setPending(true);
    setError('');
    try {
      onDone(await completeRegistration({ password, firstName: firstName.trim() }));
    } catch (failure) {
      if (['weak_password', 'busy', 'bad_name', 'breached_password'].includes(failure?.code)) {
        setError(failure.message);
        setPending(false);
        (failure.code === 'bad_name' ? nameRef : passwordRef).current?.focus();
        return;
      }
      onProblem(failure);
    }
  };

  return (
    <form onSubmit={submit} noValidate data-testid="register-password">
      <Heading focus={false}>Придумайте пароль</Heading>
      <p className="mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        Email подтверждён. Время на этот шаг — до {formatMoscow(context.expiresAt, false)}.
      </p>
      <AccountRow email={context.email} testId="register-account" />
      <input type="email" name="username" autoComplete="username" value={context.email} readOnly hidden />
      <div className="space-y-4">
        <TextField
          ref={nameRef}
          label="Как к вам обращаться"
          hint="Необязательно — можно указать позже в профиле."
          name="given-name"
          autoComplete="given-name"
          maxLength={60}
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
          data-testid="register-first-name"
        />
        <div>
          <PasswordField
            ref={passwordRef}
            label="Пароль"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (error) setError('');
            }}
            invalid={Boolean(error)}
            describedBy={[requirementsId, error ? errorId : null].filter(Boolean).join(' ')}
            data-testid="register-password-input"
          />
          <PasswordRequirements id={requirementsId} password={password} email={context.email} />
          <PasswordStrength password={password} email={context.email} />
        </div>
        <FormError id={errorId} message={error} />
        <Motion.div layout="position">
          <AuthButton type="submit" icon={LogIn} loading={pending} loadingLabel="Создаём аккаунт…" data-testid="register-complete">Создать аккаунт и войти</AuthButton>
        </Motion.div>
      </div>
    </form>
  );
}

function ConfirmPage() {
  const env = useAuthEnvironment();
  const [initialToken] = useState(readTokenFromUrl);
  const tokenRef = useRef(initialToken);
  const [phase, setPhase] = useState({ name: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    cleanUrl('/register/confirm');
    document.title = 'Подтверждение email — МедКарта';
    const onHash = () => {
      const token = readTokenFromUrl();
      cleanUrl('/register/confirm');
      if (!token) return;
      tokenRef.current = token;
      setPhase({ name: 'checking' });
      setAttempt((value) => value + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    let alive = true;
    const set = (next) => alive && setPhase(next);
    const token = tokenRef.current;
    (async () => {
      if (!token) {
        try {
          const { context } = await fetchRegistrationContext();
          set({ name: 'password', context });
        } catch (error) {
          set({ name: 'problem', problem: problemOf(error?.code === 'no_context' ? { code: 'no_link' } : error) });
        }
        return;
      }
      try {
        const { link } = await peekRegistration(token);
        set({ name: 'confirm', link });
      } catch (error) {
        if (error?.code === 'link_used') {
          // Та же ссылка, уже открытая в этом браузере: продолжаем с паролем.
          try {
            const { context } = await startRegistration(token);
            set({ name: 'password', context });
            return;
          } catch {
            // Открыта в другом браузере — показываем исходную причину.
          }
        }
        set({ name: 'problem', problem: problemOf(error) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (phase.name !== 'success') return undefined;
    const timer = setTimeout(() => navigate(homeFor(phase.result?.user), { replace: true }), REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const proceed = async () => {
    try {
      const { context } = await startRegistration(tokenRef.current);
      tokenRef.current = null;
      setPhase({ name: 'password', context });
      return true;
    } catch (error) {
      setPhase({ name: 'problem', problem: problemOf(error) });
      return false;
    }
  };

  let content;
  if (phase.name === 'checking') content = <AuthSkeleton />;
  else if (phase.name === 'confirm') content = <ConfirmEmail link={phase.link} onContinue={proceed} />;
  else if (phase.name === 'password') {
    content = <PasswordForm context={phase.context} onDone={(result) => setPhase({ name: 'success', result })} onProblem={(error) => setPhase({ name: 'problem', problem: problemOf(error) })} />;
  } else if (phase.name === 'success') {
    content = (
      <div role="status" data-testid="register-success">
        <div className="mb-5"><SuccessMark size={56} /></div>
        <Heading>Аккаунт создан</Heading>
        <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
          Вы вошли{phase.result?.user?.firstName ? `, ${phase.result.user.firstName}` : ''}. Открываем МедКарту…
        </p>
        <AuthButton variant="secondary" onClick={() => navigate(homeFor(phase.result?.user), { replace: true })} data-testid="register-go">Перейти сейчас</AuthButton>
      </div>
    );
  } else {
    content = <LinkProblem problem={phase.problem} testId="register-problem" onRetry={() => { setPhase({ name: 'checking' }); setAttempt((value) => value + 1); }} />;
  }

  return (
    <AuthLayout support={env.support}>
      <div data-testid="register-confirm-flow" data-phase={phase.name}>
        <Steps stepKey={`${phase.name}-${attempt}`}>{content}</Steps>
      </div>
    </AuthLayout>
  );
}

export default function RegisterPage() {
  const { path } = useLocation();
  return path === '/register/confirm' ? <ConfirmPage /> : <RequestPage />;
}
