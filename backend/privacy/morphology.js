/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Лёгкая морфология для детектора ФИО: «к Петрову» должно совпасть со справочным
 * «Петров», иначе фамилия уйдёт во внешнюю LLM. Не лемматизатор: ошибается в сторону
 * лишнего усечения — ложная редакция лучше утечки ФИО.
 */

import { normalizeRu } from './normalize.js';

/**
 * Окончания фамилий по падежам. Порядок важен: длинные раньше коротких,
 * иначе «петровского» усечётся по «-ого» до «петровск», а не по «-ского» до «петров».
 */
const SURNAME_ENDINGS = [
  'овскими', 'евскими', 'инскими',
  'ovскому',
  'ескому', 'ескими',
  'ского', 'скому', 'скими', 'ской', 'скую', 'ская', 'ские', 'ских', 'ским', 'ском', 'ский',
  'цкого', 'цкому', 'цкими', 'цкой', 'цкую', 'цкая', 'цкие', 'цких', 'цким', 'цком', 'цкий',
  'ыми', 'ого', 'ому', 'ему',
  'ева', 'еву', 'евы', 'евых', 'евым', 'евой', 'еве', 'евe',
  'ова', 'ову', 'овы', 'овых', 'овым', 'овой', 'ове',
  'ина', 'ину', 'ины', 'иных', 'иным', 'иной', 'ине',
  'ына', 'ыну', 'ыны', 'ыных', 'ыным', 'ыной', 'ыне',
  'ым', 'ом', 'ем', 'ой', 'ей', 'ах', 'ям', 'ух', 'юх', 'ий', 'ый', 'ая', 'ую',
  'а', 'у', 'е', 'ы', 'и', 'ю', 'я',
];

/** Окончания нарицательных: «стоматологу» → «стоматолог». */
const NOUN_ENDINGS = [
  'иями', 'ями', 'ами', 'ому', 'его', 'ему', 'ыми', 'ими',
  'ией', 'иях', 'ия', 'ии', 'ие', 'ию',
  'ов', 'ев', 'ам', 'ах', 'ям', 'ях', 'ой', 'ей', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее',
  'ом', 'ем', 'ум', 'ым', 'им', 'ут', 'ют',
  'а', 'у', 'е', 'ы', 'и', 'о', 'ю', 'я', 'ь', 'й',
];

/** Фамилии на эти окончания не склоняются — трогать их нельзя. */
const INDECLINABLE_SUFFIXES = ['енко', 'ко', 'ых', 'их', 'аго', 'яго', 'ово', 'иа', 'уа'];

const MIN_STEM_LENGTH = 3;

const stripBySuffixList = (word, endings, minLength) => {
  for (const ending of endings) {
    if (word.length - ending.length >= minLength && word.endsWith(ending)) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return word;
};

/**
 * Основа фамилии, инвариантная к падежу: Петрова / Петрову / Петровым → «петров».
 *
 * @param {string} word
 * @returns {string} основа в нижнем регистре либо '' для мусора
 */
export const stemSurname = (word) => {
  const normalized = normalizeRu(word);
  if (normalized.length < MIN_STEM_LENGTH) {
    return normalized;
  }

  if (INDECLINABLE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return normalized;
  }

  // Продуктивные модели: основа на -ов/-ев/-ёв/-ин/-ын.
  const productive = normalized.match(/^(.*?(?:ов|ев|ёв|ин|ын))(?:а|у|ы|е|ым|ом|ой|ей|ых|ым|ыми|ами)?$/u);
  if (productive && productive[1].length >= MIN_STEM_LENGTH) {
    return productive[1];
  }

  // -ский/-цкий: основа без родового окончания.
  const adjectival = normalized.match(/^(.*?(?:ск|цк))(?:ий|ого|ому|им|ом|ая|ой|ую|ие|их|ими)$/u);
  if (adjectival && adjectival[1].length >= MIN_STEM_LENGTH) {
    return adjectival[1];
  }

  return stripBySuffixList(normalized, SURNAME_ENDINGS, MIN_STEM_LENGTH);
};

/** Основа нарицательного слова (специальности, услуги, клиники): «стоматологу» → «стоматолог». */
export const stemWord = (word) => {
  const normalized = normalizeRu(word);
  if (normalized.length <= 4) {
    return normalized;
  }
  return stripBySuffixList(normalized, NOUN_ENDINGS, 4);
};

export const stemPhrase = (value, stemmer = stemWord) =>
  normalizeRu(value)
    .split(' ')
    .filter(Boolean)
    .map((word) => stemmer(word));

/** Отчество — сильный признак того, что рядом стоит ФИО. */
export const looksLikePatronymic = (word) =>
  // Все падежи: «Петрович/Петровича/Петровичем», «Петровна/Петровну/Петровной».
  /^[а-яё]{3,}(?:(?:ович|евич|ьич)(?:а|у|ем|е|ом)?|(?:овн|евн|ичн|иничн)(?:а|ы|е|у|ой|ою))$/u.test(normalizeRu(word));

export const looksLikeSurname = (word) => {
  const normalized = normalizeRu(word);
  if (normalized.length < 4) {
    return false;
  }
  return /(?:ов|ев|ёв|ин|ын|ский|цкий|ская|цкая|ich|ич|ук|юк|енко|швили|ян|оглы)[ауеыхмйои]{0,3}$/u.test(
    normalized,
  );
};
