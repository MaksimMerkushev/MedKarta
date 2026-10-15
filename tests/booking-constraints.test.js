/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Условия записи из текста: день, цена, город, ДМС и их снятие в диалоге.
 * И флаги демо-режима: скрытие госучреждений, /api/config, нормализация
 * запроса подбора в контракте интерфейса.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractBookingConstraints, mergeBookingTurns } from '../backend/privacy/bookingConstraints.js';
import { extractConstraints } from '../backend/privacy/gateway.js';
import { bookingModeFromEnv, isPublicClinicRecord, publicClinicsHidden } from '../backend/demo/flags.js';
import { sanitizeAiAction } from '../shared/contract.js';
import configHandler from '../backend/api/config.js';
import { __resetCatalogCache, loadCatalog } from '../backend/privacy/catalog.js';

describe('Условия записи из текста', () => {
  const cases = [
    ['Нужен ЛОР завтра после 18:00', { date: { kind: 'tomorrow' } }],
    ['не сегодня, а завтра', { date: { kind: 'tomorrow' }, excludeDays: [{ kind: 'today' }] }],
    ['послезавтра вечером', { date: { kind: 'after_tomorrow' } }],
    ['сегодня', { date: { kind: 'today' } }],
    ['в пятницу', { date: { kind: 'weekday', weekday: 5 } }],
    ['во вторник', { date: { kind: 'weekday', weekday: 2 } }],
    ['не раньше 17:00', {}],
    ['на 15 октября', { date: { kind: 'date', month: 10, dayOfMonth: 15 } }],
    ['на 15.10', { date: { kind: 'date', month: 10, dayOfMonth: 15 } }],
    ['в любой день', { date: null }],
    ['дерматолог до 3000 ₽', { maxPrice: 3000 }],
    ['до 3 000 рублей', { maxPrice: 3000 }],
    ['не дороже 2,5 тыс', { maxPrice: 2500 }],
    ['не дороже 2500', { maxPrice: 2500 }],
    ['до трёх тысяч', { maxPrice: 3000 }],
    ['до 2к', { maxPrice: 2000 }],
    ['цена не важна', { maxPrice: null }],
    ['в Иннополисе', { city: 'innopolis' }],
    ['я из Москвы', { city: 'moscow' }],
    ['в Казани', { city: 'kazan' }],
    ['в Московском районе', { districts: ['Московский'] }],
    ['на Нижнекамской улице', {}],
    ['по ДМС', { dms: true }],
    ['по страховке', { dms: true }],
    ['без ДМС', { dms: false }],
    // «Платно» — ещё и согласие на платный приём вместо ОМС, если ОМС просили раньше.
    ['платно', { dms: false, consentPaid: true }],
    ['повторный приём', { visit: 'repeat' }],
    ['в любое время', { timeAny: true }],
    ['добрый вечер, нужен педиатр', {}],
    ['до 18', {}],
    ['до 20 минут', {}],
    ['педиатр в понедельник утром', { date: { kind: 'weekday', weekday: 1 }, timeOfDay: 'morning' }],
    ['терапевт до обеда', { timeOfDay: 'morning' }],
    ['невролог после обеда', { timeOfDay: 'afternoon' }],
    ['днём в среду', { date: { kind: 'weekday', weekday: 3 }, timeOfDay: 'daytime' }],
    ['доброе утро, нужен терапевт', {}],
    ['на этой неделе', { date: { kind: 'this_week' } }],
    ['на следующей неделе', { date: { kind: 'next_week' } }],
    ['подбор очков', { serviceId: 'proc.ophthalmologist.glasses', procedureSpecialty: 'ophthalmologist' }],
    ['сделать ЭКГ', { serviceId: 'diag.ecg', procedureSpecialty: 'cardiologist' }],
    ['профессиональная чистка зубов', { serviceId: 'proc.dentist.hygiene', procedureSpecialty: 'dentist' }],
    ['к гинекологу на УЗИ', { serviceId: 'proc.gynecologist.ultrasound', procedureSpecialty: 'gynecologist' }],
    ['УЗИ брюшной полости', {}],
    // Несколько дней сразу — все, а не последний.
    ['во вторник или среду', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 2 }, { kind: 'weekday', weekday: 3 }] } }],
    ['сегодня или завтра', { date: { kind: 'any_of', options: [{ kind: 'today' }, { kind: 'tomorrow' }] } }],
    ['в понедельник, среду или пятницу', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 1 }, { kind: 'weekday', weekday: 3 }, { kind: 'weekday', weekday: 5 }] } }],
    ['на 15 или 16 октября', { date: { kind: 'any_of', options: [{ kind: 'date', month: 10, dayOfMonth: 15 }, { kind: 'date', month: 10, dayOfMonth: 16 }] } }],
    ['не в понедельник, а во вторник', { date: { kind: 'weekday', weekday: 2 }, excludeWeekdays: [1] }],
    ['только не в понедельник', { excludeWeekdays: [1] }],
    ['кроме пятницы и субботы', { excludeWeekdays: [5, 6], suppressWeekend: true }],
    ['гинеколог, желательно женщина', { preferGender: 'female' }],
    ['запишите на 17:30', { timeExact: '17:30', bookingIntent: true }],
    ['около 18:00', { timeAround: '18:00' }],
    ['лор в субботу 16 октября', { date: { kind: 'date', month: 10, dayOfMonth: 16, expectWeekday: 6 } }],
    ['педиатр бесплатно по ОМС', { unsupported: ['oms'] }],
    ['онлайн-консультация не нужна', {}],
    // Часы словами и с частью суток.
    ['после шести вечера', { spokenAfter: '18:00' }],
    ['в 2 часа дня', { timeExact: '14:00' }],
    ['с 9 утра до 2 дня', { spokenAfter: '09:00', spokenBefore: '14:00' }],
    ['около семи вечера', { timeAround: '19:00' }],
    ['в два раза дешевле', {}],
    ['уролог после работы', { afterWork: true }],
    ['в пн или ср', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 1 }, { kind: 'weekday', weekday: 3 }] } }],
    ['через 2 дня', { date: { kind: 'in_days', days: 2 } }],
    // «Через 2 часа» — не время «2:00», а «не раньше, чем через 2 часа от сейчас».
    ['через 2 часа', { afterHours: 2 }],
    ['в районе Горок', { originHint: 'place', nearPlace: true }],
    // Сложные речевые обороты.
    ['не дороже двух с половиной тысяч', { maxPrice: 2500 }],
    ['бюджет тысяч пять', { maxPrice: 5000 }],
    ['до полутора тысяч', { maxPrice: 1500 }],
    ['стаж от десяти лет', { minExperience: 10 }],
    ['врач с опытом лет 15', { minExperience: 15 }],
    ['в Приволжском на этой неделе', { date: { kind: 'this_week' }, districts: ['Приволжский'] }],
    ['кроме Советского', { excludeDistricts: ['Советский'] }],
    ['не хочу к врачу-женщине', { doctorGender: 'male' }],
    ['обязательно женщина', { doctorGender: 'female' }],
    ['а женщина есть?', { doctorGender: 'female' }],
    ['почистить зубы', { serviceId: 'proc.dentist.hygiene', procedureSpecialty: 'dentist' }],
    ['пн-ср', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 1 }, { kind: 'weekday', weekday: 2 }, { kind: 'weekday', weekday: 3 }] } }],
    ['в понедельник на следующей неделе', { date: { kind: 'weekday', weekday: 1, week: 'next' } }],
    ['в ближайшие 2 часа', { withinHours: 2, nearestIsTime: true }],
    ['с пандусом и парковкой', { wheelchair: true, parking: true }],
    ['часов в пять вечера примерно', { timeAround: '17:00' }],
    ['кардиолог 8 часов вечера', { timeExact: '20:00' }],
    ['в будни', { workdays: true, suppressWeekend: true }],
    ['в любой день кроме выходных', { date: null, workdays: true, suppressWeekend: true }],
    // Район — только со словом «район»; «Московский проспект» — улица.
    ['в Вахитовском или Приволжском районе, но не в Советском районе', { districts: ['Вахитовский', 'Приволжский'], excludeDistricts: ['Советский'] }],
    ['кроме Советского района', { excludeDistricts: ['Советский'] }],
    ['на Московском проспекте', {}],
    ['в центре', { districts: ['Вахитовский'] }],
    ['в медицинском центре', {}],
    // Пол — только о враче.
    ['врач-женщина', { doctorGender: 'female' }],
    ['чтобы врач был мужчина', { doctorGender: 'male' }],
    ['нужен гинеколог женщина', { doctorGender: 'female' }],
    ['гинеколог женщине 30 лет', {}],
    ['я женщина, нужен терапевт', {}],
    // Стаж: «больше 15» — строго больше.
    ['с опытом больше 15 лет', { minExperience: 16 }],
    ['стаж от 10 лет', { minExperience: 10 }],
    ['мне 40 лет', {}],
    // Чего в демо нет — помечается, а не теряется.
    ['вызвать врача на дом', { unsupported: ['home_visit'] }],
    ['онлайн-консультация', { unsupported: ['online'] }],
    ['запишите онлайн', { bookingIntent: true }],
    ['лучший лор с отзывами', { unsupported: ['rating'] }],
    // Программа ДМС по названию; «Кама Премиум» — клиника, а не программа.
    ['по программе Demo Premium', { planId: 'demo-premium', dms: true }],
    ['в клинику Кама Премиум', {}],
    // Точка отправления словами — только рядом со словами о дороге.
    ['не дальше 20 минут от дома', { originHint: 'home' }],
    ['рядом с Кремлём', { originHint: 'place' }],
    ['что-нибудь от кашля', {}],
    ['рядом со мной', {}],
    // Рассказ о себе — не район и не точка: «работаю в центре», «живу на Азино».
    ['работаю в центре', {}],
    ['живу на Азино', {}],
    ['живу на Азино, нужен лор поближе', { originHint: 'home' }],
    ['я сейчас на Азино, нужен лор', { originHint: 'place', nearPlace: true }],
    // Неделя у дня недели: «следующий понедельник», «эта пятница».
    // «В следующую среду» — какая из двух сред, подбор уточнит (askWeek), если ближайшая ещё впереди.
    ['в следующую среду', { date: { kind: 'weekday', weekday: 3, week: 'next', askWeek: true } }],
    ['в эту пятницу', { date: { kind: 'weekday', weekday: 5, week: 'this' } }],
    ['в ближайший вторник', { date: { kind: 'weekday', weekday: 2 }, nearestIsTime: true }],
    ['на пятницу или следующий понедельник', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 5 }, { kind: 'weekday', weekday: 1, week: 'next' }] } }],
    // Несуществующее число — дата, которую подбор назовёт несуществующей, а не пропуск условия.
    ['32 октября', { date: { kind: 'date', month: 10, dayOfMonth: 32 } }],
    // «Через час» — от текущего времени; «час езды» — не о времени приёма.
    ['не раньше чем через час', { afterHours: 1 }],
    ['через полчаса', { afterHours: 0.5 }],
    ['через пару часов', { afterHours: 2 }],
    // Возраст врача в демо не указан; возраст пациента — не о враче.
    ['хирурга, которому больше 50 лет', { unsupported: ['doctor_age'] }],
    ['чтобы врач был постарше', { unsupported: ['doctor_age'] }],
    ['молодого гинеколога', { unsupported: ['doctor_age'] }],
    ['педиатра ребёнку, которому 5 лет', {}],
    ['маме 67 лет', {}],
    ['анонимно', { unsupported: ['anonymous'] }],
    // «Стаж побольше» — пожелание (опытные первыми), а не условие.
    ['у кого стаж побольше', { preferExperience: true }],
    ['самого опытного кардиолога', { preferExperience: true }],
    // Согласие на замену заранее: условия «по ОМС» больше нет — ищем платно.
    ['по ОМС, а если нельзя — то платно', { dms: false, fallbacks: ['oms'] }],
    ['на дом, а если нет — приеду сам', { fallbacks: ['home_visit'], consentInPerson: true }],
    // Раунд 6: сон и отрицание части суток — «после», а не «до».
    ['только не утром — я до 11 сплю', { spokenAfter: '12:00', busyUntil: true }],
    ['сплю до 9', { spokenAfter: '09:00', busyUntil: true }],
    ['только не вечером', { spokenBefore: '17:00' }],
    // Пол с запасным вариантом — пожелание, а не «к мужчине».
    ['к женщине, но если женщин нет — можно и к мужчине', { preferGender: 'female' }],
    ['лучше женщина, но можно и мужчина', { preferGender: 'female' }],
    // Цена: «тысячи до четырёх» — не «до 16:00»; точка и запятая после суммы — конец фразы.
    ['тысячи до четырёх', { maxPrice: 4000 }],
    ['До 2500.', { maxPrice: 2500 }],
    ['до 2500, в любой день', { date: null, maxPrice: 2500 }],
    // «Вечером, но не позже восьми» — 20:00.
    ['вечером, но не позже восьми', { spokenBefore: '20:00' }],
    ['на 9 утра, а если нет — то хотя бы до 11', { preferTime: '09:00' }],
    ['не старше 40 лет', { unsupported: ['doctor_age'] }],
    ['ребёнку не старше 10 лет', {}],
    ['только не к молодым врачам', { unsupported: ['doctor_age'] }],
    ['со стажем от 20', { minExperience: 20 }],
    ['лучше со стажем от 20', { preferMinExperience: 20 }],
    // Несколько окон времени через «или».
    ['с 10 до 12 или после 18', { timeWindows: [{ from: '10:00', to: '12:00' }, { from: '18:00', to: null }] }],
    ['в 18:00 или в 19:00', { timeWindows: [{ from: '18:00', to: '18:01' }, { from: '19:00', to: '19:01' }] }],
    ['до 8 утра или после 15:00', { timeWindows: [{ from: null, to: '08:00' }, { from: '15:00', to: null }] }],
    // Даты: опечатка, именительный падеж, диапазоны, ближайшие дни, исключения, запасной день.
    ['на после завтра', { date: { kind: 'after_tomorrow' } }],
    ['день — четверг', { date: { kind: 'weekday', weekday: 4 } }],
    ['с 15 по 17 октября', { date: { kind: 'range', from: { month: 10, dayOfMonth: 15, shift: 0 }, to: { month: 10, dayOfMonth: 17, shift: 0 } } }],
    ['до 20 октября', { date: { kind: 'range', from: null, to: { month: 10, dayOfMonth: 20, shift: -1 } } }],
    ['в ближайшие 3 дня', { date: { kind: 'next_days', days: 3 }, nearestIsTime: true }],
    ['в любой день этой недели', { date: { kind: 'this_week' } }],
    ['только не завтра', { excludeDays: [{ kind: 'tomorrow' }] }],
    ['в пятницу 16 октября, если нельзя — то в субботу 17-го', { date: { kind: 'any_of', options: [{ kind: 'date', month: 10, dayOfMonth: 16, expectWeekday: 5 }, { kind: 'date', month: null, dayOfMonth: 17, expectWeekday: 6 }] } }],
    ['поближе к дому', { originHint: 'home' }],
    ['а в другой клинике?', { clinicAny: true, clinicOther: true }],
    // Раунд 7: у каждого дня своё окно; «в среду не можем» — исключение.
    ['в среду не можем — кружок, в четверг после 15:30, а в пятницу только до обеда', {
      date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 4, from: '15:30', to: null }, { kind: 'weekday', weekday: 5, from: null, to: '12:00' }] },
      excludeWeekdays: [3],
      dayWindows: true,
      timeOfDay: 'morning',
    }],
    ['в пт после 19 или в сб до 12', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 5, from: '19:00', to: null }, { kind: 'weekday', weekday: 6, from: null, to: '12:00' }] }, dayWindows: true }],
    ['в эту субботу или в следующую', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 6, week: 'this' }, { kind: 'weekday', weekday: 6, week: 'next' }] } }],
    ['во вторник или в среду на следующей неделе', { date: { kind: 'any_of', options: [{ kind: 'weekday', weekday: 2, week: 'next' }, { kind: 'weekday', weekday: 3, week: 'next' }] } }],
    ['в 12:00 в четверг, или в 12:30', { date: { kind: 'weekday', weekday: 4 }, timeWindows: [{ from: '12:00', to: '12:01' }, { from: '12:30', to: '12:31' }] }],
    ['в районе 14:00', { timeAround: '14:00' }],
    ['ближайший по времени', { nearestIsTime: true }],
    ['нужно два слота подряд', { unsupported: ['multi_patient'] }],
    ['нужна справка для бассейна', { unsupported: ['certificate'] }],
    ['в Советском районе, но если там нет никого — можно Приволжский', { districts: ['Советский', 'Приволжский'], preferDistricts: ['Советский'] }],
    ['в Московском районе, а если там нет — то любой район', { preferDistricts: ['Московский'], districtAny: true }],
    ['а на Ново-Савиновском филиале?', { districts: ['Ново-Савиновский'] }],
    ['лучше по ДМС', { preferDms: true, dms: false }],
    ['у меня Demo Basic, но если что я готов заплатить', { planId: 'demo-basic', preferDms: true, dms: false, allowPaid: true }],
    ['хирург, но не детский, а взрослый', { adult: true }],
  ];
  for (const [text, expected] of cases) {
    it(`«${text}»`, () => {
      assert.deepEqual(extractBookingConstraints(text), expected);
    });
  }

  it('цена не принимается за время приёма: «до 3 000 ₽» — не «до 03:00»', () => {
    for (const text of ['до 3 000 рублей', 'до 3 тысяч', 'до 2к', 'с 3 000', 'до 2 дней', 'до 5 лет']) {
      const constraints = extractConstraints(text);
      assert.equal(constraints.availableBefore, undefined, text);
      assert.equal(constraints.availableAfter, undefined, text);
    }
    assert.equal(extractConstraints('до 18:30').availableBefore, '18:30');
  });

  it('время суток заменяет прежнее условие на время, а не складывается с ним', () => {
    const turns = ['ЛОР вечером', 'нет, лучше утром']
      .map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) }));
    const merged = mergeBookingTurns(turns);
    assert.equal(merged.evening, false);
    assert.equal(merged.timeFrom, null);
    assert.equal(merged.timeTo, '12:00');
  });

  it('сложные обороты в слиянии: «работаю до шести, поэтому после 19», «если на 18:30 нет — после 18», «по ДМС, а если никого — платно»', () => {
    const merge = (text) => mergeBookingTurns([{ booking: extractBookingConstraints(text), constraints: extractConstraints(text) }]);
    const work = merge('работаю до шести, поэтому после 19');
    assert.equal(work.timeFrom, '19:00');
    assert.equal(work.timeTo, null);
    const busy = merge('я работаю до 18');
    assert.equal(busy.timeFrom, '18:00');
    assert.equal(busy.timeTo, null);
    const fallback = merge('на 18:30, если нет — то после 18');
    assert.equal(fallback.timeFrom, '18:00');
    assert.equal(fallback.preferTime, '18:30');
    const dms = merge('по ДМС, а если по ДМС никого — платно, но не дороже 2000');
    assert.equal(dms.dms, false);
    assert.equal(dms.preferDms, true);
    assert.equal(dms.maxPrice, 2000);
    // «Утром» — только для запасного дня: сегодня — в любое время, завтра — до 12:00.
    const day = merge('сегодня, а если сегодня никого, то завтра утром');
    assert.deepEqual(day.date, { kind: 'any_of', options: [{ kind: 'today' }, { kind: 'tomorrow', from: null, to: '12:00' }] });
    assert.equal(day.timeTo, null);
    // «Ближайший час» — о времени, не о расстоянии.
    assert.equal(merge('невролог в ближайший час').nearest, false);
    assert.equal(merge('обязательно не дальше 15 минут').maxTravelMinutes, 15);
  });

  it('сложные обороты раунда 5: рассказ о себе, ДМС с потолком для платного, согласие следующей репликой', () => {
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    const story = merge(['Работаю в центре до 18:00, живу на Азино. Можно к лору вечером, по страховке Demo Standard, а если не входит — то не дороже 2000']);
    assert.deepEqual(story.districts, []);
    assert.equal(story.originHint, null);
    assert.equal(story.nearest, false);
    assert.equal(story.timeFrom, '18:00');
    assert.equal(story.timeTo, null);
    assert.equal(story.preferDms, true);
    assert.equal(story.maxPrice, 2000);
    assert.equal(story.planId, 'demo-standard');
    const oms = merge(['лор по ОМС', 'ладно, давайте платно']);
    assert.deepEqual(oms.unsupported, []);
    assert.deepEqual(oms.fallbacks, ['oms']);
    assert.equal(oms.dms, false);
    const stillOms = merge(['лор по ОМС', 'а завтра?']);
    assert.deepEqual(stillOms.unsupported, ['oms']);
    const home = merge(['терапевт на дом', 'хорошо, приеду сам']);
    assert.deepEqual(home.unsupported, []);
    assert.deepEqual(home.fallbacks, ['home_visit']);
    // «Через час» снимается новым днём.
    assert.equal(merge(['терапевт через час']).afterHours, 1);
    assert.equal(merge(['терапевт через час', 'а лучше завтра']).afterHours, null);
  });

  it('раунд 6: окна времени и даты не путаются с часами; «в субботу 17-го» — не «только выходные»', () => {
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    const windows = merge(['гинеколог с 10 до 12 или после 18']);
    assert.equal(windows.timeFrom, null);
    assert.equal(windows.timeTo, null);
    assert.equal(windows.timeWindows.length, 2);
    assert.equal(merge(['гинеколог с 10 до 12 или после 18', 'лучше после 17']).timeWindows, null);
    const until = merge(['дерматолог до 20 октября']);
    assert.equal(until.timeTo, null);
    assert.equal(until.date.kind, 'range');
    const range = merge(['кардиолог с 15 по 17 октября']);
    assert.equal(range.timeFrom, null);
    const fallback = merge(['хирург в пятницу 16 октября, если нельзя в пятницу, то в субботу 17-го']);
    assert.equal(fallback.weekend, false);
    const sleep = merge(['невролог завтра, только не утром — я до 11 сплю']);
    assert.equal(sleep.timeFrom, '12:00');
    assert.equal(sleep.timeTo, null);
    const price = merge(['стоматолог, не позже 19:00, тысячи до четырёх']);
    assert.equal(price.timeTo, '19:00');
    assert.equal(price.maxPrice, 4000);
    assert.equal(merge(['уролог завтра или в четверг, лучше вечером, но не позже восьми']).timeTo, '20:00');
    assert.deepEqual(merge(['уролог, только не завтра', 'в любой день']).excludeDays, []);
    assert.equal(extractConstraints('до 20 октября').availableBefore, undefined);
    assert.equal(extractConstraints('в радиусе 15 минут на такси').maxTravelMinutes, 15);
  });

  it('уточнения: «после 7» — вопрос «утра или вечера?», ответ следующей репликой выбирает прочтение', () => {
    assert.deepEqual(extractConstraints('после 7').timeAmbiguity, [{ from: '07:00', to: null }, { from: '19:00', to: null }]);
    assert.equal(extractConstraints('после 7').availableAfter, undefined);
    assert.equal(extractConstraints('после 5').availableAfter, '17:00');
    assert.equal(extractConstraints('до 2').availableBefore, '14:00');
    assert.deepEqual([extractConstraints('с 8 до 10').availableAfter, extractConstraints('с 8 до 10').availableBefore], ['08:00', '10:00']);
    assert.deepEqual([extractConstraints('с 5 до 7').availableAfter, extractConstraints('с 5 до 7').availableBefore], ['17:00', '19:00']);
    assert.equal(extractConstraints('после 7 вечером').availableAfter, '19:00');
    assert.deepEqual(extractBookingConstraints('после семи').timeAmbiguity, [{ from: '07:00', to: null }, { from: '19:00', to: null }]);
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    const asked = merge(['терапевт после 7']);
    assert.equal(asked.pendingTime.length, 2);
    assert.equal(asked.timeFrom, null);
    const evening = merge(['терапевт после 7', 'вечера']);
    assert.equal(evening.timeFrom, '19:00');
    assert.equal(evening.pendingTime, null);
    const morning = merge(['терапевт после 7', 'утром']);
    assert.equal(morning.timeFrom, '07:00');
    assert.equal(morning.timeTo, null);
    const replaced = merge(['терапевт после 7', 'нет, после 18']);
    assert.equal(replaced.timeFrom, '18:00');
    assert.equal(replaced.pendingTime, null);
    const week = merge(['кардиолог в следующую пятницу', 'ближайшую']);
    assert.deepEqual(week.date, { kind: 'weekday', weekday: 5, week: 'this' });
    assert.equal(week.nearest, false);
    assert.deepEqual(merge(['кардиолог в следующую пятницу', 'через неделю']).date, { kind: 'weekday', weekday: 5, week: 'next' });
  });

  it('контекст: согласия и ответы следующей репликой — пол, возраст врача, ДМС, программа, точка', () => {
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    const gender = merge(['гинеколог, только женщина', 'да, можно и к мужчине']);
    assert.equal(gender.doctorGender, null);
    assert.equal(gender.preferGender, 'female');
    assert.deepEqual(merge(['хирург, которому больше 50 лет', 'возраст не важен']).unsupported, []);
    const paid = merge(['терапевт по ДМС', 'можно и платно']);
    assert.equal(paid.preferDms, true);
    assert.equal(paid.dms, false);
    assert.equal(merge(['терапевт по ДМС', 'премиум']).planId, 'demo-premium');
    assert.equal(merge(['лор рядом с домом', 'я сейчас дома']).originConfirmed, true);
    assert.equal(merge(['кардиолог', 'а подешевле?']).preferCheap, true);
    assert.equal(merge(['кардиолог', 'запиши меня к первому']).pickOption, true);
    assert.equal(merge(['кардиолог', 'запиши меня к первому', 'а в четверг?']).pickOption, false);
    assert.deepEqual(merge(['стаж от 10 лет', 'стаж не важен']).minExperience, null);
  });

  it('контекст раунда 9: неделя переходит на день, «или …» добавляет вариант, «выходные тоже» — к будням', () => {
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    assert.deepEqual(merge(['кардиолог на следующей неделе', 'а можно в эту?', 'хорошо, тогда в четверг']).date, { kind: 'weekday', weekday: 4, week: 'this' });
    assert.deepEqual(merge(['лор в четверг', 'или в пятницу?']).date, { kind: 'any_of', options: [{ kind: 'weekday', weekday: 4 }, { kind: 'weekday', weekday: 5 }] });
    assert.deepEqual(merge(['лор на 13:30', 'или на 14:00']).timeWindows, [{ from: '13:30', to: '13:31' }, { from: '14:00', to: '14:01' }]);
    const weekend = merge(['невролог, я работаю до 19', 'и в выходные тоже можно']);
    assert.equal(weekend.date.kind, 'any_of');
    assert.deepEqual(weekend.date.options.map((option) => [option.weekday, option.from || null]), [[1, '19:00'], [2, '19:00'], [3, '19:00'], [4, '19:00'], [5, '19:00'], [6, null], [7, null]]);
    assert.equal(weekend.weekend, false);
    assert.equal(weekend.timeFrom, null);
    assert.equal(merge(['дерматолог, дерматоскопия', 'а просто консультация?']).serviceId, null);
    assert.equal(merge(['уролог', 'мужчина']).doctorGender, 'male');
    assert.equal(merge(['уролог', 'стаж не важен', 'а вот мужчина обязательно']).doctorGender, 'male');
    assert.deepEqual(extractBookingConstraints('около 8').timeAmbiguity, [{ from: '07:30', to: '08:31' }, { from: '19:30', to: '20:31' }]);
    assert.equal(extractBookingConstraints('около шести').timeAround, '18:00');
  });

  it('слияние: будни и выходные сменяют друг друга; район, пол, стаж держатся до отмены', () => {
    const merge = (texts) => mergeBookingTurns(texts.map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) })));
    const weekdays = merge(['терапевт в выходные', 'нет, лучше в будни']);
    assert.equal(weekdays.workdays, true);
    assert.equal(weekdays.weekend, false);
    const back = merge(['терапевт в будни', 'а можно в субботу']);
    assert.equal(back.workdays, false);
    const kept = merge(['лор в Вахитовском районе, врач-женщина, стаж от 10 лет', 'а завтра?']);
    assert.deepEqual(kept.districts, ['Вахитовский']);
    assert.equal(kept.doctorGender, 'female');
    assert.equal(kept.minExperience, 10);
    const cleared = merge(['лор в Вахитовском районе, врач-женщина', 'район не важен, пол врача не важен']);
    assert.deepEqual(cleared.districts, []);
    assert.equal(cleared.doctorGender, null);
  });

  it('слияние реплик: поздняя важнее, снятие обнуляет', () => {
    const turns = ['ЛОР завтра после 18:00 по ДМС до 3000 ₽', 'а лучше послезавтра', 'без ДМС, цена не важна, в любое время']
      .map((text) => ({ booking: extractBookingConstraints(text), constraints: extractConstraints(text) }));
    const step1 = mergeBookingTurns(turns.slice(0, 1));
    assert.deepEqual(step1.date, { kind: 'tomorrow' });
    assert.equal(step1.timeFrom, '18:00');
    assert.equal(step1.dms, true);
    assert.equal(step1.maxPrice, 3000);
    const step2 = mergeBookingTurns(turns.slice(0, 2));
    assert.deepEqual(step2.date, { kind: 'after_tomorrow' });
    assert.equal(step2.timeFrom, '18:00');
    const step3 = mergeBookingTurns(turns);
    assert.equal(step3.dms, false);
    assert.equal(step3.maxPrice, null);
    assert.equal(step3.timeFrom, null);
    assert.deepEqual(step3.date, { kind: 'after_tomorrow' });
  });
});

describe('Флаги демо-режима', () => {
  it('госучреждения скрыты только в демо и возвращаются PUBLIC_CLINICS=on', () => {
    assert.equal(publicClinicsHidden({}), false);
    assert.equal(publicClinicsHidden({ DEMO_DATA: 'on' }), true);
    assert.equal(publicClinicsHidden({ DEMO_DATA: 'on', PUBLIC_CLINICS: 'on' }), false);
    assert.equal(isPublicClinicRecord({ ownership: 'Государственная' }), true);
    assert.equal(isPublicClinicRecord({ ownership: 'Частная' }), false);
  });

  it('запись — только в демо и выключается DEMO_BOOKING=off', () => {
    assert.equal(bookingModeFromEnv({}), false);
    assert.equal(bookingModeFromEnv({ DEMO_DATA: 'on' }), true);
    assert.equal(bookingModeFromEnv({ DEMO_DATA: 'on', DEMO_BOOKING: 'off' }), false);
  });

  it('справочник ассистента в демо — без госучреждений; PUBLIC_CLINICS=on — с ними; данные не удаляются', async () => {
    const saved = { DEMO_DATA: process.env.DEMO_DATA, PUBLIC_CLINICS: process.env.PUBLIC_CLINICS };
    try {
      process.env.DEMO_DATA = 'on';
      delete process.env.PUBLIC_CLINICS;
      __resetCatalogCache();
      const hidden = await loadCatalog();
      const publicCount = (catalog) => [...catalog.doctors, ...catalog.clinics].filter(isPublicClinicRecord).length;
      assert.equal(publicCount(hidden), 0);
      assert.ok(hidden.doctors.some((doctor) => String(doctor.id).startsWith('demo-doc-')));
      process.env.PUBLIC_CLINICS = 'on';
      __resetCatalogCache();
      const shown = await loadCatalog();
      assert.ok(publicCount(shown) > 0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      __resetCatalogCache();
    }
  });

  it('/api/config отдаёт флаги', async () => {
    const saved = { DEMO_DATA: process.env.DEMO_DATA, PUBLIC_CLINICS: process.env.PUBLIC_CLINICS };
    process.env.DEMO_DATA = 'on';
    delete process.env.PUBLIC_CLINICS;
    try {
      let body = '';
      const res = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(chunk) { body = chunk; } };
      await configHandler({ method: 'GET', headers: {} }, res);
      const payload = JSON.parse(body);
      assert.equal(payload.demo, true);
      assert.equal(payload.publicClinics, false);
      assert.equal(typeof payload.booking, 'boolean');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('Контракт: запрос подбора в ответе ассистента', () => {
  it('неизвестные поля и строки вне списков отбрасываются', () => {
    const action = sanitizeAiAction({
      booking: {
        request: { specialty: 'lor', date: { kind: 'yesterday' }, timeFrom: '25:00', maxPrice: 3000, city: 'atlantis', injected: '<script>', dms: { required: 'yes' } },
        summary: ['ЛОР', 'x'.repeat(500), 42],
      },
    });
    assert.equal(action.booking.request.specialty, 'lor');
    assert.deepEqual(action.booking.request.date, { kind: 'any' });
    assert.equal(action.booking.request.timeFrom, null);
    assert.equal(action.booking.request.city, null);
    assert.equal(action.booking.request.dms.required, false);
    assert.equal(action.booking.request.injected, undefined);
    assert.equal(action.booking.summary[1].length, 80);
    assert.equal(action.booking.summary.length, 2);
    assert.equal(sanitizeAiAction({}).booking, null);
  });
});
