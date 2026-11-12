/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Подбор лаборатории под ответом ассистента. Ассистент прислал корзину и условия,
 * а подбор исполняет сервер (/api/labs/quote) по базе: ни цены, ни филиалы, ни время
 * модель не придумывает. Точка отправления — из браузера, в /api/chat не уходит.
 */
import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2, SearchX } from 'lucide-react';

import { quoteLabs } from '../services/labs';
import { Link } from '../ui/router';
import LabBookingDialog from './LabBookingDialog';
import LabOptionCard from './LabOptionCard';
import { blockedText, labsPageUrl } from './labsText';

export default function LabOffers({ labs, origin = null, compact = false, autoScroll = false }) {
  const [state, setState] = useState({ status: 'loading', result: null, error: null });
  const [dialog, setDialog] = useState(null);
  const rootRef = useRef(null);
  const originKey = Array.isArray(origin) ? `${origin[0].toFixed(3)},${origin[1].toFixed(3)}` : 'none';

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', result: null, error: null });
    quoteLabs(labs.request, { origin, signal: controller.signal })
      .then((result) => setState({ status: 'ready', result, error: null }))
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'error', result: null, error: error.message });
      });
    return () => controller.abort();
    // origin сравнивается по огрублённому ключу: дрожание геолокации не перезапускает подбор.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labs.request, originKey]);

  useEffect(() => {
    if (autoScroll && state.status === 'ready') rootRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [autoScroll, state.status]);

  const { result } = state;
  return (
    <div ref={rootRef} className="mt-2 space-y-2 pl-1" data-testid="lab-offers">
      {state.status === 'loading' && <p className="flex items-center gap-2 text-[13px] text-slate-500"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Сравниваю лаборатории…</p>}
      {state.status === 'error' && <p className="text-[13px] text-rose-700">{state.error}</p>}
      {state.status === 'ready' && result.status === 'ok' && (
        <>
          {result.options.slice(0, compact ? 2 : 3).map((option, position) => (
            <LabOptionCard key={option.branch.id} option={option} index={position + 1} compact={compact} onBook={(item, slot) => setDialog({ option: item, slotId: slot?.id || null })} />
          ))}
          <p className="text-[11.5px] text-slate-500">{result.comparisonScope}</p>
          <Link to={labsPageUrl(labs.request)} className="inline-flex items-center gap-1.5 rounded-xl border border-violet-200 px-3 py-1.5 text-[13px] font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:text-violet-200 dark:hover:bg-violet-900/30">
            <FlaskConical size={14} aria-hidden="true" />Все варианты и карта ({result.total})
          </Link>
        </>
      )}
      {state.status === 'ready' && result.status !== 'ok' && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="lab-offers-empty">
          <p className="flex items-start gap-1.5"><SearchX size={15} className="mt-0.5 shrink-0" aria-hidden="true" />{result.status === 'invalid' ? 'Не получилось разобрать список исследований.' : blockedText(result)}</p>
          {result.partial?.slice(0, 2).map((item) => (
            <p key={item.branch.id} className="mt-1.5 text-[12.5px]">{item.lab.name}: нет {item.missing.map((missing) => missing.name).join(', ')}.</p>
          ))}
          <Link to={labsPageUrl(labs.request)} className="mt-2 inline-block font-semibold underline">Изменить условия в разделе «Лаборатории»</Link>
        </div>
      )}
      {dialog && (
        <LabBookingDialog branch={dialog.option.branch} lab={dialog.option.lab} tests={labs.request.tests} initialSlotId={dialog.slotId} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
