/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Раздел «Лаборатории»: каталог исследований, корзина, сравнение полной стоимости
 * визита по филиалам, карта, страницы лаборатории и исследования, демо-запись и
 * «Мои записи». Подбор считает сервер (/api/labs/quote) по базе демо-данных.
 *
 *   /labs                 — каталог, корзина и подбор (?request=… — от ассистента)
 *   /labs/lab/:id         — лаборатория: филиалы, часы, цены
 *   /labs/test/:code      — исследование: подготовка, где сделать, пример бланка
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttributionControl, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  ArrowLeft, Building2, CalendarCheck, FlaskConical, Info, ListChecks, Loader2, MapPin, Minus, Plus, Search, ShoppingBasket, TestTube, X,
} from 'lucide-react';

import { KAZAN_PLACES } from '@shared/kazanPlaces.js';
import {
  cancelLabBooking, fetchAccountLabBookings, fetchLab, fetchLabCatalog, fetchLabTest, forgetLabBooking, formatLabDay, formatRub,
  lookupLabBookings, quoteLabs, readLabBookings, readLabCart, writeLabCart,
} from '../services/labs';
import { navigate, useLocation } from '../ui/navigation';
import { Link } from '../ui/router';
import LabBookingDialog from './LabBookingDialog';
import LabOptionCard from './LabOptionCard';
import { blockedText, describeWeekly } from './labsText';

const DATE_OPTIONS = [
  ['any', 'Любой день'], ['today', 'Сегодня'], ['tomorrow', 'Завтра'], ['after_tomorrow', 'Послезавтра'],
  ['w1', 'Понедельник'], ['w2', 'Вторник'], ['w3', 'Среда'], ['w4', 'Четверг'], ['w5', 'Пятница'], ['w6', 'Суббота'], ['w7', 'Воскресенье'],
];
const TIME_OPTIONS = [['', 'Любое время'], ['morning', 'Утро (до 12:00)'], ['afternoon', 'День (12–17)'], ['evening', 'Вечер (после 17)']];
const TURNAROUND_OPTIONS = [['', 'Любой срок'], ['10', 'В день сдачи'], ['24', 'До 1 дня'], ['72', 'До 3 дней']];
const SORT_OPTIONS = [['total', 'Дешевле'], ['distance', 'Ближе'], ['turnaround', 'Быстрее результат'], ['soonest', 'Раньше время']];
const MINUTES_OPTIONS = [['', 'Любое'], ['10', 'до 10 мин'], ['20', 'до 20 мин'], ['30', 'до 30 мин']];
const CENTER = [55.7963, 49.1088];

const dateToKey = (date) => {
  if (!date || date.kind === 'any') return 'any';
  if (['today', 'tomorrow', 'after_tomorrow'].includes(date.kind)) return date.kind;
  if (date.kind === 'weekday') return `w${date.weekday}`;
  return 'any';
};
const keyToDate = (key) => (key.startsWith('w') ? { kind: 'weekday', weekday: Number(key.slice(1)) } : { kind: key });

const readInitialRequest = (search) => {
  try {
    const raw = new URLSearchParams(search).get('request');
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
};

const branchIcon = (label, active) => L.divIcon({
  className: '',
  html: `<div style="transform:translate(-50%,-100%);white-space:nowrap;padding:3px 7px;border-radius:10px;font:600 12px system-ui;color:${active ? '#fff' : '#334155'};background:${active ? '#7c3aed' : '#fff'};border:1px solid ${active ? '#6d28d9' : '#cbd5e1'};box-shadow:0 1px 3px rgba(0,0,0,.25)">${label}</div>`,
  iconSize: [0, 0],
});

function FlyTo({ point }) {
  const map = useMap();
  useEffect(() => {
    if (point) map.flyTo(point, Math.max(map.getZoom(), 14), { duration: 0.6 });
  }, [map, point]);
  return null;
}

function BranchMap({ branches, options = [], focus = null, onSelect }) {
  const byBranch = new Map(options.map((option) => [option.branch.id, option]));
  return (
    <MapContainer center={CENTER} zoom={12} className="h-full w-full" attributionControl={false} scrollWheelZoom>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' />
      <AttributionControl position="bottomright" prefix={false} />
      <FlyTo point={focus} />
      {branches.map((branch) => {
        const option = byBranch.get(branch.id);
        return (
          <Marker key={branch.id} position={[branch.lat, branch.lng]} icon={branchIcon(option ? formatRub(option.total) : '●', Boolean(option))} eventHandlers={{ click: () => onSelect?.(branch.id) }}>
            <Popup>
              <strong>{branch.name}</strong><br />{branch.address}{option ? <><br />Итого: {formatRub(option.total)}</> : null}
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}

function Shell({ children, title, back = null, onMyBookings }) {
  return (
    <div className="flex h-full flex-col bg-slate-50 dark:bg-slate-950" data-testid="labs-page">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <Link to={back || '/'} className="rounded-xl p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" aria-label={back ? 'Назад' : 'На карту врачей'}><ArrowLeft size={18} /></Link>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-violet-600 dark:text-violet-300">МедКарта · Лаборатории</p>
          <h1 className="truncate text-[17px] font-bold text-slate-900 dark:text-white">{title}</h1>
        </div>
        <button type="button" onClick={onMyBookings} data-testid="labs-my-bookings" className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
          <CalendarCheck size={15} aria-hidden="true" /><span className="hidden sm:inline">Мои записи</span>
        </button>
      </header>
      <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
        <Info size={13} className="mr-1 inline" aria-hidden="true" />Демо-режим: лаборатории, цены, сроки и время вымышлены, запись никуда не уходит. Филиалы стоят там, где в Казани действительно есть пункты сдачи анализов (OpenStreetMap), но сами лаборатории вымышлены; адрес — без номера дома.
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function MyBookings({ onClose }) {
  const [state, setState] = useState({ status: 'loading', items: [] });
  const load = useCallback(async () => {
    setState((current) => ({ ...current, status: 'loading' }));
    const stored = readLabBookings();
    const [guest, mine] = await Promise.all([
      stored.length ? lookupLabBookings(stored).then((data) => data.bookings.filter((item) => item.found).map((item) => ({ ...item, cancelToken: stored.find((entry) => entry.number === item.number)?.cancelToken }))).catch(() => []) : [],
      fetchAccountLabBookings().then((data) => data.bookings).catch(() => []),
    ]);
    const seen = new Set();
    const items = [...mine, ...guest].filter((item) => !seen.has(item.number) && seen.add(item.number));
    setState({ status: 'ready', items });
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const cancel = async (item) => {
    try {
      await cancelLabBooking({ number: item.number, cancelToken: item.cancelToken });
      forgetLabBooking(item.number);
    } finally {
      load();
    }
  };
  return (
    <div className="fixed inset-0 z-[1300] flex justify-end bg-slate-900/40" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="flex h-full w-full max-w-md flex-col bg-white shadow-2xl dark:bg-slate-900" role="dialog" aria-modal="true" aria-label="Мои записи в лаборатории" data-testid="labs-my-bookings-panel">
        <div className="flex items-center justify-between border-b border-slate-100 p-4 dark:border-slate-800">
          <h2 className="text-[16px] font-bold">Мои записи в лаборатории</h2>
          <button type="button" onClick={onClose} aria-label="Закрыть" className="rounded-xl p-2 hover:bg-slate-100 dark:hover:bg-slate-800"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {state.status === 'loading' && <p className="text-[14px] text-slate-500">Загружаю…</p>}
          {state.status === 'ready' && state.items.length === 0 && <p className="text-[14px] text-slate-500">Записей пока нет. Гостевые записи хранятся только в этом браузере.</p>}
          {state.items.map((item) => (
            <div key={item.number} className="rounded-2xl border border-slate-200 p-3 text-[13.5px] dark:border-slate-700" data-testid="labs-my-booking">
              <div className="flex justify-between gap-2"><strong>{item.lab?.name}</strong><span className={item.status === 'CANCELLED' ? 'text-slate-500' : 'text-emerald-700 dark:text-emerald-300'}>{item.status === 'CANCELLED' ? 'отменена' : 'активна'}</span></div>
              <p className="text-slate-500">{item.slot ? `${formatLabDay(item.slot.day)}, ${item.slot.start}` : ''} · {item.branch?.address}</p>
              <p className="mt-1">{item.tests.map((test) => test.name).join(', ')}</p>
              <p className="mt-1 font-semibold">{formatRub(item.total)} · <span className="font-mono text-[12px]">{item.number}</span></p>
              {item.status === 'CONFIRMED' && item.cancelToken && !item.slot?.past && (
                <button type="button" onClick={() => cancel(item)} className="mt-2 rounded-xl border border-rose-200 px-3 py-1.5 text-[13px] font-semibold text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300">Отменить</button>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function CatalogView({ catalog, cart, setCart, initialRequest, onMyBookings }) {
  const [tab, setTab] = useState('tests');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [filters, setFilters] = useState(() => ({
    date: dateToKey(initialRequest?.date),
    timeOfDay: initialRequest?.timeOfDay || '',
    maxTotalPrice: initialRequest?.maxTotalPrice ? String(initialRequest.maxTotalPrice) : '',
    maxTurnaroundHours: initialRequest?.maxTurnaroundHours ? String(initialRequest.maxTurnaroundHours) : '',
    sort: initialRequest?.sort || 'total',
    place: initialRequest?.originPlace || '',
    maxMinutes: initialRequest?.travel?.maxMinutes ? String(initialRequest.travel.maxMinutes) : '',
  }));
  const [geo, setGeo] = useState(null);
  const [quote, setQuote] = useState({ status: 'idle', result: null, error: null });
  const [dialog, setDialog] = useState(null);
  const [focus, setFocus] = useState(null);
  const resultsRef = useRef(null);
  const tests = catalog.tests;
  const byCode = useMemo(() => new Map(tests.map((test) => [test.code, test])), [tests]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/ё/g, 'е');
    return tests.filter((test) => (!category || test.category === category)
      && (!needle || `${test.name} ${test.code}`.toLowerCase().replace(/ё/g, 'е').includes(needle)));
  }, [tests, query, category]);

  const request = useMemo(() => ({
    tests: cart,
    date: keyToDate(filters.date),
    timeOfDay: filters.timeOfDay || null,
    maxTotalPrice: filters.maxTotalPrice ? Number(filters.maxTotalPrice) : null,
    maxTurnaroundHours: filters.maxTurnaroundHours ? Number(filters.maxTurnaroundHours) : null,
    sort: filters.sort,
    originPlace: filters.place && filters.place !== 'geo' ? filters.place : null,
    travel: filters.maxMinutes ? { maxMinutes: Number(filters.maxMinutes), mode: 'driving' } : undefined,
  }), [cart, filters]);

  useEffect(() => {
    if (cart.length === 0) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setQuote((current) => ({ ...current, status: 'loading' }));
      quoteLabs(request, { origin: filters.place === 'geo' ? geo : null, signal: controller.signal })
        .then((result) => setQuote({ status: 'ready', result, error: null }))
        .catch((error) => !controller.signal.aborted && setQuote({ status: 'error', result: null, error: error.message }));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, geo, filters.place, cart.length]);

  const toggle = (code) => setCart((current) => (current.includes(code) ? current.filter((item) => item !== code) : [...current, code].slice(0, 25)));
  const setFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const askGeo = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => setGeo([position.coords.latitude, position.coords.longitude]), () => setGeo(null), { timeout: 8000 });
  };
  // Пустая корзина — подбора нет, прежний ответ не показывается.
  const shown = cart.length ? quote : { status: 'idle', result: null, error: null };
  const result = shown.result;
  const selectClass = 'w-full rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-[13px] dark:border-slate-700 dark:bg-slate-900';

  return (
    <Shell title="Анализы и лаборатории" onMyBookings={onMyBookings}>
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex gap-2" role="tablist">
              {[['tests', 'Исследования', <TestTube key="icon" size={15} aria-hidden="true" />], ['labs', 'Лаборатории', <Building2 key="icon" size={15} aria-hidden="true" />]].map(([id, label, icon]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[13.5px] font-semibold ${tab === id ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200'}`}>{icon}{label}</button>
              ))}
            </div>
            {tab === 'tests' ? (
              <>
                <label className="relative block">
                  <span className="sr-only">Поиск исследования</span>
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Например: ферритин, ТТГ, общий анализ крови" data-testid="labs-search"
                    className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-[14px] dark:border-slate-700 dark:bg-slate-800" />
                </label>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => setCategory('')} className={`rounded-full px-3 py-1 text-[12.5px] ${!category ? 'bg-violet-100 font-semibold text-violet-800 dark:bg-violet-900/40 dark:text-violet-100' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>Все</button>
                  {catalog.categories.map((item) => (
                    <button key={item.id} type="button" onClick={() => setCategory(item.id)} className={`rounded-full px-3 py-1 text-[12.5px] ${category === item.id ? 'bg-violet-100 font-semibold text-violet-800 dark:bg-violet-900/40 dark:text-violet-100' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{item.name}</button>
                  ))}
                </div>
                <ul className="mt-3 max-h-[380px] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800" data-testid="labs-test-list">
                  {visible.map((test) => {
                    const inCart = cart.includes(test.code);
                    return (
                      <li key={test.code} className="flex items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <Link to={`/labs/test/${test.code}`} className="text-[13.5px] font-semibold text-slate-900 hover:text-violet-700 dark:text-white">{test.name}</Link>
                          <p className="text-[12px] text-slate-500">{test.biomaterialName}{test.fasting ? ' · натощак' : ''}{test.minPrice ? ` · от ${formatRub(test.minPrice)}` : ''}{test.fastestText ? ` · ${test.fastestText}` : ''}</p>
                        </div>
                        <button type="button" onClick={() => toggle(test.code)} aria-pressed={inCart} aria-label={inCart ? `Убрать «${test.name}» из корзины` : `Добавить «${test.name}» в корзину`} data-testid={`labs-add-${test.code}`}
                          className={`shrink-0 rounded-xl p-2 ${inCart ? 'bg-violet-600 text-white' : 'border border-slate-200 text-slate-700 hover:border-violet-400 dark:border-slate-700 dark:text-slate-200'}`}>
                          {inCart ? <Minus size={16} /> : <Plus size={16} />}
                        </button>
                      </li>
                    );
                  })}
                  {visible.length === 0 && <li className="py-6 text-center text-[13.5px] text-slate-500">Ничего не нашлось. Попробуйте другое название или спросите ассистента.</li>}
                </ul>
              </>
            ) : (
              <ul className="space-y-2">
                {catalog.labs.map((lab) => (
                  <li key={lab.id}><Link to={`/labs/lab/${lab.id}`} className="flex items-center justify-between rounded-2xl border border-slate-200 p-3 hover:border-violet-400 dark:border-slate-700">
                    <span className="font-semibold">{lab.name}</span><span className="text-[12.5px] text-slate-500">{lab.branchesCount} филиалов</span>
                  </Link></li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900" aria-label="Корзина и условия" data-testid="labs-cart">
            <h2 className="flex items-center gap-2 text-[15px] font-bold"><ShoppingBasket size={17} aria-hidden="true" />Корзина: {cart.length ? `${cart.length} ${cart.length === 1 ? 'исследование' : cart.length < 5 ? 'исследования' : 'исследований'}` : 'пусто'}</h2>
            {cart.length === 0 && <p className="mt-1 text-[13px] text-slate-500">Добавьте исследования из направления — подбор сравнит полную стоимость в лабораториях.</p>}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {cart.map((code) => (
                <span key={code} className="flex items-center gap-1 rounded-full bg-violet-50 py-1 pl-3 pr-1 text-[12.5px] font-medium text-violet-800 dark:bg-violet-900/30 dark:text-violet-100">
                  {byCode.get(code)?.name || code}
                  <button type="button" onClick={() => toggle(code)} aria-label={`Убрать ${byCode.get(code)?.name || code}`} className="rounded-full p-0.5 hover:bg-violet-200 dark:hover:bg-violet-800"><X size={13} /></button>
                </span>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <label className="text-[12px] text-slate-500">День<select className={selectClass} value={filters.date} onChange={(event) => setFilter('date', event.target.value)} data-testid="labs-filter-date">{DATE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="text-[12px] text-slate-500">Время<select className={selectClass} value={filters.timeOfDay} onChange={(event) => setFilter('timeOfDay', event.target.value)} data-testid="labs-filter-time">{TIME_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="text-[12px] text-slate-500">Готовность<select className={selectClass} value={filters.maxTurnaroundHours} onChange={(event) => setFilter('maxTurnaroundHours', event.target.value)}>{TURNAROUND_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="text-[12px] text-slate-500">До, ₽ за всё<input inputMode="numeric" className={selectClass} value={filters.maxTotalPrice} onChange={(event) => setFilter('maxTotalPrice', event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="без ограничения" data-testid="labs-filter-price" /></label>
              <label className="text-[12px] text-slate-500">Откуда ехать<select className={selectClass} value={filters.place} onChange={(event) => {
                setFilter('place', event.target.value);
                if (event.target.value === 'geo') askGeo();
              }}><option value="">Не учитывать</option><option value="geo">Моё местоположение</option>{Object.entries(KAZAN_PLACES).map(([key, place]) => <option key={key} value={key}>{place.from.replace(/^от /, '')}</option>)}</select></label>
              <label className="text-[12px] text-slate-500">В пути<select className={selectClass} value={filters.maxMinutes} disabled={!filters.place} onChange={(event) => setFilter('maxMinutes', event.target.value)}>{MINUTES_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Порядок">
              {SORT_OPTIONS.map(([value, label]) => (
                <button key={value} type="button" role="radio" aria-checked={filters.sort === value} onClick={() => setFilter('sort', value)} disabled={value === 'distance' && !filters.place}
                  className={`rounded-full px-3 py-1 text-[12.5px] ${filters.sort === value ? 'bg-slate-900 font-semibold text-white dark:bg-white dark:text-slate-900' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'} disabled:opacity-40`}>{label}</button>
              ))}
            </div>
          </section>

          <section ref={resultsRef} aria-label="Результаты подбора" className="space-y-2" data-testid="labs-results">
            {shown.status === 'loading' && <p className="flex items-center gap-2 text-[13.5px] text-slate-500"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Сравниваю лаборатории…</p>}
            {shown.status === 'error' && <p className="text-[13.5px] text-rose-700">{shown.error}</p>}
            {result && result.status === 'ok' && (
              <>
                <p className="text-[13px] text-slate-600 dark:text-slate-300" data-testid="labs-results-summary">Подходит {result.total} {result.total === 1 ? 'филиал' : result.total < 5 ? 'филиала' : 'филиалов'}. {result.comparisonScope}</p>
                {result.notes.map((note) => <p key={note} className="rounded-xl bg-sky-50 p-2.5 text-[12.5px] text-sky-900 dark:bg-sky-950/40 dark:text-sky-100">{note}</p>)}
                {result.options.map((option, position) => (
                  <LabOptionCard key={option.branch.id} option={option} index={position + 1} onBook={(item, slot) => setDialog({ option: item, slotId: slot?.id || null })} onFocus={(item) => setFocus([item.branch.lat, item.branch.lng])} />
                ))}
              </>
            )}
            {result && result.status === 'empty' && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-[13.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="labs-results-empty">
                <p>{blockedText(result)}</p>
              </div>
            )}
            {result?.partial?.length > 0 && result.status === 'empty' && (
              <div className="space-y-1.5">
                <p className="text-[12.5px] font-semibold text-slate-600 dark:text-slate-300">Частично:</p>
                {result.partial.map((item) => <p key={item.branch.id} className="text-[12.5px] text-slate-600 dark:text-slate-300">{item.lab.name} ({item.branch.name}): нет {item.missing.map((missing) => missing.name).join(', ')}</p>)}
              </div>
            )}
            {result?.tests?.some((test) => test.preparation) && (
              <details className="rounded-2xl border border-slate-200 bg-white p-3 text-[13px] dark:border-slate-800 dark:bg-slate-900">
                <summary className="cursor-pointer font-semibold"><ListChecks size={14} className="mr-1 inline" aria-hidden="true" />Как подготовиться</summary>
                <ul className="mt-2 space-y-1.5">{result.tests.map((test) => <li key={test.code}><strong>{test.name}.</strong> {test.preparation}</li>)}</ul>
                <p className="mt-2 text-[12px] text-slate-500">{result.preparationNote}</p>
              </details>
            )}
          </section>
        </div>
        <div className="h-[420px] overflow-hidden rounded-3xl border border-slate-200 lg:sticky lg:top-4 lg:h-[calc(100vh-180px)] dark:border-slate-800" data-testid="labs-map">
          <BranchMap branches={catalog.branches} options={result?.options || []} focus={focus} onSelect={(branchId) => {
            const card = resultsRef.current?.querySelector(`[data-branch="${branchId}"]`);
            card?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
          }} />
        </div>
      </div>
      {dialog && <LabBookingDialog branch={dialog.option.branch} lab={dialog.option.lab} tests={cart} initialSlotId={dialog.slotId} onClose={() => setDialog(null)} />}
    </Shell>
  );
}

function TestView({ code, cart, setCart, onMyBookings }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    fetchLabTest(code, { signal: controller.signal }).then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error) => !controller.signal.aborted && setState({ status: 'error', data: null, error: error.message }));
    return () => controller.abort();
  }, [code]);
  const test = state.data?.test;
  const inCart = cart.includes(code);
  return (
    <Shell title={test?.name || 'Исследование'} back="/labs" onMyBookings={onMyBookings}>
      <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="labs-test-page">
        {state.status === 'loading' && <p className="text-slate-500">Загружаю…</p>}
        {state.status === 'error' && <p className="text-rose-700">{state.error}</p>}
        {test && (
          <>
            <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-[12.5px] text-slate-500">{test.biomaterialName}{test.unit ? ` · ${test.unit}` : ''}{test.requiresBooking ? ' · только по записи' : ''}</p>
              {test.synonyms?.length > 0 && <p className="mt-1 text-[13px] text-slate-600 dark:text-slate-300">Ещё называют: {test.synonyms.join(', ')}</p>}
              {test.description && <p className="mt-2 text-[14px]">{test.description}</p>}
              {test.components?.length > 0 && <p className="mt-2 text-[13px] text-slate-600 dark:text-slate-300">Состав: {test.components.join(', ')}</p>}
              <button type="button" onClick={() => setCart((current) => (inCart ? current.filter((item) => item !== code) : [...current, code]))} data-testid="labs-test-toggle"
                className={`mt-3 rounded-xl px-4 py-2 text-[14px] font-semibold ${inCart ? 'border border-violet-300 text-violet-700 dark:text-violet-200' : 'bg-violet-600 text-white hover:bg-violet-700'}`}>
                {inCart ? 'В корзине — убрать' : 'Добавить в корзину'}
              </button>
              {cart.length > 0 && <Link to="/labs" className="ml-3 text-[13.5px] font-semibold text-violet-700 dark:text-violet-300">Подобрать лабораторию для корзины ({cart.length}) →</Link>}
            </section>
            <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="text-[15px] font-bold">Подготовка</h2>
              <p className="mt-1 text-[14px]">{test.preparation}</p>
              <p className="mt-2 text-[12px] text-slate-500">{state.data.preparationNote}</p>
            </section>
            <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="text-[15px] font-bold">Где сдать (демо)</h2>
              <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800">
                {state.data.labs.map((lab) => (
                  <li key={lab.id} className="flex items-center justify-between gap-3 py-2 text-[13.5px]">
                    <Link to={`/labs/lab/${lab.id}`} className="font-semibold hover:text-violet-700">{lab.name}</Link>
                    <span className="text-right text-slate-600 dark:text-slate-300">{lab.minPrice === lab.maxPrice ? formatRub(lab.minPrice) : `${formatRub(lab.minPrice)} – ${formatRub(lab.maxPrice)}`} · {lab.turnaroundText} · {lab.branches.length} фил.</span>
                  </li>
                ))}
                {state.data.labs.length === 0 && <li className="py-2 text-[13.5px] text-slate-500">Сейчас нигде не делается.</li>}
              </ul>
              <p className="mt-2 text-[12px] text-slate-500">К цене исследования добавляется взятие биоматериала — полную стоимость покажет подбор.</p>
            </section>
            {state.data.demoResults.map((item) => (
              <section key={item.id} className="rounded-3xl border border-dashed border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900" data-testid="labs-demo-result">
                <h2 className="text-[15px] font-bold">{item.title}</h2>
                <table className="mt-2 w-full text-[13px]"><thead><tr className="text-left text-slate-500"><th className="py-1">Показатель</th><th>Значение</th><th>Ед.</th><th>Референс</th></tr></thead>
                  <tbody>{item.rows.map((row) => <tr key={row.name} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1">{row.name}</td><td className="font-semibold">{row.value}</td><td>{row.unit}</td><td>{row.reference}</td></tr>)}</tbody></table>
                <p className="mt-2 text-[12px] text-amber-800 dark:text-amber-200">{item.disclaimer}</p>
              </section>
            ))}
          </>
        )}
      </div>
    </Shell>
  );
}

function LabView({ id, cart, onMyBookings }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null);
  const [focus, setFocus] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchLab(id, { signal: controller.signal }).then((data) => setState({ status: 'ready', data, error: null }))
      .catch((error) => !controller.signal.aborted && setState({ status: 'error', data: null, error: error.message }));
    return () => controller.abort();
  }, [id]);
  const data = state.data;
  const needle = query.trim().toLowerCase();
  return (
    <Shell title={data?.lab?.name || 'Лаборатория'} back="/labs" onMyBookings={onMyBookings}>
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-4 p-4 lg:grid-cols-2" data-testid="labs-lab-page">
        {state.status === 'loading' && <p className="text-slate-500">Загружаю…</p>}
        {state.status === 'error' && <p className="text-rose-700">{state.error}</p>}
        {data && (
          <>
            <div className="min-w-0 space-y-4">
              <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <p className="text-[14px]">{data.lab.description}</p>
                {data.lab.phone && <p className="mt-1 text-[13px] text-slate-500">Телефон (демо): {data.lab.phone}</p>}
              </section>
              <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <h2 className="text-[15px] font-bold">Филиалы</h2>
                <ul className="mt-2 space-y-3">
                  {data.branches.map((branch) => (
                    <li key={branch.id} className="rounded-2xl border border-slate-100 p-3 text-[13px] dark:border-slate-800" data-testid="labs-branch">
                      <p className="font-semibold">{branch.name}</p>
                      <p className="flex items-start gap-1 text-slate-500"><MapPin size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{branch.address}</p>
                      <p className="mt-1">Работает: {describeWeekly(branch.hours)}</p>
                      <p>Приём биоматериала: {describeWeekly(branch.collection)}</p>
                      <p className="mt-1 text-slate-500">{branch.fees.map((fee) => `${fee.name} — ${formatRub(fee.price)}`).join(' · ')}</p>
                      <div className="mt-2 flex gap-2">
                        <button type="button" disabled={cart.length === 0} onClick={() => setDialog(branch)} className="rounded-xl bg-violet-600 px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40">Записаться с корзиной</button>
                        <button type="button" onClick={() => setFocus([branch.lat, branch.lng])} className="rounded-xl border border-slate-200 px-3 py-1.5 text-[13px] dark:border-slate-700">На карте</button>
                      </div>
                      {cart.length === 0 && <p className="mt-1 text-[12px] text-slate-500">Сначала добавьте исследования в корзину.</p>}
                    </li>
                  ))}
                </ul>
              </section>
              <section className="rounded-3xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                <h2 className="text-[15px] font-bold">Исследования и цены (демо)</h2>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по названию" className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[13.5px] dark:border-slate-700 dark:bg-slate-800" />
                <ul className="mt-2 max-h-[360px] divide-y divide-slate-100 overflow-y-auto text-[13px] dark:divide-slate-800">
                  {data.tests.filter((test) => !needle || test.name.toLowerCase().includes(needle)).map((test) => (
                    <li key={test.code} className="flex justify-between gap-3 py-1.5">
                      <Link to={`/labs/test/${test.code}`} className="hover:text-violet-700">{test.name}</Link>
                      <span className="shrink-0 text-slate-600 dark:text-slate-300">{test.minPrice === test.maxPrice ? formatRub(test.minPrice) : `${formatRub(test.minPrice)}–${formatRub(test.maxPrice)}`} · {test.turnaroundText}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
            <div className="h-[420px] overflow-hidden rounded-3xl border border-slate-200 lg:sticky lg:top-4 lg:h-[calc(100vh-180px)] dark:border-slate-800">
              <BranchMap branches={data.branches} focus={focus} />
            </div>
          </>
        )}
      </div>
      {dialog && <LabBookingDialog branch={dialog} lab={data.lab} tests={cart} onClose={() => setDialog(null)} />}
    </Shell>
  );
}

export default function LabsPage() {
  const { path, search } = useLocation();
  const [catalog, setCatalog] = useState({ status: 'loading', data: null, error: null });
  const initialRequest = useMemo(() => readInitialRequest(search), [search]);
  const [cart, setCartState] = useState(() => (initialRequest?.tests?.length ? initialRequest.tests.filter((code) => /^[A-Z0-9_]{2,40}$/.test(code)) : readLabCart()));
  const [myBookings, setMyBookings] = useState(false);
  const setCart = useCallback((update) => setCartState((current) => {
    const next = typeof update === 'function' ? update(current) : update;
    writeLabCart(next);
    return next;
  }), []);

  useEffect(() => {
    if (initialRequest?.tests?.length) writeLabCart(cart);
    // Запрос от ассистента разобран — из адреса его убираем, чтобы «Назад» не возвращал старые условия.
    if (initialRequest) navigate('/labs', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchLabCatalog({ signal: controller.signal }).then((data) => setCatalog({ status: 'ready', data, error: null }))
      .catch((error) => !controller.signal.aborted && setCatalog({ status: 'error', data: null, error: error.message }));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    document.title = 'Лаборатории — МедКарта';
  }, []);

  const openMine = () => setMyBookings(true);
  let content;
  const testMatch = path.match(/^\/labs\/test\/([A-Z0-9_]{2,40})$/);
  const labMatch = path.match(/^\/labs\/lab\/([a-z0-9-]{2,80})$/);
  if (testMatch) content = <TestView code={testMatch[1]} cart={cart} setCart={setCart} onMyBookings={openMine} />;
  else if (labMatch) content = <LabView id={labMatch[1]} cart={cart} onMyBookings={openMine} />;
  else if (catalog.status === 'ready') content = <CatalogView catalog={catalog.data} cart={cart} setCart={setCart} initialRequest={initialRequest} onMyBookings={openMine} />;
  else {
    content = (
      <Shell title="Анализы и лаборатории" onMyBookings={openMine}>
        <div className="p-6 text-[14px] text-slate-600 dark:text-slate-300">
          {catalog.status === 'loading' ? <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Загружаю каталог…</span>
            : <span><FlaskConical size={16} className="mr-1 inline" aria-hidden="true" />{catalog.error || 'Раздел лабораторий сейчас недоступен.'}</span>}
        </div>
      </Shell>
    );
  }
  return (
    <>
      {content}
      {myBookings && <MyBookings onClose={() => setMyBookings(false)} />}
    </>
  );
}
