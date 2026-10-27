/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ссылки из писем: токен во фрагменте адреса (#token=…) — браузер не
 * отправляет его на сервер ни в строке запроса, ни в Referer. Страница сразу
 * убирает его из адреса и истории (replaceState) и держит только в памяти.
 * Компоненты страниц ссылок — linkParts.jsx.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;

/** Токен из #token=… — только чтение (рендер может выполниться дважды). */
export const readTokenFromUrl = () => {
  const token = new URLSearchParams(window.location.hash.replace(/^#/u, '')).get('token');
  return token && TOKEN.test(token) ? token : null;
};

/** Чистый адрес без токена — и в истории тоже: «Назад» его не вернёт. */
export const cleanUrl = (path) => {
  if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, '', path);
};

export const formatMoscow = (iso, withDate = true) => new Date(iso).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow',
  ...(withDate ? { day: 'numeric', month: 'long' } : {}),
  hour: '2-digit',
  minute: '2-digit',
});
