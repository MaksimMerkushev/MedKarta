/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Запросы админ-панели. Сессия — в cookie HttpOnly; изменяющие запросы —
 * всегда JSON (сервер другие не принимает). 401, «смените пароль» и
 * «нужен второй фактор» поднимаются событием — оболочка панели показывает
 * вход, смену пароля или настройку защиты. Критичное действие без свежего
 * подтверждения личности (403 reauth_required): окно подтверждения
 * (setReauthHandler) — и запрос повторяется один раз.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export const AUTH_EVENT = 'medkarta:admin-auth';
const SHELL_CODES = new Set(['password_change_required', 'mfa_setup_required', 'mfa_required']);

let reauthHandler = null;
/** Оболочка панели передаёт сюда confirm() из ReauthProvider. */
export const setReauthHandler = (handler) => {
  reauthHandler = handler;
};

export const queryString = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

const call = async (method, path, { query, body, retried = false } = {}) => {
  let response;
  try {
    response = await fetch(`${path}${queryString(query)}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? { Accept: 'application/json' } : { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет.', { code: 'network' });
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (payload?.code === 'reauth_required' && reauthHandler && !retried) {
      if (await reauthHandler()) return call(method, path, { query, body, retried: true });
      throw new ApiError('Действие отменено: личность не подтверждена.', { status: 403, code: 'reauth_cancelled', payload });
    }
    const error = new ApiError(typeof payload?.error === 'string' ? payload.error : 'Не получилось. Попробуйте ещё раз.', { status: response.status, code: payload?.code || null, payload });
    if (response.status === 401 || SHELL_CODES.has(payload?.code)) {
      window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: { code: payload?.code || 'unauthenticated' } }));
    }
    throw error;
  }
  return payload;
};

export const api = {
  get: (path, query) => call('GET', path, { query }),
  post: (path, body) => call('POST', path, { body }),
  patch: (path, body) => call('PATCH', path, { body }),
  put: (path, body) => call('PUT', path, { body }),
  del: (path, body) => call('DELETE', path, { body }),
};

/**
 * Загрузка данных для страницы: {data, error, loading, reload}. При
 * обновлении прежние данные остаются на экране (без мигания), пока не
 * придут новые; ответ на устаревший запрос отбрасывается.
 */
export const useApi = (loader, deps) => {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const sequence = useRef(0);
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const reload = useCallback(async () => {
    sequence.current += 1;
    const ticket = sequence.current;
    setState((current) => ({ ...current, loading: true }));
    try {
      const data = await loaderRef.current();
      if (ticket === sequence.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (ticket === sequence.current) setState((current) => ({ data: current.data, error, loading: false }));
    }
  }, []);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...state, reload, setData: (data) => setState((current) => ({ ...current, data })) };
};
