/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Пропуск к ассистенту: ассистент доступен только вошедшим, но запрос к нему
 * не связан с аккаунтом.
 *
 * Запросы к ассистенту могут содержать сведения о здоровье («болит сердце»).
 * Если бы /api/chat проверял сессию, сервер получал бы такие сведения вместе
 * с тем, чей это аккаунт, — это обработка сведений о здоровье конкретного
 * человека (ст. 10 152-ФЗ), для которой нужно письменное согласие.
 * Поэтому проверка разделена на два запроса:
 *   1) POST /api/account/assistant-pass — с сессией: сервер выдаёт пропуск
 *      (cookie mk_ai, HttpOnly, только для /api/chat, на час). В пропуске
 *      нет id аккаунта: срок, случайное число и подпись HMAC. Выдача нигде
 *      не записывается;
 *   2) POST /api/chat — проверяется только подпись и срок пропуска, сессия
 *      не читается. Связать текст запроса с аккаунтом сервер не может.
 * Цена: заблокированный пользователь сохраняет доступ к ассистенту до часа
 * (пропуск не отзывается), выход из аккаунта стирает cookie пропуска.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ASSISTANT_PASS_COOKIE = 'mk_ai';
export const ASSISTANT_PASS_PATH = '/api/chat';
export const ASSISTANT_PASS_TTL_MS = 60 * 60 * 1000;

const b64 = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * @param {object} options
 * @param {Buffer} options.key ключ подписи (выводится из главного ключа сервера)
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 */
export const createAssistantPass = ({ key, ttlMs = ASSISTANT_PASS_TTL_MS, now = () => Date.now() }) => {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new Error('assistant pass key must be 32 bytes');
  const sign = (payload) => createHmac('sha256', key).update('medkarta:assistant-pass:v1').update(payload).digest();
  return Object.freeze({
    ttlMs,
    /** Новый пропуск: срок (8 байт) и случайное число (12 байт) — без данных о человеке. */
    issue() {
      const payload = Buffer.alloc(20);
      payload.writeBigUInt64BE(BigInt(now() + ttlMs), 0);
      randomBytes(12).copy(payload, 8);
      return `${b64(payload)}.${b64(sign(payload))}`;
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 120) return false;
      const [payloadPart, signaturePart, rest] = token.split('.');
      if (!payloadPart || !signaturePart || rest !== undefined) return false;
      let payload;
      let signature;
      try {
        payload = Buffer.from(payloadPart, 'base64url');
        signature = Buffer.from(signaturePart, 'base64url');
      } catch {
        return false;
      }
      if (payload.length !== 20 || signature.length !== 32) return false;
      if (!timingSafeEqual(signature, sign(payload))) return false;
      return Number(payload.readBigUInt64BE(0)) > now();
    },
  });
};
