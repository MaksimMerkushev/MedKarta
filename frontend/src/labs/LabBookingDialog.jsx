/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-запись в лабораторию: день, свободное время, состав и полная стоимость
 * (исследования и взятие биоматериала), подтверждение, номер записи и отмена.
 * Место в слоте сервер проверяет в момент записи; если цена изменилась, запись
 * не создаётся и человек видит новую сумму.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarCheck, Check, Clock, FlaskConical, Loader2, MapPin, X } from 'lucide-react';

import {
  cancelLabBooking, createLabBooking, fetchLabSlots, formatLabDay, formatRub, newIdempotencyKey, rememberLabBooking, forgetLabBooking,
} from '../services/labs';

const readyText = (hours) => {
  if (!hours) return null;
  if (hours <= 10) return 'результат в день сдачи';
  const days = Math.ceil(hours / 24);
  return `результат через ${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'}`;
};

export default function LabBookingDialog({ branch, lab, tests, initialSlotId = null, onClose, onBooked }) {
  const [state, setState] = useState({ status: 'loading', slots: [], quote: null, window: null, error: null });
  const [from, setFrom] = useState(null);
  const [day, setDay] = useState(null);
  const [slotId, setSlotId] = useState(initialSlotId);
  const [submitting, setSubmitting] = useState(false);
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState(null);
  const keyRef = useRef(newIdempotencyKey());
  const dialogRef = useRef(null);

  const load = useCallback(async (start = from, signal) => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const data = await fetchLabSlots({ branchId: branch.id, from: start, days: 7, tests, signal });
      setState({ status: 'ready', slots: data.slots || [], quote: data.quote, window: data.window, error: null, now: data.now });
      const days = [...new Set((data.slots || []).filter((slot) => slot.bookable).map((slot) => slot.day))];
      setDay((current) => (current && days.includes(current) ? current : (data.slots || []).find((slot) => slot.id === initialSlotId)?.day || days[0] || null));
    } catch (loadError) {
      if (signal?.aborted) return;
      setState({ status: 'error', slots: [], quote: null, window: null, error: loadError.message });
    }
  }, [branch.id, tests, from, initialSlotId]);

  useEffect(() => {
    const controller = new AbortController();
    load(from, controller.signal);
    return () => controller.abort();
  }, [load, from]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !submitting) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const days = useMemo(() => [...new Set(state.slots.map((slot) => slot.day))], [state.slots]);
  const daySlots = state.slots.filter((slot) => slot.day === day);
  const selected = state.slots.find((slot) => slot.id === slotId) || null;
  const quote = state.quote;
  const missingTests = (quote?.missing || []).filter((item) => !item.startsWith('fee:'));
  const readyHours = Math.max(0, ...(quote?.lines || []).filter((line) => line.kind === 'test').map((line) => line.turnaroundHours || 0));

  const confirm = async () => {
    if (!selected || !quote) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createLabBooking({ branchId: branch.id, slotId: selected.id, tests, idempotencyKey: keyRef.current, expectedTotal: quote.total });
      if (!result.booking.owned) rememberLabBooking(result.booking);
      setBooking(result.booking);
      onBooked?.(result.booking);
    } catch (bookError) {
      setError(bookError.message);
      // Место заняли или цена изменилась: новое расписание и сумма, новый ключ запроса.
      if (['slot_full', 'price_changed', 'slot_past'].includes(bookError.code)) {
        keyRef.current = newIdempotencyKey();
        setSlotId(null);
        load(from);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (!booking) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await cancelLabBooking({ number: booking.number, cancelToken: booking.cancelToken });
      setBooking({ ...booking, ...result.booking, cancelToken: booking.cancelToken });
      forgetLabBooking(booking.number);
    } catch (cancelError) {
      setError(cancelError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1400] flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !submitting && onClose?.()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lab-booking-title"
        data-testid="lab-booking-dialog"
        className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none dark:bg-slate-900 sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4 dark:border-slate-800">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">Демо-запись в лабораторию</p>
            <h2 id="lab-booking-title" className="mt-0.5 text-[17px] font-bold text-slate-900 dark:text-white">{lab?.name}</h2>
            <p className="mt-0.5 flex items-center gap-1 text-[13px] text-slate-500 dark:text-slate-400"><MapPin size={13} aria-hidden="true" />{branch.address || branch.name}</p>
          </div>
          <button type="button" onClick={() => !submitting && onClose?.()} aria-label="Закрыть" className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {booking ? (
            <div data-testid="lab-booking-result" className="space-y-3">
              <div className={`flex items-center gap-2 rounded-2xl p-3 text-[14px] font-semibold ${booking.status === 'CANCELLED' ? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200' : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'}`}>
                <Check size={18} aria-hidden="true" />
                {booking.status === 'CANCELLED' ? 'Запись отменена, время освобождено.' : 'Вы записаны (демо). В лабораторию ничего не отправлено.'}
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[14px]">
                <dt className="text-slate-500">Номер</dt><dd className="font-mono font-semibold" data-testid="lab-booking-number">{booking.number}</dd>
                <dt className="text-slate-500">Когда</dt><dd>{booking.slot ? `${formatLabDay(booking.slot.day)}, ${booking.slot.start}` : '—'}</dd>
                <dt className="text-slate-500">Где</dt><dd>{booking.branch?.address}</dd>
                <dt className="text-slate-500">Итого</dt><dd className="font-semibold">{formatRub(booking.total)}</dd>
              </dl>
              <ul className="space-y-1 rounded-2xl bg-slate-50 p-3 text-[13px] dark:bg-slate-800/60">
                {[...booking.tests, ...booking.fees].map((line) => (
                  <li key={`${line.code || line.kind}`} className="flex justify-between gap-3"><span>{line.name}</span><span className="shrink-0 tabular-nums">{formatRub(line.price)}</span></li>
                ))}
              </ul>
              {booking.readyInHours > 0 && <p className="text-[13px] text-slate-500">{readyText(booking.readyInHours)}, ориентировочно.</p>}
              {booking.status !== 'CANCELLED' && (
                <button type="button" onClick={cancel} disabled={submitting} data-testid="lab-booking-cancel" className="w-full rounded-2xl border border-rose-200 px-4 py-2.5 text-[14px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40">
                  {submitting ? 'Отменяю…' : 'Отменить запись'}
                </button>
              )}
            </div>
          ) : (
            <>
              {quote && (
                <section aria-label="Состав и стоимость" className="mb-4 rounded-2xl bg-slate-50 p-3 dark:bg-slate-800/60">
                  <ul className="space-y-1 text-[13px]">
                    {quote.lines.map((line) => (
                      <li key={line.testCode || line.feeKind} className="flex justify-between gap-3">
                        <span className={line.kind === 'fee' ? 'text-slate-500' : ''}>{line.name}</span>
                        <span className="shrink-0 tabular-nums">{formatRub(line.price)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex justify-between border-t border-slate-200 pt-2 text-[15px] font-bold dark:border-slate-700">
                    <span>Итого за визит</span><span data-testid="lab-booking-total">{formatRub(quote.total)}</span>
                  </div>
                  {readyHours > 0 && <p className="mt-1 text-[12px] text-slate-500">{readyText(readyHours)}, ориентировочно</p>}
                  {missingTests.length > 0 && <p className="mt-2 text-[13px] font-medium text-rose-700 dark:text-rose-300">В этом филиале нет части исследований — запись невозможна. Выберите другой филиал.</p>}
                </section>
              )}
              {state.status === 'loading' && <p className="flex items-center gap-2 text-[14px] text-slate-500"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Загружаю расписание…</p>}
              {state.status === 'error' && <p className="text-[14px] text-rose-700">{state.error}</p>}
              {state.status === 'ready' && (
                <>
                  <div className="mb-3 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="День">
                    {days.map((item) => {
                      const free = state.slots.filter((slot) => slot.day === item && slot.bookable).length;
                      return (
                        <button key={item} type="button" role="tab" aria-selected={item === day} onClick={() => setDay(item)} disabled={free === 0}
                          className={`shrink-0 rounded-xl border px-3 py-2 text-left text-[13px] ${item === day ? 'border-violet-500 bg-violet-50 text-violet-800 dark:bg-violet-900/30 dark:text-violet-100' : 'border-slate-200 text-slate-700 dark:border-slate-700 dark:text-slate-200'} disabled:opacity-40`}>
                          <span className="block font-semibold">{formatLabDay(item)}</span>
                          <span className="block text-[11px] text-slate-500">{free ? `${free} окон` : 'нет мест'}</span>
                        </button>
                      );
                    })}
                    {days.length === 0 && <p className="text-[14px] text-slate-500">На эти дни свободного времени нет.</p>}
                  </div>
                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" role="radiogroup" aria-label="Время">
                    {daySlots.map((slot) => (
                      <button key={slot.id} type="button" role="radio" aria-checked={slot.id === slotId} disabled={!slot.bookable} onClick={() => setSlotId(slot.id)}
                        data-testid="lab-slot"
                        className={`rounded-xl border px-2 py-2 text-[13px] font-semibold tabular-nums ${slot.id === slotId ? 'border-violet-600 bg-violet-600 text-white' : 'border-slate-200 text-slate-800 hover:border-violet-400 dark:border-slate-700 dark:text-slate-100'} disabled:cursor-not-allowed disabled:opacity-35`}>
                        {slot.start}
                      </button>
                    ))}
                  </div>
                  <div className="mt-3 flex justify-between">
                    <button type="button" className="text-[13px] font-medium text-violet-700 disabled:opacity-40 dark:text-violet-300" disabled={!from}
                      onClick={() => setFrom(null)}>← К сегодня</button>
                    <button type="button" className="text-[13px] font-medium text-violet-700 disabled:opacity-40 dark:text-violet-300" disabled={!days.length || (state.window && days[days.length - 1] >= state.window.to)}
                      onClick={() => {
                        const last = days[days.length - 1];
                        const next = new Date(`${last}T12:00:00Z`);
                        next.setUTCDate(next.getUTCDate() + 1);
                        setFrom(next.toISOString().slice(0, 10));
                      }}>Следующие дни →</button>
                  </div>
                </>
              )}
            </>
          )}
          {error && <p role="alert" className="mt-3 rounded-xl bg-rose-50 p-3 text-[13px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{error}</p>}
        </div>

        {!booking && (
          <div className="border-t border-slate-100 p-4 dark:border-slate-800">
            <button type="button" onClick={confirm} disabled={!selected || submitting || !quote || missingTests.length > 0} data-testid="lab-booking-confirm"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-4 py-3 text-[15px] font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50">
              {submitting ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : <CalendarCheck size={18} aria-hidden="true" />}
              {selected ? `Записаться: ${formatLabDay(selected.day)}, ${selected.start}` : 'Выберите время'}
            </button>
            <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11.5px] text-slate-500"><FlaskConical size={12} aria-hidden="true" />Демонстрация: лаборатории, цены и время вымышлены. <Clock size={12} aria-hidden="true" />Время московское.</p>
          </div>
        )}
      </div>
    </div>
  );
}
