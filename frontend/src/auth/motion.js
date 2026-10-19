/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общие параметры движения экранов входа: кривая, пружина и смена шагов.
 * Длительности — 180–250 мс: движение подсказывает, что изменилось, и не
 * задерживает. При prefers-reduced-motion смещения нет совсем (direction = 0):
 * шаг сменяется только прозрачностью.
 */

export const EASE = [0.22, 1, 0.36, 1];
export const SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.8 };
export const LAYOUT_SPRING = { type: 'spring', stiffness: 380, damping: 38, mass: 0.9 };

/** Смена шагов: небольшое смещение по горизонтали по направлению движения (1 — вперёд, −1 — назад, 0 — без смещения). */
export const stepVariants = {
  enter: (direction) => ({ opacity: 0, x: Math.sign(direction) * 16 }),
  center: { opacity: 1, x: 0 },
  exit: (direction) => ({ opacity: 0, x: Math.sign(direction) * -16 }),
};
export const stepTransition = { duration: 0.22, ease: EASE };
