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
      // Ключи в клиентском коде — то, с чего начался этот аудит.
      // Правило ловит обращения вида import.meta.env.VITE_..._API_KEY.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD/i]',
          message: 'Секреты не должны попадать в клиентский бандл — обращайтесь через серверную функцию api/chat.js.',
        },
      ],
      'no-alert': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Серверные функции, скрипты и конфиги: окружение Node.
  {
    files: [
      'backend/**/*.js',
      'shared/**/*.js',
      'data/**/*.js',
      'scripts/**/*.{js,mjs}',
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
   * Граница доверия, проверяемая линтером.
   *
   * mintSanitizedPlannerRequest создаёт объект, который внешний планировщик
   * согласен принять. Если бы его мог импортировать любой модуль, инвариант
   * «наружу уходит только санитизированное» держался бы на внимательности.
   * Правило оставляет ровно одну точку создания — privacy/gateway.js.
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
