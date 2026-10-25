/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Названия способов второго фактора и тексты ошибок второго шага — для
 * SecondFactor.jsx (отдельный модуль: в файле компонента — только компоненты).
 */

export const METHOD_LABELS = {
  webauthn: 'Ключ доступа',
  totp: 'Приложение-аутентификатор',
  recovery: 'Резервный код',
};

/** Текст ошибки второго шага: что не так и сколько попыток осталось. */
export const secondFactorError = (error) => {
  switch (error?.code) {
    case 'bad_mfa_code': {
      const left = error.payload?.attemptsLeft;
      return `${error.message}${Number.isInteger(left) && left <= 3 ? ` Осталось попыток: ${left}.` : ''}`;
    }
    case 'too_many_attempts':
      return error.message || 'Слишком много неверных кодов. Подождите 15 минут.';
    case 'mfa_expired':
      return 'Время на подтверждение вышло. Войдите заново.';
    default:
      return error?.message || 'Не получилось проверить. Попробуйте ещё раз.';
  }
};
