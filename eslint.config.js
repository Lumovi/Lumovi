import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** A fixed wait, refused in the tests: what it waits for is what to wait for. */
const FIXED_WAIT = {
  selector: "CallExpression[callee.property.name='waitForTimeout']",
  message:
    "A fixed wait is a race. Wait for what it's for: an expect, expect.poll or a locator's state; for what mustn't happen, holds() (tests/holds.ts). Where only time itself can pass, say why: // eslint-disable-next-line no-restricted-syntax -- <why>.",
}
/** A measurement, refused in the tests but through placed() (tests/placed.ts), which waits for the view. */
const MEASURED = {
  selector: "CallExpression[callee.property.name='boundingBox']",
  message: 'Measure with placed() (tests/placed.ts): it waits until what it measures is in view.',
}
/** The tests that measured before placed() was there, each by its own waits. */
const MEASURED_BEFORE = [
  'tests/e2e/app-menu.spec.ts',
  'tests/e2e/columns.spec.ts',
  'tests/e2e/create-form-kinds.spec.ts',
  'tests/e2e/experience.spec.ts',
  'tests/e2e/kit-graph.spec.ts',
  'tests/e2e/kit-page.spec.ts',
  'tests/e2e/lists.spec.ts',
  'tests/e2e/local-terminal.spec.ts',
  'tests/e2e/map.spec.ts',
  'tests/e2e/metrics.spec.ts',
  'tests/e2e/overview.spec.ts',
  'tests/e2e/plugin-page.spec.ts',
  'tests/web/create.spec.ts',
  'tests/web/managed-by-phone.spec.ts',
  'tests/web/phone-events-many.spec.ts',
  'tests/web/phone-kit-graph.spec.ts',
  'tests/web/phone-kit-page.spec.ts',
  'tests/web/phone-kit.spec.ts',
  'tests/web/phone-notes.spec.ts',
  'tests/web/phone.spec.ts',
]

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
  // A test that waits a fixed time is a race; and one that measures before what it measures is
  // in view measures it where it opened, on a slow machine.
  {
    files: ['tests/**/*.ts'],
    ignores: MEASURED_BEFORE,
    rules: { 'no-restricted-syntax': ['error', FIXED_WAIT, MEASURED] },
  },
  {
    files: MEASURED_BEFORE,
    rules: { 'no-restricted-syntax': ['error', FIXED_WAIT] },
  },
)
