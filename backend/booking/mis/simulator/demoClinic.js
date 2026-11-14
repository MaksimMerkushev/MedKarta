/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Симулятор МИС для одной вымышленной клиники демо-набора: её филиалы и
 * врачи получают внешние id симулятора (B-1, D-1, V-1), а в журнал
 * интеграций пишутся интеграция и таблица соответствий. После этого подбор,
 * ассистент и запись работают с клиникой как с подключённой через МИС.
 * Только для разработки, тестов и демонстрации: данные синтетические.
 */

import { addDays, moscowDay } from '../../../demo/time.js';

/**
 * @param {object} catalog демо-набор (data/demo/generated.js → demoCatalog)
 * @param {string} clinicId вымышленная клиника, например demo-yasen
 * @param {number} [days] сколько дней расписания от завтра
 */
export const simulatorDataForClinic = (catalog, clinicId, { days = 7, now = Date.now() } = {}) => {
  const clinic = catalog.clinics.find((item) => item.id === clinicId);
  if (!clinic || clinic.real) throw new Error(`Симулятор: нужна вымышленная клиника демо-набора, а не «${clinicId}».`);
  const branchIds = clinic.branches.map((branch) => branch.id);
  const doctors = catalog.doctors.filter((doctor) => doctor.branchIds.some((id) => branchIds.includes(id)));
  const branchMap = new Map(branchIds.map((id, index) => [id, `B-${index + 1}`]));
  const services = [...new Set(doctors.map((doctor) => doctor.serviceIds[0]))];
  const serviceMap = new Map(services.map((id, index) => [id, `V-${index + 1}`]));
  const doctorMap = new Map(doctors.map((doctor, index) => [doctor.id, `D-${index + 1}`]));
  const today = moscowDay(now);
  return {
    clinic,
    simulator: {
      branches: clinic.branches.map((branch) => ({ id: branchMap.get(branch.id), name: branch.name, address: branch.address })),
      doctors: doctors.map((doctor) => ({
        id: doctorMap.get(doctor.id), name: doctor.name, specialty: doctor.specialtyKey,
        branchIds: doctor.branchIds.filter((id) => branchMap.has(id)).map((id) => branchMap.get(id)), serviceId: serviceMap.get(doctor.serviceIds[0]),
      })),
      services: services.map((id) => ({ id: serviceMap.get(id), name: id, price: 1500, durationMinutes: 30 })),
      days: Array.from({ length: days }, (_, index) => addDays(today, index + 1)),
    },
    mappings: [
      ...[...branchMap].map(([medkarta, external]) => ['branch', external, medkarta]),
      ...[...doctorMap].map(([medkarta, external]) => ['doctor', external, medkarta]),
      ...[...serviceMap].map(([medkarta, external]) => ['service', external, medkarta]),
    ],
  };
};

/** Записать интеграцию симулятора и соответствия в журнал. */
export const seedSimulatorIntegration = (ledger, { id = 'sim-demo', clinicId, baseUrl, mappings, secretEnv = 'MIS_SIM_DEMO', title = 'Симулятор МИС (демо)' }) => {
  ledger.upsertIntegration({ id, clinicId, misType: 'mis-simulator', title, enabled: true, config: { baseUrl }, secretEnv });
  for (const [kind, external, medkarta] of mappings) ledger.setMapping(id, kind, external, medkarta);
  return ledger.getIntegration(id);
};
