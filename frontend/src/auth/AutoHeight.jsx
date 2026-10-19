/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Контейнер, высота которого плавно следует за содержимым: смена шага формы
 * не дёргает страницу. Высота измеряется ResizeObserver и анимируется Motion
 * (без масштабирования — текст не искажается). Поля внутри получают 4 px
 * запаса, чтобы кольцо фокуса не обрезалось.
 */
import { useEffect, useRef, useState } from 'react';
import { motion as Motion, useReducedMotion } from 'motion/react';

import { LAYOUT_SPRING } from './motion';

export default function AutoHeight({ children, className = '' }) {
  const inner = useRef(null);
  const [height, setHeight] = useState('auto');
  // prefers-reduced-motion: высота меняется сразу, без анимации.
  const instant = useReducedMotion();

  useEffect(() => {
    const node = inner.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    // Первый вызов наблюдателя приходит сразу после observe — отдельное измерение не нужно.
    // +8 — запас p-1 сверху и снизу (box-sizing: border-box).
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight + 8));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Motion.div
      initial={false}
      animate={{ height }}
      transition={instant ? { duration: 0 } : LAYOUT_SPRING}
      className={`-m-1 overflow-hidden p-1 ${className}`}
    >
      <div ref={inner} className="relative">{children}</div>
    </Motion.div>
  );
}
