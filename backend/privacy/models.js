/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Типы границы доверия.
 *
 * ГЛАВНАЯ ИДЕЯ. Внешний планировщик принимает НЕ строку, а объект
 * SanitizedPlannerRequest, создать который можно единственным способом —
 * через privacy/gateway.js. Конструктор закрыт приватным Symbol: вызов
 * `new SanitizedPlannerRequest(...)` из другого модуля бросает исключение.
 *
 * Это превращает «не забудь санитизировать» из соглашения в свойство кода.
 * Разработчик, который захочет отправить сырой ввод, не сможет собрать
 * аргумент нужного типа — ошибка возникнет на этапе вызова, а не на проде.
 * Дополнительно импорт mintSanitizedPlannerRequest ограничен правилом ESLint
 * (см. eslint.config.js, no-restricted-imports).
 */

const BRAND = Symbol('medkarta.SanitizedPlannerRequest');

const freezeDeep = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      freezeDeep(inner);
    }
  }
  return value;
};

/**
 * Единственный тип, который принимает внешний планировщик.
 *
 * Объект НЕ содержит: исходного текста пользователя, ФИО, телефонов, адресов,
 * координат, идентификаторов БД, идентификатора сессии и сырого описания
 * симптомов. Он содержит только редактированный текст с плейсхолдерами и
 * производные семантические подсказки.
 */
export class SanitizedPlannerRequest {
  constructor(brand, payload) {
    if (brand !== BRAND) {
      throw new TypeError(
        'SanitizedPlannerRequest нельзя создать напрямую: используйте privacy/gateway.js',
      );
    }

    /** @type {string} корреляционный идентификатор, не связанный с пользователем */
    this.requestId = payload.requestId;
    /** @type {string} версия политики приватности, применённой к запросу */
    this.policyVersion = payload.policyVersion;
    /** @type {ReadonlyArray<{role: 'user'|'assistant', text: string}>} */
    this.turns = payload.turns;
    /** @type {ReadonlyArray<{token: string, kind: string}>} токены без значений */
    this.placeholders = payload.placeholders;
    /** @type {object} производные семантические подсказки */
    this.hints = payload.hints;
    /** @type {string} */
    this.locale = payload.locale || 'ru-RU';

    freezeDeep(this);
  }

  /** Набор допустимых токенов — для валидации плана, вернувшегося от модели. */
  get allowedTokens() {
    return new Set(this.placeholders.map((item) => item.token));
  }

  /** Сообщения ровно в том виде, в каком они уйдут в сеть. */
  toWireMessages() {
    return this.turns.map((turn) => ({ role: turn.role, content: turn.text }));
  }

  /**
   * Никакой автоматический сериализатор не должен случайно вытащить больше,
   * чем toWireMessages. Метод фиксирует безопасное представление для логов.
   */
  toJSON() {
    return {
      requestId: this.requestId,
      policyVersion: this.policyVersion,
      turnCount: this.turns.length,
      placeholderKinds: this.placeholders.map((item) => item.kind),
      hints: this.hints,
    };
  }
}

/**
 * ВНИМАНИЕ: разрешено вызывать только из privacy/gateway.js.
 * Правило ESLint no-restricted-imports запрещает импорт этого символа
 * из любого другого файла; тест tests/boundary.test.js проверяет это же.
 */
export const mintSanitizedPlannerRequest = (payload) => new SanitizedPlannerRequest(BRAND, payload);

export const isSanitizedPlannerRequest = (value) => value instanceof SanitizedPlannerRequest;

/** Решение Privacy Gateway о судьбе запроса. */
export const GATEWAY_DECISION = Object.freeze({
  ALLOW_EXTERNAL: 'allow_external',
  LOCAL_ONLY: 'local_only',
  EMERGENCY: 'emergency',
  REJECT: 'reject',
});

/** Причины отказа от внешнего вызова. Попадают в метрики, но не к пользователю. */
export const FAIL_CLOSED_REASON = Object.freeze({
  HARD_IDENTIFIER: 'hard_identifier_present',
  MEDICAL_TEXT: 'medical_text_policy',
  LOW_CLASSIFIER_CONFIDENCE: 'symptom_classifier_uncertain',
  RESIDUAL_RISK: 'residual_unredacted_risk',
  OVER_REDACTED: 'redaction_ratio_too_high',
  TOKEN_BUDGET: 'token_budget_exceeded',
  EMERGENCY: 'emergency_red_flag',
  VAULT_UNAVAILABLE: 'token_vault_unavailable',
  OUTBOUND_ASSERTION: 'outbound_assertion_failed',
  OBFUSCATION: 'obfuscation_unresolved',
  // Режим structured: в запросе нет ничего, из чего модель построила бы план.
  NOTHING_TO_PLAN: 'nothing_to_plan',
  // То же, но пользователь назвал врача, которого нет в справочнике.
  UNKNOWN_DOCTOR: 'doctor_not_in_catalog',
});
