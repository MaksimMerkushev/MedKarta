/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Поиск исследования на витрине «Лаборатории» (shared/labSearch.js): синонимы,
 * падеж, одна опечатка — на настоящем каталоге; срок готовности словами.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TESTS } from '../backend/labs/catalog.js';
import { describeTurnaround, searchLabTests } from '../shared/labSearch.js';

const codes = (query) => searchLabTests(TESTS, query).map((test) => test.code);

describe('Лаборатории: поиск исследования', () => {
  it('пустой запрос — весь каталог в прежнем порядке', () => {
    assert.deepEqual(codes(''), TESTS.map((test) => test.code));
    assert.deepEqual(codes('   '), TESTS.map((test) => test.code));
  });

  it('сокращения и бытовые названия из направлений — через синонимы', () => {
    assert.deepEqual(codes('ОАК').slice(0, 2), ['CBC_DIFF', 'CBC']);
    assert.equal(codes('оак')[0], 'CBC_DIFF');
    assert.equal(codes('сахар в крови')[0], 'GLUCOSE');
    assert.equal(codes('витамин д')[0], 'VITD');
    assert.equal(codes('ттг')[0], 'TSH');
    assert.equal(codes('АЛТ')[0], 'ALT');
    assert.equal(codes('hba1c')[0], 'HBA1C');
  });

  it('регистр, «ё», знаки, начало слова и падеж не мешают', () => {
    assert.equal(codes('ФЕРРИТИН')[0], 'FERRITIN');
    assert.equal(codes('печёночные')[0], 'LIVER_PANEL');
    assert.equal(codes('25-OH')[0], 'VITD');
    assert.equal(codes('ферр')[0], 'FERRITIN');
    assert.ok(codes('моча').includes('URINE_GENERAL'));
  });

  it('одна опечатка в длинном слове прощается, в коротком — нет', () => {
    assert.equal(codes('ферритинн')[0], 'FERRITIN');
    assert.equal(codes('ферретин')[0], 'FERRITIN');
    assert.equal(codes('феритин')[0], 'FERRITIN');
    assert.equal(codes('фреритин')[0], 'FERRITIN');
    // В трёхбуквенном сокращении одна буква — уже другое исследование.
    assert.ok(!codes('оаг').includes('CBC_DIFF'));
  });

  it('точное совпадение выше частичного; чужое — не находится', () => {
    assert.equal(codes('холестерин')[0], 'CHOLESTEROL');
    assert.deepEqual(codes('qwerty'), []);
    assert.deepEqual(searchLabTests(null, 'оак'), []);
  });

  it('каталог без синонимов (страница лаборатории до обновления) ищется по названию', () => {
    const plain = TESTS.map(({ code, name }) => ({ code, name }));
    assert.equal(searchLabTests(plain, 'ферритин')[0].code, 'FERRITIN');
    assert.deepEqual(searchLabTests(plain, 'оак'), []);
  });
});

describe('Лаборатории: срок готовности словами — общий для подбора и диалога записи', () => {
  it('30 часов — «через 1 день», как в карточке подбора, а не «через 2 дня»', () => {
    assert.equal(describeTurnaround(30), 'через 1 день');
    assert.equal(describeTurnaround(6), 'в день сдачи');
    assert.equal(describeTurnaround(0), null);
    assert.equal(describeTurnaround(Number.NaN), null);
    assert.equal(describeTurnaround(24 * 11), 'через 11 дней');
    assert.equal(describeTurnaround(24 * 21), 'через 21 день');
  });
});
