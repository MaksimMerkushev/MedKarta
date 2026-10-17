/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Тема до первой отрисовки: приложение применяет её только после загрузки
 * бандла, и без этого скрипта страница вспыхивает другой темой.
 * Отдельный файл, а не встроенный скрипт: CSP разрешает только script-src 'self'.
 */
(function () {
  try {
    var saved = window.localStorage.getItem('med-navigator-dark-mode');
    var dark = saved === 'true'
      || (saved === null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (error) {
    // Хранилище недоступно (приватный режим) — остаётся светлая тема.
  }
})();
