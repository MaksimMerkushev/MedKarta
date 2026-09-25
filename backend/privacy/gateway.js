/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * PRIVACY GATEWAY — единственная точка, где пользовательский текст может быть
 * преобразован в объект, пригодный для отправки внешней модели.
 *
 * ИНВАРИАНТ ПРОЕКТА
 * Не существует пути исполнения, в котором сырой ввод попадает во внешний LLM.
 * Технически это обеспечено тем, что planner/client.js принимает только
 * SanitizedPlannerRequest, а создать его умеет исключительно этот файл
 * (privacy/models.js, приватный Symbol + ограничение ESLint).
 *
 * ПОРЯДОК ОБРАБОТКИ
 *   1. детекторы           — регулярные выражения по «скан-виду»;
 *   2. entity linking      — сопоставление с собственным справочником;
 *   3. примирение спанов   — ссылка на справочник сильнее эвристики;
 *   4. классификация жалоб — локально, без сети;
 *   5. выдача токенов      — запись в TokenVault, наружу только @DOCTOR_A;
 *   6. редактура текста    — замена по исходным индексам;
 *   7. политика            — fail-closed решение (policies.js).
 *
 * FAIL-CLOSED
 * Любая ошибка на шагах 1–6 приводит к решению LOCAL_ONLY, а не к отправке
 * исходного текста. Исключения не «проглатываются»: они превращаются в отказ
 * от внешнего вызова и в метрику.
 */

import { randomUUID } from 'node:crypto';

import { findTrigger, ruStem } from './normalize.js';
import { detectEntities, detectObfuscation, ENTITY_KIND } from './detectors.js';
import { classifySymptoms } from './symptoms.js';
import { looksLikeSurname } from './morphology.js';
import {
  countContentChars,
  countResidualNameLike,
  reconcileEntities,
  redactText,
  tokenizeLocations,
} from './redaction.js';
import { decideGatewayPolicy, POLICY, POLICY_VERSION } from './policies.js';
import { FAIL_CLOSED_REASON, GATEWAY_DECISION, mintSanitizedPlannerRequest } from './models.js';
import { SPECIALTY_CANON } from './catalog.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;

/** Приводит идентификатор сессии к безопасному виду или выдаёт новый. */
export const normalizeSessionId = (value) =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : randomUUID();

/**
 * Извлекает структурные ограничения запроса.
 * Работает по исходному тексту, но возвращает ТОЛЬКО перечислимые значения —
 * ни одного фрагмента пользовательских слов наружу не попадает.
 */
export const extractConstraints = (text) => {
  const lower = String(text || '').toLowerCase();
  const constraints = {};

  /*
   * Время. Обе границы обязаны быть «словом целиком» и не частью более
   * длинного числа: без хвостового (?![\d.:-]) строка «СНИЛС 123-456-789 01»
   * давала availableAfter=12:00 — предлог «с» находился в конце слова
   * «снилс», а «12» откусывалось от номера документа.
   */
  const TIME_AFTER = /(?<![\p{L}\p{N}])(?:после|позже|начиная\s+с|с)\s+(\d{1,2})(?::(\d{2}))?(?![\d.:-])/u;
  const TIME_BEFORE = /(?<![\p{L}\p{N}])(?:до|раньше|ранее)\s+(\d{1,2})(?::(\d{2}))?(?![\d.:-])/u;

  const after = lower.match(TIME_AFTER);
  if (after) {
    const hour = Number(after[1]);
    if (hour >= 0 && hour <= 23) {
      constraints.availableAfter = `${String(hour).padStart(2, '0')}:${after[2] || '00'}`;
    }
  }

  const before = lower.match(TIME_BEFORE);
  if (before) {
    const hour = Number(before[1]);
    if (hour >= 0 && hour <= 23) {
      constraints.availableBefore = `${String(hour).padStart(2, '0')}:${before[2] || '00'}`;
    }
  }

  /*
   * Каждое условие проверяется через findTrigger: он отличает «в выходные»
   * от «не в выходные». Для булевых признаков отрицание означает «не ставить»,
   * для формы собственности — выбрать противоположную: она бинарна, и «не
   * государственную» однозначно означает частную.
   */
  if (findTrigger(lower, 'вечер') === 'affirmed') constraints.evening = true;
  if (findTrigger(lower, 'выходн', 'суббот', 'воскресен') === 'affirmed') constraints.weekend = true;
  if (/сейчас\s+открыт|открыт\p{L}*\s+сейчас|работает\s+сейчас/u.test(lower)) constraints.openNow = true;
  if (findTrigger(lower, 'онлайн', 'дистанцион', 'удал[её]нн') === 'affirmed') constraints.onlineBooking = true;
  if (findTrigger(lower, 'коляск', 'инвалид', 'пандус') === 'affirmed') constraints.wheelchair = true;

  const state = findTrigger(lower, 'бесплатн', 'государствен', 'муниципальн');
  const commercial = findTrigger(lower, 'платн', 'частн', 'коммерческ');
  if (state === 'affirmed' || /по\s+омс/u.test(lower) || commercial === 'negated') {
    constraints.ownership = 'Государственная';
  }
  if (commercial === 'affirmed' || state === 'negated') {
    constraints.ownership = 'Частная';
  }

  if (findTrigger(lower, 'ближайш', 'рядом', 'недалеко', 'поблизости') === 'affirmed') {
    constraints.selection = 'nearest';
  }
  if (ruStem('лучш').test(lower) && ruStem('рейтинг', 'врач').test(lower)) {
    constraints.selection = 'best_rated';
  }

  const minRating = lower.match(/рейтинг\p{L}*\s*(?:от|выше|больше)?\s*(\d(?:[.,]\d)?)/u);
  if (minRating) {
    const value = Number(minRating[1].replace(',', '.'));
    if (value >= 0 && value <= 5) constraints.minRating = value;
  }

  const minExperience = lower.match(/стаж\p{L}*\s*(?:от|более|больше)?\s*(\d{1,2})/u);
  if (minExperience) {
    const value = Number(minExperience[1]);
    if (value >= 0 && value <= 60) constraints.minExperience = value;
  }

  return constraints;
};

/** Грубое определение намерения по ключевым словам — для локального планировщика. */
export const extractIntentSignals = (text) => {
  const lower = String(text || '').toLowerCase();
  return {
    route: ruStem('маршрут', 'пострв', 'построй', 'построит', 'доеха', 'добрат', 'проложи', 'отвез').test(lower)
      || /как\s+добраться/u.test(lower),
    slots: ruStem('слот', 'талон', 'расписани').test(lower)
      || /свободн\p{L}*\s+врем|запис\p{L}*\s+на|когда\s+при[её]м/u.test(lower),
    clear: ruStem('сброс', 'сбрось', 'очист', 'отмени').test(lower),
    service: ruStem('услуг', 'анализ', 'узи', 'мрт', 'кт', 'рентген', 'привив').test(lower),
    clinic: ruStem('клиник', 'больниц', 'поликлиник', 'учрежден', 'медцентр').test(lower),
  };
};

/**
 * @param {object} deps
 * @param {{resolve: Function}} deps.resolver entity resolver по справочнику
 * @param {{mint: Function}} deps.vault хранилище токенов
 * @param {Function} [deps.classifier] классификатор жалоб (подменяется в тестах)
 */
export const createPrivacyGateway = ({ resolver, vault, classifier = classifySymptoms }) => {
  /** Переводит координаты ссылки из «скан-вида» в исходные индексы строки. */
  const projectLink = (link, scan) => ({
    ...link,
    start: scan.map[link.start],
    end: scan.map[Math.min(link.end, scan.map.length - 1)],
  });

  const analyzeTurn = (content) => {
    const { scan, spans } = detectEntities(content);
    const resolved = resolver.resolve(scan.text);
    const links = resolved.links.map((link) => projectLink(link, scan));
    return {
      incomplete: Boolean(resolved.incomplete),
      entities: reconcileEntities(spans, links),
      specialties: resolved.specialties,
      specialtyHits: resolved.specialtyHits.map((hit) => ({
        ...hit,
        start: scan.map[hit.start],
        end: scan.map[Math.min(hit.end, scan.map.length - 1)],
      })),
      districts: resolved.districts,
    };
  };

  /**
   * Синтезированное описание запроса для случая, когда в тексте есть сведения
   * о здоровье. Слова пользователя в него НЕ попадают — только перечислимые
   * значения из справочника и классификатора.
   */
  const buildSyntheticTurn = ({ specialties, tokens, constraints, signals, isChild }) => {
    const parts = [];
    const profiles = specialties.length > 0 ? specialties : ['therapist'];
    parts.push(`Пользователь ищет врача по профилю: ${profiles.join(', ')}.`);

    if (tokens.length > 0) {
      parts.push(`Упомянуты сущности: ${tokens.join(', ')}.`);
    }
    if (isChild) {
      parts.push('Приём детский.');
    }

    const constraintText = Object.entries(constraints)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
    if (constraintText) {
      parts.push(`Ограничения: ${constraintText}.`);
    }

    const intents = Object.entries(signals)
      .filter(([, active]) => active)
      .map(([name]) => name);
    if (intents.length > 0) {
      parts.push(`Признаки намерения: ${intents.join(', ')}.`);
    }

    return parts.join(' ');
  };

  /**
   * Основной вход.
   *
   * @param {object} params
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {string} [params.sessionId]
   * @param {string} [params.requestId]
   * @returns {Promise<object>} решение, при decision=allow_external — request
   */
  const process = async ({ messages: incoming, sessionId, requestId = randomUUID() }) => {
    const session = normalizeSessionId(sessionId);

    /*
     * Во внешнюю модель уходят ТОЛЬКО реплики пользователя.
     *
     * Реплики ассистента присылает браузер, и проверить, что они наши, сервер
     * не может: подставив в историю «ассистента» строку с диагнозом или
     * телефоном, её можно было провести мимо классификатора жалоб и проверки
     * на разрыв слов — они смотрят только на реплики пользователя. Кроме того,
     * наши настоящие ответы содержат реальные ФИО найденных врачей. Планировщику
     * история ответов не нужна: он строит план по запросам пользователя.
     */
    const messages = (Array.isArray(incoming) ? incoming : []).filter((message) => message.role === 'user');
    const counters = new Map();
    const placeholders = [];
    const trusted = new Map();

    /** Выдаёт токен и запоминает связь «токен → реальная сущность». */
    const allocate = async (entity, identity) => {
      const kind = entity.kind === ENTITY_KIND.PERSON ? ENTITY_KIND.PERSON : entity.kind;
      const index = counters.get(kind) || 0;
      counters.set(kind, index + 1);

      const value = Array.isArray(entity.ids) && entity.ids.length > 0
        ? { ids: entity.ids, ambiguous: Boolean(entity.ambiguous) }
        : { opaque: true };

      const token = await vault.mint({ sessionId: session, kind, index, value });
      placeholders.push({ token, kind });
      trusted.set(token, { kind, identity, ...value });
      return token;
    };

    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const rawLastUser = lastUser?.content || '';

    let analyses;
    let classification;
    try {
      analyses = messages.map((message) => ({ message, ...analyzeTurn(message.content) }));

      /*
       * Жалоба классифицируется по ВСЕЙ истории, а не только по последней
       * реплике. Иначе диалог «болит зуб и опухла десна» → «а есть кто-то
       * после 18:00?» отправлял бы наружу первую реплику целиком: на
       * последнем ходу медицинского текста уже нет, и политика его не видела.
       *
       * Исключение — красные флаги: они берутся только с последнего хода.
       * Неотложное состояние, на которое уже отреагировали, не должно
       * повторно перехватывать каждый следующий вопрос.
       */
      /*
       * Жалоба ищется в тексте БЕЗ найденных сущностей: фамилия «Раков» или
       * кусок «вичу» от «Галя🙂вичу» не должны читаться как диагноз.
       */
      const masked = (analysis) => {
        let text = analysis.message.content;
        for (const entity of [...analysis.entities].sort((left, right) => right.start - left.start)) {
          text = `${text.slice(0, entity.start)} ${text.slice(entity.end)}`;
        }
        return text;
      };
      const perTurn = analyses.map((analysis) => classifier(masked(analysis)));
      const lastTurn = perTurn[perTurn.length - 1] || classifier('');

      classification = {
        emergency: lastTurn.emergency,
        hasMedicalText: perTurn.some((item) => item.hasMedicalText),
        isChild: perTurn.some((item) => item.isChild),
        confidence: Math.max(...perTurn.map((item) => item.confidence), 0),
        specialties: [...new Set(perTurn.flatMap((item) => item.specialties))],
        matchedRules: [...new Set(perTurn.flatMap((item) => item.matchedRules))],
      };
    } catch {
      // Сбой анализа — это НЕ повод отправить текст как есть.
      return {
        decision: GATEWAY_DECISION.LOCAL_ONLY,
        reason: FAIL_CLOSED_REASON.RESIDUAL_RISK,
        request: null,
        requestId,
        sessionId: session,
        context: emptyContext(session, requestId),
      };
    }

    const constraints = extractConstraints(rawLastUser);
    const signals = extractIntentSignals(rawLastUser);

    const catalogSpecialties = new Set();
    const catalogDistricts = new Set();
    for (const analysis of analyses) {
      analysis.specialties.forEach((item) => catalogSpecialties.add(item));
      analysis.districts.forEach((item) => catalogDistricts.add(item));
    }

    let redactedTurns;
    let totalRedacted = 0;
    let totalChars = 0;
    let locationTokens = [];

    try {
      redactedTurns = [];
      for (const analysis of analyses) {
        const { redacted } = await redactText({
          text: analysis.message.content,
          entities: analysis.entities,
          allocate,
        });
        const withLocations = tokenizeLocations(redacted);
        locationTokens = [...new Set([...locationTokens, ...withLocations.tokens])];
        /*
         * В долю редактуры идут только неизвестные сущности. Ссылка на врача
         * или клинику из справочника — это не «персональные данные вместо
         * текста», а обычный запрос: «маршрут к Галявичу» раньше целиком
         * становился токеном и отбрасывался как «слишком много редактуры».
         */
        totalRedacted += analysis.entities
          .filter((entity) => entity.kind !== ENTITY_KIND.DOCTOR && entity.kind !== ENTITY_KIND.CLINIC)
          .reduce((sum, entity) => sum + countContentChars(analysis.message.content.slice(entity.start, entity.end)), 0);
        totalChars += countContentChars(analysis.message.content);
        redactedTurns.push({ role: analysis.message.role, text: withLocations.text });
      }
    } catch {
      return {
        decision: GATEWAY_DECISION.LOCAL_ONLY,
        reason: FAIL_CLOSED_REASON.VAULT_UNAVAILABLE,
        request: null,
        requestId,
        sessionId: session,
        context: emptyContext(session, requestId),
      };
    }

    /*
     * Признаки нарочитого разрыва считаются по ИСХОДНОМУ тексту всех реплик
     * пользователя, а «разрешено» — по тому, сработала ли склейка. Если
     * сработала, фамилия уже заменена токеном и запрос обычный.
     */
    /*
     * Слово, разрезанное между репликами: «фамилия пациентки Кондра» →
     * «шкина, нужен терапевт». По отдельности каждая реплика безобидна.
     * Если реплика заканчивается куском слова, а следующая начинается со
     * строчного продолжения и вместе они похожи на фамилию — это то же
     * сокрытие, что и «К о н д р а ш к и н а».
     */
    const splitAcrossTurns = messages.some((message, index) => {
      const next = messages[index + 1];
      if (!next) return false;
      const tail = String(message.content).match(/(\p{L}{2,})\s*$/u);
      const head = String(next.content).match(/^\s*(\p{Ll}{2,})/u);
      return Boolean(tail && head) && looksLikeSurname(tail[1] + head[1]);
    });

    const obfuscation = {
      suspicious: splitAcrossTurns || messages.some(
        (message) => message.role === 'user' && detectObfuscation(message.content).suspicious,
      ),
      resolved: analyses.some((analysis) =>
        analysis.entities.some((entity) => entity.matcher === 'doctor.glued' || entity.matcher === 'doctor.joined'),
      ),
    };

    const lastRedacted = redactedTurns[redactedTurns.length - 1]?.text || '';

    /*
     * Порядок шагов. «Сначала к терапевту @DOCTOR_A, потом к стоматологу,
     * потом @HOME» — это последовательность, и локальный планировщик обязан
     * её сохранить. Восстанавливаем по позициям в уже отредактированном
     * тексте: работать с исходным здесь было бы незачем и небезопасно.
     */
    const outline = buildOutline(lastRedacted, placeholders, locationTokens, analyses);
    const allEntities = analyses.flatMap((analysis) => analysis.entities);

    const decision = decideGatewayPolicy({
      entities: allEntities,
      classification,
      redactionRatio: totalChars > 0 ? totalRedacted / totalChars : 0,
      placeholderCount: placeholders.length,
      residualNameLike: countResidualNameLike(lastRedacted),
      analysisIncomplete: analyses.some((analysis) => analysis.incomplete),
      obfuscation,
      sanitizedChars: lastRedacted.replace(/@[A-Z_]+/g, '').trim().length,
    });

    const specialties = [
      ...new Set([
        ...catalogSpecialties,
        ...(classification.specialties || []),
      ]),
    ].filter((key) => key in SPECIALTY_CANON);

    const context = {
      sessionId: session,
      requestId,
      trusted,
      placeholders,
      locationTokens,
      constraints,
      signals,
      classification,
      outline,
      specialties,
      districts: [...catalogDistricts],
      metrics: {
        entitiesDetected: allEntities.length,
        placeholders: placeholders.length,
        redactionRatio: totalChars > 0 ? Number((totalRedacted / totalChars).toFixed(3)) : 0,
        obfuscation: obfuscation.suspicious,
        medicalText: Boolean(classification.hasMedicalText),
        emergency: Boolean(classification.emergency),
      },
    };

    if (decision.decision !== GATEWAY_DECISION.ALLOW_EXTERNAL) {
      return { ...decision, request: null, requestId, sessionId: session, context };
    }

    /*
     * Текст сведений о здоровье наружу не уходит НИКОГДА: он заменяется
     * синтезированным описанием, собранным из перечислимых значений.
     * Это относится ко всем репликам, а не только к последней, — иначе
     * жалоба «утекла» бы через историю диалога.
     */
    const outboundTurns = classification.hasMedicalText
      ? [
          {
            role: 'user',
            text: buildSyntheticTurn({
              specialties,
              tokens: [...placeholders.map((item) => item.token), ...locationTokens],
              constraints,
              signals,
              isChild: classification.isChild,
            }),
          },
        ]
      : redactedTurns;

    const request = mintSanitizedPlannerRequest({
      requestId,
      policyVersion: POLICY_VERSION,
      turns: outboundTurns,
      placeholders: [
        ...placeholders.map((item) => ({ token: item.token, kind: item.kind })),
        ...locationTokens.map((token) => ({ token, kind: 'LOCATION' })),
      ],
      hints: {
        specialties,
        districts: context.districts,
        constraints,
        isChild: Boolean(classification.isChild),
        medicalTextWithheld: Boolean(classification.hasMedicalText),
      },
      locale: 'ru-RU',
    });

    return { ...decision, request, requestId, sessionId: session, context };
  };

  return Object.freeze({ process, policyVersion: POLICY_VERSION, policy: POLICY });
};

/**
 * Восстанавливает последовательность сущностей и специальностей по позициям
 * в отредактированном тексте последней реплики.
 */
export const buildOutline = (redactedText, placeholders, locationTokens, analyses) => {
  const items = [];

  for (const { token, kind } of placeholders) {
    const position = redactedText.indexOf(token);
    if (position >= 0) {
      items.push({ position, kind, token });
    }
  }

  for (const token of locationTokens) {
    const position = redactedText.indexOf(token);
    if (position >= 0) {
      items.push({ position, kind: 'LOCATION', token });
    }
  }

  const lastAnalysis = analyses[analyses.length - 1];
  for (const hit of lastAnalysis?.specialtyHits || []) {
    if (hit.negated) continue;
    items.push({ position: hit.start, kind: 'SPECIALTY', specialty: hit.key });
  }

  return items
    .sort((left, right) => left.position - right.position)
    .map(({ position: _position, ...rest }) => rest);
};

const emptyContext = (sessionId, requestId) => ({
  sessionId,
  requestId,
  trusted: new Map(),
  placeholders: [],
  locationTokens: [],
  constraints: {},
  signals: {},
  classification: { specialties: [], confidence: 0, hasMedicalText: false, emergency: null, isChild: false },
  outline: [],
  specialties: [],
  districts: [],
  metrics: { entitiesDetected: 0, placeholders: 0, redactionRatio: 0, medicalText: false, emergency: false },
});
