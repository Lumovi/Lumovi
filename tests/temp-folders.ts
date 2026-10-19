/**
 * Where the tests' temp folders go, and that they go (LMV-344). A run has a temp folder of its own,
 * each worker one in it and each test one in its worker's: `TMPDIR` (and Windows' `TEMP` and `TMP`)
 * names it, so what a test makes with `tmpdir()`, and what the apps and servers it starts make with
 * theirs, lands there. A test's goes when the test ends, however it ends; a worker's when it stops;
 * and the run's at its end, which fails if anything was left in it.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test as base } from '@playwright/test'

const KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const

/** Names `dir` as the temp folder, for this process and all it starts from now. */
export function tempFolderIs(dir: string): void {
  for (const key of KEYS) process.env[key] = dir
}

const remove = (dir: string) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

/**
 * The run's temp folder, made in global setup (before any worker starts, so each inherits it).
 * What it returns is the run's teardown: it removes the folder, and fails where something was left.
 */
export function runTempFolder(): () => void {
  // Playwright's own cache of compiled tests stays where it was, kept from run to run.
  process.env.PWTEST_CACHE_DIR ??= join(
    tmpdir(),
    process.platform === 'win32'
      ? 'playwright-transform-cache'
      : `playwright-transform-cache-${process.geteuid?.() ?? ''}`,
  )
  const run = mkdtempSync(join(tmpdir(), 'lumovi-run-'))
  tempFolderIs(run)
  return () => {
    // (Playwright's own, for traces and the like: it removes them itself, after this. What a
    // failed test keeps of them is in its results by now.)
    const left = readdirSync(run).filter((name) => !name.startsWith('playwright-artifacts-'))
    remove(run)
    if (left.length > 0) {
      throw new Error(
        `The tests left ${left.length} folders in their temp folder: what makes one removes it.\n${left.join('\n')}`,
      )
    }
  }
}

/** A worker's temp folder, for the worker's own (its mock clusters', say): gone when it stops. */
export async function workerTempFolder(use: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-worker-'))
  tempFolderIs(dir)
  try {
    await use(dir)
  } finally {
    remove(dir)
  }
}

/** A test's temp folder, in its worker's: gone when the test ends, passed or failed. */
export async function testTempFolder(
  worker: string,
  use: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(worker, 'test-'))
  tempFolderIs(dir)
  try {
    await use(dir)
  } finally {
    tempFolderIs(worker)
    remove(dir)
  }
}

/**
 * Playwright's `test`, each test in a temp folder of its own and each worker in one: what every
 * spec takes (or the fixtures that extend it), so none makes a folder that outlives it.
 */
export const test = base.extend<{ testTemp: string }, { workerTemp: string }>({
  workerTemp: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => workerTempFolder(use),
    { scope: 'worker', auto: true },
  ],
  testTemp: [async ({ workerTemp }, use) => testTempFolder(workerTemp, use), { auto: true }],
  // A worker's browser, started inside whichever test first wants one, keeps the worker's temp
  // folder: not that test's, which goes when it ends (a download would go with it).
  launchOptions: [
    async ({ launchOptions, workerTemp }, use) =>
      use({
        ...launchOptions,
        env: { ...process.env, TMPDIR: workerTemp, TMP: workerTemp, TEMP: workerTemp },
      }),
    { scope: 'worker' },
  ],
})

export { expect }
