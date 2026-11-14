/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Демо-лаборатории на карте и в списке: филиалы из /api/labs/labs — карточки вида
 * «Лаборатория» (отдельная вкладка фильтров). Цены, состав анализов и запись —
 * на странице лаборатории (/labs/lab/:id). Филиал стоит на месте пункта сдачи
 * анализов из OSM и заменяет его карточку (osmId).
 */
const LAB_DAYS = [['mon', 1, 'Пн'], ['tue', 2, 'Вт'], ['wed', 3, 'Ср'], ['thu', 4, 'Чт'], ['fri', 5, 'Пт'], ['sat', 6, 'Сб'], ['sun', 7, 'Вс']];
const labRanges = (hours, day) => (Array.isArray(hours?.[day]) ? hours[day] : []).map(([from, to]) => `${from}-${to}`).join(', ');
const labScheduleOf = (hours) => Object.fromEntries(LAB_DAYS.map(([key, day]) => [key, labRanges(hours, day) || 'Выходной']));
/** «Пн–Пт 07:00–19:00; Сб 08:00–15:00; Вс — выходной»: подряд идущие дни с одинаковыми часами — вместе. */
const labHoursText = (hours) => {
  const groups = [];
  for (const [, day, short] of LAB_DAYS) {
    const value = labRanges(hours, day);
    const last = groups.at(-1);
    if (last && last.value === value) last.to = short;
    else groups.push({ from: short, to: short, value });
  }
  return groups.map((group) => `${group.from === group.to ? group.from : `${group.from}–${group.to}`} ${group.value ? group.value.replaceAll('-', '–') : '— выходной'}`).join('; ');
};
/** Ответ /api/labs/labs → карточки филиалов для карты и списка. */
export const labItemsFrom = (payload) => (Array.isArray(payload?.labs) ? payload.labs : []).flatMap((lab) => (Array.isArray(lab.branches) ? lab.branches : [])
  .filter((branch) => Number.isFinite(branch.lat) && Number.isFinite(branch.lng))
  .map((branch) => ({
    id: branch.id,
    name: branch.name,
    clinic: lab.name,
    specialty: 'Лаборатория',
    facilityType: 'Лаборатория',
    address: branch.address,
    district: branch.district || '',
    ownership: 'Частная',
    rating: 0,
    experience: 0,
    schedule: labScheduleOf(branch.hours),
    hours: labHoursText(branch.hours),
    phone: '',
    website: '',
    services: ['Анализы'],
    features: { onlineBooking: true },
    description: lab.description || 'Демо-лаборатория: цены, расписание и запись вымышлены.',
    lat: branch.lat,
    lng: branch.lng,
    source: 'demo',
    demo: true,
    isLab: true,
    labId: lab.id,
    ...(branch.osmId ? { osmId: branch.osmId } : {}),
  })));
