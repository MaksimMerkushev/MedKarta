#!/usr/bin/env node
/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * npm run demo:generate — пересобирает статичную часть демо-набора
 * (клиники, врачи, услуги, цены, графики, программы ДМС) в
 * data/demo/generated.js из генератора backend/demo/generator.js.
 *
 * Результат детерминирован: при том же seed файл получается байт в байт
 * тем же. Тест tests/demo-data.test.js сверяет файл с генератором, так что
 * правка генератора без пересборки файла не пройдёт незамеченной.
 * Реальные данные (врачи госучреждений, OSM, собранный справочник) не
 * затрагиваются: пишется только этот файл.
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
