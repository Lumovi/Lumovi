/**
 * Where the tests' temp folders go, and that they go (LMV-344). A run has a temp folder of its own,
 * each worker one in it and each test one in its worker's: `TMPDIR` (and Windows' `TEMP` and `TMP`)
 * names it, so what a test makes with `tmpdir()`, and what the apps and servers it starts make with
 * theirs, lands there. A test's goes when the test ends, however it ends; a worker's when it stops;
 * and the run's at its end, which fails if anything was left in it.
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test as base } from '@playwright/test'

const KEYS = ['TMPDIR', 'TMP', 'TEMP'] as const

/** Names `dir` as the temp folder, for this process and all it starts from now. */
export function tempFolderIs(dir: string): void {
  for (const key of KEYS) process.env[key] = dir
}

/** Runs `start` with `dir` named as the temp folder, then names again what was named before. */
async function inFolder<T>(dir: string, start: () => Promise<T>): Promise<T> {
  const before = KEYS.map((key) => process.env[key])
  tempFolderIs(dir)
  try {
    return await start()
  } finally {
    KEYS.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key]
      else process.env[key] = before[i]
    })
  }
}

/** Every process running, as its id and its command line: none where they can't be listed. */
export function processes(): { id: number; commandLine: string }[] {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? [
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
        ]
      : // (However long each is.)
        ['ps', ['-Aww', '-o', 'pid=,args=']]
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 30_000 })
      .split(/\r?\n/)
      .flatMap((line) => {
        const [, id, commandLine] = /^(\d+) +(.+)$/.exec(line.trim()) ?? []
        return id && commandLine ? [{ id: Number(id), commandLine }] : []
      })
  } catch {
    return []
  }
}

/** The processes whose command line names `path` (a browser names its profile there). */
const naming = (path: string) =>
  processes().filter(({ commandLine }) => commandLine.toLowerCase().includes(path.toLowerCase()))

/** Those, by their program and id: what may still have something in `dir` open. */
function namingIt(dir: string): string[] {
  return naming(dir).map(({ id, commandLine }) => {
    // (Its program: the first word, or what's quoted first.)
    const program = /^("[^"]*"|\S+)/.exec(commandLine)![1]!.replaceAll('"', '')
    return `${basename(program)} (process ${id})`
  })
}

/** How long what's ended outright is waited for. */
const ENDED_WITHIN_MS = 15_000

/**
 * Ends `child` outright, with all it started, and waits until no process names `named` (a path
 * only they have: an app's user data). On Windows a process ended outright leaves what it started
 * running, with what they have open still open: there its whole tree is ended, while its root is
 * there to find it by. Whatever still names `named` is ended too, wherever it is.
 */
export async function endedWhole(child: ChildProcess, named: string): Promise<void> {
  if (process.platform === 'win32' && child.pid !== undefined && child.exitCode === null) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 30_000,
      })
    } catch {
      // (Some of it had ended already: what's left is ended below.)
    }
  }
  child.kill('SIGKILL')
  const until = Date.now() + ENDED_WITHIN_MS
  for (let left = naming(named); left.length > 0; left = naming(named)) {
    if (Date.now() > until) {
      const ids = left.map(({ id }) => id).join(', ')
      console.warn(`Still running ${ENDED_WITHIN_MS / 1000} s after they were ended: ${ids}.`)
      return
    }
    for (const { id } of left) {
      try {
        process.kill(id, 'SIGKILL')
      } catch {
        // (Ended meanwhile.)
      }
    }
    await new Promise((wait) => setTimeout(wait, TRIED_EVERY_MS))
  }
}

/** How long a folder that won't go is tried again, and how often. */
const REMOVED_WITHIN_MS = 10_000
const TRIED_EVERY_MS = 250

/**
 * Removes `dir` and all in it. On Windows nothing another process has open can go, nor any folder
 * holding it: tried again for a while, as a process that's ending lets go. Then it fails, naming
 * what's left in it and what may still have it open.
 */
export function removeFolder(dir: string, within = REMOVED_WITHIN_MS): void {
  const until = Date.now() + within
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (Date.now() < until) {
        // (A teardown waits as it is: synchronously.)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TRIED_EVERY_MS)
        continue
      }
      throw notRemoved(dir, error)
    }
  }
}

/** Why `dir` is still there: what's left in it (the first 20), and what names it. */
function notRemoved(dir: string, error: unknown): Error {
  const left = existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : []
  const more = left.length > 20 ? `, and ${left.length - 20} more` : ''
  const holders = namingIt(dir)
  return new Error(
    [
      `${dir} couldn’t be removed: ${(error as Error).message}`,
      `Left in it: ${left.length === 0 ? 'nothing' : left.slice(0, 20).join(', ') + more}.`,
      `Naming it: ${holders.length === 0 ? 'no process' : holders.join(', ')}.`,
    ].join('\n'),
    { cause: error },
  )
}

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
    removeFolder(run)
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
    removeFolder(dir)
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
    removeFolder(dir)
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
  // A worker's browser, started inside whichever test first wants one, is the worker's, and so is
  // its temp folder: not that test's, which goes when it ends. What Playwright makes for it as it
  // starts (its profile) is in the worker's (as it's started), and what it makes itself too (its
  // own environment). On Windows a folder can't go while a browser has files in it open, and a
  // browser's profile is open as long as it runs (LMV-383).
  browser: [
    async ({ playwright, browserName, workerTemp }, use) => {
      const browser = await inFolder(workerTemp, () => playwright[browserName].launch())
      await use(browser)
      await browser.close({ reason: 'Test ended.' })
    },
    { scope: 'worker', timeout: 0 },
  ],
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
