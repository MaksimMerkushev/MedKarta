/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ ДМС. СТРАХОВЫЕ, ПРОГРАММЫ И ТЕЛЕФОНЫ ВЫМЫШЛЕНЫ.
 *
 * Показывает модель «страховая → программа → покрытие по филиалам» на
 * демо-клиниках из data/demo/private.js. В программах намеренно есть все
 * режимы доступа (напрямую, через пульт, по направлению, по согласованию,
 * исключение), детская программа и просроченная — чтобы проверить каждую
 * ветку логики. Реальные программы появятся из памяток ДМС (уровень 1)
 * и выгрузок работодателя или брокера (уровень 2).
 */

export const demoInsurance = {
  meta: { source: 'demo', verifiedAt: '2026-09-28' },

  providers: [
    {
      id: 'demo-strakh',
      name: 'СтрахДемо',
      pultPhone: '+7 (800) 000-00-01',
      bookingNote: 'К специалистам — через пульт: назовите номер полиса и удобное время, пульт сам запишет и пришлёт гарантийное письмо в клинику.',
    },
    {
      id: 'demo-primer',
      name: 'Пример-Мед',
      pultPhone: '+7 (800) 000-00-02',
      bookingNote: 'Терапевт и педиатр — напрямую в клинику с полисом. Узкие специалисты — по направлению терапевта.',
    },
  ],

  plans: [
    { id: 'demo-strakh-basic', providerId: 'demo-strakh', name: 'Базовая', insured: 'adult', validFrom: '2026-01-01', validTo: '2026-12-31', sourceDoc: 'Демо-памятка «Базовая», 2026' },
    { id: 'demo-strakh-optimum', providerId: 'demo-strakh', name: 'Оптимум', insured: 'adult', validFrom: '2026-01-01', validTo: '2026-12-31', sourceDoc: 'Демо-памятка «Оптимум», 2026' },
    { id: 'demo-strakh-kids', providerId: 'demo-strakh', name: 'Детская', insured: 'child', validFrom: '2026-01-01', validTo: '2026-12-31', sourceDoc: 'Демо-памятка «Детская», 2026' },
    { id: 'demo-primer-family', providerId: 'demo-primer', name: 'Семейная', insured: 'family', validFrom: '2026-03-01', validTo: '2027-02-28', sourceDoc: 'Демо-памятка «Семейная», 2026/27' },
    { id: 'demo-primer-2025', providerId: 'demo-primer', name: 'Старт 2025 (истекла)', insured: 'adult', validFrom: '2025-01-01', validTo: '2025-12-31', sourceDoc: 'Демо-памятка «Старт», 2025' },
  ],

  coverage: [
    // «Базовая»: только центр и Азино, специалисты — через пульт или по направлению.
    { planId: 'demo-strakh-basic', branchId: 'demo-zdorovie-center', scope: 'specialty', specialty: 'therapist', access: 'direct' },
    { planId: 'demo-strakh-basic', branchId: 'demo-zdorovie-center', scope: 'specialty', specialty: 'lor', access: 'via_pult' },
    { planId: 'demo-strakh-basic', branchId: 'demo-zdorovie-center', scope: 'specialty', specialty: 'neurologist', access: 'referral_required' },
    { planId: 'demo-strakh-basic', branchId: 'demo-zdorovie-center', scope: 'service', serviceId: 'diag.ultrasound.abdomen', access: 'approval_required' },
    { planId: 'demo-strakh-basic', branchId: 'demo-zdorovie-azino', scope: 'all_outpatient', access: 'via_pult' },
    { planId: 'demo-strakh-basic', branchId: 'demo-zdorovie-azino', scope: 'specialty', specialty: 'urologist', access: 'excluded', notes: 'Урология исключена из программы «Базовая».' },

    // «Оптимум»: вся сеть «Демо-Здоровье», дерматолог и гинеколог в профильных клиниках.
    { planId: 'demo-strakh-optimum', branchId: 'demo-zdorovie-center', scope: 'all_outpatient', access: 'direct' },
    { planId: 'demo-strakh-optimum', branchId: 'demo-zdorovie-azino', scope: 'all_outpatient', access: 'direct' },
    { planId: 'demo-strakh-optimum', branchId: 'demo-zdorovie-sever', scope: 'all_outpatient', access: 'via_pult' },
    { planId: 'demo-strakh-optimum', branchId: 'demo-derma-center', scope: 'specialty', specialty: 'dermatologist', access: 'via_pult', limitPerYear: 2, notes: 'Не более двух приёмов дерматолога в год.' },
    { planId: 'demo-strakh-optimum', branchId: 'demo-zhenskaya-kirov', scope: 'specialty', specialty: 'gynecologist', access: 'direct' },

    // «Детская»: «Демо-Малыш».
    { planId: 'demo-strakh-kids', branchId: 'demo-malysh-gorki', scope: 'all_outpatient', access: 'direct' },
    { planId: 'demo-strakh-kids', branchId: 'demo-malysh-derbyshki', scope: 'specialty', specialty: 'pediatrician', access: 'direct' },
    { planId: 'demo-strakh-kids', branchId: 'demo-malysh-derbyshki', scope: 'specialty', specialty: 'lor', access: 'via_pult' },
    { planId: 'demo-strakh-kids', branchId: 'demo-malysh-derbyshki', scope: 'specialty', specialty: 'ophthalmologist', access: 'referral_required' },
    { planId: 'demo-strakh-kids', branchId: 'demo-derma-center', scope: 'specialty', specialty: 'dermatologist', access: 'via_pult' },

    // «Семейная» (Пример-Мед): взрослые и дети, стоматология — по согласованию.
    { planId: 'demo-primer-family', branchId: 'demo-zdorovie-center', scope: 'all_outpatient', access: 'direct' },
    { planId: 'demo-primer-family', branchId: 'demo-malysh-gorki', scope: 'all_outpatient', access: 'direct' },
    { planId: 'demo-primer-family', branchId: 'demo-zhenskaya-kirov', scope: 'all_outpatient', access: 'direct' },
    { planId: 'demo-primer-family', branchId: 'demo-dent-avia', scope: 'specialty', specialty: 'dentist', access: 'approval_required', notes: 'Лечение — по согласованию; профилактический осмотр раз в год.' },

    // Просроченная программа: покрытие есть, но срок вышел.
    { planId: 'demo-primer-2025', branchId: 'demo-zdorovie-center', scope: 'all_outpatient', access: 'direct' },
  ],
};
