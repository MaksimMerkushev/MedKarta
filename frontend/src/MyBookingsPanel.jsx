/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * «Мои демо-записи»: у гостя номера записей хранятся в этом браузере, у
 * вошедшего пользователя — в кабинете на сервере. Актуальный статус каждый
 * раз спрашивается у сервера.
 */
import { useEffect, useState } from 'react';
import { CalendarCheck, Loader2, Navigation, X } from 'lucide-react';
import { cancelBooking, formatFullDate, lookupBookings } from './services/demoBooking';

export default function MyBookingsPanel({ bookings, inAccount = false, onChange, onRoute, onClose }) {
  const [statuses, setStatuses] = useState({});
  const [busyNumber, setBusyNumber] = useState(null);
  const [error, setError] = useState(null);
  // Статус входит в подпись: запись, отменённую в окне записи, нужно
  // перепроверить, а не показывать прежнее «подтверждена».
  const signature = bookings.map((item) => `${item.number}:${item.status}`).join(',');

  useEffect(() => {
    if (!signature) return undefined;
    const controller = { cancelled: false };
    lookupBookings(bookings)
      .then((payload) => {
        if (controller.cancelled) return;
        setStatuses(Object.fromEntries(payload.bookings.map((item, index) => [bookings[index].number, item.found ? item.status : 'NOT_FOUND'])));
      })
      .catch(() => {
        if (!controller.cancelled) setError('Не удалось проверить статусы — показаны сохранённые.');
      });
    return () => {
      controller.cancelled = true;
    };
    // Статусы перепроверяются при изменении набора записей.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const cancel = async (item) => {
    setBusyNumber(item.number);
    setError(null);
    try {
      await cancelBooking({ number: item.number, cancelToken: item.cancelToken });
      setStatuses((current) => ({ ...current, [item.number]: 'CANCELLED' }));
      onChange(bookings.map((entry) => (entry.number === item.number ? { ...entry, status: 'CANCELLED' } : entry)), { cancelled: item.number });
    } catch (cancelError) {
      setError(cancelError.message);
    } finally {
      setBusyNumber(null);
    }
  };

  return (
    <section className="mb-4 rounded-2xl border border-violet-200 bg-violet-50/60 p-4 dark:border-violet-900 dark:bg-violet-950/30" aria-label="Мои демо-записи" data-testid="my-bookings">
      <div className="flex items-start justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-bold text-violet-800 dark:text-violet-200">
          <CalendarCheck size={16} aria-hidden="true" /> Мои демо-записи
        </h2>
        <button type="button" onClick={onClose} aria-label="Закрыть «Мои демо-записи»" className="-mr-1 -mt-1 rounded-lg p-1 text-slate-400 hover:bg-white/70 dark:hover:bg-slate-700">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {bookings.length === 0 && <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Записей пока нет. Попросите помощника найти врача — и запишитесь из подборки.</p>}
      {error && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{error}</p>}
      <ul className="mt-2 space-y-2">
        {bookings.map((item) => {
          // Отмену, о которой браузер уже знает, не перекрывает устаревший ответ сервера.
          const status = item.status === 'CANCELLED' ? 'CANCELLED' : statuses[item.number] || item.status;
          return (
            <li key={item.number} className="rounded-xl bg-white p-2.5 text-xs leading-5 shadow-sm dark:bg-slate-800">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-semibold text-slate-800 dark:text-white">{item.number}</span>
                <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${status === 'CONFIRMED' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-300'}`}>
                  {status === 'CONFIRMED' ? 'подтверждена' : status === 'CANCELLED' ? 'отменена' : 'не найдена (демо сброшено)'}
                </span>
              </div>
              <p className="mt-1 text-slate-700 dark:text-slate-200">{item.doctorName}{item.specialty ? `, ${item.specialty}` : ''}</p>
              <p className="text-slate-500 dark:text-slate-400">{item.clinicName}</p>
              <p className="text-slate-500 dark:text-slate-400">{formatFullDate(item.day)}, {item.start}–{item.end}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {Number.isFinite(item.lat) && (
                  <button type="button" onClick={() => onRoute(item)} className="inline-flex items-center gap-1 rounded-lg border border-blue-200 px-2 py-0.5 font-semibold text-blue-700 dark:border-blue-800 dark:text-blue-200">
                    <Navigation size={12} aria-hidden="true" /> Маршрут
                  </button>
                )}
                {status === 'CONFIRMED' && (
                  <button type="button" disabled={busyNumber === item.number} onClick={() => cancel(item)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-0.5 font-semibold text-red-600 disabled:opacity-50 dark:border-red-800 dark:text-red-300">
                    {busyNumber === item.number && <Loader2 size={12} className="animate-spin" aria-hidden="true" />} Отменить
                  </button>
                )}
                {status !== 'CONFIRMED' && !inAccount && (
                  <button type="button" onClick={() => onChange(bookings.filter((entry) => entry.number !== item.number))} className="rounded-lg border border-slate-200 px-2 py-0.5 font-semibold text-slate-500 dark:border-slate-600 dark:text-slate-300">
                    Убрать из списка
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] leading-4 text-slate-400">
        {inAccount
          ? 'Записи демонстрационные: хранятся в вашем личном кабинете, в клиники ничего не отправляется.'
          : 'Записи демонстрационные: хранятся номер и код отмены только в этом браузере, в клиники ничего не отправляется.'}
      </p>
    </section>
  );
}
