/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Варианты демо-записи под ответом ассистента.
 *
 * Подбор строгий и выполняется на сервере (/api/demo/search): здесь только
 * показ. Если ничего не подошло, компонент честно говорит, какое условие
 * отсекло варианты, и предлагает ослабить ОДНО условие — только по нажатию
 * пользователя (это и есть согласие). Сам он условия не меняет.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, CalendarCheck, Clock, FlaskConical, Loader2, LocateFixed, MapPin, Navigation, RefreshCw, SearchX, ShieldAlert, ShieldCheck, Wallet,
} from 'lucide-react';
import { formatDay, formatPrice, searchDemo, TRAVEL_LABEL } from './services/demoBooking';

const SPECIALTY_CHOICES = [
  ['therapist', 'Терапевт'], ['pediatrician', 'Педиатр'], ['lor', 'ЛОР'], ['dermatologist', 'Дерматолог'],
  ['neurologist', 'Невролог'], ['gynecologist', 'Гинеколог'], ['dentist', 'Стоматолог'], ['ophthalmologist', 'Офтальмолог'],
];

/** Запрос с принятыми послаблениями: patch приходит с сервера как часть запроса. */
const applyPatch = (request, patch) => {
  const next = { ...request, ...patch };
  if (patch.travel) next.travel = { ...request.travel, ...patch.travel };
  if (patch.dms) next.dms = { ...request.dms, ...patch.dms };
  return next;
};

const yearsWord = (count) => {
  const tail = count % 100;
  if (tail >= 11 && tail <= 14) return 'лет';
  if (count % 10 === 1) return 'год';
  if (count % 10 >= 2 && count % 10 <= 4) return 'года';
  return 'лет';
};

const originKey = (origin) => (Array.isArray(origin) ? `${origin[0].toFixed(3)},${origin[1].toFixed(3)}` : 'none');

const CoverageBadge = ({ coverage }) => {
  if (!coverage) return null;
  if (coverage.status === 'covered') {
    return (
      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${coverage.conditional ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200'}`}>
        <ShieldCheck size={11} aria-hidden="true" /> {coverage.label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300" title={coverage.note || undefined}>
      <ShieldAlert size={11} aria-hidden="true" /> {coverage.label} — платно
    </span>
  );
};

const OptionCard = ({ option, index, today, onBook, onFocus, compact }) => {
  const slots = option.slots || [];
  const text = compact ? 'text-[12.5px]' : 'text-[13.5px]';
  return (
    <li className="rounded-xl border border-slate-100 p-2.5 dark:border-slate-700" data-testid="demo-offer">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${index === 0 ? 'bg-gradient-to-br from-violet-600 to-indigo-500' : 'bg-gradient-to-br from-violet-400 to-indigo-400'}`}>
          {index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <h3 className={`font-semibold leading-5 text-slate-800 dark:text-white ${text}`}>{option.doctor.name}</h3>
            <span className="shrink-0 rounded border border-amber-300 px-1 text-[9px] font-semibold uppercase text-amber-700 dark:border-amber-600 dark:text-amber-300">Демо</span>
          </div>
          <p className="text-[11.5px] leading-4 text-slate-500 dark:text-slate-400">
            {option.doctor.specialty}{option.doctor.experienceYears ? ` · стаж ${option.doctor.experienceYears} ${yearsWord(option.doctor.experienceYears)}` : ''} · {option.clinic.name}, {option.clinic.branchName}
          </p>
          {option.clinic.real && (
            <p className="mt-0.5 text-[10.5px] leading-4 text-sky-700 dark:text-sky-300" data-testid="demo-offer-real">
              Клиника реальная (OSM), врач и расписание — демонстрационные
            </p>
          )}
          <ul className="mt-1.5 flex flex-wrap gap-1">
            <li className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
              <Wallet size={11} aria-hidden="true" /> {formatPrice(option.price)}
            </li>
            {option.coverage && <li><CoverageBadge coverage={option.coverage} /></li>}
            {option.travel ? (
              <li className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-200" title="По графу дорог, без учёта пробок">
                <Navigation size={11} aria-hidden="true" /> {option.travel.minutes} мин {TRAVEL_LABEL[option.travel.mode] || ''}
              </li>
            ) : null}
          </ul>
          <p className="mt-1.5 text-[11.5px] font-medium leading-4 text-slate-700 dark:text-slate-200">
            <Clock size={12} aria-hidden="true" className="mr-1 inline-block -translate-y-px text-violet-500" />
            Ближайшее: {formatDay(option.nextSlot.day, today)}, {option.nextSlot.start}
            <span className="block font-normal text-slate-400">{option.service.name}, {option.service.durationMinutes} мин</span>
          </p>
          {slots.length > 1 && (
            <div className="mt-1.5 flex flex-wrap gap-1" aria-label="Свободное время">
              {slots.slice(0, 5).map((slot) => (
                <button
                  key={slot.id}
                  type="button"
                  onClick={() => onBook(option, slot)}
                  className="rounded-lg border border-violet-200 px-1.5 py-0.5 text-[11px] font-semibold text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-700 dark:text-violet-200 dark:hover:bg-slate-700"
                  aria-label={`Записаться на ${formatDay(slot.day, today)}, ${slot.start}`}
                >
                  {slot.day === option.nextSlot.day ? slot.start : `${formatDay(slot.day, today).replace(/^(\p{L}+),.*$/u, '$1')} ${slot.start}`}
                </button>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => onBook(option, option.nextSlot)}
              className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-[11.5px] font-semibold text-white transition-colors hover:bg-violet-700"
              data-testid="demo-offer-book"
            >
              <CalendarCheck size={12} aria-hidden="true" /> Записаться
            </button>
            <button
              type="button"
              onClick={() => onFocus?.(option)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 transition-colors hover:border-violet-300 hover:text-violet-700 dark:border-slate-600 dark:text-slate-300"
            >
              <MapPin size={12} aria-hidden="true" /> На карте
            </button>
          </div>
        </div>
      </div>
    </li>
  );
};

const RelaxButtons = ({ relax, onRelax, title = 'Могу снять одно условие — только если вы согласны:' }) => {
  if (!relax?.length) return null;
  return (
    <div className="mt-2">
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{title}</p>
      <div className="mt-1 flex flex-col gap-1">
        {relax.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onRelax(item)}
            className="rounded-lg border border-violet-200 px-2 py-1 text-left text-[11.5px] font-medium text-violet-700 transition-colors hover:bg-violet-50 dark:border-violet-700 dark:text-violet-200 dark:hover:bg-slate-700"
            data-testid={`demo-relax-${item.key}`}
          >
            {item.label}{Number.isInteger(item.count) ? ` — найдётся ${item.count}` : ''}
          </button>
        ))}
      </div>
    </div>
  );
};

/**
 * @param {object} props
 * @param {{request: object, summary: string[]}} props.booking из ответа ассистента
 * @param {[number, number]|null} props.origin точка отправления (null — неизвестна)
 * @param {string|null} props.planId выбранная программа ДМС
 */
export default function DemoOffers({
  booking,
  origin,
  planId,
  refreshKey = 0,
  compact = false,
  autoScroll = false,
  onSelectPlan,
  onBook,
  onFocus,
  onRequestOrigin,
  onAnswer = null,
}) {
  const sectionRef = useRef(null);
  const [patch, setPatch] = useState({});
  // «От дома»: ждём, пока пользователь сам поставит точку, — тогда она и есть «дом».
  const [awaitingPoint, setAwaitingPoint] = useState(null);
  const [state, setState] = useState({ status: 'loading', result: null, error: null });
  const [retry, setRetry] = useState(0);

  const request = useMemo(() => applyPatch(booking.request, patch), [booking.request, patch]);
  const ignoreOrigin = Object.hasOwn(patch, 'origin') && patch.origin === null;
  const effectiveOrigin = ignoreOrigin ? null : origin;
  const originSignature = originKey(effectiveOrigin);

  useEffect(() => {
    const controller = new AbortController();
    // Смена условий или точки — новый подбор; прежний ответ уже не про этот запрос.
    setState((current) => ({ status: 'loading', result: current.result, error: null }));
    searchDemo(request, { origin: effectiveOrigin, planId, signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setState({ status: 'ready', result, error: null });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'error', result: null, error });
      });
    return () => controller.abort();
    // Точка — по огрублённой подписи: дрожание геолокации не перезапускает подбор.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, originSignature, planId, refreshKey, retry]);

  useEffect(() => {
    if (autoScroll && state.status === 'ready') sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [autoScroll, state.status]);

  // Ответ на вопрос подбора: в чат (и в историю диалога), а без чата — только в этом блоке.
  const answer = (text, patchValue) => (onAnswer ? onAnswer(text) : setPatch((current) => ({ ...current, ...patchValue })));

  useEffect(() => {
    // Точку переставили после вопроса «откуда поедете» — это подтверждённое место отправления.
    if (awaitingPoint !== null && originSignature !== awaitingPoint && effectiveOrigin) {
      setAwaitingPoint(null);
      // Точка поставлена в ответ на вопрос — это ответ и для истории диалога.
      answer('считай от моей точки на карте', { originConfirmed: true });
    }
    // answer — новая функция на каждый рендер; условие выше срабатывает один раз.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingPoint, originSignature, effectiveOrigin]);

  const result = state.result;
  /*
   * Согласие кнопкой — та же реплика, что и словами («в любой день»,
   * «вечера»): она уходит в чат и остаётся в истории диалога. Без чата
   * (или пока ассистент отвечает) — уступка только в этом блоке.
   */
  const accept = (item) => {
    if (onAnswer && item.say) {
      onAnswer(item.say);
      return;
    }
    setPatch((current) => ({ ...current, ...item.patch, ...(item.patch?.travel ? { travel: { ...(current.travel || {}), ...item.patch.travel } } : {}) }));
  };
  const applied = result?.applied?.length ? result.applied : booking.summary;

  return (
    <section
      ref={sectionRef}
      className="mt-2 w-full scroll-mt-2 overflow-hidden rounded-2xl border border-violet-100 bg-white shadow-sm dark:border-slate-600 dark:bg-slate-800"
      aria-label="Свободное время у врачей под ваш запрос"
      data-testid="demo-offers"
      data-status={state.status === 'ready' ? result?.status : state.status}
    >
      <header className="flex items-start gap-2 border-b border-violet-50 bg-gradient-to-r from-violet-50/80 to-white px-3 py-2 dark:border-slate-700 dark:from-slate-700/60 dark:to-slate-800">
        <CalendarCheck size={14} className="mt-0.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-violet-700 dark:text-violet-300">
            {result?.status === 'ok' ? `Свободное время · ${result.options.length} из ${result.total}` : 'Подбор времени приёма'}
          </div>
          {applied?.length > 0 && (
            <div className="mt-0.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400" data-testid="demo-offers-applied">{applied.join(' · ')}</div>
          )}
        </div>
        <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-amber-300 px-1 text-[9px] font-semibold uppercase text-amber-700 dark:border-amber-600 dark:text-amber-300" title="Вымышленные клиники и расписание">
          <FlaskConical size={9} aria-hidden="true" /> Демо
        </span>
      </header>

      <div className="p-2" aria-live="polite">
        {state.status === 'loading' && (
          <p className="flex items-center gap-2 px-1 py-1.5 text-[12px] text-slate-500 dark:text-slate-400" role="status">
            <Loader2 size={14} className="animate-spin text-violet-500" aria-hidden="true" /> Проверяю расписание…
          </p>
        )}

        {state.status === 'error' && (
          <div className="px-1 py-1.5 text-[12px] text-slate-600 dark:text-slate-300" role="status">
            <p className="flex items-start gap-1.5"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true" /> {state.error?.code === 'demo_disabled' ? 'Демо-запись выключена на сервере.' : state.error?.message || 'Не удалось проверить расписание.'}</p>
            {state.error?.code !== 'demo_disabled' && (
              <button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 dark:border-slate-600 dark:text-slate-300">
                <RefreshCw size={12} aria-hidden="true" /> Повторить
              </button>
            )}
          </div>
        )}

        {state.status === 'ready' && result && (
          <>
            {result.status !== 'ok' && result.message && (
              <p className="flex items-start gap-1.5 px-1 py-1 text-[12px] leading-5 text-slate-700 dark:text-slate-200" data-testid="demo-offers-message">
                <SearchX size={14} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
                <span>{result.message}</span>
              </p>
            )}

            {result.status === 'needs' && result.needs?.includes('specialty') && (
              <div className="mt-1 flex flex-wrap gap-1 px-1">
                {SPECIALTY_CHOICES.map(([key, label]) => (
                  <button key={key} type="button" onClick={() => answer(label, { specialty: key })} className="rounded-lg border border-violet-200 px-2 py-0.5 text-[11.5px] font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-200 dark:hover:bg-slate-700">
                    {label}
                  </button>
                ))}
              </div>
            )}

            {result.status === 'needs' && result.needs?.includes('dms_plan') && (
              <div className="mt-1 space-y-1 px-1" data-testid="demo-plan-choice">
                {result.plans?.map((plan) => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => onSelectPlan?.(plan.id)}
                    className="block w-full rounded-lg border border-teal-200 px-2 py-1.5 text-left transition-colors hover:bg-teal-50 dark:border-teal-800 dark:hover:bg-slate-700"
                  >
                    <span className="flex items-center gap-1 text-[12px] font-semibold text-teal-800 dark:text-teal-200"><ShieldCheck size={12} aria-hidden="true" /> {plan.name}</span>
                    {plan.summary && <span className="mt-0.5 block text-[11px] leading-4 text-slate-500 dark:text-slate-400">{plan.summary}</span>}
                  </button>
                ))}
                <p className="text-[10.5px] leading-4 text-slate-400">Программы демонстрационные: страховщик и условия вымышлены.</p>
              </div>
            )}

            {result.status === 'needs' && result.needs?.includes('origin') && (
              <div className="mt-1 px-1">
                <button type="button" onClick={() => onRequestOrigin?.()} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-violet-700">
                  <LocateFixed size={12} aria-hidden="true" /> Указать точку на карте
                </button>
                <RelaxButtons relax={[{ key: 'travel', label: 'Искать без учёта времени в пути', say: 'неважно сколько ехать', patch: { travel: { maxMinutes: null, nearest: false } } }]} onRelax={accept} />
              </div>
            )}

            {result.status === 'needs' && result.needs?.includes('origin_place') && (
              <div className="mt-1 px-1" data-testid="demo-origin-place">
                <div className="flex flex-wrap gap-1">
                  {effectiveOrigin && (
                    <button type="button" onClick={() => answer('я сейчас там', { originConfirmed: true })} className="inline-flex items-center gap-1 rounded-lg border border-violet-200 px-2.5 py-1 text-[11.5px] font-semibold text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-200 dark:hover:bg-slate-700" data-testid="demo-origin-here">
                      <MapPin size={12} aria-hidden="true" /> Я сейчас там — считать от моей точки
                    </button>
                  )}
                  <button type="button" onClick={() => { setAwaitingPoint(originSignature); onRequestOrigin?.(); }} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-[11.5px] font-semibold text-white hover:bg-violet-700">
                    <LocateFixed size={12} aria-hidden="true" /> Поставить точку на карте
                  </button>
                </div>
                {awaitingPoint !== null && <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Перетащите красную точку туда, откуда поедете, — подбор пересчитается.</p>}
                <RelaxButtons relax={result.relax} onRelax={accept} />
              </div>
            )}

            {result.status === 'needs' && ['date_conflict', 'date_invalid', 'time_conflict', 'time_choice', 'date_choice'].some((key) => result.needs?.includes(key)) && (
              <div className="px-1" data-testid="demo-conflict">
                <RelaxButtons
                  relax={result.relax}
                  onRelax={accept}
                  title={result.needs.includes('date_conflict') || result.needs.includes('date_choice') ? 'Какой день имели в виду?'
                    : result.needs.includes('time_choice') ? 'Какое время имели в виду? (можно ответить и в чате)'
                      : result.needs.includes('date_invalid') ? 'Можно искать в любой день — если согласны:' : 'Можно искать без ограничения по часам — если согласны:'}
                />
              </div>
            )}

            {['empty', 'out_of_coverage', 'unavailable'].includes(result.status) && <RelaxButtons relax={result.relax} onRelax={accept} />}

            {result.status === 'ok' && (
              <>
                {result.notices?.includes('travel_unavailable') && (
                  <p className="px-1 pb-1 text-[11px] text-amber-700 dark:text-amber-300">Время в пути сейчас не считается — показываю без него.</p>
                )}
                {!effectiveOrigin && !result.notices?.includes('travel_unavailable') && (
                  <p className="px-1 pb-1 text-[11px] text-slate-400">Время в пути не показано: точка отправления не задана.</p>
                )}
                <ol className="space-y-1.5">
                  {result.options.map((option, index) => (
                    <OptionCard key={option.id} option={option} index={index} today={result.today} onBook={(item, slot) => onBook?.(item, slot, request.patient)} onFocus={onFocus} compact={compact} />
                  ))}
                </ol>
                <p className="mt-1.5 px-1 text-[10.5px] leading-4 text-slate-400">
                  Только врачи и время, подходящие под все условия. Время в пути — по дорогам, без пробок. Клиники, врачи и расписание — демонстрационные.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
