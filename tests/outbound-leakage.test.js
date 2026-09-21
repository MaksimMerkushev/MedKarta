/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Тесты 11, 13, 14, 15: что физически уходит за границу доверия.
 *
 * Эти проверки — главные в наборе. Всё остальное описывает, как система
 * устроена; здесь фиксируется, что именно покидает контур.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GATEWAY_DECISION } from '../backend/privacy/models.js';
import { detectEntities } from '../backend/privacy/detectors.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';
import { FIXTURE_DOCTORS } from './fixtures/catalog.js';

const CLARIFY = { action: 'CLARIFY', steps: [], constraints: {}, reply_hint: 'need_clarification' };

/** Всё, что ушло бы в сеть за один прогон. */
const runAndCapture = async (content) => {
  const { pipeline, sent } = makeTestPipeline({ respond: CLARIFY });
  await pipeline.handle({ messages: [{ role: 'user', content }], sessionId: TEST_SESSION });
  return sent.map((item) => item.serialized + JSON.stringify(item.hints)).join('\n');
};

describe('11. Сырые персональные данные не уходят наружу', () => {
  it('ФИО, телефон и email отсутствуют в исходящем запросе', async () => {
    const outbound = await runAndCapture(
      'Меня зовут Иван Петров, мой телефон +7 (843) 291-10-16, почта ivan@mail.ru, найди терапевта',
    );

    assert.ok(!/Иван/i.test(outbound), 'имя ушло наружу');
    assert.ok(!/291-10-16/.test(outbound), 'телефон ушёл наружу');
    assert.ok(!/ivan@mail\.ru/i.test(outbound), 'email ушёл наружу');
  });

  it('ФИО врача из справочника заменено токеном', async () => {
    const outbound = await runAndCapture('Построй маршрут к терапевту Петрову');
    for (const doctor of FIXTURE_DOCTORS) {
      for (const part of doctor.name.split(' ')) {
        assert.ok(!outbound.includes(part), `часть ФИО врача «${part}» ушла наружу`);
      }
    }
    assert.ok(/@DOCTOR_/.test(outbound), 'токен врача не сформирован');
  });

  it('домашний адрес не уходит наружу', async () => {
    const outbound = await runAndCapture('построй маршрут от ул. Карбышева, 12А, кв. 45 до терапевта');
    assert.ok(!/Карбышева/i.test(outbound), 'улица ушла наружу');
    assert.ok(!/кв\.\s*45/i.test(outbound), 'квартира ушла наружу');
  });

  it('исходящий запрос не содержит ни одной сущности по мнению детекторов', async () => {
    const outbound = await runAndCapture('Построй маршрут к терапевту Петрову, потом домой');
    const kinds = detectEntities(outbound).spans.map((span) => span.kind);
    assert.deepEqual(kinds, [], `детекторы нашли в исходящем запросе: ${kinds.join(', ')}`);
  });

  it('предохранитель клиента отклоняет запрос с остаточными данными', async () => {
    const { assertOutboundSafe } = await import('../backend/planner/client.js');
    assert.deepEqual(assertOutboundSafe('Построй маршрут к @DOCTOR_A, потом @HOME'), []);
    assert.ok(assertOutboundSafe('телефон +7 843 291-10-16').length > 0);
  });
});

describe('13. Координаты не уходят наружу', () => {
  it('координаты из текста пользователя заменяются', async () => {
    const outbound = await runAndCapture('я сейчас на 55.753381, 49.173867 — найди ближайшего терапевта');
    assert.ok(!/55\.753381/.test(outbound), 'широта ушла наружу');
    assert.ok(!/49\.173867/.test(outbound), 'долгота ушла наружу');
  });

  it('место передаётся семантическим токеном, а не координатами', async () => {
    const outbound = await runAndCapture('построй маршрут к терапевту, а потом домой');
    assert.ok(/@HOME/.test(outbound), 'семантический токен места не сформирован');
    assert.ok(!/\d{2}\.\d{4,}/.test(outbound), 'в запросе есть что-то похожее на координату');
  });

  it('координаты врачей из справочника наружу не передаются', async () => {
    const outbound = await runAndCapture('построй маршрут к ближайшему стоматологу');
    for (const doctor of FIXTURE_DOCTORS) {
      assert.ok(!outbound.includes(String(doctor.lat)), 'широта врача ушла наружу');
      assert.ok(!outbound.includes(String(doctor.lng)), 'долгота врача ушла наружу');
    }
  });
});

describe('14. Идентификаторы базы не уходят наружу', () => {
  it('id врача отсутствует в исходящем запросе', async () => {
    const outbound = await runAndCapture('Построй маршрут к терапевту Петрову');
    for (const doctor of FIXTURE_DOCTORS) {
      assert.ok(!outbound.includes(doctor.id), `id ${doctor.id} ушёл наружу`);
    }
  });

  it('идентификатор, названный пользователем, тоже редактируется', async () => {
    const outbound = await runAndCapture('открой карточку verified-mkdc-1 и 550e8400-e29b-41d4-a716-446655440000');
    assert.ok(!/verified-mkdc-1/.test(outbound), 'внутренний id ушёл наружу');
    assert.ok(!/550e8400/.test(outbound), 'UUID ушёл наружу');
  });

  it('идентификатор сессии наружу не передаётся', async () => {
    const outbound = await runAndCapture('найди терапевта');
    assert.ok(!outbound.includes(TEST_SESSION), 'идентификатор сессии ушёл наружу');
  });
});

describe('15. Медицинский текст не покидает контур', () => {
  it('описание жалоб заменяется перечнем профилей', async () => {
    const outbound = await runAndCapture('Меня зовут Иван, неделю болит живот и тошнит');

    assert.ok(!/живот/i.test(outbound), 'жалоба ушла наружу');
    assert.ok(!/тошнит/i.test(outbound), 'жалоба ушла наружу');
    assert.ok(!/Иван/i.test(outbound), 'имя ушло наружу');
    assert.ok(/gastroenterologist|therapist/.test(outbound), 'профиль специалиста не выведен локально');
  });

  it('жалоба не утекает через историю диалога', async () => {
    const { pipeline, sent } = makeTestPipeline({ respond: CLARIFY });
    await pipeline.handle({
      messages: [
        { role: 'user', content: 'у меня третий день болит зуб и опухла десна' },
        { role: 'assistant', content: 'Нашёл стоматологов рядом.' },
        { role: 'user', content: 'а есть кто-то после 18:00?' },
      ],
      sessionId: TEST_SESSION,
    });

    const outbound = sent.map((item) => item.serialized).join('\n');
    assert.ok(!/десна|опухла/i.test(outbound), 'жалоба ушла наружу через историю');
  });

  it('при неуверенной классификации внешний вызов не делается вовсе', async () => {
    const { pipeline, sent } = makeTestPipeline({ respond: CLARIFY });
    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'что-то мне нехорошо' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(sent.length, 0, 'запрос ушёл наружу при неуверенной классификации');
    assert.ok(result.action.replyText.length > 0);
  });

  it('номера документов останавливают внешний вызов', async () => {
    const { pipeline, sent } = makeTestPipeline({ respond: CLARIFY });
    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'мой СНИЛС 123-456-789 01, запишите меня к терапевту' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(sent.length, 0, 'запрос с номером документа ушёл наружу');
    assert.match(result.action.replyText, /не присылайте номера документов/i);
  });

  it('признаки неотложного состояния не уходят наружу и дают указание звонить 103', async () => {
    const { pipeline, sent } = makeTestPipeline({ respond: CLARIFY });
    const result = await pipeline.handle({
      messages: [{ role: 'user', content: 'сильно давит в груди и нечем дышать' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(sent.length, 0, 'экстренный запрос ушёл наружу');
    assert.match(result.action.replyText, /103|112/);
    assert.equal(result.action.buildRoute, false);
  });
});

describe('Граница типов', () => {
  it('Gateway — единственный источник SanitizedPlannerRequest', async () => {
    const { SanitizedPlannerRequest } = await import('../backend/privacy/models.js');
    assert.throws(() => new SanitizedPlannerRequest(Symbol('fake'), {}), /нельзя создать напрямую/);
  });

  it('внешний планировщик не принимает строку', async () => {
    const { createExternalPlanner, PLANNER_ERROR } = await import('../backend/planner/client.js');
    const planner = createExternalPlanner({ apiKey: 'k', url: 'https://example.test/v1', model: 'm' });

    await assert.rejects(
      planner.generate('Меня зовут Иван, болит живот'),
      (error) => error.code === PLANNER_ERROR.NOT_SANITIZED,
    );
  });

  it('решение Gateway фиксируется явным перечислением', async () => {
    const values = Object.values(GATEWAY_DECISION);
    assert.ok(values.includes('allow_external') && values.includes('local_only'));
  });
});
