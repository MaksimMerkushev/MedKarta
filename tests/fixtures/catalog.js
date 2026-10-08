/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Детерминированная фикстура справочника для тестов.
 *
 * ПОЧЕМУ НЕ РЕАЛЬНАЯ БАЗА. Полный справочник врачей лежит вне git
 * (data/doctors.full.js в .gitignore), поэтому в CI его нет, а
 * публичный срез меняется. Тесты безопасности не должны зависеть ни от того,
 * ни от другого: проверяется поведение конвейера, а не состав базы.
 *
 * Данные вымышлены целиком. Совпадение с реальными врачами не предполагается;
 * именно поэтому здесь нет ни одного настоящего ФИО из справочника.
 */

import { buildCatalog } from '../../backend/privacy/catalog.js';

const WORKDAY = {
  mon: '08:00-20:00',
  tue: '08:00-20:00',
  wed: '08:00-20:00',
  thu: '08:00-20:00',
  fri: '08:00-20:00',
  sat: '09:00-14:00',
  sun: 'Выходной',
};

const SHORT_DAY = {
  mon: '08:00-15:00',
  tue: '08:00-15:00',
  wed: '08:00-15:00',
  thu: '08:00-15:00',
  fri: '08:00-15:00',
  sat: 'Выходной',
  sun: 'Выходной',
};

export const FIXTURE_DOCTORS = [
  {
    id: 'fx-doc-petrov-therapist',
    name: 'Петров Сергей Иванович',
    specialty: 'Терапевт',
    clinic: 'Клиника «Тестовая» на Гагарина',
    district: 'Советский',
    ownership: 'Государственная',
    rating: 4.7,
    experience: 15,
    lat: 55.8,
    lng: 49.13,
    services: ['Терапевт', 'Консультация терапевта'],
    features: { children: false, wheelchair: true, onlineBooking: true },
  },
  {
    id: 'fx-doc-petrova-dentist',
    name: 'Петрова Анна Олеговна',
    specialty: 'Стоматолог',
    clinic: 'Стоматология «Тестовая» на Победе',
    district: 'Приволжский',
    ownership: 'Частная',
    rating: 4.9,
    experience: 9,
    lat: 55.74,
    lng: 49.2,
    services: ['Стоматолог'],
    features: { children: true, wheelchair: false, onlineBooking: true },
  },
  {
    id: 'fx-doc-sidorov-dentist',
    name: 'Сидоров Павел Юрьевич',
    specialty: 'Стоматолог',
    clinic: 'Стоматология «Тестовая» у вокзала',
    district: 'Вахитовский',
    ownership: 'Частная',
    rating: 4.4,
    experience: 20,
    lat: 55.786,
    lng: 49.105,
    services: ['Стоматолог'],
    features: { children: false, wheelchair: true, onlineBooking: false },
  },
  {
    id: 'fx-doc-kuznecov-gastro',
    name: 'Кузнецов Дмитрий Львович',
    specialty: 'Гастроэнтеролог',
    clinic: 'Клиника «Тестовая» на Гагарина',
    district: 'Советский',
    ownership: 'Государственная',
    rating: 4.6,
    experience: 12,
    lat: 55.8,
    lng: 49.13,
    services: ['Гастроэнтеролог'],
    features: { children: false },
  },
  {
    /* Однофамилец: нужен для проверки поведения при неоднозначности. */
    id: 'fx-doc-petrov-surgeon',
    name: 'Петров Олег Данилович',
    specialty: 'Хирург',
    clinic: 'Клиника «Тестовая» у вокзала',
    district: 'Вахитовский',
    ownership: 'Частная',
    rating: 4.2,
    experience: 22,
    lat: 55.786,
    lng: 49.105,
    services: ['Хирург'],
    features: {},
  },
];

export const FIXTURE_CLINICS = [
  {
    clinic_id: 'fx-clinic-gagarina',
    name: 'Клиника «Тестовая» на Гагарина',
    facility_type: 'Медцентр',
    ownership: 'Государственная',
    address_full: 'ул. Гагарина, 1, Казань',
    district: 'Советский район',
    coordinates: { lat: 55.8, lng: 49.13 },
    working_hours: { ...WORKDAY, raw: 'Пн-Пт 08:00-20:00' },
  },
  {
    clinic_id: 'fx-clinic-pobeda',
    name: 'Стоматология «Тестовая» на Победе',
    facility_type: 'Клиника',
    ownership: 'Частная',
    address_full: 'пр-кт Победы, 100, Казань',
    district: 'Приволжский район',
    coordinates: { lat: 55.74, lng: 49.2 },
    working_hours: { ...WORKDAY, raw: 'Пн-Пт 08:00-20:00' },
  },
  {
    clinic_id: 'fx-clinic-vokzal',
    name: 'Стоматология «Тестовая» у вокзала',
    facility_type: 'Клиника',
    ownership: 'Частная',
    address_full: 'ул. Привокзальная, 2, Казань',
    district: 'Вахитовский район',
    coordinates: { lat: 55.786, lng: 49.105 },
    working_hours: { ...SHORT_DAY, raw: 'Пн-Пт 08:00-15:00' },
  },
  {
    clinic_id: 'fx-clinic-vokzal-general',
    name: 'Клиника «Тестовая» у вокзала',
    facility_type: 'Клиника',
    ownership: 'Частная',
    address_full: 'ул. Привокзальная, 4, Казань',
    district: 'Вахитовский район',
    coordinates: { lat: 55.786, lng: 49.106 },
    working_hours: { ...WORKDAY, raw: 'Пн-Пт 08:00-20:00' },
  },
];

export const fixtureCatalog = () =>
  buildCatalog({ doctors: FIXTURE_DOCTORS, clinics: FIXTURE_CLINICS, facilities: [] });
