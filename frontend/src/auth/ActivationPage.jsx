/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * /activate#token=… — приглашение или ссылка для смены пароля.
 *
 * Токен — во фрагменте адреса: браузер не отправляет его ни на сервер в
 * строке запроса, ни в Referer. Страница сразу убирает его из адреса и
 * истории (replaceState) и держит только в памяти. Дальше:
 *   1) peek — чья ссылка и до когда действует (ничего не меняет);
 *   2) «Принять приглашение» — start: токен гаснет, взамен cookie контекста
 *      (HttpOnly, 30 минут, только для /api/auth/activation);
 *   3) пароль — complete: аккаунт активирован, вход выполнен.
 *      Если у аккаунта включена двухфакторная защита, ссылки (то есть
 *      доступа к почте) мало: после пароля — второй фактор, и только вместе
 *      с ним сервер меняет пароль и открывает сессию.
 * После перезагрузки на шаге пароля контекст берётся из cookie.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion as Motion, useReducedMotion } from 'motion/react';
import { ArrowLeft, KeyRound, LogIn, MailPlus, RotateCw } from 'lucide-react';

import { passwordProblem } from '@shared/passwordPolicy.js';
import { completeActivation, fetchActivationContext, fetchActivationMfaOptions, peekActivation, startActivation } from '../services/account';
import { navigate } from '../ui/navigation';
import AuthLayout from './AuthLayout';
import AutoHeight from './AutoHeight';
import { AuthSkeleton } from './LoginPage';
import { AuthButton, FormError, PasswordField, PasswordRequirements, PasswordStrength, SuccessMark, TextAction } from './parts';
import SecondFactorForm from './SecondFactor';
import { homeFor, useAuthEnvironment } from './environment';
import { AccountRow, Heading } from './linkParts';
import { cleanUrl as cleanUrlTo, formatMoscow, readTokenFromUrl } from './links';
import { stepTransition, stepVariants } from './motion';

const REDIRECT_MS = 1400;

const cleanUrl = () => cleanUrlTo('/activate');

const PROBLEMS = {
  invalid_link: { title: 'Ссылка не подходит', text: 'Возможно, она скопирована не полностью. Откройте ссылку из письма или сообщения ещё раз — целиком.' },
  link_expired: { title: 'Срок действия ссылки истёк', text: 'Ссылки действуют ограниченное время. Попросите новую — старая больше не откроется.' },
  link_revoked: { title: 'Ссылка отозвана', text: 'Администратор отозвал её или выдал новую. Используйте последнюю полученную ссылку.' },
  link_used: { title: 'Ссылка уже использована', text: 'Каждая ссылка срабатывает один раз. Если вы уже задали пароль — просто войдите.', login: true },
  activation_expired: { title: 'Время на создание пароля истекло', text: 'На пароль даётся 30 минут после открытия ссылки — или пароль уже задан в другой вкладке. Войдите или попросите новую ссылку.', login: true },
  account_blocked: { title: 'Аккаунт заблокирован', text: 'По этой ссылке нельзя войти, пока аккаунт заблокирован. Обратитесь к администратору МедКарты.', noRequest: true },
  no_link: { title: 'Откройте ссылку из приглашения', text: 'Эта страница работает только по персональной ссылке из письма или сообщения от администратора.' },
  rate_limited: { title: 'Слишком много попыток', text: 'Подождите несколько минут и откройте ссылку снова.', retry: true },
  mfa_failed: {
    title: 'Слишком много неверных кодов',
    text: 'Ссылка больше не действует — так код не подобрать. Запросите новую ссылку и подтвердите смену пароля ключом доступа, кодом из приложения или резервным кодом.',
  },
};

// Ошибки второго фактора, которые форма показывает сама (дальше — снова ввод).
const FACTOR_RETRY = new Set(['bad_mfa_code', 'too_many_attempts', 'bad_request', 'rate_limited', 'network']);

const problemOf = (error) => {
  const known = PROBLEMS[error?.code];
  if (known) return { code: error.code, ...known };
  return { code: error?.code || 'network', title: 'Не получилось открыть ссылку', text: error?.message || 'Проверьте интернет и попробуйте ещё раз.', retry: true };
};

function ConfirmStep({ link, onAccept }) {
  const [pending, setPending] = useState(false);
  const invite = link.purpose === 'invite';
  const accept = async () => {
    setPending(true);
    const ok = await onAccept();
    if (!ok) setPending(false);
  };
  return (
    <div data-testid="activation-confirm">
      <Heading>{invite ? 'Приглашение в МедКарту' : 'Смена пароля'}</Heading>
      <p className="mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        {invite
          ? <>{link.firstName ? `${link.firstName}, в` : 'В'}ас пригласили в МедКарту. Осталось придумать пароль — и можно входить.</>
          : <>{link.firstName ? `${link.firstName}, з` : 'З'}адайте новый пароль для аккаунта. Прежний пароль перестанет действовать, а другие сессии завершатся.</>}
      </p>
      <AccountRow email={link.email} />
      <AuthButton icon={invite ? null : KeyRound} loading={pending} loadingLabel="Открываем…" onClick={accept} data-testid="activation-accept">
        {invite ? 'Принять приглашение' : 'Задать новый пароль'}
      </AuthButton>
      <p className="mt-4 text-[13.5px] leading-5 text-slate-500 dark:text-slate-400">
        {invite && link.invitedBy ? <>Приглашение от администратора: {link.invitedBy}. </> : null}
        Ссылка действует до {formatMoscow(link.expiresAt)} (МСК) и срабатывает один раз. Не вы? Просто закройте страницу — без пароля в аккаунт не войти.
      </p>
    </div>
  );
}

/**
 * Второй фактор при смене пароля по ссылке: аккаунт с включённой MFA.
 * Пароль уже набран (держится в памяти шага); сервер меняет его только
 * вместе с верным вторым фактором.
 */
function FactorStep({ context, methods, onSubmit, onBack }) {
  const name = [context.firstName, context.lastName].filter(Boolean).join(' ');
  return (
    <div data-testid="activation-mfa">
      <Heading focus={false}>Подтвердите, что это вы</Heading>
      <p className="mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        Для аккаунта включена двухфакторная защита. Одной ссылки из письма мало: подтвердите смену пароля ключом доступа, кодом из приложения или резервным кодом.
      </p>
      <AccountRow email={context.email} name={name} />
      <SecondFactorForm
        methods={methods}
        getPasskeyOptions={async () => (await fetchActivationMfaOptions()).passkey}
        onSubmit={onSubmit}
        submitLabel="Сохранить пароль и войти"
      />
      <div className="mt-3 flex justify-center">
        <TextAction onClick={onBack} className="inline-flex items-center gap-1.5 px-2 py-1" data-testid="activation-mfa-back">
          <ArrowLeft size={15} aria-hidden="true" />
          Изменить пароль
        </TextAction>
      </div>
      <p className="mt-4 text-[13.5px] leading-5 text-slate-500 dark:text-slate-400" data-testid="activation-mfa-lost">
        Нет доступа ни к ключу, ни к приложению, ни к резервным кодам? Обратитесь в поддержку МедКарты: после проверки личности защиту сбросят, и пароль можно будет задать заново.
      </p>
    </div>
  );
}

function PasswordStep({ context, onDone, onProblem }) {
  const requirementsId = useId();
  const errorId = useId();
  const inputRef = useRef(null);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  // Второй фактор: известен заранее из контекста ссылки или по ответу сервера mfa_required.
  const [factor, setFactor] = useState({ open: false, methods: context.mfa?.methods || [] });
  const invite = context.purpose === 'invite';
  const name = [context.firstName, context.lastName].filter(Boolean).join(' ');

  useEffect(() => {
    if (!factor.open) inputRef.current?.focus({ preventScroll: true });
  }, [factor.open]);

  const backToPassword = (message = '') => {
    setFactor((current) => ({ ...current, open: false }));
    setError(message);
    setPending(false);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (pending) return;
    const problem = passwordProblem(password, { email: context.email });
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setError('');
    if (context.mfa?.required) {
      setFactor((current) => ({ ...current, open: true }));
      return;
    }
    setPending(true);
    try {
      const result = await completeActivation(password);
      onDone(result);
    } catch (failure) {
      if (failure?.code === 'weak_password' || failure?.code === 'busy') {
        setError(failure.message);
        setPending(false);
        inputRef.current?.focus();
        return;
      }
      if (failure?.code === 'mfa_required') {
        // MFA включили, пока ссылка была открыта: пароль не изменён, нужен второй фактор.
        setFactor({ open: true, methods: failure.payload?.methods || [] });
        setPending(false);
        return;
      }
      onProblem(failure);
    }
  };

  const submitFactor = async (secondFactor) => {
    try {
      onDone(await completeActivation(password, secondFactor));
    } catch (failure) {
      if (FACTOR_RETRY.has(failure?.code)) throw failure;
      if (failure?.code === 'weak_password' || failure?.code === 'busy') {
        backToPassword(failure.message);
        return;
      }
      // Ссылка погашена после пяти неверных кодов.
      onProblem(failure?.code === 'link_revoked' ? { code: 'mfa_failed' } : failure);
    }
  };

  if (factor.open) {
    return <FactorStep context={context} methods={factor.methods} onSubmit={submitFactor} onBack={() => backToPassword()} />;
  }

  return (
    <form onSubmit={submit} noValidate data-testid="activation-password">
      <Heading focus={false}>{invite ? 'Придумайте пароль' : 'Новый пароль'}</Heading>
      <p className="mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        С ним вы будете входить в МедКарту по email. Время на этот шаг — до {formatMoscow(context.expiresAt, false)}.
        {context.mfa?.required ? ' Затем подтвердите смену вторым фактором.' : ''}
      </p>
      <AccountRow email={context.email} name={name} />
      {/* Менеджер паролей сохранит новый пароль под этим адресом. */}
      <input type="email" name="username" autoComplete="username" value={context.email} readOnly hidden />
      <PasswordField
        ref={inputRef}
        label={invite ? 'Пароль' : 'Новый пароль'}
        name="new-password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
          if (error) setError('');
        }}
        invalid={Boolean(error)}
        describedBy={[requirementsId, error ? errorId : null].filter(Boolean).join(' ')}
        data-testid="activation-password-input"
      />
      <PasswordRequirements id={requirementsId} password={password} email={context.email} />
      <PasswordStrength password={password} email={context.email} />
      <div className="mt-4"><FormError id={errorId} message={error} /></div>
      <Motion.div layout="position" className="mt-5">
        <AuthButton type="submit" icon={LogIn} loading={pending} loadingLabel="Сохраняем…" data-testid="activation-submit">
          {context.mfa?.required ? 'Продолжить' : 'Сохранить пароль и войти'}
        </AuthButton>
      </Motion.div>
    </form>
  );
}

function SuccessStep({ result }) {
  const target = homeFor(result?.user);
  const invite = result?.purpose === 'invite';
  return (
    <div role="status" data-testid="activation-success">
      <div className="mb-5"><SuccessMark size={56} /></div>
      <Heading>{invite ? 'Аккаунт активирован' : 'Пароль изменён'}</Heading>
      <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
        Вы вошли{result?.user?.firstName ? `, ${result.user.firstName}` : ''}. {target === '/admin' ? 'Открываем админ-панель…' : 'Открываем МедКарту…'}
      </p>
      <AuthButton variant="secondary" onClick={() => navigate(target, { replace: true })} data-testid="activation-go">Перейти сейчас</AuthButton>
    </div>
  );
}

function ProblemStep({ problem, onRetry }) {
  return (
    <div data-testid="activation-problem" data-code={problem.code}>
      <Heading>{problem.title}</Heading>
      <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">{problem.text}</p>
      <div className="space-y-3">
        {problem.retry && <AuthButton icon={RotateCw} onClick={onRetry} data-testid="activation-retry">Попробовать снова</AuthButton>}
        {problem.login && <AuthButton icon={LogIn} onClick={() => navigate('/login')} data-testid="activation-login">Войти</AuthButton>}
        {!problem.noRequest && (
          <AuthButton variant={problem.login || problem.retry ? 'secondary' : 'primary'} icon={MailPlus} onClick={() => navigate('/login?step=access')} data-testid="activation-new-link">Получить новую ссылку</AuthButton>
        )}
        {!problem.login && <AuthButton variant="secondary" icon={LogIn} onClick={() => navigate('/login')}>Ко входу</AuthButton>}
      </div>
    </div>
  );
}

export default function ActivationPage() {
  const env = useAuthEnvironment();
  // Токен — только в памяти этой страницы; в адресе, истории и хранилище его нет.
  const [initialToken] = useState(readTokenFromUrl);
  const tokenRef = useRef(initialToken);
  const [phase, setPhase] = useState({ name: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const shift = useReducedMotion() ? 0 : 1;

  // Новая ссылка в этой же вкладке (вставили в адрес): меняется только фрагмент,
  // страница не перезагружается — начинаем заново с новым токеном.
  useEffect(() => {
    const onHash = () => {
      const token = readTokenFromUrl();
      cleanUrl();
      if (!token) return;
      tokenRef.current = token;
      setPhase({ name: 'checking' });
      setAttempt((value) => value + 1);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    cleanUrl();
    document.title = 'Приглашение — МедКарта';
  }, []);

  useEffect(() => {
    let alive = true;
    const set = (next) => alive && setPhase(next);
    const token = tokenRef.current;
    (async () => {
      if (!token) {
        // Перезагрузка на шаге пароля: контекст — в cookie этого браузера.
        try {
          const { context } = await fetchActivationContext();
          set({ name: 'password', context });
        } catch (error) {
          set({ name: 'problem', problem: problemOf(error?.code === 'no_context' ? { code: 'no_link' } : error) });
        }
        return;
      }
      try {
        const { link } = await peekActivation(token);
        set({ name: 'confirm', link });
      } catch (error) {
        if (error?.code === 'link_used') {
          // Та же ссылка, уже открытая в этом браузере (вторая вкладка, повторный клик из письма).
          try {
            const { context } = await startActivation(token);
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

  // После успеха — короткая пауза на «Аккаунт активирован» и переход.
  useEffect(() => {
    if (phase.name !== 'success') return undefined;
    const timer = setTimeout(() => navigate(homeFor(phase.result?.user), { replace: true }), REDIRECT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  const accept = async () => {
    try {
      const { context } = await startActivation(tokenRef.current);
      // Токен обменян на контекст: больше он не нужен даже в памяти.
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
  else if (phase.name === 'confirm') content = <ConfirmStep link={phase.link} onAccept={accept} />;
  else if (phase.name === 'password') {
    content = (
      <PasswordStep
        context={phase.context}
        onDone={(result) => setPhase({ name: 'success', result })}
        onProblem={(error) => setPhase({ name: 'problem', problem: problemOf(error) })}
      />
    );
  } else if (phase.name === 'success') content = <SuccessStep result={phase.result} />;
  else {
    content = (
      <ProblemStep
        problem={phase.problem}
        onRetry={() => {
          setPhase({ name: 'checking' });
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  return (
    <AuthLayout support={env.support}>
      <MotionConfig reducedMotion="user">
        <div data-testid="activation-flow" data-phase={phase.name}>
          <AutoHeight>
            <AnimatePresence mode="popLayout" initial={false} custom={shift}>
              <Motion.div key={`${phase.name}-${attempt}`} custom={shift} variants={stepVariants} initial="enter" animate="center" exit="exit" transition={stepTransition}>
                {content}
              </Motion.div>
            </AnimatePresence>
          </AutoHeight>
        </div>
      </MotionConfig>
    </AuthLayout>
  );
}
