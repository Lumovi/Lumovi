import { availableParallelism } from 'node:os'
import { defineConfig } from '@playwright/test'

const ci = Boolean(process.env.CI)

export default defineConfig({
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
  projects: [
    // The desktop app (Electron), driven through its window.
    { name: 'desktop', testDir: 'tests/e2e' },
    // KubeStacks served from a cluster (out/server), in a browser.
    {
      name: 'web',
      testDir: 'tests/web',
      use: {
        browserName: 'chromium',
        viewport: { width: 1440, height: 920 },
        locale: 'en-US',
        // Transitions are shortened under reduced motion, which keeps the tests quick and stable.
        reducedMotion: 'reduce',
        trace: ci ? 'retain-on-failure' : 'off',
      },
    },
  ],
})
