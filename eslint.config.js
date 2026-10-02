import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/',
      'dist/',
      'release/',
      'coverage/',
      '.nyc_output/',
      'test-results/',
      'playwright-report/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: [
      'src/main/**',
      'src/backend/**',
      'src/preload/**',
      'scripts/**',
      'tests/**',
      '*.config.{js,ts}',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // Shared by the desktop app and the server, which has no Electron.
    files: ['src/backend/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'electron', message: 'The server runs src/backend without Electron.' }] },
      ],
    },
  },
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['tests/**', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
)
