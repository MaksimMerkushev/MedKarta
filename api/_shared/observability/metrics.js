/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Privacy-safe метрики.
 *
 * ПРАВИЛО МЕТОК. В labels попадают только значения из перечислений: решение
 * Gateway, код отказа, имя провайдера, действие плана. ФИО, названия клиник,
 * идентификаторы и тем более текст запроса метками быть не могут — метки
 * уходят во внешние системы мониторинга и хранятся долго, а кардинальность
 * по ФИО превратила бы монитор в базу персональных данных.
 */

const ALLOWED_LABEL_VALUES = /^[a-z0-9_.:-]{1,48}$/i;

export const createMetrics = ({ sink = null } = {}) => {
  const counters = new Map();
  const timings = new Map();

  const keyOf = (name, labels) => {
    const parts = Object.entries(labels || {})
      .filter(([, value]) => ALLOWED_LABEL_VALUES.test(String(value)))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, value]) => `${label}=${value}`);
    return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
  };

  return Object.freeze({
    increment(name, labels = {}, value = 1) {
      const key = keyOf(name, labels);
      counters.set(key, (counters.get(key) || 0) + value);
      sink?.({ type: 'counter', key, value });
    },
    observe(name, milliseconds, labels = {}) {
      const key = keyOf(name, labels);
      const bucket = timings.get(key) || [];
      bucket.push(milliseconds);
      timings.set(key, bucket);
      sink?.({ type: 'timing', key, value: milliseconds });
    },
    snapshot() {
      return {
        counters: Object.fromEntries(counters),
        timings: Object.fromEntries(
          [...timings].map(([key, values]) => [
            key,
            {
              count: values.length,
              p50: percentile(values, 0.5),
              p95: percentile(values, 0.95),
            },
          ]),
        ),
      };
    },
  });
};

const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
};

export const metrics = createMetrics();
