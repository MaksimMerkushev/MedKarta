/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * ДЕМОНСТРАЦИОННЫЙ НАБОР ДАННЫХ (SAMPLE DATASET).
 *
 * В публичном репозитории представлен ознакомительный срез специалистов для демонстрации работы UI,
 * поиска, фильтрации и построения маршрутов.
 * Полная верифицированная база врачей клиник Казани (680+ специалистов РКБ, ДРКБ, МКДЦ)
 * вынесена в защищённый закрытый контур проекта.
 */

export const verifiedDoctors = [
  {
    "id": "verified-mkdc-1",
    "name": "Галявич Альберт Сарварович",
    "specialty": "Кардиолог",
    "clinic": "ГАУЗ «Межрегиональный клинико-диагностический центр» (МКДЦ)",
    "address": "Казань, ул. Карбышева, 12А",
    "district": "Приволжский",
    "ownership": "Государственная",
    "rating": 4.9,
    "experience": 28,
    "schedule": null,
    "hours": "Уточняйте в регистратуре",
    "phone": "+7 (843) 291-10-16",
    "website": "https://www.icdc.ru/",
    "services": ["Кардиолог", "Консультация кардиолога"],
    "features": {
      "onlineBooking": true,
      "wheelchair": true,
      "parking": true,
      "children": false,
      "eveningReception": true,
      "weekendReception": false
    },
    "description": "Данные специалиста верифицированы.",
    "lat": 55.753381,
    "lng": 49.173867,
    "facilityType": "Больница",
    "source": "verified"
  },
  {
    "id": "verified-rkb-1",
    "name": "Шавалиев Рафаэль Фирнаялович",
    "specialty": "Хирург",
    "clinic": "ГАУЗ «Республиканская клиническая больница» (РКБ)",
    "address": "Казань, Оренбургский тракт, 138",
    "district": "Приволжский",
    "ownership": "Государственная",
    "rating": 4.8,
    "experience": 24,
    "schedule": null,
    "hours": "Уточняйте в регистратуре",
    "phone": "+7 (843) 231-20-02",
    "website": "https://rkbrt.ru/",
    "services": ["Хирург", "Консультация хирурга"],
    "features": {
      "onlineBooking": true,
      "wheelchair": true,
      "parking": true,
      "children": false,
      "eveningReception": false,
      "weekendReception": false
    },
    "description": "Данные специалиста верифицированы.",
    "lat": 55.733979,
    "lng": 49.176465,
    "facilityType": "Больница",
    "source": "verified"
  },
  {
    "id": "verified-rkb-2",
    "name": "Ахмадеева Гульнара Рустэмовна",
    "specialty": "Невролог",
    "clinic": "ГАУЗ «Республиканская клиническая больница» (РКБ)",
    "address": "Казань, Оренбургский тракт, 138",
    "district": "Приволжский",
    "ownership": "Государственная",
    "rating": 4.9,
    "experience": 17,
    "schedule": null,
    "hours": "Уточняйте в регистратуре",
    "phone": "+7 (843) 231-20-02",
    "website": "https://rkbrt.ru/",
    "services": ["Невролог", "Диагностика нервной системы"],
    "features": {
      "onlineBooking": true,
      "wheelchair": true,
      "parking": true,
      "children": false,
      "eveningReception": false,
      "weekendReception": false
    },
    "description": "Данные специалиста верифицированы.",
    "lat": 55.733979,
    "lng": 49.176465,
    "facilityType": "Больница",
    "source": "verified"
  },
  {
    "id": "verified-drkb-1",
    "name": "Зиатдинов Айрат Ильгизарович",
    "specialty": "Педиатр",
    "clinic": "ГАУЗ «Детская республиканская клиническая больница» (ДРКБ)",
    "address": "Казань, Оренбургский тракт, 140",
    "district": "Приволжский",
    "ownership": "Государственная",
    "rating": 5.0,
    "experience": 22,
    "schedule": null,
    "hours": "Уточняйте в регистратуре",
    "phone": "+7 (843) 269-89-00",
    "website": "https://drkbrt.ru/",
    "services": ["Педиатр", "Детский приём"],
    "features": {
      "onlineBooking": true,
      "wheelchair": true,
      "parking": true,
      "children": true,
      "eveningReception": true,
      "weekendReception": false
    },
    "description": "Данные специалиста верифицированы.",
    "lat": 55.727566,
    "lng": 49.173873,
    "facilityType": "Больница",
    "source": "verified"
  },
  {
    "id": "verified-drkb-2",
    "name": "Поспелов Михаил Сергеевич",
    "specialty": "Офтальмолог",
    "clinic": "ГАУЗ «Детская республиканская клиническая больница» (ДРКБ)",
    "address": "Казань, Оренбургский тракт, 140",
    "district": "Приволжский",
    "ownership": "Государственная",
    "rating": 4.7,
    "experience": 14,
    "schedule": null,
    "hours": "Уточняйте в регистратуре",
    "phone": "+7 (843) 269-89-00",
    "website": "https://drkbrt.ru/",
    "services": ["Офтальмолог", "Проверка зрения"],
    "features": {
      "onlineBooking": true,
      "wheelchair": true,
      "parking": true,
      "children": true,
      "eveningReception": false,
      "weekendReception": false
    },
    "description": "Данные специалиста верифицированы.",
    "lat": 55.727566,
    "lng": 49.173873,
    "facilityType": "Больница",
    "source": "verified"
  },
  {
    "id": "verified-mkdc-2",
    "name": "Хазиахметов Булат Ринатович",
    "specialty": "Терапевт",
    "clinic": "ГАУЗ «Межрегиональный клинико-диагностический центр» (МКДЦ)",
    "address": "Казань, ул. Карбышева, 12А",
    "district": "Приволжский",
    "ownership": "Государственная",
    "rating": 4.8,
    "experience": 11,
    "schedule": null,
    "hours": "Уточняйте в регистратуре",
    "phone": "+7 (843) 291-10-16",
    "website": "https://www.icdc.ru/",
    "services": ["Терапевт", "Общая терапия"],
    "features": {
      "onlineBooking": true,
      "wheelchair": true,
      "parking": true,
      "children": false,
      "eveningReception": true,
      "weekendReception": false
    },
    "description": "Данные специалиста верифицированы.",
    "lat": 55.753381,
    "lng": 49.173867,
    "facilityType": "Больница",
    "source": "verified"
  }
];
