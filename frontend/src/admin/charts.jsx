/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Графики дашборда на SVG без библиотек. Правила: одна ось Y от нуля,
 * линия 2 px с заливкой ~10 %, столбцы не толще 24 px со скруглённым
 * верхом и зазором 2 px, тонкая сетка, подсказка по наведению и с
 * клавиатуры, легенда при двух рядах и таблица — для тех, кто не видит цвет.
 * Цвета — переменные --viz-* (index.css), проверенные на дальтонизм для
 * светлой и тёмной темы.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Table2 } from 'lucide-react';

import { formatNumber } from '../ui/format';

const PADDING = { top: 14, right: 16, bottom: 26, left: 40 };

const niceMax = (value) => {
  if (!Number.isFinite(value) || value <= 0) return 4;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  let max = nice * exponent;
  if (max < 4) max = 4;
  // Счётчики — целые: середина оси тоже должна быть целой (не «2,5»).
  if (!Number.isInteger(max / 2)) max = Math.ceil(max / 2) * 2;
  return max;
};

const compact = (value) => (value >= 1000 ? `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} тыс.` : formatNumber(value));

const useWidth = () => {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => setWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
};

function Legend({ series }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-slate-600 dark:text-slate-300">
      {series.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: `var(${item.color})` }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ labels, series, caption }) {
  return (
    <div className="max-h-64 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
      <table className="w-full text-left text-[12.5px]">
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 bg-slate-50 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">Период</th>
            {series.map((item) => <th key={item.key} scope="col" className="px-3 py-2 text-right font-semibold">{item.label}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 tabular-nums dark:divide-slate-800">
          {labels.map((label, index) => (
            <tr key={label}>
              <td className="px-3 py-1.5 text-slate-600 dark:text-slate-300">{label}</td>
              {series.map((item) => <td key={item.key} className="px-3 py-1.5 text-right text-slate-800 dark:text-slate-100">{formatNumber(item.values[index])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Временной ряд: type 'area' (один ряд — линия с заливкой) или 'columns'
 * (один-два ряда столбцов рядом). labels — подписи корзин для оси и подсказки.
 */
export function TimeChart({ labels, axisLabels = labels, series, type = 'columns', height = 200, caption, emptyText = 'Нет данных за период' }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const count = labels.length;
  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((item) => item.values))), [series]);
  const allZero = series.every((item) => item.values.every((value) => !value));

  const innerWidth = Math.max(0, width - PADDING.left - PADDING.right);
  const innerHeight = height - PADDING.top - PADDING.bottom;
  const band = count > 0 ? innerWidth / count : 0;
  const x = (index) => PADDING.left + band * index + band / 2;
  const y = (value) => PADDING.top + innerHeight - (value / max) * innerHeight;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(innerWidth / 64))));

  const pointerIndex = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - rect.left - PADDING.left;
    return Math.min(count - 1, Math.max(0, Math.floor(position / band)));
  };

  const groupWidth = Math.min(band - 4, series.length * 24 + (series.length - 1) * 2);
  const barWidth = series.length > 0 ? Math.max(2, (groupWidth - (series.length - 1) * 2) / series.length) : 0;

  return (
    <figure className="mk-viz relative" aria-label={caption}>
      <div className="flex items-start justify-between gap-2">
        <Legend series={series} />
        <button type="button" onClick={() => setShowTable((current) => !current)} className="ml-auto inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11.5px] font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800" aria-pressed={showTable}>
          <Table2 size={13} aria-hidden="true" /> {showTable ? 'График' : 'Таблица'}
        </button>
      </div>
      {showTable ? (
        <DataTable labels={labels} series={series} caption={caption} />
      ) : (
        <div ref={ref} className="relative w-full" style={{ height }}>
          {width > 0 && (
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={caption}
              tabIndex={0}
              className="rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
              onPointerMove={(event) => setHover(pointerIndex(event))}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(count - 1)}
              onBlur={() => setHover(null)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') setHover((current) => Math.max(0, (current ?? count) - 1));
                if (event.key === 'ArrowRight') setHover((current) => Math.min(count - 1, (current ?? -1) + 1));
              }}
            >
              {ticks.map((tick) => (
                <g key={tick}>
                  <line x1={PADDING.left} x2={width - PADDING.right} y1={y(tick)} y2={y(tick)} stroke="var(--viz-grid)" strokeWidth="1" />
                  <text x={PADDING.left - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="tabular-nums" fill="var(--viz-muted)" fontSize="11">{compact(tick)}</text>
                </g>
              ))}
              {labels.map((label, index) => (index % labelEvery === 0 || index === count - 1) && (index === count - 1 || count - 1 - index >= labelEvery) ? (
                <text key={label} x={x(index)} y={height - 8} textAnchor="middle" fill="var(--viz-muted)" fontSize="11">{axisLabels[index]}</text>
              ) : null)}
              {hover !== null && (
                <rect x={PADDING.left + band * hover} y={PADDING.top} width={band} height={innerHeight} fill="var(--viz-hover)" />
              )}
              {type === 'area' && series[0] && count > 0 && (() => {
                const values = series[0].values;
                const points = values.map((value, index) => `${x(index)},${y(value)}`);
                const area = `M${x(0)},${y(0)} L${points.join(' L')} L${x(count - 1)},${y(0)} Z`;
                return (
                  <g>
                    <path d={area} fill={`var(${series[0].color})`} opacity="0.1" />
                    <polyline points={points.join(' ')} fill="none" stroke={`var(${series[0].color})`} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                    <circle cx={x(count - 1)} cy={y(values[count - 1])} r="4" fill={`var(${series[0].color})`} stroke="var(--viz-surface)" strokeWidth="2" />
                    {hover !== null && <circle cx={x(hover)} cy={y(values[hover])} r="4.5" fill={`var(${series[0].color})`} stroke="var(--viz-surface)" strokeWidth="2" />}
                  </g>
                );
              })()}
              {type === 'columns' && series.map((item, seriesIndex) => item.values.map((value, index) => {
                if (!value) return null;
                const left = x(index) - groupWidth / 2 + seriesIndex * (barWidth + 2);
                const top = y(value);
                const barHeight = Math.max(1, PADDING.top + innerHeight - top);
                const radius = Math.min(4, barWidth / 2, barHeight);
                const path = `M${left},${top + barHeight} V${top + radius} Q${left},${top} ${left + radius},${top} H${left + barWidth - radius} Q${left + barWidth},${top} ${left + barWidth},${top + radius} V${top + barHeight} Z`;
                return <path key={`${item.key}-${labels[index]}`} d={path} fill={`var(${item.color})`} opacity={hover === null || hover === index ? 1 : 0.55} />;
              }))}
              <line x1={PADDING.left} x2={width - PADDING.right} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" strokeWidth="1" />
            </svg>
          )}
          {allZero && width > 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-[12.5px] text-slate-400">{emptyText}</p>
          )}
          {hover !== null && width > 0 && (
            <div
              className="pointer-events-none absolute z-10 min-w-[120px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] shadow-lg dark:border-slate-700 dark:bg-slate-900"
              style={{ left: Math.min(Math.max(0, x(hover) - 70), width - 150), top: 0 }}
              role="status"
            >
              <p className="mb-1 font-medium text-slate-500 dark:text-slate-400">{labels[hover]}</p>
              {series.map((item) => (
                <p key={item.key} className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-3 rounded" style={{ background: `var(${item.color})` }} aria-hidden="true" />
                  <span className="font-bold tabular-nums text-slate-800 dark:text-white">{formatNumber(item.values[hover])}</span>
                  <span className="text-slate-500 dark:text-slate-400">{item.label}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** Горизонтальные полосы с подписью и значением на конце (распределение по ролям и т. п.). */
export function BarList({ items, caption }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <ul className="mk-viz space-y-2.5" aria-label={caption}>
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
            <span className="text-slate-600 dark:text-slate-300">{item.label}</span>
            <span className="font-bold tabular-nums text-slate-800 dark:text-white">{formatNumber(item.value)}</span>
          </div>
          <div className="h-2.5 w-full rounded-full" style={{ background: 'var(--viz-track)' }}>
            <div className="h-2.5 rounded-full" style={{ width: `${(item.value / max) * 100}%`, minWidth: item.value > 0 ? 6 : 0, background: 'var(--viz-1)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
