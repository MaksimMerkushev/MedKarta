/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Общее для страниц входа: куда вести после входа и что известно о сервере
 * (вошёл ли уже человек, есть ли отправка писем, контакты поддержки).
 */
import { useEffect, useState } from 'react';

import { fetchAccount, fetchPublicConfig } from '../services/account';

/**
 * Куда вернуть после входа: только путь внутри приложения. «//evil.ru»,
 * «/\evil.ru», полные адреса и /api/… отбрасываются — открытого редиректа нет.
 */
export const safeNext = (value) => {
  if (typeof value !== 'string' || value.length > 512) return null;
  if (!/^\/(?![/\\])/u.test(value) || /[\s\\]/u.test(value)) return null;
  // Страницы входа, регистрации и ссылок из писем — не цель возврата (иначе круг или повторное открытие ссылки).
  if (value.startsWith('/api/') || /^\/(?:login|activate|register|email\/confirm)(?:[/?#]|$)/u.test(value)) return null;
  return value;
};

/** Сотрудник — в админ-панель, остальные — на карту. */
export const homeFor = (user) => (user?.permissions?.includes('admin.access') ? '/admin' : '/');

export const nextFromLocation = (search) => safeNext(new URLSearchParams(search).get('next'));

/**
 * Сессия и публичные настройки. status: loading → ready | error.
 * Ошибка конфигурации не мешает войти: без неё просто нет контактов поддержки.
 */
export function useAuthEnvironment() {
  const [state, setState] = useState({ status: 'loading', user: null, features: {}, support: {}, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchAccount(), fetchPublicConfig().catch(() => null)])
      .then(([account, config]) => {
        if (!alive) return;
        setState({
          status: 'ready',
          user: account?.user || null,
          features: account?.features || {},
          support: { email: config?.settings?.supportEmail || null, phone: config?.settings?.supportPhone || null },
          error: null,
        });
      })
      .catch((error) => {
        if (!alive) return;
        // 503 с features — кабинет выключен на сервере: показываем это, а не «нет связи».
        if (error?.payload?.features) {
          setState({ status: 'ready', user: null, features: error.payload.features, support: {}, error: null });
          return;
        }
        setState((current) => ({ ...current, status: 'error', error }));
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  return { ...state, retry: () => setAttempt((value) => value + 1), setUser: (user) => setState((current) => ({ ...current, user })) };
}
