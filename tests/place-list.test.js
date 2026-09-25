/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Список врачей в одной точке карты (frontend/src/placeList.js).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPlaceList,
  fromLatinLayout,
  highlightParts,
  normalizeQuery,
  specialtyOf,
} from '../frontend/src/placeList.js';

const doctor = (id, name, specialty, extra = {}) => ({ id, name, specialty, doctorProfile: specialty, entityKind: 'doctor', ...extra });

const ITEMS = [
  doctor('1', 'Петров Иван Сергеевич', 'Кардиолог'),
  doctor('2', 'Алексеева Мария Петровна', 'Кардиолог'),
  doctor('3', 'Петрова Анна Ильинична', 'Хирург', { department: 'Отделение торакальной хирургии' }),
  doctor('4', 'Сёмин Олег Юрьевич', 'Невролог'),
  doctor('5', 'Борисов Артём Павлович', 'Хирург', { isFavorite: true }),
  doctor('6', 'Яковлев Пётр Андреевич', 'Кардиолог', { isRouteTarget: true, routeIndex: 1 }),
  { id: 'f', name: 'ГАУЗ РКБ', specialty: 'Больница', entityKind: 'facility' },
];

const names = (result) => result.sections.flatMap((section) => section.items.map((item) => item.id));

describe('Список врачей в точке карты', () => {
  it('без запроса: маршрут и избранное наверху, дальше учреждение и специальности по алфавиту', () => {
    const result = buildPlaceList(ITEMS);
    assert.deepEqual(result.sections.map((section) => section.title), [
      'В маршруте', 'Избранные', 'Учреждение', 'Кардиолог', 'Невролог', 'Хирург',
    ]);
    assert.equal(result.shown, 7);
    // Внутри специальности — по алфавиту.
    assert.deepEqual(result.sections[3].items.map((item) => item.id), ['2', '1']);
    // Закреплённые не дублируются в своих специальностях.
    assert.equal(new Set(names(result)).size, names(result).length);
  });

  it('ищет по нескольким словам сразу, без учёта регистра и «ё»', () => {
    assert.deepEqual(names(buildPlaceList(ITEMS, { query: 'кардиолог петр' })).sort(), ['1', '2', '6']);
    assert.deepEqual(names(buildPlaceList(ITEMS, { query: 'СЕМИН' })), ['4']);
    assert.deepEqual(names(buildPlaceList(ITEMS, { query: 'пётр' })).sort(), ['1', '2', '3', '6']);
  });

  it('ищет по отделению и должности', () => {
    assert.deepEqual(names(buildPlaceList(ITEMS, { query: 'торакальн' })), ['3']);
  });

  it('понимает запрос в английской раскладке', () => {
    const result = buildPlaceList(ITEMS, { query: 'ytdhjkju' });
    assert.equal(result.layoutQuery, 'невролог');
    assert.deepEqual(names(result), ['4']);
    assert.equal(fromLatinLayout('rfhlbjkju'), 'кардиолог');
  });

  it('фильтр по специальности; числа на фильтрах учитывают запрос', () => {
    const result = buildPlaceList(ITEMS, { query: 'петр', specialty: 'Хирург' });
    assert.deepEqual(names(result), ['3']);
    assert.deepEqual(result.chips, [
      { specialty: 'Кардиолог', count: 3 },
      { specialty: 'Хирург', count: 1 },
    ]);
  });

  it('фильтры отсортированы по числу врачей, учреждения в них не попадают', () => {
    const chips = buildPlaceList(ITEMS).chips;
    assert.deepEqual(chips.map((chip) => chip.specialty), ['Кардиолог', 'Хирург', 'Невролог']);
    assert.equal(specialtyOf(ITEMS[6]), null);
  });

  it('пустой результат не падает', () => {
    const result = buildPlaceList(ITEMS, { query: 'несуществующий' });
    assert.equal(result.shown, 0);
    assert.deepEqual(result.sections, []);
  });

  it('подсвечивает совпадения, сохраняя исходное написание', () => {
    assert.deepEqual(highlightParts('Сёмин Олег', ['семин']), [
      { text: 'Сёмин', match: true },
      { text: ' Олег', match: false },
    ]);
    assert.deepEqual(highlightParts('Петров Пётр', ['петр']), [
      { text: 'Петр', match: true },
      { text: 'ов ', match: false },
      { text: 'Пётр', match: true },
    ]);
    assert.deepEqual(highlightParts('Иванов', []), [{ text: 'Иванов', match: false }]);
  });

  it('на 320 врачах укладывается в миллисекунды', () => {
    const many = Array.from({ length: 320 }, (_, i) =>
      doctor(String(i), `Фамилия${i} Имя Отчество`, ['Хирург', 'Педиатр', 'Кардиолог', 'Невролог'][i % 4]));
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) buildPlaceList(many, { query: 'фамилия1' });
    const perCall = (performance.now() - started) / 50;
    assert.ok(perCall < 5, `${perCall.toFixed(2)} мс на пересчёт`);
    assert.equal(normalizeQuery('  Ёж   Ёлка '), 'еж елка');
  });
});
