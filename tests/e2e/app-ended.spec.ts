/**
 * An app that won't quit is ended with all it started (LMV-383): on Windows, ending only its main
 * process leaves its others running, with its user data open, and its test's folder can't go.
 */
import { existsSync } from 'node:fs'
import { endedWhole, naming, removeFolder } from '../temp-folders.ts'
import { expect, test } from './fixtures.ts'

test('an app ended outright goes with all it started, and its user data can go', async ({
  launch,
}) => {
  const { app, userDataDir } = await launch()
  // Its own processes (its page's, its GPU's) name its user data, as it does.
  await expect.poll(() => naming(userDataDir).length).toBeGreaterThan(1)
  await endedWhole(app.process(), userDataDir)
  expect(naming(userDataDir)).toEqual([])
  removeFolder(userDataDir, 2_000)
  expect(existsSync(userDataDir)).toBe(false)
})
