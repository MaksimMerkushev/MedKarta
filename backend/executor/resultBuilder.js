/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Сборка ответа пользователю — детерминированными шаблонами.
 *
 * ПОЧЕМУ БЕЗ ВТОРОГО ВЫЗОВА МОДЕЛИ.
 *   1. Второй вызов — второй канал утечки: чтобы фраза была осмысленной,
 *      модели пришлось бы показать реальные ФИО и адреса найденных врачей.
 *   2. Текст, пришедший от модели, попадает прямо в интерфейс. Инъекция,
 *      прошедшая через поле ввода, смогла бы показать пользователю
 *      произвольное сообщение — например, чужой номер «для записи».
 * Шаблоны обе проблемы снимают. Модель влияет на формулировку только через
 * перечислимый replyHint.
 *
 * Формат возвращаемого объекта совпадает с прежним контрактом api/chat.js,
 * поэтому интерфейс не требует переписывания.
 */

import { SPECIALTY_CANON } from '../privacy/catalog.js';
import { DEFAULT_REPLY, sanitizeAiAction } from '../../shared/contract.js';

const CONSTRAINT_LABELS = Object.freeze({
  available_after: 'приём после указанного времени',
  available_before: 'приём до указанного времени',
  evening: 'вечерний приём',
  weekend: 'приём в выходные',
  wheelchair: 'доступность для коляски',
  online_booking: 'онлайн-запись',
});

const plural = (count, one, few, many) => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

/**
 * Текст на случай признаков неотложного состояния.
 * Без поиска, без фильтров и без диагноза: единственная цель — как можно
 * быстрее направить человека к экстренной помощи.
 */
export const EMERGENCY_REPLY =
  'Описанное похоже на состояние, при котором нужна неотложная помощь. ' +
  'Пожалуйста, немедленно позвоните 103 или 112 — не ждите и не ищите врача через приложение. ' +
  'Я не ставлю диагнозов, но в такой ситуации лучше перестраховаться.';

/**
 * Отдельный текст для мыслей о самоповреждении: здесь человеку нужен не
 * «поиск врача», а контакт с живым человеком прямо сейчас.
 */
export const SELF_HARM_REPLY =
  'Похоже, вам сейчас очень тяжело. Если есть мысли причинить себе вред, пожалуйста, ' +
  'позвоните 112 прямо сейчас — это бесплатно и круглосуточно — или скажите о своём ' +
  'состоянии кому-то рядом. Вы не обязаны справляться с этим в одиночку. ' +
  'Когда будете готовы, я помогу найти психиатра или психотерапевта поблизости.';

const describeStop = (stop) => {
  if (stop.kind === 'location') {
    return stop.token === '@HOME' ? 'дом' : stop.token === '@WORK' ? 'работа' : 'ваше местоположение';
  }
  if (stop.kind === 'clinic') {
    return stop.name;
  }
  return stop.specialty ? `${stop.specialty} — ${stop.name}` : stop.name;
};

/** Собирает человекочитаемый текст строго из фактов исполнения. */
const buildReplyText = (execution, context) => {
  const parts = [];
  const { stops, notes } = execution;
  const found = stops.filter((stop) => stop.kind !== 'location');
  const travelLimit = Number.isInteger(execution.constraints?.max_travel_minutes)
    ? execution.constraints.max_travel_minutes
    : null;

  switch (execution.action) {
    case 'CLEAR_FILTERS':
      parts.push('Сбросил фильтры и маршрут — показываю всё, что есть на карте.');
      break;

    case 'BUILD_ROUTE': {
      if (found.length === 0) {
        parts.push('Не нашёл, из чего построить маршрут.');
        break;
      }
      parts.push(`Построил маршрут: ${stops.map(describeStop).join(' → ')}.`);
      break;
    }

    case 'GET_AVAILABLE_SLOTS':
      parts.push(
        found.length > 0
          ? 'Отсортировал по расписанию. Точное время приёма уточняйте в регистратуре — в справочнике только часы работы учреждения.'
          : 'Не нашёл подходящих вариантов с расписанием.',
      );
      break;

    case 'SEARCH_SERVICE':
      parts.push(
        found.length > 0
          ? `Нашёл ${found.length} ${plural(found.length, 'вариант', 'варианта', 'вариантов')} по услуге.`
          : 'По этой услуге ничего не нашлось.',
      );
      break;

    case 'FIND_CLINIC':
      parts.push(
        found.length > 0
          ? `Показываю: ${found.map(describeStop).join(', ')}.`
          : 'Подходящих учреждений не нашлось.',
      );
      break;

    case 'FIND_DOCTOR':
      if (travelLimit && found.length > 0 && !found.some((stop) => stop.token)) {
        const labels = [...new Set(found.map((stop) => stop.specialty).filter(Boolean))];
        parts.push(
          `Показываю ${labels.length > 0 ? `врачей профиля: ${labels.join(', ')}` : 'подходящих врачей'} — ` +
            `только тех, до кого не дольше ${travelLimit} мин пути от вашей точки на карте (без учёта пробок).`,
        );
        // Список в интерфейсе по часам приёма не сужается: расписание есть не
        // у всех врачей, и молча обещать «после 18:00» нельзя.
        if (execution.constraints?.available_after || execution.constraints?.available_before) {
          parts.push('Часы приёма уточняйте при записи: расписание в справочнике есть не у всех врачей.');
        }
        break;
      }
      parts.push(
        found.length > 0
          ? `Нашёл: ${found.map(describeStop).join(', ')}.`
          : 'Подходящих специалистов не нашлось.',
      );
      break;

    case 'CLARIFY':
    default:
      parts.push(
        context?.clarifyPrompt ||
          'Уточните, пожалуйста, какой специалист или клиника нужны — и я найду и построю маршрут.',
      );
      break;
  }

  if (notes.missingSpecialties.length > 0) {
    const labels = notes.missingSpecialties.map((key) => SPECIALTY_CANON[key] || key);
    parts.push(
      `В справочнике пока нет врачей профиля: ${labels.join(', ')}. ` +
        'Не подставляю вместо них другой профиль, чтобы не отправить вас не к тому специалисту.',
    );
  }

  if (notes.relaxed.length > 0) {
    const labels = notes.relaxed.map((key) => CONSTRAINT_LABELS[key] || key);
    parts.push(
      `Не удалось подтвердить условие: ${labels.join(', ')} — показал варианты без него. Пожалуйста, уточните время работы перед визитом.`,
    );
  }

  if (notes.ambiguous.length > 0) {
    parts.push('По фамилии нашлось несколько врачей — выбрал одного. Уточните имя или клинику, если нужен другой.');
  }

  if (notes.approximate && execution.action === 'BUILD_ROUTE') {
    parts.push('Время в пути оценочное.');
  }

  return parts.join(' ');
};

/** Переносит ограничения плана в поля интерфейса. */
const applyConstraints = (target, constraints = {}) => {
  if (constraints.ownership) target.ownership = constraints.ownership;
  if (constraints.district) target.district = constraints.district;
  if (typeof constraints.min_rating === 'number') target.minRating = constraints.min_rating;
  if (typeof constraints.min_experience_years === 'number') target.minExperience = constraints.min_experience_years;
  if (typeof constraints.max_distance_km === 'number') target.maxDistance = constraints.max_distance_km;
  if (Number.isInteger(constraints.max_travel_minutes)) target.maxTravelMinutes = constraints.max_travel_minutes;
  if (constraints.open_now) target.openOnly = true;
  if (constraints.weekend) target.weekendOnly = true;
  if (constraints.evening) target.eveningOnly = true;
  if (constraints.online_booking) target.onlineOnly = true;
  if (constraints.wheelchair) target.wheelchairOnly = true;
  if (constraints.children) target.isChild = true;
};

/**
 * Итоговый объект для интерфейса.
 *
 * @param {object} execution результат executor.run
 * @param {object} [context] дополнительные сведения (уточняющий вопрос)
 * @returns {object} объект в контракте sanitizeAiAction
 */
export const buildUiAction = (execution, context = {}) => {
  const draft = {
    searchQuery: null,
    specialty: null,
    service: null,
    clinic: null,
    facilityType: null,
    doctorProfile: null,
    district: null,
    services: execution.services || null,
    targetStops: [],
    ownership: null,
    travelMode: execution.travelMode || null,
    cardDisplayMode: null,
    sortMode: execution.sortMode || null,
    isChild: false,
    buildRoute: false,
    clearRoute: false,
    clearFilters: false,
    openOnly: null,
    favoritesOnly: null,
    weekendOnly: null,
    eveningOnly: null,
    onlineOnly: null,
    wheelchairOnly: null,
    darkMode: null,
    minRating: null,
    minExperience: null,
    maxDistance: null,
    maxTravelMinutes: null,
    replyText: DEFAULT_REPLY,
  };

  applyConstraints(draft, execution.constraints);

  const entities = execution.stops.filter((stop) => stop.kind !== 'location');

  if (execution.action === 'CLEAR_FILTERS') {
    draft.clearFilters = true;
    draft.clearRoute = true;
  }

  if (execution.action === 'BUILD_ROUTE' && execution.stops.length > 0) {
    draft.buildRoute = true;
    draft.targetStops = execution.stops
      .filter((stop) => stop.kind !== 'location')
      .map((stop) => ({
        specialty: stop.kind === 'doctor' ? stop.specialty || null : null,
        clinic: stop.kind === 'clinic' ? stop.name : stop.clinic || null,
        doctor: stop.kind === 'doctor' ? stop.name : null,
      }));
  }

  if (execution.action === 'GET_AVAILABLE_SLOTS') {
    draft.sortMode = 'schedule';
    draft.openOnly = true;
  }

  /*
   * С потолком времени в пути сервер не знает, кто ближе: координаты
   * остаются в браузере. Поэтому выдача не сужается до одного врача по
   * фамилии — интерфейс покажет всех врачей профиля и сам отсечёт дальних.
   */
  const travelLimited = Number.isInteger(execution.constraints?.max_travel_minutes);

  if (execution.action === 'FIND_DOCTOR' && entities.length > 0) {
    const first = entities[0];
    draft.specialty = first.specialty || null;
    draft.searchQuery = travelLimited && !first.token ? null : first.name || null;
    draft.cardDisplayMode = 'doctor';
  }

  if (execution.action === 'FIND_CLINIC' && entities.length > 0 && !(travelLimited && !entities[0].token)) {
    draft.clinic = entities[0].name || null;
    draft.searchQuery = entities[0].name || null;
    draft.cardDisplayMode = 'facility';
  }

  if (execution.action === 'SEARCH_SERVICE' && execution.services?.length) {
    draft.services = execution.services;
    draft.searchQuery = execution.services[0];
  }

  /*
   * Предупреждение fail-closed показывается ДАЖЕ когда локальный план
   * отработал успешно. Иначе пользователь, приславший номер СНИЛС, получал бы
   * обычный результат поиска и не узнал бы, что документы присылать не нужно.
   */
  draft.replyText = [context.notice, buildReplyText(execution, context)].filter(Boolean).join(' ');

  /*
   * Финальная нормализация тем же санитайзером, что использует клиент.
   * Избыточно по построению — все значения собраны нами из перечислений —
   * но оставлено осознанно: контракт интерфейса должен соблюдаться вне
   * зависимости от того, кто собрал объект.
   */
  const normalized = sanitizeAiAction(draft);
  normalized.targetStops = draft.targetStops.slice(0, 5);
  return normalized;
};

/** Ответ на случай красного флага: без поиска и без изменения состояния карты. */
export const buildEmergencyAction = (flagId = null) =>
  sanitizeAiAction({ replyText: flagId === 'self_harm' ? SELF_HARM_REPLY : EMERGENCY_REPLY });
