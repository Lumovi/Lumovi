import { defineConfig } from '@playwright/test'

const ci = Boolean(process.env.CI)

/**
 * Integration tests against a real cluster (kind): `npm run test:kind`.
 * They share one cluster and change it, so they run one at a time.
 */
export default defineConfig({
  testDir: 'tests/integration',
  globalSetup: './tests/integration/global-setup.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  reporter: ci
    ? [
        ['github'],
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report-integration' }],
      ]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-integration' }]],
  outputDir: 'test-results-integration',
  use: { screenshot: 'off', trace: 'off' },
})
