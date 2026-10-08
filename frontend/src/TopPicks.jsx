/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Подборка «три лучших» под ответом ассистента.
 */
import { useEffect, useRef } from 'react';
import { Award, Baby, ChevronRight, Clock, MapPin, Navigation, Route, SearchX, ShieldCheck, Sparkles, Star, Wallet } from 'lucide-react';

const REASON_STYLE = {
  travel: { icon: Navigation, className: 'bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200' },
  distance: { icon: Navigation, className: 'bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-200' },
  open: { icon: Clock, className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200' },
  hours: { icon: Clock, className: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
  dms: { icon: ShieldCheck, className: 'bg-teal-50 text-teal-700 dark:bg-teal-900/40 dark:text-teal-200' },
  price: { icon: Wallet, className: 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
  child: { icon: Baby, className: 'bg-pink-50 text-pink-700 dark:bg-pink-900/40 dark:text-pink-200' },
  rating: { icon: Star, className: 'bg-yellow-50 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200' },
  experience: { icon: Award, className: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
};

const ReasonChip = ({ reason }) => {
  const style = REASON_STYLE[reason.kind] || REASON_STYLE.hours;
  const Icon = style.icon;
  return (
    <li className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${style.className}`}>
      <Icon size={11} aria-hidden="true" />
      {/* Звёздочка рейтинга уже нарисована иконкой. */}
      {reason.kind === 'rating' ? reason.text.replace(/^★\s*/u, '') : reason.text}
    </li>
  );
};

const Skeleton = () => (
  <div className="space-y-2" aria-hidden="true">
    {[0, 1, 2].map((index) => (
      <div key={index} className="flex animate-pulse gap-2.5 rounded-xl p-2">
        <div className="h-6 w-6 shrink-0 rounded-full bg-violet-100 dark:bg-slate-600" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-3/4 rounded bg-slate-200 dark:bg-slate-600" />
          <div className="h-2.5 w-1/2 rounded bg-slate-100 dark:bg-slate-700" />
        </div>
      </div>
    ))}
  </div>
);

/**
 * @param {object} props
 * @param {{status: 'pending'|'ready', picks?: Array, total?: number, criteria?: string[], sortText?: string}} props.state
 */
export default function TopPicks({ state, onFocus, onRoute, onShowAll, compact = false, autoScroll = false }) {
  const sectionRef = useRef(null);
  const status = state?.status;

  // Подборка приходит позже текста ответа: прокручиваем к её началу, а не к концу переписки.
  useEffect(() => {
    if (autoScroll && status === 'ready') sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [autoScroll, status]);

  if (!state) return null;
  const text = compact ? 'text-[12.5px]' : 'text-[13.5px]';

  return (
    <section
      ref={sectionRef}
      className="mt-2 w-full scroll-mt-2 overflow-hidden rounded-2xl border border-violet-100 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-800"
      aria-label="Лучшие варианты под ваш запрос"
      data-testid="top-picks"
    >
      <header className="flex items-start gap-2 border-b border-violet-50 bg-gradient-to-r from-violet-50/80 to-white px-3 py-2 dark:border-slate-700 dark:from-slate-700/60 dark:to-slate-800">
        <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">
            {state.status === 'ready' && state.picks?.length > 0 ? `Топ-${state.picks.length} под ваш запрос` : 'Подбор под ваш запрос'}
          </div>
          {state.status === 'ready' && state.criteria?.length > 0 && (
            <div className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">{state.criteria.join(' · ')}</div>
          )}
        </div>
      </header>

      <div className="p-1.5">
        {state.status === 'pending' && (
          <>
            <p className="px-2 pb-1 pt-1 text-[11px] text-slate-500 dark:text-slate-400" role="status">Подбираю лучшие варианты…</p>
            <Skeleton />
          </>
        )}

        {state.status === 'ready' && state.picks?.length === 0 && (
          <div className="flex items-start gap-2 px-2 py-2.5" role="status">
            <SearchX size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
            <p className="text-[12px] leading-5 text-slate-600 dark:text-slate-300">
              Под все условия сразу никто не подошёл. Уберите одно из них в фильтрах — например, время в пути или ДМС.
            </p>
          </div>
        )}

        {state.status === 'ready' && state.picks?.length > 0 && (
          <ol className="space-y-1">
            {state.picks.map((pick, index) => (
              <li key={pick.id} className="group rounded-xl p-2 transition-colors hover:bg-violet-50/70 dark:hover:bg-slate-700/60">
                <div className="flex gap-2.5">
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white shadow-sm ${
                      index === 0 ? 'bg-gradient-to-br from-violet-600 to-indigo-500' : 'bg-gradient-to-br from-violet-400 to-indigo-400'
                    }`}
                    aria-label={`Место ${index + 1}`}
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <h3 className={`truncate font-semibold text-slate-800 dark:text-white ${text}`}>{pick.name}</h3>
                      {pick.demo && <span className="shrink-0 rounded border border-amber-300 px-1 text-[9px] font-semibold uppercase text-amber-700 dark:border-amber-600 dark:text-amber-300">Демо</span>}
                    </div>
                    <p className="truncate text-[11.5px] text-slate-500 dark:text-slate-400">
                      {[pick.entityKind === 'doctor' ? pick.doctorProfile || pick.specialty : pick.facilityType, pick.entityKind === 'doctor' ? pick.clinic : pick.address]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {pick.reasons?.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1" aria-label="Почему этот вариант">
                        {pick.reasons.map((reason) => <ReasonChip key={reason.kind} reason={reason} />)}
                      </ul>
                    )}
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => onFocus?.(pick)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:border-violet-300 hover:text-violet-700 dark:border-slate-600 dark:text-slate-300 dark:hover:text-violet-300"
                        aria-label={`Показать на карте: ${pick.name}`}
                      >
                        <MapPin size={12} aria-hidden="true" />
                        На карте
                      </button>
                      <button
                        type="button"
                        onClick={() => onRoute?.(pick)}
                        className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-violet-700"
                        aria-label={`Добавить в маршрут: ${pick.name}`}
                      >
                        <Route size={12} aria-hidden="true" />
                        В маршрут
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {state.status === 'ready' && ((state.sortText && state.picks?.length > 0) || state.total > (state.picks?.length || 0)) && (
        <footer className="border-t border-slate-100 px-3 py-2 dark:border-slate-700">
          {state.sortText && state.picks?.length > 0 && (
            <p className="mb-1.5 text-[10.5px] leading-4 text-slate-400">Сначала — {state.sortText}. Все варианты подходят под условия запроса.</p>
          )}
          {state.total > (state.picks?.length || 0) && (
            <button
              type="button"
              onClick={() => onShowAll?.()}
              className="flex w-full items-center justify-center gap-1 rounded-xl bg-violet-50 py-2 text-[12px] font-semibold text-violet-700 transition-colors hover:bg-violet-100 dark:bg-slate-700 dark:text-violet-200 dark:hover:bg-slate-600"
            >
              Показать все {state.total.toLocaleString('ru-RU')}
              <ChevronRight size={14} aria-hidden="true" />
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
