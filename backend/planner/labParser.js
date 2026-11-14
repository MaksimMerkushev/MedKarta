/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сопоставление названий анализов с каталогом с помощью модели — только для
 * фрагментов, которые не нашлись по синонимам на сервере («ферритинн», «анализ
 * мочи общий», «кровь на тиреотропный»). Модели уходят только эти короткие
 * фрагменты после обезличивания и список кодов каталога: ни остальной текст
 * реплики, ни история разговора, ни идентификаторы.
 *
 * Модель выбирает код из закрытого списка или UNKNOWN. Область без названия
 * исследования («печень», «щитовидка», «гормоны») — UNKNOWN: набор анализов
 * назначает врач. Цены, филиалы и время модель не видит и не возвращает.
 */

import { assertOutboundSafe, isAllowedUpstreamUrl, PLANNER_ERROR, PlannerError, requestCompletion } from './client.js';

export const LAB_PARSER_LIMITS = Object.freeze({ MAX_FRAGMENTS: 5, MAX_FRAGMENT_CHARS: 60, MAX_RAW_BYTES: 4 * 1024 });

const systemPrompt = (tests) => `Ты сопоставляешь названия лабораторных исследований с кодами каталога медицинского навигатора.
Тебе дают короткие фрагменты из запроса человека. Для каждого фрагмента верни код исследования из каталога или "UNKNOWN".
Правила:
- Выбирай код, только если фрагмент — название исследования, его сокращение, синоним или название с опечаткой.
- Область или орган без названия исследования ("печень", "щитовидка", "гормоны", "почки", "витамины", "аллергия") — "UNKNOWN": набор анализов назначает врач, ты его не подбираешь.
- Если фрагмент подходит к нескольким разным исследованиям ("железо": железо сыворотки или ферритин; "сахар": глюкоза или гликированный гемоглобин) — "UNKNOWN".
- Один фрагмент — один код. Не придумывай кодов вне каталога.
Каталог (код — название):
${tests.map((test) => `${test.code} — ${test.name}`).join('\n')}
Ответ — строго JSON по схеме, без пояснений.`;

const schemaFor = (codes) => ({
  name: 'medkarta_lab_parse',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fragment', 'code'],
          properties: { fragment: { type: 'string' }, code: { type: 'string', enum: [...codes, 'UNKNOWN'] } },
        },
      },
    },
  },
});

/** Ответ модели → пары «фрагмент — код»: только переданные фрагменты и коды каталога. */
export const validateLabParse = (raw, { fragments, codes }) => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > LAB_PARSER_LIMITS.MAX_RAW_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.items)) return null;
  const allowed = new Set(codes);
  const result = [];
  for (const item of parsed.items) {
    if (!item || typeof item.fragment !== 'string' || typeof item.code !== 'string') continue;
    if (!fragments.includes(item.fragment)) continue;
    result.push({ fragment: item.fragment, code: allowed.has(item.code) ? item.code : 'UNKNOWN' });
  }
  return result;
};

export const createExternalLabParser = ({ apiKey, url, model, fetchImpl = globalThis.fetch, timeoutMs = 12_000, logger = null } = {}) => {
  const name = 'external';
  /**
   * @param {object} params
   * @param {string[]} params.fragments обезличенные фрагменты
   * @param {Array<{code:string, name:string}>} params.tests каталог
   */
  const parse = async ({ fragments, tests }) => {
    if (!apiKey || !url || !model || !isAllowedUpstreamUrl(url)) throw new PlannerError('lab parser is not configured', PLANNER_ERROR.NOT_CONFIGURED);
    const list = (fragments || []).map((item) => String(item || '').trim().slice(0, LAB_PARSER_LIMITS.MAX_FRAGMENT_CHARS)).filter(Boolean).slice(0, LAB_PARSER_LIMITS.MAX_FRAGMENTS);
    if (list.length === 0) throw new PlannerError('nothing to parse', PLANNER_ERROR.EMPTY);
    const leaked = list.flatMap((fragment) => assertOutboundSafe(fragment));
    if (leaked.length > 0) throw new PlannerError('Исходящий запрос содержит чувствительные данные — отправка отменена', PLANNER_ERROR.OUTBOUND_ASSERTION);
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt(tests) },
        { role: 'user', content: `Фрагменты:\n${list.map((item, index) => `${index + 1}. ${item}`).join('\n')}` },
      ],
      response_format: { type: 'json_schema', json_schema: schemaFor(tests.map((test) => test.code)) },
      temperature: 0,
      max_tokens: 300,
    };
    const completion = await requestCompletion({ url, apiKey, body, fetchImpl, timeoutMs, logger, provider: name });
    return { ...completion, fragments: list };
  };
  return Object.freeze({ name, parse });
};
