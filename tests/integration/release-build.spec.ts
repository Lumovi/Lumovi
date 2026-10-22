/**
 * The build these tests run against is made as a release's is (`npm run build`, no
 * LUMOVI_COVERAGE). What the tests' own build adds for itself must not be in it: the counters,
 * the messages a test's server answers (to save its coverage; to stop, on Windows), and the
 * stand-ins the tests hand it in place of what a release only ever has built in or fetches.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  codedPlugins,
  pluginsAndCode,
  readLock,
  takePlugins,
  trust,
} from '../../scripts/plugins-bundle.ts'
import { RENDERER_MAPS } from '../../scripts/vite-coverage.ts'
import { openCluster } from '../e2e/fixtures.ts'
import { nameFor } from '../e2e/plugin-box/catchers.ts'
import { namedIn } from '../e2e/plugin-box/net-log.ts'
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
  // The switch that takes a wall of a plugin's box away, for the box check to fail on.
  'LUMOVI_TEST_BOX_WALL_OFF',
  // And the one that makes a box's check never answer.
  'LUMOVI_TEST_BOX_CHECK',
  // The one that lengthens Lumovi's wait for a plugin's tool's server.
  'LUMOVI_TEST_PLUGIN_SERVER_WAIT_MS',
  // The one that holds a terminal's PowerShell before its first line.
  'LUMOVI_TEST_POWERSHELL_HOLD_S',
  // The ones that make names resolve as a test says, and private addresses count as public.
  'LUMOVI_TEST_HOSTS',
  'LUMOVI_TEST_PUBLIC_ADDRESSES',
  'LUMOVI_SPONSOR_URL',
  // What the tests reach a plugin's box by.
  '__lumoviBox',
  // How many failed reads of a Secret's certificates the tests' build asks again for.
  '__lumoviCertificatePolls',
  // And the box they open with nothing taken away by the worker's first lines: by its name,
  // by what makes its worker's text, and by that text's own first line.
  'openBoxBare',
  'workerTextBare',
  'lumovi: first lines taken away',
  // The page the kit's parts are seen and tested on.
  'lumovi-kit-page',
  // And the stage a test plugin's page is drawn on, with the door's checks it lends the tests.
  '__lumoviDoor',
  'doorChecks',
  // And the edits Create's form makes to YAML text, which it lends them too.
  'yamlChecks',
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
  // The plugins it was built with, and nothing more: the release its lock pins, as the build took
  // it (the folder's file is nobody's).
  const built = Object.keys(pluginsAndCode(await takePlugins(readLock(), trust())).plugins).length
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

test('a release looks no name up ahead of a request: a link that asks for one is asked for by nobody', async ({
  launch,
}) => {
  // The tests' build shows it of a plugin's box, every way out tried, by Chromium's own log of
  // its network (plugin-box-ways-out). A release opens no box for a test, so here the link is on
  // a page of Lumovi's own: the setting is the whole app's, and an Electron that stopped heeding
  // it would look this name up.
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-net-log-')), 'net-log.json')
  const lumovi = await launch({ args: [`--log-net-log=${file}`] })
  await lumovi.page.evaluate(
    (href) =>
      document.head.append(
        Object.assign(document.createElement('link'), { rel: 'dns-prefetch', href }),
      ),
    `http://${nameFor('link-dns-prefetch')}`,
  )
  // What a link asks for is asked for at once: without the setting, its name is in the log
  // well inside this second (tried: the check fails then), and that run is what vouches for
  // the wait. Then a name of the test's own, which a log that was kept holds: the only one in it.
  await new Promise((done) => setTimeout(done, 1_000))
  await lumovi.app.evaluate(
    ({ session }, name) => session.defaultSession.resolveHost(name).catch(() => undefined),
    nameFor('asked-by-the-test'),
  )
  await lumovi.close()
  expect(namedIn(file).lookedUp).toEqual(['asked-by-the-test'])
})

test('a release’s pages open a plugin’s box only where they take its code through the hand-over', () => {
  // A release's pages name the box's address where the policy says what a page may frame, and
  // in what opens a plugin's page: and that is where its code is taken, through the one call
  // that hands it over (`pluginCode`, the backend's `mayHandOver`), and nowhere else. (The
  // tests' stage, which can be given code of its own, is in none of them: TESTS_ONLY, above.)
  const pages = resolve('out', 'renderer')
  const read = (file: string) => readFileSync(join(pages, file), 'utf8')
  const files = readdirSync(pages, { recursive: true, encoding: 'utf8' }).filter((file) =>
    /\.(js|mjs|cjs|html)$/.test(file),
  )
  const naming = files.filter((file) => read(file).includes('lumovi-plugin'))
  expect(read('index.html')).toContain('frame-src lumovi-plugin:')
  const opening = naming.filter((file) => file !== 'index.html')
  expect(opening.length).toBeGreaterThan(0)
  for (const file of opening) expect(read(file), file).toContain('kube:plugin-code')
})

/**
 * The runs of a plugin's code that a string holding it has word for word however a bundle writes
 * it (in what quotes, with what escaped): what's between quotes, backslashes, `$`, line ends and
 * anything not plain ASCII. The long ones, which nothing else would have.
 */
const runsOf = (source: string) =>
  source.split(/[^\x20-\x7e]|['"`\\$]/).filter((run) => run.length >= 40)

test('a release carries plugins’ code only as the release its lock pins has it, and its pages offer only theirs', async () => {
  const { code } = pluginsAndCode(await takePlugins(readLock(), trust()))
  const out = resolve('out')
  const textOf = (part: string) =>
    readdirSync(join(out, part), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(js|mjs|cjs|html)$/.test(file))
      .map((file) => readFileSync(join(out, part, file), 'utf8'))
      .join('\n')
  const backends = ['main', 'server'].map((part) => [part, textOf(part)] as const)
  const pages = textOf('renderer')
  for (const [file, source] of Object.entries(code)) {
    const runs = runsOf(source)
    expect(runs.length, file).toBeGreaterThan(10)
    // The backends hold each plugin's code, as the bundle has it: the one place a page is handed
    // it from.
    for (const [part, text] of backends) {
      expect(
        runs.filter((run) => !text.includes(run)),
        `out/${part}: ${file}`,
      ).toEqual([])
    }
    // The pages hold none of it: none of its lines of code. (Its words may be Lumovi's too, as
    // its own overview of Karpenter, which stands in where the plugin's code is off, has them.)
    const lines = runs.filter((run) => /^ {2,}\S/.test(run))
    expect(lines.length, file).toBeGreaterThan(10)
    expect(
      lines.filter((line) => pages.includes(line)),
      `out/renderer: ${file}`,
    ).toEqual([])
  }
  // Only the names of the plugins whose code came with them: the ones whose pages they may offer.
  expect(pages).toContain(JSON.stringify(codedPlugins(code)))
})
