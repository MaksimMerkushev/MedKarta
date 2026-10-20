/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Предупреждение вместо чата для гостя: ассистент доступен только после входа
 * в личный кабинет, чтобы переписка принадлежала одному человеку и не
 * оставалась открытой на общем устройстве. Сервер проверяет то же самое
 * (backend/api/chatAccess.js).
 */
import { useEffect, useRef } from 'react';
import { Bot, LogIn, X } from 'lucide-react';

export default function ChatLoginNotice({ canSignIn, onSignIn, onClose, isMobile }) {
  const primaryRef = useRef(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement;
    primaryRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeRef.current?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[1200] flex bg-slate-900/40 backdrop-blur-[2px] ${isMobile ? 'items-end' : 'items-center justify-center p-4'}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="chat-login-title"
        aria-describedby="chat-login-text"
        className={`relative w-full bg-white p-5 shadow-2xl dark:bg-slate-800 ${isMobile ? 'rounded-t-3xl' : 'max-w-[400px] rounded-3xl'}`}
        style={isMobile ? { paddingBottom: 'max(20px, env(safe-area-inset-bottom))' } : undefined}
        data-testid="chat-login-notice"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
          aria-label="Закрыть"
        >
          <X size={20} aria-hidden="true" />
        </button>
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300" aria-hidden="true">
          <Bot size={24} />
        </span>
        <h2 id="chat-login-title" className="mt-3 pr-8 text-[18px] font-extrabold leading-tight text-slate-800 dark:text-white">
          Ассистент — только в личном кабинете
        </h2>
        <p id="chat-login-text" className="mt-2 text-[13.5px] leading-5 text-slate-600 dark:text-slate-300">
          {canSignIn
            ? 'Войдите в личный кабинет, чтобы поговорить с ассистентом. Так переписка принадлежит только вам и не остаётся открытой на общем устройстве.'
            : 'Личный кабинет сейчас недоступен, поэтому ассистент тоже. Поиск врачей, карта и маршруты работают без входа.'}
        </p>
        <div className={`mt-4 flex gap-2 ${isMobile ? 'flex-col' : 'flex-row-reverse'}`}>
          {canSignIn ? (
            <>
              <button
                ref={primaryRef}
                type="button"
                onClick={onSignIn}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-2.5 text-[14px] font-bold text-white shadow-sm transition hover:brightness-110"
                data-testid="chat-login-sign-in"
              >
                <LogIn size={16} aria-hidden="true" />
                Войти в кабинет
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-2xl border border-slate-200 px-4 py-2.5 text-[14px] font-semibold text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                Не сейчас
              </button>
            </>
          ) : (
            <button
              ref={primaryRef}
              type="button"
              onClick={onClose}
              className="flex-1 rounded-2xl border border-slate-200 px-4 py-2.5 text-[14px] font-semibold text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              Понятно
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
