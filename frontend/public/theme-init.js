/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Тема до первой отрисовки. Приложение включает тёмную тему только после
 * загрузки бандла, и до этого страница вспыхивала белым; а при тёмной теме
 * в системе и без сохранённого выбора — наоборот, тёмным, а потом светлым.
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
