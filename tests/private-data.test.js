/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Частные клиники, цены и ДМС: справочник услуг, разворачивание
 * справочника в карточки, покрытие программ ДМС, демо-набор.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchService, normalizePrice, SERVICES } from '../shared/services.js';
import { flattenPrivateCatalog, validatePrivateCatalog } from '../shared/privateCatalog.js';
import { coverageBadge, coverageFor, validateInsuranceData } from '../shared/dms.js';
import { demoInsurance, demoPrivateCatalog } from '../data/demo/index.js';
import { extractConstraints } from '../backend/privacy/gateway.js';
import { validatePlan } from '../backend/planner/validator.js';
import { sanitizeAiAction } from '../shared/contract.js';
import { specialtyCode } from '../shared/specialties.js';
import { __resetCatalogCache, loadCatalog } from '../backend/privacy/catalog.js';

const TODAY = '2026-10-01';
const items = flattenPrivateCatalog(demoPrivateCatalog);
const byId = (id) => items.find((item) => item.id === id);
const place = (item) => ({
  clinicId: item.clinicId,
  branchId: item.branchId,
  entityKind: item.doctorId ? 'doctor' : 'facility',
  specialtyKey: item.doctorId ? specialtyCode(item.specialty) : null,
  pediatric: Boolean(item.features?.children),
});

describe('Справочник услуг', () => {
  it('сводит разные названия из прайсов к одной услуге', () => {
    for (const text of ['Приём ЛОР-врача первичный', 'Консультация оториноларинголога', 'Прием (осмотр, консультация) врача-оториноларинголога первичный', 'Приём детского ЛОРа']) {
      assert.equal(matchService(text), 'consult.lor.first', text);
    }
    assert.equal(matchService('Консультация оториноларинголога (повторная)'), 'consult.lor.repeat');
    assert.equal(matchService('Приём акушера-гинеколога повторный'), 'consult.gynecologist.repeat');
    assert.equal(matchService('УЗИ органов брюшной полости'), 'diag.ultrasound.abdomen');
    assert.equal(matchService('ОАК'), 'lab.cbc');
  });

  it('не путает похожие профили, пакеты и комбинации', () => {
    for (const text of [
      'Приём кардиохирурга', 'Приём детского хирурга', 'Консультация онколога-маммолога',
      'Приём педиатра на дому', 'Онлайн-консультация терапевта', 'Приём терапевта и кардиолога',
      'Прием хирурга-проктолога и терапевта', 'Холтер ЭКГ (суточный)', 'Биохимический анализ крови',
      'УЗИ брюшной полости + почки, комплекс',
    ]) {
      assert.equal(matchService(text), null, text);
    }
  });

  it('каждая консультация имеет код номенклатуры', () => {
    for (const service of SERVICES.filter((item) => item.kind === 'consult')) {
      assert.match(service.nomenclature, /^B01\.\d{3}\.00[12]$/, service.id);
    }
  });

  it('разбирает цены из прайса и сохраняет «от»', () => {
    assert.deepEqual(normalizePrice('1 500 ₽'), { min: 1500, max: 1500 });
    assert.deepEqual(normalizePrice('от 1000 руб.'), { min: 1000, max: 1000, from: true });
    assert.deepEqual(normalizePrice({ min: 1200, max: 1800 }), { min: 1200, max: 1800 });
    for (const bad of [0, -5, 'бесплатно', 'по запросу', null, NaN]) assert.equal(normalizePrice(bad), null, String(bad));
  });
});

describe('Справочник частных клиник', () => {
  it('демо-набор проходит проверку и помечен как демо', () => {
    assert.deepEqual(validatePrivateCatalog(demoPrivateCatalog), []);
    assert.ok(items.length > 30);
    assert.ok(items.every((item) => item.demo === true && item.source === 'demo'));
    assert.ok(items.every((item) => !item.website || /\.example$/.test(new URL(item.website).hostname)), 'демо-сайты только в .example');
    assert.ok(items.every((item) => !item.phone || /\(843\) 000-/.test(item.phone)), 'демо-телефоны только с кодом 000');
  });

  it('находит битые ссылки между записями', () => {
    const broken = structuredClone(demoPrivateCatalog);
    broken.doctors[0].branchIds = ['no-such-branch'];
    broken.prices[0].serviceId = 'consult.astrologer.first';
    broken.clinics[0].branches[0].hours = 'когда как';
    const errors = validatePrivateCatalog(broken);
    assert.ok(errors.some((error) => error.includes('no-such-branch')));
    assert.ok(errors.some((error) => error.includes('consult.astrologer.first')));
    assert.ok(errors.some((error) => error.includes('часы не разбираются')));
    assert.deepEqual(flattenPrivateCatalog(broken), [], 'битый справочник не должен попадать в интерфейс');
  });

  it('врач в двух филиалах — две карточки, у каждой свой филиал и цена', () => {
    const center = byId('demo-doc-garifullin--demo-zdorovie-center');
    const azino = byId('demo-doc-garifullin--demo-zdorovie-azino');
    assert.equal(center.branchId, 'demo-zdorovie-center');
    assert.equal(azino.branchId, 'demo-zdorovie-azino');
    assert.equal(center.consultPrice, 2200);
    assert.equal(azino.consultPrice, 2000);
    assert.notDeepEqual([center.lat, center.lng], [azino.lat, azino.lng]);
  });

  it('детский профиль даёт признак детского приёма', () => {
    assert.equal(byId('demo-doc-fatkullin--demo-malysh-gorki').features.children, true);
    assert.equal(byId('demo-doc-garifullin--demo-zdorovie-center').features.children, false);
    assert.equal(byId('demo-malysh-gorki').features.children, true, 'филиал детской клиники');
  });

  it('цена «от» сохраняется до карточки', () => {
    const dentist = byId('demo-doc-salikhov--demo-dent-avia');
    assert.equal(dentist.servicePrices.find((price) => price.serviceId === 'consult.dentist.first').from, true);
    assert.equal(dentist.consultPrice, 1000);
  });
});

describe('ДМС: покрытие программы', () => {
  const branchIds = new Set(demoPrivateCatalog.clinics.flatMap((clinic) => clinic.branches.map((branch) => branch.id)));

  it('демо-справочник ДМС корректен и ссылается на существующие филиалы', () => {
    assert.deepEqual(validateInsuranceData(demoInsurance, { branchIds }), []);
  });

  it('проверка ловит ошибки справочника', () => {
    const broken = structuredClone(demoInsurance);
    broken.coverage.push({ planId: 'nope', branchId: 'demo-x', scope: 'specialty', access: 'maybe' });
    const errors = validateInsuranceData(broken, { branchIds });
    assert.ok(errors.some((error) => error.includes('нет программы nope')));
    assert.ok(errors.some((error) => error.includes('нет филиала demo-x')));
    assert.ok(errors.some((error) => error.includes('не указана специальность')));
    assert.ok(errors.some((error) => error.includes('неверный режим доступа')));
  });

  const cover = (planId, id, options = {}) => coverageFor(demoInsurance, planId, place(byId(id)), { today: TODAY, ...options });

  it('режимы доступа: напрямую, через пульт, по направлению', () => {
    assert.deepEqual(
      [cover('demo-strakh-basic', 'demo-doc-veresova--demo-zdorovie-center').access,
        cover('demo-strakh-basic', 'demo-doc-garifullin--demo-zdorovie-center').access,
        cover('demo-strakh-basic', 'demo-doc-nurieva--demo-zdorovie-center').access],
      ['direct', 'via_pult', 'referral_required'],
    );
  });

  it('специалист вне программы и исключение — не покрыты', () => {
    assert.equal(cover('demo-strakh-basic', 'demo-doc-sokolov--demo-zdorovie-center').reason, 'specialty_not_covered');
    // В Азино вся амбулатория через пульт, но урология исключена — точное правило главнее общего.
    const urology = cover('demo-strakh-basic', 'demo-doc-lebedev--demo-zdorovie-azino');
    assert.equal(urology.status, 'not_covered');
    assert.equal(urology.reason, 'excluded');
    assert.equal(cover('demo-strakh-basic', 'demo-doc-safina--demo-zdorovie-azino').access, 'via_pult');
  });

  it('согласование конкретной услуги сильнее «вся амбулатория»', () => {
    const result = coverageFor(demoInsurance, 'demo-strakh-basic', place(byId('demo-doc-veresova--demo-zdorovie-center')), { today: TODAY, serviceId: 'diag.ultrasound.abdomen' });
    assert.equal(result.access, 'approval_required');
  });

  it('покрытие — по филиалу, а не по клинике', () => {
    // «Оптимум»: Азино и центр — напрямую, Чистопольская — через пульт.
    assert.equal(cover('demo-strakh-optimum', 'demo-doc-sokolov--demo-zdorovie-center').access, 'direct');
    assert.equal(cover('demo-strakh-optimum', 'demo-doc-sokolov--demo-zdorovie-sever').access, 'via_pult');
    // Тот же ЛОР в двух филиалах — по-разному в «Базовой».
    assert.equal(cover('demo-strakh-basic', 'demo-doc-garifullin--demo-zdorovie-azino').access, 'via_pult');
  });

  it('детская программа — только детские врачи, взрослая — только взрослые, семейная — все', () => {
    assert.equal(cover('demo-strakh-kids', 'demo-doc-fatkullin--demo-malysh-gorki').status, 'covered');
    assert.equal(cover('demo-strakh-kids', 'demo-doc-valieva--demo-derma-center').reason, 'age');
    assert.equal(cover('demo-strakh-kids', 'demo-doc-ahmetova--demo-derma-center').status, 'covered');
    assert.equal(cover('demo-strakh-optimum', 'demo-doc-ahmetova--demo-derma-center').reason, 'age');
    assert.equal(cover('demo-primer-family', 'demo-doc-fatkullin--demo-malysh-gorki').status, 'covered');
    assert.equal(cover('demo-primer-family', 'demo-doc-veresova--demo-zdorovie-center').status, 'covered');
  });

  it('срок действия и лимиты', () => {
    assert.equal(cover('demo-primer-2025', 'demo-doc-veresova--demo-zdorovie-center').reason, 'plan_expired');
    assert.equal(cover('demo-strakh-optimum', 'demo-doc-valieva--demo-derma-center').limitPerYear, 2);
    assert.equal(cover('demo-primer-family', 'demo-doc-veresova--demo-zdorovie-center', { today: '2026-02-01' }).reason, 'plan_expired', 'до начала действия');
  });

  it('карточка без филиала — «нет данных», а не «не входит»', () => {
    const result = coverageFor(demoInsurance, 'demo-strakh-optimum', { entityKind: 'doctor', specialtyKey: 'lor' }, { today: TODAY });
    assert.equal(result.status, 'unknown');
    assert.equal(coverageBadge(result, demoInsurance.plans[1]), null);
  });

  it('учреждение: частичное покрытие и подписи', () => {
    const plan = demoInsurance.plans.find((item) => item.id === 'demo-strakh-optimum');
    const derma = coverageFor(demoInsurance, plan.id, place(byId('demo-derma-center')), { today: TODAY });
    assert.equal(derma.partial, true);
    assert.match(coverageBadge(derma, plan).text, /часть специалистов/);
    const not = cover('demo-strakh-optimum', 'demo-doc-fatkullin--demo-malysh-gorki');
    assert.match(coverageBadge(not, plan).detail, /клиника не входит|детский приём/);
  });
});

describe('ДМС в запросе ассистенту', () => {
  it('«есть ДМС» ставит признак, «нет ДМС» — нет', () => {
    assert.equal(extractConstraints('у ребёнка болит ухо, есть ДМС').dmsOnly, true);
    assert.equal(extractConstraints('дерматолог по дмс').dmsOnly, true);
    assert.equal(extractConstraints('ДМС нет, нужен платный приём').dmsOnly, undefined);
  });

  it('планировщик и контракт пропускают только булево значение', () => {
    const plan = (value) => JSON.stringify({ action: 'FIND_DOCTOR', steps: [{ type: 'specialty', specialty: 'lor', selection: 'nearest' }], constraints: { dms_only: value }, reply_hint: 'doctors_found' });
    assert.equal(validatePlan(plan(true), { allowedTokens: [] }).ok, true);
    assert.equal(validatePlan(plan('yes'), { allowedTokens: [] }).ok, false);
    assert.equal(sanitizeAiAction({ dmsOnly: true }).dmsOnly, true);
    assert.equal(sanitizeAiAction({ dmsOnly: 'maybe' }).dmsOnly, false);
  });
});

describe('Демо-набор на сервере', () => {
  it('подключается только по DEMO_DATA=on', async () => {
    const previous = process.env.DEMO_DATA;
    try {
      delete process.env.DEMO_DATA;
      __resetCatalogCache();
      const plain = await loadCatalog();
      assert.ok(!plain.doctors.some((doctor) => doctor.id.startsWith('demo-')));

      process.env.DEMO_DATA = 'on';
      __resetCatalogCache();
      const demo = await loadCatalog();
      assert.ok(demo.doctors.some((doctor) => doctor.id === 'demo-doc-valieva--demo-derma-center'));
      assert.ok(demo.clinics.some((clinic) => clinic.id === 'demo-derma-center'));
    } finally {
      if (previous === undefined) delete process.env.DEMO_DATA;
      else process.env.DEMO_DATA = previous;
      __resetCatalogCache();
    }
  });
});
