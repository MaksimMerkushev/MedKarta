/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сценарии ассистента для лабораторий. Все данные вымышлены. Ожидания заданы до
 * прогона и не подгоняются под результат.
 *
 * expect:
 *   tests        — корзина ровно из этих кодов (порядок не важен); [] — корзина пуста
 *   filters      — условия запроса подбора (date — вид даты, weekday; остальные — значения)
 *   noFilters    — условий, которых быть не должно
 *   search       — показан ли подбор лаборатории
 *   ambiguous    — уточняющий вопрос по неоднозначному слову (iron, sugar, thyroid, blood, hormones, biochem)
 *   quickReplies — кнопки, которые должны быть
 *   replyHas / replyNot — текст ответа
 *   path         — 'labs' (ответ лабораторный), 'doctor' (обычный путь, без лабораторий), 'both', 'emergency'
 *   doctor       — профиль записи к врачу (для doctor/both)
 *   model        — true: модели отданы фрагменты; false: модель не вызывалась
 *   fragmentsNot — чего не должно быть во фрагментах для модели
 * real: false — в тексте идентификаторы: такой сценарий никогда не уходит в настоящую модель.
 */

export const LAB_SCENARIOS = [
  // Из постановки задачи
  { id: 'L01', turns: ['Где сдать ОАК завтра утром?'], expect: { path: 'labs', tests: ['CBC_DIFF'], filters: { date: 'tomorrow', timeOfDay: 'morning' }, search: true, model: false } },
  { id: 'L02', turns: ['Хочу сдать ОАК и ферритин до 2000 рублей'], expect: { path: 'labs', tests: ['CBC_DIFF', 'FERRITIN'], filters: { maxTotalPrice: 2000 }, search: true } },
  { id: 'L03', turns: ['Хочу сдать ОАК и ферритин до 2000 рублей', 'Добавь ещё ТТГ'], expect: { path: 'labs', tests: ['CBC_DIFF', 'FERRITIN', 'TSH'], filters: { maxTotalPrice: 2000 }, search: true, replyHas: ['Добавил'] } },
  { id: 'L04', turns: ['Хочу сдать ОАК и ферритин до 2000 рублей', 'Добавь ещё ТТГ', 'Убери ферритин'], expect: { path: 'labs', tests: ['CBC_DIFF', 'TSH'], filters: { maxTotalPrice: 2000 }, search: true, replyHas: ['Убрал'] } },
  { id: 'L05', turns: ['Хочу сдать ОАК и ферритин', 'Найди вариант дешевле'], expect: { path: 'labs', tests: ['CBC_DIFF', 'FERRITIN'], filters: { sort: 'total' }, search: true } },
  { id: 'L06', turns: ['Хочу сдать ОАК', 'Только недалеко от площади Тукая'], expect: { path: 'labs', tests: ['CBC_DIFF'], filters: { originPlace: 'tukay', sort: 'distance' }, search: true } },
  { id: 'L07', turns: ['Хочу сдать ОАК завтра', 'Можно послезавтра?'], expect: { path: 'labs', tests: ['CBC_DIFF'], filters: { date: 'after_tomorrow' }, search: true } },
  { id: 'L08', turns: ['Мне назначили анализ на железо'], expect: { path: 'labs', tests: [], ambiguous: 'iron', search: false, quickReplies: ['Железо сыворотки', 'Ферритин'] } },
  { id: 'L09', turns: ['Хочу проверить щитовидку'], expect: { path: 'labs', tests: [], ambiguous: 'thyroid', search: false, quickReplies: ['Нужен эндокринолог'], replyHas: ['назначает врач'] } },
  { id: 'L10', turns: ['Где сдать кровь?'], expect: { path: 'labs', tests: [], ambiguous: 'blood', search: false } },
  { id: 'L11', turns: ['Нужен эндокринолог и анализ ТТГ'], expect: { path: 'both', doctor: 'endocrinologist', tests: ['TSH'], search: true } },
  { id: 'L12', turns: ['Хочу сдать ОАК и ферритин', 'Хочу сдать всё в одной лаборатории'], expect: { path: 'labs', tests: ['CBC_DIFF', 'FERRITIN'], search: true, replyHas: ['сдать всё сразу'] } },
  { id: 'L13', turns: ['Хочу сдать ферритин и ТТГ', 'А где быстрее получу результаты?'], expect: { path: 'labs', tests: ['FERRITIN', 'TSH'], filters: { sort: 'turnaround' }, search: true } },
  { id: 'L14', turns: ['Хочу сдать ОАК', 'Есть ли возможность сдать в субботу?'], expect: { path: 'labs', tests: ['CBC_DIFF'], filters: { date: 'weekday', weekday: 6 }, search: true } },
  { id: 'L15', turns: ['Мне срочно нужно к врачу, болит в груди и трудно дышать'], expect: { path: 'emergency', replyHas: ['103'] } },
  { id: 'L16', turns: ['Где дешевле всего сдать ферритин и ТТГ?'], expect: { path: 'labs', tests: ['FERRITIN', 'TSH'], filters: { sort: 'total' }, search: true, replyNot: ['дешевле всего в городе', 'самая дешёвая'] } },
  { id: 'L17', turns: ['Врач назначил ОАК, СРБ и глюкозу. Хочу сдать всё за один раз'], expect: { path: 'labs', tests: ['CBC_DIFF', 'CRP', 'GLUCOSE'], search: true, replyHas: ['натощак'] } },
  { id: 'L18', turns: ['Найди лабораторию рядом с площадью Тукая, желательно до 1500 рублей'], expect: { path: 'labs', tests: [], search: false, filters: { originPlace: 'tukay', maxTotalPrice: 1500 }, replyHas: ['Какие анализы'] } },
  { id: 'L19', turns: ['Хочу сдать ОАК и ферритин завтра утром до 2000 рублей', 'Нет, анализы хочу сдавать не завтра, а в пятницу'], expect: { path: 'labs', tests: ['CBC_DIFF', 'FERRITIN'], filters: { date: 'weekday', weekday: 5, timeOfDay: 'morning', maxTotalPrice: 2000 }, search: true } },
  { id: 'L20', turns: ['Хочу сдать ТТГ', 'Покажи варианты подешевле, но не дальше 20 минут от центра'], expect: { path: 'labs', tests: ['TSH'], filters: { sort: 'total', maxMinutes: 20, originPlace: 'center' }, search: true } },
  // Названия, падежи, состав
  { id: 'L21', turns: ['Сдать общего анализа крови и анализ мочи по Нечипоренко'], expect: { path: 'labs', tests: ['CBC_DIFF', 'NECHIPORENKO'], search: true } },
  { id: 'L22', turns: ['Сдать сахар в крови и Т4 свободный в 8:30'], expect: { path: 'labs', tests: ['GLUCOSE', 'FT4'], filters: { timeFrom: '08:30' }, search: true } },
  { id: 'L23', turns: ['Сдать анализ на сахар'], expect: { path: 'labs', tests: [], ambiguous: 'sugar', search: false, quickReplies: ['Глюкоза в крови', 'HbA1c'] } },
  { id: 'L24', turns: ['ОАК без лейкоцитарной формулы где сделать?'], expect: { path: 'labs', tests: ['CBC'], search: true } },
  { id: 'L25', turns: ['Хочу сдать ОАК и ферритин', 'не ферритин, а железо сыворотки'], expect: { path: 'labs', tests: ['CBC_DIFF', 'IRON'], search: true } },
  { id: 'L26', turns: ['Как подготовиться к анализу на ТТГ?'], expect: { path: 'labs', tests: ['TSH'], search: true, replyHas: ['Подготовка'] } },
  { id: 'L27', turns: ['Расшифруй мой анализ: у меня гемоглобин 98'], expect: { path: 'labs', tests: [], search: false, model: false, replyHas: ['не расшифровываю'] } },
  { id: 'L28', turns: ['Хочу сдать ферритинн'], expect: { path: 'labs', tests: ['FERRITIN'], search: true, model: true, replyHas: ['сопоставил'] } },
  { id: 'L29', turns: ['Хочу сдать анализ на печёнку'], expect: { path: 'labs', tests: [], search: false, model: true, replyHas: ['Не нашёл в каталоге'] } },
  { id: 'L30', turns: ['Где сдать анализ на ВИЧ?'], expect: { path: 'labs', tests: ['HIV_AGAB'], search: true, model: false } },
  { id: 'L31', turns: ['Где быстрее всего сделают ПЦР на ковид?'], expect: { path: 'labs', tests: ['COVID_PCR'], filters: { sort: 'turnaround' }, search: true } },
  { id: 'L32', turns: ['Липидограмма и глюкоза натощак завтра'], expect: { path: 'labs', tests: ['LIPID_PROFILE', 'GLUCOSE'], filters: { date: 'tomorrow' }, search: true } },
  { id: 'L33', turns: ['Сдать витамин Д и ферритин после 18:00'], expect: { path: 'labs', tests: ['VITD', 'FERRITIN'], filters: { timeFrom: '18:00' }, search: true, replyHas: ['вечером это обычно невозможно'] } },
  { id: 'L34', turns: ['Хочу сдать ОАК', 'и ещё ОАМ'], expect: { path: 'labs', tests: ['CBC_DIFF', 'URINE_GENERAL'], search: true } },
  { id: 'L35', turns: ['Хочу сдать ОАК, ТТГ и ферритин', 'только ТТГ'], expect: { path: 'labs', tests: ['TSH'], search: true } },
  { id: 'L36', turns: ['Хочу сдать ОАК', 'вместо ОАК — ОАМ'], expect: { path: 'labs', tests: ['URINE_GENERAL'], search: true } },
  { id: 'L37', turns: ['Кал на скрытую кровь и копрограмма, где сдать?'], expect: { path: 'labs', tests: ['FECES_OCCULT', 'COPROGRAM'], search: true } },
  { id: 'L38', turns: ['Хочу сдать ОАК с результатом в тот же день'], expect: { path: 'labs', tests: ['CBC_DIFF'], filters: { maxTurnaroundHours: 10 }, search: true } },
  // Поиск врачей не должен сломаться
  { id: 'L39', turns: ['Болит горло, нужен лор завтра'], expect: { path: 'doctor', doctor: 'lor' } },
  { id: 'L40', turns: ['Нужен кардиолог завтра после 18 до 3000'], expect: { path: 'doctor', doctor: 'cardiologist' } },
  { id: 'L41', turns: ['Кардиолог назначил липидограмму, где сдать?'], expect: { path: 'labs', tests: ['LIPID_PROFILE'], search: true } },
  { id: 'L42', turns: ['Мне 70 лет, хочу сдать общий анализ мочи'], expect: { path: 'labs', tests: ['URINE_GENERAL'], search: true } },
  { id: 'L43', turns: ['Хочу сдать гормоны'], expect: { path: 'labs', tests: [], ambiguous: 'hormones', search: false } },
  { id: 'L44', turns: ['Сдать биохимию'], expect: { path: 'labs', tests: [], ambiguous: 'biochem', search: false } },
  { id: 'L45', turns: ['Хочу сдать ТТГ завтра утром', 'время не важно'], expect: { path: 'labs', tests: ['TSH'], filters: { date: 'tomorrow' }, noFilters: ['timeOfDay', 'timeFrom', 'timeTo'], search: true } },
  { id: 'L46', turns: ['Хочу сдать ферритин до 1500', 'цена любая'], expect: { path: 'labs', tests: ['FERRITIN'], noFilters: ['maxTotalPrice'], search: true } },
  { id: 'L47', turns: ['Записаться на ОАК завтра в 9 утра'], expect: { path: 'labs', tests: ['CBC_DIFF'], filters: { date: 'tomorrow', timeFrom: '09:00' }, search: true, replyHas: ['запись демонстрационная'] } },
  { id: 'L48', real: false, turns: ['Хочу сдать ТТГ. Меня зовут Иван Петров, телефон 89171234567'], expect: { path: 'labs', tests: ['TSH'], search: true, model: false } },
  { id: 'L49', real: false, turns: ['Хочу сдать ферритинн, я Иван Петров'], expect: { path: 'labs', tests: ['FERRITIN'], search: true, model: true, fragmentsNot: ['Иван', 'Петров'] } },
];

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

/**
 * @returns {string[]} расхождения с ожиданием
 */
export const checkLabScenario = (scenario, { action, planSource, fragments }) => {
  const { expect } = scenario;
  const problems = [];
  const labs = action.labs;
  const reply = action.replyText || '';
  const emergency = /\b(?:103|112)\b/u.test(reply) && !labs && !action.booking;
  if (expect.path === 'emergency') {
    if (!emergency) problems.push('нет совета 103/112');
    return problems;
  }
  if (emergency) problems.push('ложная тревога 103/112');
  if (expect.path === 'doctor') {
    if (labs) problems.push(`лишняя лабораторная часть: ${labs.tests.map((test) => test.code).join('+')}`);
    if (expect.doctor && action.booking?.request?.specialty !== expect.doctor) problems.push(`врач ${action.booking?.request?.specialty || '—'}, ожидался ${expect.doctor}`);
    return problems;
  }
  if (expect.path === 'labs' && planSource !== 'labs') problems.push(`ответ не лабораторный (${planSource})`);
  if (expect.path === 'both') {
    if (action.booking?.request?.specialty !== expect.doctor) problems.push(`врач ${action.booking?.request?.specialty || '—'}, ожидался ${expect.doctor}`);
    if (!labs) problems.push('нет лабораторной части');
  }
  if (!labs) {
    problems.push('нет лабораторной части ответа');
    return problems;
  }
  const codes = labs.tests.map((test) => test.code);
  if (expect.tests && !sameSet(codes, expect.tests)) problems.push(`корзина ${codes.join('+') || '—'}, ожидалась ${expect.tests.join('+') || '—'}`);
  if (expect.search !== undefined && labs.search !== expect.search) problems.push(`подбор ${labs.search ? 'показан' : 'не показан'}`);
  const request = labs.request;
  for (const [name, value] of Object.entries(expect.filters || {})) {
    const actual = name === 'date' ? request.date?.kind : name === 'weekday' ? request.date?.weekday : name === 'maxMinutes' ? request.travel?.maxMinutes : request[name];
    if (actual !== value) problems.push(`${name}: ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(value)}`);
  }
  for (const name of expect.noFilters || []) {
    const actual = request[name];
    if (actual !== null && actual !== undefined && actual !== false) problems.push(`лишнее условие ${name}: ${JSON.stringify(actual)}`);
  }
  for (const label of expect.quickReplies || []) if (!(action.quickReplies || []).includes(label)) problems.push(`нет кнопки «${label}»`);
  for (const text of expect.replyHas || []) if (!reply.includes(text)) problems.push(`в ответе нет «${text}»`);
  for (const text of expect.replyNot || []) if (reply.toLowerCase().includes(text.toLowerCase())) problems.push(`в ответе есть «${text}»`);
  if (expect.model === true && fragments.length === 0) problems.push('модель не вызывалась');
  if (expect.model === false && fragments.length > 0) problems.push(`модели ушло: ${fragments.join(', ')}`);
  for (const text of expect.fragmentsNot || []) if (fragments.some((fragment) => fragment.includes(text))) problems.push(`модели ушло «${text}»`);
  if (expect.ambiguous && !(action.quickReplies?.length || /\?/u.test(reply))) problems.push('нет уточняющего вопроса');
  return problems;
};
