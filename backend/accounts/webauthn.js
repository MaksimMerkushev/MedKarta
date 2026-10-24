/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Проверка ключей доступа (passkeys, WebAuthn Level 2) без внешних
 * библиотек: разбор CBOR и authenticatorData, ключ COSE → открытый ключ
 * node:crypto, проверка подписи.
 *
 * Что проверяется при регистрации (navigator.credentials.create):
 *   - clientDataJSON: type = webauthn.create, challenge — выданный сервером
 *     для этого пользователя, origin — из списка разрешённых (PUBLIC_BASE_URL),
 *     crossOrigin не true;
 *   - authenticatorData: SHA-256 от rpId, флаг присутствия пользователя (UP),
 *     наличие данных ключа (AT); алгоритм — ES256, EdDSA или RS256.
 *   Аттестация производителя не проверяется (запрашивается 'none'): нам
 *   важно, что ключ принадлежит этому человеку, а не модель устройства.
 *
 * При входе (navigator.credentials.get) — то же для webauthn.get, плюс
 * подпись над authenticatorData ‖ SHA-256(clientDataJSON) открытым ключом,
 * сохранённым при регистрации, и счётчик подписей (если устройство его
 * ведёт, он обязан расти: иначе — признак копии ключа).
 *
 * Ключ доступа привязан к домену (rpId): на фишинговом сайте браузер его
 * просто не предложит — в этом главное преимущество перед кодами.
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

export class WebAuthnError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WebAuthnError';
    this.code = code;
  }
}

const fail = (code) => {
  throw new WebAuthnError(code);
};

const sha256 = (data) => createHash('sha256').update(data).digest();

export const toBase64url = (buffer) => Buffer.from(buffer).toString('base64url');
export const fromBase64url = (text) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length > 8192) fail('bad_encoding');
  return Buffer.from(text, 'base64url');
};

/* --------------------------------- CBOR --------------------------------- */

const MAX_DEPTH = 8;

/**
 * Минимальный декодер CBOR (RFC 8949) для данных WebAuthn: целые, байты,
 * строки, массивы, словари, true/false/null. Возвращает значение и смещение
 * за ним. Неопределённая длина, теги и числа с плавающей точкой отвергаются.
 */
export const decodeCbor = (buffer, start = 0, depth = 0) => {
  if (depth > MAX_DEPTH) fail('cbor_depth');
  if (start >= buffer.length) fail('cbor_truncated');
  const initial = buffer[start];
  const major = initial >> 5;
  const info = initial & 31;
  let offset = start + 1;
  const need = (count) => {
    if (offset + count > buffer.length) fail('cbor_truncated');
  };
  let length;
  if (info < 24) length = info;
  else if (info === 24) {
    need(1);
    length = buffer[offset];
    offset += 1;
  } else if (info === 25) {
    need(2);
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (info === 26) {
    need(4);
    length = buffer.readUInt32BE(offset);
    offset += 4;
  } else if (info === 27) {
    need(8);
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) fail('cbor_too_large');
    length = Number(big);
    offset += 8;
  } else fail('cbor_unsupported');

  switch (major) {
    case 0: return { value: length, offset };
    case 1: return { value: -1 - length, offset };
    case 2:
      need(length);
      return { value: buffer.subarray(offset, offset + length), offset: offset + length };
    case 3:
      need(length);
      return { value: buffer.subarray(offset, offset + length).toString('utf8'), offset: offset + length };
    case 4: {
      if (length > 1024) fail('cbor_too_large');
      const items = [];
      for (let index = 0; index < length; index += 1) {
        const item = decodeCbor(buffer, offset, depth + 1);
        items.push(item.value);
        offset = item.offset;
      }
      return { value: items, offset };
    }
    case 5: {
      if (length > 256) fail('cbor_too_large');
      const map = new Map();
      for (let index = 0; index < length; index += 1) {
        const key = decodeCbor(buffer, offset, depth + 1);
        const value = decodeCbor(buffer, key.offset, depth + 1);
        map.set(key.value, value.value);
        offset = value.offset;
      }
      return { value: map, offset };
    }
    case 7:
      if (info === 20) return { value: false, offset };
      if (info === 21) return { value: true, offset };
      if (info === 22) return { value: null, offset };
      return fail('cbor_unsupported');
    default:
      return fail('cbor_unsupported');
  }
};

/* --------------------------- authenticatorData --------------------------- */

export const FLAGS = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 });

export const parseAuthData = (data) => {
  if (!Buffer.isBuffer(data) || data.length < 37) fail('bad_auth_data');
  const flags = data[32];
  const result = {
    rpIdHash: data.subarray(0, 32),
    flags,
    userPresent: Boolean(flags & FLAGS.UP),
    userVerified: Boolean(flags & FLAGS.UV),
    backupEligible: Boolean(flags & FLAGS.BE),
    backedUp: Boolean(flags & FLAGS.BS),
    signCount: data.readUInt32BE(33),
    credential: null,
  };
  if (flags & FLAGS.AT) {
    if (data.length < 55) fail('bad_auth_data');
    const aaguid = data.subarray(37, 53);
    const idLength = data.readUInt16BE(53);
    if (idLength < 16 || idLength > 1023 || data.length < 55 + idLength) fail('bad_credential_id');
    const credentialId = data.subarray(55, 55 + idLength);
    const key = decodeCbor(data, 55 + idLength);
    if (!(key.value instanceof Map)) fail('bad_public_key');
    result.credential = { aaguid, credentialId, publicKey: key.value };
  }
  return result;
};

/* -------------------------------- ключи --------------------------------- */

export const ALGORITHMS = Object.freeze({ ES256: -7, EdDSA: -8, RS256: -257 });
const ALLOWED_ALGORITHMS = new Set(Object.values(ALGORITHMS));

/** Ключ COSE → {key: KeyObject, algorithm}. Только ES256 (P-256), EdDSA (Ed25519), RS256. */
export const coseToKey = (cose) => {
  const kty = cose.get(1);
  const algorithm = cose.get(3);
  if (!ALLOWED_ALGORITHMS.has(algorithm)) fail('unsupported_algorithm');
  let jwk;
  if (kty === 2 && algorithm === ALGORITHMS.ES256) {
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (cose.get(-1) !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) fail('bad_public_key');
    jwk = { kty: 'EC', crv: 'P-256', x: toBase64url(x), y: toBase64url(y) };
  } else if (kty === 1 && algorithm === ALGORITHMS.EdDSA) {
    const x = cose.get(-2);
    if (cose.get(-1) !== 6 || !Buffer.isBuffer(x) || x.length !== 32) fail('bad_public_key');
    jwk = { kty: 'OKP', crv: 'Ed25519', x: toBase64url(x) };
  } else if (kty === 3 && algorithm === ALGORITHMS.RS256) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) fail('bad_public_key');
    jwk = { kty: 'RSA', n: toBase64url(n), e: toBase64url(e) };
  } else {
    fail('unsupported_algorithm');
  }
  try {
    return { key: createPublicKey({ key: jwk, format: 'jwk' }), algorithm };
  } catch {
    return fail('bad_public_key');
  }
};

const verifyWith = (algorithm, spkiBase64url, data, signature) => {
  const key = createPublicKey({ key: Buffer.from(spkiBase64url, 'base64url'), format: 'der', type: 'spki' });
  try {
    if (algorithm === ALGORITHMS.EdDSA) return verifySignature(null, data, key, signature);
    if (algorithm === ALGORITHMS.ES256) return verifySignature('sha256', data, { key, dsaEncoding: 'der' }, signature);
    if (algorithm === ALGORITHMS.RS256) return verifySignature('sha256', data, key, signature);
  } catch {
    return false;
  }
  return false;
};

/* ---------------------------- clientDataJSON ---------------------------- */

const checkClientData = (raw, { type, challenge, origins }) => {
  if (raw.length > 4096) fail('bad_client_data');
  let client;
  try {
    client = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('bad_client_data');
  }
  if (!client || client.type !== type) fail('bad_type');
  if (typeof client.challenge !== 'string' || client.challenge !== challenge) fail('bad_challenge');
  if (!origins.includes(client.origin)) fail('bad_origin');
  if (client.crossOrigin === true) fail('cross_origin');
  return client;
};

/**
 * Проверка ответа navigator.credentials.create().
 *
 * @param {object} response {id, rawId, type, response: {clientDataJSON, attestationObject, transports?}} — base64url
 * @param {{challenge: string, rpId: string, origins: string[]}} expected
 * @returns {{credentialId: string, publicKey: string, algorithm: number, signCount: number, transports: string[], backedUp: boolean, userVerified: boolean}}
 */
export const verifyRegistration = (response, { challenge, rpId, origins }) => {
  if (!response || response.type !== 'public-key' || !response.response) fail('bad_response');
  const clientDataJSON = fromBase64url(response.response.clientDataJSON);
  checkClientData(clientDataJSON, { type: 'webauthn.create', challenge, origins });
  const attestation = decodeCbor(fromBase64url(response.response.attestationObject)).value;
  if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get('authData'))) fail('bad_attestation');
  const auth = parseAuthData(attestation.get('authData'));
  if (!auth.rpIdHash.equals(sha256(rpId))) fail('bad_rp_id');
  if (!auth.userPresent) fail('user_not_present');
  if (!auth.credential) fail('no_credential');
  const credentialId = toBase64url(auth.credential.credentialId);
  if (response.id !== credentialId || (response.rawId && response.rawId !== credentialId)) fail('bad_credential_id');
  const { key, algorithm } = coseToKey(auth.credential.publicKey);
  const transports = Array.isArray(response.response.transports)
    ? response.response.transports.filter((item) => ['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'].includes(item)).slice(0, 6)
    : [];
  return {
    credentialId,
    publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64url'),
    algorithm,
    signCount: auth.signCount,
    transports,
    backedUp: auth.backedUp,
    userVerified: auth.userVerified,
  };
};

/**
 * Проверка ответа navigator.credentials.get() для известного ключа.
 *
 * @param {object} response {id, rawId, type, response: {clientDataJSON, authenticatorData, signature, userHandle?}}
 * @param {{challenge: string, rpId: string, origins: string[], publicKey: string, algorithm: number, signCount: number}} expected
 * @returns {{signCount: number, userVerified: boolean, backedUp: boolean}}
 */
export const verifyAssertion = (response, { challenge, rpId, origins, publicKey, algorithm, signCount = 0 }) => {
  if (!response || response.type !== 'public-key' || !response.response) fail('bad_response');
  const clientDataJSON = fromBase64url(response.response.clientDataJSON);
  checkClientData(clientDataJSON, { type: 'webauthn.get', challenge, origins });
  const authData = fromBase64url(response.response.authenticatorData);
  const auth = parseAuthData(authData);
  if (!auth.rpIdHash.equals(sha256(rpId))) fail('bad_rp_id');
  if (!auth.userPresent) fail('user_not_present');
  const signature = fromBase64url(response.response.signature);
  const signed = Buffer.concat([authData, sha256(clientDataJSON)]);
  if (!verifyWith(algorithm, publicKey, signed, signature)) fail('bad_signature');
  // Счётчик ведут не все устройства (синхронизируемые passkeys отдают 0); если ведёт — он обязан расти.
  if ((auth.signCount !== 0 || signCount !== 0) && auth.signCount <= signCount) fail('counter_replay');
  return { signCount: auth.signCount, userVerified: auth.userVerified, backedUp: auth.backedUp };
};
