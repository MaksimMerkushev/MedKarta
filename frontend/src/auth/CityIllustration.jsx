/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Иллюстрация к экранам входа: фрагмент городской карты — кварталы, река,
 * зоны доступности 5/10/15 минут вокруг клиники и маршрут от точки «вы
 * здесь». Маршрут прорисовывается один раз; при prefers-reduced-motion всё
 * показано сразу. Чистая декорация: aria-hidden, без данных.
 */
import { motion as Motion, useReducedMotion } from 'motion/react';

import { EASE } from './motion';

const PIN = { x: 330, y: 300 };

// Изохроны неровные, как настоящие: вдоль улиц дальше, через реку — ближе.
const RINGS = [
  { minutes: 15, d: 'M330 92c78 2 150 34 182 96 30 58 24 132-8 186-34 58-96 104-170 110-80 6-152-18-196-74-40-52-52-122-30-180 26-70 78-110 128-128 32-10 62-10 94-10z', label: { x: 474, y: 152 } },
  { minutes: 10, d: 'M332 162c52 0 98 22 120 62 22 40 18 90-4 128-24 42-70 70-122 72-54 2-100-20-124-60-22-36-22-84 0-122 24-46 74-80 130-80z', label: { x: 432, y: 214 } },
  { minutes: 5, d: 'M330 232c34 0 62 16 72 42 10 26 4 54-14 72-18 18-46 26-72 20-28-6-50-26-56-52-6-28 6-56 30-70 12-8 26-12 40-12z', label: { x: 392, y: 258 } },
];

const STREETS = [
  'M0 132 H560', 'M0 236 H260 L300 226 H560', 'M0 352 H560', 'M0 456 L180 448 H560', 'M0 552 H560',
  'M86 0 V640', 'M196 0 V250 L210 640', 'M300 0 V640', 'M420 0 L410 330 V640', 'M512 0 V640',
  'M0 40 L560 300',
];
const MINOR = [
  'M0 186 H560', 'M0 296 H560', 'M0 404 H560', 'M0 504 H560', 'M140 0 V640', 'M250 0 V640', 'M362 0 V640', 'M466 0 V640',
];
const PARKS = [
  { x: 214, y: 146, w: 72, h: 76 },
  { x: 432, y: 470, w: 66, h: 70 },
  { x: 100, y: 22, w: 82, h: 96 },
];

// Маршрут — по улицам, без срезания углов.
const ROUTE = 'M120 524 H196 L192 456 L300 452 V352 H330 V318';

export default function CityIllustration() {
  const reduced = useReducedMotion();
  const appear = (delay) => (reduced ? { initial: false } : {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.6, delay, ease: EASE },
  });

  return (
    <svg viewBox="0 0 560 640" className="h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <rect width="560" height="640" className="fill-slate-100 dark:fill-slate-900" />

      {PARKS.map((park) => (
        <rect key={`${park.x}-${park.y}`} x={park.x} y={park.y} width={park.w} height={park.h} rx="10" className="fill-emerald-100/80 dark:fill-emerald-900/25" />
      ))}

      {/* Река (Казанка) и набережная. */}
      <path d="M-20 600 C80 560 120 610 210 590 S330 520 380 560 470 640 590 600" className="fill-none stroke-sky-200 dark:stroke-sky-900/60" strokeWidth="44" strokeLinecap="round" />
      <path d="M-20 600 C80 560 120 610 210 590 S330 520 380 560 470 640 590 600" className="fill-none stroke-sky-300/70 dark:stroke-sky-800/50" strokeWidth="2" strokeDasharray="2 10" strokeLinecap="round" />

      <g className="stroke-white dark:stroke-slate-800" strokeWidth="3" fill="none">
        {MINOR.map((d) => <path key={d} d={d} />)}
      </g>
      <g className="stroke-white dark:stroke-slate-700/80" strokeWidth="9" fill="none" strokeLinecap="round" strokeLinejoin="round">
        {STREETS.map((d) => <path key={d} d={d} />)}
      </g>

      {RINGS.map((ring, index) => (
        <Motion.g key={ring.minutes} {...appear(0.15 + index * 0.12)}>
          <path d={ring.d} className="fill-blue-600/[0.07] stroke-blue-600/40 dark:fill-blue-400/[0.07] dark:stroke-blue-400/40" strokeWidth="1.5" strokeDasharray={ring.minutes === 5 ? undefined : '5 6'} />
        </Motion.g>
      ))}
      {RINGS.map((ring, index) => (
        <Motion.g key={`label-${ring.minutes}`} {...appear(0.5 + index * 0.08)}>
          <rect x={ring.label.x - 30} y={ring.label.y - 13} width="60" height="26" rx="13" className="fill-white stroke-slate-200 dark:fill-slate-800 dark:stroke-slate-700" strokeWidth="1" />
          <text x={ring.label.x} y={ring.label.y + 4.5} textAnchor="middle" className="fill-slate-600 dark:fill-slate-300" style={{ font: '600 12.5px system-ui, -apple-system, Segoe UI, sans-serif' }}>{ring.minutes} мин</text>
        </Motion.g>
      ))}

      {/* Маршрут: подложка и линия, которая прорисовывается один раз. */}
      <path d={ROUTE} className="fill-none stroke-white dark:stroke-slate-950" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
      <Motion.path
        d={ROUTE}
        className="fill-none stroke-blue-700 dark:stroke-blue-400"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.3, delay: 0.55, ease: [0.65, 0, 0.35, 1] }}
      />

      {/* Вы здесь. */}
      <circle cx="120" cy="524" r="16" className="fill-blue-600/15 dark:fill-blue-400/20" />
      <circle cx="120" cy="524" r="8" className="fill-blue-700 stroke-white dark:fill-blue-400 dark:stroke-slate-900" strokeWidth="3" />

      {/* Клиника — фирменная метка МедКарты. */}
      <Motion.g
        initial={reduced ? false : { opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 22, delay: 0.3 }}
      >
        <ellipse cx={PIN.x} cy={PIN.y + 4} rx="11" ry="4" className="fill-slate-900/15 dark:fill-black/40" />
        <path d={`M${PIN.x} ${PIN.y}c-4-14-24-26-24-44a24 24 0 0 1 48 0c0 18-20 30-24 44z`} fill="#dc2626" className="stroke-white dark:stroke-slate-900" strokeWidth="2.5" />
        <path d={`M${PIN.x - 3.5} ${PIN.y - 54}h7v8h8v7h-8v8h-7v-8h-8v-7h8z`} fill="#fff" />
      </Motion.g>
    </svg>
  );
}
