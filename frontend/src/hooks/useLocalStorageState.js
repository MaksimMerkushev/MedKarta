/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * localStorage — недоверенный источник: содержимое правится из консоли,
 * переживает смену версии приложения и может быть повреждено.
 * Поэтому всё, что оттуда читается, проходит через валидатор,
 * а не сразу попадает в состояние.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

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
  const validateRef = useRef(validate);
  validateRef.current = validate;

  const [value, setValue] = useState(() => readValue(key, validateRef.current, fallback));

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
