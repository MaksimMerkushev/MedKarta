/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Роли частей реплики и обезличивание: что считается условием записи и что уходит модели.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deidentifyComplaint, hasRareCircumstance, hasSensitiveCondition } from '../backend/privacy/deidentify.js';
import { extractBookingConstraints } from '../backend/privacy/bookingConstraints.js';
import { extractConstraints } from '../backend/privacy/gateway.js';
import { bookingView, expandCorrections, isExplicitRequest, segmentTurn } from '../backend/understanding/turnRoles.js';

// Оба извлекателя условий, как в обработке реплики: дата и район в одном, время и цена в другом.
const booking = (text) => {
  const view = bookingView(text);
  return { ...extractConstraints(view), ...extractBookingConstraints(view) };
};
const TIME_FIELDS = ['availableAfter', 'availableBefore', 'timeOfDay', 'evening', 'timeExact', 'timeAround', 'spokenAfter', 'busyUntil'];

describe('Роли частей реплики', () => {
  for (const text of ['С утра тошнит, болит живот', 'Вечером поднимается температура', 'После 18:00 поднимается давление', 'До обеда кружится голова', 'Болит живот с утра и до вечера', 'Ночью сильно болит зуб']) {
    it(`время симптома не становится временем приёма: «${text}»`, () => {
      const result = booking(text);
      for (const field of TIME_FIELDS) assert.ok(!result[field], `${field}: ${JSON.stringify(result[field])}`);
    });
  }

  for (const text of ['В понедельник заболело горло', 'Со вторника болит ухо', 'Вчера упал, болит рука']) {
    it(`начало симптома не становится днём записи: «${text}»`, () => {
      assert.equal(booking(text).date ?? null, null);
    });
  }

  it('условия записи рядом с жалобой сохраняются', () => {
    assert.equal(booking('Болит горло, завтра после 18').date?.kind, 'tomorrow');
    assert.equal(booking('Болит горло, завтра после 18').availableAfter, '18:00');
    assert.equal(booking('Ночью сильно болит зуб, запишите на завтра утром').date?.kind, 'tomorrow');
    assert.equal(booking('Болит ухо по ДМС').dms, true);
    assert.equal(booking('Болит ухо, до 2500 рублей').maxPrice, 2500);
  });

  for (const text of ['Я работаю учителем в Авиастроительном районе', 'Завуч школы № 12 в Авиастроительном районе', 'Учусь в институте в Советском районе']) {
    it(`рассказ о себе не становится местом поиска: «${text}»`, () => {
      assert.deepEqual(booking(text).districts ?? [], []);
    });
  }

  it('место поиска, сказанное прямо, остаётся', () => {
    assert.ok(booking('Нужен лор в Авиастроительном районе').districts?.length > 0);
    assert.equal(booking('Хочу врача рядом с работой').originHint, 'work');
  });

  it('смены на работе остаются условием, а не местом', () => {
    const result = booking('Работаю в центре до 18:00');
    assert.deepEqual(result.districts ?? [], []);
    assert.equal(result.spokenAfter, '18:00');
    assert.equal(result.busyUntil, true);
    assert.ok(extractBookingConstraints(bookingView('я работаю посменно: в понедельник до 15')).date);
  });

  for (const text of ['Вчера вечером заболел зуб, сегодня сильнее', 'Две недели шумит в ушах после 6 вечера', 'Я водитель, езжу через Ново-Савиновский район, болит спина', 'На выходных простудился, кашель', 'К ночи поднимается температура, утром нормально']) {
    it(`рассказ о симптоме или поездке не становится условием: «${text}»`, () => {
      const result = booking(text);
      for (const field of [...TIME_FIELDS, 'date']) assert.ok(!result[field], `${field}: ${JSON.stringify(result[field])}`);
      assert.deepEqual(result.districts ?? [], []);
    });
  }

  it('настоящие условия рядом с такими словами остаются', () => {
    assert.equal(booking('а есть кто-то после 18').availableAfter, '18:00');
    assert.equal(booking('окулист на выходных').date ? true : Boolean(booking('окулист на выходных').weekend), true);
  });

  it('отказ после условия снимает его, а снятие «не важно» одно на цену, район и время', () => {
    assert.ok(!booking('утром не смогу, давайте вечером').timeOfDay);
    assert.equal(booking('утром не болит').timeOfDay ?? null, null);
    assert.equal(extractBookingConstraints('цена любая').maxPrice, null);
    assert.equal(extractBookingConstraints('бюджет не важен').maxPrice, null);
    assert.equal(extractBookingConstraints('район неважно').districtAny, true);
    assert.equal(extractBookingConstraints('время без разницы').timeAny, true);
  });

  it('прямо названное условие отличается от рассказа', () => {
    assert.equal(isExplicitRequest('Сыпь на руках и сильно чешется, рядом с Кремлём, сегодня вечером', 'сегодня вечером'), true);
    assert.equal(isExplicitRequest('Нужен лор завтра после 18', 'завтра после 18'), true);
    assert.equal(isExplicitRequest('Вчера вечером заболел зуб, сегодня сильнее', 'сегодня'), false);
    assert.equal(isExplicitRequest('Завтра экзамен, а горло совсем пропало', 'Завтра экзамен'), false);
    assert.equal(isExplicitRequest('Две недели шумит в ушах после 6 вечера', 'после 6 вечера'), false);
    assert.equal(isExplicitRequest('Я работаю учителем в Авиастроительном районе', 'в Авиастроительном районе'), false);
  });

  it('роли видны по частям', () => {
    assert.deepEqual(segmentTurn('Работаю на заводе, болит спина, нужен врач завтра').map((part) => part.role), ['biography', 'complaint', 'request']);
  });

  it('модель может снять условие, указав фрагмент', () => {
    assert.equal(extractBookingConstraints(bookingView('Лор завтра', { blanks: ['завтра'] })).date ?? null, null);
  });

  it('исправление внутри реплики — как две реплики', () => {
    const turns = expandCorrections([{ role: 'user', content: 'Нужен кардиолог завтра после 18:00. Хотя нет, болит колено' }]);
    assert.deepEqual(turns.map((turn) => turn.content), ['Нужен кардиолог завтра после 18:00', 'болит колено']);
    assert.equal(expandCorrections([{ role: 'user', content: 'Хотя нет' }]).length, 1);
    assert.equal(expandCorrections([{ role: 'user', content: 'нет ли у вас лора' }]).length, 1);
  });
});

describe('Обезличивание не разрушает фразу', () => {
  const clean = (text) => deidentifyComplaint(text).text;

  it('жалоба передаётся целиком, вместе с отрицанием, длительностью и местом боли', () => {
    const text = 'Последние несколько дней у меня закладывает правое ухо, не знаю, к какому врачу обратиться';
    assert.equal(clean(text), text);
    assert.equal(clean('Живот не болит, но тошнит третий день'), 'Живот не болит, но тошнит третий день');
    assert.equal(clean('Температуры нет, горло болит'), 'Температуры нет, горло болит');
  });

  it('метка вместо значения: роль в предложении видна, значения нет', () => {
    const state = { places: new Map() };
    const text = deidentifyComplaint('Я @PERSON_A, завуч школы № 12 в Авиастроительном районе, у сына @PERSON_B болит живот', state).text;
    assert.equal(text, 'Я [имя], [должность] школы в [место_1], у сына [имя] болит живот');
    assert.equal(state.places.get('[место_1]'), 'Авиастроительном районе');
  });

  it('обычная работа остаётся: она бывает важна для жалобы', () => {
    assert.equal(clean('Работаю на заводе с химией, кашель не проходит'), 'Работаю на заводе с химией, кашель не проходит');
    assert.equal(clean('Я учитель, постоянно срываю голос'), 'Я учитель, постоянно срываю голос');
    assert.equal(clean('Мне 67 лет, болит колено'), 'Мне 67 лет, болит колено');
  });

  it('организация, должность, номер, дата и страховая заменяются', () => {
    assert.equal(clean('Работаю в Газпроме, кашель'), 'Работаю в [организация], кашель');
    assert.equal(clean('Работаю главврачом больницы № 7'), 'Работаю [должность] больницы');
    assert.equal(clean('Родилась 12.03.1985, болит голова'), 'Родилась [дата], болит голова');
    assert.equal(clean('Учусь в КФУ, чешется кожа'), 'Учусь в [организация], чешется кожа');
    assert.equal(clean('Нужно по ДМС СберСтрахования'), 'Нужно по ДМС [страховая]');
    assert.equal(clean('Машина А123ВС116, болит шея'), 'Машина [номер], болит шея');
  });

  it('медицинские сокращения остаются', () => {
    assert.equal(clean('Сделали МРТ и ЭКГ, по УЗИ всё хорошо'), 'Сделали МРТ и ЭКГ, по УЗИ всё хорошо');
  });

  it('редкое обстоятельство и особый диагноз наружу не уходят', () => {
    assert.equal(deidentifyComplaint('Я единственная женщина во фракции, болит горло').blocked, true);
    assert.equal(hasRareCircumstance('известный актёр, болит горло'), true);
    assert.equal(hasRareCircumstance('как известно, горло болит второй день'), false);
    for (const phrase of ['у мужа ВИЧ', 'вич инфекция', 'лечусь от гепатита', 'был аборт, болит живот', 'алкоголизм у отца']) {
      assert.equal(hasSensitiveCondition(phrase), true, phrase);
    }
    for (const phrase of ['болит живот', 'кашель с мокротой', 'вичуга', 'спидометр']) {
      assert.equal(hasSensitiveCondition(phrase), false, phrase);
    }
  });
});
