/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Перехват обмена с моделью на последней точке перед сетью. Только для локальной
 * диагностики (scripts/ai-diagnose.mjs): по умолчанию выключен, а в production его нельзя
 * включить. Ключ и заголовки авторизации сюда не передаются. Файлы трасс лежат в var/,
 * который не попадает в репозиторий.
 */

let sink = null;

export const setAiTraceSink = (next, env = process.env) => {
  if (next && (env.NODE_ENV === 'production' || env.APP_ENV === 'production')) {
    throw new Error('Диагностика обмена с моделью в production запрещена.');
  }
  sink = next;
};

export const aiTraceSink = () => sink;
