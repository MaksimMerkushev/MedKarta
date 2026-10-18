/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ссылка внутри приложения. Сами переходы — navigation.js.
 */
import { navigate } from './navigation';

/** Ссылка внутри приложения: обычный клик — без перезагрузки, Ctrl/⌘-клик — новая вкладка. */
export function Link({ to, children, className = '', onClick, ...rest }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
