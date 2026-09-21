/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Исполнение авторизованного плана.
 *
 * Это единственный слой, который работает с реальными записями справочника.
 * Внешняя модель сюда не заглядывает: она не получает ни выборку, ни её
 * размер, ни идентификаторы. Результат исполнения уходит только в
 * resultBuilder и далее пользователю.
 */

import { selectByTravelTime } from './routing.js';
import { SPECIALTY_CANON } from '../privacy/catalog.js';

/** Сортировка при отсутствии точки отправления: по рейтингу, затем по стажу. */
const byQuality = (left, right) =>
  (right.rating ?? 0) - (left.rating ?? 0) || (right.experience ?? 0) - (left.experience ?? 0);

/**
 * Снимает неоднозначность токена врача.
 * Если одной фамилии соответствует несколько врачей, предпочтение отдаётся
 * тому, чей профиль совпал со специальностью из плана. Если и это не помогло —
 * берётся запись с лучшим рейтингом, а факт неоднозначности фиксируется,
 * чтобы ответ честно предложил уточнить.
 */
const disambiguate = (entities, plan) => {
  if (entities.length <= 1) {
    return { chosen: entities[0] || null, ambiguous: false };
  }

  const wanted = plan.steps
    .filter((step) => step.type === 'specialty')
    .map((step) => SPECIALTY_CANON[step.specialty])
    .filter(Boolean);

  if (wanted.length > 0) {
    const matched = entities.filter((entity) =>
      wanted.some((label) => String(entity.specialty || '').toLowerCase().includes(label.toLowerCase())),
    );
    if (matched.length === 1) {
      return { chosen: matched[0], ambiguous: false };
    }
    if (matched.length > 1) {
      return { chosen: [...matched].sort(byQuality)[0], ambiguous: true };
    }
  }

  return { chosen: [...entities].sort(byQuality)[0], ambiguous: true };
};

/**
 * @param {object} deps
 * @param {object} deps.repository
 * @param {object} deps.routing
 */
export const createExecutor = ({ repository, routing }) => ({
  /**
   * @param {object} params
   * @param {object} params.plan авторизованный план (policyEngine)
   * @param {{lat: number, lng: number}|null} [params.origin]
   *        ОГРУБЛЁННАЯ точка отправления, если клиент её прислал.
   *        Точные координаты на сервер не передаются и наружу не уходят.
   * @returns {Promise<object>} результат исполнения
   */
  async run({ plan, origin = null }) {
    const stops = [];
    const notes = { relaxed: new Set(), missingSpecialties: [], ambiguous: [], approximate: false };

    /*
     * Одна и та же запись не может быть двумя остановками маршрута.
     * Дубликат возникает штатно: «к Петрову, потом к стоматологу» — если
     * Петров и есть ближайший стоматолог, шаг по специальности обязан выбрать
     * следующего кандидата, а не повторить уже добавленного.
     */
    const usedIds = new Set();

    for (const step of plan.steps) {
      if (step.type === 'location') {
        stops.push({ kind: 'location', token: step.token, resolvedBy: 'client' });
        continue;
      }

      if (step.type === 'specific_doctor') {
        const { chosen, ambiguous } = disambiguate(step.entities, plan);
        if (!chosen) continue;
        if (ambiguous) {
          notes.ambiguous.push({ token: step.token, count: step.entities.length });
        }
        usedIds.add(chosen.id);
        stops.push({
          kind: 'doctor',
          token: step.token,
          id: chosen.id,
          name: chosen.name,
          specialty: chosen.specialty,
          clinic: chosen.clinic,
          district: chosen.district,
          lat: chosen.lat,
          lng: chosen.lng,
        });
        continue;
      }

      if (step.type === 'specific_clinic') {
        const clinic = step.entities[0];
        usedIds.add(clinic.id);
        stops.push({
          kind: 'clinic',
          token: step.token,
          id: clinic.id,
          name: clinic.name,
          district: clinic.district,
          lat: clinic.lat,
          lng: clinic.lng,
        });
        continue;
      }

      if (step.type === 'specialty') {
        const constraints = { ...plan.constraints, ...step.constraints };
        const found = repository.findBySpecialty({ specialty: step.specialty, constraints });

        found.relaxed.forEach((item) => notes.relaxed.add(item));

        if (found.specialtyMissing) {
          notes.missingSpecialties.push(step.specialty);
          continue;
        }
        if (found.records.length === 0) {
          continue;
        }

        const available = found.records.filter((record) => !usedIds.has(record.id));
        if (available.length === 0) continue;

        let chosen = null;
        if (step.selection === 'nearest' && origin) {
          const selected = await selectByTravelTime({
            origin,
            candidates: available,
            routing,
            mode: plan.travelMode || 'driving',
          });
          chosen = selected.best;
          notes.approximate = notes.approximate || selected.approximate;
        } else {
          chosen = [...available].sort(byQuality)[0];
        }

        if (!chosen) continue;
        usedIds.add(chosen.id);

        stops.push({
          kind: 'doctor',
          id: chosen.id,
          name: chosen.name,
          specialty: chosen.specialty,
          specialtyKey: step.specialty,
          clinic: chosen.clinic,
          district: chosen.district,
          lat: chosen.lat,
          lng: chosen.lng,
          distanceKm: chosen.distanceKm ?? null,
          durationSeconds: chosen.durationSeconds ?? null,
          candidateCount: available.length,
          /*
           * Когда точки отправления нет, «ближайший» на сервере не определён.
           * Клиент, у которого координаты есть, доуточнит выбор сам.
           */
          selection: step.selection || null,
          refineOnClient: step.selection === 'nearest' && !origin,
        });
      }
    }

    return {
      action: plan.action,
      stops,
      constraints: plan.constraints,
      travelMode: plan.travelMode,
      sortMode: plan.sortMode,
      services: plan.services,
      replyHint: plan.replyHint,
      notes: {
        relaxed: [...notes.relaxed],
        missingSpecialties: notes.missingSpecialties,
        ambiguous: notes.ambiguous,
        approximate: notes.approximate,
      },
    };
  },
});
