/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Замена чувствительных фрагментов на session-токены.
 *
 * Модуль работает по ИСХОДНЫМ индексам строки: детекторы и entity resolver
 * возвращают границы, приведённые к оригиналу, а замена идёт справа налево,
 * чтобы каждая подстановка не сдвигала границы ещё не обработанных спанов.
 *
 * Одинаковые сущности внутри одного запроса получают ОДИН токен: если
 * «Петрову» встречается дважды, внешняя модель должна видеть, что это один
 * и тот же человек, иначе план окажется бессмысленным. Между запросами и
 * сессиями токены различаются (см. storage/tokenVault.js).
 */

import { normalizeRu, ruPattern } from './normalize.js';
import { ENTITY_KIND } from './detectors.js';
import { looksLikePatronymic, looksLikeSurname } from './morphology.js';

/**
 * Ключ «одинаковости» сущности.
 * Для врачей и клиник это список id из справочника — две разные формы
 * («Петрову», «Петров») дают один ключ. Для остальных — нормализованный текст.
 */
/**
 * Значащие символы: буквы и цифры, без пробелов и пунктуации.
 *
 * Доля редактуры должна отражать, какую часть СОДЕРЖАНИЯ составляли
 * персональные данные. Если считать сырую длину, «Г.а.л.я.в.и.ч.у» весит
 * впятеро больше самой фамилии, доля пробивает порог и запрос уходит
 * в fail-closed из-за манеры набора, хотя утечки нет — фамилия уже заменена.
 */
export const countContentChars = (value) =>
  (String(value || '').match(/[\p{L}\p{N}]/gu) || []).length;

const identityOf = (entity, text) => {
  if (Array.isArray(entity.ids) && entity.ids.length > 0) {
    return `${entity.kind}:${[...entity.ids].sort().join(',')}`;
  }
  return `${entity.kind}:${normalizeRu(text.slice(entity.start, entity.end))}`;
};

/**
 * Снимает перекрытия между спанами детекторов и ссылками на справочник.
 * Ссылка на справочник ВСЕГДА побеждает эвристику ФИО: она точнее и несёт
 * id для последующего исполнения плана.
 */
export const reconcileEntities = (detectorSpans, catalogLinks) => {
  const all = [
    ...catalogLinks.map((link) => ({ ...link, priority: 2 })),
    ...detectorSpans.map((span) => ({ ...span, priority: 1 })),
  ].sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return right.end - left.end;
  });

  const result = [];
  for (const entity of all) {
    const previous = result[result.length - 1];
    if (previous && entity.start < previous.end) {
      /*
       * Ссылка на каталог точнее эвристики ФИО и забирает вид и id, НО
       * границы берутся объединением. Без объединения «Меня зовут Иван
       * Петров» редактировалось только по фамилии — она совпала со
       * справочником и вытеснила более широкий спан ФИО, — и имя «Иван»
       * уходило во внешнюю модель открытым текстом.
       */
      if (entity.priority > previous.priority) {
        result[result.length - 1] = {
          ...entity,
          start: Math.min(entity.start, previous.start),
          end: Math.max(entity.end, previous.end),
        };
      } else if (entity.end > previous.end && entity.priority === previous.priority) {
        result[result.length - 1] = { ...previous, end: entity.end };
      }
      continue;
    }
    result.push(entity);
  }

  return result;
};

/**
 * Считает слова, похожие на имя, которые ОСТАЛИСЬ в тексте после редактуры.
 *
 * Это и есть реализация принципа «не нашли — не значит, что нет»: остаточное
 * имя делает текст непригодным для отправки наружу (см. policies.js).
 */
export const countResidualNameLike = (redactedText) => {
  const words = redactedText.match(/\p{Lu}\p{L}{2,}/gu) || [];
  return words.filter((word) => looksLikeSurname(word) || looksLikePatronymic(word)).length;
};

/**
 * Выполняет редактуру одного текста.
 *
 * @param {object} params
 * @param {string} params.text исходный текст
 * @param {Array} params.entities сущности с полями {kind, start, end, ids?}
 * @param {(entity: object, identity: string) => Promise<string>} params.allocate
 *        функция выдачи токена; вызывается один раз на уникальную сущность
 * @returns {Promise<{redacted: string, used: Array, redactedChars: number}>}
 */
export const redactText = async ({ text, entities, allocate }) => {
  const ordered = [...entities].sort((left, right) => left.start - right.start);
  const identities = new Map();
  const used = [];
  let redactedChars = 0;

  for (const entity of ordered) {
    const identity = identityOf(entity, text);
    if (!identities.has(identity)) {
      const token = await allocate(entity, identity);
      identities.set(identity, token);
      used.push({ token, kind: entity.kind, identity });
    }
  }

  let redacted = text;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const entity = ordered[index];
    const token = identities.get(identityOf(entity, text));
    /*
     * Считаются ЗНАЧАЩИЕ символы, без пробелов. Иначе «Г а л я в и ч у»
     * весит пятнадцать символов вместо восьми, доля редактуры вырастает
     * вдвое и запрос уходит в fail-closed только из-за манеры набора —
     * при том что фамилия уже заменена токеном и утечки нет.
     */
    redactedChars += countContentChars(text.slice(entity.start, entity.end));
    redacted = `${redacted.slice(0, entity.start)}${token}${redacted.slice(entity.end)}`;
  }

  return { redacted: redacted.replace(/\s{2,}/g, ' ').trim(), used, redactedChars };
};

/**
 * Семантические плейсхолдеры для мест пользователя.
 * Координаты и адрес дома НИКОГДА не покидают контур: наружу уходит смысл
 * («дом», «текущее местоположение»), а не значение.
 */
export const LOCATION_TOKENS = Object.freeze({
  HOME: '@HOME',
  CURRENT: '@CURRENT_LOCATION',
  WORK: '@WORK',
});

const HOME_PATTERNS = [
  ruPattern('домо?й'),
  ruPattern('дома'),
  /(?<![\p{L}\p{N}])к\s+себе\s+домой(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])мой\s+дом(?![\p{L}\p{N}])/iu,
];

const CURRENT_PATTERNS = [
  /(?<![\p{L}\p{N}])рядом\s+со?\s+мной(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])от\s+меня(?![\p{L}\p{N}])/iu,
  ruPattern('поблизости'),
  /(?<![\p{L}\p{N}])где\s+я\s+сейчас(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])мо[её]\s+местоположени\p{L}*/iu,
];

const WORK_PATTERNS = [
  /(?<![\p{L}\p{N}])на\s+работу(?![\p{L}\p{N}])/iu,
  /(?<![\p{L}\p{N}])с\s+работы(?![\p{L}\p{N}])/iu,
  ruPattern('офис\\p{L}*'),
];

/**
 * Заменяет бытовые указания на места семантическими токенами.
 * Возвращает и текст, и список использованных токенов.
 */
export const tokenizeLocations = (text) => {
  let output = text;
  const tokens = new Set();

  const apply = (patterns, token) => {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      if (regex.test(output)) {
        output = output.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), token);
        tokens.add(token);
      }
    }
  };

  apply(HOME_PATTERNS, LOCATION_TOKENS.HOME);
  apply(CURRENT_PATTERNS, LOCATION_TOKENS.CURRENT);
  apply(WORK_PATTERNS, LOCATION_TOKENS.WORK);

  return { text: output, tokens: [...tokens] };
};

export { ENTITY_KIND };
