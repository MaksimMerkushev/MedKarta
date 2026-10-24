/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Детали экранов входа и активации: поле, поле пароля, кнопка, ошибка,
 * требования к паролю, знак успеха. Движение — Motion for React: только в
 * ответ на действие человека (шаг, ошибка, успех), с учётом
 * prefers-reduced-motion (MotionConfig reducedMotion="user" выше по дереву).
 */
import { forwardRef, useId, useState } from 'react';
import { AnimatePresence, motion as Motion, useReducedMotion } from 'motion/react';
import { AlertCircle, Check, Eye, EyeOff, Loader2 } from 'lucide-react';

import { PASSWORD_LIMITS, passwordChecks, passwordStrength } from '@shared/passwordPolicy.js';
import { EASE, SPRING } from './motion';


const BUTTON_VARIANTS = {
  primary: 'bg-blue-700 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_2px_rgba(15,23,42,0.2)] hover:bg-blue-800 disabled:bg-blue-700/60 dark:bg-blue-600 dark:hover:bg-blue-500 dark:disabled:bg-blue-600/50',
  secondary: 'border border-slate-300 bg-white text-slate-800 shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-600 dark:hover:bg-slate-800',
  quiet: 'text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/50',
};

/** Кнопка: мягкий подъём при наведении и лёгкое нажатие; во время загрузки — индикатор и aria-busy. */
export const AuthButton = forwardRef(function AuthButton(
  { children, variant = 'primary', loading = false, loadingLabel = null, icon: Icon = null, className = '', disabled, type = 'button', ...rest },
  ref,
) {
  const inactive = disabled || loading;
  return (
    <Motion.button
      ref={ref}
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      whileHover={inactive ? undefined : { y: -1 }}
      whileTap={inactive ? undefined : { y: 0, scale: 0.985 }}
      transition={SPRING}
      className={`relative inline-flex h-12 w-full select-none items-center justify-center gap-2 rounded-[10px] px-4 text-[15px] font-semibold transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : Icon && <Icon size={18} aria-hidden="true" />}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </Motion.button>
  );
});

/** Текстовая кнопка-ссылка внутри формы. */
export function TextAction({ children, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`rounded-md text-[14px] font-medium text-blue-700 underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60 dark:text-blue-300 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

const fieldClass = (invalid) => `block h-12 w-full rounded-[10px] border bg-white px-3.5 text-[16px] text-slate-900 shadow-[0_1px_2px_rgba(15,23,42,0.05)] outline-none transition-[border-color,box-shadow] placeholder:text-slate-500 focus:ring-4 dark:bg-slate-900 dark:text-slate-50 dark:placeholder:text-slate-400 ${invalid
  ? 'border-red-500 focus:border-red-500 focus:ring-red-500/15 dark:border-red-400'
  : 'border-slate-300 hover:border-slate-400 focus:border-blue-600 focus:ring-blue-600/15 dark:border-slate-700 dark:hover:border-slate-600 dark:focus:border-blue-400 dark:focus:ring-blue-400/20'}`;

export const TextField = forwardRef(function TextField({ label, hint = null, invalid = false, describedBy = null, className = '', ...rest }, ref) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : null;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-medium text-slate-700 dark:text-slate-200">{label}</label>
      <input
        ref={ref}
        id={id}
        aria-invalid={invalid || undefined}
        aria-describedby={[hintId, describedBy].filter(Boolean).join(' ') || undefined}
        className={fieldClass(invalid)}
        {...rest}
      />
      {hint && <p id={hintId} className="mt-1.5 text-[13px] leading-5 text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
});

/** Поле пароля с кнопкой «Показать»: менеджеры паролей видят обычный input type=password. */
export const PasswordField = forwardRef(function PasswordField({ label, invalid = false, describedBy = null, ...rest }, ref) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-medium text-slate-700 dark:text-slate-200">{label}</label>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          type={visible ? 'text' : 'password'}
          maxLength={PASSWORD_LIMITS.MAX}
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
          className={`${fieldClass(invalid)} pr-12`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-1.5 top-1.5 flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
          aria-pressed={visible}
          aria-controls={id}
        >
          {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
});

/** Ошибка формы: появляется плавно, без тряски; role=alert — её прочитает экранный диктор. */
export function FormError({ id, message, children = null }) {
  const instant = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {message && (
        <Motion.div
          key="error"
          initial={{ opacity: 0, height: 0, y: -4 }}
          animate={{ opacity: 1, height: 'auto', y: 0 }}
          exit={{ opacity: 0, height: 0, y: -4 }}
          transition={instant ? { duration: 0 } : { duration: 0.2, ease: EASE }}
          className="overflow-hidden"
        >
          <div id={id} role="alert" className="flex gap-2.5 rounded-[10px] border border-red-200 bg-red-50 px-3.5 py-3 text-[14px] leading-5 text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200" data-testid="auth-error">
            <AlertCircle size={18} className="mt-px shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <p>{message}</p>
              {children}
            </div>
          </div>
        </Motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Требования к паролю — те же, что проверит сервер. Выполненное отмечается
 * галочкой; итог озвучивается вежливо, без спама на каждую букву.
 */
export function PasswordRequirements({ id, password, email }) {
  const checks = passwordChecks(password, { email });
  const done = checks.filter((check) => check.ok).length;
  return (
    <div id={id} className="mt-3">
      <ul className="space-y-1.5" aria-label="Требования к паролю">
        {checks.map((check) => (
          <li key={check.key} className={`flex items-center gap-2 text-[13.5px] leading-5 transition-colors ${check.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`} data-testid={`requirement-${check.key}`} data-ok={check.ok}>
            <span className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center" aria-hidden="true">
              <AnimatePresence initial={false} mode="wait">
                {check.ok ? (
                  <Motion.span
                    key="ok"
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.4, opacity: 0 }}
                    transition={SPRING}
                    className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500"
                  >
                    <Check size={12} strokeWidth={3} />
                  </Motion.span>
                ) : (
                  <Motion.span key="todo" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-[7px] w-[7px] rounded-full bg-slate-300 dark:bg-slate-600" />
                )}
              </AnimatePresence>
            </span>
            <span>
              {check.label}
              <span className="sr-only">{check.ok ? ' — выполнено' : ' — пока нет'}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">{password ? `Выполнено требований: ${done} из ${checks.length}` : ''}</p>
    </div>
  );
}

const STRENGTH_TONES = ['bg-slate-300 dark:bg-slate-600', 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600 dark:bg-emerald-400'];

/**
 * Индикатор надёжности: четыре деления и слово. Только подсказка — решает
 * сервер (длина, частые пароли, по желанию — база утечек). Цвет не
 * единственный носитель смысла: рядом всегда слово.
 */
export function PasswordStrength({ password, email }) {
  const { score, label } = passwordStrength(password, { email });
  if (!password) return null;
  return (
    <div className="mt-3 flex items-center gap-3" data-testid="password-strength" data-score={score}>
      <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((step) => (
          <span key={step} className={`h-1.5 rounded-full transition-colors duration-200 ${score >= step ? STRENGTH_TONES[score] : 'bg-slate-200 dark:bg-slate-700'}`} />
        ))}
      </div>
      <span className="min-w-[88px] text-right text-[13px] font-medium text-slate-600 dark:text-slate-300" aria-live="polite">
        <span className="sr-only">Надёжность пароля: </span>{label}
      </span>
    </div>
  );
}

/** Знак успеха: круг и галочка, которая прорисовывается один раз. */
export function SuccessMark({ size = 64 }) {
  return (
    <Motion.svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      initial={{ scale: 0.85, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={SPRING}
      className="text-emerald-600 dark:text-emerald-400"
    >
      <circle cx="32" cy="32" r="30" fill="currentColor" opacity="0.12" />
      <Motion.circle
        cx="32"
        cy="32"
        r="30"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.45, ease: EASE }}
      />
      <Motion.path
        d="M20 33.5 28.5 42 45 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.35, delay: 0.25, ease: EASE }}
      />
    </Motion.svg>
  );
}
