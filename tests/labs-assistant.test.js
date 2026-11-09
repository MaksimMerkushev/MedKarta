/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории в ассистенте: 49 сценариев через весь путь запроса (pipeline) с
 * заглушкой модели вместо OpenRouter. Заглушка сопоставляет только опечатку
 * «ферритинн» — остальное должно решаться правилами на сервере. Качество
 * настоящей модели этим не измеряется.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { loadSqlite } from '../backend/demo/bookingStore.js';
import { moscowMoment } from '../backend/demo/time.js';
import { createLabAssistant, doctorRequestTurns } from '../backend/labs/assistant.js';
import { createLabService } from '../backend/labs/service.js';
import { createLabStore } from '../backend/labs/store.js';
import { createLabUnderstanding } from '../backend/labs/understanding.js';
import { validateLabParse } from '../backend/planner/labParser.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { checkLabScenario, LAB_SCENARIOS } from './fixtures/lab-scenarios.js';
import { makeTestPipeline, TEST_SESSION } from './helpers.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-11-09', '09:00');

describe('Лаборатории в ассистенте', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let service;
  let catalog;
  before(async () => {
    process.env.DEMO_DATA = 'on';
    delete process.env.PUBLIC_CLINICS;
    __resetCatalogCache();
    catalog = await loadCatalog();
    service = createLabService({ store: createLabStore({ DatabaseSync, file: ':memory:', now: () => NOW }), now: () => NOW });
  });

  const run = async (turns) => {
    const fragments = [];
    const parser = {
      parse: async ({ fragments: sent }) => {
        fragments.push(...sent);
        return { raw: JSON.stringify({ items: sent.map((fragment) => ({ fragment, code: /ферритинн/u.test(fragment) ? 'FERRITIN' : 'UNKNOWN' })) }), fragments: sent, usage: null };
      },
    };
    const labs = createLabAssistant({ getService: async () => service, parser });
    const { pipeline } = makeTestPipeline({ catalog, labs, booking: { enabled: true, now: () => NOW } });
    const { action, diagnostics } = await pipeline.handle({ messages: turns.map((content) => ({ role: 'user', content })), sessionId: TEST_SESSION });
    return { action: sanitizeAiAction(JSON.parse(JSON.stringify(action))), planSource: diagnostics.planSource, fragments };
  };

  for (const scenario of LAB_SCENARIOS) {
    it(`${scenario.id}: ${scenario.turns.join(' → ').slice(0, 80)}`, async () => {
      const outcome = await run(scenario.turns);
      assert.deepEqual(checkLabScenario(scenario, outcome), []);
    });
  }

  it('подбор по ответу ассистента исполняется сервером и находит варианты', async () => {
    const { action } = await run(['Хочу сдать ОАК и ферритин завтра утром до 2000 рублей']);
    const result = await service.quote(action.labs.request);
    assert.equal(result.status, 'ok');
    assert.ok(result.options.every((option) => option.total <= 2000 && option.slots.every((slot) => slot.start < '12:00')));
  });

  it('врач в роли «назначил» — не просьба о записи; «нужен», «к» и одно название профиля — просьба', () => {
    assert.deepEqual([...doctorRequestTurns(['Эндокринолог назначил ТТГ', 'Нужен эндокринолог', 'к лору', 'кардиолог'])], [1, 2, 3]);
  });

  it('модель не может добавить код вне каталога или для фрагмента, которого ей не давали', () => {
    const parsed = validateLabParse(JSON.stringify({ items: [{ fragment: 'ферритинн', code: 'FERRITIN' }, { fragment: 'чужое', code: 'TSH' }, { fragment: 'печенку', code: 'MADE_UP' }] }), { fragments: ['ферритинн', 'печенку'], codes: ['FERRITIN', 'TSH'] });
    assert.deepEqual(parsed, [{ fragment: 'ферритинн', code: 'FERRITIN' }, { fragment: 'печенку', code: 'UNKNOWN' }]);
    assert.equal(validateLabParse('не json', { fragments: [], codes: [] }), null);
  });

  it('разбор устойчив к падежам и порядку: «общего анализа крови», «Т4 свободного»', () => {
    const tests = new Map(service.store.listTests().map((test) => [test.code, test]));
    const understanding = createLabUnderstanding({ synonyms: service.store.synonymIndex(), tests });
    assert.deepEqual(understanding.findTests('для общего анализа крови и т4 свободного').map((item) => item.code), ['CBC_DIFF', 'FT4']);
    assert.deepEqual(understanding.findTests('без лейкоцитарной формулы оак').map((item) => item.code), ['CBC_DIFF']);
  });
});
