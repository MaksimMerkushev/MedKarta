/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Работает ли внешняя модель на деле, а не «настроена ли». Каждый вызов
 * (planner/client.js → requestCompletion) оставляет одну запись: время,
 * успех или код ошибки (http_502, timeout, proxy_timeout…), задержку и
 * токены. Ни текста запроса, ни ответа здесь нет. Хранятся последние 500
 * записей в памяти процесса — для раздела «Система» и проверки готовности.
 */

const MAX_CALLS = 500;
const CODE = /^[a-z0-9_]{2,32}$/i;

export const createAiHealth = ({ now = () => Date.now() } = {}) => {
  const calls = [];

  const record = ({ ok, code = null, ms = null, promptTokens = null, completionTokens = null }) => {
    calls.push({
      at: now(),
      ok: Boolean(ok),
      code: ok ? null : (CODE.test(String(code)) ? String(code) : 'unknown'),
      ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null,
      tokens: (Number(promptTokens) || 0) + (Number(completionTokens) || 0),
    });
    if (calls.length > MAX_CALLS) calls.shift();
  };

  /**
   * Сводка за окно (по умолчанию час). status: idle — вызовов не было;
   * failing — за окно нет ни одного успеха или последние три и больше подряд с ошибкой;
   * ok — иначе.
   */
  const snapshot = ({ windowMs = 3_600_000 } = {}) => {
    const since = now() - windowMs;
    const recent = calls.filter((call) => call.at >= since);
    const succeeded = recent.filter((call) => call.ok);
    const errors = {};
    for (const call of recent) if (!call.ok) errors[call.code] = (errors[call.code] || 0) + 1;
    const latencies = succeeded.map((call) => call.ms).filter(Number.isFinite).sort((a, b) => a - b);
    const lastOk = calls.findLast((call) => call.ok);
    const lastError = calls.findLast((call) => !call.ok);
    let streak = 0;
    for (let index = calls.length - 1; index >= 0 && !calls[index].ok; index -= 1) streak += 1;
    const status = recent.length === 0 ? 'idle' : succeeded.length === 0 || streak >= 3 ? 'failing' : 'ok';
    return {
      status,
      windowMinutes: Math.round(windowMs / 60_000),
      calls: recent.length,
      ok: succeeded.length,
      errors,
      failingStreak: streak,
      p50Ms: latencies.length ? latencies[Math.floor((latencies.length - 1) / 2)] : null,
      p95Ms: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null,
      tokens: recent.reduce((sum, call) => sum + call.tokens, 0),
      lastOkAt: lastOk ? new Date(lastOk.at).toISOString() : null,
      lastErrorAt: lastError ? new Date(lastError.at).toISOString() : null,
      lastErrorCode: lastError?.code ?? null,
    };
  };

  return { record, snapshot, reset: () => { calls.length = 0; } };
};

export const aiHealth = createAiHealth();
