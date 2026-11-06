/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Иллюстрация к экранам входа: фрагмент городской карты — кварталы с домами,
 * парки, Казанка с мостами — и то, что МедКарта делает на ней: клиники
 * вокруг, зоны доступности 5/10/15 минут (ровные круги вокруг клиники),
 * маршрут от точки «Вы здесь» и ближайшее время приёма.
 *
 * Сначала один раз собирается сцена: клиники, метка, зоны, «Вы здесь»,
 * маршрут, время в пути, карточка. Потом, пока иллюстрация на экране, идёт
 * спокойный цикл: точка едет по маршруту, на финише метка подпрыгивает и
 * подсвечивается время приёма; от клиники расходятся волны, течёт река.
 * Всё движение — прозрачность, трансформации и атрибуты SVG одним рендером
 * Motion, без перерисовки React на каждый кадр. Невидимая иллюстрация (экран
 * уже 1024 px, вкладка в фоне) не анимируется; при prefers-reduced-motion
 * сразу показана готовая сцена без движения. Чистая декорация: aria-hidden.
 */
import { useEffect, useId, useRef } from 'react';
import { animate, easeInOut, motion as Motion, useInView, useMotionValue, useReducedMotion, useTransform } from 'motion/react';

import { EASE } from './motion';

const FONT = '600 12.5px system-ui, -apple-system, "Segoe UI", sans-serif';
const SMALL_FONT = '500 10.5px system-ui, -apple-system, "Segoe UI", sans-serif';

/* ------------------------------- Карта --------------------------------- */

// Сетка улиц: крупные — шире и пересекают реку мостами, мелкие — тоньше.
const MAJOR_X = [86, 196, 300, 420, 512];
const MINOR_X = [140, 250, 362, 466];
const MAJOR_Y = [132, 236, 352, 456, 552];
const MINOR_Y = [66, 186, 296, 404, 504];
const GRID_X = [0, ...[...MAJOR_X, ...MINOR_X].sort((a, b) => a - b), 560];
const GRID_Y = [0, ...[...MAJOR_Y, ...MINOR_Y].sort((a, b) => a - b)];
const AVENUE = 'M-10 36 L570 306';

// Парки — целыми кварталами: [x1, y1, x2, y2] по линиям сетки.
const PARKS = [[196, 132, 300, 186], [420, 456, 512, 504], [0, 132, 86, 236]];

const inPark = (x, y) => PARKS.some(([x1, y1, x2, y2]) => x >= x1 && x < x2 && y >= y1 && y < y2);

/** Дома в кварталах (до набережной): по одному-два на квартал, раскладка детерминирована номером квартала. */
const BUILDINGS = GRID_Y.slice(0, -1).flatMap((top, row) => {
  const bottom = GRID_Y[row + 1];
  return GRID_X.slice(0, -1).flatMap((left, col) => {
    const right = GRID_X[col + 1];
    if (inPark(left, top)) return [];
    const x = left + 7;
    const y = top + 7;
    const w = right - left - 14;
    const h = bottom - top - 14;
    const variant = (row * 7 + col * 3) % 4;
    if (variant === 0 && w > 30) return [{ x, y, w: (w - 5) / 2, h }, { x: x + (w + 5) / 2, y, w: (w - 5) / 2, h }];
    if (variant === 1 && h > 30) return [{ x, y, w, h: (h - 5) / 2 }, { x, y: y + (h + 5) / 2, w, h: (h - 5) / 2 }];
    return [{ x, y, w, h }];
  });
});

/** Деревья в парках — в шахматном порядке. */
const TREES = PARKS.flatMap(([x1, y1, x2, y2]) => {
  const trees = [];
  for (let row = 0, y = y1 + 16; y <= y2 - 14; row += 1, y += 14) {
    for (let x = x1 + 16 + (row % 2) * 7; x <= x2 - 14; x += 14) trees.push({ x, y });
  }
  return trees;
});

const RIVER_EDGE = 'M-20 578 C60 556 130 600 220 586 S340 540 392 566 S482 614 580 588';
const RIVER = `${RIVER_EDGE} V660 H-20 Z`;
const RIVER_FLOW = 'M-20 606 C60 584 130 628 220 614 S340 568 392 594 S482 642 580 616';

/* --------------------------- Клиника и зоны ----------------------------- */

const PIN = { x: 300, y: 296 };
// Подпись — точно на окружности, под своим углом: подписи не наезжают друг на
// друга и остаются в кадре, когда узкая колонка срезает края картинки.
const ZONES = [
  { minutes: 5, r: 72, angle: -25 },
  { minutes: 10, r: 146, angle: -40 },
  { minutes: 15, r: 222, angle: -55 },
].map((zone) => ({
  ...zone,
  label: {
    x: PIN.x + zone.r * Math.cos((zone.angle * Math.PI) / 180),
    y: PIN.y + zone.r * Math.sin((zone.angle * Math.PI) / 180),
  },
}));
const OUTER = ZONES[ZONES.length - 1].r;

// Другие клиники на перекрёстках: внутри 15-минутной зоны — синие, дальше — серые.
const CLINICS = [[362, 404], [466, 352], [466, 186], [140, 296], [362, 186], [86, 504], [512, 404], [512, 132], [140, 66]]
  .map(([x, y]) => ({ x, y, near: Math.hypot(x - PIN.x, y - PIN.y) <= OUTER }));

/* ------------------------------- Маршрут -------------------------------- */

const YOU = { x: 196, y: 456 };
const ROUTE_POINTS = [[YOU.x, YOU.y], [250, 456], [250, 352], [300, 352], [300, 312]];

/**
 * Маршрут по улицам со скруглёнными углами. Из одних и тех же точек — и
 * линия (d), и положение едущей точки (at): точка не сходит с линии.
 */
const buildRoute = (points, radius) => {
  const toward = (from, to, distance) => {
    const length = Math.hypot(from[0] - to[0], from[1] - to[1]);
    return [to[0] + ((from[0] - to[0]) / length) * distance, to[1] + ((from[1] - to[1]) / length) * distance];
  };
  const segments = [];
  let cursor = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const entry = toward(points[index - 1], points[index], radius);
    const exit = toward(points[index + 1], points[index], radius);
    segments.push({ from: cursor, to: entry });
    segments.push({ from: entry, control: points[index], to: exit });
    cursor = exit;
  }
  segments.push({ from: cursor, to: points[points.length - 1] });

  const pointOf = (segment, u) => {
    if (!segment.control) return [segment.from[0] + (segment.to[0] - segment.from[0]) * u, segment.from[1] + (segment.to[1] - segment.from[1]) * u];
    const a = (1 - u) ** 2;
    const b = 2 * (1 - u) * u;
    const c = u ** 2;
    return [a * segment.from[0] + b * segment.control[0] + c * segment.to[0], a * segment.from[1] + b * segment.control[1] + c * segment.to[1]];
  };
  let total = 0;
  for (const segment of segments) {
    let length = 0;
    let previous = segment.from;
    for (let step = 1; step <= 12; step += 1) {
      const next = pointOf(segment, step / 12);
      length += Math.hypot(next[0] - previous[0], next[1] - previous[1]);
      previous = next;
    }
    segment.start = total;
    segment.length = length;
    total += length;
  }

  const round = (value) => Math.round(value * 100) / 100;
  const d = segments.reduce((path, segment) => `${path} ${segment.control ? `Q${round(segment.control[0])} ${round(segment.control[1])} ` : 'L'}${round(segment.to[0])} ${round(segment.to[1])}`, `M${points[0][0]} ${points[0][1]}`);
  const at = (progress) => {
    const distance = Math.min(Math.max(progress, 0), 1) * total;
    const segment = segments.find((item) => distance <= item.start + item.length) || segments[segments.length - 1];
    return pointOf(segment, segment.length ? (distance - segment.start) / segment.length : 1);
  };
  return { d, at };
};

const ROUTE = buildRoute(ROUTE_POINTS, 10);

/* -------------------------------- Время --------------------------------- */

// Сборка сцены, с. Потом — цикл: поездка 0–0,6, финиш 0,6–0,9, пауза.
const T = { clinics: 0.1, pin: 0.3, zones: 0.5, you: 1.0, labels: 1.15, route: 1.35, card: 2.1, eta: 2.45, loop: 2.9 };
const CYCLE = 5.2;

/** Бесконечное движение — только когда иллюстрация на экране и движение не отключено. */
const loop = (active, keyframes, rest, transition) => (active
  ? { animate: keyframes, transition: { repeat: Infinity, ...transition } }
  : { animate: rest, transition: { duration: 0 } });

function Pill({ x, y, width, children }) {
  return (
    <>
      <rect x={x - width / 2} y={y - 13} width={width} height="26" rx="13" className="fill-white stroke-slate-200 dark:fill-slate-800 dark:stroke-slate-700" strokeWidth="1" />
      <text x={x} y={y + 4.5} textAnchor="middle" className="fill-slate-700 dark:fill-slate-200" style={{ font: FONT }}>{children}</text>
    </>
  );
}

export default function CityIllustration() {
  const svgRef = useRef(null);
  const reduced = useReducedMotion();
  const inView = useInView(svgRef, { amount: 0.25 });
  const active = inView && !reduced;
  const shadowId = `mk-city-shadow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  // Один такт цикла (0 → 1) — от него и поездка, и финиш: всё синхронно.
  const cycle = useMotionValue(0);
  useEffect(() => {
    if (!active) {
      cycle.set(0);
      return undefined;
    }
    const controls = animate(cycle, [0, 1], { duration: CYCLE, ease: 'linear', repeat: Infinity, delay: T.loop });
    return () => controls.stop();
  }, [active, cycle]);

  const travel = useTransform(cycle, [0, 0.6], [0, 1], { ease: easeInOut });
  const travelerX = useTransform(travel, (progress) => ROUTE.at(progress)[0]);
  const travelerY = useTransform(travel, (progress) => ROUTE.at(progress)[1]);
  const travelerOpacity = useTransform(cycle, [0, 0.04, 0.58, 0.64], [0, 1, 1, 0]);
  const arrivalR = useTransform(cycle, [0.6, 0.9], [8, 54]);
  const arrivalOpacity = useTransform(cycle, [0.58, 0.61, 0.9], [0, 0.55, 0]);
  const pinLift = useTransform(cycle, [0.58, 0.63, 0.7], [0, -7, 0]);
  const slotGlow = useTransform(cycle, [0.62, 0.68, 0.9], [0, 1, 0]);

  const intro = (delay, from = { opacity: 0 }, to = { opacity: 1 }, transition = { duration: 0.5, ease: EASE }) => (reduced
    ? { initial: false, animate: to }
    : { initial: from, animate: to, transition: { ...transition, delay } });
  const pop = (delay) => intro(delay, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1 }, { type: 'spring', stiffness: 420, damping: 22 });

  return (
    <svg ref={svgRef} viewBox="0 0 560 640" className="h-full w-full" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <filter id={shadowId} x="-20%" y="-30%" width="140%" height="170%">
          <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#0f172a" floodOpacity="0.12" />
        </filter>
      </defs>

      {/* Город: фон, дома, парки, мелкие улицы. */}
      <rect width="560" height="640" className="fill-slate-100 dark:fill-slate-900" />
      <g className="fill-slate-200/70 dark:fill-slate-800/60">
        {BUILDINGS.map((block) => <rect key={`${block.x}-${block.y}`} x={block.x} y={block.y} width={block.w} height={block.h} rx="3" />)}
      </g>
      {PARKS.map(([x1, y1, x2, y2]) => (
        <rect key={`${x1}-${y1}`} x={x1 + 6} y={y1 + 6} width={x2 - x1 - 12} height={y2 - y1 - 12} rx="10" className="fill-emerald-100 dark:fill-emerald-950/60" />
      ))}
      <g className="fill-emerald-200/90 dark:fill-emerald-800/40">
        {TREES.map((tree) => <circle key={`${tree.x}-${tree.y}`} cx={tree.x} cy={tree.y} r="4.5" />)}
      </g>
      <g className="stroke-white dark:stroke-slate-800" strokeWidth="3" fill="none">
        {MINOR_X.map((x) => <path key={`x${x}`} d={`M${x} 0 V560`} />)}
        {MINOR_Y.map((y) => <path key={`y${y}`} d={`M0 ${y} H560`} />)}
      </g>

      {/* Казанка: вода, берег, течение. Крупные улицы идут поверх — мостами. */}
      <path d={RIVER} className="fill-sky-200/80 dark:fill-sky-950/70" />
      <path d={RIVER_EDGE} className="fill-none stroke-sky-300/80 dark:stroke-sky-800/70" strokeWidth="1.5" />
      <Motion.path
        d={RIVER_FLOW}
        className="fill-none stroke-sky-400/60 dark:stroke-sky-700/70"
        strokeWidth="2"
        strokeDasharray="2 10"
        strokeLinecap="round"
        initial={{ strokeDashoffset: 0 }}
        {...loop(active, { strokeDashoffset: [0, -24] }, { strokeDashoffset: 0 }, { duration: 2.4, ease: 'linear' })}
      />
      <text x="110" y="604" className="fill-sky-600/70 dark:fill-sky-400/50" style={{ font: 'italic 500 11px system-ui, -apple-system, "Segoe UI", sans-serif' }}>р. Казанка</text>

      <g className="stroke-white dark:stroke-slate-700" strokeWidth="9" fill="none" strokeLinecap="round">
        {MAJOR_X.map((x) => <path key={`X${x}`} d={`M${x} -10 V650`} />)}
        {MAJOR_Y.map((y) => <path key={`Y${y}`} d={`M-10 ${y} H570`} />)}
        <path d={AVENUE} />
      </g>

      {/* Зоны доступности: ровные круги с общим центром в клинике. */}
      {ZONES.slice().reverse().map((zone, index) => {
        const dashed = zone.minutes !== 5;
        const delay = T.zones + (ZONES.length - 1 - index) * 0.16;
        return (
          <Motion.circle
            key={zone.minutes}
            cx={PIN.x}
            cy={PIN.y}
            className="fill-blue-600/[0.06] stroke-blue-600/45 dark:fill-blue-400/[0.07] dark:stroke-blue-400/45"
            strokeWidth="1.5"
            strokeDasharray={dashed ? '6 6' : undefined}
            initial={reduced ? false : { r: 0, opacity: 0, strokeDashoffset: 0 }}
            animate={{ r: zone.r, opacity: 1, strokeDashoffset: dashed && active ? [0, -24] : 0 }}
            transition={{
              r: { duration: 1.1, ease: EASE, delay },
              opacity: { duration: 0.35, delay },
              strokeDashoffset: dashed && active ? { duration: 3 + index, ease: 'linear', repeat: Infinity } : { duration: 0 },
            }}
          />
        );
      })}

      {/* Волны от клиники — радиус растёт до внешней зоны и гаснет. */}
      {[0, 1].map((wave) => (
        <Motion.circle
          key={`wave-${wave}`}
          cx={PIN.x}
          cy={PIN.y}
          className="fill-none stroke-blue-500 dark:stroke-blue-400"
          strokeWidth="1.5"
          initial={{ r: 18, opacity: 0 }}
          {...loop(active, { r: [18, OUTER], opacity: [0.45, 0] }, { r: 18, opacity: 0 }, { duration: 3.6, ease: [0.25, 0.6, 0.4, 1], delay: T.loop - 1 + wave * 1.8 })}
        />
      ))}

      {ZONES.map((zone, index) => (
        <Motion.g key={`label-${zone.minutes}`} {...intro(T.labels + index * 0.09, { opacity: 0, y: 6 }, { opacity: 1, y: 0 }, { duration: 0.45, ease: EASE })}>
          <Pill x={zone.label.x} y={zone.label.y} width={zone.minutes < 10 ? 54 : 60}>{zone.minutes} мин</Pill>
        </Motion.g>
      ))}

      {/* Другие клиники рядом. */}
      {CLINICS.map((clinic, index) => (
        <Motion.g key={`${clinic.x}-${clinic.y}`} {...pop(T.clinics + index * 0.06)}>
          <circle cx={clinic.x} cy={clinic.y} r="6.5" className={`${clinic.near ? 'fill-blue-600 dark:fill-blue-400' : 'fill-slate-400 dark:fill-slate-600'} stroke-white dark:stroke-slate-900`} strokeWidth="2.5" />
        </Motion.g>
      ))}

      {/* Маршрут: подложка, линия прорисовывается один раз, по ней ездит точка. */}
      <Motion.path d={ROUTE.d} className="fill-none stroke-white dark:stroke-slate-950" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" {...intro(T.route, { pathLength: 0 }, { pathLength: 1 }, { duration: 1.2, ease: [0.65, 0, 0.35, 1] })} />
      <Motion.path d={ROUTE.d} className="fill-none stroke-blue-700 dark:stroke-blue-400" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" {...intro(T.route, { pathLength: 0 }, { pathLength: 1 }, { duration: 1.2, ease: [0.65, 0, 0.35, 1] })} />
      <Motion.g style={{ opacity: travelerOpacity }}>
        <Motion.circle cx={travelerX} cy={travelerY} r="10" className="fill-blue-500/25 dark:fill-blue-300/25" />
        <Motion.circle cx={travelerX} cy={travelerY} r="5" className="fill-white stroke-blue-700 dark:fill-slate-900 dark:stroke-blue-300" strokeWidth="2.5" />
      </Motion.g>

      <Motion.g {...intro(T.eta, { opacity: 0, y: 6 }, { opacity: 1, y: 0 }, { duration: 0.45, ease: EASE })}>
        <rect x="122" y="391" width="110" height="26" rx="13" className="fill-blue-700 dark:fill-blue-500" />
        <text x="177" y="408.5" textAnchor="middle" className="fill-white" style={{ font: FONT }}>12 мин пешком</text>
      </Motion.g>

      {/* Вы здесь: точка с мягкой пульсацией. */}
      <Motion.g {...pop(T.you)}>
        <Motion.circle
          cx={YOU.x}
          cy={YOU.y}
          className="fill-blue-600/25 dark:fill-blue-400/25"
          initial={{ r: 16, opacity: 0.6 }}
          {...loop(active, { r: [9, 24], opacity: [0.7, 0] }, { r: 16, opacity: 0.6 }, { duration: 2.4, ease: 'easeOut' })}
        />
        <circle cx={YOU.x} cy={YOU.y} r="8" className="fill-blue-700 stroke-white dark:fill-blue-400 dark:stroke-slate-900" strokeWidth="3" />
      </Motion.g>
      <Motion.g {...intro(T.you + 0.15, { opacity: 0, y: -4 }, { opacity: 1, y: 0 }, { duration: 0.4, ease: EASE })}>
        <Pill x={YOU.x} y={YOU.y + 30} width="76">Вы здесь</Pill>
      </Motion.g>

      {/* Ближайшее время приёма и ДМС; на финише поездки время подсвечивается. */}
      <Motion.g filter={`url(#${shadowId})`} {...intro(T.card, { opacity: 0, y: 10 }, { opacity: 1, y: 0 }, { duration: 0.5, ease: EASE })}>
        <rect x="100" y="174" width="164" height="68" rx="12" className="fill-white stroke-slate-200 dark:fill-slate-800 dark:stroke-slate-700" strokeWidth="1" />
        <text x="113" y="194" className="fill-slate-500 dark:fill-slate-400" style={{ font: SMALL_FONT }}>Ближайшее время</text>
        <rect x="216" y="183" width="36" height="16" rx="8" className="fill-emerald-100 dark:fill-emerald-900/60" />
        <text x="234" y="194.5" textAnchor="middle" className="fill-emerald-700 dark:fill-emerald-300" style={{ font: '700 9.5px system-ui, -apple-system, "Segoe UI", sans-serif' }}>ДМС</text>
        <Motion.rect x="110" y="203" width="50" height="30" rx="10" className="fill-none stroke-blue-500 dark:stroke-blue-400" strokeWidth="2" style={{ opacity: slotGlow }} />
        {['18:30', '19:00', '19:30'].map((time, index) => (
          <g key={time}>
            <rect x={113 + index * 50} y="206" width="44" height="24" rx="8" className={index === 0 ? 'fill-blue-600 dark:fill-blue-500' : 'fill-slate-100 dark:fill-slate-700'} />
            <text x={135 + index * 50} y="222" textAnchor="middle" className={index === 0 ? 'fill-white' : 'fill-slate-700 dark:fill-slate-200'} style={{ font: FONT }}>{time}</text>
          </g>
        ))}
      </Motion.g>

      {/* Клиника — фирменная метка МедКарты: падает при сборке, подпрыгивает на финише поездки. */}
      <Motion.circle cx={PIN.x} cy={PIN.y} r={arrivalR} className="fill-none stroke-red-500 dark:stroke-red-400" strokeWidth="2" style={{ opacity: arrivalOpacity }} />
      <Motion.ellipse cx={PIN.x} cy={PIN.y + 3} rx="11" ry="4" className="fill-slate-900/20 dark:fill-black/45" {...intro(T.pin + 0.15, { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1 }, { duration: 0.4, ease: EASE })} />
      <Motion.g {...intro(T.pin, { opacity: 0, y: -36 }, { opacity: 1, y: 0 }, { type: 'spring', stiffness: 380, damping: 17 })}>
        <Motion.g style={{ y: pinLift }}>
          <path d={`M${PIN.x} ${PIN.y}c-4-14-24-26-24-44a24 24 0 0 1 48 0c0 18-20 30-24 44z`} fill="#dc2626" className="stroke-white dark:stroke-slate-900" strokeWidth="2.5" />
          <path d={`M${PIN.x - 3.5} ${PIN.y - 54}h7v8h8v7h-8v8h-7v-8h-8v-7h8z`} fill="#fff" />
        </Motion.g>
      </Motion.g>
    </svg>
  );
}
