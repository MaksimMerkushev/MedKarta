/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Расписание демо-врача в окне подробностей — так, как его видит сервер записи
 * (с отпусками и выходными). Нажатие на время открывает запись на это время.
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Loader2, RefreshCw } from 'lucide-react';
import { fetchDoctorSlots, formatDay, formatPrice } from './services/demoBooking';

const ABSENCE_LABEL = { vacation: 'отпуск', day_off: 'выходной', sick_leave: 'больничный' };
const DAYS = 7;
const SHOWN_PER_DAY = 6;

export default function DemoDoctorSchedule({ doctorId, branchId, planId = null, patient = null, onPick }) {
  const [loaded, setLoaded] = useState({ key: null, status: 'loading', schedule: null });
  const [retry, setRetry] = useState(0);
  // Ответ относится к конкретному запросу: другой врач, программа или повтор — снова «загружаю».
  const requestKey = `${doctorId}|${branchId}|${planId}|${patient}|${retry}`;

  useEffect(() => {
    const controller = new AbortController();
    fetchDoctorSlots({ doctorId, branchId, days: DAYS, planId, patient, signal: controller.signal })
      .then((schedule) => {
        if (!controller.signal.aborted) setLoaded({ key: requestKey, status: 'ready', schedule });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key: requestKey, status: 'error', schedule: null });
      });
    return () => controller.abort();
  }, [doctorId, branchId, planId, patient, requestKey]);

  const state = loaded.key === requestKey ? loaded : { status: 'loading', schedule: null };
  const schedule = state.schedule;
  const firstService = useMemo(() => {
    const services = schedule?.services || [];
    return services.find((item) => item.id.endsWith('.first')) || services[0] || null;
  }, [schedule]);

  const days = useMemo(() => {
    if (!schedule || !firstService) return [];
    const absences = new Map((schedule.absences || []).map((item) => [item.day, item.kind]));
    const byDay = new Map();
    for (const slot of schedule.slots) {
      if (slot.serviceId !== firstService.id) continue;
      if (!byDay.has(slot.day)) byDay.set(slot.day, []);
      byDay.get(slot.day).push(slot);
    }
    return [...new Set([...byDay.keys(), ...absences.keys()])].sort().map((day) => {
      const slots = byDay.get(day) || [];
      return { day, absence: absences.get(day) || null, free: slots.filter((slot) => slot.bookable), total: slots.length };
    });
  }, [schedule, firstService]);

  return (
    <section className="mt-4 rounded-2xl border border-violet-100 bg-violet-50/40 p-3 dark:border-violet-900 dark:bg-violet-950/20" aria-label="Расписание и запись" data-testid="demo-doctor-schedule">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300">
          <CalendarCheck size={14} aria-hidden="true" /> Расписание на {DAYS} дней
        </h3>
        {firstService && schedule?.prices?.[firstService.id] != null && (
          <span className="whitespace-nowrap text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            {firstService.name}: {formatPrice(schedule.prices[firstService.id])}
          </span>
        )}
      </div>

      {state.status === 'loading' && (
        <p className="flex items-center gap-2 text-xs text-slate-500" role="status"><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Загружаю расписание…</p>
      )}
      {state.status === 'error' && (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          Не удалось загрузить расписание.{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)} className="inline-flex items-center gap-1 font-semibold text-violet-700 underline dark:text-violet-300">
            <RefreshCw size={12} aria-hidden="true" /> Повторить
          </button>
        </p>
      )}
      {state.status === 'ready' && days.length === 0 && (
        <p className="text-xs text-slate-600 dark:text-slate-300">В ближайшие {DAYS} дней приёма нет.</p>
      )}
      {state.status === 'ready' && days.length > 0 && (
        <ul className="space-y-1.5">
          {days.map((item) => (
            <li key={item.day} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs" data-testid="demo-schedule-day">
              <span className="w-28 shrink-0 font-semibold text-slate-700 dark:text-slate-200">{formatDay(item.day, schedule.now?.day)}</span>
              {item.absence ? (
                <span className="text-slate-400">врача нет: {ABSENCE_LABEL[item.absence] || 'не принимает'}</span>
              ) : item.free.length === 0 ? (
                <span className="text-slate-400">свободного времени нет</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {item.free.slice(0, SHOWN_PER_DAY).map((slot) => (
                    <button
                      key={slot.id}
                      type="button"
                      onClick={() => onPick?.(slot)}
                      className="rounded-lg border border-violet-200 bg-white px-1.5 py-0.5 font-semibold text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-700 dark:bg-slate-800 dark:text-violet-200"
                      aria-label={`Записаться на ${formatDay(item.day, schedule.now?.day)}, ${slot.start}`}
                    >
                      {slot.start}
                    </button>
                  ))}
                  {item.free.length > SHOWN_PER_DAY && <span className="self-center text-slate-400">ещё {item.free.length - SHOWN_PER_DAY}</span>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10.5px] leading-4 text-slate-400">
        Расписание демонстрационное: врач и слоты вымышлены, запись в клинику не уходит.
      </p>
    </section>
  );
}
