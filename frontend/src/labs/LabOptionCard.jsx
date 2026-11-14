/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Вариант подбора лаборатории: полная стоимость визита и из чего она сложилась,
 * срок готовности, время в пути, ближайшее свободное время. Общий для раздела
 * «Лаборатории» и для подбора под ответом ассистента.
 */
import { useState } from 'react';
import { ChevronDown, Clock, FlaskConical, MapPin, Navigation, Timer, Wallet } from 'lucide-react';

import { formatLabDay, formatReadyAt, formatRub } from '../services/labs';

const BADGES = { cheapest: 'Дешевле всего среди демо', fastest: 'Быстрее результат' };

export default function LabOptionCard({ option, onBook, onFocus = null, compact = false, index = 0 }) {
  const [open, setOpen] = useState(false);
  const firstSlot = option.slots?.[0];
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900" data-testid="lab-option" data-branch={option.branch.id} aria-label={`${option.lab.name}, ${formatRub(option.total)}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14.5px] font-bold text-slate-900 dark:text-white">{index > 0 ? `${index}. ` : ''}{option.lab.name}</p>
          <p className="mt-0.5 flex items-start gap-1 text-[12.5px] text-slate-500 dark:text-slate-400"><MapPin size={13} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="truncate">{option.branch.address}</span></p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[17px] font-extrabold tabular-nums text-slate-900 dark:text-white" data-testid="lab-option-total">{formatRub(option.total)}</p>
          <p className="text-[11px] text-slate-500">за визит</p>
        </div>
      </div>
      {option.badges?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {option.badges.map((badge) => <span key={badge} className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">{BADGES[badge]}</span>)}
        </div>
      )}
      <ul className="mt-2 space-y-1 text-[12.5px] text-slate-600 dark:text-slate-300">
        <li className="flex items-center gap-1.5"><Wallet size={13} aria-hidden="true" />Анализы {formatRub(option.testsTotal)}{option.feesTotal > 0 ? ` + взятие ${formatRub(option.feesTotal)}` : ' + взятие бесплатно'}</li>
        {option.turnaroundText && <li className="flex items-center gap-1.5"><Timer size={13} aria-hidden="true" />Результат {option.turnaroundText}{option.readyAt && !compact ? ` (≈ ${formatReadyAt(option.readyAt)})` : ''}</li>}
        {option.travel && <li className="flex items-center gap-1.5"><Navigation size={13} aria-hidden="true" />{option.travel.approximate ? '≈ ' : ''}{option.travel.minutes} мин, {option.travel.distanceKm} км</li>}
        {firstSlot && <li className="flex items-center gap-1.5"><Clock size={13} aria-hidden="true" />Ближайшее: {formatLabDay(firstSlot.day)}, {firstSlot.start}</li>}
      </ul>
      {option.slots?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Свободное время">
          {option.slots.slice(0, compact ? 3 : 4).map((slot) => (
            <button key={slot.id} type="button" onClick={() => onBook(option, slot)} data-testid="lab-option-slot"
              className="rounded-lg border border-violet-200 bg-violet-50 px-2 py-1 text-[12px] font-semibold text-violet-800 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-900/30 dark:text-violet-100">
              {slot.day === firstSlot?.day ? '' : `${formatLabDay(slot.day).split(',')[0]} `}{slot.start}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onBook(option, null)} data-testid="lab-option-book"
          className="rounded-xl bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-violet-700">Записаться</button>
        {onFocus && <button type="button" onClick={() => onFocus(option)} className="rounded-xl border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">На карте</button>}
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
          className="ml-auto flex items-center gap-1 text-[12.5px] font-medium text-slate-600 dark:text-slate-300">
          Состав <ChevronDown size={14} className={open ? 'rotate-180' : ''} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1 rounded-xl bg-slate-50 p-2.5 text-[12.5px] dark:bg-slate-800/60">
          {option.lines.map((line) => <li key={line.code} className="flex justify-between gap-2"><span><FlaskConical size={12} className="mr-1 inline" aria-hidden="true" />{line.name}</span><span className="shrink-0 tabular-nums">{formatRub(line.price)}</span></li>)}
          {option.fees.map((line) => <li key={line.feeKind} className="flex justify-between gap-2 text-slate-500"><span>{line.name}</span><span className="shrink-0 tabular-nums">{formatRub(line.price)}</span></li>)}
          {option.priceDate && <li className="pt-1 text-[11px] text-slate-400">Цены (демо) на {option.priceDate.split('-').reverse().join('.')}</li>}
        </ul>
      )}
    </article>
  );
}
