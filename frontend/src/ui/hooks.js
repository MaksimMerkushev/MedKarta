/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Хуки интерфейса: уведомления (контекст — ToastProvider в kit.jsx), тема
 * (ключ общий с картой) и загрузка данных страницы.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

/*
 * Подтверждение личности перед важным действием (ReauthProvider в
 * reauth.jsx). withReauth(work): выполнить; если сервер ответил 403
 * reauth_required — спросить пароль (и второй фактор) и повторить один раз.
 * Без провайдера — просто выполнить.
 */
export const ReauthContext = createContext({ confirm: async () => false, withReauth: (work) => work() });
export const useReauth = () => useContext(ReauthContext);

const THEME_KEY = 'med-navigator-dark-mode';

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = useCallback(() => {
    setDark((current) => {
      const next = !current;
      document.documentElement.classList.toggle('dark', next);
      try {
        window.localStorage.setItem(THEME_KEY, JSON.stringify(next));
      } catch {
        // Без хранилища тема продержится до перезагрузки.
      }
      return next;
    });
  }, []);
  return useMemo(() => ({ dark, toggle }), [dark, toggle]);
}

/**
 * Состояние, которое загружается при показе и по запросу (повторить, обновить).
 * resolve — асинхронная функция без побочных эффектов, возвращает новое
 * состояние целиком (и для ошибки тоже); ответ после ухода со страницы
 * отбрасывается. Возвращает [state, setState, reload].
 */
export function useLoaded(resolve, initial) {
  const [state, setState] = useState(initial);
  const resolveRef = useRef(resolve);
  const mounted = useRef(false);
  const reload = useCallback(() => resolveRef.current().then((next) => {
    if (mounted.current) setState(next);
    return next;
  }), []);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);
  return [state, setState, reload];
}
