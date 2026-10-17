/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Замена чувствительных фрагментов на session-токены. Работает по исходным
 * индексам строки (к ним приводят границы детекторы и entity resolver); замена
 * идёт справа налево, чтобы подстановка не сдвигала ещё не обработанные спаны.
 *
 * Одинаковые сущности в одном запросе получают один токен: модель должна
 * видеть, что дважды упомянутая «Петрова» — один человек, иначе план
 * бессмыслен. Между запросами и сессиями токены различаются (tokenVault.js).
 */

import { normalizeRu, ruPattern } from './normalize.js';
import { ENTITY_KIND, isCommonAdjective } from './detectors.js';
import { looksLikePatronymic, looksLikeSurname } from './morphology.js';

/**
 * Значащие символы — буквы и цифры. Доля редактуры считается по ним: по сырой
 * длине «Г.а.л.я.в.и.ч.у» весит почти вдвое больше фамилии, и запрос уходит в
 * fail-closed из-за манеры набора, хотя фамилия уже заменена токеном.
 */
export const countContentChars = (value) =>
  (String(value || '').match(/[\p{L}\p{N}]/gu) || []).length;

/**
 * Ключ одинаковости: для врачей и клиник — id из справочника («Петрову» и
 * «Петров» дают один ключ), для остальных — нормализованный текст.
 */
const identityOf = (entity, text) => {
  if (Array.isArray(entity.ids) && entity.ids.length > 0) {
    return `${entity.kind}:${[...entity.ids].sort().join(',')}`;
  }
  return `${entity.kind}:${normalizeRu(text.slice(entity.start, entity.end))}`;
};

/**
 * Снимает перекрытия между спанами детекторов и ссылками на справочник.
 * Ссылка точнее и несёт id для исполнения плана, поэтому забирает вид (кроме
 * адреса, см. ниже), но границы — объединение: иначе в «Меня зовут Иван
 * Петров» фамилия из справочника вытеснит спан ФИО, и «Иван» уйдёт наружу.
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
       * Адрес с номером дома сильнее совпадения со справочником внутри него:
       * «от улица Декабристов дом три» — откуда едет пользователь, а не
       * «Медцентр на Декабристов» как первый шаг маршрута.
       */
      if (previous.kind === ENTITY_KIND.ADDRESS || entity.kind === ENTITY_KIND.ADDRESS) {
        const address = previous.kind === ENTITY_KIND.ADDRESS ? previous : entity;
        result[result.length - 1] = {
          ...address,
          start: Math.min(entity.start, previous.start),
          end: Math.max(entity.end, previous.end),
        };
      } else if (entity.priority > previous.priority) {
        result[result.length - 1] = {
          ...entity,
          start: Math.min(entity.start, previous.start),
          end: Math.max(entity.end, previous.end),
        };
      } else if (entity.end > previous.end) {
        /*
         * Более слабая сущность, заходящая дальше, тоже расширяет границы:
         * иначе в «маму шарапову марию петровну» ссылка на врача по фамилии
         * оставит имя и отчество открытыми.
         */
        result[result.length - 1] = { ...previous, end: entity.end };
      }
      continue;
    }
    result.push(entity);
  }

  return result;
};

/**
 * Слова с морфологией фамилии или отчества, оставшиеся после редактуры:
 * «не нашли — не значит, что нет», такой текст наружу не уходит (policies.js).
 */
export const countResidualNameLike = (redactedText, ignore = new Set()) => {
  const words = redactedText.match(/\p{Lu}\p{L}{2,}/gu) || [];
  return words.filter(
    (word) => !ignore.has(word)
      && ((looksLikeSurname(word) && !isCommonAdjective(word)) || looksLikePatronymic(word)),
  ).length;
};

/**
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
    redactedChars += countContentChars(text.slice(entity.start, entity.end));
    redacted = `${redacted.slice(0, entity.start)}${token}${redacted.slice(entity.end)}`;
  }

  return { redacted: redacted.replace(/\s{2,}/g, ' ').trim(), used, redactedChars };
};

/**
 * Семантические плейсхолдеры для мест пользователя: координаты и адрес дома
 * не покидают контур, наружу уходит смысл («дом», «текущее местоположение»).
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

/** Бытовые указания на места («домой», «от меня») → семантические токены. */
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
