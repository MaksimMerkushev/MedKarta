/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * /email/confirm#token=… — подтверждение email по ссылке из письма: новый
 * адрес после смены в профиле или подтверждение текущего. Открытие
 * страницы ничего не меняет — только кнопка «Подтвердить» (POST). После
 * смены адреса остальные сессии завершаются; сессия в этом браузере
 * остаётся, если это тот же человек.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion as Motion, useReducedMotion } from 'motion/react';
import { LogIn, MailCheck, UserRound } from 'lucide-react';

import { confirmEmailChange, peekEmailChange } from '../services/account';
import { navigate } from '../ui/navigation';
import AuthLayout from './AuthLayout';
import AutoHeight from './AutoHeight';
import { AuthSkeleton } from './LoginPage';
import { AuthButton, SuccessMark } from './parts';
import { useAuthEnvironment } from './environment';
import { AccountRow, cleanUrl, formatMoscow, Heading, LinkProblem, readTokenFromUrl } from './linkParts';
import { stepTransition, stepVariants } from './motion';

const PROFILE = { label: 'Открыть профиль', to: '/profile#security' };
const PROBLEMS = {
  invalid_link: { title: 'Ссылка не подходит', text: 'Возможно, она скопирована не полностью. Откройте ссылку из письма ещё раз — целиком.', again: PROFILE },
  link_expired: { title: 'Срок действия ссылки истёк', text: 'Запросите смену или подтверждение email заново в профиле — придёт новое письмо.', again: PROFILE },
  link_used: { title: 'Ссылка уже использована', text: 'Email по этой ссылке уже подтверждён.', login: true },
  link_revoked: { title: 'Ссылка больше не действует', text: 'Email уже менялся или запрошена новая смена — работает ссылка из последнего письма.', again: PROFILE },
  email_taken: { title: 'Адрес уже занят', text: 'Этот email привязан к другому аккаунту МедКарты. Укажите другой адрес в профиле.', again: PROFILE },
  no_link: { title: 'Откройте ссылку из письма', text: 'Эта страница работает только по ссылке из письма с подтверждением email.', login: true },
  rate_limited: { title: 'Слишком много попыток', text: 'Подождите несколько минут и попробуйте снова.', retry: true },
};

const problemOf = (error) => {
  const known = PROBLEMS[error?.code];
  if (known) return { code: error.code, ...known };
  return { code: error?.code || 'network', title: 'Не получилось открыть ссылку', text: error?.message || 'Проверьте интернет и попробуйте ещё раз.', retry: true };
};

export default function EmailConfirmPage() {
  const env = useAuthEnvironment();
  const [initialToken] = useState(readTokenFromUrl);
  const tokenRef = useRef(initialToken);
  const [phase, setPhase] = useState({ name: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const shift = useReducedMotion() ? 0 : 1;

  useEffect(() => {
    cleanUrl('/email/confirm');
    document.title = 'Подтверждение email — МедКарта';
  }, []);

  useEffect(() => {
    let alive = true;
    const token = tokenRef.current;
    (async () => {
      if (!token) {
        if (alive) setPhase({ name: 'problem', problem: problemOf({ code: 'no_link' }) });
        return;
      }
      try {
        const { change } = await peekEmailChange(token);
        if (alive) setPhase({ name: 'confirm', change });
      } catch (error) {
        if (alive) setPhase({ name: 'problem', problem: problemOf(error) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  const confirm = async () => {
    setPending(true);
    try {
      const result = await confirmEmailChange(tokenRef.current);
      tokenRef.current = null;
      setPhase({ name: 'success', result });
    } catch (error) {
      setPhase({ name: 'problem', problem: problemOf(error) });
    } finally {
      setPending(false);
    }
  };

  let content;
  if (phase.name === 'checking') content = <AuthSkeleton />;
  else if (phase.name === 'confirm') {
    const { change } = phase;
    content = (
      <div data-testid="email-confirm">
        <Heading>{change.verifyOnly ? 'Подтвердите email' : 'Подтвердите новый email'}</Heading>
        <p className="mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
          {change.verifyOnly
            ? 'Подтвердите, что этот адрес ваш: на него будут приходить письма о входе и восстановлении доступа.'
            : <>Email аккаунта {change.currentEmail} сменится на этот адрес. Входить нужно будет с новым email; остальные сессии завершатся.</>}
        </p>
        <AccountRow email={change.newEmail} testId="email-confirm-address" />
        <AuthButton icon={MailCheck} loading={pending} loadingLabel="Подтверждаем…" onClick={confirm} data-testid="email-confirm-submit">Подтвердить</AuthButton>
        <p className="mt-4 text-[13.5px] leading-5 text-slate-500 dark:text-slate-400">
          Ссылка действует до {formatMoscow(change.expiresAt)} (МСК). Не запрашивали? Просто закройте страницу — без подтверждения ничего не изменится.
        </p>
      </div>
    );
  } else if (phase.name === 'success') {
    const { result } = phase;
    content = (
      <div role="status" data-testid="email-confirm-success">
        <div className="mb-5"><SuccessMark size={56} /></div>
        <Heading>{result.verifiedOnly ? 'Email подтверждён' : 'Email изменён'}</Heading>
        <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">
          {result.verifiedOnly ? `Адрес ${result.email} подтверждён.` : `Теперь вход — по адресу ${result.email}.`}
          {!result.signedIn && !result.verifiedOnly ? ' Войдите с новым email.' : ''}
        </p>
        {result.signedIn || env.user
          ? <AuthButton icon={UserRound} onClick={() => navigate('/profile', { replace: true })} data-testid="email-confirm-profile">Открыть профиль</AuthButton>
          : <AuthButton icon={LogIn} onClick={() => navigate('/login', { replace: true })} data-testid="email-confirm-login">Войти</AuthButton>}
      </div>
    );
  } else {
    content = <LinkProblem problem={phase.problem} testId="email-confirm-problem" onRetry={() => { setPhase({ name: 'checking' }); setAttempt((value) => value + 1); }} />;
  }

  return (
    <AuthLayout support={env.support}>
      <MotionConfig reducedMotion="user">
        <div data-testid="email-confirm-flow" data-phase={phase.name}>
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
