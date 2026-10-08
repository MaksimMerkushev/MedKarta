/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Окно маркера, в котором много врачей: РКБ и ДРКБ — по 320 человек
 * на одних координатах. Поиск, фильтр по специальности, группы.
 * Логика отбора — в placeList.js, здесь только отображение.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Heart, Navigation, Search, X, XCircle } from 'lucide-react';

import { buildPlaceList, highlightParts } from './placeList.js';

/** С какого размера точки показывать поиск и фильтры: для трёх врачей это шум. */
const SEARCH_FROM = 6;

/** Сколько фильтров по специальности видно до «Ещё». */
const CHIPS_COLLAPSED = 5;

const plural = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

const Highlight = ({ text, tokens }) =>
  highlightParts(text, tokens).map((part, index) =>
    part.match ? (
      <mark key={index} className="rounded-sm bg-amber-200 text-inherit dark:bg-amber-500/40">
        {part.text}
      </mark>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );

const metaOf = (doc, withSpecialty) =>
  [
    withSpecialty ? doc.doctorProfile || doc.specialty : null,
    doc.department || doc.position,
    doc.experience > 0 ? `стаж ${doc.experience} ${plural(doc.experience, 'год', 'года', 'лет')}` : null,
    doc.rating > 0 ? `★ ${doc.rating}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

export default function PlaceDoctorList({ items, onAddToRoute, onRemoveFromRoute, onToggleFavorite }) {
  const [query, setQuery] = useState('');
  const [specialty, setSpecialty] = useState(null);
  const [allChips, setAllChips] = useState(false);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const withTools = items.length >= SEARCH_FROM;
  const result = useMemo(() => buildPlaceList(items, { query, specialty }), [items, query, specialty]);

  // Фокус в поиск сразу — только при мыши. На телефоне это открыло бы
  // клавиатуру поверх карты, хотя человек, может, просто листает.
  useEffect(() => {
    if (!withTools) return;
    if (window.matchMedia?.('(pointer: fine)').matches) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [withTools]);

  // Сменился запрос или фильтр — к началу списка.
  useEffect(() => {
    listRef.current?.scrollTo?.({ top: 0 });
  }, [query, specialty]);

  const reset = () => {
    setQuery('');
    setSpecialty(null);
  };

  const onKeyDown = (event) => {
    // Esc сначала очищает поиск и только потом, вторым нажатием, закрывает окно.
    if (event.key === 'Escape' && (query || specialty)) {
      event.preventDefault();
      reset();
    }
    event.stopPropagation();
  };

  const chips = result.chips;
  let visibleChips = allChips ? chips : chips.slice(0, CHIPS_COLLAPSED);
  // Выбранный фильтр виден всегда, даже если он в свёрнутой части.
  if (specialty && !visibleChips.some((chip) => chip.specialty === specialty)) {
    const selected = chips.find((chip) => chip.specialty === specialty) || { specialty, count: 0 };
    visibleChips = [...visibleChips, selected];
  }
  const hiddenChips = chips.length - visibleChips.length;

  const chipClass = (active) =>
    `rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap transition-colors ${
      active
        ? 'border-blue-600 bg-blue-600 text-white'
        : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300'
    }`;

  return (
    <div className="w-full">
      <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
        <span>
          {result.total} {plural(result.total, 'специалист', 'специалиста', 'специалистов')}
        </span>
        {(query || specialty) && (
          <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            найдено {result.shown}
          </span>
        )}
      </div>

      {withTools && (
        <>
          <label className="relative mb-2 block">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Фамилия, специальность, отделение"
              aria-label="Поиск врача в этом учреждении"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-7 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-blue-400 focus:bg-white focus:ring-2 focus:ring-blue-100 dark:border-slate-600 dark:bg-slate-900 dark:text-white dark:focus:bg-slate-900 dark:focus:ring-blue-900 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  inputRef.current?.focus({ preventScroll: true });
                }}
                aria-label="Очистить поиск"
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:bg-slate-200 hover:text-slate-600 dark:hover:bg-slate-700"
              >
                <X size={12} />
              </button>
            )}
          </label>

          {result.layoutQuery && (
            <div className="mb-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              Ищем «{result.layoutQuery}» — похоже, была английская раскладка
            </div>
          )}

          {chips.length > 1 && (
            /*
              Раскрытые чипы прокручиваются внутри своей полосы: иначе окно
              на телефоне росло вверх, и заголовок, крестик и поиск уходили
              за верхний край экрана.
            */
            <div
              className={`mb-2 flex flex-wrap gap-1 ${allChips ? 'max-h-24 overflow-y-auto overscroll-contain' : ''}`}
              role="group"
              aria-label="Фильтр по специальности"
            >
              <button type="button" className={chipClass(specialty === null)} onClick={() => setSpecialty(null)}>
                Все
              </button>
              {visibleChips.map((chip) => (
                <button
                  key={chip.specialty}
                  type="button"
                  aria-pressed={specialty === chip.specialty}
                  className={chipClass(specialty === chip.specialty)}
                  onClick={() => setSpecialty(specialty === chip.specialty ? null : chip.specialty)}
                >
                  {chip.specialty} <span className="opacity-70">{chip.count}</span>
                </button>
              ))}
              {hiddenChips > 0 && (
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() => setAllChips(true)}
                >
                  ещё {hiddenChips}
                </button>
              )}
              {allChips && chips.length > CHIPS_COLLAPSED && (
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  onClick={() => setAllChips(false)}
                >
                  свернуть
                </button>
              )}
            </div>
          )}
        </>
      )}

      <div
        ref={listRef}
        // Раскрытые чипы занимают место — список на телефоне становится ниже,
        // чтобы окно целиком оставалось на экране.
        className={`-mx-1 max-h-72 overflow-y-auto overscroll-contain px-1 scrollbar-thin ${allChips ? 'max-sm:max-h-[24vh]' : 'max-sm:max-h-[36vh]'}`}
        data-testid="place-doctor-list"
      >
        {result.shown === 0 ? (
          <div className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
            <div className="mb-2">Никого не нашли{query ? ` по запросу «${query.trim()}»` : ''}</div>
            <button
              type="button"
              onClick={reset}
              className="rounded-lg border border-slate-200 px-3 py-1 font-semibold text-blue-600 hover:bg-blue-50 dark:border-slate-600 dark:text-blue-400 dark:hover:bg-slate-700"
            >
              Сбросить поиск
            </button>
          </div>
        ) : (
          result.sections.map((section) => {
            const pinned = section.key === 'route' || section.key === 'favorites' || section.key === 'facilities';
            return (
              <section key={section.key} className="mb-1">
                <h4 className="sticky top-0 z-10 flex items-center justify-between bg-white py-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:bg-slate-800 dark:text-slate-500">
                  <span className={section.key === 'route' ? 'text-red-500' : section.key === 'favorites' ? 'text-amber-600' : ''}>
                    {section.title}
                  </span>
                  <span>{section.items.length}</span>
                </h4>
                <ul>
                  {section.items.map((doc) => {
                    const meta = metaOf(doc, pinned && doc.entityKind !== 'facility');
                    return (
                      <li
                        key={doc.id}
                        className={`flex items-center gap-1.5 rounded-lg px-1.5 py-1 ${
                          doc.isRouteTarget ? 'bg-red-50/70 dark:bg-red-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-semibold leading-snug text-slate-800 dark:text-white">
                            <Highlight text={doc.name} tokens={result.tokens} />
                          </div>
                          {meta && (
                            <div className="truncate text-[11px] leading-snug text-slate-500 dark:text-slate-400" title={meta}>
                              <Highlight text={meta} tokens={result.tokens} />
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => (doc.isRouteTarget ? onRemoveFromRoute(doc.id) : onAddToRoute(doc))}
                          title={doc.isRouteTarget ? 'Убрать из маршрута' : 'Добавить в маршрут'}
                          aria-label={`${doc.isRouteTarget ? 'Убрать из маршрута' : 'Добавить в маршрут'}: ${doc.name}`}
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors pointer-coarse:h-11 pointer-coarse:w-11 ${
                            doc.isRouteTarget
                              ? 'bg-red-100 text-red-600 hover:bg-red-200 dark:bg-red-900 dark:text-red-200'
                              : 'bg-blue-600 text-white hover:bg-blue-700'
                          }`}
                        >
                          {doc.isRouteTarget ? <XCircle size={14} /> : <Navigation size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleFavorite(doc.id)}
                          title={doc.isFavorite ? 'Убрать из избранного' : 'В избранное'}
                          aria-label={`${doc.isFavorite ? 'Убрать из избранного' : 'В избранное'}: ${doc.name}`}
                          aria-pressed={Boolean(doc.isFavorite)}
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors pointer-coarse:h-11 pointer-coarse:w-11 ${
                            doc.isFavorite
                              ? 'border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-800 dark:bg-amber-900/40'
                              : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:border-slate-600 dark:bg-slate-700'
                          }`}
                        >
                          <Heart size={13} fill={doc.isFavorite ? 'currentColor' : 'none'} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
