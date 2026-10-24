/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * /login — вход отдельной страницей (из письма, из админ-панели, по прямой
 * ссылке). ?next=/admin/… — куда вернуть после входа, только внутри
 * приложения.
 */
import { useEffect, useState } from 'react';
import { motion as Motion } from 'motion/react';
import { LogOut, RotateCw, UserRound } from 'lucide-react';

import { loginAccount, logoutAccount } from '../services/account';
import { navigate, useLocation } from '../ui/navigation';
import AuthFlow from './AuthFlow';
import AuthLayout from './AuthLayout';
import { AuthButton, FormError } from './parts';
import { homeFor, nextFromLocation, useAuthEnvironment } from './environment';
import { EASE } from './motion';

/** Заготовка формы на время загрузки: те же размеры, что у формы, — без скачка. */
export function AuthSkeleton() {
  return (
    <div className="animate-pulse motion-reduce:animate-none" role="status" aria-label="Загрузка" data-testid="auth-loading">
      <div className="h-[34px] w-3/4 rounded-lg bg-slate-100 dark:bg-slate-800" />
      <div className="mt-3 h-[22px] w-full rounded-md bg-slate-100 dark:bg-slate-800" />
      <div className="mt-8 h-5 w-14 rounded-md bg-slate-100 dark:bg-slate-800" />
      <div className="mt-2 h-12 w-full rounded-[10px] bg-slate-100 dark:bg-slate-800" />
      <div className="mt-4 h-12 w-full rounded-[10px] bg-slate-200/70 dark:bg-slate-800" />
    </div>
  );
}

const Appear = ({ children }) => (
  <Motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE }}>
    {children}
  </Motion.div>
);

function SignedIn({ user, next, onSwitch }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const switchAccount = async () => {
    setPending(true);
    setError('');
    try {
      await logoutAccount();
      onSwitch();
    } catch (failure) {
      setError(failure?.message || 'Не получилось выйти.');
      setPending(false);
    }
  };
  return (
    <Appear>
      <div data-testid="auth-signed-in">
        <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.015em] text-slate-900 dark:text-white">Вы уже вошли</h1>
        <div className="mb-6 mt-5 flex items-center gap-3 rounded-[12px] border border-slate-200 p-3.5 dark:border-slate-800">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300" aria-hidden="true"><UserRound size={20} /></span>
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold text-slate-900 dark:text-white">{user.displayName || user.email}</span>
            <span className="block truncate text-[13.5px] text-slate-500 dark:text-slate-400">{user.email}</span>
          </span>
        </div>
        <div className="space-y-3">
          <AuthButton onClick={() => navigate(next || homeFor(user), { replace: true })} data-testid="auth-continue">Продолжить</AuthButton>
          <AuthButton variant="secondary" icon={LogOut} loading={pending} loadingLabel="Выходим…" onClick={switchAccount} data-testid="auth-switch">Войти в другой аккаунт</AuthButton>
        </div>
        <div className="mt-4"><FormError message={error} /></div>
      </div>
    </Appear>
  );
}

export default function LoginPage() {
  const { search } = useLocation();
  const next = nextFromLocation(search);
  const initialStep = new URLSearchParams(search).get('step') === 'access' ? 'access' : 'email';
  const env = useAuthEnvironment();
  // Вход только что выполнен здесь: не показывать «Вы уже вошли», пока идёт переход.
  const [signedHere, setSignedHere] = useState(false);

  useEffect(() => {
    document.title = 'Вход — МедКарта';
  }, []);

  let content;
  if (env.status === 'loading') {
    content = <AuthSkeleton />;
  } else if (env.status === 'error') {
    content = (
      <Appear>
        <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.015em] text-slate-900 dark:text-white">Вход в МедКарту</h1>
        <div className="mb-5 mt-5"><FormError message={env.error?.message || 'Не получилось связаться с сервером.'} /></div>
        <AuthButton variant="secondary" icon={RotateCw} onClick={env.retry}>Повторить</AuthButton>
      </Appear>
    );
  } else if (!env.features.available) {
    content = (
      <Appear>
        <h1 className="text-[28px] font-semibold leading-[34px] tracking-[-0.015em] text-slate-900 dark:text-white">Вход недоступен</h1>
        <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">Аккаунты на этом сервере выключены. Карта, поиск и избранное в браузере работают без входа.</p>
        <AuthButton variant="secondary" onClick={() => navigate('/')}>Открыть карту</AuthButton>
      </Appear>
    );
  } else if (env.user && !signedHere) {
    content = <SignedIn user={env.user} next={next} onSwitch={() => env.setUser(null)} />;
  } else {
    content = (
      <AuthFlow
        variant="page"
        initialStep={initialStep}
        features={env.features}
        support={env.support}
        onLogin={async (credentials) => {
          const result = await loginAccount(credentials);
          setSignedHere(true);
          return result;
        }}
        onSuccess={(result) => navigate(next || homeFor(result?.user), { replace: true })}
      />
    );
  }

  return (
    <AuthLayout support={env.support}>
      {content}
    </AuthLayout>
  );
}
