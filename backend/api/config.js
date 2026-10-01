/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Публичная конфигурация для интерфейса: только то, что можно показать
 * любому посетителю. Сейчас это один флаг — включён ли демо-набор на сервере,
 * чтобы интерфейс и ассистент работали с одними и теми же данными.
 */

import { respondJson } from '../http/request.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    respondJson(res, 405, { error: 'Метод не поддерживается.' });
    return;
  }
  respondJson(res, 200, { demo: process.env.DEMO_DATA === 'on' });
}
