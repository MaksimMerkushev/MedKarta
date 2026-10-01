/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. ВСЕ КЛИНИКИ, ВРАЧИ, ЦЕНЫ И ТЕЛЕФОНЫ ВЫМЫШЛЕНЫ.
 *
 * Набор нужен, чтобы показать и проверить сценарии, для которых реальных
 * данных пока нет: частные клиники с ценами, вечерний и детский приём,
 * покрытие ДМС. Названия начинаются с «Демо», сайты — в зарезервированной
 * зоне .example, телефоны — с несуществующим кодом 000. Совпадения имён
 * с реальными врачами случайны.
 *
 * В интерфейсе эти записи видны только в демо-режиме и помечены плашкой
 * «Демо-данные»; на сервере — только при DEMO_DATA=on.
 */

const clinic = (id, name, extra) => ({ id, name, ownership: 'Частная', ...extra });

export const demoPrivateCatalog = {
  meta: { source: 'demo', verifiedAt: '2026-09-28' },

  clinics: [
    clinic('demo-zdorovie', 'Демо-Здоровье', {
      website: 'https://demo-zdorovie.example',
      facilityType: 'Медцентр',
      description: 'Демонстрационная многопрофильная клиника (вымышленная).',
      branches: [
        {
          id: 'demo-zdorovie-center', name: 'на Баумана', district: 'Вахитовский',
          address: 'Казань, ул. Баумана, 101 (демо-адрес)', lat: 55.7887, lng: 49.1221,
          phone: '+7 (843) 000-01-01', hours: 'Mo-Fr 08:00-21:00; Sa 09:00-17:00; Su 10:00-15:00',
          features: { wheelchair: true, parking: false, onlineBooking: true },
        },
        {
          id: 'demo-zdorovie-azino', name: 'в Азино', district: 'Советский',
          address: 'Казань, пр. Победы, 999 (демо-адрес)', lat: 55.7536, lng: 49.2047,
          phone: '+7 (843) 000-01-02', hours: 'Mo-Fr 08:00-20:00; Sa 09:00-15:00',
          features: { wheelchair: true, parking: true, onlineBooking: true },
        },
        {
          id: 'demo-zdorovie-sever', name: 'на Чистопольской', district: 'Ново-Савиновский',
          address: 'Казань, ул. Чистопольская, 999 (демо-адрес)', lat: 55.8237, lng: 49.1186,
          phone: '+7 (843) 000-01-03', hours: 'Mo-Fr 07:30-20:00; Sa 08:00-14:00',
          features: { wheelchair: false, parking: true, onlineBooking: true },
        },
      ],
    }),
    clinic('demo-malysh', 'Детская клиника Демо-Малыш', {
      website: 'https://demo-malysh.example',
      facilityType: 'Клиника',
      description: 'Демонстрационная детская клиника (вымышленная).',
      branches: [
        {
          id: 'demo-malysh-gorki', name: 'в Горках', district: 'Приволжский',
          address: 'Казань, ул. Рихарда Зорге, 999 (демо-адрес)', lat: 55.7650, lng: 49.1630,
          phone: '+7 (843) 000-02-01', hours: 'Mo-Su 08:00-21:00',
          features: { wheelchair: true, parking: true, onlineBooking: true },
        },
        {
          id: 'demo-malysh-derbyshki', name: 'в Дербышках', district: 'Советский',
          address: 'Казань, ул. Мира, 999 (демо-адрес)', lat: 55.8575, lng: 49.2230,
          phone: '+7 (843) 000-02-02', hours: 'Mo-Fr 08:00-20:00; Sa,Su 09:00-15:00',
          features: { wheelchair: false, parking: true, onlineBooking: false },
        },
      ],
    }),
    clinic('demo-derma', 'Дерма-Демо', {
      website: 'https://demo-derma.example',
      facilityType: 'Клиника',
      description: 'Демонстрационная дерматологическая клиника (вымышленная).',
      branches: [
        {
          id: 'demo-derma-center', name: 'у Кремля', district: 'Вахитовский',
          address: 'Казань, ул. Кремлёвская, 999 (демо-адрес)', lat: 55.7960, lng: 49.1160,
          phone: '+7 (843) 000-03-01', hours: 'Mo-Fr 09:00-20:00; Sa 10:00-16:00',
          features: { wheelchair: false, parking: false, onlineBooking: true },
        },
      ],
    }),
    clinic('demo-zhenskaya', 'Женская консультация Демо', {
      website: 'https://demo-zhenskaya.example',
      facilityType: 'Клиника',
      description: 'Демонстрационная женская консультация (вымышленная).',
      branches: [
        {
          id: 'demo-zhenskaya-kirov', name: 'в Кировском районе', district: 'Кировский',
          address: 'Казань, ул. Габишева, 999 (демо-адрес)', lat: 55.8040, lng: 49.0700,
          phone: '+7 (843) 000-04-01', hours: 'Mo-Fr 08:00-19:00; Sa 09:00-14:00',
          features: { wheelchair: true, parking: false, onlineBooking: true },
        },
      ],
    }),
    clinic('demo-dent', 'Демо-Стоматология', {
      website: 'https://demo-dent.example',
      facilityType: 'Стоматология',
      description: 'Демонстрационная стоматология (вымышленная).',
      branches: [
        {
          id: 'demo-dent-avia', name: 'на Королёва', district: 'Авиастроительный',
          address: 'Казань, ул. Королёва, 999 (демо-адрес)', lat: 55.8560, lng: 49.0880,
          phone: '+7 (843) 000-05-01', hours: 'Mo-Sa 09:00-21:00',
          features: { wheelchair: false, parking: true, onlineBooking: true },
        },
      ],
    }),
  ],

  doctors: [
    { id: 'demo-doc-veresova', name: 'Вересова Алина Тимуровна', specialty: 'Терапевт', branchIds: ['demo-zdorovie-center'], hours: 'Mo-Fr 14:00-21:00', experienceYears: 12 },
    { id: 'demo-doc-garifullin', name: 'Гарифуллин Рустем Ильдарович', specialty: 'ЛОР', branchIds: ['demo-zdorovie-center', 'demo-zdorovie-azino'], hours: 'Mo,We,Fr 16:00-21:00; Sa 10:00-14:00', experienceYears: 18 },
    { id: 'demo-doc-nurieva', name: 'Нуриева Камила Ринатовна', specialty: 'Невролог', branchIds: ['demo-zdorovie-center'], hours: 'Tu,Th 09:00-18:00', experienceYears: 9 },
    { id: 'demo-doc-sokolov', name: 'Соколов Глеб Аркадьевич', specialty: 'Кардиолог', branchIds: ['demo-zdorovie-center', 'demo-zdorovie-sever'], hours: 'Mo-Fr 09:00-15:00', experienceYears: 21 },
    { id: 'demo-doc-hairullina', name: 'Хайруллина Диляра Маратовна', specialty: 'Гинеколог', branchIds: ['demo-zdorovie-center'], hours: 'Mo-Fr 12:00-20:00', experienceYears: 14 },
    { id: 'demo-doc-belov', name: 'Белов Тимофей Андреевич', specialty: 'Офтальмолог', branchIds: ['demo-zdorovie-azino'], hours: 'Mo-Fr 10:00-19:00', experienceYears: 7 },
    { id: 'demo-doc-safina', name: 'Сафина Эльвира Наилевна', specialty: 'Терапевт', branchIds: ['demo-zdorovie-azino'], hours: 'Mo-Fr 08:00-20:00; Sa 09:00-15:00', experienceYears: 16 },
    { id: 'demo-doc-morozova', name: 'Морозова Вероника Олеговна', specialty: 'Эндокринолог', branchIds: ['demo-zdorovie-sever'], hours: 'Mo,We 09:00-17:00', experienceYears: 11 },
    { id: 'demo-doc-zakirov', name: 'Закиров Айдар Фаридович', specialty: 'Травматолог', branchIds: ['demo-zdorovie-sever'], hours: 'Mo-Sa 08:00-20:00', experienceYears: 13 },
    { id: 'demo-doc-lebedev', name: 'Лебедев Арсений Павлович', specialty: 'Уролог', branchIds: ['demo-zdorovie-azino'], hours: 'Tu,Th 15:00-20:00', experienceYears: 19 },
    { id: 'demo-doc-mingazova', name: 'Мингазова Алсу Ренатовна', specialty: 'Педиатр', branchIds: ['demo-malysh-gorki'], hours: 'Mo-Fr 08:00-15:00', experienceYears: 10 },
    { id: 'demo-doc-orlova', name: 'Орлова Ксения Викторовна', specialty: 'Педиатр', branchIds: ['demo-malysh-gorki', 'demo-malysh-derbyshki'], hours: 'Mo-Fr 15:00-21:00; Sa 09:00-15:00', experienceYears: 8 },
    { id: 'demo-doc-fatkullin', name: 'Фаткуллин Ильназ Рамилевич', specialty: 'Детский ЛОР', branchIds: ['demo-malysh-gorki'], hours: 'Mo-Fr 14:00-20:00', experienceYears: 15 },
    { id: 'demo-doc-pavlova', name: 'Павлова Ульяна Сергеевна', specialty: 'Детский ЛОР', branchIds: ['demo-malysh-derbyshki'], hours: 'Mo,We,Fr 09:00-14:00; Sa 09:00-13:00', experienceYears: 6 },
    { id: 'demo-doc-kim', name: 'Ким Виктория Эдуардовна', specialty: 'Детский невролог', branchIds: ['demo-malysh-gorki'], hours: 'Tu,Th 10:00-18:00', experienceYears: 12 },
    { id: 'demo-doc-sharipova', name: 'Шарипова Лейсан Фанисовна', specialty: 'Детский офтальмолог', branchIds: ['demo-malysh-derbyshki'], hours: 'Mo-Fr 10:00-18:00', experienceYears: 9 },
    { id: 'demo-doc-golubev', name: 'Голубев Матвей Ильич', specialty: 'Детский хирург', branchIds: ['demo-malysh-gorki'], hours: 'We,Fr 09:00-15:00', experienceYears: 20 },
    { id: 'demo-doc-valieva', name: 'Валиева Регина Азатовна', specialty: 'Дерматолог', branchIds: ['demo-derma-center'], hours: 'Mo-Fr 09:00-20:00; Sa 10:00-16:00', experienceYears: 13 },
    { id: 'demo-doc-titov', name: 'Титов Савелий Германович', specialty: 'Дерматолог', branchIds: ['demo-derma-center'], hours: 'Mo-Fr 15:00-20:00', experienceYears: 5 },
    { id: 'demo-doc-ahmetova', name: 'Ахметова Гульназ Рустемовна', specialty: 'Детский дерматолог', branchIds: ['demo-derma-center'], hours: 'Mo,We 16:00-20:00; Sa 10:00-16:00', experienceYears: 10 },
    { id: 'demo-doc-yusupova', name: 'Юсупова Айгуль Ринатовна', specialty: 'Гинеколог', branchIds: ['demo-zhenskaya-kirov'], hours: 'Mo-Fr 08:00-19:00', experienceYears: 17 },
    { id: 'demo-doc-romanova', name: 'Романова Полина Игоревна', specialty: 'Гинеколог', branchIds: ['demo-zhenskaya-kirov', 'demo-zdorovie-center'], hours: 'Tu,Th 13:00-19:00; Sa 09:00-14:00', experienceYears: 8 },
    { id: 'demo-doc-salikhov', name: 'Салихов Артур Робертович', specialty: 'Стоматолог', branchIds: ['demo-dent-avia'], hours: 'Mo-Sa 09:00-21:00', experienceYears: 11 },
    { id: 'demo-doc-egorova', name: 'Егорова Таисия Максимовна', specialty: 'Стоматолог', branchIds: ['demo-dent-avia'], hours: 'Mo-Fr 14:00-21:00', experienceYears: 4 },
  ],

  prices: [
    // «Демо-Здоровье» на Баумана
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.therapist.first', price: 1900 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.therapist.repeat', price: 1600 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.lor.first', price: 2200 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.lor.repeat', price: 1900 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.neurologist.first', price: 2400 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.neurologist.repeat', price: 2000 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.cardiologist.first', price: 2500 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.cardiologist.repeat', price: 2100 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.gynecologist.first', price: 2300 },
    { branchId: 'demo-zdorovie-center', serviceId: 'consult.gynecologist.repeat', price: 1900 },
    { branchId: 'demo-zdorovie-center', serviceId: 'diag.ecg', price: 900 },
    { branchId: 'demo-zdorovie-center', serviceId: 'lab.cbc', price: 550 },
    { branchId: 'demo-zdorovie-center', serviceId: 'diag.ultrasound.abdomen', price: 2200 },
    // «Демо-Здоровье» в Азино
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.lor.first', price: 2000 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.lor.repeat', price: 1700 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.ophthalmologist.first', price: 1900 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.ophthalmologist.repeat', price: 1600 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.therapist.first', price: 1700 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.therapist.repeat', price: 1400 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.urologist.first', price: 2100 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'consult.urologist.repeat', price: 1800 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'diag.ecg', price: 800 },
    { branchId: 'demo-zdorovie-azino', serviceId: 'lab.cbc', price: 500 },
    // «Демо-Здоровье» на Чистопольской
    { branchId: 'demo-zdorovie-sever', serviceId: 'consult.cardiologist.first', price: 2300 },
    { branchId: 'demo-zdorovie-sever', serviceId: 'consult.cardiologist.repeat', price: 1900 },
    { branchId: 'demo-zdorovie-sever', serviceId: 'consult.endocrinologist.first', price: 2300 },
    { branchId: 'demo-zdorovie-sever', serviceId: 'consult.endocrinologist.repeat', price: 1900 },
    { branchId: 'demo-zdorovie-sever', serviceId: 'consult.traumatologist.first', price: 2100 },
    { branchId: 'demo-zdorovie-sever', serviceId: 'consult.traumatologist.repeat', price: 1800 },
    { branchId: 'demo-zdorovie-sever', serviceId: 'diag.ultrasound.abdomen', price: 2000 },
    // «Демо-Малыш» в Горках
    { branchId: 'demo-malysh-gorki', serviceId: 'consult.pediatrician.first', price: 1800 },
    { branchId: 'demo-malysh-gorki', serviceId: 'consult.pediatrician.repeat', price: 1500 },
    { branchId: 'demo-malysh-gorki', serviceId: 'consult.lor.first', price: 2100 },
    { branchId: 'demo-malysh-gorki', serviceId: 'consult.lor.repeat', price: 1800 },
    { branchId: 'demo-malysh-gorki', serviceId: 'consult.neurologist.first', price: 2300 },
    { branchId: 'demo-malysh-gorki', serviceId: 'consult.neurologist.repeat', price: 1900 },
    { branchId: 'demo-malysh-gorki', serviceId: 'lab.cbc', price: 600 },
    // «Демо-Малыш» в Дербышках
    { branchId: 'demo-malysh-derbyshki', serviceId: 'consult.pediatrician.first', price: 1600 },
    { branchId: 'demo-malysh-derbyshki', serviceId: 'consult.pediatrician.repeat', price: 1400 },
    { branchId: 'demo-malysh-derbyshki', serviceId: 'consult.lor.first', price: 1900 },
    { branchId: 'demo-malysh-derbyshki', serviceId: 'consult.lor.repeat', price: 1600 },
    { branchId: 'demo-malysh-derbyshki', serviceId: 'consult.ophthalmologist.first', price: 1800 },
    { branchId: 'demo-malysh-derbyshki', serviceId: 'consult.ophthalmologist.repeat', price: 1500 },
    // «Дерма-Демо»
    { branchId: 'demo-derma-center', serviceId: 'consult.dermatologist.first', price: 2400 },
    { branchId: 'demo-derma-center', serviceId: 'consult.dermatologist.repeat', price: 2000 },
    // «Женская консультация Демо»
    { branchId: 'demo-zhenskaya-kirov', serviceId: 'consult.gynecologist.first', price: 1900 },
    { branchId: 'demo-zhenskaya-kirov', serviceId: 'consult.gynecologist.repeat', price: 1600 },
    { branchId: 'demo-zhenskaya-kirov', serviceId: 'diag.ultrasound.abdomen', price: 1900 },
    // «Демо-Стоматология»: в прайсе «от» — это нижняя граница, не точная цена
    { branchId: 'demo-dent-avia', serviceId: 'consult.dentist.first', price: 'от 1000 руб.' },
    { branchId: 'demo-dent-avia', serviceId: 'consult.dentist.repeat', price: 800 },
  ],
};
