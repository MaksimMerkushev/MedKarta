#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Проверка обезличивания на размеченном наборе.
 *
 *   npm run eval:privacy                         — проверочный набор + ручной
 *   npm run eval:privacy -- --split handwritten  — только ручной
 *   npm run eval:privacy -- --scale 0.2          — быстрый прогон (20 % набора)
 *   npm run eval:privacy -- --examples 30        — показать примеры утечек и отказов
 *   npm run eval:privacy -- --out /tmp/eval.json — сохранить все результаты
 *
 * Считает: сколько примеров с персональными данными дали утечку (цель — 0),
 * сколько ушло модели в обезличенном виде, сколько ответило локально, и
 * сколько обычных запросов зря не дошло до модели или было испорчено.
 */

import fs from 'node:fs/promises';

import { loadCatalog } from '../backend/privacy/catalog.js';
import { createPipeline } from '../backend/pipeline.js';
import { createMemoryStore, createTokenVault } from '../backend/storage/tokenVault.js';
import { createExternalPlanner } from '../backend/planner/client.js';
import { createHaversineRoutingProvider } from '../backend/executor/routing.js';
import { createSafeLogger } from '../backend/observability/safeLogger.js';
import { createMetrics } from '../backend/observability/metrics.js';
import { generateDataset } from '../tools/privacy-eval/generate.js';
import { HANDWRITTEN } from '../tools/privacy-eval/handwritten.js';
import { createRecordingPipeline, evaluateSamples, handwrittenSamples, summarize } from '../tools/privacy-eval/evaluate.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const split = option('--split', 'test');
const scale = Number(option('--scale', '1'));
const examples = Number(option('--examples', '0'));
const out = option('--out', null);
// --mode hybrid|structured — режим исходящего запроса; по умолчанию — PRIVACY_OUTBOUND_MODE или structured.
const mode = option('--mode', undefined);

const modules = { loadCatalog, createPipeline, createMemoryStore, createTokenVault, createExternalPlanner, createHaversineRoutingProvider, createSafeLogger, createMetrics };

const main = async () => {
  const runner = await createRecordingPipeline({ modules, outboundMode: mode });
  const catalogDoctors = (runner.catalog.doctors || []).filter((doctor) => doctor.name && doctor.specialty).map((doctor) => ({ name: doctor.name, specialty: doctor.specialty }));

  const samples = [];
  if (split === 'test' || split === 'train' || split === 'all') {
    for (const part of split === 'all' ? ['train', 'test'] : [split]) samples.push(...generateDataset({ split: part, scale, catalogDoctors }));
  }
  if (split === 'test' || split === 'handwritten' || split === 'all') samples.push(...handwrittenSamples(HANDWRITTEN));

  process.stderr.write(`Примеров: ${samples.length}\n`);
  const results = await evaluateSamples(runner, samples, {
    onProgress: (done, total) => process.stderr.write(`  ${done}/${total}\r`),
  });
  const summary = summarize(results);

  const line = (label, value) => process.stdout.write(`${label.padEnd(44)}${value}\n`);
  const percent = (value) => (value === null ? '—' : `${value}%`);
  const o = summary.overall;
  process.stdout.write(`\nМедКарта — проверка обезличивания (режим: ${mode || process.env.PRIVACY_OUTBOUND_MODE || 'structured'})\n`);
  process.stdout.write('='.repeat(60) + '\n');
  line('Примеров всего', o.samples);
  line('С персональными данными', o.piiSamples);
  line('  утечка (что-то ушло модели)', `${o.leakedSamples} (${percent(o.leakRate)})`);
  line('  ушло модели обезличенным', percent(o.piiSentRate));
  line('  ответили локально, без модели', percent(o.piiLocalRate));
  line('Обычных запросов', o.benignSamples);
  line('  дошли до модели', percent(o.benignSentRate));
  line('  дошли без изменений', percent(o.benignVerbatimRate));
  line('  испорчены метками персональных данных', percent(o.benignTokenizedRate));
  line('  ложная тревога «звоните 103»', o.emergencyFalseAlarms);
  line('Реплики без запроса («привет»): ушли модели', `${percent(o.smalltalkSentRate)} из ${o.smalltalkSamples}`);
  line('Врачи справочника: ушли меткой', percent(o.catalogTokenRate));
  line('Дошло модели описанием вместо текста', percent(o.syntheticRate));
  line('Смысл дошёл: профиль / время / место', `${percent(o.specialtyCoverage)} / ${percent(o.timeCoverage)} / ${percent(o.placeCoverage)}`);
  line('  из них при описании вместо текста', `${percent(o.specialtyCoverageSynthetic)} / ${percent(o.timeCoverageSynthetic)} / ${percent(o.placeCoverageSynthetic)}`);
  line('Смысл дошёл: детский / ДМС / транспорт / клиника', `${percent(o.childCoverage)} / ${percent(o.dmsCoverage)} / ${percent(o.travelCoverage)} / ${percent(o.clinicCoverage)}`);
  line('  из них при описании вместо текста', `${percent(o.childCoverageSynthetic)} / ${percent(o.dmsCoverageSynthetic)} / ${percent(o.travelCoverageSynthetic)} / ${percent(o.clinicCoverageSynthetic)}`);
  line('Смысл дошёл: порядок шагов / стаж / сортировка', `${percent(o.orderCoverage)} / ${percent(o.experienceCoverage)} / ${percent(o.sortCoverage)}`);
  line('  из них при описании вместо текста', `${percent(o.orderCoverageSynthetic)} / ${percent(o.experienceCoverageSynthetic)} / ${percent(o.sortCoverageSynthetic)}`);
  line('Время разбора, мс (p50 / p95 / max)', `${o.p50ms} / ${o.p95ms} / ${o.maxms}`);
  line('Отменено выходным предохранителем', o.outboundBlocked);
  line('Ошибки', o.errors);

  process.stdout.write('\nПо группам: утечка | обезличено | локально || обычные: дошли | без изменений\n');
  for (const [key, group] of Object.entries(summary.groups)) {
    const pii = group.piiSamples > 0 ? `${percent(group.leakRate).padStart(7)} | ${percent(group.piiSentRate).padStart(7)} | ${percent(group.piiLocalRate).padStart(7)}` : ' '.repeat(29);
    const benign = group.benignSamples > 0 ? ` || ${percent(group.benignSentRate).padStart(7)} | ${percent(group.benignVerbatimRate).padStart(7)}` : '';
    const meaning = ` || смысл ${percent(group.specialtyCoverage)}/${percent(group.timeCoverage)}/${percent(group.placeCoverage)}`;
    process.stdout.write(`  ${key.padEnd(30)} n=${String(group.samples).padStart(5)}  ${pii}${benign}${meaning}\n`);
  }

  if (examples > 0) {
    const leaked = results.filter((item) => item.leaks.length > 0);
    process.stdout.write(`\nУтечки (${leaked.length}), первые ${Math.min(examples, leaked.length)}:\n`);
    for (const item of leaked.slice(0, examples)) {
      process.stdout.write(`  [${item.category}/${item.variant || '-'}] ${item.messages.join(' || ')}\n      ушло: ${item.outbound.join(' | ').slice(0, 220)}\n      утекло: ${item.leaks.map((leak) => `${leak.kind}:${leak.value}`).join(', ')}\n`);
    }
    const refused = results.filter((item) => item.benign && !item.sent);
    process.stdout.write(`\nОбычные запросы, не дошедшие до модели (${refused.length}), первые ${Math.min(examples, refused.length)}:\n`);
    for (const item of refused.slice(0, examples)) process.stdout.write(`  ${item.messages.join(' || ')}  [${item.decision}/${item.reason}]\n`);
    const mangled = results.filter((item) => item.benign && item.piiTokens > 0);
    process.stdout.write(`\nОбычные запросы с лишними метками (${mangled.length}), первые ${Math.min(examples, mangled.length)}:\n`);
    for (const item of mangled.slice(0, examples)) process.stdout.write(`  ${item.messages.join(' || ')}  →  ${item.outbound.join(' | ').slice(0, 160)}\n`);
  }

  if (examples > 0) {
    const lost = results.filter((item) => item.coverage && Object.values(item.coverage).some((value) => value === false));
    process.stdout.write(`\nПотеря смысла (${lost.length}), первые ${Math.min(examples, lost.length)}:\n`);
    for (const item of lost.slice(0, examples)) {
      const missing = Object.entries(item.coverage).filter(([, value]) => !value).map(([key]) => key).join(',');
      process.stdout.write(`  [${item.category}] ${item.messages.join(' || ')}  — потеряно: ${missing}\n      ушло: ${item.outbound.join(' | ').slice(0, 200)}\n`);
    }
  }

  if (out) {
    await fs.writeFile(out, JSON.stringify({ summary, results }, null, 1));
    process.stderr.write(`Результаты: ${out}\n`);
  }
};

main().catch((error) => {
  process.stderr.write(`Ошибка: ${error?.stack || error}\n`);
  process.exit(1);
});
