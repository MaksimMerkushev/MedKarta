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
export const loginDemoAccount = (account) => request('/api/auth/demo', { method: 'POST', body: { account } });
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
export const fetchMyLogins = () => request('/api/me/logins');
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
export const completeActivation = (password) => request('/api/auth/activation/complete', { method: 'POST', body: { password } });
