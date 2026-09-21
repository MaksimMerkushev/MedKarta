/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Замена window.alert(): нативный диалог блокирует поток, ломает вёрстку на
 * мобильных и не читается скринридером в контексте карты.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
};

const TONES = {
  info: 'border-blue-200 bg-white text-slate-700 dark:border-blue-800 dark:bg-slate-800 dark:text-slate-100',
  success: 'border-emerald-200 bg-white text-emerald-800 dark:border-emerald-800 dark:bg-slate-800 dark:text-emerald-200',
  warning: 'border-amber-200 bg-white text-amber-800 dark:border-amber-800 dark:bg-slate-800 dark:text-amber-200',
};

export const useToast = () => {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  const showToast = useCallback((message, tone = 'info', durationMs = 4000) => {
    clearTimeout(timerRef.current);
    setToast({ message, tone, id: `${tone}-${message}` });
    timerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { toast, showToast, dismiss };
};

export default function Toast({ toast, onDismiss }) {
  if (!toast) {
    return null;
  }

  const Icon = ICONS[toast.tone] || Info;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-4 z-[1200] flex justify-center px-4"
    >
      <div
        className={`toast-enter pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl border px-4 py-3 shadow-xl ${
          TONES[toast.tone] || TONES.info
        }`}
      >
        <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium leading-5">{toast.message}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Закрыть уведомление"
          className="-mr-1 shrink-0 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
