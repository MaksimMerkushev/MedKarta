#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка записи через МИС на симуляторе (вымышленный API, данные
 * синтетические): пользователь → ассистент → врач клиники, подключённой через
 * МИС → её расписание из МИС → удержание → подтверждение → запись в МИС →
 * результат. Проверяются запросы к симулятору и состояние журнала интеграций.
 * Это MOCK VERIFIED: с настоящей МИС ничего не проверяется.
 */
/* global document -- код внутри page.evaluate выполняется в браузере */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer, createSteps, expect, requireBrowser, shotsDir } from './e2e-lib.mjs';
import { loadSqlite } from '../backend/demo/bookingStore.js';
import { createMisLedger } from '../backend/booking/mis/ledger.js';
import { createMisSimulator } from '../backend/booking/mis/simulator/server.js';
import { seedSimulatorIntegration, simulatorDataForClinic } from '../backend/booking/mis/simulator/demoClinic.js';
import { demoCatalog } from '../data/demo/generated.js';

const chromium = await requireBrowser();
const SHOTS = shotsDir();
const PORT = Number(process.env.E2E_PORT) || 4250;
const BASE = `http://localhost:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-e2e-mis-'));
const TOKEN = `sim-${randomBytes(12).toString('hex')}`;
const CLINIC = 'demo-travma';

// Симулятор — в этом процессе: тест видит его состояние и управляет сбоями.
const { simulator, mappings, clinic } = simulatorDataForClinic(demoCatalog, CLINIC, { days: 7 });
const sim = createMisSimulator({ ...simulator, token: TOKEN });
const SIM_URL = await sim.listen(0);
const DatabaseSync = await loadSqlite();
const LEDGER_FILE = path.join(WORK, 'integrations.sqlite');
{
  const ledger = createMisLedger({ DatabaseSync, file: LEDGER_FILE });
  seedSimulatorIntegration(ledger, { clinicId: CLINIC, baseUrl: SIM_URL, mappings });
  ledger.close();
}
const readLedger = (fn) => {
  const ledger = createMisLedger({ DatabaseSync, file: LEDGER_FILE });
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
};

const env = {
  ...process.env,
  PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development',
  DEMO_DATA: 'on', DEMO_ONLY: 'on', ANALYTICS: 'off', COOKIE_SECURE: 'off', CHAT_REQUIRES_ACCOUNT: 'off',
  ACCOUNTS_DB_PATH: path.join(WORK, 'accounts.sqlite'), DEMO_BOOKING_DB_PATH: path.join(WORK, 'booking.sqlite'), LAB_DB_PATH: path.join(WORK, 'labs.sqlite'),
  INTEGRATIONS_DB_PATH: LEDGER_FILE, MIS_INTEGRATIONS: 'on', MIS_SIMULATOR: 'on', MIS_SIM_DEMO: TOKEN, MIS_SIM_DEMO_WEBHOOK: 'e2e-webhook-secret',
  ADMIN_BOOTSTRAP_PASSWORD: '', TRUST_PROXY: '1', TRUSTED_PROXIES: '', SMTP_URL: '', SMTP_HOST: '',
  OPENROUTER_API_KEY: '', AI_API_KEY: '', AI_UPSTREAM_URL: '', AI_PROXY_URL: '',
};
const server = createServer({ env, base: BASE });
const { step, summary } = createSteps();
const pageErrors = [];
const api = async (route, body, headers = {}) => {
  const response = await fetch(`${BASE}${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE, ...headers }, body: JSON.stringify(body) } : { headers });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const appointments = () => [...sim.state.appointments.values()];
/* Ожидание с текстом страницы при неудаче: видно, на чём остановился сценарий. */
const waitFor = async (page, selector, timeout) => {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch (error) {
    const text = await page.evaluate(() => (document.querySelector('[data-testid=booking-dialog]') || document.body).innerText.replace(/\s+/g, ' ').slice(0, 900)).catch(() => '');
    throw new Error(`${error.message.split('\n')[0]} [${selector}] — на странице: ${text}`);
  }
};
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `mis-${name}.png`) });
};

let browser;
try {
  await server.start();
  browser = await chromium.launch();

  await step(`1. Ассистент → подбор: травматолог клиники «${clinic.name}» со временем из МИС`, async () => {
    const chat = await api('/api/chat', { messages: [{ role: 'user', content: 'Нужен травматолог' }], sessionId: 'e2e-mis-000000000001' });
    const request = (chat.body.action || chat.body).booking?.request;
    expect(request?.specialty === 'traumatologist', `запрос: ${JSON.stringify(request)}`);
    const found = await api('/api/booking/search', { request });
    const options = found.body.options || [];
    expect(options.length > 0 && options.every((option) => option.clinic.id === CLINIC), `варианты: ${options.map((option) => option.clinic?.id).join(', ')}`);
    expect(options.every((option) => String(option.nextSlot?.id || '').startsWith('mis.sim-demo.')), 'слоты не из МИС');
    expect(sim.state.requests.some((item) => item.route === 'GET /v1/slots'), 'в симулятор не было запроса слотов');
  });

  let number;
  await step('2. Браузер: выбор врача → время из МИС → удержание → подтверждение → «Запись подтверждена»', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Открыть AI-ассистента' }).first().click();
    const input = page.locator('input[placeholder="Опишите симптомы..."]:visible').first();
    await input.fill('Нужен травматолог');
    await input.press('Enter');
    await waitFor(page, '[data-testid=demo-offers] [data-testid=demo-offer]', 20_000);
    const before = appointments().length;
    await page.locator('[data-testid=demo-offer]', { hasText: 'Опора' }).first().locator('[data-testid=demo-offer-book]').click();
    // Время из варианта уже выбрано: окно сразу удерживает его и показывает подтверждение.
    await waitFor(page, '[data-testid=booking-confirm-button]', 20_000);
    expect(sim.state.holds.size === 1, `удержаний в МИС: ${sim.state.holds.size}`);
    const disclaimer = await page.textContent('[data-testid=booking-disclaimer]');
    expect(/уйдёт в МИС клиники/u.test(disclaimer) && !/ничего не отправляется/u.test(disclaimer), `оговорка: ${disclaimer}`);
    await page.click('[data-testid=booking-confirm-button]');
    await page.waitForSelector('[data-testid=booking-done]', { timeout: 15_000 });
    const status = await page.textContent('[data-testid=booking-status]');
    number = (await page.textContent('[data-testid=booking-number]')).trim();
    expect(/^MK-\d{6}-[A-Z0-9]{5}$/.test(number), `номер: ${number}`);
    expect(/Запись подтверждена/u.test(status), `статус: ${status}`);
    expect(appointments().length === before + 1, 'в МИС не появилась запись');
    const op = readLedger((ledger) => ledger.opByNumber(number));
    expect(op?.state === 'confirmed' && op.externalBookingId, `журнал: ${JSON.stringify(op)}`);
    expect(sim.state.appointments.get(op.externalBookingId).status === 'confirmed', 'в МИС запись не подтверждена');
    await shot(page, 'confirmed');
    await page.close();
  });

  await step('3. Слот заняли в клинике после удержания — «время занято», второй записи нет', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Открыть AI-ассистента' }).first().click();
    const input = page.locator('input[placeholder="Опишите симптомы..."]:visible').first();
    await input.fill('Нужен травматолог');
    await input.press('Enter');
    await waitFor(page, '[data-testid=demo-offers] [data-testid=demo-offer]', 20_000);
    await page.locator('[data-testid=demo-offer]', { hasText: 'Опора' }).first().locator('[data-testid=demo-offer-book]').click();
    // Время из варианта уже выбрано: окно сразу удерживает его и показывает подтверждение.
    await waitFor(page, '[data-testid=booking-confirm-button]', 20_000);
    const [held] = [...sim.state.holds.values()];
    sim.takeSlotByOther(held.slotId);
    const before = appointments().length;
    await page.click('[data-testid=booking-confirm-button]');
    await page.waitForSelector('[data-testid=booking-notice]', { timeout: 15_000 });
    const notice = await page.textContent('[data-testid=booking-notice]');
    expect(/занято/u.test(notice), `сообщение: ${notice}`);
    expect(!/МИС|409|slot_taken/iu.test(notice), `технические подробности: ${notice}`);
    expect(appointments().length === before, 'запись создана, хотя слот занят');
    await page.close();
  });

  await step('4. Ответ МИС потерян — сверка находит запись, второй нет (API)', async () => {
    const found = await api('/api/booking/search', { request: { specialty: 'traumatologist' } });
    const slot = found.body.options[0].nextSlot;
    const held = await api('/api/booking/hold', { slotId: slot.id });
    expect(held.status === 200, `удержание: ${held.status} ${JSON.stringify(held.body)}`);
    sim.fail('book', 'lost_response');
    const idempotencyKey = randomBytes(12).toString('base64url');
    const booked = await api('/api/booking/bookings', { slotId: slot.id, holdToken: held.body.holdToken, idempotencyKey });
    expect([200, 201].includes(booked.status) && booked.body.booking.status === 'CONFIRMED', `запись: ${booked.status} ${JSON.stringify(booked.body).slice(0, 200)}`);
    const op = readLedger((ledger) => ledger.opByNumber(booked.body.booking.number));
    expect(appointments().filter((item) => item.requestId === op.id).length === 1, 'в МИС не одна запись');
    const history = readLedger((ledger) => ledger.eventsOf(op.id).map((item) => item.to));
    expect(history.join('>') === 'booking_pending>pending_reconciliation>confirmed', `история: ${history.join('>')}`);
    const again = await api('/api/booking/bookings', { slotId: slot.id, holdToken: held.body.holdToken, idempotencyKey });
    expect(again.status === 200 && again.body.booking.number === booked.body.booking.number, 'повтор создал вторую запись');
  });

  await step('5. Отмена через МедКарту освобождает слот в МИС', async () => {
    const op = readLedger((ledger) => ledger.opByNumber(number));
    const token = readLedger((ledger) => ledger.cancelTokenFor(op.id));
    const cancelled = await api('/api/booking/bookings/cancel', { number, cancelToken: token });
    expect(cancelled.status === 200 && cancelled.body.booking?.status === 'CANCELLED' || cancelled.body.status === 'CANCELLED' || cancelled.body.state === 'cancelled', `отмена: ${JSON.stringify(cancelled.body).slice(0, 200)}`);
    expect(sim.state.appointments.get(op.externalBookingId).status === 'cancelled', 'в МИС запись не отменена');
  });

  await step('6. Webhook: без подписи — 401; с подписью — применяется; повтор — не применяется', async () => {
    const signed = sim.signWebhook('e2e-webhook-secret', { type: 'schedule.changed' });
    const post = (headers) => fetch(`${BASE}/api/integrations/sim-demo/webhook`, { method: 'POST', headers, body: signed.raw });
    expect((await post({ 'Content-Type': 'application/json' })).status === 401, 'без подписи принят');
    const first = await post(signed.headers);
    expect(first.status === 200, `с подписью: ${first.status}`);
    const second = await (await post(signed.headers)).json();
    expect(second.duplicate === true, 'повтор применён');
  });

  await step('7. Админ-API интеграций закрыт для гостя; секреты и данные пациента — не в журнале сервера', async () => {
    const list = await api('/api/admin/integrations');
    expect([401, 403].includes(list.status), `гость получил ${list.status}`);
    expect(!server.state.output.includes(TOKEN), 'токен МИС в журнале сервера');
    expect(!server.state.output.includes('opaque') && !/patient/i.test(server.state.output), 'данные пациента в журнале сервера');
    expect(pageErrors.length === 0, pageErrors.join('; '));
  });
} finally {
  await browser?.close();
  await server.stop();
  await sim.close();
  fs.rmSync(WORK, { recursive: true, force: true });
  summary();
}
