/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Фильтрация нескольких сотен записей на каждое нажатие подвешивает ввод на
 * слабых телефонах: поле остаётся отзывчивым, фильтрация догоняет с задержкой.
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
