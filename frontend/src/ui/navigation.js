/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Маршруты /admin/… и /profile без библиотеки: history.pushState и
 * popstate. Сервер на любой неизвестный путь отдаёт index.html.
 */
import { useEffect, useState } from 'react';

const EVENT = 'medkarta:navigate';

export const navigate = (to, { replace = false } = {}) => {
  if (to === `${window.location.pathname}${window.location.search}`) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', to);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo?.(0, 0);
};

export const useLocation = () => {
  const read = () => ({ path: window.location.pathname.replace(/\/+$/, '') || '/', search: window.location.search });
  const [location, setLocation] = useState(read);
  useEffect(() => {
    const update = () => setLocation(read());
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return location;
};
