#!/usr/bin/env node
/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Сквозная проверка ассистента на настоящем сервере и в настоящем браузере (Chromium,
 * телефон 375 px и компьютер 1440 px). Ключей модели нет: ответы строят правила сервера,
 * наружу ничего не уходит, деньги не тратятся. Качество настоящей модели здесь не
 * проверяется — для этого scripts/ai-diagnose.mjs --mode real.
 *   — «С утра тошнит, болит живот»: нет условия «до 12:00» (ошибка №30);
 *   — «работаю учителем в Авиастроительном районе»: район работы не становится фильтром (№2);
 *   — «кардиолог завтра после 18 до 3000… хотя нет, болит колено»: врач другой, день, время
 *     и цена сохранились (№23);
 *   — неотложное состояние: совет звонить 103/112 и нет подбора;
 *   — текст жалобы не попадает в журналы сервера.
 *
 *   node scripts/e2e-assistant.mjs [--shots каталог]
 */

/* global document -- код внутри page.evaluate выполняется в браузере */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer, createSteps, expect, requireBrowser, shotsDir } from './e2e-lib.mjs';

const chromium = await requireBrowser();
const SHOTS = shotsDir();
const PORT = Number(process.env.E2E_PORT) || 4230;
const BASE = `http://localhost:${PORT}`;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'medkarta-e2e-assistant-'));

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
  ADMIN_BOOTSTRAP_PASSWORD: '',
  TRUST_PROXY: '1',
  TRUSTED_PROXIES: '',
  SMTP_URL: '',
  SMTP_HOST: '',
  // Без модели: ни одного внешнего вызова.
  OPENROUTER_API_KEY: '',
  AI_API_KEY: '',
  AI_UPSTREAM_URL: '',
  AI_PROXY_URL: '',
};

const server = createServer({ env, base: BASE });
const { step, summary } = createSteps();

const chat = async (turns) => {
  const response = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ messages: turns.map((content) => ({ role: 'user', content })), sessionId: 'e2e-assistant-000001' }),
  });
  const body = await response.json();
  expect(response.ok, `ответ ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.action || body;
};

const MORNING_LIMIT = /до\s*12:00|до 12|утром/u;

try {
  await server.start();

  await step('1. «С утра тошнит, болит живот» — без условия «до 12:00»', async () => {
    const action = await chat(['С утра тошнит, болит живот']);
    const request = action.booking?.request;
    expect(!/\b(?:103|112)\b/.test(action.replyText || ''), `ложная тревога: ${action.replyText}`);
    if (request) {
      expect(!request.timeTo && !request.timeFrom, `лишнее время: ${JSON.stringify(request)}`);
      expect(!MORNING_LIMIT.test(JSON.stringify(request.labels || request.chips || '')), 'утро попало в условия');
    }
  });

  await step('2. Район работы не становится местом поиска', async () => {
    const action = await chat(['Я работаю учителем в Авиастроительном районе. У сына болит живот']);
    const request = action.booking?.request;
    expect(request, `нет подбора: ${action.replyText}`);
    expect((request.districts || []).length === 0, `район стал фильтром: ${JSON.stringify(request.districts)}`);
    expect(request.patient === 'child', `приём не детский: ${request.patient}`);
  });

  await step('3. Смена врача внутри реплики сохраняет день, время и цену', async () => {
    const action = await chat(['Нужен кардиолог завтра после 18:00 до 3000 рублей. Хотя нет, болит колено, наверное, нужен другой врач']);
    const request = action.booking?.request;
    expect(request, `нет подбора: ${action.replyText}`);
    expect(request.specialty !== 'cardiologist', `врач остался прежним: ${request.specialty}`);
    expect(request.date?.kind === 'tomorrow', `день потерян: ${JSON.stringify(request.date)}`);
    expect(request.timeFrom === '18:00', `время потеряно: ${request.timeFrom}`);
    expect(request.maxPrice === 3000, `цена потеряна: ${request.maxPrice}`);
  });

  await step('4. Неотложное состояние: 103/112 и нет подбора', async () => {
    const action = await chat(['кардиолог', 'давит в груди и холодный пот']);
    expect(/\b(?:103|112)\b/.test(action.replyText || ''), `нет совета позвонить: ${action.replyText}`);
    expect(!action.booking?.request, 'начат подбор');
  });

  for (const [label, viewport] of [['телефон 375 px', { width: 375, height: 812 }], ['компьютер 1440 px', { width: 1440, height: 900 }]]) {
    await step(`5. Браузер, ${label}: гость пишет ассистенту, «до 12:00» не появляется`, async () => {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport });
        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page.getByRole('button', { name: 'Открыть AI-ассистента' }).first().click();
        // На компьютере и телефоне окно ассистента разное: берём видимое.
        const input = page.locator('input[placeholder="Опишите симптомы..."]:visible').first();
        await input.waitFor({ state: 'visible', timeout: 15_000 });
        await input.fill('С утра тошнит, болит живот');
        await input.press('Enter');
        // Окно ассистента — ближайший предок видимого поля ввода, где уже есть реплика человека.
        const readChat = () => {
          const field = [...document.querySelectorAll('input[placeholder="Опишите симптомы..."]')].find((node) => node.getClientRects().length > 0);
          let node = field;
          while (node && !(node.innerText || '').includes('С утра тошнит, болит живот')) node = node.parentElement;
          const text = node ? node.innerText : '';
          return { text, ready: !document.querySelector('[data-testid="ai-typing"]') && text.split('С утра тошнит, болит живот')[1]?.trim().length > 40 };
        };
        for (let attempt = 0; attempt < 40 && !(await page.evaluate(readChat)).ready; attempt += 1) await page.waitForTimeout(500);
        const { text, ready } = await page.evaluate(readChat);
        expect(ready, `ответ не появился: ${text.slice(-200)}`);
        expect(!/до\s*12:00/u.test(text), `в ответе условие до 12:00: ${text.slice(-300)}`);
        expect(!/\b(?:103|112)\b/.test(text.split('С утра тошнит, болит живот')[1] || ''), 'ложная тревога в браузере');
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `assistant-${viewport.width}.png`) });
      } finally {
        await browser.close();
      }
    });
  }

  await step('6. Текст жалоб не попал в журналы сервера', async () => {
    for (const phrase of ['тошнит', 'Авиастроительн', 'колено', 'холодный пот']) {
      expect(!server.state.output.includes(phrase), `в журнале есть «${phrase}»`);
    }
  });
} finally {
  await server.stop();
  fs.rmSync(WORK, { recursive: true, force: true });
  summary();
}
