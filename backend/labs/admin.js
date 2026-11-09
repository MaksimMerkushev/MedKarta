/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Лаборатории в админ-панели. Сессию, второй фактор и admin.access проверяет
 * api/admin.js; здесь — конкретное разрешение и журнал действий. Скрытая кнопка
 * в интерфейсе не защищает: решает только сервер.
 *
 *   labs.view      — просмотр лабораторий, филиалов, исследований и цен;
 *   labs.manage    — создание и изменение: лаборатории, филиалы, расписания,
 *                    исследования, цены, доступность, сроки, процедуры;
 *   labs.bookings  — демо-записи в лаборатории: просмотр и отмена.
 */

import { LabError } from './store.js';

export const LAB_ADMIN_PERMISSIONS = Object.freeze({
  labsOverview: 'labs.view',
  labsCreate: 'labs.manage',
  labsUpdate: 'labs.manage',
  labsBranches: 'labs.view',
  labsBranchCreate: 'labs.manage',
  labsBranchUpdate: 'labs.manage',
  labsBranchOfferings: 'labs.view',
  labsOfferingPut: 'labs.manage',
  labsOfferingDelete: 'labs.manage',
  labsFeePut: 'labs.manage',
  labsTests: 'labs.view',
  labsTestCreate: 'labs.manage',
  labsTestUpdate: 'labs.manage',
  labsBookings: 'labs.bookings',
  labsBookingCancel: 'labs.bookings',
});

export const LAB_ADMIN_ROUTES = Object.freeze([
  ['GET', '/api/admin/labs', 'labsOverview'],
  ['POST', '/api/admin/labs', 'labsCreate'],
  ['GET', '/api/admin/labs/branches', 'labsBranches'],
  ['POST', '/api/admin/labs/branches', 'labsBranchCreate'],
  ['PATCH', '/api/admin/labs/branches/:id', 'labsBranchUpdate'],
  ['GET', '/api/admin/labs/branches/:id/offerings', 'labsBranchOfferings'],
  ['PUT', '/api/admin/labs/branches/:id/offerings/:code', 'labsOfferingPut'],
  ['DELETE', '/api/admin/labs/branches/:id/offerings/:code', 'labsOfferingDelete'],
  ['PUT', '/api/admin/labs/branches/:id/fees/:kind', 'labsFeePut'],
  ['GET', '/api/admin/labs/tests', 'labsTests'],
  ['POST', '/api/admin/labs/tests', 'labsTestCreate'],
  ['PATCH', '/api/admin/labs/tests/:code', 'labsTestUpdate'],
  ['GET', '/api/admin/labs/bookings', 'labsBookings'],
  ['POST', '/api/admin/labs/bookings/:number/cancel', 'labsBookingCancel'],
  ['PATCH', '/api/admin/labs/:id', 'labsUpdate'],
]);

export const LAB_ADMIN_WITH_BODY = Object.freeze(new Set(['labsCreate', 'labsUpdate', 'labsBranchCreate', 'labsBranchUpdate', 'labsOfferingPut', 'labsFeePut', 'labsTestCreate', 'labsTestUpdate']));

/**
 * @param {object} deps
 * @param {() => Promise<object|null>} deps.getService лабораторный сервис (labs/service.js)
 * @param {(actor, action, fields) => void} deps.audit запись в журнал действий
 */
export const createLabAdmin = ({ getService, audit }) => {
  const run = async (actor, operation, { params = {}, query = {}, body = {} } = {}) => {
    const permission = LAB_ADMIN_PERMISSIONS[operation];
    if (!permission) throw new LabError('not_found', 'Not found', 404);
    if (!actor?.permissions?.includes(permission)) {
      if (permission !== 'labs.view') audit(actor, `labs.${operation}`, { result: 'denied', details: { code: 'forbidden' } });
      throw new LabError('forbidden', 'Недостаточно прав.', 403);
    }
    const service = await getService();
    if (!service) throw new LabError('labs_disabled', 'Раздел лабораторий выключен (нужны DEMO_DATA=on и LABS≠off).', 404);
    const { store } = service;
    const log = (action, target, details = null) => audit(actor, action, { targetId: target?.id || null, targetLabel: target?.label || null, details });

    switch (operation) {
      case 'labsOverview':
        return { labs: store.listLabs({ includeInactive: true }), stats: store.stats(), demo: true };
      case 'labsCreate': {
        const lab = store.createLab(body);
        log('labs.lab_create', { id: lab.id, label: lab.name });
        return lab;
      }
      case 'labsUpdate': {
        const before = store.getLab(params.id);
        if (!before) throw new LabError('not_found', 'Лаборатория не найдена.', 404);
        const lab = store.updateLab(params.id, body);
        log('labs.lab_update', { id: lab.id, label: lab.name }, { fields: Object.keys(body || {}).filter((key) => key !== 'version') });
        return lab;
      }
      case 'labsBranches': {
        const labId = typeof query.labId === 'string' ? query.labId : null;
        return { branches: store.listBranches({ labId, includeInactive: true }).map((branch) => ({ ...branch, fees: store.branchFees(branch.id) })) };
      }
      case 'labsBranchCreate': {
        const branch = store.createBranch(body);
        log('labs.branch_create', { id: branch.id, label: branch.name });
        return branch;
      }
      case 'labsBranchUpdate': {
        if (!store.getBranch(params.id)) throw new LabError('not_found', 'Филиал не найден.', 404);
        const branch = store.updateBranch(params.id, body);
        log('labs.branch_update', { id: branch.id, label: branch.name }, { fields: Object.keys(body || {}).filter((key) => key !== 'version') });
        return branch;
      }
      case 'labsBranchOfferings': {
        const branch = store.getBranch(params.id);
        if (!branch) throw new LabError('not_found', 'Филиал не найден.', 404);
        return { branch, offerings: store.branchOfferings(params.id), fees: store.branchFees(params.id) };
      }
      case 'labsOfferingPut': {
        const branch = store.getBranch(params.id);
        if (!branch) throw new LabError('not_found', 'Филиал не найден.', 404);
        const previous = store.branchOfferings(params.id).find((item) => item.testCode === params.code) || null;
        const offering = store.upsertOffering({
          branchId: params.id, testCode: params.code, price: body.price, available: body.available !== false,
          turnaroundHours: body.turnaroundHours, conditions: body.conditions ?? null, priceDate: body.priceDate ?? null,
        });
        log('labs.offering_put', { id: `${params.id}:${params.code}`, label: `${branch.name}: ${offering.testName}` }, {
          price: offering.price, previousPrice: previous?.price ?? null, available: offering.available, turnaroundHours: offering.turnaroundHours,
        });
        return offering;
      }
      case 'labsOfferingDelete': {
        const branch = store.getBranch(params.id);
        if (!branch) throw new LabError('not_found', 'Филиал не найден.', 404);
        const removed = store.deleteOffering({ branchId: params.id, testCode: params.code });
        if (removed) log('labs.offering_delete', { id: `${params.id}:${params.code}`, label: `${branch.name}: ${params.code}` });
        return { removed };
      }
      case 'labsFeePut': {
        const branch = store.getBranch(params.id);
        if (!branch) throw new LabError('not_found', 'Филиал не найден.', 404);
        const fee = store.setFee({ branchId: params.id, kind: params.kind, price: body.price === null ? null : body.price });
        log('labs.fee_put', { id: `${params.id}:${params.kind}`, label: branch.name }, { kind: params.kind, price: fee?.price ?? null });
        return { fee };
      }
      case 'labsTests':
        return { tests: store.listTests({ includeInactive: true, synonyms: true }) };
      case 'labsTestCreate': {
        const test = store.createTest(body);
        log('labs.test_create', { id: test.code, label: test.name });
        return test;
      }
      case 'labsTestUpdate': {
        const test = store.updateTest(params.code, body);
        log('labs.test_update', { id: test.code, label: test.name }, { fields: Object.keys(body || {}).filter((key) => key !== 'version') });
        return test;
      }
      case 'labsBookings': {
        const page = Math.max(Number(query.page) || 1, 1);
        const pageSize = Math.min(Math.max(Number(query.pageSize) || 50, 1), 200);
        const result = store.listBookings({ status: query.status || null, labId: query.labId || null, fromDay: query.from || null, toDay: query.to || null, limit: pageSize, offset: (page - 1) * pageSize });
        return { ...result, page, pageSize };
      }
      case 'labsBookingCancel': {
        const result = store.adminCancel({ number: params.number });
        if (!result.alreadyCancelled) log('labs.booking_cancel', { id: result.number, label: `${result.lab?.name || ''} ${result.number}`.trim() }, { slotReleased: result.slotReleased });
        return result;
      }
      default:
        throw new LabError('not_found', 'Not found', 404);
    }
  };
  return Object.freeze({ run });
};
