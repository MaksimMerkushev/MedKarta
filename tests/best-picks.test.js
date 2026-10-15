/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * «Топ-3» в ответе ассистента: отбор и подписи (frontend/src/bestPicks.js)
 * и то, что сервер больше не сужает поиск по профилю до одного врача.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  describeCriteria,
  formatDistance,
  formatPrice,
  formatTravel,
  pickReasons,
  selectTopPicks,
  wantsTopPicks,
} from '../frontend/src/bestPicks.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const doc = (id, extra = {}) => ({ id, name: `Врач ${id}`, clinic: `Клиника ${id}`, lat: 55.79 + Number(id) / 1000, lng: 49.1, ...extra });

describe('Топ-3: отбор', () => {
  it('берёт первых трёх из отсортированной выдачи', () => {
    const { picks, total } = selectTopPicks([doc(1), doc(2), doc(3), doc(4)]);
    assert.deepEqual(picks.map((item) => item.id), [1, 2, 3]);
    assert.equal(total, 4);
  });

  it('три врача одной клиники — не три варианта: второй из той же клиники уступает место', () => {
    const same = { clinic: 'Поликлиника №7', lat: 55.8, lng: 49.12 };
    const list = [doc(1, same), doc(2, same), doc(3), doc(4)];
    assert.deepEqual(selectTopPicks(list).picks.map((item) => item.id), [1, 3, 4]);
  });

  it('если других мест нет, добирает из той же клиники', () => {
    const same = { clinic: 'Поликлиника №7', lat: 55.8, lng: 49.12 };
    assert.deepEqual(selectTopPicks([doc(1, same), doc(2, same)]).picks.map((item) => item.id), [1, 2]);
  });

  it('ради разнообразия не поднимает далёкий результат', () => {
    const same = { clinic: 'Поликлиника №7', lat: 55.8, lng: 49.12 };
    const list = [...Array.from({ length: 15 }, (_, index) => doc(index + 1, same)), doc(99)];
    assert.deepEqual(selectTopPicks(list).picks.map((item) => item.id), [1, 2, 3]);
  });

  it('один врач в двух филиалах — один вариант', () => {
    const list = [
      doc(1, { entityKind: 'doctor', name: 'Соколов Глеб Аркадьевич', doctorProfile: 'Кардиолог' }),
      doc(2, { entityKind: 'doctor', name: 'Соколов  Глеб Аркадьевич', doctorProfile: 'Кардиолог' }),
      doc(3, { entityKind: 'doctor', name: 'Галявич Альберт Сарварович', doctorProfile: 'Кардиолог' }),
    ];
    assert.deepEqual(selectTopPicks(list).picks.map((item) => item.id), [1, 3]);
  });

  it('точки маршрута в лучшие не попадают и в «всего» не считаются', () => {
    const { picks, total } = selectTopPicks([doc(1), doc(2), doc(3)], { exclude: new Set([1]) });
    assert.deepEqual(picks.map((item) => item.id), [2, 3]);
    assert.equal(total, 2);
  });

  it('пустая выдача — пустая подборка', () => {
    assert.deepEqual(selectTopPicks([]), { picks: [], total: 0 });
    assert.deepEqual(selectTopPicks(null), { picks: [], total: 0 });
  });
});

describe('Топ-3: почему этот вариант', () => {
  it('время в пути важнее расстояния, оценка по прямой помечена «≈»', () => {
    assert.equal(formatTravel(720, 'driving', false), '12 мин на машине');
    assert.equal(formatTravel(600, 'foot', true), '≈10 мин пешком');
    const reasons = pickReasons({ travelSeconds: 720, travelApproximate: false, distanceKm: 3 }, { travelMode: 'driving' });
    assert.equal(reasons[0].kind, 'travel');
    assert.ok(!reasons.some((reason) => reason.kind === 'distance'));
  });

  it('расстояние и цена по-русски', () => {
    assert.equal(formatDistance(0.83), '850 м');
    assert.equal(formatDistance(2.345), '2,3 км');
    assert.equal(formatDistance(12.6), '13 км');
    assert.equal(formatPrice(1500), `от ${(1500).toLocaleString('ru-RU')} ₽`);
    assert.equal(formatPrice(null), null);
  });

  it('ДМС, открыто сейчас, детский приём — только если это правда', () => {
    const reasons = pickReasons(
      { distanceKm: 1.2, openNow: true, dmsCoverage: { status: 'covered' }, features: { children: true }, rating: 0, experience: 0 },
      { childrenOnly: true },
    );
    assert.deepEqual(reasons.map((reason) => reason.kind), ['distance', 'open', 'dms', 'child']);
    const none = pickReasons({ distanceKm: null, openNow: false, todayHours: 'График уточняется', dmsCoverage: { status: 'not_covered' } });
    assert.deepEqual(none, []);
  });

  it('не больше четырёх пунктов', () => {
    const reasons = pickReasons({
      distanceKm: 1, openNow: true, dmsCoverage: { status: 'covered' }, consultPrice: 1200, features: { children: true }, rating: 4.8, experience: 20,
    }, { childrenOnly: true });
    assert.equal(reasons.length, 4);
  });

  it('условия запроса одной строкой', () => {
    assert.deepEqual(
      describeCriteria({ profile: 'Детский ЛОР', childrenOnly: true, maxTravelMinutes: 20, travelActive: true, travelMode: 'driving', dmsPlanName: 'Оптимум' }),
      ['Детский ЛОР', 'детский приём', 'до 20 мин на машине', 'ДМС «Оптимум»'],
    );
    // Потолок времени без точки отправления не применяется — и не упоминается.
    assert.deepEqual(describeCriteria({ maxTravelMinutes: 20, travelActive: false }), []);
  });
});

describe('Топ-3: когда показывать', () => {
  it('на поиск — да, на маршрут и сброс — нет', () => {
    assert.equal(wantsTopPicks({ specialty: 'Кардиолог' }), true);
    assert.equal(wantsTopPicks({ searchQuery: 'Петрова' }), true);
    assert.equal(wantsTopPicks({ specialty: 'Кардиолог', buildRoute: true }), false);
    assert.equal(wantsTopPicks({ targetStops: [{ doctor: 'x' }], specialty: 'Терапевт' }), false);
    assert.equal(wantsTopPicks({ clearFilters: true }), false);
    assert.equal(wantsTopPicks({ replyText: 'Уточните запрос' }), false);
    assert.equal(wantsTopPicks(null), false);
  });
});

describe('Топ-3: сервер не выбирает врача за пользователя', () => {
  it('поиск по профилю отдаёт профиль целиком, без фамилии', async () => {
    const { pipeline } = makeTestPipeline({
      respond: { action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'therapist', selection: 'nearest' }], constraints: {}, reply_hint: 'doctors_found' },
    });
    const { action } = await pipeline.handle({ messages: [{ role: 'user', content: 'нужен терапевт рядом' }], sessionId: TEST_SESSION });
    assert.equal(action.specialty, 'Терапевт');
    assert.equal(action.searchQuery, null);
    assert.match(action.replyText, /Лучшие варианты — ниже/);
    assert.doesNotMatch(action.replyText, /Петров/);
    assert.equal(wantsTopPicks(action), true);
  });

  it('названный врач по-прежнему ищется по фамилии', async () => {
    const { pipeline } = makeTestPipeline({
      respond: (request) => ({
        action: 'FIND_DOCTOR',
        steps: [{ type: 'specific_doctor', token: request.placeholders.find((item) => item.kind === 'DOCTOR')?.token }],
        constraints: {},
        reply_hint: 'doctors_found',
      }),
    });
    const { action } = await pipeline.handle({ messages: [{ role: 'user', content: 'к терапевту Петрову' }], sessionId: TEST_SESSION });
    assert.match(action.searchQuery || '', /Петров/);
    assert.match(action.replyText, /Нашёл/);
  });
});
