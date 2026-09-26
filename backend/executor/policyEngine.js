/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Policy Engine — последний барьер перед исполнением.
 *
 * Схемная валидация (planner/validator.js) отвечает на вопрос «это вообще
 * похоже на план?». Здесь отвечают на другой: «этот план разрешено исполнить
 * в этой сессии?». Разделение важно: синтаксически безупречный план может
 * ссылаться на чужие токены, требовать невозможного объёма работы или
 * запрашивать специальность, которой нет в справочнике.
 *
 * Все отказы — жёсткие. План не «чинится» частичным исполнением: непонятно,
 * что именно хотел пользователь, и домысливать в медицинском навигаторе хуже,
 * чем переспросить.
 */

import { ACTIONS, DENIED_ACTIONS, PLAN_LIMITS } from '../planner/schema.js';
import { LOCATION_TOKENS } from '../planner/schema.js';

export const POLICY_ERROR = Object.freeze({
  ACTION_NOT_ALLOWED: 'action_not_allowed',
  ACTION_DENIED: 'action_explicitly_denied',
  TOKEN_UNRESOLVED: 'token_unresolved',
  TOKEN_FOREIGN_SESSION: 'token_foreign_session',
  ENTITY_NOT_FOUND: 'entity_not_found',
  SPECIALTY_NOT_ALLOWED: 'specialty_not_allowed',
  COMPLEXITY: 'complexity_limit_exceeded',
  EMPTY_PLAN: 'plan_has_no_actionable_steps',
});

/** Бюджет сложности одного запроса. */
export const COMPLEXITY_BUDGET = Object.freeze({
  maxSteps: PLAN_LIMITS.MAX_STEPS,
  maxCandidatesTotal: 150,
  maxCandidatesPerStep: PLAN_LIMITS.MAX_CANDIDATES_PER_STEP,
  maxTokenResolutions: 16,
});

const deny = (code, detail) => ({ ok: false, error: { code, detail: detail || null } });

/**
 * @param {object} deps
 * @param {{resolve: Function}} deps.vault
 * @param {object} deps.repository
 */
export const createPolicyEngine = ({ vault, repository }) => ({
  /**
   * Проверяет и разыменовывает план.
   *
   * @param {object} params
   * @param {object} params.plan результат validatePlan или localPlanner
   * @param {string} params.sessionId
   * @returns {Promise<{ok: true, value: object} | {ok: false, error: object}>}
   */
  async authorize({ plan, sessionId, requestId }) {
    if (DENIED_ACTIONS.some((denied) => String(plan.action).toUpperCase().includes(denied))) {
      return deny(POLICY_ERROR.ACTION_DENIED, plan.action);
    }
    if (!ACTIONS.includes(plan.action)) {
      return deny(POLICY_ERROR.ACTION_NOT_ALLOWED, plan.action);
    }
    if (plan.steps.length > COMPLEXITY_BUDGET.maxSteps) {
      return deny(POLICY_ERROR.COMPLEXITY, `steps=${plan.steps.length}`);
    }

    let resolutions = 0;
    const steps = [];

    for (const step of plan.steps) {
      if (step.type === 'location') {
        if (!LOCATION_TOKENS.includes(step.token)) {
          return deny(POLICY_ERROR.TOKEN_UNRESOLVED, 'location');
        }
        /*
         * Семантические места намеренно НЕ разыменовываются на сервере:
         * точные координаты дома и текущего положения остаются в браузере.
         * Клиент подставит их сам при построении маршрута.
         */
        steps.push({ ...step, resolvedBy: 'client' });
        continue;
      }

      if (step.type === 'specialty') {
        if (!repository.hasSpecialty(step.specialty)) {
          return deny(POLICY_ERROR.SPECIALTY_NOT_ALLOWED, step.specialty);
        }
        steps.push({ ...step, resolvedBy: 'server' });
        continue;
      }

      if (step.type === 'specific_doctor' || step.type === 'specific_clinic') {
        resolutions += 1;
        if (resolutions > COMPLEXITY_BUDGET.maxTokenResolutions) {
          return deny(POLICY_ERROR.COMPLEXITY, 'token_resolutions');
        }

        const record = await vault.resolve({ sessionId, requestId, token: step.token });
        if (!record) {
          /*
           * Токен не найден: он выдуман моделью, истёк по TTL или принадлежит
           * другой сессии. Во всех случаях исполнение прекращается — «попробуем
           * угадать, о ком речь» было бы ровно тем поведением, которое
           * инъекция и пытается вызвать.
           */
          return deny(POLICY_ERROR.TOKEN_UNRESOLVED, step.token);
        }

        const ids = Array.isArray(record.value?.ids) ? record.value.ids : record.ids || [];
        const entities = (step.type === 'specific_doctor'
          ? ids.map((id) => repository.getDoctor(id))
          : ids.map((id) => repository.getClinic(id))
        ).filter(Boolean);

        if (entities.length === 0) {
          return deny(POLICY_ERROR.ENTITY_NOT_FOUND, step.type);
        }

        steps.push({ ...step, entities, ambiguous: entities.length > 1, resolvedBy: 'server' });
        continue;
      }

      return deny(POLICY_ERROR.ACTION_NOT_ALLOWED, step.type);
    }

    if (plan.action !== 'CLEAR_FILTERS' && plan.action !== 'CLARIFY' && steps.length === 0) {
      return deny(POLICY_ERROR.EMPTY_PLAN);
    }

    return { ok: true, value: { ...plan, steps } };
  },
});
