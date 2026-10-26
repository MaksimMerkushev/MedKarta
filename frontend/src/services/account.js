/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Запросы личного кабинета и профиля. Сессия — в cookie HttpOnly, которую
 * страница не видит; здесь только JSON туда и обратно. Изменяющие запросы —
 * всегда с телом JSON: сервер принимает только их (защита от CSRF).
 */

export const request = async (path, { method = 'GET', body } = {}) => {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const error = new Error('Нет связи с сервером. Проверьте интернет.');
    error.code = 'network';
    throw error;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(typeof payload?.error === 'string' ? payload.error : 'Не получилось. Попробуйте ещё раз.');
    error.status = response.status;
    error.code = payload?.code || null;
    error.payload = payload;
    throw error;
  }
  return payload;
};

export const fetchAccount = () => request('/api/account');
export const loginAccount = ({ email, password }) => request('/api/auth/login', { method: 'POST', body: { email, password } });
export const logoutAccount = () => request('/api/auth/logout', { method: 'POST', body: {} });
export const updateAccount = (patch) => request('/api/account', { method: 'PATCH', body: patch });
export const updateAccountFavorites = (action, ids) => request('/api/account/favorites', { method: 'POST', body: { action, ids } });
export const deleteAccount = () => request('/api/account', { method: 'DELETE', body: { confirm: true } });

/* Свой профиль (/profile): только свои данные, id берётся из сессии. */
export const fetchMe = () => request('/api/me');
export const updateMe = ({ firstName, lastName }) => request('/api/me', { method: 'PATCH', body: { firstName, lastName } });
export const changePassword = ({ currentPassword, newPassword }) => request('/api/me/password', { method: 'POST', body: { currentPassword, newPassword } });
export const fetchMySessions = () => request('/api/me/sessions');
export const revokeMySession = (id) => request(`/api/me/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
export const revokeOtherSessions = () => request('/api/me/sessions/revoke-others', { method: 'POST', body: {} });
export const fetchMyLogins = (limit = 20) => request(`/api/me/logins?limit=${limit}`);
export const uploadAvatar = (image) => request('/api/me/avatar', { method: 'PUT', body: { image } });
export const removeAvatar = () => request('/api/me/avatar', { method: 'DELETE', body: {} });
export const fetchPublicConfig = () => request('/api/config');

/*
 * Приглашения и ссылки для входа. Токен из ссылки уходит только в теле
 * POST — не в адресе запроса; контекст активации — в cookie HttpOnly.
 */
export const requestAccessLink = (email) => request('/api/auth/access-link', { method: 'POST', body: { email } });
export const peekActivation = (token) => request('/api/auth/activation/peek', { method: 'POST', body: { token } });
export const startActivation = (token) => request('/api/auth/activation/start', { method: 'POST', body: { token } });
export const fetchActivationContext = () => request('/api/auth/activation');
/**
 * Задать пароль по ссылке. factor — второй фактор ({method, code} или
 * {method: 'webauthn', credential}), если у аккаунта включена MFA: без него
 * сервер ответит 403 mfa_required и пароль не изменит.
 */
export const completeActivation = (password, factor = null) => request('/api/auth/activation/complete', { method: 'POST', body: { password, ...(factor || {}) } });
export const fetchActivationMfaOptions = () => request('/api/auth/activation/mfa-options', { method: 'POST', body: {} });

/* Второй шаг входа: способы, вызов для ключа доступа и проверка. */
export const fetchMfaLoginOptions = () => request('/api/auth/mfa/options', { method: 'POST', body: {} });
export const verifyMfaLogin = ({ method, code, credential }) => request('/api/auth/mfa/verify', { method: 'POST', body: { method, ...(code !== undefined ? { code } : {}), ...(credential !== undefined ? { credential } : {}) } });

/*
 * Регистрация: письмо на адрес → ссылка → «Продолжить» → пароль. Токен —
 * только в теле POST; контекст после «Продолжить» — в cookie HttpOnly.
 */
export const requestRegistration = (email) => request('/api/auth/register', { method: 'POST', body: { email } });
export const peekRegistration = (token) => request('/api/auth/register/peek', { method: 'POST', body: { token } });
export const startRegistration = (token) => request('/api/auth/register/start', { method: 'POST', body: { token } });
export const fetchRegistrationContext = () => request('/api/auth/register');
export const completeRegistration = ({ password, firstName = '' }) => request('/api/auth/register/complete', { method: 'POST', body: { password, ...(firstName ? { firstName } : {}) } });

/* Подтверждение нового email по ссылке из письма. */
export const peekEmailChange = (token) => request('/api/auth/email-change/peek', { method: 'POST', body: { token } });
export const confirmEmailChange = (token) => request('/api/auth/email-change/confirm', { method: 'POST', body: { token } });

/* Безопасность аккаунта (профиль). */
export const fetchSecurity = () => request('/api/me/security');
export const fetchReauthOptions = () => request('/api/me/reauth/options', { method: 'POST', body: {} });
export const reauthenticate = ({ password, method, code, credential }) => request('/api/me/reauth', {
  method: 'POST',
  body: { password, ...(method ? { method } : {}), ...(code !== undefined ? { code } : {}), ...(credential !== undefined ? { credential } : {}) },
});
export const startTotpSetup = () => request('/api/me/mfa/totp', { method: 'POST', body: {} });
export const confirmTotpSetup = ({ factorId, code, label }) => request('/api/me/mfa/totp/confirm', { method: 'POST', body: { factorId, code, ...(label ? { label } : {}) } });
export const startPasskeySetup = () => request('/api/me/mfa/passkey', { method: 'POST', body: {} });
export const finishPasskeySetup = ({ credential, label }) => request('/api/me/mfa/passkey/finish', { method: 'POST', body: { credential, ...(label ? { label } : {}) } });
export const renameFactor = (id, label) => request(`/api/me/mfa/factors/${encodeURIComponent(id)}`, { method: 'PATCH', body: { label } });
export const removeFactor = (id) => request(`/api/me/mfa/factors/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
export const regenerateRecoveryCodes = () => request('/api/me/mfa/recovery-codes', { method: 'POST', body: {} });
export const requestEmailChange = (newEmail) => request('/api/me/email', { method: 'POST', body: { newEmail } });
export const requestEmailVerification = () => request('/api/me/email/verify', { method: 'POST', body: {} });
export const revokeAllSessions = () => request('/api/me/sessions/revoke-all', { method: 'POST', body: {} });
