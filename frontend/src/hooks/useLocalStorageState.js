/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * localStorage — недоверенный источник: содержимое правится из консоли,
 * переживает смену версии приложения и может быть повреждено.
 * Поэтому всё, что оттуда читается, проходит через валидатор,
 * а не сразу попадает в состояние.
 */
import { useCallback, useEffect, useState } from 'react';

const readValue = (key, validate, fallback) => {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }

    const parsed = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    // Повреждённый JSON, отключённое хранилище или приватный режим.
    return fallback;
  }
};

export const useLocalStorageState = (key, fallback, validate) => {
  // Валидатор нужен только при первом чтении: ref для него не требуется, а
  // запись в ref во время отрисовки нарушала правила React.
  const [value, setValue] = useState(() => readValue(key, validate, fallback));

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Квота исчерпана или запись запрещена — работаем без сохранения.
    }
  }, [key, value]);

  const reset = useCallback(() => setValue(fallback), [fallback]);

  return [value, setValue, reset];
};

export const isStringIdArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number');

export const isBoolean = (value) => typeof value === 'boolean';

/** Идентификатор программы ДМС или null — больше о страховке ничего не храним. */
export const isPlanIdOrNull = (value) => value === null || (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/.test(value));
