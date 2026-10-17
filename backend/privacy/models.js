/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Типы границы доверия. Внешний планировщик принимает не строку, а
 * SanitizedPlannerRequest, который создаётся только через privacy/gateway.js:
 * конструктор закрыт приватным Symbol, поэтому сырой ввод нельзя передать
 * планировщику даже по ошибке — санитизация становится свойством кода.
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
 * Не содержит исходного текста пользователя, ФИО, телефонов, адресов,
 * координат, идентификаторов БД и сессии, сырого описания симптомов — только
 * редактированный текст с плейсхолдерами и производные подсказки.
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

  /** Представление для логов: случайная сериализация не вытащит текст реплик. */
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
 * Только для privacy/gateway.js. Импорт из других файлов запрещён правилом
 * ESLint (no-restricted-imports); его дублирует tests/boundary.test.js.
 */
export const mintSanitizedPlannerRequest = (payload) => new SanitizedPlannerRequest(BRAND, payload);

export const isSanitizedPlannerRequest = (value) => value instanceof SanitizedPlannerRequest;

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
