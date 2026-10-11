import { defineConfig } from '@playwright/test'

/**
 * Lumovi's plugins, checked against the CRDs of the operators they're
 * for (tests/plugins). Nothing to build or launch: `npm run plugins:check`.
 */
export default defineConfig({
  testDir: 'tests/plugins',
  // For the plugins' own imports (@shared/…).
  tsconfig: './tsconfig.test.json',
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
})
