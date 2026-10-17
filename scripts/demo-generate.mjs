#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * npm run demo:generate — пересобирает статичную часть демо-набора (клиники, врачи,
 * услуги, цены, графики, программы ДМС) в data/demo/generated.js из backend/demo/generator.js.
 * Результат детерминирован (тот же seed — тот же файл байт в байт), tests/demo-data.test.js
 * сверяет файл с генератором. Реальные данные не затрагиваются: пишется только этот файл.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateDemoCatalog } from '../backend/demo/generator.js';
import { renderGeneratedModule } from '../backend/demo/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(ROOT, 'data/demo/generated.js');

const catalog = generateDemoCatalog();
await fs.writeFile(target, renderGeneratedModule(catalog), 'utf8');
console.log(`Демо-набор записан в ${path.relative(ROOT, target)}: клиник ${catalog.clinics.length}, филиалов ${catalog.clinics.reduce((sum, clinic) => sum + clinic.branches.length, 0)}, врачей ${catalog.doctors.length}, программ ДМС ${catalog.insurance.plans.length}.`);
