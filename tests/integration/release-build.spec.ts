/**
 * The build these tests run against is made as a release's is (`npm run build`, no
 * LUMOVI_COVERAGE). What the tests' own build adds for itself must not be in it: the counters,
 * the messages a test's server answers (to save its coverage; to stop, on Windows), and the
 * stand-ins the tests hand it in place of what a release only ever has built in or fetches.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { RENDERER_MAPS } from '../../scripts/vite-coverage.ts'
import { openCluster } from '../e2e/fixtures.ts'
import { CONTEXT, expect, test } from './fixtures.ts'

/** What scripts/vite-coverage.ts puts in a build, by the names only it uses. */
const TESTS_ONLY = [
  'lumovi:stop',
  'lumovi:coverage',
  '__coverage__',
  'LUMOVI_COVERAGE_DIR',
  '__lumoviSaveCoverage__',
  // And what its stand-ins are given by, with the constant that keeps them to that build.
  'LUMOVI_TEST_BUILD',
  'LUMOVI_TEST_INCLUDED_PLUGINS_DIR',
  'LUMOVI_SPONSOR_URL',
  // What the tests reach a plugin's box by.
  '__lumoviBox',
  // The page the kit's parts are seen and tested on.
  'lumovi-kit-page',
  // And the stage a test plugin's page is drawn on, with the door's checks it lends the tests.
  '__lumoviDoor',
  'doorChecks',
]

const PLUGIN = `
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: slipped-in }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Slipped in
  kinds: [{ group: example.com, kind: Widget }]
`

test('Lumovi’s own plugins are the ones built in: nothing read while it runs is taken for one', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'slipped-in.yaml'), PLUGIN)
  // What makes the tests' build take a folder's files as plugins that came inside it.
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page, CONTEXT)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'API resources' })
    .click()
  // The plugins it was built with, and nothing more: the folder's file is nobody's.
  const built = readdirSync('plugins').filter((name) => name.endsWith('.yaml')).length
  await expect(page.getByText(new RegExp(`^${built} plugins from Lumovi\\.`))).toBeVisible()
  await expect(page.getByRole('list', { name: 'Plugin problems' })).toHaveCount(0)
})

test('a build made as a release’s carries nothing the tests’ build adds for itself', () => {
  const out = resolve('out')
  const found: string[] = []
  const built = readdirSync(out, { recursive: true, encoding: 'utf8' }).filter((file) =>
    /\.(js|mjs|cjs|html)$/.test(file),
  )
  // The server, the agent, the app's main process and its pages: all of them.
  for (const part of ['server', 'agent', 'main', 'preload', 'renderer']) {
    expect(
      built.some((file) => file.split(/[\\/]/)[0] === part),
      `out/${part} is built`,
    ).toBe(true)
  }
  for (const file of built) {
    const text = readFileSync(join(out, file), 'utf8')
    for (const name of TESTS_ONLY) if (text.includes(name)) found.push(`${file}: ${name}`)
  }
  expect(found).toEqual([])
  // Nor the maps a coverage build writes beside its pages, from an earlier build.
  expect(existsSync(resolve(RENDERER_MAPS)), RENDERER_MAPS).toBe(false)
})

test('a release’s pages hold no way to hand a plugin’s box any code', () => {
  // The piece of a page that opens a box is in the tests' build alone so far: a release's
  // pages name the box's address in one place, the policy that says what a page may frame.
  const pages = resolve('out', 'renderer')
  const naming = readdirSync(pages, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(js|mjs|cjs|html)$/.test(file))
    .filter((file) => readFileSync(join(pages, file), 'utf8').includes('lumovi-plugin'))
  expect(naming).toEqual(['index.html'])
  expect(readFileSync(join(pages, 'index.html'), 'utf8')).toContain('frame-src lumovi-plugin:')
})
