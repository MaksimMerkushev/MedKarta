/*
 * © 2026 MedКарта Казань. Все права защищены.
 *
 * Запросы личного кабинета. Сессия — в cookie HttpOnly, которую страница
 * не видит; здесь только JSON туда и обратно.
 */

const request = async (path, { method = 'GET', body } = {}) => {
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
    throw error;
  }
  return payload;
};

export const fetchAccount = () => request('/api/account');
export const loginAccount = ({ email, password }) => request('/api/auth/login', { method: 'POST', body: { email, password } });
export const registerAccount = ({ email, password, displayName, consent }) =>
  request('/api/auth/register', { method: 'POST', body: { email, password, displayName, consent } });
export const loginDemoAccount = (account) => request('/api/auth/demo', { method: 'POST', body: { account } });
export const logoutAccount = () => request('/api/auth/logout', { method: 'POST', body: {} });
export const updateAccount = (patch) => request('/api/account', { method: 'PATCH', body: patch });
export const updateAccountFavorites = (action, ids) => request('/api/account/favorites', { method: 'POST', body: { action, ids } });
export const deleteAccount = () => request('/api/account', { method: 'DELETE', body: { confirm: true } });
