/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Финальная проверка тела запроса к внешней модели (planner/outboundInspector.js):
 * то, что физически уйдёт в сеть, — все поля, вся история, системные тексты.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inspectOutbound } from '../backend/planner/outboundInspector.js';
import { PLANNER_ERROR, requestCompletion } from '../backend/planner/client.js';
import { PLAN_JSON_SCHEMA } from '../backend/planner/schema.js';
import { TRIAGE_JSON_SCHEMA, TRIAGE_SYSTEM_PROMPT } from '../backend/planner/triage.js';

// Доверенное объявляет канал триажа (planner/triage.js), а не вызов.
const triageInspect = (ner = null) => ({ channel: 'triage', ner });
const triageBody = (user, extra = {}) => ({
  model: 'openai/gpt-5.4-mini',
  messages: [{ role: 'system', content: TRIAGE_SYSTEM_PROMPT }, { role: 'user', content: `Реплики пользователя:\n1. ${user}` }],
  response_format: { type: 'json_schema', json_schema: TRIAGE_JSON_SCHEMA },
  temperature: 0,
  max_tokens: 600,
  ...extra,
});

describe('Финальная проверка тела запроса', () => {
  it('обычная жалоба с метками проходит; давление, температура, время, дозировка — не номера', async () => {
    assert.deepEqual(await inspectOutbound(triageBody('Меня зовут [имя], давление 160/100, температура 38.5 с 18:00, пью 1000 мг'), triageInspect()), []);
  });

  it('лишнее поле верхнего уровня, неизвестная схема, лишний ключ или роль сообщения — отказ', async () => {
    assert.ok((await inspectOutbound(triageBody('болит горло', { user: 'account-42' }), triageInspect())).includes('field:user'));
    assert.ok((await inspectOutbound(triageBody('болит горло', { metadata: { ip: '1.2.3.4' } }), triageInspect())).includes('field:metadata'));
    assert.ok((await inspectOutbound(triageBody('болит горло', { response_format: { type: 'json_schema', json_schema: PLAN_JSON_SCHEMA } }), triageInspect())).includes('schema'));
    const named = triageBody('болит горло');
    named.messages[1].name = 'Гульнара';
    assert.ok((await inspectOutbound(named, triageInspect())).includes('message'));
    const assistant = triageBody('болит горло');
    assistant.messages.push({ role: 'assistant', content: 'Гульнара, ваш номер 89175551234' });
    assert.ok((await inspectOutbound(assistant, triageInspect())).includes('message'));
  });

  it('телефон, e-mail, длинный номер — отказ, в том числе в неизвестном системном тексте', async () => {
    for (const user of ['позвоните +7 917 555-12-34', 'пишите gulnara@mail.ru', 'полис 001 778899 2231']) {
      assert.notDeepEqual(await inspectOutbound(triageBody(user), triageInspect()), [], user);
    }
    const system = triageBody('болит горло');
    system.messages.push({ role: 'system', content: 'Контакт пациента: 8 917 555 12 34' });
    assert.notDeepEqual(await inspectOutbound(system, triageInspect()), []);
  });

  it('ML-слой смотрит итоговый текст: найденная сущность или сбой модели — отказ', async () => {
    const found = { residual: async () => ['PER'] };
    assert.ok((await inspectOutbound(triageBody('болит горло'), triageInspect(found))).includes('ner:PER'));
    const broken = { residual: async () => { throw Object.assign(new Error('x'), { code: 'ner_timeout' }); } };
    assert.ok((await inspectOutbound(triageBody('болит горло'), triageInspect(broken))).includes('ner_error:ner_timeout'));
    const clean = { residual: async () => [] };
    assert.deepEqual(await inspectOutbound(triageBody('болит горло'), triageInspect(clean)), []);
  });

  it('requestCompletion не вызывает fetch, если проверка не пройдена', async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; return { ok: true }; };
    await assert.rejects(
      requestCompletion({ url: 'https://llm.example.test/v1/chat/completions', apiKey: 'k', body: triageBody('болит горло', { user: 'account-42' }), fetchImpl, channel: 'triage' }),
      { code: PLANNER_ERROR.OUTBOUND_ASSERTION },
    );
    assert.equal(called, 0);
  });
});
