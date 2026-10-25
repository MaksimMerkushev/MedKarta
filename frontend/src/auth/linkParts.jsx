/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общее для страниц, которые открываются по ссылке из письма (приглашение,
 * регистрация, новый email): токен во фрагменте адреса, заголовок шага с
 * фокусом, строка аккаунта, время по Москве, экран «что пошло не так».
 *
 * Токен и адрес — links.js.
 */
import { useEffect, useRef } from 'react';
import { LogIn, Mail, MailPlus, RotateCw } from 'lucide-react';

import { navigate } from '../ui/navigation';
import { AuthButton } from './parts';

/** Заголовок шага, который получает фокус, — экранный диктор начинает с него. */
export function Heading({ children, focus = true }) {
  const ref = useRef(null);
  useEffect(() => {
    if (focus) ref.current?.focus({ preventScroll: true });
  }, [focus]);
  return <h1 ref={ref} tabIndex={-1} className="text-[28px] font-semibold leading-[34px] tracking-[-0.015em] text-slate-900 outline-none dark:text-white">{children}</h1>;
}

export function AccountRow({ email, name, testId = 'activation-account' }) {
  return (
    <div className="mb-6 mt-5 flex items-center gap-3 rounded-[12px] border border-slate-200 px-3.5 py-3 dark:border-slate-800" data-testid={testId}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" aria-hidden="true"><Mail size={17} /></span>
      <span className="min-w-0">
        {name && <span className="block truncate text-[15px] font-semibold text-slate-900 dark:text-white">{name}</span>}
        <span className={`block truncate ${name ? 'text-[13.5px] text-slate-500 dark:text-slate-400' : 'text-[15px] font-medium text-slate-800 dark:text-slate-100'}`}>{email}</span>
      </span>
    </div>
  );
}

/**
 * Экран проблемы со ссылкой. problem: {code, title, text, retry?, login?,
 * again?: {label, to}} — again ведёт туда, где получить новую ссылку.
 */
export function LinkProblem({ problem, onRetry, testId = 'link-problem' }) {
  return (
    <div data-testid={testId} data-code={problem.code}>
      <Heading>{problem.title}</Heading>
      <p className="mb-6 mt-3 text-[15px] leading-[22px] text-slate-600 dark:text-slate-300">{problem.text}</p>
      <div className="space-y-3">
        {problem.retry && <AuthButton icon={RotateCw} onClick={onRetry} data-testid="link-retry">Попробовать снова</AuthButton>}
        {problem.login && <AuthButton variant={problem.retry ? 'secondary' : 'primary'} icon={LogIn} onClick={() => navigate('/login')} data-testid="link-login">Войти</AuthButton>}
        {problem.again && (
          <AuthButton variant={problem.login || problem.retry ? 'secondary' : 'primary'} icon={MailPlus} onClick={() => navigate(problem.again.to)} data-testid="link-again">{problem.again.label}</AuthButton>
        )}
        {!problem.login && <AuthButton variant="secondary" icon={LogIn} onClick={() => navigate('/login')}>Ко входу</AuthButton>}
      </div>
    </div>
  );
}
