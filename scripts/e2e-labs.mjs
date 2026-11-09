#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка лабораторий на настоящем сервере и в настоящем браузере
 * (Chromium, компьютер 1440 px и телефон 375 px). Ключей модели нет: анализы
 * разбирают правила сервера, наружу ничего не уходит, деньги не тратятся.
 *   — раздел «Лаборатории»: корзина, условия, сравнение, запись, отмена, «Мои записи»;
 *   — страницы исследования (подготовка, пример бланка) и лаборатории (филиалы, часы);
 *   — телефон: без горизонтальной прокрутки, диалог записи помещается;
 *   — ассистент: «ОАК и ферритин завтра утром до 2000» → варианты → запись из чата;
 *     «добавь ТТГ» сохраняет корзину и условия; неотложное — 103/112 без подбора;
 *   — названия анализов не попадают в журнал сервера.
 *
 *   node scripts/e2e-labs.mjs [--shots каталог]
 */

/* global window, document -- код внутри page.evaluate выполняется в браузере */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer, createSteps, expect, requireBrowser, shotsDir } from './e2e-lib.mjs';

const chromium = await requireBrowser();
const SHOTS = shotsDir();
const PORT = Number(process.env.E2E_PORT) || 4240;
const BASE = `http://localhost:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-e2e-labs-'));

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  NODE_ENV: 'development',
  DEMO_DATA: 'on',
  ANALYTICS: 'off',
  COOKIE_SECURE: 'off',
  CHAT_REQUIRES_ACCOUNT: 'off',
  ACCOUNTS_DB_PATH: path.join(WORK, 'accounts.sqlite'),
  DEMO_BOOKING_DB_PATH: path.join(WORK, 'booking.sqlite'),
  LAB_DB_PATH: path.join(WORK, 'labs.sqlite'),
  ADMIN_BOOTSTRAP_PASSWORD: '',
  TRUST_PROXY: '1',
  TRUSTED_PROXIES: '',
  SMTP_URL: '',
  SMTP_HOST: '',
  OPENROUTER_API_KEY: '',
  AI_API_KEY: '',
  AI_UPSTREAM_URL: '',
  AI_PROXY_URL: '',
};

const server = createServer({ env, base: BASE });
const { step, summary } = createSteps();
const pageErrors = [];

const api = async (route, body) => {
  const response = await fetch(`${BASE}${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body) } : {});
  return { status: response.status, body: await response.json() };
};

const newPage = async (browser, viewport) => {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
  return page;
};

const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `labs-${name}.png`) });
};

let browser;
try {
  await server.start();
  browser = await chromium.launch();

  await step('1. API: каталог и подбор корзины «ОАК + ферритин + ТТГ» завтра утром до 2000 ₽', async () => {
    const catalog = await api('/api/labs/catalog');
    expect(catalog.status === 200 && catalog.body.tests.length >= 50 && catalog.body.branches.length >= 20, `каталог: ${catalog.status}`);
    const quote = await api('/api/labs/quote', { request: { tests: ['CBC_DIFF', 'FERRITIN', 'TSH'], date: { kind: 'tomorrow' }, timeOfDay: 'morning', maxTotalPrice: 2000 } });
    expect(quote.body.status === 'ok' && quote.body.options.every((option) => option.total <= 2000 && option.total === option.testsTotal + option.feesTotal), `подбор: ${JSON.stringify(quote.body).slice(0, 200)}`);
  });

  let page;
  await step('2. Раздел «Лаборатории»: корзина, условия и сравнение полной стоимости', async () => {
    page = await newPage(browser, { width: 1440, height: 900 });
    await page.goto(`${BASE}/labs`, { waitUntil: 'networkidle' });
    await page.fill('[data-testid=labs-search]', 'ферритин');
    await page.click('[data-testid=labs-add-FERRITIN]');
    await page.fill('[data-testid=labs-search]', '');
    await page.click('[data-testid=labs-add-CBC_DIFF]');
    await page.click('[data-testid=labs-add-TSH]');
    await page.selectOption('[data-testid=labs-filter-date]', 'tomorrow');
    await page.selectOption('[data-testid=labs-filter-time]', 'morning');
    await page.fill('[data-testid=labs-filter-price]', '2000');
    await page.waitForSelector('[data-testid=labs-results-summary]', { timeout: 15_000 });
    const totals = await page.$$eval('[data-testid=lab-option-total]', (nodes) => nodes.map((node) => Number(node.textContent.replace(/\D/g, ''))));
    expect(totals.length > 0 && totals.every((total) => total <= 2000), `итоги: ${totals}`);
    expect(totals.join() === [...totals].sort((a, b) => a - b).join(), 'варианты не по возрастанию цены');
    const scope = await page.textContent('[data-testid=labs-results-summary]');
    expect(/не по всему городу/u.test(scope), 'нет оговорки, что сравнение только среди демо');
    await shot(page, 'compare');
  });

  let number;
  await step('3. Запись из сравнения и отмена: место освобождается', async () => {
    await page.click('[data-testid=lab-option-slot] >> nth=0');
    await page.waitForSelector('[data-testid=lab-booking-dialog]');
    const total = await page.textContent('[data-testid=lab-booking-total]');
    await page.click('[data-testid=lab-booking-confirm]');
    await page.waitForSelector('[data-testid=lab-booking-result]');
    number = (await page.textContent('[data-testid=lab-booking-number]')).trim();
    expect(/^LAB-\d{6}-[A-Z0-9]{5}$/u.test(number), `номер: ${number}`);
    expect((await page.textContent('[data-testid=lab-booking-result]')).includes(total.replace(/\s/g, ' ').trim().split(' ')[0]), 'итог записи не совпал с показанным');
    await shot(page, 'booked');
    await page.click('[data-testid=lab-booking-cancel]');
    await page.waitForSelector('[data-testid=lab-booking-result] >> text=Запись отменена');
    await page.keyboard.press('Escape');
  });

  await step('4. «Мои записи»: новая запись видна и отменяется оттуда', async () => {
    await page.click('[data-testid=lab-option-book] >> nth=0');
    await page.waitForSelector('[data-testid=lab-slot]');
    await page.click('[data-testid=lab-slot]:not([disabled]) >> nth=0');
    await page.click('[data-testid=lab-booking-confirm]');
    await page.waitForSelector('[data-testid=lab-booking-result]');
    const second = (await page.textContent('[data-testid=lab-booking-number]')).trim();
    await page.keyboard.press('Escape');
    await page.click('[data-testid=labs-my-bookings]');
    await page.waitForSelector(`[data-testid=labs-my-booking] >> text=${second}`);
    await page.locator('[data-testid=labs-my-booking]', { hasText: second }).getByRole('button', { name: 'Отменить' }).click();
    await page.waitForFunction((value) => ![...document.querySelectorAll('[data-testid=labs-my-booking]')].some((node) => node.textContent.includes(value) && node.textContent.includes('активна')), second);
    await page.keyboard.press('Escape');
  });

  await step('5. Страницы исследования и лаборатории: подготовка, пример бланка, филиалы и часы', async () => {
    await page.goto(`${BASE}/labs/test/TSH`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid=labs-test-page] >> text=Подготовка');
    await page.waitForSelector('[data-testid=labs-demo-result] >> text=не подходят для медицинских решений');
    await page.goto(`${BASE}/labs/lab/lab-mediana`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid=labs-branch]');
    const text = await page.textContent('[data-testid=labs-lab-page]');
    expect(/Приём биоматериала:/u.test(text) && /Взятие крови из вены/u.test(text), 'нет часов приёма или процедур');
    await shot(page, 'lab');
    await page.close();
  });

  await step('6. Телефон 375 px: без горизонтальной прокрутки, диалог записи помещается', async () => {
    const phone = await newPage(browser, { width: 375, height: 812 });
    await phone.goto(`${BASE}/labs`, { waitUntil: 'networkidle' });
    await phone.click('[data-testid=labs-add-CBC_DIFF]');
    await phone.waitForSelector('[data-testid=lab-option]', { timeout: 15_000 });
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow <= 1, `горизонтальная прокрутка: ${overflow}px`);
    await phone.click('[data-testid=lab-option-book] >> nth=0');
    await phone.waitForSelector('[data-testid=lab-booking-dialog]');
    const box = await phone.locator('[data-testid=lab-booking-dialog]').boundingBox();
    expect(box && box.width <= 375 && box.x >= 0, `диалог: ${JSON.stringify(box)}`);
    await shot(phone, 'phone');
    await phone.close();
  });

  await step('7. Ассистент: корзина из фразы, варианты под ответом, запись из чата', async () => {
    const chat = await newPage(browser, { width: 1440, height: 900 });
    await chat.goto(BASE, { waitUntil: 'networkidle' });
    await chat.getByRole('button', { name: 'Открыть AI-ассистента' }).first().click();
    const input = chat.locator('input[placeholder="Опишите симптомы..."]:visible').first();
    await input.fill('Хочу сдать ОАК и ферритин завтра утром до 2000 рублей');
    await input.press('Enter');
    await chat.waitForSelector('[data-testid=lab-offers] [data-testid=lab-option]', { timeout: 20_000 });
    const totals = await chat.$$eval('[data-testid=lab-offers] [data-testid=lab-option-total]', (nodes) => nodes.map((node) => Number(node.textContent.replace(/\D/g, ''))));
    expect(totals.every((total) => total <= 2000), `итоги в чате: ${totals}`);
    await chat.click('[data-testid=lab-offers] [data-testid=lab-option-slot] >> nth=0');
    await chat.click('[data-testid=lab-booking-confirm]');
    await chat.waitForSelector('[data-testid=lab-booking-result]');
    await chat.keyboard.press('Escape');
    await input.fill('Добавь ещё ТТГ');
    await input.press('Enter');
    await chat.waitForFunction(() => document.querySelectorAll('[data-testid=lab-offers]').length >= 2, null, { timeout: 20_000 });
    const lastReply = await chat.evaluate(() => {
      const area = [...document.querySelectorAll('input[placeholder="Опишите симптомы..."]')].find((node) => node.getClientRects().length > 0);
      let node = area;
      while (node && !(node.innerText || '').includes('Добавь ещё ТТГ')) node = node.parentElement;
      return node ? node.innerText.split('Добавь ещё ТТГ').pop() : '';
    });
    expect(/Добавил в список: ТТГ/u.test(lastReply) && /до 2\s?000 ₽/u.test(lastReply), `ответ: ${lastReply.slice(0, 200)}`);
    await shot(chat, 'assistant');
    await chat.close();
  });

  await step('8. Неотложное состояние: 103/112 и никакого подбора лабораторий', async () => {
    const response = await api('/api/chat', { messages: [{ role: 'user', content: 'Хочу сдать анализы, но сейчас давит в груди и холодный пот' }], sessionId: 'e2e-labs-0000000001' });
    const action = response.body.action || response.body;
    expect(/\b(?:103|112)\b/u.test(action.replyText || ''), `ответ: ${action.replyText}`);
    expect(!action.labs, 'при неотложном состоянии показан подбор');
  });

  await step('9. Названия анализов не попали в журнал сервера; ошибок JavaScript нет', async () => {
    for (const word of ['ферритин', 'ТТГ', 'Хочу сдать']) expect(!server.state.output.includes(word), `в журнале есть «${word}»`);
    expect(pageErrors.length === 0, pageErrors.join('; '));
  });
} finally {
  await browser?.close();
  await server.stop();
  fs.rmSync(WORK, { recursive: true, force: true });
  summary();
}
