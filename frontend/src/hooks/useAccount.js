/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Состояние личного кабинета в интерфейсе.
 *
 * Хук не трогает избранное и программу ДМС приложения сам: о входе и
 * выходе он сообщает через onSignedIn / onSignedOut / onGuest, а App решает,
 * как свести данные этого браузера с аккаунтом.
 *
 * onSignedOut получает причину: 'logout', 'deleted' или 'expired' — сессия
 * закончилась на сервере (истекла, вытеснена новым входом, аккаунт удалён
 * с другого устройства), и сервер ответил 401 на сохранение.
 * onGuest вызывается, когда при открытии сайта входа нет.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  deleteAccount,
  fetchAccount,
  loginAccount,
  loginDemoAccount,
  logoutAccount,
  registerAccount,
  updateAccount,
  updateAccountFavorites,
} from '../services/account';

const NO_FEATURES = Object.freeze({ available: false, registration: false, demo: false, demoAccounts: [] });

export const useAccount = ({ onSignedIn, onSignedOut, onGuest } = {}) => {
  const [state, setState] = useState({ status: 'loading', user: null, favorites: [], features: NO_FEATURES });
  const callbacksRef = useRef({ onSignedIn, onSignedOut, onGuest });

  useEffect(() => {
    callbacksRef.current = { onSignedIn, onSignedOut, onGuest };
  }, [onSignedIn, onSignedOut, onGuest]);

  useEffect(() => {
    let cancelled = false;
    fetchAccount()
      .then((payload) => {
        if (cancelled) return;
        const features = { ...NO_FEATURES, ...(payload?.features || {}) };
        if (payload?.user) {
          setState({ status: 'user', user: payload.user, favorites: payload.favorites || [], features });
          callbacksRef.current.onSignedIn?.(payload, 'restored');
        } else {
          setState({ status: 'guest', user: null, favorites: [], features });
          callbacksRef.current.onGuest?.();
        }
      })
      .catch(() => {
        // Нет связи или кабинет выключен — сайт работает без него.
        if (!cancelled) setState({ status: 'guest', user: null, favorites: [], features: NO_FEATURES });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signedIn = useCallback((payload) => {
    setState((current) => ({
      status: 'user',
      user: payload.user,
      favorites: payload.favorites || [],
      features: { ...current.features, ...(payload.features || {}) },
    }));
    callbacksRef.current.onSignedIn?.(payload, 'login');
    return payload;
  }, []);

  const signedOut = useCallback((reason) => {
    setState((current) => ({ ...current, status: 'guest', user: null, favorites: [] }));
    callbacksRef.current.onSignedOut?.(reason);
  }, []);

  // 401 на сохранение — сессии больше нет: интерфейс не должен делать вид, что вход есть.
  const guarded = useCallback(async (work) => {
    try {
      return await work();
    } catch (error) {
      if (error?.status === 401) signedOut('expired');
      throw error;
    }
  }, [signedOut]);

  const login = useCallback(async (credentials) => signedIn(await loginAccount(credentials)), [signedIn]);
  const register = useCallback(async (form) => signedIn(await registerAccount(form)), [signedIn]);
  const loginDemo = useCallback(async (key) => signedIn(await loginDemoAccount(key)), [signedIn]);

  const logout = useCallback(async () => {
    try {
      await logoutAccount();
    } catch {
      // Сессия на сервере истечёт сама; на этом устройстве выходим в любом случае.
    }
    signedOut('logout');
  }, [signedOut]);

  const removeAccount = useCallback(async () => {
    await guarded(() => deleteAccount());
    signedOut('deleted');
  }, [guarded, signedOut]);

  const setPlan = useCallback(async (dmsPlanId) => {
    const payload = await guarded(() => updateAccount({ dmsPlanId }));
    setState((current) => ({ ...current, user: payload.user }));
    return payload.user;
  }, [guarded]);

  const syncFavorites = useCallback(async (action, ids) => {
    const payload = await guarded(() => updateAccountFavorites(action, ids));
    setState((current) => ({ ...current, favorites: payload.favorites }));
    return payload.favorites;
  }, [guarded]);

  return { ...state, login, register, loginDemo, logout, removeAccount, setPlan, syncFavorites };
};
