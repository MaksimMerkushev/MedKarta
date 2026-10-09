/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * СГЕНЕРИРОВАНО: npm run demo:generate (backend/demo/generator.js, seed "medkarta-demo-2026").
 * Не править вручную — правки пропадут при следующей генерации.
 *
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. Клиники, врачи, цены, графики и программы ДМС
 * вымышлены и не являются предложениями реальных медицинских организаций
 * или страховых компаний.
 */

export const demoCatalog = {
  "meta": {
    "source": "demo",
    "version": 2,
    "seed": "medkarta-demo-2026",
    "verifiedAt": "2026-10-09",
    "disclaimer": "Демонстрационные данные: клиники, врачи, цены, расписание и программы ДМС вымышлены и не являются предложениями реальных организаций."
  },
  "clinics": [
    {
      "id": "demo-yasen",
      "name": "Демо-клиника «Ясень»",
      "ownership": "Частная",
      "facilityType": "Медцентр",
      "website": "https://demo-yasen.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "standard",
      "branches": [
        {
          "id": "demo-yasen-centr",
          "name": "центр",
          "district": "Вахитовский",
          "address": "Казань, Вахитовский район, демо-адрес (точка на карте условная)",
          "lat": 55.7887,
          "lng": 49.1221,
          "phone": "+7 (843) 000-11-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        },
        {
          "id": "demo-yasen-sever",
          "name": "Ново-Савиновский",
          "district": "Ново-Савиновский",
          "address": "Казань, Ново-Савиновский район, демо-адрес (точка на карте условная)",
          "lat": 55.8237,
          "lng": 49.1186,
          "phone": "+7 (843) 000-12-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-beresta",
      "name": "Демо-медцентр «Береста»",
      "ownership": "Частная",
      "facilityType": "Медцентр",
      "website": "https://demo-beresta.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "economy",
      "branches": [
        {
          "id": "demo-beresta-azino",
          "name": "Азино",
          "district": "Советский",
          "address": "Казань, Советский район, демо-адрес (точка на карте условная)",
          "lat": 55.7536,
          "lng": 49.2047,
          "phone": "+7 (843) 000-13-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": false,
            "onlineBooking": true
          }
        },
        {
          "id": "demo-beresta-gorki",
          "name": "Горки",
          "district": "Приволжский",
          "address": "Казань, Приволжский район, демо-адрес (точка на карте условная)",
          "lat": 55.765,
          "lng": 49.163,
          "phone": "+7 (843) 000-14-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-kama",
      "name": "Демо-клиника «Кама Премиум»",
      "ownership": "Частная",
      "facilityType": "Медцентр",
      "website": "https://demo-kama.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "premium",
      "branches": [
        {
          "id": "demo-kama-centr",
          "name": "центр",
          "district": "Вахитовский",
          "address": "Казань, Вахитовский район, демо-адрес (точка на карте условная)",
          "lat": 55.7818,
          "lng": 49.1341,
          "phone": "+7 (843) 000-15-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00; Su 10:00-16:00",
          "features": {
            "wheelchair": true,
            "parking": false,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-detstvo",
      "name": "Детская демо-клиника «Детство»",
      "ownership": "Частная",
      "facilityType": "Клиника",
      "website": "https://demo-detstvo.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "standard",
      "branches": [
        {
          "id": "demo-detstvo-gorki",
          "name": "Горки",
          "district": "Приволжский",
          "address": "Казань, Приволжский район, демо-адрес (точка на карте условная)",
          "lat": 55.765,
          "lng": 49.163,
          "phone": "+7 (843) 000-16-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00; Su 10:00-16:00",
          "features": {
            "wheelchair": false,
            "parking": false,
            "onlineBooking": true
          }
        },
        {
          "id": "demo-detstvo-derbyshki",
          "name": "Дербышки",
          "district": "Советский",
          "address": "Казань, Советский район, демо-адрес (точка на карте условная)",
          "lat": 55.8575,
          "lng": 49.223,
          "phone": "+7 (843) 000-17-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00; Su 10:00-16:00",
          "features": {
            "wheelchair": true,
            "parking": false,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-pediatr-plus",
      "name": "Демо-клиника «Педиатр Плюс»",
      "ownership": "Частная",
      "facilityType": "Клиника",
      "website": "https://demo-pediatr-plus.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "economy",
      "branches": [
        {
          "id": "demo-pediatr-plus-avia",
          "name": "Авиастроительный",
          "district": "Авиастроительный",
          "address": "Казань, Авиастроительный район, демо-адрес (точка на карте условная)",
          "lat": 55.856,
          "lng": 49.088,
          "phone": "+7 (843) 000-18-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-dent",
      "name": "Демо-стоматология «Дент»",
      "ownership": "Частная",
      "facilityType": "Стоматология",
      "website": "https://demo-dent.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "standard",
      "branches": [
        {
          "id": "demo-dent-avia",
          "name": "Авиастроительный",
          "district": "Авиастроительный",
          "address": "Казань, Авиастроительный район, демо-адрес (точка на карте условная)",
          "lat": 55.856,
          "lng": 49.088,
          "phone": "+7 (843) 000-19-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": false,
            "onlineBooking": true
          }
        },
        {
          "id": "demo-dent-moskovsky",
          "name": "Московский",
          "district": "Московский",
          "address": "Казань, Московский район, демо-адрес (точка на карте условная)",
          "lat": 55.8189,
          "lng": 49.0805,
          "phone": "+7 (843) 000-20-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": false,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-ulybka",
      "name": "Демо-стоматология «Улыбка Премиум»",
      "ownership": "Частная",
      "facilityType": "Стоматология",
      "website": "https://demo-ulybka.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "premium",
      "branches": [
        {
          "id": "demo-ulybka-centr",
          "name": "центр",
          "district": "Вахитовский",
          "address": "Казань, Вахитовский район, демо-адрес (точка на карте условная)",
          "lat": 55.796,
          "lng": 49.116,
          "phone": "+7 (843) 000-21-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00; Su 10:00-16:00",
          "features": {
            "wheelchair": true,
            "parking": false,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-zhenskoe",
      "name": "Демо-центр «Женское здоровье»",
      "ownership": "Частная",
      "facilityType": "Клиника",
      "website": "https://demo-zhenskoe.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "standard",
      "branches": [
        {
          "id": "demo-zhenskoe-kirov",
          "name": "Кировский",
          "district": "Кировский",
          "address": "Казань, Кировский район, демо-адрес (точка на карте условная)",
          "lat": 55.804,
          "lng": 49.07,
          "phone": "+7 (843) 000-22-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-travma",
      "name": "Демо-травмоцентр «Опора»",
      "ownership": "Частная",
      "facilityType": "Медцентр",
      "website": "https://demo-travma.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "standard",
      "branches": [
        {
          "id": "demo-travma-sever",
          "name": "Ново-Савиновский",
          "district": "Ново-Савиновский",
          "address": "Казань, Ново-Савиновский район, демо-адрес (точка на карте условная)",
          "lat": 55.8268,
          "lng": 49.1395,
          "phone": "+7 (843) 000-23-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00; Su 10:00-16:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-derma",
      "name": "Демо-клиника «Дерма»",
      "ownership": "Частная",
      "facilityType": "Клиника",
      "website": "https://demo-derma.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "standard",
      "branches": [
        {
          "id": "demo-derma-dubravnaya",
          "name": "Дубравная",
          "district": "Приволжский",
          "address": "Казань, Приволжский район, демо-адрес (точка на карте условная)",
          "lat": 55.7398,
          "lng": 49.1495,
          "phone": "+7 (843) 000-24-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-neuro",
      "name": "Демо-центр «Нейро»",
      "ownership": "Частная",
      "facilityType": "Медцентр",
      "website": "https://demo-neuro.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "premium",
      "branches": [
        {
          "id": "demo-neuro-ametyevo",
          "name": "Аметьево",
          "district": "Советский",
          "address": "Казань, Советский район, демо-адрес (точка на карте условная)",
          "lat": 55.7712,
          "lng": 49.1755,
          "phone": "+7 (843) 000-25-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": false,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    },
    {
      "id": "demo-semya",
      "name": "Демо-клиника «Семейный доктор»",
      "ownership": "Частная",
      "facilityType": "Клиника",
      "website": "https://demo-semya.example",
      "description": "Демонстрационная клиника МедКарты: вымышленная, для показа подбора и записи.",
      "tier": "economy",
      "branches": [
        {
          "id": "demo-semya-moskovsky",
          "name": "Московский",
          "district": "Московский",
          "address": "Казань, Московский район, демо-адрес (точка на карте условная)",
          "lat": 55.811,
          "lng": 49.065,
          "phone": "+7 (843) 000-26-00",
          "hours": "Mo-Fr 08:00-21:00; Sa 09:00-18:00",
          "features": {
            "wheelchair": true,
            "parking": true,
            "onlineBooking": true
          }
        }
      ]
    }
  ],
  "doctors": [
    {
      "id": "demo-doc-zinnatullina-nailya",
      "name": "Зиннатуллина Наиля Маратовна",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Tu,We,Th,Fr 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 21,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-valeev-vadim",
      "name": "Валеев Вадим Ринатович",
      "specialty": "ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr",
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat",
        "proc.lor.tonsils"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Mo 14:00-17:30,18:00-21:00; Th 08:00-14:00",
        "demo-yasen-sever": "Tu 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 6,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-galieva-liliya",
      "name": "Галиева Лилия Олеговна",
      "specialty": "Невролог",
      "specialtyKey": "neurologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr"
      ],
      "serviceIds": [
        "consult.neurologist.first",
        "consult.neurologist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Mo,Tu,We 08:00-14:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 15,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-usmanova-alina",
      "name": "Усманова Алина Павловна",
      "specialty": "Кардиолог",
      "specialtyKey": "cardiologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.cardiologist.first",
        "consult.cardiologist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-sever": "Tu,Th,Fr 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-sever",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 18,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-guryanov-evgeniy",
      "name": "Гурьянов Евгений Николаевич",
      "specialty": "Офтальмолог",
      "specialtyKey": "ophthalmologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr",
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.ophthalmologist.first",
        "consult.ophthalmologist.repeat",
        "proc.ophthalmologist.glasses"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Mo,Th 10:00-13:30,14:00-18:00; Sa 09:00-15:00",
        "demo-yasen-sever": "We,Fr 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 28,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-prohorova-svetlana",
      "name": "Прохорова Светлана Булатовна",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat",
        "proc.gynecologist.ultrasound"
      ],
      "hoursByBranch": {
        "demo-yasen-sever": "Mo,Tu,We,Th,Fr 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-sever",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 15,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-kalinin-rinat",
      "name": "Калинин Ринат Николаевич",
      "specialty": "Эндокринолог",
      "specialtyKey": "endocrinologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr",
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.endocrinologist.first",
        "consult.endocrinologist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Mo,Fr 16:00-21:00; We 10:00-13:30,14:00-18:00; Sa 09:00-15:00",
        "demo-yasen-sever": "Tu,Th 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 9,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-vorontsov-daniyar",
      "name": "Воронцов Данияр Ильдарович",
      "specialty": "Гастроэнтеролог",
      "specialtyKey": "gastroenterologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.gastroenterologist.first",
        "consult.gastroenterologist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-sever": "Mo,Tu,We,Th,Fr 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-sever",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 14,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ageeva-svetlana",
      "name": "Агеева Светлана Ринатовна",
      "specialty": "Уролог",
      "specialtyKey": "urologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr"
      ],
      "serviceIds": [
        "consult.urologist.first",
        "consult.urologist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Mo,Tu,Th,Fr 16:00-21:00; We 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 11,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-dyachkova-kamila",
      "name": "Дьячкова Камила Булатовна",
      "specialty": "Дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat",
        "proc.dermatologist.dermatoscopy"
      ],
      "hoursByBranch": {
        "demo-yasen-sever": "Mo,We 14:00-17:30,18:00-21:00; Fr 16:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-sever",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 9,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-muhametzyanov-rinat",
      "name": "Мухаметзянов Ринат Николаевич",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-centr"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-yasen-centr": "Mo,Tu,Th,Fr 16:00-21:00; We 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-centr",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 24,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ismagilov-aydar",
      "name": "Исмагилов Айдар Айдарович",
      "specialty": "ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-yasen-sever"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat",
        "proc.lor.tonsils"
      ],
      "hoursByBranch": {
        "demo-yasen-sever": "Tu,We 16:00-21:00; Fr 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-yasen-sever",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-yasen-sever",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 22,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-vagizova-zulfiya",
      "name": "Вагизова Зульфия Олеговна",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo,Tu,Th,Fr 10:00-13:30,14:00-18:00; We 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 28,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-efimov-timur",
      "name": "Ефимов Тимур Олегович",
      "specialty": "ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-gorki": "Mo,Tu,Th,Fr 14:00-17:30,18:00-21:00; We 16:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 24,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-efimova-mariya",
      "name": "Ефимова Мария Павловна",
      "specialty": "Невролог",
      "specialtyKey": "neurologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino",
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.neurologist.first",
        "consult.neurologist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo,Fr 08:00-14:00; We 14:00-17:30,18:00-21:00",
        "demo-beresta-gorki": "Tu,Th 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 22,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-burhanova-regina",
      "name": "Бурханова Регина Айдаровна",
      "specialty": "Кардиолог",
      "specialtyKey": "cardiologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.cardiologist.first",
        "consult.cardiologist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-gorki": "Mo,Tu,We,Th,Fr 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 11,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-belousov-bulat",
      "name": "Белоусов Булат Маратович",
      "specialty": "Офтальмолог",
      "specialtyKey": "ophthalmologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino"
      ],
      "serviceIds": [
        "consult.ophthalmologist.first",
        "consult.ophthalmologist.repeat",
        "proc.ophthalmologist.glasses"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo,Tu,Th,Fr 08:00-14:00; We 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 16,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-hasanova-elmira",
      "name": "Хасанова Эльмира Андреевна",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino",
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat",
        "proc.gynecologist.ultrasound"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo,We 16:00-21:00",
        "demo-beresta-gorki": "Tu,Th 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 16,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-zinnatullin-artem",
      "name": "Зиннатуллин Артём Ринатович",
      "specialty": "Эндокринолог",
      "specialtyKey": "endocrinologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino"
      ],
      "serviceIds": [
        "consult.endocrinologist.first",
        "consult.endocrinologist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo,Tu,We,Th 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 25,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-yahin-lenar",
      "name": "Яхин Ленар Сергеевич",
      "specialty": "Гастроэнтеролог",
      "specialtyKey": "gastroenterologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino",
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.gastroenterologist.first",
        "consult.gastroenterologist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Tu 14:00-17:30,18:00-21:00; Fr 16:00-21:00; Sa 09:00-15:00",
        "demo-beresta-gorki": "We 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 25,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-osipov-evgeniy",
      "name": "Осипов Евгений Викторович",
      "specialty": "Уролог",
      "specialtyKey": "urologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino"
      ],
      "serviceIds": [
        "consult.urologist.first",
        "consult.urologist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Tu,Th 16:00-21:00; Fr 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 19,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-melnikov-artem",
      "name": "Мельников Артём Рустемович",
      "specialty": "Дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat",
        "proc.dermatologist.dermatoscopy"
      ],
      "hoursByBranch": {
        "demo-beresta-gorki": "Mo,Tu 16:00-21:00; Fr 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 13,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-tsvetkov-ildar",
      "name": "Цветков Ильдар Рустемович",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino",
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo,Fr 10:00-13:30,14:00-18:00; We 08:00-14:00",
        "demo-beresta-gorki": "Tu,Th 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 23,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ibragimova-yuliya",
      "name": "Ибрагимова Юлия Ринатовна",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-beresta-azino",
        "demo-beresta-gorki"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat"
      ],
      "hoursByBranch": {
        "demo-beresta-azino": "Mo 16:00-21:00; We 14:00-17:30,18:00-21:00",
        "demo-beresta-gorki": "Tu,Fr 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-beresta-azino",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-beresta-azino",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-beresta-gorki",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 5,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-burhanov-marat",
      "name": "Бурханов Марат Сергеевич",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,We,Fr 10:00-13:30,14:00-18:00; Th 16:00-21:00; Sa 09:00-15:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 10,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-zaripova-irina",
      "name": "Зарипова Ирина Булатовна",
      "specialty": "ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat",
        "proc.lor.tonsils"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,We 16:00-21:00; Fr 08:00-14:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 21,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-sharafutdinova-svetlana",
      "name": "Шарафутдинова Светлана Ринатовна",
      "specialty": "Невролог",
      "specialtyKey": "neurologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.neurologist.first",
        "consult.neurologist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,We 14:00-17:30,18:00-21:00; Th 08:00-14:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 4,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-dyachkov-lenar",
      "name": "Дьячков Ленар Павлович",
      "specialty": "Кардиолог",
      "specialtyKey": "cardiologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.cardiologist.first",
        "consult.cardiologist.repeat",
        "diag.ecg"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,Tu,We,Th,Fr 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 12,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-habibullina-mariya",
      "name": "Хабибуллина Мария Ильдаровна",
      "specialty": "Офтальмолог",
      "specialtyKey": "ophthalmologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.ophthalmologist.first",
        "consult.ophthalmologist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,We,Fr 14:00-17:30,18:00-21:00; Th 10:00-13:30,14:00-18:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 25,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-tagirova-irina",
      "name": "Тагирова Ирина Рустемовна",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,Tu,Th 16:00-21:00; We 10:00-13:30,14:00-18:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 28,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-fattahova-elmira",
      "name": "Фаттахова Эльмира Рустемовна",
      "specialty": "Эндокринолог",
      "specialtyKey": "endocrinologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.endocrinologist.first",
        "consult.endocrinologist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,Tu 14:00-17:30,18:00-21:00; We 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 9,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-rahimov-gleb",
      "name": "Рахимов Глеб Павлович",
      "specialty": "Гастроэнтеролог",
      "specialtyKey": "gastroenterologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.gastroenterologist.first",
        "consult.gastroenterologist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,We,Th 14:00-17:30,18:00-21:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 9,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-urazova-yuliya",
      "name": "Уразова Юлия Рустемовна",
      "specialty": "Уролог",
      "specialtyKey": "urologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.urologist.first",
        "consult.urologist.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,Tu,Fr 14:00-17:30,18:00-21:00; Th 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 8,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-sabirov-evgeniy",
      "name": "Сабиров Евгений Сергеевич",
      "specialty": "Дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat",
        "proc.dermatologist.dermatoscopy"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,Tu,We,Th,Fr 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 27,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-davydov-farid",
      "name": "Давыдов Фарид Ринатович",
      "specialty": "Хирург",
      "specialtyKey": "surgeon",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-kama-centr"
      ],
      "serviceIds": [
        "consult.surgeon.first",
        "consult.surgeon.repeat"
      ],
      "hoursByBranch": {
        "demo-kama-centr": "Mo,Tu,Th,Fr 14:00-17:30,18:00-21:00; We 16:00-21:00; Sa 09:00-15:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-kama-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        },
        {
          "branchId": "demo-kama-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 15,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-bulygin-gleb",
      "name": "Булыгин Глеб Викторович",
      "specialty": "Педиатр",
      "specialtyKey": "pediatrician",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-gorki",
        "demo-detstvo-derbyshki"
      ],
      "serviceIds": [
        "consult.pediatrician.first",
        "consult.pediatrician.repeat"
      ],
      "hoursByBranch": {
        "demo-detstvo-gorki": "Mo,We,Fr 08:00-14:00",
        "demo-detstvo-derbyshki": "Tu,Th 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 8,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-frolova-yuliya",
      "name": "Фролова Юлия Викторовна",
      "specialty": "Детский ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-derbyshki"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat",
        "proc.lor.tonsils"
      ],
      "hoursByBranch": {
        "demo-detstvo-derbyshki": "Mo,We,Th,Fr 16:00-21:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 14,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-usmanov-rinat",
      "name": "Усманов Ринат Булатович",
      "specialty": "Детский невролог",
      "specialtyKey": "neurologist",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-gorki"
      ],
      "serviceIds": [
        "consult.neurologist.first",
        "consult.neurologist.repeat"
      ],
      "hoursByBranch": {
        "demo-detstvo-gorki": "Mo,Tu,Th,Fr 08:00-14:00; We 14:00-17:30,18:00-21:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 14,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-osipova-regina",
      "name": "Осипова Регина Викторовна",
      "specialty": "Детский офтальмолог",
      "specialtyKey": "ophthalmologist",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-derbyshki"
      ],
      "serviceIds": [
        "consult.ophthalmologist.first",
        "consult.ophthalmologist.repeat",
        "proc.ophthalmologist.glasses"
      ],
      "hoursByBranch": {
        "demo-detstvo-derbyshki": "Mo,Tu,Fr 14:00-17:30,18:00-21:00; We 16:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 19,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-nasyrova-tatyana",
      "name": "Насырова Татьяна Сергеевна",
      "specialty": "Детский хирург",
      "specialtyKey": "surgeon",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-gorki"
      ],
      "serviceIds": [
        "consult.surgeon.first",
        "consult.surgeon.repeat"
      ],
      "hoursByBranch": {
        "demo-detstvo-gorki": "Mo,Tu 10:00-13:30,14:00-18:00; Fr 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 11,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-abdullin-evgeniy",
      "name": "Абдуллин Евгений Рустемович",
      "specialty": "Детский дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-derbyshki"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat"
      ],
      "hoursByBranch": {
        "demo-detstvo-derbyshki": "We,Th 16:00-21:00; Fr 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 17,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-kalinina-darya",
      "name": "Калинина Дарья Викторовна",
      "specialty": "Детский ортопед",
      "specialtyKey": "orthopedist",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-gorki",
        "demo-detstvo-derbyshki"
      ],
      "serviceIds": [
        "consult.orthopedist.first",
        "consult.orthopedist.repeat"
      ],
      "hoursByBranch": {
        "demo-detstvo-gorki": "Mo 16:00-21:00; Th 08:00-14:00",
        "demo-detstvo-derbyshki": "We 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 8,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-aksenov-oleg",
      "name": "Аксёнов Олег Ильдарович",
      "specialty": "Педиатр",
      "specialtyKey": "pediatrician",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-derbyshki"
      ],
      "serviceIds": [
        "consult.pediatrician.first",
        "consult.pediatrician.repeat"
      ],
      "hoursByBranch": {
        "demo-detstvo-derbyshki": "Mo,Th 14:00-17:30,18:00-21:00; Fr 08:00-14:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-derbyshki",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 28,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ageev-daniyar",
      "name": "Агеев Данияр Булатович",
      "specialty": "Детский ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-detstvo-gorki"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat",
        "proc.lor.tonsils"
      ],
      "hoursByBranch": {
        "demo-detstvo-gorki": "Tu,We,Fr 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-detstvo-gorki",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 5,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-shayhutdinova-guzel",
      "name": "Шайхутдинова Гузель Рустемовна",
      "specialty": "Педиатр",
      "specialtyKey": "pediatrician",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-pediatr-plus-avia"
      ],
      "serviceIds": [
        "consult.pediatrician.first",
        "consult.pediatrician.repeat"
      ],
      "hoursByBranch": {
        "demo-pediatr-plus-avia": "Mo,Tu 10:00-13:30,14:00-18:00; Th 08:00-14:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 11,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-melnikova-zulfiya",
      "name": "Мельникова Зульфия Маратовна",
      "specialty": "Детский ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-pediatr-plus-avia"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat",
        "proc.lor.tonsils"
      ],
      "hoursByBranch": {
        "demo-pediatr-plus-avia": "Mo,Tu,We,Th,Fr 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 16,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-abdullina-regina",
      "name": "Абдуллина Регина Викторовна",
      "specialty": "Детский офтальмолог",
      "specialtyKey": "ophthalmologist",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-pediatr-plus-avia"
      ],
      "serviceIds": [
        "consult.ophthalmologist.first",
        "consult.ophthalmologist.repeat"
      ],
      "hoursByBranch": {
        "demo-pediatr-plus-avia": "Tu,We,Fr 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 23,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-tsvetkova-guzel",
      "name": "Цветкова Гузель Сергеевна",
      "specialty": "Педиатр",
      "specialtyKey": "pediatrician",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-pediatr-plus-avia"
      ],
      "serviceIds": [
        "consult.pediatrician.first",
        "consult.pediatrician.repeat"
      ],
      "hoursByBranch": {
        "demo-pediatr-plus-avia": "Mo,We 14:00-17:30,18:00-21:00; Th 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-pediatr-plus-avia",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 11,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-safiullin-nikita",
      "name": "Сафиуллин Никита Викторович",
      "specialty": "Стоматолог",
      "specialtyKey": "dentist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-dent-avia"
      ],
      "serviceIds": [
        "consult.dentist.first",
        "consult.dentist.repeat",
        "proc.dentist.hygiene"
      ],
      "hoursByBranch": {
        "demo-dent-avia": "Mo,Tu 16:00-21:00; We 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-dent-avia",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-avia",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-avia",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 23,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-frolov-aydar",
      "name": "Фролов Айдар Сергеевич",
      "specialty": "Стоматолог",
      "specialtyKey": "dentist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-dent-moskovsky"
      ],
      "serviceIds": [
        "consult.dentist.first",
        "consult.dentist.repeat"
      ],
      "hoursByBranch": {
        "demo-dent-moskovsky": "Mo,Tu,We,Th,Fr 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 26,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-egorshina-darya",
      "name": "Егоршина Дарья Андреевна",
      "specialty": "Стоматолог",
      "specialtyKey": "dentist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-dent-avia",
        "demo-dent-moskovsky"
      ],
      "serviceIds": [
        "consult.dentist.first",
        "consult.dentist.repeat"
      ],
      "hoursByBranch": {
        "demo-dent-avia": "Mo,Fr 16:00-21:00; We 08:00-14:00; Sa 09:00-15:00",
        "demo-dent-moskovsky": "Tu,Th 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-dent-avia",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-avia",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-moskovsky",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-avia",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-dent-avia",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 3,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-guryanova-kamila",
      "name": "Гурьянова Камила Андреевна",
      "specialty": "Стоматолог",
      "specialtyKey": "dentist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-ulybka-centr"
      ],
      "serviceIds": [
        "consult.dentist.first",
        "consult.dentist.repeat",
        "proc.dentist.hygiene"
      ],
      "hoursByBranch": {
        "demo-ulybka-centr": "Mo,Tu 16:00-21:00; Th 14:00-17:30,18:00-21:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 10,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-yunusov-gleb",
      "name": "Юнусов Глеб Булатович",
      "specialty": "Стоматолог",
      "specialtyKey": "dentist",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-ulybka-centr"
      ],
      "serviceIds": [
        "consult.dentist.first",
        "consult.dentist.repeat"
      ],
      "hoursByBranch": {
        "demo-ulybka-centr": "Mo,Tu 16:00-21:00; Th 08:00-14:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 22,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-nasyrov-marat",
      "name": "Насыров Марат Олегович",
      "specialty": "Стоматолог",
      "specialtyKey": "dentist",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-ulybka-centr"
      ],
      "serviceIds": [
        "consult.dentist.first",
        "consult.dentist.repeat",
        "proc.dentist.hygiene"
      ],
      "hoursByBranch": {
        "demo-ulybka-centr": "Mo,Tu,Th,Fr 14:00-17:30,18:00-21:00; We 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-ulybka-centr",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 18,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-galiev-farid",
      "name": "Галиев Фарид Олегович",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-zhenskoe-kirov"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat",
        "proc.gynecologist.ultrasound"
      ],
      "hoursByBranch": {
        "demo-zhenskoe-kirov": "Mo,Tu,Th,Fr 08:00-14:00; We 14:00-17:30,18:00-21:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 14,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-rahimova-nailya",
      "name": "Рахимова Наиля Ильдаровна",
      "specialty": "Эндокринолог",
      "specialtyKey": "endocrinologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-zhenskoe-kirov"
      ],
      "serviceIds": [
        "consult.endocrinologist.first",
        "consult.endocrinologist.repeat"
      ],
      "hoursByBranch": {
        "demo-zhenskoe-kirov": "Mo,Tu,We,Th,Fr 14:00-17:30,18:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 28,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-fattahov-vadim",
      "name": "Фаттахов Вадим Олегович",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-zhenskoe-kirov"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat"
      ],
      "hoursByBranch": {
        "demo-zhenskoe-kirov": "Mo,We,Fr 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 8,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-davydova-alina",
      "name": "Давыдова Алина Рустемовна",
      "specialty": "Гинеколог",
      "specialtyKey": "gynecologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-zhenskoe-kirov"
      ],
      "serviceIds": [
        "consult.gynecologist.first",
        "consult.gynecologist.repeat",
        "proc.gynecologist.ultrasound"
      ],
      "hoursByBranch": {
        "demo-zhenskoe-kirov": "Mo,We,Fr 14:00-17:30,18:00-21:00; Th 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 4,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-zhenskoe-kirov",
          "weekday": 5,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        }
      ],
      "experienceYears": 22,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ryabinina-zulfiya",
      "name": "Рябинина Зульфия Андреевна",
      "specialty": "Травматолог",
      "specialtyKey": "traumatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-travma-sever"
      ],
      "serviceIds": [
        "consult.traumatologist.first",
        "consult.traumatologist.repeat"
      ],
      "hoursByBranch": {
        "demo-travma-sever": "We,Th 14:00-17:30,18:00-21:00; Fr 08:00-14:00; Sa 09:00-15:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-travma-sever",
          "weekday": 3,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 17,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-egorshin-vadim",
      "name": "Егоршин Вадим Ринатович",
      "specialty": "Ортопед",
      "specialtyKey": "orthopedist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-travma-sever"
      ],
      "serviceIds": [
        "consult.orthopedist.first",
        "consult.orthopedist.repeat"
      ],
      "hoursByBranch": {
        "demo-travma-sever": "Mo,Tu 14:00-17:30,18:00-21:00; Fr 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-travma-sever",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 7,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-chernova-irina",
      "name": "Чернова Ирина Викторовна",
      "specialty": "Хирург",
      "specialtyKey": "surgeon",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-travma-sever"
      ],
      "serviceIds": [
        "consult.surgeon.first",
        "consult.surgeon.repeat"
      ],
      "hoursByBranch": {
        "demo-travma-sever": "Mo,Tu,Fr 16:00-21:00; Th 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-travma-sever",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 3,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-timofeev-gleb",
      "name": "Тимофеев Глеб Айдарович",
      "specialty": "Травматолог",
      "specialtyKey": "traumatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-travma-sever"
      ],
      "serviceIds": [
        "consult.traumatologist.first",
        "consult.traumatologist.repeat"
      ],
      "hoursByBranch": {
        "demo-travma-sever": "Mo,Tu,Th 16:00-21:00; We 10:00-13:30,14:00-18:00; Su 10:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-travma-sever",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-travma-sever",
          "weekday": 7,
          "start": "10:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 6,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ismagilova-elmira",
      "name": "Исмагилова Эльмира Олеговна",
      "specialty": "Дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-derma-dubravnaya"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat"
      ],
      "hoursByBranch": {
        "demo-derma-dubravnaya": "Mo,Tu,Th,Fr 10:00-13:30,14:00-18:00; We 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 17,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ovchinnikov-daniyar",
      "name": "Овчинников Данияр Сергеевич",
      "specialty": "Дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-derma-dubravnaya"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat",
        "proc.dermatologist.dermatoscopy"
      ],
      "hoursByBranch": {
        "demo-derma-dubravnaya": "Mo,Tu,We 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 7,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-vorontsova-alina",
      "name": "Воронцова Алина Рустемовна",
      "specialty": "Дерматолог",
      "specialtyKey": "dermatologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-derma-dubravnaya"
      ],
      "serviceIds": [
        "consult.dermatologist.first",
        "consult.dermatologist.repeat",
        "proc.dermatologist.dermatoscopy"
      ],
      "hoursByBranch": {
        "demo-derma-dubravnaya": "Mo,We,Fr 08:00-14:00; Th 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 1,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-derma-dubravnaya",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 8,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-latypov-timur",
      "name": "Латыпов Тимур Айдарович",
      "specialty": "Невролог",
      "specialtyKey": "neurologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-neuro-ametyevo"
      ],
      "serviceIds": [
        "consult.neurologist.first",
        "consult.neurologist.repeat"
      ],
      "hoursByBranch": {
        "demo-neuro-ametyevo": "Mo,Tu 14:00-17:30,18:00-21:00; Fr 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 25,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-larionova-olga",
      "name": "Ларионова Ольга Николаевна",
      "specialty": "Психиатр",
      "specialtyKey": "psychiatrist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-neuro-ametyevo"
      ],
      "serviceIds": [
        "consult.psychiatrist.first",
        "consult.psychiatrist.repeat"
      ],
      "hoursByBranch": {
        "demo-neuro-ametyevo": "Mo,Tu,We,Th,Fr 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 6,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-aksenova-tatyana",
      "name": "Аксёнова Татьяна Олеговна",
      "specialty": "Невролог",
      "specialtyKey": "neurologist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-neuro-ametyevo"
      ],
      "serviceIds": [
        "consult.neurologist.first",
        "consult.neurologist.repeat"
      ],
      "hoursByBranch": {
        "demo-neuro-ametyevo": "We,Th 16:00-21:00; Fr 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 3,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 10,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-muhametzyanova-yuliya",
      "name": "Мухаметзянова Юлия Булатовна",
      "specialty": "Психиатр",
      "specialtyKey": "psychiatrist",
      "ageGroups": [
        "adult"
      ],
      "branchIds": [
        "demo-neuro-ametyevo"
      ],
      "serviceIds": [
        "consult.psychiatrist.first",
        "consult.psychiatrist.repeat"
      ],
      "hoursByBranch": {
        "demo-neuro-ametyevo": "Mo,Tu,Th,Fr 16:00-21:00; We 10:00-13:30,14:00-18:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-neuro-ametyevo",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 4,
      "features": {
        "children": false
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-nikitina-guzel",
      "name": "Никитина Гузель Андреевна",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-semya-moskovsky"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-semya-moskovsky": "Mo,Tu,Th,Fr 10:00-13:30,14:00-18:00; We 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 23,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ovchinnikova-mariya",
      "name": "Овчинникова Мария Викторовна",
      "specialty": "Педиатр",
      "specialtyKey": "pediatrician",
      "ageGroups": [
        "child"
      ],
      "branchIds": [
        "demo-semya-moskovsky"
      ],
      "serviceIds": [
        "consult.pediatrician.first",
        "consult.pediatrician.repeat"
      ],
      "hoursByBranch": {
        "demo-semya-moskovsky": "Mo,Tu,Th,Fr 16:00-21:00; We 10:00-13:30,14:00-18:00"
      },
      "schedule": [
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 1,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 2,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 3,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 5,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        }
      ],
      "experienceYears": 13,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-ibragimov-timur",
      "name": "Ибрагимов Тимур Рустемович",
      "specialty": "ЛОР",
      "specialtyKey": "lor",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-semya-moskovsky"
      ],
      "serviceIds": [
        "consult.lor.first",
        "consult.lor.repeat"
      ],
      "hoursByBranch": {
        "demo-semya-moskovsky": "Tu,We,Fr 08:00-14:00; Th 16:00-21:00"
      },
      "schedule": [
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 2,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 4,
          "start": "16:00",
          "end": "21:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 5,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        }
      ],
      "experienceYears": 8,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-kozhevnikova-tatyana",
      "name": "Кожевникова Татьяна Олеговна",
      "specialty": "Офтальмолог",
      "specialtyKey": "ophthalmologist",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-semya-moskovsky"
      ],
      "serviceIds": [
        "consult.ophthalmologist.first",
        "consult.ophthalmologist.repeat"
      ],
      "hoursByBranch": {
        "demo-semya-moskovsky": "Mo,Tu,Th 14:00-17:30,18:00-21:00; We 08:00-14:00; Sa 09:00-15:00"
      },
      "schedule": [
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 1,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 2,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 4,
          "start": "14:00",
          "end": "21:00",
          "breakAt": [
            "17:30",
            "18:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 6,
          "start": "09:00",
          "end": "15:00",
          "breakAt": null
        }
      ],
      "experienceYears": 19,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    },
    {
      "id": "demo-doc-habibullin-evgeniy",
      "name": "Хабибуллин Евгений Рустемович",
      "specialty": "Терапевт",
      "specialtyKey": "therapist",
      "ageGroups": [
        "adult",
        "child"
      ],
      "branchIds": [
        "demo-semya-moskovsky"
      ],
      "serviceIds": [
        "consult.therapist.first",
        "consult.therapist.repeat"
      ],
      "hoursByBranch": {
        "demo-semya-moskovsky": "Mo,Tu,Th,Fr 10:00-13:30,14:00-18:00; We 08:00-14:00"
      },
      "schedule": [
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 1,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 2,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 3,
          "start": "08:00",
          "end": "14:00",
          "breakAt": null
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 4,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        },
        {
          "branchId": "demo-semya-moskovsky",
          "weekday": 5,
          "start": "10:00",
          "end": "18:00",
          "breakAt": [
            "13:30",
            "14:00"
          ]
        }
      ],
      "experienceYears": 26,
      "features": {
        "children": true
      },
      "description": "Демонстрационный врач: вымышленное лицо для показа записи."
    }
  ],
  "prices": [
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.therapist.first",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.therapist.first",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.therapist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.therapist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.lor.first",
      "price": 2200
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.lor.first",
      "price": 2200
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.lor.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.lor.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "proc.lor.tonsils",
      "price": 1500
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "proc.lor.tonsils",
      "price": 1500
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.neurologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.neurologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.neurologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.neurologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.cardiologist.first",
      "price": 2500
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.cardiologist.first",
      "price": 2500
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.cardiologist.repeat",
      "price": 2100
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.cardiologist.repeat",
      "price": 2100
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.ophthalmologist.first",
      "price": 2100
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.ophthalmologist.first",
      "price": 2100
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "proc.ophthalmologist.glasses",
      "price": 1600
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "proc.ophthalmologist.glasses",
      "price": 1600
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.gynecologist.first",
      "price": 2300
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.gynecologist.first",
      "price": 2300
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.gynecologist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.gynecologist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "proc.gynecologist.ultrasound",
      "price": 2200
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "proc.gynecologist.ultrasound",
      "price": 2200
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.endocrinologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.endocrinologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.endocrinologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.endocrinologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.gastroenterologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.gastroenterologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.gastroenterologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.gastroenterologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.urologist.first",
      "price": 2300
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.urologist.first",
      "price": 2300
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.urologist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.urologist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.dermatologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.dermatologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "consult.dermatologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "consult.dermatologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-yasen-centr",
      "serviceId": "proc.dermatologist.dermatoscopy",
      "price": 1800
    },
    {
      "branchId": "demo-yasen-sever",
      "serviceId": "proc.dermatologist.dermatoscopy",
      "price": 1800
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.therapist.first",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.therapist.first",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.therapist.repeat",
      "price": 1350
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.therapist.repeat",
      "price": 1350
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.lor.first",
      "price": 1850
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.lor.first",
      "price": 1850
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.lor.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.lor.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.neurologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.neurologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.neurologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.neurologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.cardiologist.first",
      "price": 2150
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.cardiologist.first",
      "price": 2150
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.cardiologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.cardiologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.ophthalmologist.first",
      "price": 1800
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.ophthalmologist.first",
      "price": 1800
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1550
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1550
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "proc.ophthalmologist.glasses",
      "price": 1350
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "proc.ophthalmologist.glasses",
      "price": 1350
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.gynecologist.first",
      "price": 1950
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.gynecologist.first",
      "price": 1950
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.gynecologist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.gynecologist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "proc.gynecologist.ultrasound",
      "price": 1850
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "proc.gynecologist.ultrasound",
      "price": 1850
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.endocrinologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.endocrinologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.endocrinologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.endocrinologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.gastroenterologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.gastroenterologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.gastroenterologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.gastroenterologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.urologist.first",
      "price": 1950
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.urologist.first",
      "price": 1950
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.urologist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.urologist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.dermatologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.dermatologist.first",
      "price": 2050
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "consult.dermatologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "consult.dermatologist.repeat",
      "price": 1700
    },
    {
      "branchId": "demo-beresta-azino",
      "serviceId": "proc.dermatologist.dermatoscopy",
      "price": 1550
    },
    {
      "branchId": "demo-beresta-gorki",
      "serviceId": "proc.dermatologist.dermatoscopy",
      "price": 1550
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.therapist.first",
      "price": 2550
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.therapist.repeat",
      "price": 2150
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.lor.first",
      "price": 2950
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.lor.repeat",
      "price": 2550
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "proc.lor.tonsils",
      "price": 2050
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.neurologist.first",
      "price": 3250
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.neurologist.repeat",
      "price": 2700
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.cardiologist.first",
      "price": 3400
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.cardiologist.repeat",
      "price": 2850
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "diag.ecg",
      "price": 1200
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.ophthalmologist.first",
      "price": 2850
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 2450
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.gynecologist.first",
      "price": 3100
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.gynecologist.repeat",
      "price": 2550
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.endocrinologist.first",
      "price": 3250
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.endocrinologist.repeat",
      "price": 2700
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.gastroenterologist.first",
      "price": 3250
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.gastroenterologist.repeat",
      "price": 2700
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.urologist.first",
      "price": 3100
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.urologist.repeat",
      "price": 2550
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.dermatologist.first",
      "price": 3250
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.dermatologist.repeat",
      "price": 2700
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "proc.dermatologist.dermatoscopy",
      "price": 2450
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.surgeon.first",
      "price": 2950
    },
    {
      "branchId": "demo-kama-centr",
      "serviceId": "consult.surgeon.repeat",
      "price": 2450
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.pediatrician.first",
      "price": 1900
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.pediatrician.first",
      "price": 1900
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.pediatrician.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.pediatrician.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.lor.first",
      "price": 2200
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.lor.first",
      "price": 2200
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.lor.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.lor.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "proc.lor.tonsils",
      "price": 1500
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "proc.lor.tonsils",
      "price": 1500
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.neurologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.neurologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.neurologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.neurologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.ophthalmologist.first",
      "price": 2100
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.ophthalmologist.first",
      "price": 2100
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "proc.ophthalmologist.glasses",
      "price": 1600
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "proc.ophthalmologist.glasses",
      "price": 1600
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.surgeon.first",
      "price": 2200
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.surgeon.first",
      "price": 2200
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.surgeon.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.surgeon.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.dermatologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.dermatologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.dermatologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.dermatologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.orthopedist.first",
      "price": 2300
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.orthopedist.first",
      "price": 2300
    },
    {
      "branchId": "demo-detstvo-gorki",
      "serviceId": "consult.orthopedist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-detstvo-derbyshki",
      "serviceId": "consult.orthopedist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "consult.pediatrician.first",
      "price": 1600
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "consult.pediatrician.repeat",
      "price": 1350
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "consult.lor.first",
      "price": 1850
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "consult.lor.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "proc.lor.tonsils",
      "price": 1300
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "consult.ophthalmologist.first",
      "price": 1800
    },
    {
      "branchId": "demo-pediatr-plus-avia",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1550
    },
    {
      "branchId": "demo-dent-avia",
      "serviceId": "consult.dentist.first",
      "price": 1500
    },
    {
      "branchId": "demo-dent-moskovsky",
      "serviceId": "consult.dentist.first",
      "price": 1500
    },
    {
      "branchId": "demo-dent-avia",
      "serviceId": "consult.dentist.repeat",
      "price": 1200
    },
    {
      "branchId": "demo-dent-moskovsky",
      "serviceId": "consult.dentist.repeat",
      "price": 1200
    },
    {
      "branchId": "demo-dent-avia",
      "serviceId": "proc.dentist.hygiene",
      "price": 4500
    },
    {
      "branchId": "demo-dent-moskovsky",
      "serviceId": "proc.dentist.hygiene",
      "price": 4500
    },
    {
      "branchId": "demo-ulybka-centr",
      "serviceId": "consult.dentist.first",
      "price": 2050
    },
    {
      "branchId": "demo-ulybka-centr",
      "serviceId": "consult.dentist.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-ulybka-centr",
      "serviceId": "proc.dentist.hygiene",
      "price": 6100
    },
    {
      "branchId": "demo-zhenskoe-kirov",
      "serviceId": "consult.gynecologist.first",
      "price": 2300
    },
    {
      "branchId": "demo-zhenskoe-kirov",
      "serviceId": "consult.gynecologist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-zhenskoe-kirov",
      "serviceId": "proc.gynecologist.ultrasound",
      "price": 2200
    },
    {
      "branchId": "demo-zhenskoe-kirov",
      "serviceId": "consult.endocrinologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-zhenskoe-kirov",
      "serviceId": "consult.endocrinologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-travma-sever",
      "serviceId": "consult.traumatologist.first",
      "price": 2200
    },
    {
      "branchId": "demo-travma-sever",
      "serviceId": "consult.traumatologist.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-travma-sever",
      "serviceId": "consult.orthopedist.first",
      "price": 2300
    },
    {
      "branchId": "demo-travma-sever",
      "serviceId": "consult.orthopedist.repeat",
      "price": 1900
    },
    {
      "branchId": "demo-travma-sever",
      "serviceId": "consult.surgeon.first",
      "price": 2200
    },
    {
      "branchId": "demo-travma-sever",
      "serviceId": "consult.surgeon.repeat",
      "price": 1800
    },
    {
      "branchId": "demo-derma-dubravnaya",
      "serviceId": "consult.dermatologist.first",
      "price": 2400
    },
    {
      "branchId": "demo-derma-dubravnaya",
      "serviceId": "consult.dermatologist.repeat",
      "price": 2000
    },
    {
      "branchId": "demo-derma-dubravnaya",
      "serviceId": "proc.dermatologist.dermatoscopy",
      "price": 1800
    },
    {
      "branchId": "demo-neuro-ametyevo",
      "serviceId": "consult.neurologist.first",
      "price": 3250
    },
    {
      "branchId": "demo-neuro-ametyevo",
      "serviceId": "consult.neurologist.repeat",
      "price": 2700
    },
    {
      "branchId": "demo-neuro-ametyevo",
      "serviceId": "consult.psychiatrist.first",
      "price": 4750
    },
    {
      "branchId": "demo-neuro-ametyevo",
      "serviceId": "consult.psychiatrist.repeat",
      "price": 3800
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.therapist.first",
      "price": 1600
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.therapist.repeat",
      "price": 1350
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.pediatrician.first",
      "price": 1600
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.pediatrician.repeat",
      "price": 1350
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.lor.first",
      "price": 1850
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.lor.repeat",
      "price": 1600
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.ophthalmologist.first",
      "price": 1800
    },
    {
      "branchId": "demo-semya-moskovsky",
      "serviceId": "consult.ophthalmologist.repeat",
      "price": 1550
    }
  ],
  "services": [
    {
      "id": "consult.cardiologist.first",
      "name": "Приём кардиолога первичный",
      "specialty": "cardiologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.cardiologist.repeat",
      "name": "Приём кардиолога повторный",
      "specialty": "cardiologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.dentist.first",
      "name": "Приём стоматолога-терапевта первичный",
      "specialty": "dentist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 40
    },
    {
      "id": "consult.dentist.repeat",
      "name": "Приём стоматолога-терапевта повторный",
      "specialty": "dentist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 30
    },
    {
      "id": "consult.dermatologist.first",
      "name": "Приём дерматовенеролога первичный",
      "specialty": "dermatologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.dermatologist.repeat",
      "name": "Приём дерматовенеролога повторный",
      "specialty": "dermatologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.endocrinologist.first",
      "name": "Приём эндокринолога первичный",
      "specialty": "endocrinologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.endocrinologist.repeat",
      "name": "Приём эндокринолога повторный",
      "specialty": "endocrinologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.gastroenterologist.first",
      "name": "Приём гастроэнтеролога первичный",
      "specialty": "gastroenterologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.gastroenterologist.repeat",
      "name": "Приём гастроэнтеролога повторный",
      "specialty": "gastroenterologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.gynecologist.first",
      "name": "Приём акушера-гинеколога первичный",
      "specialty": "gynecologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.gynecologist.repeat",
      "name": "Приём акушера-гинеколога повторный",
      "specialty": "gynecologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.lor.first",
      "name": "Приём оториноларинголога (ЛОР) первичный",
      "specialty": "lor",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.lor.repeat",
      "name": "Приём оториноларинголога (ЛОР) повторный",
      "specialty": "lor",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.neurologist.first",
      "name": "Приём невролога первичный",
      "specialty": "neurologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.neurologist.repeat",
      "name": "Приём невролога повторный",
      "specialty": "neurologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.ophthalmologist.first",
      "name": "Приём офтальмолога первичный",
      "specialty": "ophthalmologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.ophthalmologist.repeat",
      "name": "Приём офтальмолога повторный",
      "specialty": "ophthalmologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.orthopedist.first",
      "name": "Приём ортопеда первичный",
      "specialty": "orthopedist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.orthopedist.repeat",
      "name": "Приём ортопеда повторный",
      "specialty": "orthopedist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.pediatrician.first",
      "name": "Приём педиатра первичный",
      "specialty": "pediatrician",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.pediatrician.repeat",
      "name": "Приём педиатра повторный",
      "specialty": "pediatrician",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.psychiatrist.first",
      "name": "Приём психиатра первичный",
      "specialty": "psychiatrist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 50
    },
    {
      "id": "consult.psychiatrist.repeat",
      "name": "Приём психиатра повторный",
      "specialty": "psychiatrist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 30
    },
    {
      "id": "consult.surgeon.first",
      "name": "Приём хирурга первичный",
      "specialty": "surgeon",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.surgeon.repeat",
      "name": "Приём хирурга повторный",
      "specialty": "surgeon",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.therapist.first",
      "name": "Приём терапевта первичный",
      "specialty": "therapist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.therapist.repeat",
      "name": "Приём терапевта повторный",
      "specialty": "therapist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.traumatologist.first",
      "name": "Приём травматолога-ортопеда первичный",
      "specialty": "traumatologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.traumatologist.repeat",
      "name": "Приём травматолога-ортопеда повторный",
      "specialty": "traumatologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "consult.urologist.first",
      "name": "Приём уролога первичный",
      "specialty": "urologist",
      "kind": "consult",
      "visit": "first",
      "durationMinutes": 30
    },
    {
      "id": "consult.urologist.repeat",
      "name": "Приём уролога повторный",
      "specialty": "urologist",
      "kind": "consult",
      "visit": "repeat",
      "durationMinutes": 20
    },
    {
      "id": "diag.ecg",
      "name": "ЭКГ (регистрация электрокардиограммы)",
      "specialty": "cardiologist",
      "kind": "diagnostics",
      "visit": null,
      "durationMinutes": 20
    },
    {
      "id": "proc.dentist.hygiene",
      "name": "Профессиональная гигиена полости рта",
      "specialty": "dentist",
      "kind": "procedure",
      "visit": null,
      "durationMinutes": 60
    },
    {
      "id": "proc.dermatologist.dermatoscopy",
      "name": "Дерматоскопия",
      "specialty": "dermatologist",
      "kind": "procedure",
      "visit": null,
      "durationMinutes": 30
    },
    {
      "id": "proc.gynecologist.ultrasound",
      "name": "УЗИ органов малого таза",
      "specialty": "gynecologist",
      "kind": "procedure",
      "visit": null,
      "durationMinutes": 30
    },
    {
      "id": "proc.lor.tonsils",
      "name": "Промывание миндалин",
      "specialty": "lor",
      "kind": "procedure",
      "visit": null,
      "durationMinutes": 20
    },
    {
      "id": "proc.ophthalmologist.glasses",
      "name": "Подбор очков",
      "specialty": "ophthalmologist",
      "kind": "procedure",
      "visit": null,
      "durationMinutes": 30
    }
  ],
  "insurance": {
    "meta": {
      "source": "demo",
      "verifiedAt": "2026-10-09"
    },
    "providers": [
      {
        "id": "demo-insurer",
        "name": "Демо-Страхование",
        "demo": true,
        "pultPhone": "+7 (800) 000-00-00",
        "bookingNote": "Демонстрационная страховая: программы вымышлены и не связаны с реальными страховщиками."
      }
    ],
    "plans": [
      {
        "id": "demo-basic",
        "providerId": "demo-insurer",
        "name": "Demo Basic",
        "insured": "adult",
        "validFrom": "2026-01-01",
        "validTo": "2027-12-31",
        "sourceDoc": "Демо-программа, не реальный полис",
        "summary": "Терапевт, ЛОР, офтальмолог, гинеколог, хирург и травматолог в трёх клиниках эконом-сети. Невролог, кардиолог, эндокринолог — по направлению. Процедуры не входят."
      },
      {
        "id": "demo-standard",
        "providerId": "demo-insurer",
        "name": "Demo Standard",
        "insured": "family",
        "validFrom": "2026-01-01",
        "validTo": "2027-12-31",
        "sourceDoc": "Демо-программа, не реальный полис",
        "summary": "Взрослые и дети, девять клиник. Приёмы напрямую, процедуры — после согласования. Психиатрия и профгигиена не входят."
      },
      {
        "id": "demo-premium",
        "providerId": "demo-insurer",
        "name": "Demo Premium",
        "insured": "family",
        "validFrom": "2026-01-01",
        "validTo": "2027-12-31",
        "sourceDoc": "Демо-программа, не реальный полис",
        "summary": "Все демо-клиники и все услуги напрямую. Профгигиена — раз в год по согласованию."
      }
    ],
    "coverage": [
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "therapist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "therapist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "therapist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "therapist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "lor",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "lor",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "lor",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "lor",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "ophthalmologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "ophthalmologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "ophthalmologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "ophthalmologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "gynecologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "gynecologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "gynecologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "gynecologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "surgeon",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "surgeon",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "surgeon",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "surgeon",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "traumatologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "traumatologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "traumatologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "traumatologist",
        "access": "direct"
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "neurologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "neurologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "neurologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "neurologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "cardiologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "cardiologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "cardiologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "cardiologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "endocrinologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "endocrinologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "endocrinologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "endocrinologist",
        "access": "referral_required",
        "notes": "По направлению терапевта по программе."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-basic",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "excluded",
        "notes": "Процедуры не входят в Demo Basic."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.lor.tonsils",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.ophthalmologist.glasses",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.dermatologist.dermatoscopy",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "proc.gynecologist.ultrasound",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "service",
        "serviceId": "diag.ecg",
        "access": "approval_required",
        "notes": "Процедура — после согласования со страховой."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "proc.dentist.hygiene",
        "access": "excluded",
        "notes": "Профгигиена не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "proc.dentist.hygiene",
        "access": "excluded",
        "notes": "Профгигиена не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-centr",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-yasen-sever",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-azino",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-beresta-gorki",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-gorki",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-avia",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-dent-moskovsky",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-travma-sever",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-derma-dubravnaya",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-standard",
        "branchId": "demo-semya-moskovsky",
        "scope": "specialty",
        "specialty": "psychiatrist",
        "access": "excluded",
        "notes": "Психиатрия не входит в Demo Standard."
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-yasen-centr",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-yasen-sever",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-beresta-azino",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-beresta-gorki",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-kama-centr",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-detstvo-gorki",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-detstvo-derbyshki",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-pediatr-plus-avia",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-dent-avia",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-dent-moskovsky",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-ulybka-centr",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-zhenskoe-kirov",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-travma-sever",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-derma-dubravnaya",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-neuro-ametyevo",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-semya-moskovsky",
        "scope": "all_outpatient",
        "access": "direct"
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-dent-avia",
        "scope": "service",
        "serviceId": "proc.dentist.hygiene",
        "access": "approval_required",
        "limitPerYear": 1,
        "notes": "Профгигиена — раз в год, по согласованию."
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-dent-moskovsky",
        "scope": "service",
        "serviceId": "proc.dentist.hygiene",
        "access": "approval_required",
        "limitPerYear": 1,
        "notes": "Профгигиена — раз в год, по согласованию."
      },
      {
        "planId": "demo-premium",
        "branchId": "demo-ulybka-centr",
        "scope": "service",
        "serviceId": "proc.dentist.hygiene",
        "access": "approval_required",
        "limitPerYear": 1,
        "notes": "Профгигиена — раз в год, по согласованию."
      }
    ]
  }
};
