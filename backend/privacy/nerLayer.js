/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный ML-слой Privacy Gateway (флаг PII_NER, по умолчанию выключен).
 *
 * Работает ПОСЛЕ правил, на уже очищенных репликах жалобы: правила и модель не спорят
 * о том, пропустить ли текст, — найденное любым из них маскируется (объединение). Модель
 * не может вернуть значение назад: метки правил не трогаются, исходный текст сюда не
 * приходит. Ошибка модели — исключение, и жалоба наружу не уходит.
 *
 * Это снижение риска, а не обезличивание в юридическом смысле: модель видит имена,
 * организации и места, но не косвенные признаки (возраст, профессия, редкие обстоятельства).
 */
export const NER_LABEL = Object.freeze({ PER: '[имя]', ORG: '[организация]', MEDIA: '[организация]', LOC: '[место]', GEOPOLIT: '[место]' });
const PRIORITY = { PER: 3, ORG: 2, MEDIA: 2, LOC: 1, GEOPOLIT: 1 };

/*
 * Слова, которые идентификатором не бывают, а модель иногда отмечает: местоимения и
 * приветствия в начале фразы, частые слова жалобы с заглавной. Сравнение — по слову
 * целиком: «Кашлев» не совпадёт с «кашель».
 */
const NEVER_IDENTIFIER = new Set([
  'я', 'мы', 'ты', 'вы', 'он', 'она', 'они', 'это', 'меня', 'мне', 'мой', 'моя', 'мое', 'мои', 'нас', 'нам', 'зовут',
  'здравствуйте', 'привет', 'добрый', 'день', 'вечер', 'утро', 'спасибо', 'пожалуйста', 'реплики', 'пользователя',
  'болит', 'болят', 'болела', 'болел', 'тошнит', 'давит', 'колет', 'ноет', 'кружится', 'температура', 'давление', 'сыпь', 'кашель', 'насморк',
  'нечипоренко', 'манту', 'зимницкому', 'зимницкого', 'квинке', 'хашимото', 'рейно',
  // Город сервиса: только формы самого слова — «Казаньоргсинтез» под это не попадает.
  'казань', 'казани', 'казанью',
]);
/* Медицинские эпонимы в любом падеже: «болезнь Бехтерева», «у папы Паркинсон». */
const EPONYM = /^(?:паркинсон|альцгеймер|бехтерев|крон|меньер|боткин)(?:а|у|ом|е|ым)?$/u;
const LABEL = /\[[^[\]\n]{1,40}\]/gu;
const GLUE = /^[\s\-«»"„“']*$/u;
const norm = (value) => value.toLowerCase().replace(/ё/gu, 'е');
const neverIdentifier = (value) => {
  const words = norm(value).match(/[\p{L}\p{N}]+/gu) || [];
  return words.length === 0 || words.every((word) => NEVER_IDENTIFIER.has(word) || EPONYM.test(word));
};

/**
 * Замаскировать найденные моделью фрагменты в уже очищенном правилами тексте.
 * Перекрытия объединяются; диапазон, задевший метку правил, расширяется до неё.
 * @returns {{text: string, masked: number}}
 */
export const applyEntities = (text, entities) => {
  const labels = [...text.matchAll(LABEL)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const ranges = [];
  for (const entity of entities) {
    let { start, end } = entity;
    // Края без букв и цифр («ООО «») не маскируются.
    while (start < end && !/[\p{L}\p{N}]/u.test(text[start])) start += 1;
    while (end > start && !/[\p{L}\p{N}]/u.test(text[end - 1])) end -= 1;
    if (start >= end) continue;
    if (labels.some((label) => label.start <= start && end <= label.end)) continue;
    for (const label of labels) {
      if (label.start < end && start < label.end) { start = Math.min(start, label.start); end = Math.max(end, label.end); }
    }
    // Метка правил, приклеенная дефисом («[имя]-Вандербильт», «Вандербильт-[имя]»), — то же имя.
    for (const label of labels) {
      if (label.end <= start && /^-$/u.test(text.slice(label.end, start))) start = label.start;
      if (label.start >= end && /^-$/u.test(text.slice(end, label.start))) end = label.end;
    }
    if (neverIdentifier(text.slice(start, end).replace(LABEL, ' '))) continue;
    ranges.push({ start, end, type: entity.type });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    // Соседние фрагменты через пробел, дефис или кавычку — одна сущность («ООО «Ромашка»»).
    if (last && (range.start <= last.end || GLUE.test(text.slice(last.end, range.start)))) {
      last.end = Math.max(last.end, range.end);
      if (PRIORITY[range.type] > PRIORITY[last.type]) last.type = range.type;
    } else {
      merged.push({ ...range });
    }
  }
  let result = text;
  for (const range of [...merged].reverse()) result = `${result.slice(0, range.start)}${NER_LABEL[range.type]}${result.slice(range.end)}`;
  return { text: result, masked: merged.length };
};

/** Что модель видит в тексте помимо меток и заведомо безопасных слов (для финальной проверки). */
export const residualEntities = (text, entities) => applyEntities(text, entities).masked > 0
  ? entities.filter((entity) => applyEntities(text, [entity]).masked > 0).map((entity) => entity.type)
  : [];

export const createNerLayer = ({ client, logger = null, metrics = null }) => {
  const maskTurns = async (turns) => {
    const result = [];
    let masked = 0;
    for (const turn of turns) {
      const applied = applyEntities(turn, await client.entities(turn));
      masked += applied.masked;
      result.push(applied.text);
    }
    metrics?.increment('ner.masked', { status: masked > 0 ? 'found' : 'none' });
    logger?.event?.('ner.applied', { count: masked });
    return result;
  };
  const residual = async (text) => residualEntities(text, await client.entities(text));
  return Object.freeze({ maskTurns, residual });
};
