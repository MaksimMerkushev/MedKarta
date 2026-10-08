/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Состояние всплывающего уведомления. Отдельным модулем, а не рядом с
 * компонентом Toast: файл компонента должен экспортировать только компоненты,
 * иначе горячая перезагрузка в dev-режиме сбрасывает состояние приложения.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const useToast = () => {
  const [toast, setToast] = useState(null);
  const timerRef = useRef(null);

  const dismiss = useCallback(() => {
    clearTimeout(timerRef.current);
    setToast(null);
  }, []);

  const showToast = useCallback((message, tone = 'info', durationMs = 4000) => {
    clearTimeout(timerRef.current);
    setToast({ message, tone, id: `${tone}-${message}` });
    timerRef.current = setTimeout(() => setToast(null), durationMs);
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { toast, showToast, dismiss };
};
