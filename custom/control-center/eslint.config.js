import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'test-results/**', 'playwright-report/**', 'tests/fixtures/**', '.tmp/**', 'reports/**', '.stryker-tmp/**', 'stryker-setup-*.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // Type-aware rules for the bug classes the hunt keeps finding by hand:
    // unawaited promises, promise-returning callbacks where void is expected,
    // non-exhaustive switches over unions, and awaits on non-promises.
    // require-await stays off: it reported 1871 async functions with no await, every one an async wrapper that
    // satisfies a Promise-returning contract (Fastify plugins, handlers and onClose hooks, test callbacks), where
    // dropping async would turn rejections into synchronous throws without catching a bug.
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
);
