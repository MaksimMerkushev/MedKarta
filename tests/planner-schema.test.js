/*
 * Схема плана для structured output. Строгий режим OpenAI (strict: true)
 * отвечает 400, если хоть в одном объекте не все поля перечислены в required
 * или есть неподдерживаемые ключевые слова, — и ассистент молча уходит на
 * локальный план. Тест не даст включить strict без схемы по этим правилам.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPlannerBody } from '../backend/planner/client.js';
import { PLAN_JSON_SCHEMA } from '../backend/planner/schema.js';

const UNSUPPORTED_IN_STRICT = ['minLength', 'maxLength', 'allOf', 'oneOf', 'not', 'if', 'then', 'else', 'patternProperties', 'default'];

/** Нарушения правил строгого режима OpenAI в схеме. */
const strictProblems = (node, path = '$') => {
  if (!node || typeof node !== 'object') return [];
  const problems = [];
  for (const keyword of UNSUPPORTED_IN_STRICT) {
    if (keyword in node) problems.push(`${path}: ${keyword}`);
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('object')) {
    const keys = Object.keys(node.properties || {});
    const required = new Set(node.required || []);
    const missing = keys.filter((key) => !required.has(key));
    if (missing.length > 0) problems.push(`${path}: не в required — ${missing.join(', ')}`);
    if (node.additionalProperties !== false) problems.push(`${path}: нужно additionalProperties: false`);
    for (const key of keys) problems.push(...strictProblems(node.properties[key], `${path}.${key}`));
  }
  if (node.items) problems.push(...strictProblems(node.items, `${path}[]`));
  for (const branch of node.anyOf || []) problems.push(...strictProblems(branch, `${path}|`));
  return problems;
};

describe('Схема плана для модели', () => {
  it('strict включается только вместе со схемой по правилам строгого режима', () => {
    const problems = strictProblems(PLAN_JSON_SCHEMA.schema);
    if (PLAN_JSON_SCHEMA.strict) {
      assert.deepEqual(problems, [], 'со strict: true OpenAI ответит 400 на каждый запрос');
    } else {
      // Нынешняя схема строгий режим не проходит — поэтому strict выключен.
      assert.ok(problems.length > 0);
    }
  });

  it('проверка схемы ловит то, из-за чего OpenAI отвечал 400', () => {
    const problems = strictProblems({ type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' }, b: { type: ['string', 'null'], maxLength: 5 } } });
    assert.ok(problems.some((item) => item.includes('не в required — b')));
    assert.ok(problems.some((item) => item.includes('maxLength')));
  });

  it('ассистент и npm run ai:check отправляют одно и то же тело запроса', () => {
    const body = buildPlannerBody({ model: 'openai/gpt-5.4-mini', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema, PLAN_JSON_SCHEMA);
    assert.equal(body.max_tokens, 700);
    assert.equal('reasoning' in body, false);
    assert.deepEqual(buildPlannerBody({ model: 'm', messages: [], reasoningEffort: 'low' }).reasoning, { effort: 'low' });
  });
});
