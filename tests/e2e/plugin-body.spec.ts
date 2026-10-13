/**
 * A plugin's own page, and its tab on an object, as a person opens them: its code, handed over by
 * Lumovi, told which page or which tab (with the object, read for it as its own kind), drawing
 * Lumovi's Table from what it reads. A row it says opens an object opens that object's page in
 * Lumovi, where Lumovi's door handed it, and the plugin is told which row. Another cluster's page
 * is another page, opened anew.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, expect, openCluster, panel, test } from './fixtures.ts'

const TOYS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: toys }
spec:
  version: 1.2.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: overview, title: Overview }]
  tabs: [{ id: parts, title: Parts, kinds: [{ group: example.com, kind: Widget }] }]
`

/**
 * Toys' code: told its page, it lists its widgets and draws them as a Table, each row opening its
 * widget; told its tab, it draws the tab's widget's name; told a row was pressed, it says which.
 */
const CODE = `box.then(({ post, listen }) => {
  let title = 'Widgets'
  let rows = []
  const props = () => ({
    title,
    columns: [{ name: 'Namespace', kind: 'text' }],
    headings: true,
    rows,
    onOpen: 'h1',
  })
  let made = false
  const draw = () => {
    post(JSON.stringify({ commit: made ? [['change', 1, props()]] : [['make', 1, 'Table', props()], ['put', 0, 1]] }))
    made = true
  }
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open && said.open.page) {
      draw()
      post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
    } else if (said.open && said.open.tab) {
      title = said.open.object ? 'Parts of ' + said.open.object.object.metadata.name : 'No widget: ' + said.open.ended
      draw()
    } else if (said.read === 1 && said.objects) {
      rows = said.objects.map(({ token, object }) => ({
        key: object.metadata.name,
        lead: { name: object.metadata.name },
        cells: [{ kind: 'text', text: object.metadata.namespace }],
        opens: token,
      }))
      draw()
    } else if (said.call === 'h1') {
      title = 'Opened ' + said.carries.row
      draw()
    }
  })
})
`

/**
 * Toys' code with tiles: one opens its widgets that aren't well, a kind its file names; one names
 * nodes, which its file doesn't; and one opens all its widgets. (Its code starts with a parenthesis, as a bundler's does:
 * a statement of its own after Lumovi's first lines, never a call of the last of them.)
 */
const TILES = `(() => {
  box.then(({ post, listen }) => {
    listen((text) => {
      if (!JSON.parse(text).open) return
      const tile = (key, label, opens) => ({ key, label, value: { kind: 'figure', text: '2' }, opens })
      post(JSON.stringify({ commit: [
        ['make', 1, 'Tiles', { tiles: [
          tile('bad', 'Widgets not well', { list: 'example.com/Widget', health: ['critical', 'warning'] }),
          tile('nodes', 'Nodes', { list: '/Node' }),
          tile('all', 'All widgets', { list: 'example.com/Widget' }),
        ] }],
        ['put', 0, 1],
      ] }))
    })
  })
})()
`

const body = (page: Page) => page.locator('[data-plugin-body]')
const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

function included(code = CODE): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), TOYS)
  writeFileSync(join(folder, 'toys.js'), code)
  return folder
}

test('a plugin’s page draws what its code reads with Lumovi’s Table, and a row opens its object in Lumovi', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await expect(body(page).getByTestId('plugin-whose')).toContainText('Toys 1.2.0')
  // Its widgets, as its code read them and said them: Lumovi's Table, a row a widget.
  const table = body(page).getByRole('grid', { name: 'Widgets' })
  const widget = table.getByRole('row', { name: `${CUSTOM.widget} default` })
  await expect(widget).toBeVisible()
  // Pressed, the row opens the widget's own page in Lumovi; and the plugin is told which row.
  await widget.click()
  await expect(panel(page, 'Widget', CUSTOM.widget)).toBeVisible()
  await expect(body(page).getByRole('grid', { name: `Opened ${CUSTOM.widget}` })).toBeVisible()
  await page.keyboard.press('Escape')

  // Another cluster's page is another page: opened anew, nothing of this one carried over.
  await go(page, `#/cluster/${CONTEXTS.sandbox}/plugins/toys/overview`)
  // (Its code starts again: the Table it draws is titled as it first is, with no row pressed.)
  await expect(body(page).getByRole('grid', { name: `Opened ${CUSTOM.widget}` })).toHaveCount(0)
  await expect(table).toBeVisible()
})

test('a tile opens a list of a kind its plugin’s file names, filtered as it says, and a tile naming any other kind opens nothing', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(TILES) } })
  const said: string[] = []
  page.on('console', (message) => said.push(message.text()))
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // Nodes aren't in its file: the tile is drawn, and pressing it can open nothing.
  const nodes = body(page).getByRole('region', { name: 'Nodes' })
  await expect(nodes).toContainText('2')
  await expect(nodes.getByRole('button')).toHaveCount(0)
  // Its widgets that aren't well: Lumovi's own list of them, filtered by the levels it said.
  await body(page).getByRole('region', { name: 'Widgets not well' }).getByRole('button').click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/cluster/${CONTEXTS.demo}/r/Widget.example.com?health=critical%2Cwarning`)
  // (Said once, for whoever writes the plugin: never to the person.)
  expect(said.filter((line) => line.includes('Lumovi opens no list of /Node'))).toEqual([
    'Lumovi opens no list of /Node for the plugin toys’ page: its file doesn’t name that kind.',
  ])
  // All of them: the list as it is, filtered by nothing.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await body(page).getByRole('region', { name: 'All widgets' }).getByRole('button').click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/cluster/${CONTEXTS.demo}/r/Widget.example.com`)
})

test('a plugin’s tab is handed the object it’s on, read for it as its own kind', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(
    page,
    `#/cluster/${CONTEXTS.demo}/r/Widget.example.com?open=${encodeURIComponent(`Widget.example.com/default/${CUSTOM.widget}`)}`,
  )
  const widget = panel(page, 'Widget', CUSTOM.widget)
  await widget.getByRole('tab', { name: 'Parts' }).click()
  await expect(
    widget
      .locator('[data-plugin-body]')
      .getByRole('heading', { name: new RegExp(`^Parts of ${CUSTOM.widget}`) }),
  ).toBeVisible()
})
