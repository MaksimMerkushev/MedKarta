/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Общая обвязка HTTP-обработчиков: чтение тела, ответ, проверка Origin.
 * Вынесена из api/chat.js, когда появился второй эндпоинт, — чтобы правила
 * приёма запроса были в одном месте, а не расходились между обработчиками.
 */

import { LIMITS } from '../../shared/contract.js';

export const respondJson = (res, status, payload) => {
  res.statusCode = status;
  // Недочитанное тело: соединение закрывается после ответа, а не висит.
  if (status === 413) res.setHeader('Connection', 'close');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
};

/**
 * Читает тело с жёстким потолком размера.
 * Соединение рвётся сразу по превышении, а не после полной загрузки.
 */
export const readBody = (req, maxBytes = LIMITS.MAX_BODY_BYTES) =>
  new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      resolve(req.body);
      return;
    }

    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        /*
         * Раньше соединение рвалось сразу (req.destroy), и клиент получал
         * «Empty reply from server» вместо 413. Теперь остаток тела
         * отбрасывается, обработчик отвечает 413 с Connection: close.
         */
        tooLarge = true;
        chunks.length = 0;
        const error = new Error('Тело запроса слишком большое.');
        error.status = 413;
        reject(error);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) return;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const error = new Error('Некорректный JSON в теле запроса.');
        error.status = 400;
        reject(error);
      }
    });

    req.on('error', reject);
  });

/**
 * Запрос должен приходить с нашей же страницы. Заголовок Origin подделывается
 * только не-браузерным клиентом, поэтому это не «защита», а отсечение
 * тривиального встраивания виджета на чужой сайт за наш счёт.
 */
export const verifyOrigin = (req) => {
  /*
   * DNS rebinding: чужая страница, чей домен указал на наш адрес, шлёт
   * запросы с Host и Origin своего домена — они совпадают, и проверка ниже
   * их пропускала. ALLOWED_HOSTS (через запятую) закрывает это: API
   * отвечает только на свои имена хоста.
   */
  const allowedHosts = (process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length > 0 && !allowedHosts.includes(String(req.headers.host || '').toLowerCase())) {
    return false;
  }

  const origin = req.headers.origin;
  if (!origin) {
    // Same-origin fetch в части браузеров не шлёт Origin — пропускаем.
    return true;
  }

  const allowList = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (allowList.includes(origin)) {
    return true;
  }

  try {
    // X-Forwarded-Host пишет клиент; верить ему можно только за своим прокси.
    const behindProxy = Number.parseInt(process.env.TRUST_PROXY ?? '0', 10) > 0;
    const host = (behindProxy && req.headers['x-forwarded-host']) || req.headers.host;
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
};
