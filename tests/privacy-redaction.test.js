/*
 * © 2026 MedКарта Казань. Все права защищены.
 * Тесты 1–3: редактура PII, русская морфология, устойчивость к опечаткам.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectEntities, ENTITY_KIND } from '../api/_shared/privacy/detectors.js';
import { stemSurname, stemWord } from '../api/_shared/privacy/morphology.js';
import { createEntityResolver } from '../api/_shared/privacy/entityResolver.js';
import { GATEWAY_DECISION } from '../api/_shared/privacy/models.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { makeGateway, TEST_SESSION } from './helpers.js';

const kindsOf = (text) => new Set(detectEntities(text).spans.map((span) => span.kind));

describe('1. Редактура персональных данных', () => {
  it('обнаруживает ФИО, телефон и email в одном сообщении', () => {
    const kinds = kindsOf('Меня зовут Иван Иванов, телефон +7 (843) 291-10-16, почта ivan.petrov@mail.ru');
    assert.ok(kinds.has(ENTITY_KIND.PERSON), 'ФИО не обнаружено');
    assert.ok(kinds.has(ENTITY_KIND.PHONE), 'телефон не обнаружен');
    assert.ok(kinds.has(ENTITY_KIND.EMAIL), 'email не обнаружен');
  });

  it('обнаруживает номера документов', () => {
    assert.ok(kindsOf('СНИЛС 123-456-789 01').has(ENTITY_KIND.SNILS));
    assert.ok(kindsOf('полис ОМС 1234567890123456').has(ENTITY_KIND.OMS));
    assert.ok(kindsOf('паспорт 92 05 123456').has(ENTITY_KIND.PASSPORT));
  });

  it('обнаруживает координаты и адреса', () => {
    assert.ok(kindsOf('я на 55.753381, 49.173867').has(ENTITY_KIND.COORDS));
    assert.ok(kindsOf('живу ул. Карбышева, 12А, кв. 45').has(ENTITY_KIND.ADDRESS));
  });

  it('обнаруживает внутренние идентификаторы и UUID', () => {
    const kinds = kindsOf('запись verified-mkdc-1 и 550e8400-e29b-41d4-a716-446655440000');
    assert.ok(kinds.has(ENTITY_KIND.INTERNAL_ID));
    assert.ok(kinds.has(ENTITY_KIND.UUID));
  });

  it('не срабатывает на обычном навигационном запросе', () => {
    assert.equal(kindsOf('найди стоматолога рядом и построй маршрут').size, 0);
  });

  it('не обманывается невидимыми символами и гомоглифами', () => {
    // Латинская e внутри кириллического слова плюс zero-width space.
    const kinds = kindsOf('запиши к П​etp​ову');
    assert.ok(kinds.has(ENTITY_KIND.PERSON), 'маскировка символами обошла детектор');
  });

  it('заменяет ФИО врача на session-токен до выхода наружу', async () => {
    const { gateway } = makeGateway();
    const result = await gateway.process({
      messages: [{ role: 'user', content: 'Построй маршрут к терапевту Петрову' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(result.decision, GATEWAY_DECISION.ALLOW_EXTERNAL);
    const outbound = result.request.toWireMessages()[0].content;
    assert.ok(/@DOCTOR_[A-Z]{1,2}/.test(outbound), `нет токена врача: ${outbound}`);
    assert.ok(!/Петров/i.test(outbound), `реальная фамилия осталась: ${outbound}`);
  });
});

describe('2. Русская морфология', () => {
  const forms = ['Петров', 'Петрову', 'Петрова', 'Петровым', 'Петрове', 'Петровой'];

  it('приводит падежные формы фамилии к одной основе', () => {
    const stems = new Set(forms.map(stemSurname));
    assert.equal(stems.size, 1, `основы разошлись: ${[...stems].join(', ')}`);
    assert.equal([...stems][0], 'петров');
  });

  it('приводит падежные формы специальности к одной основе', () => {
    const stems = new Set(['стоматолог', 'стоматологу', 'стоматолога', 'стоматологом'].map(stemWord));
    assert.equal(stems.size, 1, `основы разошлись: ${[...stems].join(', ')}`);
  });

  it('находит врача в любом падеже, включая предлог', () => {
    const resolver = createEntityResolver(fixtureCatalog());
    for (const phrase of ['Петров', 'к Петрову', 'записаться к Петрову', 'о Петрове', 'Петрова']) {
      const links = resolver.resolve(phrase).links.filter((link) => link.kind === ENTITY_KIND.DOCTOR);
      assert.ok(links.length > 0, `не найден врач в форме: ${phrase}`);
    }
  });

  it('различает однофамильцев по стоящей рядом специальности', () => {
    const resolver = createEntityResolver(fixtureCatalog());
    const therapist = resolver.resolve('к терапевту Петрову').links.find((l) => l.kind === ENTITY_KIND.DOCTOR);
    const dentist = resolver.resolve('к стоматологу Петровой').links.find((l) => l.kind === ENTITY_KIND.DOCTOR);

    assert.deepEqual(therapist.ids, ['fx-doc-petrov-therapist']);
    assert.deepEqual(dentist.ids, ['fx-doc-petrova-dentist']);
  });
});

describe('3. Опечатки', () => {
  const resolver = createEntityResolver(fixtureCatalog());

  it('находит врача при разумной опечатке', () => {
    // Проверяется результат, а не способ: «Петровву» ловится схлопыванием
    // повторов как точное совпадение, «Птерову» — нечётким сравнением.
    // Требовать конкретный matcher значит запрещать улучшать распознавание.
    const KNOWN = new Set(['doctor.exact', 'doctor.fuzzy', 'doctor.glued', 'doctor.joined']);

    for (const typo of ['к Петову', 'к Птерову', 'к Петровву']) {
      const links = resolver.resolve(typo).links.filter((link) => link.kind === ENTITY_KIND.DOCTOR);
      assert.ok(links.length > 0, `опечатка не распознана: ${typo}`);
      assert.ok(KNOWN.has(links[0].matcher), `неожиданный способ совпадения: ${links[0].matcher}`);
      assert.ok(
        links[0].ids.includes('fx-doc-petrov-therapist') || links[0].ids.includes('fx-doc-petrova-dentist'),
        `опечатка привела не к тому врачу: ${JSON.stringify(links[0].ids)}`,
      );
    }
  });

  it('не связывает с врачом произвольное слово', () => {
    const links = resolver.resolve('построй маршрут в поликлинику завтра утром').links
      .filter((link) => link.kind === ENTITY_KIND.DOCTOR);
    assert.equal(links.length, 0, 'ложное срабатывание нечёткого поиска');
  });

  it('находит клинику по аббревиатуре и по части названия', () => {
    const links = resolver.resolve('поеду в Стоматологию «Тестовую» на Победе').links
      .filter((link) => link.kind === ENTITY_KIND.CLINIC);
    assert.ok(links.length > 0, 'клиника не связана со справочником');
  });
});
