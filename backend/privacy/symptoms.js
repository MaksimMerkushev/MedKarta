/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Локальный детерминированный классификатор жалоб. «Неделю болит живот и
 * тошнит» — сведения о здоровье и во внешнюю модель не уходят: описание
 * превращается в профили, и наружу идёт «ищет therapist или
 * gastroenterologist» без текста жалобы.
 *
 * Это не диагностика: модуль не ставит диагноз, не оценивает тяжесть, только
 * выбирает профиль для поиска по справочнику. Любой вывод для пользователя
 * обязан сопровождаться этой оговоркой (см. executor/resultBuilder.js).
 *
 * Интерфейс classifySymptoms(text) позволяет заменить слой локальной LLM,
 * не затрагивая Planner и Executor.
 */

import { normalizeRu } from './normalize.js';
import { stemWord } from './morphology.js';

/**
 * Красные флаги: запрос не уходит ни во внешнюю модель, ни в поиск —
 * пользователь сразу получает указание вызвать экстренную помощь.
 */
const RED_FLAGS = [
  {
    id: 'chest_pain',
    words: [
      'боль груд', 'болит груд', 'давит груд', 'жжет груд', 'сжимает груд',
      'грудь болит', 'груди болит', 'грудь давит', 'за грудиной', 'сердечный приступ',
    ],
    /*
     * «Болит сердце» — повод к кардиологу, но с отдачей в руку, челюсть или
     * лопатку, холодным потом или нехваткой воздуха — картина инфаркта.
     * Слова ищутся в любом порядке.
     */
    combos: [
      [
        ['сердц', 'сердечн', 'груд'],
        ['отдает в руку', 'отдает в левую', 'отдает в челюст', 'отдает в лопатк', 'отдает в шею', 'отдает в плеч',
          'отдает в спину', 'холодный пот', 'холодным потом', 'не хватает воздуха'],
      ],
    ],
    contextual: [{ term: /(?:микро)?инфаркт/u }],
  },
  {
    id: 'breathing',
    words: [
      'не могу дышать', 'нечем дышать', 'задыхаюсь', 'задыхается', 'удушье', 'остановка дыхания',
      'не дышит', 'перестал дышать', 'перестала дышать', 'посинел', 'посинела', 'синеют губы', 'губы синеют',
      'губы посинели',
    ],
    // «Трудно дышать носом» — заложенный нос, а не неотложное состояние.
    patterns: [/(?:трудно|тяжело) дышать(?! носом)/u],
  },
  {
    id: 'consciousness',
    words: ['потеря сознания', 'без сознания', 'обморок', 'не приходит в себя', 'не приходит в сознание', 'не могу разбудить', 'не просыпается'],
    patterns: [/потерял\p{L}* сознани|сознани\p{L}* потерял|теря\p{L}* сознани/u],
  },
  {
    id: 'bleeding',
    words: [
      'сильное кровотечение', 'кровотечение не останавливается', 'кровотечение не прекращается', 'рвота кровью',
      'рвота с кровью', 'кровь изо рта', 'кровь не останавливается', 'не останавливается кровь',
      'не могу остановить кровь', 'кровь хлещет', 'хлещет кровь',
    ],
  },
  {
    id: 'stroke',
    words: [
      'перекосило лицо', 'лицо перекосило', 'перекосило рот', 'онемела половина', 'отнялась рука', 'отнялась нога',
      'отнялась половина', 'не могу говорить', 'речь пропала', 'речь нарушилась', 'заплетается язык',
      'язык заплетается', 'асимметрия лица',
    ],
    // «Реабилитация после инсульта», «был инсульт три года назад» — поиск
    // невролога, а не вызов скорой (см. PAST_CONTEXT).
    contextual: [{ term: /(?:микро)?инсульт/u }],
  },
  {
    id: 'seizure',
    // «Судороги в ногах по ночам» — это мышечные спазмы, к неврологу или терапевту.
    contextual: [{ term: /судорог|припад(?:ок|к)|конвульси/u, notNear: /(?:в ног|ноги|ногу|ногах|икр|икроножн|стоп|пальц|сводит)/u }],
  },
  {
    id: 'anaphylaxis',
    words: [
      'отек горла', 'отек гортани', 'анафилакт', 'отек квинке', 'отекло лицо', 'отекли губы', 'опух язык',
      'отек языка', 'опухло горло', 'горло опухло', 'отекло горло', 'горло отекло', 'распухло горло',
      'опухает горло', 'отекает горло',
    ],
  },
  { id: 'trauma', words: ['открытый перелом', 'сильное отравление', 'ожог большой'] },
  /*
   * Ситуации, при которых педиатры просят звонить сразу, не дожидаясь приёма.
   * Список короткий: каждое ложное «звоните 103» отучает доверять предупреждению.
   */
  {
    id: 'poisoning',
    words: [
      'проглотил батарейк', 'проглотила батарейк', 'проглотил магнит', 'проглотила магнит', 'выпил таблетки',
      'выпила таблетки', 'наглотался', 'наглоталась', 'выпил уксус', 'выпила уксус', 'передозировк',
      'выпил много таблеток', 'выпила много таблеток', 'угарный газ', 'угарным газом', 'отравился грибами',
      'отравилась грибами', 'отравление грибами',
    ],
  },
  { id: 'abdomen', words: ['острая боль в живот', 'резкая боль в живот', 'сильная боль в живот', 'нестерпимая боль в живот', 'кинжальная боль'] },
  { id: 'rash', words: ['сыпь не исчезает при надавливании', 'сыпь не проходит при надавливании', 'сыпь не бледнеет', 'сыпь не пропадает при надавливании'] },
  { id: 'fever_high', words: ['температура 40', 'температура 41', 'температура под 40', 'температура выше 40', 'температура не сбивается', 'температура не снижается', 'жар не сбивается'] },
  // Сочетания: каждая группа должна найтись в тексте хотя бы одним словом.
  { id: 'infant_fever', allOf: [['грудничк', 'грудной ребен', 'младенц', 'младенец', 'новорожден'], ['температур', 'жар']] },
  {
    id: 'head_injury',
    allOf: [
      ['ударился головой', 'ударилась головой', 'удар головой', 'ударил головой', 'травма головы', 'упал с высоты', 'упала с высоты'],
      ['рвет', 'рвота', 'вырвало', 'тошнит', 'сознан', 'сонлив', 'кровь из уха', 'судорог'],
    ],
  },
  {
    id: 'self_harm',
    words: [
      'покончить с собой', 'покончу с собой', 'не хочу жить', 'не хочется жить', 'жить не хочу',
      'жить не хочется', 'хочу умереть', 'хочется умереть', 'причинить себе вред', 'убить себя',
      'убью себя', 'суицид', 'самоубийств', 'вскрыть вены', 'порезать себя', 'повеситься',
      'наглотаться таблеток', 'выпрыгнуть из окна', 'свести счеты с жизнью',
      'не хочу больше жить', 'больше не хочу жить', 'не хочется больше жить', 'покончить с жизнью',
      'покончу с жизнью', 'лишить себя жизни', 'уйти из жизни', 'нет смысла жить', 'незачем жить',
    ],
  },
];

/*
 * Прошедшее время и восстановление («после инфаркта», «был инсульт год
 * назад») — запрос к кардиологу или неврологу, а не вызов скорой. Окно —
 * несколько слов до и после термина.
 */
const PAST_CONTEXT = /(?:после|перенес|перенесл|перенесенн|был|была|было|постинфаркт|постинсульт|реабилит|восстанов|последстви|анамнез|назад|в прошлом|прошлом году|профилактик|риск)/u;

/**
 * Порядок специальностей в правиле — порядок предпочтения. weight —
 * специфичность: «зуб» указывает на стоматолога надёжнее, чем «слабость» —
 * на терапевта.
 */
const RULES = [
  { id: 'dental', weight: 3, stems: ['зуб', 'десн', 'челюст', 'карие', 'пломб', 'коронк', 'прикус'], specialties: ['dentist'] },
  { id: 'gastro', weight: 2, stems: ['живот', 'желудок', 'тошнот', 'тошнит', 'рвот', 'изжог', 'диаре', 'понос', 'запор', 'кишечник', 'печен', 'вздути', 'отрыжк', 'стул'], specialties: ['gastroenterologist', 'therapist'] },
  { id: 'cardio', weight: 3, stems: ['сердц', 'аритми', 'давлени', 'пульс', 'сердцебиени', 'одышк', 'тахикарди'], specialties: ['cardiologist', 'therapist'] },
  { id: 'neuro', weight: 2, stems: ['голов', 'мигрен', 'головокружени', 'спин', 'поясниц', 'онемени', 'шея', 'шеи', 'шее', 'невралги', 'бессонниц', 'памят', 'защемлени'], specialties: ['neurologist', 'therapist'] },
  { id: 'derma', weight: 3, stems: ['кож', 'сып', 'зуд', 'прыщ', 'родинк', 'экзем', 'псориаз', 'волос', 'ногт', 'шелушени'], specialties: ['dermatologist'] },
  { id: 'ophthalmo', weight: 3, stems: ['глаз', 'зрени', 'век', 'слезит', 'близорук', 'дальнозорк', 'ячмен'], specialties: ['ophthalmologist'] },
  { id: 'lor', weight: 3, stems: ['ухо', 'уши', 'ушн', 'горл', 'нос', 'насморк', 'гайморит', 'ангин', 'слух', 'миндалин', 'осиплост', 'храп'], specialties: ['lor', 'therapist'] },
  { id: 'endo', weight: 3, stems: ['щитовидн', 'щитовидк', 'сахар', 'гормон', 'диабет', 'похудени'], specialties: ['endocrinologist', 'therapist'] },
  { id: 'gyneco', weight: 3, stems: ['беременн', 'менструа', 'цикл', 'гинеколог'], specialties: ['gynecologist'] },
  { id: 'uro', weight: 3, stems: ['почк', 'мочев', 'простат', 'мочеиспускани'], specialties: ['urologist', 'therapist'] },
  { id: 'ortho', weight: 2, stems: ['перелом', 'вывих', 'ушиб', 'сустав', 'колен', 'травм', 'связк', 'плеч'], specialties: ['traumatologist', 'orthopedist'] },
  { id: 'surgery', weight: 2, stems: ['грыж', 'аппендиц', 'операци', 'шов', 'нарыв', 'фурункул'], specialties: ['surgeon'] },
  { id: 'mental', weight: 2, stems: ['тревог', 'депресс', 'паническ', 'апати', 'выгорани'], specialties: ['psychiatrist', 'therapist'] },
  { id: 'general', weight: 2, stems: ['температур', 'слабост', 'простуд', 'орви', 'грипп', 'кашел', 'недомогани', 'озноб', 'лихорадк', 'усталост'], specialties: ['therapist'] },

  /*
   * Диагнозы и состояния — сведения о здоровье особой категории: без этих
   * правил «метастазы после химиотерапии» ушли бы наружу дословно. Профиль —
   * ближайший из доступных; главное, что текст заменяется описанием.
   */
  { id: 'oncology', weight: 3, stems: ['рак', 'опухол', 'метастаз', 'химиотерап', 'химия', 'лучевую', 'онкологи', 'лимфом', 'лейкоз', 'меланом', 'карцином', 'саркам', 'новообразовани'], specialties: ['therapist'] },
  { id: 'infection', weight: 3, stems: ['вич', 'спид', 'гепатит', 'туберкул', 'сифилис', 'гонорея', 'хламиди', 'герпес', 'венерич', 'зппп', 'трихомон'], specialties: ['dermatologist', 'therapist'] },
  { id: 'addiction', weight: 3, stems: ['алкогол', 'запой', 'запоем', 'наркоман', 'наркотик', 'наркозависим', 'алкозависим', 'героин', 'метадон', 'кодирова', 'похмель'], specialties: ['psychiatrist', 'therapist'] },
  { id: 'psychiatry', weight: 3, stems: ['шизофрен', 'биполяр', 'психоз', 'галлюцинац', 'бред', 'суицид', 'самоповрежд'], specialties: ['psychiatrist'] },
  { id: 'reproductive', weight: 3, stems: ['аборт', 'выкидыш', 'бесплоди', 'эко', 'импотенц', 'эрекци', 'климакс'], specialties: ['gynecologist', 'urologist'] },
];

const PHRASE_RULES = [
  { id: 'gyneco_phrase', specialty: 'gynecologist', pattern: /(?<!\p{L})(?:по\s+)?женск\p{L}*\s+(?:дел|част|проблем|болезн)\p{L}*/u },
  { id: 'uro_phrase', specialty: 'urologist', pattern: /(?<!\p{L})(?:по\s+)?мужск\p{L}*\s+(?:дел|част|проблем|болезн)\p{L}*/u },
];

/*
 * Слова, которые начинаются как жалоба, но означают другое: «травмпункт»
 * содержит основу «травм», «эко» — часть «экологии», «просто» совпадает и с
 * «простудой», и с «простатой». Иначе «Ближайший травмпункт» — описание
 * травмы, и запрос не уходит планировщику.
 */
const NOT_A_COMPLAINT = /^(?:травмпункт|травм[ао]толог|эколог|экономи|экобез|рака[тк]|раков|ракурс|вичуг|спидометр|прост(?:о|ой|ая|ое|ые|ого|ую|ым)?$)/u;

const CHILD_STEMS = ['ребенок', 'ребенк', 'дет', 'малыш', 'грудничк', 'сын', 'доч', 'подростк', 'младенц'];

/** Лексика, выдающая описание состояния здоровья независимо от специальности. */
const MEDICAL_MARKERS = [
  'болит', 'больно', 'боль', 'беспокоит', 'мучает', 'чувствую', 'самочувств',
  'симптом', 'болею', 'заболел', 'ноет', 'колет', 'тянет', 'ломит',
  'приступ', 'обострени', 'хроническ', 'диагноз',
  'нехорошо', 'дурно', 'тошно', 'кружится', 'знобит', 'температур', 'давлени',
  'мне плохо', 'стало плохо', 'плохо себя', 'недомогани',
  // Без «анализ», «узи», «мрт», «у меня»: «Где сделать МРТ» и «У меня есть
  // полис ОМС» — вопросы об услугах, а не жалобы.
];

/** Убирает односимвольные служебные слова: «боль в груди» → «боль груди». */
const compactPhrase = (value) =>
  value
    .split(' ')
    .filter((word) => word.length > 1)
    .join(' ');

const PRECOMPILED = RULES.map((rule) => ({ ...rule, stems: rule.stems.map((stem) => normalizeRu(stem)) }));
const CHILD_NORMALIZED = CHILD_STEMS.map((stem) => normalizeRu(stem));
/*
 * Маркер ищется с начала слова, а продолжения «больше», «больница»,
 * «больничный» исключены: иначе «рейтинг больше 4.5» считается жалобой.
 */
const NOT_MARKER_TAIL = /^(?:больш|больниц|больничн|побольш)/u;
const MARKERS_NORMALIZED = MEDICAL_MARKERS.map((marker) => normalizeRu(marker));
const hasMarker = (normalized) => {
  const words = normalized.split(' ');
  return MARKERS_NORMALIZED.some((marker) => {
    if (marker.includes(' ')) return ` ${normalized} `.includes(` ${marker}`);
    return words.some((word) => word.startsWith(marker) && !NOT_MARKER_TAIL.test(word));
  });
};
const normalizeGroups = (groups) => groups.map((group) => group.map((word) => normalizeRu(word)));

const RED_FLAGS_NORMALIZED = RED_FLAGS.map((flag) => ({
  id: flag.id,
  words: (flag.words || []).map((word) => normalizeRu(word)),
  // allOf — одна комбинация; combos — несколько, достаточно любой.
  combos: [...(flag.allOf ? [flag.allOf] : []), ...(flag.combos || [])].map(normalizeGroups),
  patterns: flag.patterns || [],
  contextual: flag.contextual || [],
}));

const containsPhrase = (normalized, compact, word) => normalized.includes(word) || compact.includes(compactPhrase(word));

/** Термин найден хотя бы раз вне «прошедшего» или исключённого контекста. */
const matchesContextual = ({ term, notNear = null }, normalized) => {
  const regex = new RegExp(term.source, 'gu');
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    const before = normalized.slice(Math.max(0, match.index - 40), match.index);
    const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 30);
    const window = `${before} ${after}`;
    const excluded = notNear ? notNear.test(window) : PAST_CONTEXT.test(window);
    if (!excluded) return true;
  }
  return false;
};

const matchesRedFlag = (flag, normalized, compact) =>
  flag.words.some((word) => containsPhrase(normalized, compact, word)) ||
  flag.combos.some((combo) => combo.every((group) => group.some((word) => containsPhrase(normalized, compact, word)))) ||
  flag.patterns.some((pattern) => pattern.test(normalized)) ||
  flag.contextual.some((rule) => matchesContextual(rule, normalized));

/**
 * Основа слова из текста начинается с основы правила — префикс, а не
 * равенство: «живота», «животом» сводятся к «живот», но «тошнит» и «тошнота»
 * дают разные основы.
 */
const matchesStem = (tokenStems, ruleStem) =>
  tokenStems.some((token) => {
    if (token.startsWith(ruleStem)) {
      return true;
    }
    /*
     * Обратное направление — когда stemWord срезал больше основы правила.
     * Допуск жёсткий (разница до двух символов, не короче пяти): иначе
     * «груди» совпадёт с «грудничк», и боль в груди станет детским запросом.
     */
    return ruleStem.startsWith(token) && token.length >= 5 && ruleStem.length - token.length <= 2;
  });

/**
 * @param {string} text исходный (или уже редактированный) текст пользователя
 * @returns {{
 *   emergency: null | {id: string},
 *   hasMedicalText: boolean,
 *   specialties: string[],
 *   confidence: number,
 *   isChild: boolean,
 *   matchedRules: string[]
 * }}
 */
export const classifySymptoms = (text) => {
  const normalized = normalizeRu(text);
  const tokens = normalized.split(' ').filter(Boolean).filter((token) => !NOT_A_COMPLAINT.test(token));
  const tokenStems = tokens.map((token) => stemWord(token));

  /*
   * Красные флаги сверяются и со «сжатой» строкой без односимвольных
   * предлогов: иначе «давит в груди» не совпадёт с «давит груд», а цена
   * пропуска здесь максимальна.
   */
  const compact = compactPhrase(normalized);
  const emergency = RED_FLAGS_NORMALIZED.find((flag) => matchesRedFlag(flag, normalized, compact));

  const scores = new Map();
  const matchedRules = [];

  for (const rule of PRECOMPILED) {
    const hits = rule.stems.filter((stem) => matchesStem(tokenStems, stem)).length;
    if (hits === 0) continue;

    matchedRules.push(rule.id);
    rule.specialties.forEach((specialty, position) => {
      const contribution = rule.weight * hits * (position === 0 ? 1 : 0.5);
      scores.set(specialty, (scores.get(specialty) || 0) + contribution);
    });
  }

  /*
   * Разговорные описания профиля: «к врачу по женским делам», «по мужской
   * части». Одно «женский» («женский врач») может быть о поле врача, поэтому
   * профилем считается только с «делам/части/проблемам».
   */
  for (const rule of PHRASE_RULES) {
    if (!rule.pattern.test(normalized)) continue;
    matchedRules.push(rule.id);
    scores.set(rule.specialty, (scores.get(rule.specialty) || 0) + 3);
  }

  const isChild = CHILD_NORMALIZED.some((stem) => matchesStem(tokenStems, stem));

  // Ребёнку профильный приём — у педиатра; терапевт остаётся запасным вариантом.
  if (isChild && scores.has('therapist')) {
    scores.set('pediatrician', (scores.get('therapist') || 0) + 0.5);
  }

  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const total = ranked.reduce((sum, [, score]) => sum + score, 0);
  const top = ranked[0]?.[1] || 0;

  const hasMedicalText =
    matchedRules.length > 0 ||
    hasMarker(normalized) ||
    Boolean(emergency);

  /*
   * Уверенность — из двух независимых величин:
   *   strength  — насколько специфичны сработавшие слова («зуб» против
   *               «слабость»); нормируется по весу лидера;
   *   dominance — насколько лидер оторвался от прочих кандидатов.
   * Единственное общее слово («слабость») даёт ~0.67 — ниже порога 0.7, и
   * Gateway уходит в fail-closed: лучше переспросить, чем угадать профиль.
   */
  const dominance = total > 0 ? top / total : 0;
  const strength = Math.min(1, top / 3);
  const confidence = Number((strength * (0.5 + 0.5 * dominance)).toFixed(3));

  /*
   * Два разных профиля с равным весом («болит голова и живот»): выбирать
   * одного — гадать. Тогда ответ ассистента спрашивает, к кому записаться.
   */
  const specialists = ranked.filter(([specialty]) => specialty !== 'therapist');
  const tied = specialists.length > 1 && specialists[0][1] === specialists[1][1]
    ? specialists.slice(0, 2).map(([specialty]) => specialty)
    : null;

  return {
    emergency: emergency ? { id: emergency.id } : null,
    hasMedicalText,
    specialties: ranked.slice(0, 3).map(([specialty]) => specialty),
    confidence,
    isChild,
    matchedRules,
    ...(tied ? { tied } : {}),
  };
};

export const SYMPTOM_RULE_IDS = Object.freeze(RULES.map((rule) => rule.id));
export const RED_FLAG_IDS = Object.freeze(RED_FLAGS.map((flag) => flag.id));
