/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Маршруты с параметрами (/api/admin/users/:id) без внешних зависимостей.
 * Параметр — только [A-Za-z0-9_-]{1,64}: в обработчик не попадают «..»,
 * слэши и управляющие символы.
 */

const PARAM = '([A-Za-z0-9_-]{1,64})';

/**
 * @param {Array<[string, string, string]>} routes [метод, шаблон пути, имя операции]
 * @returns {(method: string, path: string) => {operation?: string, params?: object, status?: number, allow?: string[]}}
 */
export const createRouter = (routes) => {
  const compiled = routes.map(([method, pattern, operation]) => {
    const names = [];
    const source = pattern.split('/').map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return PARAM;
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    return { method, regex: new RegExp(`^${source}$`), names, operation };
  });

  return (method, path) => {
    const allow = [];
    for (const route of compiled) {
      const match = route.regex.exec(path);
      if (!match) continue;
      if (route.method === method) {
        const params = Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]));
        return { operation: route.operation, params };
      }
      allow.push(route.method);
    }
    return allow.length > 0 ? { status: 405, allow: [...new Set(allow)] } : { status: 404 };
  };
};
