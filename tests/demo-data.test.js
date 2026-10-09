/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Демо-набор: детерминированность, явная маркировка и логическая
 * согласованность — врачи только в своих филиалах и услугах, слоты только
 * в часы смены, длительность слота = длительность услуги, без наложений.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  absenceOn, DEMO_SEED, generateDaySlots, generateDemoCatalog, shiftIntervals, SLOT_WINDOW_DAYS, windowDays,
} from '../backend/demo/generator.js';
import { indexDemoCatalog, renderGeneratedModule } from '../backend/demo/catalog.js';
import { minutesOf, weekdayOf } from '../backend/demo/time.js';
import { demoCatalog } from '../data/demo/generated.js';
import { flattenPrivateCatalog, validatePrivateCatalog } from '../shared/privateCatalog.js';
import { demoPrivateCatalog } from '../data/demo/index.js';
import { coverageFor } from '../shared/dms.js';
import { kazanFacilities } from '../data/facilities.js';
import { createRoutingEngine } from '../backend/routing/engine.js';
import { loadGraph } from '../backend/routing/graph.js';

const GENERATED = fileURLToPath(new URL('../data/demo/generated.js', import.meta.url));
const REAL_GRAPH = fileURLToPath(new URL('../data/graph/kazan.graph', import.meta.url));
const HAS_REAL_GRAPH = fs.existsSync(REAL_GRAPH);

const catalog = generateDemoCatalog();
const index = indexDemoCatalog(catalog);
const serviceById = new Map(catalog.services.map((service) => [service.id, service]));
const START = '2026-10-12';
const days = windowDays(START, SLOT_WINDOW_DAYS);

describe('Демо-набор: воспроизводимость', () => {
  it('тот же seed — тот же набор, байт в байт', () => {
    assert.deepEqual(generateDemoCatalog({ seed: DEMO_SEED }), catalog);
    assert.equal(renderGeneratedModule(generateDemoCatalog()), renderGeneratedModule(catalog));
  });

  it('data/demo/generated.js совпадает с генератором (npm run demo:generate)', () => {
    assert.equal(fs.readFileSync(GENERATED, 'utf8'), renderGeneratedModule(catalog));
    assert.deepEqual(demoCatalog, JSON.parse(JSON.stringify(catalog)));
  });

  it('другой seed — другой набор', () => {
    const other = generateDemoCatalog({ seed: 'another-seed' });
    assert.notDeepEqual(other.doctors.map((doctor) => doctor.name), catalog.doctors.map((doctor) => doctor.name));
  });

  it('слоты на дату детерминированы', () => {
    const doctor = catalog.doctors[0];
    for (const day of days.slice(0, 5)) {
      assert.deepEqual(generateDaySlots(catalog, doctor, day), generateDaySlots(catalog, doctor, day));
    }
  });
});

describe('Демо-набор: объём', () => {
  it('10–15 клиник, 60–100 врачей, 15–20 специальностей, 3 программы ДМС', () => {
    assert.ok(catalog.clinics.length >= 10 && catalog.clinics.length <= 15, `клиник ${catalog.clinics.length}`);
    assert.ok(catalog.doctors.length >= 60 && catalog.doctors.length <= 100, `врачей ${catalog.doctors.length}`);
    const specialties = new Set(catalog.doctors.map((doctor) => doctor.specialtyKey));
    assert.ok(specialties.size >= 15 && specialties.size <= 20, `специальностей ${specialties.size}`);
    assert.deepEqual(catalog.insurance.plans.map((plan) => plan.name), ['Demo Basic', 'Demo Standard', 'Demo Premium']);
  });

  it('есть взрослые и детские врачи, процедуры и цены', () => {
    assert.ok(catalog.doctors.some((doctor) => doctor.ageGroups.includes('child') && !doctor.ageGroups.includes('adult')));
    assert.ok(catalog.doctors.some((doctor) => doctor.ageGroups.includes('adult') && doctor.ageGroups.includes('child')));
    assert.ok(catalog.services.some((service) => service.kind !== 'consult'));
    for (const doctor of catalog.doctors) {
      for (const branchId of doctor.branchIds) {
        for (const serviceId of doctor.serviceIds) {
          const price = index.priceOf(branchId, serviceId);
          assert.ok(Number.isInteger(price) && price >= 500 && price <= 15000, `${doctor.id} ${serviceId}: ${price}`);
        }
      }
    }
  });
});

describe('Демо-набор: маркировка и отделение от реальных данных', () => {
  it('каждая запись явно демонстрационная', () => {
    assert.equal(catalog.meta.source, 'demo');
    assert.match(catalog.meta.disclaimer, /вымышлены/);
    for (const clinic of catalog.clinics) {
      assert.match(clinic.name, /демо/i, clinic.name);
      assert.match(clinic.website, /^https:\/\/[a-z0-9-]+\.example$/);
      assert.match(clinic.description, /Демонстрационная/);
      for (const branch of clinic.branches) {
        assert.match(branch.address, /демо-адрес/);
        assert.match(branch.phone, /^\+7 \(843\) 000-\d{2}-00$/);
      }
    }
    for (const doctor of catalog.doctors) assert.match(doctor.description, /вымышленное лицо/);
    assert.ok(catalog.insurance.providers.every((provider) => provider.demo === true && /Демо/.test(provider.name)));
  });

  it('идентификаторы не пересекаются с OSM и реальным справочником', () => {
    const realIds = new Set(kazanFacilities.map((item) => String(item.id)));
    for (const clinic of catalog.clinics) {
      assert.match(clinic.id, /^demo-/);
      for (const branch of clinic.branches) {
        assert.match(branch.id, /^demo-/);
        assert.ok(!realIds.has(branch.id));
      }
    }
    for (const doctor of catalog.doctors) assert.match(doctor.id, /^demo-doc-/);
    const items = flattenPrivateCatalog(demoPrivateCatalog);
    assert.ok(items.every((item) => item.demo === true && item.source === 'demo' && /^demo-/.test(item.id)));
  });

  it('проходит проверку формата частного справочника', () => {
    assert.deepEqual(validatePrivateCatalog(demoPrivateCatalog), []);
  });

  it('точки филиалов — в Казани и не на адресах реальных учреждений из OSM', () => {
    for (const clinic of catalog.clinics) {
      for (const branch of clinic.branches) {
        assert.ok(branch.lat > 55.70 && branch.lat < 55.90 && branch.lng > 48.95 && branch.lng < 49.30, branch.id);
        const near = kazanFacilities.find((item) => Math.abs(item.lat - branch.lat) < 0.0004 && Math.abs(item.lng - branch.lng) < 0.0007);
        assert.equal(near, undefined, `${branch.id} стоит на точке реального учреждения ${near?.name}`);
      }
    }
  });
});

describe('Демо-набор: согласованность расписаний', () => {
  it('врач работает только в филиалах своей клиники и в часы филиала', () => {
    const hoursKeyOf = new Map(catalog.clinics.map((clinic) => [clinic.id, clinic]));
    for (const doctor of catalog.doctors) {
      const clinicIds = new Set(doctor.branchIds.map((branchId) => index.branches.get(branchId).clinic.id));
      assert.equal(clinicIds.size, 1, `${doctor.id} работает в разных клиниках`);
      for (const entry of doctor.schedule) {
        assert.ok(doctor.branchIds.includes(entry.branchId), `${doctor.id}: смена в чужом филиале`);
        assert.ok(minutesOf(entry.start) < minutesOf(entry.end));
        if (entry.breakAt) {
          assert.ok(minutesOf(entry.breakAt[0]) > minutesOf(entry.start) && minutesOf(entry.breakAt[1]) < minutesOf(entry.end));
        }
      }
      assert.ok(hoursKeyOf.has([...clinicIds][0]));
    }
  });

  it('в один день у врача не больше одной смены', () => {
    for (const doctor of catalog.doctors) {
      const weekdays = doctor.schedule.map((entry) => entry.weekday);
      assert.equal(new Set(weekdays).size, weekdays.length, doctor.id);
    }
  });

  it('слоты: внутри смены, вне перерыва, длительность = услуге, без наложений, ≥14 дней', () => {
    let total = 0;
    let evening = 0;
    let absences = 0;
    for (const doctor of catalog.doctors) {
      for (const day of days) {
        const { absence, slots } = generateDaySlots(catalog, doctor, day);
        const entry = doctor.schedule.find((item) => item.weekday === weekdayOf(day));
        if (absence) {
          absences += 1;
          assert.equal(slots.length, 0);
          continue;
        }
        if (!entry) {
          assert.equal(slots.length, 0, `${doctor.id} ${day}: слоты в нерабочий день`);
          continue;
        }
        const intervals = shiftIntervals(entry);
        let previousEnd = -1;
        for (const slot of [...slots].sort((left, right) => minutesOf(left.start) - minutesOf(right.start))) {
          const start = minutesOf(slot.start);
          const end = minutesOf(slot.end);
          assert.ok(doctor.serviceIds.includes(slot.serviceId), `${slot.id}: чужая услуга`);
          assert.equal(slot.branchId, entry.branchId);
          assert.equal(end - start, serviceById.get(slot.serviceId).durationMinutes, slot.id);
          assert.ok(intervals.some(([from, to]) => start >= from && end <= to), `${slot.id}: вне смены или в перерыве`);
          assert.ok(start >= previousEnd, `${slot.id}: наложение`);
          assert.ok(['FREE', 'BOOKED', 'BLOCKED'].includes(slot.status));
          previousEnd = end;
          if (start >= 18 * 60) evening += 1;
        }
        total += slots.length;
      }
    }
    assert.ok(total > 5000, `слотов ${total}`);
    assert.ok(evening > 300, `вечерних слотов ${evening}`);
    assert.ok(absences > 0, 'должны быть отпуска и отгулы');
  });

  it('нет слота позже конца смены: у врача, работающего до 18:00, нет приёма в 21:00', () => {
    for (const doctor of catalog.doctors) {
      for (const day of days) {
        const entry = doctor.schedule.find((item) => item.weekday === weekdayOf(day));
        if (!entry) continue;
        for (const slot of generateDaySlots(catalog, doctor, day).slots) {
          assert.ok(minutesOf(slot.end) <= minutesOf(entry.end));
          assert.ok(minutesOf(slot.start) >= minutesOf(entry.start));
        }
      }
    }
  });

  it('отсутствия детерминированы и бывают недельными (отпуск)', () => {
    const doctor = catalog.doctors.find((item) => days.some((day) => absenceOn(DEMO_SEED, item.id, day) === 'vacation'));
    assert.ok(doctor, 'хотя бы у одного врача отпуск в окне');
    for (const day of days) assert.equal(absenceOn(DEMO_SEED, doctor.id, day), absenceOn(DEMO_SEED, doctor.id, day));
  });
});

describe('Демо-набор: программы ДМС различаются', () => {
  const insurance = catalog.insurance;
  const lor = catalog.doctors.find((doctor) => doctor.specialtyKey === 'lor' && doctor.branchIds.some((id) => id.startsWith('demo-beresta')));
  const branchId = lor.branchIds[0];
  const target = { entityKind: 'doctor', clinicId: 'demo-beresta', branchId, specialtyKey: 'lor', pediatric: false };

  it('Basic: ЛОР в эконом-сети — напрямую, процедура — нет', () => {
    assert.equal(coverageFor(insurance, 'demo-basic', target, { serviceId: 'consult.lor.first', today: '2026-10-12' }).status, 'covered');
    assert.equal(coverageFor(insurance, 'demo-basic', target, { serviceId: 'proc.lor.tonsils', today: '2026-10-12' }).status, 'not_covered');
  });

  it('Basic не покрывает детей и премиальные клиники; Premium — покрывает', () => {
    const premiumClinic = catalog.clinics.find((clinic) => clinic.tier === 'premium');
    const premiumTarget = { entityKind: 'doctor', clinicId: premiumClinic.id, branchId: premiumClinic.branches[0].id, specialtyKey: 'therapist', pediatric: false };
    assert.equal(coverageFor(insurance, 'demo-basic', premiumTarget, { serviceId: 'consult.therapist.first', today: '2026-10-12' }).status, 'not_covered');
    assert.equal(coverageFor(insurance, 'demo-premium', premiumTarget, { serviceId: 'consult.therapist.first', today: '2026-10-12' }).status, 'covered');
    assert.equal(coverageFor(insurance, 'demo-basic', { ...target, pediatric: true }, { serviceId: 'consult.lor.first', today: '2026-10-12' }).status, 'not_covered');
  });

  it('Standard: процедура — по согласованию, психиатрия — исключена', () => {
    const procedure = coverageFor(insurance, 'demo-standard', target, { serviceId: 'proc.lor.tonsils', today: '2026-10-12' });
    assert.equal(procedure.status, 'covered');
    assert.equal(procedure.access, 'approval_required');
    const psychiatrist = catalog.doctors.find((doctor) => doctor.specialtyKey === 'psychiatrist');
    const psyBranch = psychiatrist.branchIds[0];
    const psyClinic = index.branches.get(psyBranch).clinic.id;
    const result = coverageFor(insurance, 'demo-standard', { entityKind: 'doctor', clinicId: psyClinic, branchId: psyBranch, specialtyKey: 'psychiatrist', pediatric: false }, { serviceId: 'consult.psychiatrist.first', today: '2026-10-12' });
    assert.equal(result.status, 'not_covered');
  });
});

describe('Демо-набор: точки филиалов на графе дорог', { skip: !HAS_REAL_GRAPH && 'нет data/graph/kazan.graph' }, () => {
  it('каждый филиал привязывается к дороге', async () => {
    const engine = createRoutingEngine({ graph: await loadGraph(REAL_GRAPH) });
    for (const clinic of catalog.clinics) {
      for (const branch of clinic.branches) {
        assert.ok(engine.snapsToNetwork({ lat: branch.lat, lng: branch.lng }, 'driving'), branch.id);
      }
    }
  });
});
