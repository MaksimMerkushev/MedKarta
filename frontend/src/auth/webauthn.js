/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Ключи доступа (passkeys, WebAuthn) в браузере: перевод параметров сервера
 * (строки base64url) в то, что ждёт navigator.credentials, и ответа — обратно
 * в JSON. Ключ привязан к сайту: на поддельной странице браузер его не
 * предложит — в этом главная защита от фишинга.
 */

const toBytes = (value) => {
  const base64 = String(value).replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const toBase64Url = (buffer) => {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

/** Браузер умеет ключи доступа (и страница открыта по HTTPS или на localhost). */
export const passkeysSupported = () => typeof window !== 'undefined'
  && Boolean(window.PublicKeyCredential)
  && typeof navigator?.credentials?.get === 'function'
  && window.isSecureContext !== false;

const credentialDescriptors = (list = []) => list.map((item) => ({ type: 'public-key', id: toBytes(item.id), ...(item.transports?.length ? { transports: item.transports } : {}) }));

/** Понятная причина отказа браузера — без технических подробностей. */
export const passkeyErrorMessage = (error) => {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'Подтверждение отменено или время вышло. Попробуйте ещё раз.';
    case 'InvalidStateError':
      return 'Этот ключ уже добавлен к аккаунту.';
    case 'SecurityError':
      return 'Ключ доступа работает только на сайте МедКарты по HTTPS.';
    case 'NotSupportedError':
      return 'Это устройство не поддерживает ключи доступа. Используйте приложение-аутентификатор.';
    case 'AbortError':
      return 'Подтверждение прервано.';
    default:
      return error?.message || 'Не получилось использовать ключ доступа.';
  }
};

/** Подтвердить вход ключом доступа: ответ — JSON для сервера. */
export const getPasskeyAssertion = async (options) => {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: toBytes(options.challenge),
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification || 'preferred',
      allowCredentials: credentialDescriptors(options.allowCredentials),
    },
  });
  if (!credential) throw Object.assign(new Error('Подтверждение отменено.'), { name: 'NotAllowedError' });
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
    },
  };
};

/** Создать новый ключ доступа: ответ — JSON для сервера. */
export const createPasskey = async (options) => {
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: toBytes(options.challenge),
      rp: options.rp,
      user: { id: toBytes(options.user.id), name: options.user.name, displayName: options.user.displayName },
      pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout,
      attestation: options.attestation || 'none',
      authenticatorSelection: options.authenticatorSelection,
      excludeCredentials: credentialDescriptors(options.excludeCredentials),
    },
  });
  if (!credential) throw Object.assign(new Error('Создание ключа отменено.'), { name: 'NotAllowedError' });
  const { response } = credential;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
  };
};
