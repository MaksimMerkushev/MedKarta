/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Privacy Gateway — единственное место, где текст пользователя превращается в
 * запрос для внешней модели. Сырой ввод во внешнюю LLM не попадает: planner/client.js
 * принимает только SanitizedPlannerRequest, а создаёт его только этот файл
 * (privacy/models.js: приватный Symbol + ограничение ESLint).
 *
 * Порядок обработки:
 *   1. детекторы           — регулярные выражения по «скан-виду»;
 *   2. entity linking      — сопоставление с собственным справочником;
 *   3. примирение спанов   — ссылка на справочник сильнее эвристики;
 *   4. классификация жалоб — локально, без сети;
 *   5. выдача токенов      — запись в TokenVault, наружу только @DOCTOR_A;
 *   6. редактура текста    — замена по исходным индексам;
 *   7. политика            — fail-closed решение (policies.js).
 *
 * Fail-closed: ошибка на шагах 1–6 даёт решение LOCAL_ONLY (оно учитывается в
 * метриках), а не отправку исходного текста.
 */

import { randomUUID } from 'node:crypto';

import { findTrigger, fixCommonTypos, isNegatedBefore, rewriteNegatedTimeBounds, ruStem } from './normalize.js';
import { detectEntities, detectObfuscation, ENTITY_KIND, isKinshipWord } from './detectors.js';
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
import { combineTimeReadings, extractBookingConstraints, extractReplySignals, mergeBookingTurns } from './bookingConstraints.js';
import { branchesOnStreet, demoRefsOf, doctorsByFirstName } from './demoRefs.js';
import { findUnknownSpecialties } from './unknownSpecialties.js';
import {
  checkClosedVocabulary,
  findKnownPlaces,
  findStreetMentions,
  isStreetMention,
  registerCatalogVocabulary,
} from './vocabulary.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;

/* Приём для взрослого, сказанный словами: «для меня», «а теперь маме», «мне самому». */
const ADULT_PATIENT = /(?<!\p{L})(?:для\s+(?:меня|себя|мужа|жены|мамы|папы|бабушки|дедушки|супруг\p{L}*|взросл\p{L}*)|мне\s+сам(?:ому|ой)|а\s+(?:теперь\s+)?(?:мне|маме|папе|мужу|жене|бабушке|дедушке)|взросл\p{L}*\s+(?:при[её]м|врач\p{L}*|пациент\p{L}*))(?!\p{L})/u;

/* Темы, с которыми навигатор не помогает: погода, курсы валют, анекдоты, «как дела». */
const OFF_TOPIC = /(?<!\p{L})(?:погод\p{L}*|анекдот\p{L}*|пошути\p{L}*|шутк\p{L}*|курс\p{L}*\s+(?:доллар|евро|валют|рубл)\p{L}*|новост(?:и|ей|ям|ях)|гороскоп\p{L}*|футбол\p{L}*|хоккей\p{L}*|фильм\p{L}*|сериал\p{L}*|рецепт\p{L}*\s+(?:блюд|пирог|торт|салат|супа|борщ)\p{L}*|как\s+(?:у\s+тебя\s+)?дела|кто\s+ты|ты\s+кто|сколько\s+тебе\s+лет|расскажи\s+(?:сказку|стих)\p{L}*|напиши\s+(?:стих|песн|сочинени|код)\p{L}*)(?!\p{L})/u;

/* «Сначала к терапевту, потом к стоматологу» — порядок визитов, то есть маршрут. */
const SEQUENCE_WORDS = /(?<!\p{L})(?:сначала|потом|затем|после\s+(?:этого|него|неё|нее)|а\s+после)(?!\p{L})/u;
/* «И ещё к стоматологу», «а потом к лору» — ещё один врач; «а лучше к дерматологу» — замена. */
const ADDITIVE_WORDS = /(?<!\p{L})(?:ещ[её]|также|потом|затем|плюс|заодно|кроме\s+того|а\s+после)(?!\p{L})/u;
const REPLACE_WORDS = /(?<!\p{L})(?:лучше|вместо|теперь|передумал\p{L}*|хотя\s+нет|точнее|вернее|не\s+(?:к|нужен|нужна|надо))(?!\p{L})/u;

/* Сколько последних реплик пользователя держит контекст диалога. */
const MAX_CONTEXT_TURNS = 20;

/* «Давай заново», «новый запрос», «забудь всё, что я писал» — начало нового запроса. */
const CONTEXT_RESET = /^[\s,.!]*(?:забудь(?:те)?|заново|сначала|с\s+начала|по\s+новой|начн[её]м\s+сначала|сброс|сбрось(?:те)?|отбой)[\s,.!]*$|(?<!\p{L})(?:начн[её]м\s+(?:с\s+)?(?:начала|заново|сначала)|(?:давай(?:те)?|можно)\s+(?:с\s+начала|сначала|заново|по-новому)|новый\s+(?:запрос|поиск|вопрос)|забудь(?:те)?\s+(?:вс[её]|предыдущ\p{L}*|прошл\p{L}*|что\s+я\s+(?:писал|говорил|просил)\p{L}*)|сброс(?:ь|ьте|ить)?\s+(?:вс[её]|услови\p{L}*|фильтр\p{L}*|контекст)|другой\s+(?:вопрос|запрос)|с\s+чистого\s+листа)(?!\p{L})/u;

/*
 * Самоисправление в одной реплике: «ЛОР, хотя нет, давайте терапевта» — первый
 * профиль снят, а не второй врач в маршруте.
 */
const CORRECTION_GAP = /^[\s.,!;:…—–-]*(?:(?:ой|ну|а|хотя|или|точнее|вернее)[\s,]*)?(?:не|нет|неа|точнее|вернее|то\s+есть|лучше|передумал\p{L}*)(?:[\s,.!—–-]*(?:нет|лучше|давай(?:те)?|вс[её][-\s]?таки|наверное|пожалуй|скорее))*[\s,.!—–-]*(?:(?:к|ко|на\s+при[её]м\s+к|записаться\s+к|запишите\s+к|нужен|нужна|надо|нужно)\s+)?$/iu;

/**
 * Профили реплики с учётом самоисправлений и профилей, которых нет в
 * справочнике («мануальный терапевт» — не «терапевт»). Снятые совпадения
 * помечаются negated: их не видят ни запись, ни планировщик.
 */
const correctSpecialtyMentions = (content, specialtyHits) => {
  const lower = content.toLowerCase();
  const unknown = findUnknownSpecialties(content).filter((item) => !isNegatedBefore(lower, item.start));
  const hits = specialtyHits.map((hit) => (
    !hit.negated && unknown.some((item) => item.start < hit.end && hit.start < item.end) ? { ...hit, negated: true, unknownOverlap: true } : hit
  ));
  const mentions = [
    ...hits.map((hit, position) => ({ kind: 'known', position, start: hit.start, end: hit.end })).filter((item) => !hits[item.position].negated),
    ...unknown.map((item) => ({ kind: 'unknown', key: item.key, start: item.start, end: item.end })),
  ].sort((left, right) => left.start - right.start);
  const dropped = new Set();
  for (let position = 1; position < mentions.length; position += 1) {
    if (CORRECTION_GAP.test(lower.slice(mentions[position - 1].end, mentions[position].start))) dropped.add(mentions[position - 1]);
  }
  const corrected = hits.map((hit, position) => (
    mentions.some((item) => item.kind === 'known' && item.position === position && dropped.has(item)) ? { ...hit, negated: true, corrected: true } : hit
  ));
  return {
    specialtyHits: corrected,
    specialties: [...new Set(corrected.filter((hit) => !hit.negated).sort((left, right) => left.start - right.start).map((hit) => hit.key))],
    unknownSpecialties: [...new Set(mentions.filter((item) => item.kind === 'unknown' && !dropped.has(item)).map((item) => item.key))],
  };
};

const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

export const normalizeSessionId = (value) =>
  typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : randomUUID();

/**
 * Структурные ограничения запроса. Работает по исходному тексту, но возвращает
 * только перечислимые значения: слова пользователя в результат не попадают.
 */
export const extractConstraints = (text) => {
  // «Добрый вечер» — приветствие, а не «принимает вечером».
  // «Нет, не после 18, а до 12» — отрицаемая граница снимается (normalize.js).
  const lower = rewriteNegatedTimeBounds(fixCommonTypos(String(text || '').toLowerCase().replace(/(?<!\p{L})добр\p{L}*\s+(?:вечер|утр|ден|дн|ноч)\p{L}*/gu, ' ')));
  const constraints = {};

  /*
   * Время. Граница — слово целиком и не часть длинного числа: иначе в «СНИЛС
   * 123-456-789 01» нашлось бы «с 12» (availableAfter=12:00). Точка после числа —
   * конец предложения («после 16. Ясень»), если за ней не цифра («после 16.10»).
   * Не время: «до 20 минут от дома» (путь), «до 3 000 ₽», «до 2к» (цена),
   * «до 20 октября», «после 15-го» (даты). «Не раньше 17:00» — это «после».
   */
  const NOT_A_DATE = '(?!\\s*(?:-?го(?!\\p{L})|-?е(?!\\p{L})|числа|январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр))(?!\\s*(?:по|до|[-–—])\\s*\\d{1,2}\\s*(?:-?го\\s+)?(?:январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр))';
  const TIME_AFTER = new RegExp(`(?<![\\p{L}\\p{N}])(?:после|(?<!не\\s)позже|начиная\\s+с|с|не\\s+раньше|не\\s+ранее)\\s+(\\d{1,2})(?::(\\d{2}))?(?![\\d:-])(?!\\.\\d)(?!\\s*(?:мин|час|тыс|руб|₽|р\\.|т\\.?\\s?р|к(?!\\p{L})|\\d{3}(?!\\d)|дн[еяй]|сут|недел|лет|год|раз))${NOT_A_DATE}`, 'u');
  const TIME_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}])(?:до|(?<!не\\s)раньше|(?<!не\\s)ранее|не\\s+позже|не\\s+позднее)\\s+(\\d{1,2})(?::(\\d{2}))?(?![\\d:-])(?!\\.\\d)(?!\\s*(?:мин|час|тыс|руб|₽|р\\.|т\\.?\\s?р|к(?!\\p{L})|\\d{3}(?!\\d)|дней|сут|недел|лет|год|раз))${NOT_A_DATE}`, 'u');

  /*
   * Час без минут и части суток: «после 5» — 17:00 (в 5 утра клиники закрыты),
   * а «после 7» — и утро, и вечер. Двусмысленное (после 7–8, до 8–9) не
   * выбирается за пользователя: в timeAmbiguity оба прочтения, и ассистент
   * спрашивает «утра или вечера?».
   */
  const morningWords = /(?<!\p{L})(?:утр\p{L}*|с\s+утра)(?!\p{L})/u.test(lower);
  const eveningWords = /(?<!\p{L})(?:вечер\p{L}*|после\s+работы|после\s+обеда|дн[её]м)(?!\p{L})/u.test(lower);
  const clockOf = (hour, minutes) => `${String(hour).padStart(2, '0')}:${minutes || '00'}`;
  const readings = (match, bound) => {
    if (!match) return [null];
    const hour = Number(match[1]);
    if (hour > 23) return [];
    if (match[2] || hour === 0 || hour >= 12) return [clockOf(hour, match[2])];
    if (eveningWords) return [clockOf(hour + 12)];
    if (morningWords) return [clockOf(hour)];
    if (bound === 'after') return hour <= 6 ? [clockOf(hour + 12)] : hour <= 8 ? [clockOf(hour), clockOf(hour + 12)] : [clockOf(hour)];
    return hour <= 7 ? [clockOf(hour + 12)] : hour <= 9 ? [clockOf(hour), clockOf(hour + 12)] : [clockOf(hour)];
  };
  const afterReadings = readings(lower.match(TIME_AFTER), 'after');
  const beforeReadings = readings(lower.match(TIME_BEFORE), 'before');
  // Оба двусмысленны — прочтения согласованы: утро с утром, вечер с вечером.
  const combined = combineTimeReadings(afterReadings, beforeReadings);
  if (combined.ambiguity) {
    constraints.timeAmbiguity = combined.ambiguity;
  } else {
    if (combined.from) constraints.availableAfter = combined.from;
    if (combined.to) constraints.availableBefore = combined.to;
  }

  /*
   * findTrigger отличает «в выходные» от «не в выходные». Отрицание булева
   * признака — «не ставить», а формы собственности — противоположная: «не
   * государственную» значит частную.
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

  // «Чтобы рядом была парковка», «остановка рядом» — о парковке, а не «врач поближе».
  const nearLower = lower.replace(/(?<!\p{L})(?:рядом|недалеко|поблизости)\s+(?:с\s+клиник\p{L}*\s+)?(?:(?:был\p{L}*|есть|будет)\s+)?(?:парковк|остановк|метро|аптек|стоянк)\p{L}*|(?:парковк|остановк|метро|стоянк)\p{L}*\s+(?:(?:был\p{L}*|есть|будет)\s+)?(?:рядом|недалеко|поблизости)/gu, ' ');
  if (
    findTrigger(nearLower, 'ближайш', 'рядом', 'недалеко', 'поблизости', 'поближе', 'неподал') === 'affirmed'
    || /(?:ближе|около|возле|у)\s+(?:к\s+)?дом[ау]?(?!\p{L})/u.test(lower)
  ) {
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

  // «стаж от 10 лет», «опыт работы не менее 20».
  const minExperience = lower.match(/(?:стаж|опыт)\p{L}*\s*(?:работы\s*)?(?:от|более|больше|не\s+менее|свыше)?\s*(\d{1,2})(?!\d)/u);
  if (minExperience) {
    const value = Number(minExperience[1]);
    if (value >= 0 && value <= 60) constraints.minExperience = value;
  }

  // Порядок выдачи — отдельным условием: в описание вместо текста слова «по рейтингу» не попадают.
  const sort = lower.match(/(?:сортир\p{L}*|отсортир\p{L}*|упорядоч\p{L}*|покаж\p{L}*|выведи|по)\s+(?:по\s+)?(рейтинг|стаж|опыт|расстояни|удал[её]нност|алфавит|фамили|расписани)/u);
  if (sort) {
    constraints.sortMode = {
      рейтинг: 'rating', стаж: 'experience', опыт: 'experience', расстояни: 'distance', удаленност: 'distance',
      удалённост: 'distance', алфавит: 'name', фамили: 'name', расписани: 'schedule',
    }[sort[1]];
  }

  // «Нет ДМС» — не ставить; «ДМС нет» — отрицание после слова, findTrigger его не видит.
  if (findTrigger(lower, 'дмс') === 'affirmed' && !/(?<!\p{L})дмс\s+(?:нет|не\s)/u.test(lower)) constraints.dmsOnly = true;

  const maxTravel = extractMaxTravelMinutes(lower);
  if (maxTravel !== null) constraints.maxTravelMinutes = maxTravel;

  // Способ передвижения — отдельным условием: в описание вместо текста «пешком» не попадает.
  if (findTrigger(lower, 'пешком', 'пешочком') === 'affirmed') constraints.travelMode = 'foot';
  else if (/(?<!\p{L})на\s+(?:велосипед|велике|самокат)\p{L}*/u.test(lower)) constraints.travelMode = 'bike';
  else if (/(?<!\p{L})на\s+(?:машин|авто(?!бус)|такси)\p{L}*/u.test(lower)) constraints.travelMode = 'driving';

  return constraints;
};

/*
 * Время в пути: «максимум 20 минут от дома», «в пределах получаса». Голое
 * «через 20 минут» — не потолок дороги: число без слова-ограничения
 * засчитывается только рядом со словами о дороге.
 */
const TRAVEL_LIMIT_WORDS = '(?:максимум|не\\s+дольше|не\\s+дальше|не\\s+больше(?:\\s+чем)?|не\\s+более|не\\s+далее|не\\s+длиннее|меньше\\s+чем|в\\s+пределах|в\\s+радиусе|до|за)';
const TRAVEL_CONTEXT = '(?:от\\s+(?:дома|работы|меня|офиса)|езды|ехать|пути|в\\s+пути|дороги|пешком|ходьбы|на\\s+машине|на\\s+такси|на\\s+авто(?!бус)\\p{L}*|на\\s+велосипеде)';
const TRAVEL_PATTERNS = [
  new RegExp(`${TRAVEL_LIMIT_WORDS}\\s+(\\d{1,3})\\s*мин\\p{L}*`, 'u'),
  new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,3})\\s*мин\\p{L}*\\s+${TRAVEL_CONTEXT}`, 'u'),
];

export const extractMaxTravelMinutes = (lower) => {
  const text = String(lower || '').toLowerCase();
  if (new RegExp(`${TRAVEL_LIMIT_WORDS}\\s+получаса`, 'u').test(text) || new RegExp(`полчаса\\s+${TRAVEL_CONTEXT}`, 'u').test(text)) {
    return 30;
  }
  if (new RegExp(`${TRAVEL_LIMIT_WORDS}\\s+(?:часа|одного\\s+часа)(?![\\p{L}])`, 'u').test(text)) {
    return 60;
  }
  for (const pattern of TRAVEL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const value = Number(match[1]);
      if (value >= 5 && value <= 120) return value;
    }
  }
  return null;
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
    // «КТ» — только отдельным словом: основа «кт» нашла бы «кто».
    service: ruStem('услуг', 'анализ', 'узи', 'мрт', 'рентген', 'привив').test(lower) || /(?<!\p{L})кт(?!\p{L})/u.test(lower),
    clinic: ruStem('клиник', 'больниц', 'поликлиник', 'учрежден', 'медцентр').test(lower),
  };
};

/*
 * Пациент с фамилией врача: «Моя мама Гульнара Хабибуллина, нужен кардиолог».
 * Родственник или «пациент» прямо перед фамилией (можно через имя) — это
 * человек, а не врач из справочника.
 */
const KIN_BEFORE = /(\p{L}+)\s+(?:\p{Lu}\p{Ll}+\s+){0,2}$/u;

/*
 * Пользователь представился фамилией врача: «меня зовут Ризида Маслова» — не
 * шаг «к врачу Масловой». Между указателем и фамилией допускается имя, но не
 * «к», «врач», «доктор».
 */
const SELF_BEFORE = /(?:меня\s+зовут|зовут\s+меня|фио|ф\.\s*и\.\s*о\.?|на\s+имя|пишет|беспокоит|пациент\p{L}*)\s*[:,—-]?\s*(?:\p{L}+\.?\s+){0,2}$/iu;
const SELF_AFTER = /^\s*[,—-]?\s*(?:беспокоит|беспокою|пишет|пишу|на\s+связи|звонит)(?!\p{L})/iu;
const DOCTOR_CUE_BEFORE = /(?:^|[^\p{L}])(?:доктор|врач)\p{L}*\s+$/iu;
const SELF_DIRECT = /(?:^|[^\p{L}])я\s*[,—-]?\s*$/iu;
const DOCTOR_WORD_BETWEEN = /(?:^|\s)(?:к|ко|врач\p{L}*|доктор\p{L}*|специалист\p{L}*)\s/iu;

export const isNamedRelative = (content, entity) => {
  if (entity.kind !== ENTITY_KIND.DOCTOR) return false;
  const before = content.slice(Math.max(0, entity.start - 60), entity.start);
  const match = before.match(KIN_BEFORE);
  if (match && isKinshipWord(match[1])) return true;
  const self = before.match(SELF_BEFORE);
  if (self && !DOCTOR_WORD_BETWEEN.test(` ${self[0]}`)) return true;
  // «Марат Ринатович беспокоит», «Гульнара пишет».
  if (SELF_AFTER.test(content.slice(entity.end, entity.end + 24))) return true;
  return SELF_DIRECT.test(before);
};

/** Стыки реплик: сущность, пересекающая стык, собрана из нескольких сообщений. */
const crossTurnEntities = (contents) => {
  const boundaries = [];
  let offset = 0;
  for (const content of contents.slice(0, -1)) {
    offset += content.length;
    boundaries.push(offset);
    offset += 1;
  }
  if (boundaries.length === 0) return [];
  const { spans } = detectEntities(contents.join('\n'));
  return spans.filter((span) => boundaries.some((boundary) => span.start < boundary && span.end > boundary));
};

/**
 * Режим исходящего запроса (PRIVACY_OUTBOUND_MODE):
 *   structured — по умолчанию: наружу уходит только описание из перечислимых
 *                значений (профиль, время, места из справочника, метки
 *                @PERSON/@DOCTOR). Ни одного слова пользователя — и поэтому
 *                ни одного имени, телефона или адреса, распознали мы их или нет;
 *   hybrid     — слова пользователя уходят, если все они из закрытого словаря,
 *                иначе то же описание. Модель видит формулировку, но словарь
 *                пропускает совпадения вроде «Жене» (жена / Женя).
 * Цифры обоих режимов на размеченном наборе — docs/privacy-evaluation.md.
 */
export const OUTBOUND_MODES = Object.freeze(['structured', 'hybrid']);
const outboundModeFromEnv = () => (OUTBOUND_MODES.includes(process.env.PRIVACY_OUTBOUND_MODE) ? process.env.PRIVACY_OUTBOUND_MODE : 'structured');

/**
 * @param {object} deps
 * @param {{resolve: Function}} deps.resolver entity resolver по справочнику
 * @param {{mint: Function}} deps.vault хранилище токенов
 * @param {Function} [deps.classifier] классификатор жалоб (подменяется в тестах)
 * @param {object} [deps.catalog] справочник для закрытого словаря
 * @param {'structured'|'hybrid'} [deps.outboundMode] по умолчанию — из PRIVACY_OUTBOUND_MODE
 */
export const createPrivacyGateway = ({
  resolver,
  vault,
  classifier = classifySymptoms,
  catalog = null,
  outboundMode = outboundModeFromEnv(),
}) => {
  const structuredOutbound = outboundMode === 'structured';
  if (catalog) {
    registerCatalogVocabulary(catalog);
  }

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
    const streets = [];
    const entities = [];
    for (const entity of reconcileEntities(spans, links)) {
      if (isStreetMention(content, entity)) {
        streets.push(content.slice(entity.start, entity.end));
        continue;
      }
      entities.push(
        isNamedRelative(content, entity)
          ? { kind: ENTITY_KIND.PERSON, start: entity.start, end: entity.end, confidence: 0.9, matcher: 'person.relative' }
          : entity,
      );
    }
    const mentions = correctSpecialtyMentions(content, resolved.specialtyHits.map((hit) => ({
      ...hit,
      start: scan.map[hit.start],
      end: scan.map[Math.min(hit.end, scan.map.length - 1)],
    })));
    // Профиль, который назван только как часть другого («мануальный терапевт»), из списка снимается.
    const specialties = resolved.specialties.filter((key) => mentions.specialties.includes(key)
      || !resolved.specialtyHits.some((hit) => hit.key === key));
    return {
      incomplete: Boolean(resolved.incomplete),
      entities,
      streets,
      specialties,
      specialtyHits: mentions.specialtyHits,
      unknownSpecialties: mentions.unknownSpecialties,
      districts: resolved.districts,
    };
  };

  /**
   * Описание запроса вместо текста пользователя. Слова пользователя в него не
   * попадают — только перечислимые значения из справочника и классификатора.
   */
  const buildSyntheticTurn = ({ specialties, tokens, constraints, signals, isChild, places = [], outline = [], defaultProfile = true }) => {
    const parts = [];
    const profiles = specialties.length > 0 ? specialties : defaultProfile ? ['therapist'] : [];
    parts.push(profiles.length > 0
      ? `Пользователь ищет врача по профилю: ${profiles.join(', ')}.`
      : 'Пользователь ищет врача, профиль не указан.');
    if (places.length > 0) {
      parts.push(`Места: ${places.join(', ')}.`);
    }

    if (tokens.length > 0) {
      parts.push(`Упомянуты сущности: ${tokens.join(', ')}.`);
    }

    const order = describeOrder(outline);
    if (order) {
      parts.push(`Порядок в запросе: ${order}.`);
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
   * @param {object} params
   * @param {Array<{role: string, content: string}>} params.messages
   * @param {string} [params.sessionId]
   * @param {string} [params.requestId]
   * @returns {Promise<object>} решение, при decision=allow_external — request
   */
  const process = async ({ messages: incoming, sessionId, requestId = randomUUID() }) => {
    const session = normalizeSessionId(sessionId);

    /*
     * Во внешнюю модель уходят только реплики пользователя. Реплики ассистента
     * присылает браузер, и сервер не может проверить, что они наши: подставной
     * «ответ» с диагнозом или телефоном прошёл бы мимо классификатора жалоб и
     * проверки разрыва слов. Настоящие ответы к тому же содержат ФИО врачей, а
     * планировщику нужны только запросы пользователя.
     */
    const userMessages = (Array.isArray(incoming) ? incoming : []).filter((message) => message.role === 'user');
    /*
     * Контекст — все реплики пользователя: «а завтра?» дополняет прошлый запрос.
     * После «давай заново» или «забудь всё» прежние реплики не участвуют ни в
     * условиях, ни в плане.
     */
    const resetAt = userMessages.findLastIndex((message) => CONTEXT_RESET.test(String(message.content || '').toLowerCase()));
    const recent = (resetAt > 0 ? userMessages.slice(resetAt) : userMessages).slice(-MAX_CONTEXT_TURNS);
    /*
     * Вопрос не по теме («какая погода в субботу?») в разбор не идёт: его «в
     * субботу» не должно менять день приёма. Ответ — «это не ко мне», прежний
     * запрос остаётся.
     */
    const isOffTopic = (message) => {
      const text = String(message.content || '');
      if (!OFF_TOPIC.test(text.toLowerCase())) return false;
      if (detectEntities(text).spans.length > 0) return false;
      if (classifier(text).hasMedicalText) return false;
      return analyzeTurn(text).specialties.length === 0;
    };
    const offTopicFlags = recent.map(isOffTopic);
    const onTopic = recent.filter((_, index) => !offTopicFlags[index]);
    const lastOffTopic = offTopicFlags[offTopicFlags.length - 1] === true;
    const messages = onTopic.length > 0 ? onTopic : recent;
    const counters = new Map();
    const placeholders = [];
    const trusted = new Map();

    /*
     * Бюджет токенов проверяется до записи в хранилище, чтобы запрос с сотней
     * телефонов не заполнял его. Сверх бюджета — «пустой» токен без записи:
     * текст всё равно редактируется, а запрос уходит в локальный режим по
     * TOKEN_BUDGET.
     */
    let overBudget = 0;

    /** Выдаёт токен и запоминает связь «токен → реальная сущность». */
    const allocate = async (entity, identity) => {
      if (placeholders.length >= POLICY.maxPlaceholders) {
        overBudget += 1;
        return `@${entity.kind}`;
      }
      const kind = entity.kind === ENTITY_KIND.PERSON ? ENTITY_KIND.PERSON : entity.kind;
      const index = counters.get(kind) || 0;
      counters.set(kind, index + 1);

      const value = Array.isArray(entity.ids) && entity.ids.length > 0
        ? { ids: entity.ids, ambiguous: Boolean(entity.ambiguous) }
        : { opaque: true };

      const token = await vault.mint({ sessionId: session, requestId, kind, index, value });
      placeholders.push({ token, kind });
      trusted.set(token, { kind, identity, ...value });
      return token;
    };

    let analyses;
    let classification;
    let perTurnSpecialties = [];
    let perTurnChild = [];
    let perTurnTied = [];
    let perTurnVariants = [];
    try {
      /*
       * Разбор синхронный: уступка циклу событий между репликами не даёт длинной
       * истории занять ядро целиком, пока ждут статика и чужие запросы.
       */
      analyses = [];
      for (const message of messages) {
        analyses.push({ message, ...analyzeTurn(message.content) });
        await yieldToEventLoop();
      }

      /*
       * Жалоба классифицируется по всей истории: иначе в диалоге «болит зуб» →
       * «а есть кто-то после 18:00?» первая реплика ушла бы наружу целиком.
       * Красные флаги — только с последнего хода, чтобы отработанное неотложное
       * состояние не перехватывало каждый следующий вопрос.
       *
       * Жалоба ищется в тексте без найденных сущностей: фамилия «Раков» — не диагноз.
       */
      const masked = (analysis) => {
        let text = analysis.message.content;
        for (const entity of [...analysis.entities].sort((left, right) => right.start - left.start)) {
          text = `${text.slice(0, entity.start)} ${text.slice(entity.end)}`;
        }
        return text;
      };
      const perTurn = analyses.map((analysis) => classifier(masked(analysis)));
      /*
       * Профиль для записи по каждой реплике: названный прямо («ЛОР»), иначе —
       * первый по классификатору жалобы. Неуверенная жалоба в поздней реплике не
       * перебивает названный раньше профиль: «дерматолог» → «а просто
       * консультация?» не превращается в терапевта.
       */
      perTurnSpecialties = perTurn.map((item, index) => {
        if (analyses[index].specialties.length > 0) return [...new Set(analyses[index].specialties)];
        const namedEarlier = analyses.slice(0, index).some((analysis) => analysis.specialties.length > 0);
        if (namedEarlier && item.confidence < POLICY.symptomConfidenceThreshold) return [];
        return (item.specialties || []).slice(0, 1);
      });
      perTurnChild = perTurn.map((item) => Boolean(item.isChild));
      perTurnTied = perTurn.map((item) => item.tied || null);
      perTurnVariants = perTurn.map((item) => item.specialties || []);
      /*
       * «Гастроэнтеролог или невролог?» → «к первому» / «не знаю»: выбор из
       * профилей вопроса; «не знаю» — терапевт, предложенный ассистентом.
       */
      for (let index = 1; index < analyses.length; index += 1) {
        if (perTurnSpecialties[index].length > 0) continue;
        const reply = extractReplySignals(analyses[index].message.content);
        if (!reply.ordinal && !reply.unsure) continue;
        const asked = perTurnSpecialties.slice(0, index).findLastIndex((keys) => keys.length > 0);
        const tied = asked >= 0 && analyses[asked].specialties.length === 0 ? perTurnTied[asked] : null;
        if (!Array.isArray(tied) || tied.length !== 2) continue;
        const chosen = reply.unsure ? 'therapist' : tied[reply.ordinal - 1];
        perTurnSpecialties[index] = [chosen];
        analyses[index] = { ...analyses[index], specialties: [chosen], defaultedSpecialty: Boolean(reply.unsure) };
      }
      const lastTurn = perTurn[perTurn.length - 1] || classifier('');
      /*
       * Красные флаги проверяются и по тексту без маскировки: «Инсульт» с
       * заглавной детектор может принять за имя и вырезать. Для неотложных
       * состояний ложная тревога дешевле пропуска.
       */
      const lastRaw = analyses.length > 0 ? analyses[analyses.length - 1].message.content : '';
      const rawEmergency = lastTurn.emergency ? null : classifier(lastRaw).emergency;

      classification = {
        emergency: lastTurn.emergency || rawEmergency,
        hasMedicalText: perTurn.some((item) => item.hasMedicalText),
        isChild: perTurn.some((item) => item.isChild),
        confidence: Math.max(...perTurn.map((item) => item.confidence), 0),
        specialties: [...new Set(perTurn.flatMap((item) => item.specialties))],
        matchedRules: [...new Set(perTurn.flatMap((item) => item.matchedRules))],
      };
    } catch {
      // Fail-closed: сбой анализа — локальный режим, а не отправка текста.
      return {
        decision: GATEWAY_DECISION.LOCAL_ONLY,
        reason: FAIL_CLOSED_REASON.RESIDUAL_RISK,
        request: null,
        requestId,
        sessionId: session,
        context: emptyContext(session, requestId),
      };
    }

    /*
     * Ограничения и признаки намерения — по всем репликам, поздние важнее:
     * в диалоге «нужен лор для сына рядом» → «его зовут Тимур» иначе потерялись
     * бы и «рядом», и детский приём.
     */
    const userTexts = messages.map((message) => message.content);
    const turnConstraints = userTexts.map((text) => extractConstraints(text));
    const constraints = Object.assign({}, ...turnConstraints);

    const signals = {};
    for (const turnSignals of userTexts.map((text) => extractIntentSignals(text))) {
      for (const [name, active] of Object.entries(turnSignals)) signals[name] = Boolean(signals[name] || active);
    }
    // Маршрут просили словами («маршрут», «как добраться», «сначала… потом») — иначе разговор о записи.
    const routeIntent = Boolean(signals.route);
    const sequence = userTexts.some((text) => SEQUENCE_WORDS.test(String(text).toLowerCase()));
    /*
     * Профили, о которых разговор сейчас. Поздняя реплика с профилем заменяет
     * прежние («ЛОР» → «а лучше дерматолог»), а в разговоре о маршруте добавляет
     * остановку («маршрут к терапевту» → «и ещё к стоматологу»).
     */
    const routeStops = [];
    let previousSpecialties = [];
    let bookedSpecialties = [];
    let currentSpecialties = [];
    for (let index = 0; index < analyses.length; index += 1) {
      if (perTurnSpecialties[index].length === 0) continue;
      const named = analyses[index].specialties;
      const own = named.length > 0 ? named : perTurnVariants[index];
      const text = String(userTexts[index]).toLowerCase();
      const additive = named.length > 0 && ADDITIVE_WORDS.test(text) && !REPLACE_WORDS.test(text) && currentSpecialties.length > 0;
      // Прежний подбор — по профилю, к которому записывали (не по всем вариантам из жалобы).
      previousSpecialties = additive ? bookedSpecialties : [];
      bookedSpecialties = perTurnSpecialties[index];
      if (additive && (routeIntent || sequence)) {
        routeStops.push(...currentSpecialties.filter((key) => !own.includes(key) && !routeStops.includes(key)));
        currentSpecialties = [...new Set([...currentSpecialties, ...own])];
      } else {
        currentSpecialties = own;
        routeStops.length = 0;
      }
    }

    /*
     * Условия записи (день, цена, город, «без ДМС»…) наружу не уходят ни в каком
     * виде: их исполняет строгий подбор на сервере. Профиль для записи — из
     * последней реплики, где он назван. Если это профиль не из справочника
     * («нет, лучше косметолог»), прежний не подбирается, а ответ говорит
     * «такого врача нет».
     */
    const lastSpecialtyIndex = perTurnSpecialties.findLastIndex((keys) => keys.length > 0);
    const lastUnknownIndex = analyses.findLastIndex((analysis) => analysis.unknownSpecialties.length > 0);
    const unknownWins = lastUnknownIndex >= 0 && lastUnknownIndex >= lastSpecialtyIndex;
    const unknownOnly = unknownWins && analyses[lastUnknownIndex].specialties.length === 0;
    const lastSpecialties = unknownOnly ? [] : perTurnSpecialties[lastSpecialtyIndex] || [];
    const turnBookings = userTexts.map((text, index) => ({ ...extractBookingConstraints(text), ...demoRefsOf(analyses[index]), reply: extractReplySignals(text) }));
    /*
     * «В Разумед на Пушкина» → «а на Ленинградской?»: улица без названия
     * клиники — другой филиал той же клиники.
     */
    for (let index = 1; index < turnBookings.length; index += 1) {
      if (turnBookings[index].branchIds?.length || turnBookings[index].excludeBranchIds?.length) continue;
      const earlier = turnBookings.slice(0, index).reverse().find((item) => item.clinicBranches?.length);
      if (!earlier) continue;
      const onStreet = branchesOnStreet(earlier.clinicBranches, userTexts[index]);
      if (onStreet.length > 0 && onStreet.length < earlier.clinicBranches.length) turnBookings[index] = { ...turnBookings[index], branchIds: onStreet };
    }
    /*
     * «К Ефимова» → «нашёл двоих, уточните» → «Тимуру»: имя без фамилии
     * выбирает одного из однофамильцев, названных раньше.
     */
    for (let index = 1; index < turnBookings.length; index += 1) {
      if (turnBookings[index].doctorIds?.length || turnBookings[index].excludeDoctorIds?.length) continue;
      const earlier = turnBookings.slice(0, index).reverse().find((item) => item.doctorIds?.length);
      if (!earlier || earlier.doctorIds.length < 2) continue;
      const named = doctorsByFirstName(earlier.doctorIds, userTexts[index]);
      if (named.length > 0 && named.length < earlier.doctorIds.length) turnBookings[index] = { ...turnBookings[index], doctorIds: named };
    }
    const mergedBooking = mergeBookingTurns(turnBookings.map((booking, index) => ({ booking, constraints: turnConstraints[index] })));
    /*
     * «Невролог Ефимова» → «а Ефимов?»: врач, названный позже профиля, сам
     * задаёт профиль — прежний «невролог» к нему не применяется (иначе
     * подбор пуст: Ефимов — ЛОР).
     */
    const lastDoctorIndex = turnBookings.findLastIndex((item) => item.doctorIds?.length > 0);
    const doctorAfterSpecialty = lastDoctorIndex >= 0 && lastDoctorIndex > lastSpecialtyIndex;
    const bookingSpecialties = doctorAfterSpecialty ? []
      // Маршрут из нескольких реплик — несколько врачей, а не запись к одному.
      : routeStops.length > 0 ? currentSpecialties
        : lastSpecialties.length > 0 || unknownOnly
          ? lastSpecialties
          // «Подбор очков» без слова «офтальмолог»: профиль однозначно задан процедурой.
          : mergedBooking.procedureSpecialty ? [mergedBooking.procedureSpecialty] : [];
    /*
     * «Невролог или терапевт» — выбор профиля для одной записи, а не маршрут
     * («ЛОР и стоматолог»). По последней реплике с профилями: между ними только
     * «или»/«либо».
     */
    const lastSpecialtyTurn = [...analyses].reverse().find((analysis) => analysis.specialties.length > 0);
    const choiceHits = (lastSpecialtyTurn?.specialtyHits || []).filter((hit) => !hit.negated).sort((left, right) => left.start - right.start);
    /*
     * «Лор, гинеколог или уролог — кто угодно из них»: перечисление через
     * запятую с «или» в конце — тоже выбор. Через «и» — маршрут по врачам.
     */
    const choiceGaps = choiceHits.slice(1).map((hit, position) => lastSpecialtyTurn.message.content.slice(choiceHits[position].end, hit.start));
    const anyOfThem = /(?<!\p{L})(?:кто\s+угодно|кто-нибудь|кто-то|любой|любого|любому|неважно\s+кто|не\s+важно\s+кто|без\s+разницы\s+(?:кто|к\s+кому))(?:\s+из\s+(?:них|этих|трёх|трех|двух))?(?!\p{L})/iu
      .test(lastSpecialtyTurn?.message.content.slice(choiceHits[choiceHits.length - 1]?.end ?? 0) || '');
    const specialtyChoice = choiceHits.length > 1 && new Set(choiceHits.map((hit) => hit.key)).size > 1
      // «К лору... или к неврологу...» — многоточие между ними тоже не разрывает выбор.
      && choiceGaps.every((gap) => /^[\s,.…!?—–-]*(?:(?:или|либо)\s+)?(?:к\s+|ко\s+)?$/iu.test(gap))
      && (/(?:или|либо)\s+(?:к\s+|ко\s+)?$/iu.test(choiceGaps[choiceGaps.length - 1] || '') || anyOfThem);
    const booking = {
      ...mergedBooking,
      specialtyChoice,
      specialties: bookingSpecialties.filter((key) => key in SPECIALTY_CANON),
      unknownSpecialty: unknownWins ? analyses[lastUnknownIndex].unknownSpecialties[0] : null,
      // Профиль назван словами («ЛОР»), а не выведен из жалобы — по нему можно искать без уточнений.
      explicitSpecialty: lastSpecialtyIndex >= 0 && analyses[lastSpecialtyIndex].specialties.length > 0,
      // «Не знаю» на вопрос «к кому записаться?» — терапевт, которого ассистент предложил сам.
      specialtyDefaulted: lastSpecialtyIndex >= 0 && Boolean(analyses[lastSpecialtyIndex].defaultedSpecialty),
      // Признаки ответа последней реплики («не знаю», «да») — для текста ответа.
      lastReply: turnBookings[turnBookings.length - 1]?.reply || {},
      // Жалоба указывает на два разных профиля поровну — ассистент спросит, к кому.
      specialtyQuestion: lastSpecialtyIndex >= 0 && analyses[lastSpecialtyIndex].specialties.length === 0 && !doctorAfterSpecialty
        ? perTurnTied[lastSpecialtyIndex] : null,
      /*
       * Для кого приём — по последней реплике, где это сказано: «педиатр для
       * сына» → «а теперь мне к терапевту» — взрослый приём. «Не детский, а
       * взрослый» — слово «детский» не делает приём детским.
       */
      child: (() => {
        const lastSaid = userTexts.map((text, index) => (turnBookings[index].adult ? 'adult'
          : perTurnChild[index] ? 'child'
            : ADULT_PATIENT.test(String(text).toLowerCase()) ? 'adult' : null)).filter(Boolean).pop();
        return lastSaid === 'child';
      })(),
      medicalText: Boolean(classification.hasMedicalText),
      routeIntent,
      sequence,
      // «ЛОР завтра» → «и ещё мне нужен кардиолог»: прежний подбор остаётся в прошлом ответе.
      previousSpecialties: routeStops.length > 0 ? [] : previousSpecialties.filter((key) => !bookingSpecialties.includes(key)),
    };

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
         * В долю редактуры идут только неизвестные сущности: ссылка на врача
         * или клинику из справочника — обычный запрос («маршрут к Галявичу»),
         * а не персональные данные.
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
     * Признаки нарочитого разрыва — по исходному тексту всех реплик, а
     * «разрешено» — если сработала склейка и фамилия уже заменена токеном.
     *
     * Слово, разрезанное между репликами («пациентки Кондра» → «шкина, нужен
     * терапевт»), — то же сокрытие, что и «К о н д р а ш к и н а»: каждая
     * реплика по отдельности безобидна.
     */
    const splitAcrossTurns = messages.some((message, index) => {
      const next = messages[index + 1];
      if (!next) return false;
      const tail = String(message.content).match(/(\p{L}{2,})\s*$/u);
      const head = String(next.content).match(/^\s*(\p{Ll}{2,})/u);
      return Boolean(tail && head) && looksLikeSurname(tail[1] + head[1]);
    });

    /*
     * Данные, разложенные по сообщениям («снилс 123 456» → «789 01»): детекторы
     * прогоняются ещё и по склейке. Найденное на стыке — повод не отправлять
     * запрос, документ — повод для обычного отказа.
     */
    let crossTurn = [];
    try {
      crossTurn = crossTurnEntities(messages.map((message) => String(message.content)));
    } catch {
      crossTurn = [{ kind: ENTITY_KIND.ACCOUNT }];
    }
    const joinedObfuscation = messages.length > 1
      && detectObfuscation(messages.map((message) => message.content).join(' ')).suspicious;

    const obfuscation = {
      suspicious: splitAcrossTurns || joinedObfuscation || messages.some(
        (message) => message.role === 'user' && detectObfuscation(message.content).suspicious,
      ),
      resolved: analyses.some((analysis) =>
        analysis.entities.some((entity) => entity.matcher === 'doctor.glued' || entity.matcher === 'doctor.joined'),
      ),
    };

    const lastRedacted = redactedTurns[redactedTurns.length - 1]?.text || '';

    // «Сначала к терапевту @DOCTOR_A, потом @HOME» — порядок, который планировщик обязан сохранить.
    const lastOutline = buildOutline(lastRedacted, placeholders, locationTokens, analyses);
    // Остановки из прежних реплик маршрута — впереди: «маршрут к терапевту» → «и ещё к стоматологу».
    const lastText = String(userTexts[userTexts.length - 1] || '').toLowerCase();
    const continuesRoute = (routeIntent || sequence) && (routeStops.length > 0 || (ADDITIVE_WORDS.test(lastText) && !REPLACE_WORDS.test(lastText)));
    const outline = [
      ...(continuesRoute ? currentSpecialties : [])
        .filter((key) => !lastOutline.some((item) => item.kind === 'SPECIALTY' && item.specialty === key))
        .map((specialty) => ({ kind: 'SPECIALTY', specialty })),
      ...lastOutline,
    ];
    const allEntities = analyses.flatMap((analysis) => analysis.entities);
    const streetWords = new Set(
      analyses.flatMap((analysis) => analysis.streets.flatMap((street) => street.split(/\s+/u))),
    );

    /*
     * Длина осмысленного текста. Токен врача, клиники или места — содержание
     * запроса («РКБ»), а не вырезанные данные: иначе запрос из одного названия
     * клиники считался бы пересредактированным.
     */
    const contentTokens = new Set([
      ...placeholders
        .filter((item) => item.kind === ENTITY_KIND.DOCTOR || item.kind === ENTITY_KIND.CLINIC)
        .map((item) => item.token),
      ...locationTokens,
    ]);
    const sanitizedChars = lastRedacted
      .replace(/@[A-Z][A-Z0-9_]*/g, (token) => (contentTokens.has(token) ? 'xxxxxxxx' : ''))
      .trim().length;

    /*
     * Профили для модели и локального плана — только текущие: после «педиатр для
     * сына» → «а теперь мне к терапевту» маршрут не идёт через обоих.
     */
    const currentKnown = unknownOnly || doctorAfterSpecialty ? [] : currentSpecialties;
    const specialties = [
      ...new Set(lastSpecialtyIndex >= 0 || unknownOnly || doctorAfterSpecialty
        ? currentKnown
        : [...catalogSpecialties, ...(classification.specialties || [])]),
    ].filter((key) => key in SPECIALTY_CANON);

    /*
     * Места для описания — только из закрытых списков. Из реплики с адресом
     * улицы не берутся вовсе: в «живу на Чистопольской, дом пять» улица — часть
     * адреса, а не ориентир.
     */
    const placeText = analyses
      .filter((analysis) => !analysis.entities.some((entity) => entity.kind === ENTITY_KIND.ADDRESS))
      .map((analysis) => analysis.message.content)
      .join('\n');
    const places = [...new Set([...findKnownPlaces(placeText), ...findStreetMentions(placeText)])];

    /*
     * Есть ли модели что планировать: иначе в режиме structured «привет»
     * превращается в «ищет врача, профиль не указан» и тратит внешний вызов.
     * Метка человека (@PERSON_A) или телефона цели поиска не задаёт.
     */
    const plannable = specialties.length > 0
      || catalogDistricts.size > 0
      || places.length > 0
      || locationTokens.length > 0
      || placeholders.some((item) => item.kind === ENTITY_KIND.DOCTOR || item.kind === ENTITY_KIND.CLINIC)
      || Object.keys(constraints).length > 0
      || Object.values(signals).some(Boolean)
      || Boolean(classification.isChild)
      || Boolean(classification.hasMedicalText);

    // «Хочу к доктору Пупкину» без фамилии в справочнике — ответ «такого врача нет».
    const namedUnknownDoctor = analyses.some((analysis) => analysis.entities.some((entity) =>
      entity.kind === ENTITY_KIND.PERSON
      && DOCTOR_CUE_BEFORE.test(analysis.message.content.slice(Math.max(0, entity.start - 24), entity.start))));

    const decision = decideGatewayPolicy({
      entities: [...allEntities, ...crossTurn],
      classification,
      redactionRatio: totalChars > 0 ? totalRedacted / totalChars : 0,
      placeholderCount: placeholders.length + overBudget,
      residualNameLike: countResidualNameLike(lastRedacted, streetWords),
      analysisIncomplete: analyses.some((analysis) => analysis.incomplete) || crossTurn.length > 0,
      obfuscation,
      sanitizedChars,
      structuredOutbound,
      plannable,
      namedUnknownDoctor,
      explicitSpecialty: catalogSpecialties.size > 0,
    });

    const context = {
      sessionId: session,
      requestId,
      // Последняя реплика — не по теме: ответ «это не ко мне», условия — из прежних реплик.
      offTopic: lastOffTopic,
      offTopicOnly: lastOffTopic && onTopic.length === 0,
      trusted,
      placeholders,
      locationTokens,
      constraints,
      booking,
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
     * Текст со сведениями о здоровье наружу не уходит никогда — ни последняя
     * реплика, ни история: вместо него синтезированное описание из
     * перечислимых значений.
     *
     * В режиме hybrid остальные слова уходят, только если все они из закрытого
     * словаря (privacy/vocabulary.js): неизвестное слово может оказаться
     * фамилией, диагнозом или ником, о которых детекторы не знают.
     */
    const issuedTokens = [...placeholders.map((item) => item.token), ...locationTokens];
    const vocabulary = classification.hasMedicalText
      ? { ok: false, reason: 'medical' }
      : structuredOutbound
        ? { ok: false, reason: 'structured' }
        : checkClosedVocabulary(redactedTurns.map((turn) => turn.text), issuedTokens);
    context.metrics.textWithheld = !vocabulary.ok;
    context.metrics.withheldReason = vocabulary.reason;

    const outboundTurns = vocabulary.ok
      ? redactedTurns
      : [
          {
            role: 'user',
            text: buildSyntheticTurn({
              specialties,
              tokens: issuedTokens,
              constraints,
              signals,
              isChild: booking.child,
              places,
              outline,
              defaultProfile: classification.hasMedicalText,
            }),
          },
        ];

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
        isChild: Boolean(booking.child),
        medicalTextWithheld: Boolean(classification.hasMedicalText),
        textWithheld: !vocabulary.ok && !classification.hasMedicalText,
      },
      locale: 'ru-RU',
    });

    return { ...decision, request, requestId, sessionId: session, context };
  };

  return Object.freeze({ process, policyVersion: POLICY_VERSION, policy: POLICY });
};

/*
 * Порядок шагов для описания вместо текста: без него модель не знает ни
 * порядка, ни того, что @DOCTOR_A и есть терапевт. Строка собирается только
 * из меток и ключей профилей; специальность прямо перед врачом или клиникой
 * уточняет их и своего шага не даёт (как в localPlanner).
 */
const ORDER_KINDS = new Set([ENTITY_KIND.DOCTOR, ENTITY_KIND.CLINIC, 'LOCATION', 'SPECIALTY']);

export const describeOrder = (outline = []) => {
  const items = outline.filter((item) => ORDER_KINDS.has(item.kind));
  const steps = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    if (item.kind === 'SPECIALTY') {
      if (!(item.specialty in SPECIALTY_CANON)) continue;
      if (next && (next.kind === ENTITY_KIND.DOCTOR || next.kind === ENTITY_KIND.CLINIC)) {
        steps.push(`${next.token} (${item.specialty})`);
        index += 1;
        continue;
      }
      steps.push(item.specialty);
      continue;
    }
    steps.push(item.token);
  }
  const unique = steps.filter((step, index) => steps.indexOf(step) === index);
  // Разделитель — слово: исходящий текст проверяется закрытым словарём, «→» в нём нет.
  return unique.length >= 2 ? unique.join(', затем ') : '';
};

/**
 * Последовательность сущностей и специальностей последней реплики: токены — по
 * позициям в отредактированном тексте, специальности — по позициям в исходном.
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
  booking: null,
  signals: {},
  classification: { specialties: [], confidence: 0, hasMedicalText: false, emergency: null, isChild: false },
  outline: [],
  specialties: [],
  districts: [],
  metrics: { entitiesDetected: 0, placeholders: 0, redactionRatio: 0, medicalText: false, emergency: false },
});
