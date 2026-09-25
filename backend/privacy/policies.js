/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Пороги и правила принятия решения Privacy Gateway.
 *
 * Все значения собраны в одном месте намеренно: это те числа, которые будет
 * проверять аудитор, и они не должны быть разбросаны по коду. Изменение любого
 * из них меняет объём данных, покидающих доверенный контур, поэтому каждая
 * правка обязана сопровождаться обновлением POLICY_VERSION и документации.
 */

import { FAIL_CLOSED_REASON, GATEWAY_DECISION } from './models.js';
import { HARD_BLOCK_KINDS } from './detectors.js';

/** Версия политики. Пишется в логи и в SanitizedPlannerRequest. */
export const POLICY_VERSION = '2026-09-25.1';

export const POLICY = Object.freeze({
  /**
   * strict — сырое описание симптомов не покидает контур НИКОГДА;
   * наружу уходит только синтезированное «ищет therapist».
   * Других режимов сейчас нет намеренно: переключатель, ослабляющий это
   * правило, — первое, что попросят убрать на аудите.
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
   * Сколько «похожих на имя» слов допускается в тексте ПОСЛЕ редактуры.
   * Ноль: остаточное имя — это потенциально нераспознанные персональные
   * данные, и отправлять такой текст наружу нельзя. Принцип «не нашли PII,
   * значит его нет» здесь не применяется.
   */
  maxResidualNameLike: 0,

  /** TTL соответствий токенов, секунды. */
  tokenTtlSeconds: Number(process.env.PRIVACY_TOKEN_TTL_SECONDS) || 900,
});

/**
 * Принимает решение о судьбе запроса.
 *
 * Порядок проверок — от самых жёстких к мягким. Первое сработавшее правило
 * определяет решение; «накопительной» логики нет намеренно, чтобы поведение
 * было предсказуемым при разборе инцидента.
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
}) => {
  if (classification.emergency) {
    return { decision: GATEWAY_DECISION.EMERGENCY, reason: FAIL_CLOSED_REASON.EMERGENCY };
  }

  if (entities.some((entity) => HARD_BLOCK_KINDS.has(entity.kind))) {
    // СНИЛС, ОМС, паспорт, номер счёта: такой запрос не уходит наружу даже
    // после редактуры — сам факт их появления означает, что пользователь
    // делится документами, и правильная реакция — попросить этого не делать.
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.HARD_IDENTIFIER };
  }

  if (obfuscation.suspicious && !obfuscation.resolved) {
    /*
     * Текст выглядит нарочито разорванным («Г а л я в и ч»), но склейка
     * ничего не нашла в справочнике. Отличить неизвестную фамилию, записанную
     * по буквам, от бессмыслицы мы не можем, поэтому наружу не отправляем.
     * Если бы склейка нашла врача, сущность была бы уже токенизирована и
     * запрос считался бы обычным.
     */
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.OBFUSCATION };
  }

  if (analysisIncomplete) {
    /*
     * Резолвер исчерпал бюджет нечётких сравнений, а кандидаты в фамилии ещё
     * оставались. Двенадцать слов с заглавной перед фамилией с опечаткой
     * раньше выключали проверку для этой фамилии. Непроверенное не уходит.
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
    // Классификатор уверен: наружу уйдёт синтезированное описание поиска,
    // а не слова пользователя. Решение остаётся «можно», но текст подменён.
    return { decision: GATEWAY_DECISION.ALLOW_EXTERNAL, reason: FAIL_CLOSED_REASON.MEDICAL_TEXT };
  }

  if (sanitizedChars < POLICY.minSanitizedChars) {
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.OVER_REDACTED };
  }

  return { decision: GATEWAY_DECISION.ALLOW_EXTERNAL, reason: null };
};
