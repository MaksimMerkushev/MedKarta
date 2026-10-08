/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Без границы ошибок любое исключение в дереве React отдаёт пользователю
 * пустой белый экран без единой подсказки. Здесь — понятный текст и выход.
 */
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Наружу подробности не показываем — только в консоль разработчика.
    console.error('[MedКарта] Непойманная ошибка интерфейса:', error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    try {
      window.localStorage.removeItem('med-navigator-favorites');
      window.localStorage.removeItem('med-navigator-dark-mode');
    } catch {
      // Приватный режим браузера — просто перезагружаемся.
    }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        role="alert"
        className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-slate-100 px-6 text-center dark:bg-slate-900"
      >
        <h1 className="text-2xl font-black text-slate-800 dark:text-white">Что-то пошло не так</h1>
        <p className="max-w-md text-sm leading-6 text-slate-600 dark:text-slate-400">
          Приложение столкнулось с непредвиденной ошибкой. Обычно помогает перезагрузка страницы.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-blue-700"
          >
            Перезагрузить
          </button>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            Сбросить сохранённые настройки
          </button>
        </div>
      </div>
    );
  }
}
