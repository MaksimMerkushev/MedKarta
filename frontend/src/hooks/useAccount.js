/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Хук не трогает избранное и ДМС приложения: о входе и выходе сообщает через
 * onSignedIn / onSignedOut / onGuest, а App сводит данные браузера с аккаунтом.
 * Причина в onSignedOut: 'logout', 'deleted' или 'expired' (401 на сохранение —
 * сессия истекла, вытеснена новым входом или аккаунт удалён с другого устройства).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  deleteAccount,
  fetchAccount,
  loginAccount,
  logoutAccount,
  updateAccount,
  updateAccountFavorites,
} from '../services/account';

const NO_FEATURES = Object.freeze({ available: false, registration: false });

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
          setState({ status: 'user', user: payload.user, favorites: payload.favorites || [], features, legalPending: payload.legalPending || [] });
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
      legalPending: [],
    }));
    callbacksRef.current.onSignedIn?.(payload, 'login');
    // Обновились ли документы с прошлого входа — отдельным запросом (ответ входа их не содержит).
    fetchAccount()
      .then((fresh) => {
        if (fresh?.user?.id === payload.user?.id) setState((current) => ({ ...current, legalPending: fresh.legalPending || [] }));
      })
      .catch(() => {});
    return payload;
  }, []);

  const signedOut = useCallback((reason) => {
    setState((current) => ({ ...current, status: 'guest', user: null, favorites: [] }));
    callbacksRef.current.onSignedOut?.(reason);
  }, []);

  // 401 на сохранение — сессии больше нет, интерфейс переходит в гостевой режим.
  const guarded = useCallback(async (work) => {
    try {
      return await work();
    } catch (error) {
      if (error?.status === 401) signedOut('expired');
      throw error;
    }
  }, [signedOut]);

  // Сервер не узнал сессию в другом месте (например, ассистент ответил 401) — выходим здесь.
  const expire = useCallback(() => signedOut('expired'), [signedOut]);

  // Пароль верный, но включена двухфакторная защита: сессии ещё нет — форма входа покажет второй шаг.
  const login = useCallback(async (credentials) => {
    const payload = await loginAccount(credentials);
    return payload?.mfaRequired ? payload : signedIn(payload);
  }, [signedIn]);

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

  // Профиль изменили на другой странице (имя, аватар, пароль) — обновить без входа заново.
  const applyUser = useCallback((user) => {
    if (user) setState((current) => (current.status === 'user' ? { ...current, user } : current));
  }, []);

  return { ...state, login, acceptLogin: signedIn, logout, expire, applyUser, removeAccount, setPlan, syncFavorites };
};
