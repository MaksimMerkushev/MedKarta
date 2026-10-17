/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Полные сведения о враче или учреждении по нажатию: в списке — только краткая
 * карточка (кто, где, сколько ехать, цена), чтобы он читался с одного взгляда.
 */
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function PlaceDetailsModal({ title, subtitle, onClose, children }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const onKeyDown = (event) => {
      // Окно записи поверх этого закрывается своим Esc — второй раз не закрываем.
      if (event.key === 'Escape' && !document.querySelector('[data-testid=booking-dialog]')) {
        event.stopPropagation();
        closeRef.current?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-end justify-center bg-slate-900/45 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl dark:bg-slate-800"
        data-testid="place-details"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5 dark:border-slate-700">
          <div className="min-w-0">
            <h2 className="truncate text-base font-extrabold text-slate-800 dark:text-white">{title}</h2>
            {subtitle && <p className="truncate text-xs font-semibold text-blue-600 dark:text-blue-400">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="-mr-1 rounded-xl p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700"
            data-testid="place-details-close"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
      </div>
    </div>
  );
}
