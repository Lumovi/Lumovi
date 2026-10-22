/**
 * The tests' temp folders go (LMV-344): what a test makes in its own, by itself or through a
 * server it starts, is gone when it ends, and so it is when the test fails. What the worker keeps
 * for all its tests is in the worker's (LMV-383), what's ended outright goes with all it started,
 * and a folder that can't go says why.
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  endedWhole,
  naming,
  processes,
  removeFolder,
  testTempFolder,
  tempFolderIs,
} from '../temp-folders.ts'
import { expect, test } from './fixtures.ts'

test('a process ended outright goes with all it started, and so does whatever names its folder', async ({
  testTemp,
}) => {
  const named = mkdtempSync(join(testTemp, 'app-'))
  // A stand-in for an app: a process that starts one of its own, as an app does its pages' and
  // its GPU's, which names its folder as they name its user data.
  const starts = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[1]], { stdio: 'ignore' }); console.log('started'); setInterval(() => {}, 1000)`
  const app = spawn(process.execPath, ['-e', starts, named], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    await new Promise<void>((started, ended) => {
      app.stdout!.once('data', () => started())
      app.once('exit', () => ended(new Error('The stand-in ended before it started its own')))
    })
    await expect.poll(() => naming(named).length).toBe(2)
    await endedWhole(app, named)
    expect(naming(named)).toEqual([])
  } finally {
    // (Whatever a test that failed left running.)
    for (const { id } of naming(named)) {
      try {
        process.kill(id)
      } catch {
        // (Ended meanwhile.)
      }
    }
  }
})

test('the worker’s browser keeps its profile in the worker’s temp folder, not in the test’s that started it', async ({
  browser,
  testTemp,
  workerTemp,
}) => {
  expect(browser.isConnected()).toBe(true)
  // Its profile, as its processes were started with it (this worker's are the only ones in its
  // folder): where it keeps files open as long as it runs, which on Windows no test could remove.
  const profiles = processes().flatMap(({ commandLine }) => {
    const named = /--user-data-dir=("[^"]*"|\S+)/.exec(commandLine)?.[1]?.replaceAll('"', '')
    return named?.startsWith(workerTemp) ? [named] : []
  })
  expect(profiles.length).toBeGreaterThan(0)
  for (const profile of profiles) {
    expect(dirname(profile)).toBe(workerTemp)
    expect(profile.startsWith(testTemp)).toBe(false)
  }
})

test('a folder that can’t be removed says why: what’s left in it, and what names it', async ({
  testTemp,
}) => {
  const windows = process.platform === 'win32'
  test.skip(!windows && process.getuid?.() === 0, 'root removes what it can’t write to')
  const dir = mkdtempSync(join(testTemp, 'held-'))
  const kept = join(dir, 'kept')
  mkdirSync(kept)
  const file = join(kept, 'a file')
  writeFileSync(file, '')
  // Held by a process that names it. On Windows, as a browser holds its profile: with a file in
  // it open and shared with nobody (Node's own share it with whoever removes them). Elsewhere,
  // where an open file holds nothing, by a folder in it that nothing can be removed from.
  const holder = windows
    ? spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'; $held = [IO.File]::Open('${file}', 'Open', 'Read', 'None'); 'open'; Start-Sleep -Seconds 600`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
    : spawn(process.execPath, ['-e', 'console.log("open"); setInterval(() => {}, 1000)', kept], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
  const exited = new Promise((done) => holder.once('exit', done))
  try {
    await new Promise<void>((open, ended) => {
      holder.stdout!.once('data', () => open())
      holder.once('exit', () => ended(new Error('The holder ended before it held the folder')))
    })
    if (!windows) chmodSync(kept, 0o500)
    let said = ''
    try {
      removeFolder(dir, 500)
    } catch (error) {
      said = (error as Error).message
    }
    expect(said).toContain(`${dir} couldn’t be removed: `)
    expect(said).toContain('Left in it: kept')
    expect(said).toContain(`(process ${holder.pid})`)
  } finally {
    if (!windows) chmodSync(kept, 0o700)
    holder.kill()
    await exited
  }
})

test('a test’s temp folder, with what it made and a server it started, goes when it ends, though it failed', async ({
  serve,
  testTemp,
  workerTemp,
}) => {
  // Its own, in its worker's.
  expect(tmpdir()).toBe(testTemp)
  expect(testTemp.startsWith(workerTemp)).toBe(true)
  let made = ''
  let served = ''
  // A test, as the fixture runs one, that makes a folder and starts a server, then fails.
  await expect(
    testTempFolder(workerTemp, async (dir) => {
      made = mkdtempSync(join(tmpdir(), 'lumovi-proof-'))
      writeFileSync(join(made, 'kept'), 'until the test ends')
      served = tmpdir()
      expect(served).toBe(dir)
      await serve()
      throw new Error('it fails, as a test can')
    }),
  ).rejects.toThrow('it fails, as a test can')
  expect(made).not.toBe('')
  expect(existsSync(made)).toBe(false)
  expect(existsSync(served)).toBe(false)
  // (Back in this test's own, for the rest of it.)
  expect(tmpdir()).toBe(workerTemp)
  tempFolderIs(testTemp)
  expect(existsSync(testTemp)).toBe(true)
})
