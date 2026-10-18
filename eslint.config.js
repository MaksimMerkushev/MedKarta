import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'node_modules', '.vercel', 'scratch', 'data/*.full.js']),

  // Клиентский код: окружение браузера.
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      // Секреты не должны попасть в бандл: правило ловит любые переменные
      // окружения *API_KEY, *SECRET_KEY, *ACCESS_TOKEN, *PASSWORD
      // (import.meta.env.VITE_..._API_KEY, process.env.…) и такие же константы
      // в ВЕРХНЕМ_РЕГИСТРЕ. Поля API в camelCase (user.mustChangePassword,
      // temporaryPassword из ответа администратору) — не конфигурация и не ловятся.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.property.name="env"][property.name=/API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD/i]',
          message: 'Секреты не должны попадать в клиентский бандл — обращайтесь через серверную функцию api/chat.js.',
        },
        {
          selector: 'MemberExpression[property.name=/^[A-Z0-9_]*(API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD)[A-Z0-9_]*$/]',
          message: 'Секреты не должны попадать в клиентский бандл — обращайтесь через серверную функцию api/chat.js.',
        },
      ],
      'no-alert': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Сервер, общий код, скрипты и конфиги: окружение Node.
  {
    files: [
      'backend/**/*.js',
      'shared/**/*.js',
      'data/**/*.js',
      'scripts/**/*.{js,mjs}',
      'tools/**/*.js',
      'vite.config.js',
      'eslint.config.js',
      'postcss.config.js',
      'tailwind.config.js',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
    },
  },

  /*
   * Граница доверия: mintSanitizedPlannerRequest создаёт объект, который принимает
   * внешний планировщик, и импортировать его может только privacy/gateway.js — иначе
   * инвариант «наружу уходит только санитизированное» держался бы на внимательности.
   * Дублируется тестом tests/boundary.test.js на случай отключения линтера.
   */
  {
    files: ['backend/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './models.js',
              importNames: ['mintSanitizedPlannerRequest'],
              message:
                'SanitizedPlannerRequest создаётся только в privacy/gateway.js — см. docs/privacy-architecture.md.',
            },
            {
              name: '../privacy/models.js',
              importNames: ['mintSanitizedPlannerRequest'],
              message:
                'SanitizedPlannerRequest создаётся только в privacy/gateway.js — см. docs/privacy-architecture.md.',
            },
            {
              name: './privacy/models.js',
              importNames: ['mintSanitizedPlannerRequest'],
              message:
                'SanitizedPlannerRequest создаётся только в privacy/gateway.js — см. docs/privacy-architecture.md.',
            },
          ],
        },
      ],
      // В серверном коде логирование идёт только через observability/safeLogger:
      // console печатает объекты целиком, вместе с телом запроса.
      'no-console': 'error',
    },
  },

  {
    files: ['backend/privacy/gateway.js'],
    rules: { 'no-restricted-imports': 'off' },
  },

  {
    files: ['tests/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'smart'],
    },
  },
])
