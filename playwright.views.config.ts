import { defineConfig } from '@playwright/test'

/**
 * KubeStacks' own views, checked against the CRDs of the operators they're
 * for (tests/views). Nothing to build or launch: `npm run views:check`.
 */
export default defineConfig({
  testDir: 'tests/views',
  // For the views' own imports (@shared/…).
  tsconfig: './tsconfig.test.json',
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
})
