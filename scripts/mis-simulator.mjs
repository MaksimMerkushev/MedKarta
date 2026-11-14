#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Локальный симулятор МИС для разработки и демонстрации (API вымышлен).
 *
 *   node scripts/mis-simulator.mjs --port 3195 [--clinic demo-yasen] [--seed]
 *
 * --seed записывает интеграцию «sim-demo» и соответствия в журнал интеграций
 * (INTEGRATIONS_DB_PATH, по умолчанию var/integrations/integrations.sqlite).
 * Затем сервер МедКарты запускается с
 *   MIS_INTEGRATIONS=on MIS_SIMULATOR=on MIS_SIM_DEMO=<токен, который печатает скрипт>
 * В production не запускается.
 */

import { randomBytes } from 'node:crypto';

import { loadSqlite } from '../backend/demo/bookingStore.js';
import { integrationsDbPath } from '../backend/booking/mis/default.js';
import { createMisLedger } from '../backend/booking/mis/ledger.js';
import { createMisSimulator } from '../backend/booking/mis/simulator/server.js';
import { seedSimulatorIntegration, simulatorDataForClinic } from '../backend/booking/mis/simulator/demoClinic.js';
import { demoCatalog } from '../data/demo/generated.js';

if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
  console.error('Симулятор МИС в production не запускается.');
  process.exit(2);
}
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const port = Number(option('port', 3195));
const clinicId = option('clinic', 'demo-yasen');
const token = process.env.MIS_SIM_DEMO || randomBytes(16).toString('base64url');

const { simulator, mappings, clinic } = simulatorDataForClinic(demoCatalog, clinicId);
const sim = createMisSimulator({ ...simulator, token });
const url = await sim.listen(port);
console.log(`Симулятор МИС (вымышленный API): ${url} — клиника «${clinic.name}», врачей ${simulator.doctors.length}, дней ${simulator.days.length}`);
if (process.argv.includes('--seed')) {
  const DatabaseSync = await loadSqlite();
  const ledger = createMisLedger({ DatabaseSync, file: integrationsDbPath() });
  seedSimulatorIntegration(ledger, { clinicId, baseUrl: url, mappings });
  ledger.close();
  console.log(`Интеграция sim-demo записана в ${integrationsDbPath()}`);
}
console.log(`Сервер МедКарты: MIS_INTEGRATIONS=on MIS_SIMULATOR=on MIS_SIM_DEMO=${token} …`);
