/*
 * © 2026 МедКарта Казань. Все права защищены.
 *
 * Настройки, которые можно менять из админ-панели без перезапуска. Только
 * перечисленные здесь ключи и только проверенные значения: переменные
 * окружения, ключи API и секреты отсюда недоступны и не редактируются.
 *
 * public: true — значение отдаётся всем в /api/config (название, контакты,
 * сообщение о работах, флаги интерфейса).
 */

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/iu;
const PHONE = /^\+?[0-9 ()-]{5,24}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

const text = (max, { min = 0, pattern = null, patternMessage = '' } = {}) => (value) => {
  if (typeof value !== 'string') return { error: 'Ожидается строка.' };
  const clean = value.replace(CONTROL, '').trim();
  if (clean.length < min) return { error: min > 0 && clean.length === 0 ? 'Значение не может быть пустым.' : `Не короче ${min} символов.` };
  if (clean.length > max) return { error: `Не длиннее ${max} символов.` };
  if (clean && pattern && !pattern.test(clean)) return { error: patternMessage };
  return { value: clean };
};

const integer = (min, max) => (value) => {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(number)) return { error: 'Ожидается целое число.' };
  if (number < min || number > max) return { error: `Допустимо от ${min} до ${max}.` };
  return { value: number };
};

const boolean = (value) => (typeof value === 'boolean' ? { value } : { error: 'Ожидается «да» или «нет».' });

export const SETTINGS = Object.freeze([
  { key: 'app.name', group: 'Общее', label: 'Название приложения', type: 'text', default: 'МедКарта', public: true, validate: text(40, { min: 2 }) },
  { key: 'support.email', group: 'Общее', label: 'Email поддержки', type: 'text', default: '', public: true, validate: text(254, { pattern: EMAIL, patternMessage: 'Проверьте email.' }) },
  { key: 'support.phone', group: 'Общее', label: 'Телефон поддержки', type: 'text', default: '', public: true, validate: text(24, { pattern: PHONE, patternMessage: 'Только цифры, пробелы, +, -, скобки.' }) },
  { key: 'maintenance.enabled', group: 'Технические работы', label: 'Показывать сообщение о работах', type: 'boolean', default: false, public: true, validate: boolean },
  { key: 'maintenance.message', group: 'Технические работы', label: 'Текст сообщения', type: 'textarea', default: 'Идут технические работы — часть функций может быть недоступна.', public: true, validate: text(280) },
  { key: 'assistant.enabled', group: 'Функции', label: 'ИИ-ассистент включён', type: 'boolean', default: true, public: true, validate: boolean, description: 'Выключение сразу закрывает /api/chat для всех.' },
  { key: 'assistant.requiresAccount', group: 'Функции', label: 'Ассистент только после входа', type: 'boolean', default: null, public: true, validate: boolean, description: 'По умолчанию — как в CHAT_REQUIRES_ACCOUNT (включено).' },
  { key: 'features.demoLogin', group: 'Экспериментальные функции', label: 'Кнопки демо-аккаунтов', type: 'boolean', default: true, public: false, validate: boolean, description: 'Работает только при DEMO_DATA=on на сервере.' },
  { key: 'sessions.idleDays', group: 'Сессии и вход', label: 'Сессия без активности, дней', type: 'number', default: 14, validate: integer(1, 60), description: 'Каждый запрос продлевает сессию на этот срок.' },
  { key: 'sessions.maxDays', group: 'Сессии и вход', label: 'Предельный срок сессии, дней', type: 'number', default: 30, validate: integer(1, 90), description: 'После него нужен новый вход, даже при активности.' },
  { key: 'sessions.maxPerUser', group: 'Сессии и вход', label: 'Сессий на пользователя', type: 'number', default: 10, validate: integer(1, 50), description: 'Самая старая вытесняется новым входом.' },
  { key: 'auth.maxFailedPerEmail', group: 'Сессии и вход', label: 'Неудачных входов на email за 15 минут', type: 'number', default: 10, validate: integer(3, 50) },
  { key: 'retention.authEventsDays', group: 'Хранение журналов', label: 'История входов, дней', type: 'number', default: 90, validate: integer(30, 365) },
  { key: 'retention.auditDays', group: 'Хранение журналов', label: 'Журнал действий, дней', type: 'number', default: 365, validate: integer(90, 1825) },
].map((item) => Object.freeze({ public: false, description: '', ...item })));

const BY_KEY = new Map(SETTINGS.map((item) => [item.key, item]));

export const settingDefinition = (key) => BY_KEY.get(key) || null;

/**
 * @param {object} deps
 * @param {object} deps.store хранилище с listSettings/putSettings
 * @param {object} [deps.env] для значений по умолчанию из окружения
 */
export const createSettingsService = ({ store, env = process.env, now = () => Date.now() }) => {
  const envDefaults = {
    'assistant.requiresAccount': env.CHAT_REQUIRES_ACCOUNT !== 'off',
  };
  let cache = null;
  const load = () => {
    if (!cache) {
      cache = new Map();
      for (const row of store.listSettings()) {
        const definition = BY_KEY.get(row.key);
        if (!definition) continue;
        try {
          const parsed = definition.validate(JSON.parse(row.value));
          if (!parsed.error) cache.set(row.key, { value: parsed.value, updatedAt: row.updatedAt, updatedBy: row.updatedBy });
        } catch {
          // Испорченное значение — как будто его нет: действует значение по умолчанию.
        }
      }
    }
    return cache;
  };
  const defaultOf = (definition) => (definition.default === null ? envDefaults[definition.key] : definition.default);

  const get = (key) => {
    const definition = BY_KEY.get(key);
    if (!definition) throw new Error(`unknown setting ${key}`);
    const stored = load().get(key);
    return stored ? stored.value : defaultOf(definition);
  };

  return Object.freeze({
    get,
    /** Для админ-панели: определение, значение, значение по умолчанию, кто и когда менял. */
    list() {
      return SETTINGS.map((definition) => {
        const stored = load().get(definition.key);
        return {
          key: definition.key,
          group: definition.group,
          label: definition.label,
          description: definition.description,
          type: definition.type,
          public: definition.public,
          value: stored ? stored.value : defaultOf(definition),
          defaultValue: defaultOf(definition),
          customized: Boolean(stored),
          updatedAt: stored?.updatedAt ? new Date(stored.updatedAt).toISOString() : null,
          updatedBy: stored?.updatedBy || null,
        };
      });
    },
    publicValues() {
      return Object.fromEntries(SETTINGS.filter((definition) => definition.public).map((definition) => [definition.key, get(definition.key)]));
    },
    /**
     * Проверяет все значения и сохраняет их одной транзакцией. Возвращает
     * изменения {key: {from, to}} или ошибки по ключам.
     */
    update(values, actorId) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) return { errors: { _: 'Ожидается объект настроек.' } };
      const errors = {};
      const changes = {};
      for (const [key, raw] of Object.entries(values)) {
        const definition = BY_KEY.get(key);
        if (!definition) {
          errors[key] = 'Такой настройки нет.';
          continue;
        }
        const parsed = definition.validate(raw);
        if (parsed.error) {
          errors[key] = parsed.error;
          continue;
        }
        const before = get(key);
        if (before !== parsed.value) changes[key] = { from: before, to: parsed.value };
      }
      // Связанные значения: предельный срок сессии не короче срока без активности.
      const idle = changes['sessions.idleDays']?.to ?? get('sessions.idleDays');
      const max = changes['sessions.maxDays']?.to ?? get('sessions.maxDays');
      if (!errors['sessions.idleDays'] && !errors['sessions.maxDays'] && idle > max) {
        errors['sessions.maxDays'] = 'Предельный срок не может быть короче срока без активности.';
      }
      if (Object.keys(errors).length > 0) return { errors };
      if (Object.keys(changes).length > 0) {
        store.putSettings(Object.entries(changes).map(([key, change]) => ({ key, value: JSON.stringify(change.to) })), actorId, now());
        cache = null;
      }
      return { changes };
    },
    /** Сбросить кеш (другой процесс поменял настройки, тесты). */
    reload() {
      cache = null;
    },
  });
};
