/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Таксономия обфускации: шесть способов записать одно и то же так, чтобы
 * детектор промахнулся, плюс отдельный блок на ЛОЖНЫЕ срабатывания.
 *
 * Зачем второй блок. Склейка разорванных написаний — приём с двумя краями:
 * она обязана поймать «П е т р о в у», но не имеет права превратить в фамилию
 * «кто-то», «с 9-00 до 18-00» или «с 1-го по 5-е марта». Проверка только
 * первого края даёт слой, который редактирует половину обычного текста.
 *
 * Все проверки идут на фикстуре, а не на реальном справочнике: состав базы
 * меняется, а поведение конвейера меняться не должно.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectEntities, detectObfuscation, ENTITY_KIND } from '../api/_shared/privacy/detectors.js';
import { createEntityResolver } from '../api/_shared/privacy/entityResolver.js';
import { extractConstraints } from '../api/_shared/privacy/gateway.js';
import { GATEWAY_DECISION } from '../api/_shared/privacy/models.js';
import { translitKey } from '../api/_shared/privacy/normalize.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { makeGateway, TEST_SESSION } from './helpers.js';

const resolver = createEntityResolver(fixtureCatalog());

/** Находит ли резолвер врача и того ли. */
const resolvedDoctor = (text) => {
  const links = resolver.resolve(text).links.filter((link) => link.kind === ENTITY_KIND.DOCTOR);
  return links.length > 0 ? links[0] : null;
};

const PETROV_IDS = ['fx-doc-petrov-therapist', 'fx-doc-petrova-dentist', 'fx-doc-petrov-surgeon'];

const assertFindsPetrov = (text) => {
  const link = resolvedDoctor(text);
  assert.ok(link, `фамилия не распознана: ${text}`);
  assert.ok(
    link.ids.some((id) => PETROV_IDS.includes(id)),
    `распознан не тот врач для «${text}»: ${JSON.stringify(link.ids)}`,
  );
};

describe('Группа 1. Посимвольное разбиение', () => {
  it('пробелы между буквами', () => assertFindsPetrov('построй маршрут к П е т р о в у'));
  it('точки между буквами', () => assertFindsPetrov('построй маршрут к П.е.т.р.о.в.у'));
  it('дефисы между буквами', () => assertFindsPetrov('построй маршрут к П-е-т-р-о-в-у'));
  it('подчёркивания', () => assertFindsPetrov('построй маршрут к П_е_т_р_о_в_у'));
  it('смешанные разделители', () => assertFindsPetrov('построй маршрут к П.е т-р о в у'));

  it('спан покрывает фамилию целиком, а не её часть', () => {
    const text = 'построй маршрут к П е т р о в у';
    const link = resolvedDoctor(text);
    const covered = text.slice(link.start, link.end);
    assert.ok(!/^к\s/u.test(covered), `в спан попал предлог: ${JSON.stringify(covered)}`);
    assert.equal(
      covered.replace(/[^\p{L}]/gu, '').toLowerCase(),
      'петрову',
      `спан обрезан: ${JSON.stringify(covered)}`,
    );
  });
});

describe('Группа 2. Разрыв внутри слова', () => {
  it('один пробел посередине', () => assertFindsPetrov('запиши к Петр ову'));
  it('один пробел ближе к началу', () => assertFindsPetrov('запиши к Пет рову'));

  it('не склеивает два обычных слова в фамилию', () => {
    assert.equal(resolvedDoctor('нужен приём врача завтра утром'), null);
    assert.equal(resolvedDoctor('покажи все клиники рядом со мной'), null);
  });
});

describe('Группа 3. Транслитерация', () => {
  it('прямая латиница', () => assertFindsPetrov('маршрут к врачу Petrov'));
  it('окончание -off', () => assertFindsPetrov('маршрут к врачу Petroff'));

  it('диграфы сводятся к одному скелету', () => {
    assert.equal(translitKey('Кузнецов'), translitKey('Kuznetsov'));
    assert.equal(translitKey('Кузнецов'), translitKey('Kuznecov'));
    assert.equal(translitKey('Сидоров'), translitKey('Sidoroff'));
  });

  it('находит врача по латинскому написанию из справочника', () => {
    const link = resolvedDoctor('маршрут к врачу Kuznetsov');
    assert.ok(link, 'транслитерация не распознана');
    assert.ok(link.ids.includes('fx-doc-kuznecov-gastro'));
  });

  it('латинское слово без указателя на человека не становится фамилией', () => {
    assert.equal(resolvedDoctor('покажи online запись'), null);
  });
});

describe('Группа 4. Подмена символов', () => {
  it('латинские гомоглифы внутри кириллического слова', () =>
    assertFindsPetrov('запиши к Рeтрову'));

  it('невидимые символы внутри слова', () => assertFindsPetrov('запиши к Пет​рову'));

  it('цифра вместо похожей буквы', () => assertFindsPetrov('запиши к Петр0ву'));

  it('невидимые символы не ломают обычный текст', () => {
    assert.equal(resolvedDoctor('нужен те​рапевт рядом'), null);
  });
});

describe('Группа 5. Растягивание', () => {
  it('удвоенные буквы', () => assertFindsPetrov('запиши к Пеетрову'));
  it('утроенные буквы', () => assertFindsPetrov('запиши к Пеееетрову'));
});

describe('Группа 6. Числа и адреса', () => {
  const kinds = (text) => new Set(detectEntities(text).spans.map((span) => span.kind));

  it('телефон, записанный с разрядкой', () => {
    assert.ok(kinds('позвоните 8 9 6 5 1 2 3 4 5 6 7').has(ENTITY_KIND.PHONE));
  });

  it('телефон через точки', () => {
    assert.ok(kinds('позвоните 8.965.123.45.67').has(ENTITY_KIND.PHONE));
  });

  it('почта, записанная словами', () => {
    assert.ok(kinds('пишите ivan (собака) mail точка ru').has(ENTITY_KIND.EMAIL));
    assert.ok(kinds('пишите ivan [at] mail [dot] ru').has(ENTITY_KIND.EMAIL));
  });

  it('координаты в русской локали: запятая как десятичный разделитель', () => {
    // Именно так координаты копируются из отечественных карт.
    assert.ok(kinds('я на 55,753381 49,173867').has(ENTITY_KIND.COORDS));
    assert.ok(kinds('я на 55.753381, 49.173867').has(ENTITY_KIND.COORDS));
  });

  it('СНИЛС с разрядкой и с меткой', () => {
    assert.ok(kinds('снилс 123-456-789 01').has(ENTITY_KIND.SNILS));
    assert.ok(kinds('мой СНИЛС 123 456 789 01').has(ENTITY_KIND.SNILS));
  });
});

describe('Группа 7. Ложные срабатывания — обычный текст не должен ломаться', () => {
  const MUST_NOT_MATCH = [
    ['неопределённое местоимение', 'нужен кто-то из терапевтов'],
    ['диапазон часов', 'приём с 9-00 до 18-00'],
    ['диапазон дат', 'запись с 1-го по 5-е марта'],
    ['номер дома с корпусом', 'ул. Победы д. 12 корп. 3'],
    ['предлоги подряд', 'я и ты и он пойдём вместе'],
    ['сложное слово через дефис', 'нужна какая-нибудь клиника поблизости'],
    ['перечисление дней', 'работает пн ср пт'],
  ];

  for (const [label, text] of MUST_NOT_MATCH) {
    it(`${label}: не становится фамилией`, () => {
      assert.equal(resolvedDoctor(text), null, `ложное совпадение в «${text}»`);
    });
  }

  it('дефисная фамилия распознаётся целиком — это не ложное срабатывание', () => {
    const text = 'врач Петров-Водкин принимает завтра';
    const link = resolvedDoctor(text);
    assert.ok(link, 'дефисная фамилия пропущена');
    assert.ok(text.slice(link.start, link.end).includes('Петров'));
  });

  it('инициалы после фамилии попадают в тот же спан', () => {
    const text = 'запись к Петров А. С. на завтра';
    const link = resolvedDoctor(text);
    assert.ok(link, 'фамилия с инициалами пропущена');
    const covered = text.slice(link.start, link.end);
    assert.ok(/А\.\s*С\./u.test(covered), `инициалы остались вне спана: ${JSON.stringify(covered)}`);
  });
});

describe('Группа 8. Признаки нарочитого разрыва', () => {
  it('цепочка одиночных букв помечается подозрительной', () => {
    assert.equal(detectObfuscation('построй маршрут к П е т р о в у').suspicious, true);
    assert.equal(detectObfuscation('я к в р а ч у хочу').suspicious, true);
  });

  it('цифры рвут цепочку: расписание не считается разрывом', () => {
    assert.equal(detectObfuscation('приём с 9 до 18 в пн ср пт').suspicious, false);
    assert.equal(detectObfuscation('я и ты и он пойдём').suspicious, false);
    assert.equal(detectObfuscation('обычный запрос про терапевта').suspicious, false);
  });

  it('цифры, записанные словами, помечаются подозрительными', () => {
    assert.equal(
      detectObfuscation('телефон восемь девять шесть пять один два').suspicious,
      true,
    );
  });

  it('распознанная фамилия проходит наружу токеном', async () => {
    const { gateway } = makeGateway();
    const result = await gateway.process({
      messages: [{ role: 'user', content: 'построй маршрут к П е т р о в у' }],
      sessionId: TEST_SESSION,
    });

    assert.equal(result.decision, GATEWAY_DECISION.ALLOW_EXTERNAL);
    const outbound = result.request.toWireMessages()[0].content;
    assert.ok(/@DOCTOR_/.test(outbound), `нет токена: ${outbound}`);
    assert.ok(!/П\s*е\s*т\s*р\s*о\s*в/u.test(outbound), `фамилия ушла наружу: ${outbound}`);
  });

  it('НЕраспознанный разрыв останавливает внешний вызов', async () => {
    const { gateway } = makeGateway();
    const result = await gateway.process({
      messages: [{ role: 'user', content: 'построй маршрут к Н е и з в е с т н о м у' }],
      sessionId: TEST_SESSION,
    });

    // Отличить неизвестную фамилию по буквам от бессмыслицы мы не можем,
    // поэтому наружу не отправляем ничего.
    assert.equal(result.decision, GATEWAY_DECISION.LOCAL_ONLY);
    assert.equal(result.reason, 'obfuscation_unresolved');
    assert.equal(result.request, null);
  });

  it('доля редактуры считается по значащим символам', async () => {
    const { gateway } = makeGateway();
    const spaced = await gateway.process({
      messages: [{ role: 'user', content: 'построй маршрут к П.е.т.р.о.в.у' }],
      sessionId: TEST_SESSION,
    });

    // Разделители не должны раздувать долю редактуры: фамилия уже заменена
    // токеном, и уводить такой запрос в fail-closed незачем.
    assert.equal(spaced.decision, GATEWAY_DECISION.ALLOW_EXTERNAL);
  });
});

describe('Группа 9. Отрицание', () => {
  it('«не в государственную» выбирает частную, а не государственную', () => {
    assert.equal(
      extractConstraints('Хочу к неврологу, но только не в государственную').ownership,
      'Частная',
    );
  });

  it('«не частную» выбирает государственную', () => {
    assert.equal(extractConstraints('только не частную клинику').ownership, 'Государственная');
  });

  it('утверждение работает как раньше', () => {
    assert.equal(extractConstraints('нужна частная клиника').ownership, 'Частная');
    assert.equal(extractConstraints('бесплатно по ОМС').ownership, 'Государственная');
  });

  it('отрицание булевых признаков снимает условие, а не ставит его', () => {
    const constraints = extractConstraints('не в выходные, а в будни вечером');
    assert.equal(constraints.weekend, undefined);
    assert.equal(constraints.evening, true);
  });

  it('отрицаемая специальность не попадает в подсказки', () => {
    const resolved = resolver.resolve('Мне не нужен кардиолог, найди лучше невролога');
    assert.ok(resolved.specialties.includes('neurologist'));
    assert.ok(
      !resolved.specialties.includes('cardiologist'),
      'отвергнутая специальность попала в подсказки',
    );
  });

  it('рейтинг и стаж извлекаются локально', () => {
    const constraints = extractConstraints('кардиолог с рейтингом от 4,5 и стажем от 10 лет');
    assert.equal(constraints.minRating, 4.5);
    assert.equal(constraints.minExperience, 10);
  });
});
