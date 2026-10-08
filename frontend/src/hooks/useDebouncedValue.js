/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Поиск идёт по нескольким сотням записей с конкатенацией строк.
 * Без задержки это выполнялось на каждое нажатие клавиши и подвешивало ввод
 * на слабых телефонах. Поле ввода остаётся отзывчивым, фильтрация догоняет.
 */
import { useEffect, useState } from 'react';

export const useDebouncedValue = (value, delayMs = 200) => {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value === debounced) {
      return undefined;
    }

    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs]);

  return debounced;
};
