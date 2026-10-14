/**
 * The kit's Header, at work: a second status beside its first, with how long, counted by Lumovi,
 * and its line under; a button that's busy, where it was, with its word and, where the page
 * says, how long, which a press doesn't reach the plugin from; and one folded into "…", busy
 * there too.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const FILE = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: busy }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Busy
  kinds: [{ group: example.com, kind: Widget }]
  pages:
    - { id: overview, title: Overview }
`

/** Its code: a header at work; told a button was pressed, it says which in the header's name. */
const CODE = (started: string) => `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const props = (name) => ({
    name,
    status: { level: 'healthy', word: 'Healthy' },
    secondStatus: { level: 'progressing', word: 'Syncing', since: ${JSON.stringify(started)}, detail: 'Sync running: waiting for healthy state' },
    buttons: [
      { key: 'pause', name: 'Pause', changes: true, busy: { word: 'Pausing', since: ${JSON.stringify(started)} } },
      { key: 'look', name: 'Look' },
      { key: 'terminate', name: 'Terminate sync', asks: true, changes: true },
      { key: 'sync', name: 'Sync', asks: true, changes: true, busy: { word: 'Syncing' } },
    ],
    onPress: 'press',
  })
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) commit([['make', 1, 'Header', props('storefront')], ['put', 0, 1]])
    else if (said.call) commit([['change', 1, props('pressed ' + said.carries.button)]])
  })
})
`

test('a header at work: its second status with how long, a busy button that a press doesn’t get past, and a busy one folded', async ({
  launch,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  const started = new Date(Date.now() - 65_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(join(folder, 'busy.yaml'), FILE)
  writeFileSync(join(folder, 'busy.js'), CODE(started))
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await page.evaluate((to) => {
    window.location.hash = to
  }, `#/cluster/${CONTEXTS.demo}/plugins/busy/overview`)
  const drawn = page.locator('[data-plugin-body]')
  const header = drawn.getByRole('group', { name: 'storefront' })
  await expect(header).toBeVisible()

  // The second status, beside the first, with how long; its line is the one under.
  const second = header.locator('[data-health="progressing"]')
  await expect(second).toHaveText(/^Syncing1m \d\ds$/)
  await expect(header.locator('[data-health="healthy"]')).toHaveText('Healthy')
  await expect(header).toContainText('Sync running: waiting for healthy state')

  // The busy button, where it was: its word, no time of its own here, and Lumovi's words.
  const sync = header.getByRole('button', { name: /^Sync, busy/ })
  await expect(sync).toHaveAccessibleName('Sync, busy: syncing')
  await expect(sync).toHaveAttribute('aria-disabled', 'true')
  await expect(sync).toHaveText('Syncing')
  await sync.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Syncing. Sync can be pressed again when it’s done.',
  )
  // Pressed anyway, past what a person can: the plugin isn't told.
  await sync.click({ force: true })
  await header.getByRole('button', { name: 'Terminate sync…' }).click()
  await expect(drawn.getByRole('heading', { name: 'pressed terminate' })).toBeVisible()

  // Folded into "…": busy there too, with how long, and choosing it tells the plugin nothing.
  const after = drawn.getByRole('group', { name: 'pressed terminate' })
  await after.getByRole('button', { name: 'More for pressed terminate' }).click()
  const pause = page.getByRole('menuitem', { name: /^Pause, busy: pausing/ })
  await expect(pause).toHaveAttribute('aria-disabled', 'true')
  await expect(pause).toContainText(/Pausing\s*1m \d\ds/)
  // (Chosen from the keyboard, as a menu's item is: still nothing.)
  await pause.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(drawn.getByRole('heading', { name: 'pressed terminate' })).toBeVisible()
})
