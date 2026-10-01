import { availableParallelism } from 'node:os'
import { defineConfig } from '@playwright/test'

const ci = Boolean(process.env.CI)

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  // On CI, a test per core on Linux and Windows (4); macOS runners (3 cores, 7 GB) are
  // fastest with 2.
  workers: ci ? (process.platform === 'darwin' ? 2 : availableParallelism()) : 4,
  reporter: ci
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    screenshot: 'off',
    trace: 'off',
  },
})
