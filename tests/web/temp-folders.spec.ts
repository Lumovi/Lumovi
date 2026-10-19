/**
 * The tests' temp folders go (LMV-344): what a test makes in its own, by itself or through a
 * server it starts, is gone when it ends, and so it is when the test fails.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testTempFolder, tempFolderIs } from '../temp-folders.ts'
import { expect, test } from './fixtures.ts'

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
