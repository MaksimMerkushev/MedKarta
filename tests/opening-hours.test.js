/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Часы работы из OpenStreetMap (shared/openingHours.js).
 *
 * Регрессия: импорт закрывал субботу и воскресенье у 293 из 327 учреждений
 * с часами, в том числе у «Mo-Su» и круглосуточного травмпункта.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseOpeningHours } from '../shared/openingHours.js';
import { kazanFacilities } from '../data/facilities.js';

describe('Часы работы OSM', () => {
  it('Mo-Su — каждый день, включая выходные', () => {
    const schedule = parseOpeningHours('Mo-Su 08:00-20:00');
    assert.equal(schedule.sat, '08:00-20:00');
    assert.equal(schedule.sun, '08:00-20:00');
  });

  it('несколько правил, выходной и диапазон через воскресенье', () => {
    assert.deepEqual(parseOpeningHours('Mo-Fr 08:00-20:00; Sa 09:00-15:00; Su off'), {
      mon: '08:00-20:00', tue: '08:00-20:00', wed: '08:00-20:00', thu: '08:00-20:00',
      fri: '08:00-20:00', sat: '09:00-15:00', sun: 'Выходной',
    });
    assert.equal(parseOpeningHours('Sa-Mo 10:00-12:00').tue, 'Выходной');
    assert.equal(parseOpeningHours('Sa-Mo 10:00-12:00').sun, '10:00-12:00');
  });

  it('списки дней, правила через запятую, праздники и комментарии', () => {
    const schedule = parseOpeningHours('Mo,We,Fr 09:00-18:00; Tu,Th 10:00-19:00');
    assert.equal(schedule.we, undefined);
    assert.equal(schedule.wed, '09:00-18:00');
    assert.equal(schedule.thu, '10:00-19:00');
    assert.equal(parseOpeningHours('Mo-Fr 08:00-18:00, Sa 08:00-13:00').sat, '08:00-13:00');
    assert.equal(parseOpeningHours('Mo-Fr 08:00-20:00; PH 09:00-17:00').sat, 'Выходной');
    assert.equal(parseOpeningHours('Mo-Fr 08:00-17:00 || "Sa by appointment"').fri, '08:00-17:00');
  });

  it('24/7 и часы без дней', () => {
    assert.equal(parseOpeningHours('24/7').sun, '00:00-00:00');
    assert.equal(parseOpeningHours('09:00-21:00').sat, '09:00-21:00');
  });

  it('непонятная запись не выдумывает расписание', () => {
    assert.equal(parseOpeningHours('by appointment'), null);
    assert.equal(parseOpeningHours(''), null);
    assert.equal(parseOpeningHours('Mo-Fr утром'), null);
  });

  it('разбирает почти все часы справочника', () => {
    const withHours = kazanFacilities.filter((item) => item.hours && item.hours !== 'График не указан');
    const unparsed = withHours.filter((item) => !parseOpeningHours(item.hours));
    assert.ok(unparsed.length <= 2, `не разобрано: ${unparsed.map((item) => item.hours).join(' | ')}`);
  });
});
