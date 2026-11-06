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
export const POLICY_VERSION = '2026-10-28.1';

/** Режим для жалоб: AI_SYMPTOM_TRIAGE=off возвращает «только локально». */
export const medicalTextModeFromEnv = (env = process.env) =>
  /^(?:off|0|false|no|local)$/iu.test(String(env.AI_SYMPTOM_TRIAGE || '').trim()) ? 'local_only' : 'external_triage';

export const POLICY = Object.freeze({
  /**
   * external_triage (с 2026-10-28.1): жалоба (симптомы, «что беспокоит»)
   * уходит внешней модели, чтобы та подобрала профиль врача и при
   * необходимости задала уточняющий вопрос (planner/triage.js). Уходит
   * только текст реплик пользователя после редактуры: ФИО, телефоны, адреса,
   * e-mail заменены метками; запрос с номером документа (СНИЛС, полис,
   * паспорт), с неразобранным «разрывом» слов или остаточным именем наружу
   * не уходит. Неотложное состояние по-прежнему распознаётся локально и
   * модели не передаётся. Планировщику маршрута и записи (planner/client.js)
   * текст жалобы не передаётся по-прежнему — он получает только профиль.
   *
   * local_only — прежний режим (2026-10-26.1): жалоба только локально.
   * Включается AI_SYMPTOM_TRIAGE=off без изменения кода.
   */
  medicalTextMode: medicalTextModeFromEnv(),

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
 * @returns {{decision: string, reason: string|null, triage?: boolean}} triage —
 *          жалобу можно передать модели для выбора профиля врача
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
   * Жалоба не уходит планировщику (ни текстом, ни описанием): план строит
   * локальный планировщик. Профиль врача по жалобе выбирает отдельный
   * вызов модели — триаж (planner/triage.js), если текст после редактуры
   * безопасен: без «разрыва» слов, остаточных имён, недоразобранных мест и
   * лишних меток. Иначе профиль — из локального классификатора.
   */
  /*
   * Текст, который можно показать модели-триажу: те же проверки, что и для
   * текста в режиме hybrid, — без «разрыва» слов, недоразобранных мест,
   * остаточных имён и пересредактированных реплик.
   */
  const triageable = POLICY.medicalTextMode === 'external_triage'
    && !(obfuscation.suspicious && !obfuscation.resolved)
    && !analysisIncomplete
    && placeholderCount <= POLICY.maxPlaceholders
    && residualNameLike <= POLICY.maxResidualNameLike
    && redactionRatio <= POLICY.maxRedactionRatio;

  if (classification.hasMedicalText) {
    return { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.MEDICAL_TEXT, triage: triageable };
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
      /*
       * Ни профиля, ни места, ни условия: описание было бы пустым. Но
       * «плохо вижу вдаль», «немеют пальцы» — тоже жалобы, которых нет в
       * словаре классификатора: такой текст может разобрать триаж.
       */
      return namedUnknownDoctor
        ? { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.UNKNOWN_DOCTOR }
        : { decision: GATEWAY_DECISION.LOCAL_ONLY, reason: FAIL_CLOSED_REASON.NOTHING_TO_PLAN, triage: triageable };
    }
    /*
     * triage: запрос без профиля («у сына косоглазие» — детский приём есть,
     * врача нет) pipeline может сначала показать модели-триажу.
     */
    return {
      decision: GATEWAY_DECISION.ALLOW_EXTERNAL,
      reason: classification.hasMedicalText ? FAIL_CLOSED_REASON.MEDICAL_TEXT : null,
      triage: triageable,
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
