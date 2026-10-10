/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Демо-запись к врачу: выбор времени → удержание → подтверждение → номер.
 *
 * Состояния слотов показываются такими, какие они на сервере: свободно,
 * занято, закрыто, удерживается, прошло. Запись создаёт сервер — атомарно и
 * с ключом повтора, поэтому двойной щелчок или повтор после обрыва связи не
 * создают вторую запись. «Подтверждено» показывается только после ответа
 * сервера, а не заранее.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CalendarCheck, CheckCircle2, Clock, FlaskConical, Loader2, MapPin, Navigation, ShieldAlert, ShieldCheck, Stethoscope, X, XCircle,
} from 'lucide-react';
import {
  cancelBooking, createBooking, fetchDoctorSlots, formatDay, formatFullDate, formatPrice, holdSlot, newIdempotencyKey, releaseSlot,
} from './services/demoBooking';

const STATUS_VIEW = {
  BOOKED: { label: 'занято', className: 'border-slate-200 bg-slate-100 text-slate-400 line-through dark:border-slate-700 dark:bg-slate-800 dark:text-slate-500' },
  BLOCKED: { label: 'закрыто', className: 'border-slate-200 bg-slate-50 text-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-600' },
  HELD: { label: 'удерживается', className: 'border-amber-200 bg-amber-50 text-amber-500 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400' },
  PAST: { label: 'прошло', className: 'border-slate-100 bg-white text-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-600' },
};
const ABSENCE_LABEL = { vacation: 'врач в отпуске', day_off: 'у врача выходной', sick_leave: 'врач на больничном' };
const RETRYABLE_SLOT_ERRORS = new Set(['slot_taken', 'slot_held', 'slot_unavailable', 'slot_past', 'slot_not_found', 'slot_conflict']);

const CoverageLine = ({ coverage }) => {
  if (!coverage) return <p className="text-xs text-slate-500 dark:text-slate-400">Программа ДМС не выбрана — платный приём.</p>;
  if (coverage.status === 'covered') {
    return (
      <p className={`flex items-start gap-1.5 text-xs ${coverage.conditional ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
        <ShieldCheck size={14} className="mt-px shrink-0" aria-hidden="true" />
        <span>{coverage.label}{coverage.note ? `. ${coverage.note}` : ''}</span>
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
      <ShieldAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
      <span>{coverage.label}{coverage.note ? ` (${coverage.note})` : ''} — приём платный.</span>
    </p>
  );
};

/** Сбой в обработчике родителя не должен превращать состоявшуюся запись в «ошибку». */
const notify = (callback, value) => {
  try {
    callback?.(value);
  } catch (error) {
    console.error(error);
  }
};

/*
 * Обратный отсчёт удержания. Срок считается от длительности удержания,
 * а не от часов браузера: часы сервера (в демо их можно «заморозить»)
 * и браузера не обязаны совпадать.
 */
const useCountdown = (deadline) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!deadline) return null;
  return Math.max(0, Math.round((deadline - now) / 1000));
};

/**
 * @param {object} props
 * @param {{doctorId: string, branchId: string, serviceId?: string, slotId?: string, patient?: string}} props.target
 */
export default function BookingDialog({ target, planId = null, onClose, onBooked, onCancelled, onRoute }) {
  const [step, setStep] = useState('pick');
  const [schedule, setSchedule] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [serviceId, setServiceId] = useState(target.serviceId || null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [hold, setHold] = useState(null);
  const [booking, setBooking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const idempotencyRef = useRef(null);
  const holdRef = useRef(null);
  const autoHoldRef = useRef(target.slotId || null);
  const dialogRef = useRef(null);
  const remaining = useCountdown(step === 'confirm' ? hold?.deadline : null);

  useEffect(() => {
    holdRef.current = hold;
  }, [hold]);

  // Расписание врача в филиале: 14 дней вперёд, с состояниями слотов и покрытием ДМС.
  useEffect(() => {
    const controller = new AbortController();
    fetchDoctorSlots({ doctorId: target.doctorId, branchId: target.branchId, days: 14, planId, patient: target.patient, signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setSchedule(payload);
        setLoadError(null);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setLoadError(error);
      });
    return () => controller.abort();
  }, [target.doctorId, target.branchId, target.patient, planId, reloadKey]);

  const services = useMemo(() => schedule?.services || [], [schedule]);
  const activeServiceId = serviceId && services.some((item) => item.id === serviceId)
    ? serviceId
    : services.find((item) => item.id.endsWith('.first'))?.id || services[0]?.id || null;
  const activeService = services.find((item) => item.id === activeServiceId) || null;

  const days = useMemo(() => {
    if (!schedule) return [];
    const byDay = new Map();
    for (const slot of schedule.slots) {
      if (slot.serviceId !== activeServiceId) continue;
      if (!byDay.has(slot.day)) byDay.set(slot.day, []);
      byDay.get(slot.day).push(slot);
    }
    const absences = new Map(schedule.absences.map((item) => [item.day, item.kind]));
    const keys = [...new Set([...byDay.keys(), ...absences.keys()])].sort();
    return keys.map((day) => {
      const slots = byDay.get(day) || [];
      return { day, slots, absence: absences.get(day) || null, free: slots.filter((slot) => slot.bookable).length };
    });
  }, [schedule, activeServiceId]);

  const preselectedDay = useMemo(() => {
    const wanted = schedule?.slots.find((slot) => slot.id === target.slotId)?.day;
    return wanted || days.find((item) => item.free > 0)?.day || days[0]?.day || null;
  }, [schedule, target.slotId, days]);
  const activeDay = days.some((item) => item.day === selectedDay) ? selectedDay : preselectedDay;
  const dayView = days.find((item) => item.day === activeDay) || null;

  const startHold = useCallback(async (slot) => {
    setBusy(true);
    setNotice(null);
    setStep('holding');
    try {
      const result = await holdSlot(slot.id);
      idempotencyRef.current = newIdempotencyKey();
      const ttlSeconds = Number.isFinite(result.ttlSeconds) ? result.ttlSeconds : 300;
      setHold({ ...result, slot: result.slot || slot, deadline: Date.now() + ttlSeconds * 1000 });
      setStep('confirm');
    } catch (error) {
      setNotice(error.message);
      setStep('pick');
      setReloadKey((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }, []);

  // Пришли с конкретным временем из чата — сразу удерживаем его (если оно ещё свободно).
  useEffect(() => {
    if (!schedule || !autoHoldRef.current) return;
    const slot = schedule.slots.find((item) => item.id === autoHoldRef.current);
    autoHoldRef.current = null;
    // Удержание — реакция на ответ сервера с расписанием, а не расчёт при отрисовке.
    if (slot) setServiceId(slot.serviceId);
    if (slot?.bookable) startHold(slot);
    else if (slot) setNotice('Это время уже недоступно — выберите другое.');
  }, [schedule, startHold]);

  const releaseCurrent = useCallback(() => {
    const current = holdRef.current;
    if (current?.holdToken && current.slot?.id) releaseSlot(current.slot.id, current.holdToken);
    setHold(null);
  }, []);

  const backToPick = () => {
    releaseCurrent();
    setStep('pick');
    setReloadKey((value) => value + 1);
  };

  const close = useCallback(() => {
    if (step === 'confirm') releaseCurrent();
    onClose?.();
  }, [onClose, releaseCurrent, step]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      // Esc закрывает только этот диалог, а не чат под ним.
      event.stopPropagation();
      if (!busy) close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, close]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, [step]);

  const confirm = async () => {
    if (!hold || busy) return;
    setBusy(true);
    setNotice(null);
    setStep('booking');
    try {
      const result = await createBooking({ slotId: hold.slot.id, holdToken: hold.holdToken, idempotencyKey: idempotencyRef.current, planId });
      setBooking(result.booking);
      setHold(null);
      setStep('done');
      notify(onBooked, result.booking);
    } catch (error) {
      if (RETRYABLE_SLOT_ERRORS.has(error.code)) {
        setNotice(error.message);
        setHold(null);
        setStep('pick');
        setReloadKey((value) => value + 1);
      } else {
        // Обрыв связи: повтор с тем же ключом не создаст вторую запись.
        setNotice(`${error.message} Можно нажать «Подтвердить» ещё раз — повтор не создаст вторую запись.`);
        setStep('confirm');
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!booking || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await cancelBooking({ number: booking.number, cancelToken: booking.cancelToken });
      setBooking((current) => ({ ...current, ...result.booking, slotReleased: result.slotReleased, cancelToken: current.cancelToken }));
      setStep('cancelled');
      notify(onCancelled, result.booking);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  const doctor = schedule?.doctor;
  const title = doctor?.name || target.doctorName || 'Врач';
  const price = activeServiceId && schedule?.prices ? schedule.prices[activeServiceId] : null;
  const coverage = activeServiceId && schedule?.coverage ? schedule.coverage[activeServiceId] : null;

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-slate-900/50 p-0 sm:items-center sm:p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close(); }}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Демонстрационная запись к врачу"
        data-testid="booking-dialog"
        data-step={step}
        className="flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none dark:bg-slate-800 sm:rounded-3xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-700">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">
              <CalendarCheck size={13} aria-hidden="true" /> Запись к врачу
              <span className="inline-flex items-center gap-0.5 rounded border border-amber-300 px-1 text-[9px] text-amber-700 dark:border-amber-600 dark:text-amber-300"><FlaskConical size={9} aria-hidden="true" /> Демо</span>
            </div>
            <h2 className="mt-0.5 text-base font-bold leading-6 text-slate-800 dark:text-white">{title}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {[doctor?.specialty || target.specialty, target.clinicName && `${target.clinicName}${target.branchName ? `, ${target.branchName}` : ''}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          <button type="button" onClick={close} disabled={busy} aria-label="Закрыть" className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 disabled:opacity-40 dark:hover:bg-slate-700">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {notice && (
            <p className="mb-3 flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100" role="alert" data-testid="booking-notice">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {notice}
            </p>
          )}

          {step === 'pick' && (
            <>
              {!schedule && !loadError && (
                <p className="flex items-center gap-2 py-6 text-sm text-slate-500"><Loader2 size={16} className="animate-spin text-violet-500" aria-hidden="true" /> Загружаю расписание…</p>
              )}
              {loadError && (
                <p className="py-6 text-sm text-slate-600 dark:text-slate-300">{loadError.code === 'demo_disabled' ? 'Демо-запись выключена на сервере.' : `Не удалось загрузить расписание: ${loadError.message}`}</p>
              )}
              {schedule && (
                <>
                  {services.length > 1 && (
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300">
                      Услуга
                      <select
                        value={activeServiceId || ''}
                        onChange={(event) => setServiceId(event.target.value)}
                        className="mt-1 block w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-white"
                      >
                        {services.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name} · {item.durationMinutes} мин · {formatPrice(schedule.prices[item.id])}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="mt-2 rounded-xl bg-slate-50 px-3 py-2 dark:bg-slate-900/60">
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      {activeService?.name} · {activeService?.durationMinutes} мин · <b>{formatPrice(price)}</b>
                    </p>
                    <div className="mt-1"><CoverageLine coverage={coverage} /></div>
                  </div>

                  <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Дни">
                    {days.map((item) => (
                      <button
                        key={item.day}
                        type="button"
                        role="tab"
                        aria-selected={item.day === activeDay}
                        onClick={() => setSelectedDay(item.day)}
                        className={`shrink-0 rounded-xl border px-2.5 py-1.5 text-left text-xs transition-colors ${item.day === activeDay ? 'border-violet-500 bg-violet-50 text-violet-800 dark:bg-violet-900/40 dark:text-violet-100' : 'border-slate-200 text-slate-600 hover:border-violet-300 dark:border-slate-600 dark:text-slate-300'}`}
                      >
                        <span className="block font-semibold">{formatDay(item.day, schedule.now.day)}</span>
                        <span className="block text-[10.5px] text-slate-400">{item.absence ? 'не принимает' : item.free > 0 ? `свободно ${item.free}` : 'нет мест'}</span>
                      </button>
                    ))}
                  </div>

                  {dayView?.absence && (
                    <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">В этот день {ABSENCE_LABEL[dayView.absence] || 'врач не принимает'}.</p>
                  )}
                  {dayView && !dayView.absence && (
                    <div className="mt-3 grid grid-cols-4 gap-1.5 sm:grid-cols-5" data-testid="booking-slots">
                      {dayView.slots.map((slot) => {
                        const view = slot.past ? STATUS_VIEW.PAST : STATUS_VIEW[slot.status];
                        if (slot.bookable) {
                          return (
                            <button
                              key={slot.id}
                              type="button"
                              disabled={busy}
                              onClick={() => startHold(slot)}
                              className="rounded-xl border border-violet-200 bg-white px-1 py-1.5 text-center text-sm font-semibold text-violet-700 transition-colors hover:bg-violet-600 hover:text-white disabled:opacity-50 dark:border-violet-700 dark:bg-slate-900 dark:text-violet-200"
                              data-slot-id={slot.id}
                              data-slot-status="FREE"
                              aria-label={`Свободно: ${slot.start}`}
                            >
                              {slot.start}
                            </button>
                          );
                        }
                        return (
                          <span key={slot.id} className={`rounded-xl border px-1 py-1.5 text-center text-sm ${view?.className || ''}`} data-slot-id={slot.id} data-slot-status={slot.past ? 'PAST' : slot.status} title={view?.label}>
                            {slot.start}
                            <span className="block text-[9.5px] font-normal no-underline">{view?.label}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <p className="mt-3 text-[11px] leading-4 text-slate-400">Время московское. Состояния слотов — с сервера: что занято, то занято.</p>
                </>
              )}
            </>
          )}

          {(step === 'holding' || step === 'booking') && (
            <p className="flex items-center gap-2 py-8 text-sm text-slate-500" role="status">
              <Loader2 size={16} className="animate-spin text-violet-500" aria-hidden="true" /> {step === 'holding' ? 'Удерживаю время…' : 'Записываю…'}
            </p>
          )}

          {step === 'confirm' && hold && (
            <div data-testid="booking-confirm">
              <div className="rounded-2xl border border-violet-100 p-3 dark:border-slate-700">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-white">
                  <Clock size={15} className="text-violet-500" aria-hidden="true" /> {formatFullDate(hold.slot.day)}, {hold.slot.start}–{hold.slot.end}
                </p>
                <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <Stethoscope size={14} className="mt-px shrink-0" aria-hidden="true" /> {activeService?.name}, {formatPrice(price)}
                </p>
                {target.address && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <MapPin size={14} className="mt-px shrink-0" aria-hidden="true" /> {target.address}
                  </p>
                )}
                <div className="mt-1.5"><CoverageLine coverage={coverage} /></div>
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                {remaining > 0
                  ? `Время удержано за вами ещё ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}.`
                  : 'Удержание истекло: запись пройдёт, только если время ещё свободно.'}
              </p>
              <p className="mt-1 text-[11px] leading-4 text-slate-400">
                Это демонстрация: запись появится только в МедКарте. В клинику, страховую и МИС ничего не отправляется, персональные данные не нужны.
              </p>
            </div>
          )}

          {(step === 'done' || step === 'cancelled') && booking && (
            <div data-testid="booking-done">
              {step === 'done' ? (
                <p className="flex items-center gap-2 text-base font-bold text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 size={20} aria-hidden="true" /> Демонстрационная запись подтверждена
                </p>
              ) : (
                <p className="flex items-center gap-2 text-base font-bold text-slate-700 dark:text-slate-200">
                  <XCircle size={20} aria-hidden="true" /> Запись отменена{booking.slotReleased === false ? '' : ' — время снова свободно'}
                </p>
              )}
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-slate-400">Номер</dt>
                <dd className="font-mono font-semibold text-slate-800 dark:text-white" data-testid="booking-number">{booking.number}</dd>
                <dt className="text-slate-400">Врач</dt>
                <dd className="text-slate-800 dark:text-white">{booking.doctor.name}, {booking.doctor.specialty}</dd>
                <dt className="text-slate-400">Клиника</dt>
                <dd className="text-slate-800 dark:text-white">{booking.clinic.name}, {booking.clinic.branchName}<span className="block text-xs text-slate-500">{booking.clinic.address}</span></dd>
                <dt className="text-slate-400">Когда</dt>
                <dd className="text-slate-800 dark:text-white">{formatFullDate(booking.slot.day)}, {booking.slot.start}–{booking.slot.end} (МСК)</dd>
                <dt className="text-slate-400">Услуга</dt>
                <dd className="text-slate-800 dark:text-white">{booking.service.name}, {formatPrice(booking.price)}</dd>
                <dt className="text-slate-400">Статус</dt>
                <dd className="text-slate-800 dark:text-white" data-testid="booking-status">{booking.status === 'CONFIRMED' ? 'Подтверждена (демо)' : 'Отменена'}</dd>
              </dl>
              {booking.coverage && <div className="mt-2"><CoverageLine coverage={booking.coverage} /></div>}
              <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                {booking.clinic?.real
                  ? 'Демонстрационная запись: клиника реальная, но врач и расписание вымышлены — в клинику ничего не отправлено, звонить туда по этой записи не нужно.'
                  : 'Демонстрационная запись: клиника и врач вымышлены, в реальную клинику ничего не отправлено.'}
              </p>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-700">
          {step === 'confirm' && (
            <>
              <button type="button" onClick={backToPick} disabled={busy} className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700">
                Другое время
              </button>
              <button type="button" onClick={confirm} disabled={busy} className="inline-flex items-center gap-1.5 rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50" data-testid="booking-confirm-button">
                <CheckCircle2 size={16} aria-hidden="true" /> Подтвердить запись
              </button>
            </>
          )}
          {step === 'done' && (
            <>
              <button type="button" onClick={cancel} disabled={busy} className="rounded-xl border border-red-200 px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40" data-testid="booking-cancel-button">
                Отменить запись
              </button>
              <button type="button" onClick={() => onRoute?.(booking)} className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200" data-testid="booking-route-button">
                <Navigation size={15} aria-hidden="true" /> Построить маршрут
              </button>
              <button type="button" onClick={onClose} className="rounded-xl bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700">
                Готово
              </button>
            </>
          )}
          {(step === 'pick' || step === 'cancelled') && (
            <button type="button" onClick={close} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700">
              Закрыть
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
