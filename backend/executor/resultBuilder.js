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

  if (execution.action === 'FIND_DOCTOR' && entities.length > 0) {
    const first = entities[0];
    draft.specialty = first.specialty || null;
    draft.searchQuery = first.name || null;
    draft.cardDisplayMode = 'doctor';
  }

  if (execution.action === 'FIND_CLINIC' && entities.length > 0) {
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
export const buildEmergencyAction = () =>
  sanitizeAiAction({ replyText: EMERGENCY_REPLY });
