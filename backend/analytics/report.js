/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Отчёт по поискам: сколько искали, сколько дошли до действия и почему нет.
 *
 * «Успешный поиск» — после него в той же сессии и до следующего поиска было
 * целевое действие: звонок, переход на сайт или в Госуслуги, маршрут, открытие
 * Яндекс Карт / 2ГИС или ответ «да, нашёл». Это приближение: действие
 * приписывается последнему поиску перед ним. Для решения «в каких
 * специальностях продукт работает, а в каких нет» этой точности достаточно.
 *
 * Модуль чистый: на входе массив событий, на выходе объект. Чтение файлов —
 * в scripts/search-report.mjs.
 */

const SUCCESS_TYPES = new Set(['contact_click', 'external_map_click']);

const isSuccessAction = (event) =>
  SUCCESS_TYPES.has(event.type)
  || (event.type === 'route_build' && event.outcome === 'ok')
  || (event.type === 'feedback' && event.answer === 'yes');

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

const share = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

const sortedEntries = (map, limit = Infinity) =>
  [...map.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))).slice(0, limit);

/**
 * @param {object[]} events события в порядке записи
 * @returns {object}
 */
export const buildReport = (events) => {
  const byType = new Map();
  const sessions = new Map();

  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.sid !== 'string') continue;
    bump(byType, event.type);
    if (!sessions.has(event.sid)) sessions.set(event.sid, []);
    sessions.get(event.sid).push(event);
  }

  const searches = { total: 0, zeroResults: 0, successful: 0 };
  const bySpecialty = new Map();
  const bySource = new Map();
  const zeroBySpecialty = new Map();
  const zeroByFilter = new Map();
  const funnel = { sessions: sessions.size, searched: 0, opened: 0, acted: 0, satisfied: 0 };

  for (const list of sessions.values()) {
    let searched = false;
    let opened = false;
    let acted = false;
    let satisfied = false;
    let open = null; // текущий поиск, которому приписываются действия

    const close = () => {
      if (!open) return;
      const key = open.event.specialty || 'не выбрана';
      const row = bySpecialty.get(key) || { searches: 0, successful: 0, zeroResults: 0 };
      row.searches += 1;
      if (open.success) row.successful += 1;
      if (open.event.results === 0) row.zeroResults += 1;
      bySpecialty.set(key, row);

      const source = bySource.get(open.event.source) || { searches: 0, successful: 0 };
      source.searches += 1;
      if (open.success) source.successful += 1;
      bySource.set(open.event.source, source);

      if (open.success) searches.successful += 1;
      open = null;
    };

    for (const event of list) {
      if (event.type === 'search') {
        close();
        searched = true;
        searches.total += 1;
        if (event.results === 0) {
          searches.zeroResults += 1;
          bump(zeroBySpecialty, event.specialty || 'не выбрана');
          for (const filter of event.filters || []) bump(zeroByFilter, filter);
        }
        open = { event, success: false };
        continue;
      }
      if (event.type === 'result_open') opened = true;
      if (isSuccessAction(event)) {
        acted = acted || event.type !== 'feedback';
        if (event.type === 'feedback') satisfied = true;
        if (open) open.success = true;
      }
    }
    close();

    if (searched) funnel.searched += 1;
    if (opened) funnel.opened += 1;
    if (acted) funnel.acted += 1;
    if (satisfied) funnel.satisfied += 1;
  }

  const feedback = { yes: 0, no: 0, reasons: new Map(), byContext: new Map() };
  const contacts = new Map();
  const contactPlaces = new Map();
  const externalMaps = new Map();
  const dataReports = new Map();
  const dataReportPlaces = new Map();
  const routes = { ok: 0, failed: 0 };

  for (const event of events) {
    switch (event?.type) {
      case 'feedback':
        feedback[event.answer] += 1;
        bump(feedback.byContext, `${event.context}:${event.answer}`);
        if (event.reason) bump(feedback.reasons, event.reason);
        break;
      case 'contact_click':
        bump(contacts, event.channel);
        if (event.placeId) bump(contactPlaces, event.placeId);
        break;
      case 'external_map_click':
        bump(externalMaps, `${event.provider}:${event.mode}`);
        break;
      case 'data_report':
        bump(dataReports, event.reason);
        bump(dataReportPlaces, event.placeId);
        break;
      case 'route_build':
        routes[event.outcome] += 1;
        break;
      default:
        break;
    }
  }

  return {
    totals: { events: events.length, sessions: sessions.size, byType: Object.fromEntries(sortedEntries(byType)) },
    funnel: {
      ...funnel,
      searchedShare: share(funnel.searched, funnel.sessions),
      actedShareOfSearched: share(funnel.acted, funnel.searched),
    },
    searches: {
      ...searches,
      successRate: share(searches.successful, searches.total),
      zeroResultRate: share(searches.zeroResults, searches.total),
    },
    bySpecialty: sortedEntries(new Map([...bySpecialty].map(([key, row]) => [key, row.searches])))
      .map(([key]) => {
        const row = bySpecialty.get(key);
        return { specialty: key, ...row, successRate: share(row.successful, row.searches) };
      }),
    bySource: [...bySource.entries()].map(([source, row]) => ({ source, ...row, successRate: share(row.successful, row.searches) })),
    zeroResults: {
      bySpecialty: Object.fromEntries(sortedEntries(zeroBySpecialty, 10)),
      byFilter: Object.fromEntries(sortedEntries(zeroByFilter, 10)),
    },
    feedback: {
      yes: feedback.yes,
      no: feedback.no,
      satisfaction: share(feedback.yes, feedback.yes + feedback.no),
      reasons: Object.fromEntries(sortedEntries(feedback.reasons)),
      byContext: Object.fromEntries(sortedEntries(feedback.byContext)),
    },
    contacts: {
      byChannel: Object.fromEntries(sortedEntries(contacts)),
      topPlaces: Object.fromEntries(sortedEntries(contactPlaces, 10)),
    },
    externalMaps: Object.fromEntries(sortedEntries(externalMaps)),
    routes,
    dataReports: {
      byReason: Object.fromEntries(sortedEntries(dataReports)),
      topPlaces: Object.fromEntries(sortedEntries(dataReportPlaces, 10)),
    },
  };
};

const SOURCE_LABELS = { filters: 'фильтры', assistant: 'ассистент', url: 'ссылка' };
const REASON_LABELS = {
  no_doctor: 'нет нужного врача',
  too_far: 'далеко',
  bad_time: 'неудобное время',
  too_expensive: 'дорого',
  not_covered: 'не входит в ОМС/ДМС',
  wrong_data: 'данные неверны',
  other: 'другое',
  closed: 'закрыто',
  wrong_hours: 'неверные часы',
  wrong_phone: 'неверный телефон',
  wrong_address: 'неверный адрес',
  doctor_left: 'врач не работает',
};

const percent = (value) => (value === null ? '—' : `${value}%`);

/** Текстовый отчёт для терминала. */
export const formatReport = (report, { period = '' } = {}) => {
  const lines = [];
  const push = (line = '') => lines.push(line);
  const list = (object, labels = {}) => {
    const entries = Object.entries(object);
    if (entries.length === 0) push('  —');
    for (const [key, value] of entries) push(`  ${labels[key] || key}: ${value}`);
  };

  push(`МедКарта — отчёт по поискам${period ? ` (${period})` : ''}`);
  push('='.repeat(48));
  push(`Сессий: ${report.funnel.sessions}, событий: ${report.totals.events}`);
  push();
  push('Воронка (сессии)');
  push(`  искали:                 ${report.funnel.searched} (${percent(report.funnel.searchedShare)} от всех)`);
  push(`  открыли карточку/метку: ${report.funnel.opened}`);
  push(`  дошли до действия:      ${report.funnel.acted} (${percent(report.funnel.actedShareOfSearched)} от искавших)`);
  push(`  ответили «нашёл»:       ${report.funnel.satisfied}`);
  push();
  push('Поиски');
  push(`  всего: ${report.searches.total}, успешных: ${report.searches.successful} (${percent(report.searches.successRate)})`);
  push(`  с пустой выдачей: ${report.searches.zeroResults} (${percent(report.searches.zeroResultRate)})`);
  for (const row of report.bySource) {
    push(`  через ${SOURCE_LABELS[row.source] || row.source}: ${row.searches}, успешных ${percent(row.successRate)}`);
  }
  push();
  push('По специальностям (поиски / успешных / пустых)');
  if (report.bySpecialty.length === 0) push('  —');
  for (const row of report.bySpecialty) {
    push(`  ${row.specialty}: ${row.searches} / ${percent(row.successRate)} / ${row.zeroResults}`);
  }
  push();
  push('Пустая выдача: какие фильтры были включены');
  list(report.zeroResults.byFilter);
  push();
  push(`Обратная связь: да ${report.feedback.yes}, нет ${report.feedback.no} (${percent(report.feedback.satisfaction)} «да»)`);
  push('  причины «нет»:');
  list(report.feedback.reasons, REASON_LABELS);
  push();
  push('Контакты по каналам');
  list(report.contacts.byChannel);
  push('  топ мест по контактам:');
  list(report.contacts.topPlaces);
  push();
  push('Внешние карты (сервис:режим)');
  list(report.externalMaps);
  push(`Маршруты: построено ${report.routes.ok}, ошибок ${report.routes.failed}`);
  push();
  push('Сообщения о неверных данных');
  list(report.dataReports.byReason, REASON_LABELS);
  push('  проверить в первую очередь:');
  list(report.dataReports.topPlaces);
  return lines.join('\n');
};
