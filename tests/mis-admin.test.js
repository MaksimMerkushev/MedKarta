/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Админ-операции интеграций с МИС: права (просмотр — integrations.view,
 * проверка и синхронизация — integrations.manage), журнал действий, секреты не
 * показываются. Симулятор, данные синтетические.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadSqlite } from '../backend/demo/bookingStore.js';
import { moscowDay } from '../backend/demo/time.js';
import { permissionsOf } from '../backend/accounts/rbac.js';
import { createMisAdmin } from '../backend/booking/mis/admin.js';
import { createMisLedger } from '../backend/booking/mis/ledger.js';
import { createMisRuntime } from '../backend/booking/mis/runtime.js';
import { createMisSimulator } from '../backend/booking/mis/simulator/server.js';

const DatabaseSync = await loadSqlite();
const actor = (role) => ({ id: `${role}-1`, role, permissions: permissionsOf(role) });

describe('МИС: админ-операции', { skip: !DatabaseSync && 'нужен node:sqlite' }, () => {
  let sim;
  let mis;
  const audit = [];
  const env = { MIS_INTEGRATIONS: 'on', MIS_SIMULATOR: 'on', MIS_SIM_ADMIN: 'secret-token-value' };
  let admin;
  before(async () => {
    sim = createMisSimulator({ branches: [{ id: 'B1', name: 'Филиал' }], doctors: [{ id: 'D1', name: 'Врач', specialty: 'therapist', branchIds: ['B1'], serviceId: 'V1' }], services: [{ id: 'V1', name: 'Приём', price: 1000 }], token: 'secret-token-value', days: [moscowDay(Date.now() + 86_400_000)] });
    const url = await sim.listen();
    const ledger = createMisLedger({ DatabaseSync, file: ':memory:' });
    ledger.upsertIntegration({ id: 'sim-admin', clinicId: 'c-1', misType: 'mis-simulator', title: 'Тест', enabled: true, config: { baseUrl: url }, secretEnv: 'MIS_SIM_ADMIN' });
    mis = { ledger, runtime: createMisRuntime({ ledger, env }) };
    admin = createMisAdmin({ getRuntime: async () => mis, audit: (who, action, fields) => audit.push({ who: who?.role, action, ...fields }), env });
  });
  after(async () => {
    await sim.close();
    mis.ledger.close();
  });

  it('пользователь и модератор — 403; администратор видит список, но секрет — только «задан»', async () => {
    await assert.rejects(admin.run(actor('user'), 'integrationsList'), { status: 403 });
    await assert.rejects(admin.run(actor('moderator'), 'integrationsList'), { status: 403 });
    const list = await admin.run(actor('admin'), 'integrationsList');
    assert.equal(list.enabled, true);
    assert.equal(list.integrations[0].secretSet, true);
    assert.doesNotMatch(JSON.stringify(list), /secret-token-value/u);
    const detail = await admin.run(actor('admin'), 'integrationsDetail', { params: { id: 'sim-admin' } });
    assert.doesNotMatch(JSON.stringify(detail), /secret-token-value/u);
  });

  it('проверка и синхронизация — только с integrations.manage; попытка без права и действие — в журнале', async () => {
    await assert.rejects(admin.run(actor('admin'), 'integrationsSync', { params: { id: 'sim-admin' } }), { status: 403 });
    assert.ok(audit.some((item) => item.action === 'integrations.integrationsSync' && item.result === 'denied'));
    const test = await admin.run(actor('superadmin'), 'integrationsTest', { params: { id: 'sim-admin' } });
    assert.equal(test.ok, true);
    const sync = await admin.run(actor('superadmin'), 'integrationsSync', { params: { id: 'sim-admin' } });
    assert.equal(sync.ok, true);
    assert.ok(audit.some((item) => item.action === 'integrations.sync' && item.result === 'ok'));
  });

  it('интеграции выключены — список пуст, подробности 404', async () => {
    const off = createMisAdmin({ getRuntime: async () => null, audit: () => {}, env: {} });
    assert.deepEqual((await off.run(actor('superadmin'), 'integrationsList')).integrations, []);
    await assert.rejects(off.run(actor('superadmin'), 'integrationsDetail', { params: { id: 'x' } }), { status: 404 });
  });
});
