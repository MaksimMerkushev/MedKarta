/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 *   USER → API → PRIVACY GATEWAY → SANITIZED REQUEST → EXTERNAL LLM (planner)
 *        → SCHEMA VALIDATOR → POLICY ENGINE → EXECUTOR → справочник/маршруты
 *        → RESULT BUILDER → USER
 *
 * Деградация: отказ на любом шаге после Gateway ведёт к локальному
 * детерминированному плану, а не к повторному запросу к модели. Модель
 * получает только обезличенный запрос Gateway; пути с исходным текстом нет.
 */

import { GATEWAY_DECISION } from './privacy/models.js';
import { loadCatalog } from './privacy/catalog.js';
import { createEntityResolver } from './privacy/entityResolver.js';
import { createPrivacyGateway } from './privacy/gateway.js';
import { createStoreFromEnv, createTokenVault } from './storage/tokenVault.js';
import { createExternalPlanner, PLANNER_ERROR } from './planner/client.js';
import { createProxyFetch, parseProxyUrl } from './planner/proxyFetch.js';
import { validatePlan } from './planner/validator.js';
import { planLocally } from './planner/localPlanner.js';
import { createCatalogRepository } from './executor/catalogRepository.js';
import { createPolicyEngine } from './executor/policyEngine.js';
import { createExecutor } from './executor/actions.js';
import { createRoutingProviderFromEnv } from './executor/routing.js';
import { buildEmergencyAction, buildUiAction } from './executor/resultBuilder.js';
import { bookingModeFromEnv, bookingReplyText, buildBookingRequest, summarizeBooking } from './demo/chatBridge.js';
import { UNKNOWN_SPECIALTIES } from './privacy/unknownSpecialties.js';

/* Реплика целиком — благодарность или «понятно», без нового запроса. */
const THANKS_ONLY = /^(?:(?:ок|окей|хорошо|понятно|ясно|отлично|супер|класс|ага|угу)[\s,!.)]*)*(?:спасибо|спс|благодарю|thanks|спасибки)(?:\s+(?:большое|огромное|вам|за\s+помощь))*[\s,!.)🙏😊👍]*$|^(?:понятно|ясно|хорошо|ок|окей)[\s,!.]*$/u;
import { SPECIALTY_CANON } from '../shared/specialties.js';
import { getDemoCatalog } from './demo/catalog.js';
import { demoNow } from './demo/time.js';
import { publicClinicsHidden } from './demo/flags.js';
import { logger as defaultLogger } from './observability/safeLogger.js';
import { metrics as defaultMetrics } from './observability/metrics.js';

/* Вопросы о найденном варианте посреди записи. */
const QUESTION_PRICE = /(?<!\p{L})(?:сколько\s+(?:это\s+)?(?:стоит|стоить|будет\s+стоить)|какая\s+цена|почём|почем|стоимость|цена\s+при[её]ма)(?!\p{L})/u;
const QUESTION_WHERE = /(?<!\p{L})(?:где\s+(?:это|находится|она|он|клиника|принимает)|какой\s+адрес|адрес\s+клиники)(?!\p{L})/u;
const QUESTION_HOW = /(?<!\p{L})(?:как\s+(?:мне\s+)?(?:записаться|оформить)|что\s+дальше|а\s+дальше\s+что|что\s+нажать)(?!\p{L})/u;
/* Реплика латиницей без кириллицы: «Need ENT doctor tomorrow». */
const LATIN_ONLY = (text) => (text.match(/[a-z]/giu) || []).length >= 5 && !/\p{Script=Cyrillic}/u.test(text);
const DOCTOR_WORDS = /(?<!\p{L})(?:врач\p{L}*|доктор\p{L}*|специалист\p{L}*|запис\p{L}*|запиш\p{L}*)(?!\p{L})/u;

/**
 * @param {object} deps инъектируются, чтобы тесты подставляли фикстуру
 *   справочника и фальшивый планировщик без сети и реальной базы.
 */
export const createPipeline = ({
  catalog,
  vault,
  planner,
  routing,
  logger = defaultLogger,
  metrics = defaultMetrics,
  outboundMode = undefined,
  /*
   * Демо-запись: ответ на «нужен ЛОР завтра после 18:00» несёт запрос
   * строгого подбора (action.booking), который интерфейс исполняет через
   * /api/demo/search. now — «текущее» время демо (DEMO_NOW в тестах).
   */
  booking = { enabled: false, now: () => Date.now() },
}) => {
  const resolver = createEntityResolver(catalog);
  const allowedServices = new Map(
    [
      ...(catalog.doctors || []).flatMap((doctor) => doctor.services || []),
      ...(catalog.specialties || []),
      ...(catalog.clinics || []).map((clinic) => clinic.facilityType).filter(Boolean),
    ].map((service) => [String(service).toLowerCase(), String(service)]),
  );
  const repository = createCatalogRepository(catalog);
  const gateway = createPrivacyGateway({ resolver, vault, catalog, ...(outboundMode ? { outboundMode } : {}) });
  const policyEngine = createPolicyEngine({ vault, repository });
  const executor = createExecutor({ repository, routing });
  let warnedNotConfigured = false;

  const planExternally = async (request) => {
    const started = Date.now();
    const completion = await planner.generate(request);
    metrics.observe('planner.latency_ms', Date.now() - started, { provider: completion.provider });

    const validated = validatePlan(completion.raw, {
      allowedTokens: request.allowedTokens,
      allowedDistricts: catalog.districts,
      allowedServices,
    });

    if (!validated.ok) {
      metrics.increment('planner.invalid_plan', { code: validated.error.code });
      logger.warn('planner.invalid_plan', {
        request_id: request.requestId,
        code: validated.error.code,
      });
      return null;
    }

    metrics.increment('planner.usage', { provider: completion.provider });
    logger.event('planner.usage', {
      request_id: request.requestId,
      provider: completion.provider,
      // Числа приходят от апстрима: в лог попадает только конечное число.
      prompt_tokens: Number.isFinite(completion.usage?.promptTokens) ? completion.usage.promptTokens : null,
      completion_tokens: Number.isFinite(completion.usage?.completionTokens) ? completion.usage.completionTokens : null,
    });

    return { ...validated.value, source: 'external' };
  };

  return Object.freeze({
    /**
     * @param {object} params
     * @param {Array<{role: string, content: string}>} params.messages
     * @param {string} [params.sessionId]
     * @param {{lat: number, lng: number}|null} [params.origin] огрублённая точка
     * @returns {Promise<{action: object, diagnostics: object}>}
     */
    async handle({
      messages,
      sessionId,
      origin = null,
      takeExternalBudget = () => true,
      runExclusive = (task) => task(),
    }) {
      const started = Date.now();
      /*
       * Оценка процессорного времени: только тяжёлые участки (разбор реплик,
       * исполнение плана), без ожидания модели и очереди. По ней chat.js
       * списывает бюджет адреса.
       */
      let workMs = 0;
      const cpuMs = () => workMs;
      const exclusive = (task) =>
        runExclusive(async () => {
          const taskStarted = Date.now();
          try {
            return await task();
          } finally {
            workMs += Date.now() - taskStarted;
          }
        });
      const gate = await exclusive(() => gateway.process({ messages, sessionId }));

      metrics.increment('gateway.decision', { decision: gate.decision });
      logger.event('gateway.decision', {
        request_id: gate.requestId,
        decision: gate.decision,
        reason: gate.reason,
        policy_version: gateway.policyVersion,
        pii_detected: gate.context.metrics.entitiesDetected > 0,
        redacted_entities: gate.context.metrics.entitiesDetected,
        placeholders: gate.context.metrics.placeholders,
        redaction_ratio: gate.context.metrics.redactionRatio,
        medical_text: gate.context.metrics.medicalText,
      });

      if (gate.decision === GATEWAY_DECISION.EMERGENCY) {
        metrics.increment('gateway.emergency');
        return {
          action: buildEmergencyAction(gate.context?.classification?.emergency?.id),
          diagnostics: { requestId: gate.requestId, decision: gate.decision, planSource: 'none', cpuMs: cpuMs() },
        };
      }

      let plan = null;
      let planSource = 'local';

      /*
       * Исчерпанный общий бюджет обращений к модели — не отказ пользователю,
       * а локальный план: иначе несколько адресов пустыми запросами
       * отключали бы ассистента для всех.
       */
      if (gate.decision === GATEWAY_DECISION.ALLOW_EXTERNAL && gate.request && !takeExternalBudget()) {
        metrics.increment('planner.budget_exhausted');
      } else if (gate.decision === GATEWAY_DECISION.ALLOW_EXTERNAL && gate.request) {
        try {
          plan = await planExternally(gate.request);
          if (plan) planSource = 'external';
        } catch (error) {
          metrics.increment('planner.error', { code: error?.code || 'unknown' });
          if (error?.code === PLANNER_ERROR.NOT_CONFIGURED) {
            // Модель не настроена — режим работы, а не авария: одно
            // предупреждение на процесс.
            if (!warnedNotConfigured) {
              warnedNotConfigured = true;
              logger.warn('planner.not_configured', { request_id: gate.requestId });
            }
          } else {
            logger.error('planner.error', error, { request_id: gate.requestId });
          }
          // Резервного пути «отправить оригинал другому провайдеру» нет:
          // локальный план строится из уже извлечённых структур.
          if (error?.code === PLANNER_ERROR.OUTBOUND_ASSERTION) {
            metrics.increment('gateway.outbound_blocked');
          }
        }
      }

      if (!plan) {
        plan = planLocally(gate.context);
        planSource = 'local';
        metrics.increment('planner.local_fallback', { reason: gate.reason || 'planner_failed' });
      }

      let authorized = await policyEngine.authorize({ plan, sessionId: gate.sessionId, requestId: gate.requestId });

      if (!authorized.ok) {
        metrics.increment('policy.rejected', { code: authorized.error.code });
        logger.warn('policy.rejected', {
          request_id: gate.requestId,
          code: authorized.error.code,
          plan_source: planSource,
        });

        // Отклонённый внешний план заменяется локальным ровно один раз.
        if (planSource === 'external') {
          plan = planLocally(gate.context);
          planSource = 'local_after_rejection';
          authorized = await policyEngine.authorize({ plan, sessionId: gate.sessionId, requestId: gate.requestId });
        }
      }

      if (!authorized.ok) {
        metrics.increment('policy.rejected_final', { code: authorized.error.code });
        return {
          action: buildUiAction(
            {
              action: 'CLARIFY',
              stops: [],
              constraints: {},
              services: null,
              notes: { relaxed: [], missingSpecialties: [], ambiguous: [], approximate: false },
            },
            { clarifyPrompt: clarifyTextFor(gate.reason) },
          ),
          diagnostics: {
            requestId: gate.requestId,
            decision: gate.decision,
            planSource,
            rejected: authorized.error.code,
            cpuMs: cpuMs(),
          },
        };
      }

      const execution = await exclusive(() => executor.run({ plan: authorized.value, origin }));
      const action = buildUiAction(execution, {
        clarifyPrompt: clarifyTextFor(gate.reason),
        notice: noticeFor(gate.reason),
      });

      if (booking.enabled) {
        // Справочник демо — для подписей названных врачей и клиник (кэшируется на процесс).
        const index = await (booking.getIndex || getDemoCatalog)().catch(() => null);
        const built = buildBookingRequest({ booking: gate.context.booking, execution, now: booking.now(), index });
        if (built) {
          action.booking = { request: built.request, summary: summarizeBooking(built) };
          // Карта не должна противоречить подбору: ни лишнего маршрута, ни фильтра по исключённой клинике.
          if (built.dropRoute) {
            action.buildRoute = false;
            action.targetStops = [];
          }
          if (built.dropPlaceFilter) {
            action.searchQuery = null;
            action.clinic = null;
            action.targetStops = [];
          }
          action.replyText = [noticeFor(gate.reason), bookingReplyText({ ...built, booking: gate.context.booking })].filter(Boolean).join(' ');
          metrics.increment('pipeline.booking_request');
        } else if (execution.action === 'CLARIFY' && booking.publicHidden) {
          // Не нашли — возможно, искали государственную клинику, которую демо скрывает.
          action.replyText = `${action.replyText} В демо-режиме показываются только частные клиники (вымышленные и реальные с вымышленными врачами) — государственные временно скрыты.`;
        }
      }

      /*
       * Профиль, которого в справочнике нет («косметолог», «мануальный
       * терапевт»): честное «такого врача нет» вместо общего «уточните» или,
       * хуже, подбора по прежнему профилю. Похожий профиль — только словами.
       */
      const unknownSpecialty = gate.context.booking?.unknownSpecialty;
      if (unknownSpecialty && UNKNOWN_SPECIALTIES[unknownSpecialty]) {
        const { label, related } = UNKNOWN_SPECIALTIES[unknownSpecialty];
        const note = `Врачей профиля «${label}» в справочнике МедКарты нет — показать или записать к такому врачу не могу, а подменять другим профилем без вашего согласия не буду.`;
        const hint = related ? ` Похожий профиль, который есть, — ${SPECIALTY_CANON[related].toLowerCase()}: напишите, если он подойдёт.` : '';
        if (action.booking) {
          // Назван и профиль, который есть («косметолог или дерматолог»): подбор — только по нему.
          action.replyText = `Врачей профиля «${label}» в справочнике МедКарты нет — подбираю только по профилю, который вы назвали вместе с ним. ${action.replyText}`;
        } else if ((gate.context.booking?.specialties || []).length === 0) {
          action.replyText = `${note}${hint}`;
          action.specialty = null;
          action.doctorProfile = null;
          action.searchQuery = null;
          action.buildRoute = false;
          action.targetStops = [];
        }
      }

      /*
       * «Спасибо», «понятно, спасибо» — не новый запрос: подбор остаётся как
       * был, а ответ — вежливое завершение, а не повтор «Ищу свободное время».
       */
      const lastUserText = [...(messages || [])].reverse().find((message) => message?.role === 'user')?.content || '';
      const closing = String(lastUserText).toLowerCase().trim();

      /*
       * Вопрос не по теме посреди записи: честное «это не ко мне», а прежний
       * запрос — как был (его условия gateway собрал без этой реплики).
       */
      if (gate.context.offTopic) {
        // Не по теме с самого начала — и подбора нет: условий не было.
        if (gate.context.offTopicOnly) {
          delete action.booking;
          action.buildRoute = false;
          action.targetStops = [];
        }
        const kept = action.booking?.summary?.length ? ` Прежний запрос помню: ${action.booking.summary.join(', ')} — можно продолжать.` : '';
        action.replyText = `С этим не подскажу: я помогаю найти врача, записаться и построить маршрут по Казани.${kept}`;
      } else if (action.booking) {
        /* Вопросы о найденном: цена, адрес, как записаться — ответ про подбор ниже, а не повтор «ищу». */
        const answers = [
          [QUESTION_PRICE, 'Цена приёма указана в каждом варианте ниже. Ограничить можно словами — например, «до 3000 ₽».'],
          [QUESTION_WHERE, 'Адрес — в карточке варианта: «На карте» покажет клинику, «В маршрут» построит путь.'],
          [QUESTION_HOW, 'Выберите время в варианте ниже и нажмите «Записаться» — запись подтверждаете вы.'],
        ].filter(([pattern]) => pattern.test(closing)).map(([, text]) => text);
        if (answers.length > 0) action.replyText = `${answers.join(' ')} ${action.replyText}`;
      } else if (execution.action === 'CLARIFY' && !action.booking && LATIN_ONLY(closing)) {
        // «Need ENT doctor tomorrow» — запросы понимаются только по-русски; честно и с примером.
        action.replyText = 'Я понимаю запросы на русском языке. Напишите, например: «ЛОР завтра после 18» или «терапевт рядом по ДМС». / I understand requests in Russian only — e.g. «ЛОР завтра после 18».';
      } else if (execution.action === 'CLARIFY' && (!gate.reason || gate.reason === 'nothing_to_plan') && !(gate.context.specialties || []).length && DOCTOR_WORDS.test(closing)) {
        // «Хочу к врачу» без профиля — вопрос, а не общая справка.
        action.replyText = 'К какому врачу записать? Назовите специалиста — например, «к терапевту», — или опишите, что беспокоит: подскажу профиль. Диагнозов не ставлю.';
      }
      // «Ок» в ответ на «искать без этого?» — согласие, а не прощание: ответ — новый подбор.
      if (THANKS_ONLY.test(closing) && !gate.context.booking?.answered) {
        action.replyText = `${/спасиб|спс|благодар|thanks/u.test(closing) ? 'Пожалуйста!' : 'Хорошо.'} Если нужно что-то поменять — день, время, цену или врача, — просто напишите: прежние условия я помню.`;
      }

      metrics.observe('pipeline.latency_ms', Date.now() - started, { plan_source: planSource });
      logger.event('pipeline.done', {
        request_id: gate.requestId,
        action: execution.action,
        plan_source: planSource,
        stops: execution.stops.length,
        relaxed: execution.notes.relaxed,
        missing_specialties: execution.notes.missingSpecialties,
        latency_ms: Date.now() - started,
      });

      return {
        action,
        diagnostics: {
          requestId: gate.requestId,
          decision: gate.decision,
          reason: gate.reason,
          planSource,
          stops: execution.stops.length,
          cpuMs: cpuMs(),
        },
      };
    },
  });
};

/*
 * Тексты под причину fail-closed: техническая причина пользователю не
 * сообщается, формулировка направляет к безопасному переформулированию.
 */
const noticeFor = (reason) =>
  reason === 'hard_identifier_present'
    ? 'Пожалуйста, не присылайте номера документов — СНИЛС, полис ОМС, паспорт: для поиска врача они не нужны.'
    : null;

const clarifyTextFor = (reason) => {
  switch (reason) {
    case 'hard_identifier_present':
      return (
        'Пожалуйста, не присылайте номера документов — СНИЛС, полис ОМС, паспорт: ' +
        'для поиска врача они не нужны. Напишите, какой специалист или клиника вам нужны.'
      );
    case 'symptom_classifier_uncertain':
      return (
        'Чтобы не гадать с профилем врача, уточните, пожалуйста: что беспокоит или ' +
        'к какому специалисту хотите записаться? Диагнозов я не ставлю — только помогаю найти врача.'
      );
    case 'obfuscation_unresolved':
      return (
        'Не разобрал запрос — похоже, слова разделены пробелами или точками. ' +
        'Напишите, пожалуйста, обычным текстом: например, «маршрут к терапевту Петрову».'
      );
    case 'nothing_to_plan':
      return 'Подскажу врача или клинику в Казани и построю маршрут. Напишите, например, «терапевт рядом» или «детский лор в Советском районе».';
    case 'doctor_not_in_catalog':
      return (
        'Врача с такой фамилией в справочнике нет — возможно, она записана иначе или врач принимает в клинике, ' +
        'которой у нас пока нет. Напишите специальность, например «кардиолог рядом», — подберу врачей.'
      );
    case 'residual_unredacted_risk':
    case 'redaction_ratio_too_high':
      return 'Уточните запрос покороче — например, «терапевт рядом» или «стоматология в Вахитовском районе».';
    default:
      return 'Уточните, пожалуйста, какой специалист или клиника нужны — и я найду и построю маршрут.';
  }
};

let cached = null;

/**
 * Кэшируется обещание, а не результат: иначе одновременные первые запросы
 * собирали бы каждый свой конвейер (каталог, индексы, хранилище).
 */
export const getDefaultPipeline = () => {
  if (!cached) {
    cached = buildDefaultPipeline().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
};

/*
 * С AI_PROXY_URL запрос к модели идёт через прокси (OpenRouter не принимает
 * российские адреса). Ошибка в адресе прокси выключает внешнюю модель:
 * в обход прокси напрямую нельзя — ответит локальный планировщик.
 */
export const plannerTransportFromEnv = (env = process.env, logger = defaultLogger) => {
  const apiKey = env.OPENROUTER_API_KEY || env.AI_API_KEY;
  if (!env.AI_PROXY_URL) return { apiKey, fetchImpl: fetch };
  try {
    const proxy = parseProxyUrl(env.AI_PROXY_URL);
    logger.event('planner.proxy', { status: 'enabled', provider: proxy.protocol });
    return { apiKey, fetchImpl: createProxyFetch({ proxy }) };
  } catch {
    logger.warn('planner.proxy_invalid', { status: 'AI_PROXY_URL is invalid, external planner disabled' });
    return { apiKey: undefined, fetchImpl: fetch };
  }
};

const buildDefaultPipeline = async () => {
  const catalog = await loadCatalog();
  const vault = createTokenVault({ store: createStoreFromEnv() });
  if ((process.env.OPENROUTER_API_KEY || process.env.AI_API_KEY) && !process.env.AI_UPSTREAM_URL) {
    // Без AI_UPSTREAM_URL ключ уйдёт на адрес по умолчанию (modelhub.my):
    // ключ одного провайдера не должен незаметно уходить другому.
    defaultLogger.warn('planner.default_upstream', { status: 'AI_UPSTREAM_URL not set' });
  }
  const planner = createExternalPlanner({
    ...plannerTransportFromEnv(),
    url: process.env.AI_UPSTREAM_URL || 'https://modelhub.my/v1/chat/completions',
    model: process.env.AI_MODEL || 'gpt-5.4-mini',
    reasoningEffort: process.env.AI_REASONING_EFFORT || null,
    logger: defaultLogger,
  });

  return createPipeline({
    catalog,
    vault,
    planner,
    routing: await createRoutingProviderFromEnv(),
    booking: { enabled: bookingModeFromEnv(), publicHidden: publicClinicsHidden(), now: () => demoNow() },
  });
};

/** Только для тестов. */
export const __resetPipelineCache = () => {
  cached = null;
};
