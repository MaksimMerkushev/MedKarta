/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Тексты раздела «Лаборатории»: почему подбор пуст, часы недели словами, ссылка на
 * раздел с условиями от ассистента. Отдельно от компонентов — для быстрого
 * обновления при разработке.
 */
import { formatRub } from '../services/labs';

const WEEKDAY_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Раздел «Лаборатории» с корзиной и условиями из ответа ассистента (точку отправления — не передаём). */
export const labsPageUrl = (request) => `/labs?request=${encodeURIComponent(JSON.stringify({ ...request, origin: undefined }))}`;

export const blockedText = (result) => {
  if (!result) return '';
  switch (result.blockedBy) {
    case 'missing': return 'Ни в одном демо-филиале нет всех этих исследований вместе. Ниже — где можно сдать часть.';
    case 'price': return result.cheapestComplete
      ? `За эту сумму вариантов нет: полная стоимость в демо-филиалах — от ${formatRub(result.cheapestComplete)}.`
      : 'За эту сумму вариантов нет.';
    case 'turnaround': return 'С таким сроком готовности вариантов нет.';
    case 'travel': return 'В пределах этого времени в пути подходящих филиалов нет.';
    case 'slots': return 'На выбранные день и время свободных мест нет. Попробуйте другой день или время.';
    default: return 'Свободного времени в ближайшие 30 дней нет.';
  }
};


/** Часы недели словами: «Пн–Пт 07:00–12:00 · Сб 08:00–12:00 · Вс — нет». */
export const describeWeekly = (weekly) => {
  if (!weekly) return '';
  const days = [1, 2, 3, 4, 5, 6, 7].map((day) => (weekly[day] || weekly[String(day)] || []).map(([from, to]) => `${from}–${to}`).join(', ') || null);
  const groups = [];
  days.forEach((value, index) => {
    const last = groups[groups.length - 1];
    if (last && last.value === value) last.to = index + 1;
    else groups.push({ from: index + 1, to: index + 1, value });
  });
  return groups.map((group) => `${WEEKDAY_SHORT[group.from]}${group.to > group.from ? `–${WEEKDAY_SHORT[group.to]}` : ''} ${group.value || '— нет'}`).join(' · ');
};

