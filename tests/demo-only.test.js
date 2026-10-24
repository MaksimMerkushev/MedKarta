/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * «Только демо» (DEMO_DATA=on и DEMO_ONLY=on): на карте, в подборе и в ответах
 * ассистента — только вымышленные клиники и врачи. Реальных клиник из OSM,
 * реальных клиник с демо-врачами и справочника врачей нет; запись работает,
 * все специальности на месте.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import configHandler from '../backend/api/config.js';
import { createBookingStore, loadSqlite } from '../backend/demo/bookingStore.js';
import { fictionalOnly, getDemoCatalog } from '../backend/demo/catalog.js';
import { demoOnlyEnabled } from '../backend/demo/flags.js';
import { createDemoSearch } from '../backend/demo/search.js';
import { moscowMoment } from '../backend/demo/time.js';
import { loadCatalog, __resetCatalogCache } from '../backend/privacy/catalog.js';
import { demoCatalog } from '../data/demo/generated.js';

const DatabaseSync = await loadSqlite();
const NOW = moscowMoment('2026-10-19', '10:00');
const SAVED = { DEMO_DATA: process.env.DEMO_DATA, DEMO_ONLY: process.env.DEMO_ONLY, PUBLIC_CLINICS: process.env.PUBLIC_CLINICS };

const configOf = async () => {
  let body = '';
  const res = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(chunk) { body = chunk; } };
  await configHandler({ method: 'GET', headers: {} }, res);
  return JSON.parse(body);
};

before(() => {
  process.env.DEMO_DATA = 'on';
  process.env.DEMO_ONLY = 'on';
  delete process.env.PUBLIC_CLINICS;
  __resetCatalogCache();
});

after(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetCatalogCache();
});

describe('«Только демо»', () => {
  it('флаг действует только вместе с DEMO_DATA=on и виден в /api/config', async () => {
    assert.equal(demoOnlyEnabled({ DEMO_DATA: 'on', DEMO_ONLY: 'on' }), true);
    assert.equal(demoOnlyEnabled({ DEMO_ONLY: 'on' }), false);
    assert.equal(demoOnlyEnabled({ DEMO_DATA: 'on' }), false);
    const config = await configOf();
    assert.equal(config.demo, true);
    assert.equal(config.demoOnly, true);
  });

  it('набор без реальных клиник: врачи, цены и ДМС — только вымышленных филиалов, все специальности на месте', () => {
    const fictional = fictionalOnly(demoCatalog);
    assert.ok(demoCatalog.clinics.some((clinic) => clinic.real), 'в полном наборе есть реальные клиники');
    assert.ok(fictional.clinics.length > 0 && fictional.clinics.every((clinic) => !clinic.real));
    const branches = new Set(fictional.clinics.flatMap((clinic) => clinic.branches.map((branch) => branch.id)));
    assert.ok(fictional.doctors.every((doctor) => doctor.branchIds.every((id) => branches.has(id))));
    assert.ok(fictional.prices.every((price) => branches.has(price.branchId)));
    assert.ok(fictional.insurance.coverage.every((item) => branches.has(item.branchId)));
    const all = new Set(demoCatalog.doctors.map((doctor) => doctor.specialtyKey));
    const left = new Set(fictional.doctors.map((doctor) => doctor.specialtyKey));
    assert.deepEqual([...left].sort(), [...all].sort());
  });

  it('ассистент знает только вымышленные клиники и врачей', async () => {
    const catalog = await loadCatalog();
    assert.ok(catalog.doctors.length > 0 && catalog.clinics.length > 0);
    for (const doctor of catalog.doctors) assert.match(String(doctor.id), /^demo-/, `не демо: ${doctor.id}`);
    const fictionalBranches = new Set(fictionalOnly(demoCatalog).clinics.flatMap((clinic) => clinic.branches.map((branch) => branch.id)));
    for (const clinic of catalog.clinics) assert.ok(fictionalBranches.has(clinic.id), `не вымышленная клиника: ${clinic.id} ${clinic.name}`);
  });

  it('подбор и запись — только у вымышленных клиник', { skip: !DatabaseSync && 'нужен Node 22.13+ (node:sqlite)' }, async () => {
    const index = await getDemoCatalog();
    assert.ok([...index.branches.values()].every(({ clinic }) => !clinic.real));
    const store = createBookingStore({ DatabaseSync, file: ':memory:', index, now: () => NOW });
    try {
      const search = createDemoSearch({ index, store, getEngine: async () => null, now: () => NOW });
      for (const specialty of ['therapist', 'lor', 'dentist', 'cardiologist']) {
        const found = await search.search({ specialty, date: { kind: 'tomorrow' } });
        assert.equal(found.status, 'ok', `${specialty}: ${found.message}`);
        assert.ok(found.options.every((option) => !option.clinic.real && !option.clinic.branchId.startsWith('demo-real-')), specialty);
      }
    } finally {
      store.close();
    }
  });
});
