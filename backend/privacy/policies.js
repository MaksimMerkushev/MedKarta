/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Пороги и правила решения Privacy Gateway, собранные в одном месте. Любое
 * изменение меняет объём данных, покидающих доверенный контур, и требует
 * обновить POLICY_VERSION и документацию.
 */

import { FAIL_CLOSED_REASON, GATEWAY_DECISION } from './models.js';
import { HARD_BLOCK_KINDS } from './detectors.js';

/** Версия политики. Пишется в логи и в SanitizedPlannerRequest. */
export const POLICY_VERSION = '2026-10-05.1';

export const POLICY = Object.freeze({
  /**
   * strict: сырое описание симптомов не покидает контур, наружу уходит только
   * синтезированное «ищет therapist». Режима, ослабляющего это правило, нет.
   */
  medicalTextMode: 'strict',

  /** Ниже порога классификатор считается неуверенным → fail-closed. */
  symptomConfidenceThreshold: 0.7,

  /** Доля отредактированных символов, выше которой текст не отправляется. */
  maxRedactionRatio: 0.45,

  /** Больше этого числа сущностей в одном запросе — аномалия. */
  maxPlaceholders: 12,

  /** Минимум осмысленного текста после редактуры. */
  minSanitizedChars: 8,

  /**
   * Допустимое число «похожих на имя» слов после редактуры. Ноль: остаточное
   * имя — возможно, нераспознанные персональные данные; «не нашли PII —
   * значит, его нет» здесь не действует.
   */
  maxResidualNameLike: 0,

  /**
   * Не используется: TTL соответствий токенов задаёт storage/tokenVault.js
   * (PRIVACY_TOKEN_TTL_SECONDS, по умолчанию DEFAULT_TTL_SECONDS = 120 с).
   */
  tokenTtlSeconds: Number(process.env.PRIVACY_TOKEN_TTL_SECONDS) || 900,
});

/**
 * Проверки идут от жёстких к мягким, решает первое сработавшее правило: без
 * накопительной логики поведение предсказуемо при разборе инцидента.
 *
 * @param {object} input
 * @param {Array<{kind: string}>} input.entities обнаруженные сущности
 * @param {object} input.classification результат classifySymptoms
 * @param {number} input.redactionRatio доля отредактированных символов
 * @param {number} input.placeholderCount
 * @param {{suspicious: boolean, resolved: boolean}} input.obfuscation признаки
 *        нарочитого разрыва текста и удалось ли что-то по ним связать
 * @param {number} input.residualNameLike сколько «имён» осталось после редактуры
 * @param {number} input.sanitizedChars длина безопасного текста
 * @returns {{decision: string, reason: string|null}}
 */
export const decideGatewayPolicy = ({
  entities = [],
  classification = {},
  redactionRatio = 0,
  placeholderCount = 0,
  residualNameLike = 0,
  sanitizedChars = 0,
  obfuscation = { suspicious: false, resolved: false },
  analysisIncomplete = false,
  structuredOutbound = false,
  plannable = true,
  namedUnknownDoctor = false,
  explicitSpecialty = false,
}) => {
  if (classification.emergency) {
    return { decision: GATEWAY_DECISION.EMERGENCY, reason: FAIL_CLOSED_REASON.EMERGENCY };
  }

  if (entities.some((entity) => HARD_BLOCK_KINDS.has(entity.kind))) {
    // Запрос с СНИЛС, ОМС, паспортом или номером счёта не уходит наружу даже
    // после редактуры: пользователь делится документами, и ответ должен
    // попросить этого не делать.
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.HARD_IDENTIFIER };
  }

  /*
   * Структурный режим: наружу уходит только описание из перечислимых
   * значений, без слов пользователя. Текстовые проверки (недоразобранность,
   * остаточные имена, доля редактуры) здесь ничего не защищают и лишь
   * отключали бы модель для «я Гульнара Хайруллина, Баумана 44, нужен терапевт».
   */
  if (structuredOutbound) {
    /*
     * Разрыв по буквам и здесь ведёт к локальному ответу, но не ради
     * приватности: «маршрут к Н е и з в е с т н о м у» модель получила бы как
     * маршрут без цели, а локальный ответ просит написать фамилию обычным текстом.
     */
    if (obfuscation.suspicious && !obfuscation.resolved) {
      return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.OBFUSCATION };
    }
    if (placeholderCount > POLICY.maxPlaceholders) {
      return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.TOKEN_BUDGET };
    }
    /*
     * Неуверенный классификатор — повод не угадывать профиль, но если
     * специальность названа явно («Марат беспокоит, нужен кардиолог»),
     * угадывать нечего: профиль взят из слов пользователя.
     */
    if (classification.hasMedicalText && classification.confidence < POLICY.symptomConfidenceThreshold && !explicitSpecialty) {
      return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.LOW_CLASSIFIER_CONFIDENCE };
    }
    if (!plannable) {
      // Ни профиля, ни места, ни условия: описание было бы пустым.
      return {
        decision: GATEWAY_DECISION.LOCAL_ONLY,
        reason: namedUnknownDoctor ? FAIL_CLOSED_REASON.UNKNOWN_DOCTOR : FAIL_CLOSED_REASON.NOTHING_TO_PLAN,
      };
    }
    return {
      decision: GATEWAY_DECISION.ALLOW_EXTERNAL,
      reason: classification.hasMedicalText ? FAIL_CLOSED_REASON.MEDICAL_TEXT : null,
    };
  }

  if (obfuscation.suspicious && !obfuscation.resolved) {
    /*
     * Нарочито разорванный текст («Г а л я в и ч»), склейка которого не нашлась
     * в справочнике: неизвестную фамилию по буквам не отличить от бессмыслицы.
     * Найденный склейкой врач был бы уже токенизирован.
     */
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.OBFUSCATION };
  }

  if (analysisIncomplete) {
    /*
     * Резолвер исчерпал бюджет нечётких сравнений, а кандидаты в фамилии
     * остались (дюжина слов с заглавной перед фамилией с опечаткой).
     * Непроверенное не уходит.
     */
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.RESIDUAL_RISK };
  }

  if (placeholderCount > POLICY.maxPlaceholders) {
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.TOKEN_BUDGET };
  }

  if (residualNameLike > POLICY.maxResidualNameLike) {
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.RESIDUAL_RISK };
  }

  if (redactionRatio > POLICY.maxRedactionRatio) {
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.OVER_REDACTED };
  }

  if (classification.hasMedicalText) {
    if (classification.confidence < POLICY.symptomConfidenceThreshold) {
      return {
        decision: GATEWAY_DECISION.LOCAL_ONLY,
        reason: FAIL_CLOSED_REASON.LOW_CLASSIFIER_CONFIDENCE,
      };
    }
    // Наружу уйдёт синтезированное описание поиска, а не слова пользователя.
    return { decision: GATEWAY_DECISION.ALLOW_EXTERNAL, reason: FAIL_CLOSED_REASON.MEDICAL_TEXT };
  }

  if (sanitizedChars < POLICY.minSanitizedChars) {
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.OVER_REDACTED };
  }

  return { decision: GATEWAY_DECISION.ALLOW_EXTERNAL, reason: null };
};
