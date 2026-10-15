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
import type { Locator, Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { CONTEXTS, expect, openCluster, panel, test } from './fixtures.ts'
import { holds } from '../holds.ts'

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

/** Toys, whose pages open Lumovi's lists of ten of Kubernetes' own kinds. */
const TOYS_OPENS = `${TOYS}  opens:
${[
  'apps/Deployment',
  'apps/StatefulSet',
  'apps/DaemonSet',
  '/Service',
  '/ConfigMap',
  'networking.k8s.io/Ingress',
  'batch/Job',
  'batch/CronJob',
  '/Pod',
  '/Secret',
]
  .map((id) => `    - { group: "${id.split('/')[0]}", kind: ${id.split('/')[1]} }`)
  .join('\n')}
`

/**
 * Toys' code with tiles that open a list at one object: a Deployment that's there, one that
 * isn't, and one of its own widgets, whose list its file doesn't say its pages open at one name.
 */
const AT_ONE = `box.then(({ post, listen }) => {
  listen((text) => {
    if (!JSON.parse(text).open) return
    const tile = (key, label, opens) => ({ key, label, value: { kind: 'figure', text: '1' }, opens })
    post(JSON.stringify({ commit: [
      ['make', 1, 'Tiles', { tiles: [
        tile('storefront', 'Storefront', { list: 'apps/Deployment', name: 'storefront', namespace: 'shop' }),
        tile('gone', 'Gone', { list: 'apps/Deployment', name: 'gone', namespace: 'shop' }),
        tile('widget', 'One widget', { list: 'example.com/Widget', name: '${CUSTOM.widget}' }),
      ] }],
      ['put', 0, 1],
      // A table's rows, as a plugin's own list of what it manages: one goes to its Deployment,
      // and one that's missing goes nowhere.
      ['make', 2, 'Table', { title: 'Resources', headings: true, columns: [{ name: 'Health', kind: 'text' }], rows: [
        { key: 'cart', lead: { name: 'cart', under: 'Deployment · shop' }, cells: [{ kind: 'text', text: 'Healthy' }],
          goes: { list: 'apps/Deployment', name: 'cart', namespace: 'shop' } },
        { key: 'lost', lead: { name: 'lost', under: 'Deployment · shop' }, cells: [{ kind: 'text', text: 'Missing' }] },
      ] }],
      ['put', 0, 2],
    ] }))
  })
})
`

const body = (page: Page) => page.locator('[data-plugin-body]')
/** What's said of an element where it's read: its text, without what's hidden from that. */
const read = (locator: Locator) =>
  locator.evaluate((element) => {
    const copy = element.cloneNode(true) as HTMLElement
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
    return copy.textContent
  })
const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

function included(code = CODE, file = TOYS): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'toys.yaml'), file)
  writeFileSync(join(folder, 'toys.js'), code)
  return folder
}

test('a plugin’s page draws what its code reads with Lumovi’s Table, and a row opens its object in Lumovi', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // What it may do, Lumovi's bar says, in its More: no line on the page.
  await page.locator('header').getByRole('button', { name: 'More' }).click()
  await expect(page.getByRole('menuitem', { name: 'What Toys may do' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(body(page).getByText('This page is from')).toHaveCount(0)
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

test('a tile opens Lumovi’s list at one object, of a kind its file says its pages open, and the list says so until it’s cleared', async ({
  launch,
}) => {
  const { page } = await launch({
    env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included(AT_ONE, TOYS_OPENS) },
  })
  const said: string[] = []
  page.on('console', (message) => said.push(message.text()))
  await openCluster(page)
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  // Its own widget at one name: its file doesn't say its pages open that, so the tile opens nothing.
  await expect(body(page).getByRole('region', { name: 'Storefront' })).toBeVisible()
  await expect(
    body(page).getByRole('region', { name: 'One widget' }).getByRole('button'),
  ).toHaveCount(0)
  await expect
    .poll(() => said.filter((line) => line.includes('at one name')))
    .toEqual([
      'Lumovi opens no list of example.com/Widget at one name for the plugin toys’ page: its file doesn’t name that kind under spec.opens.',
    ])

  // Pressed, the Deployment's: Lumovi's own list of Deployments, of that one alone, in its namespace.
  await body(page).getByRole('region', { name: 'Storefront' }).getByRole('button').click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/cluster/${CONTEXTS.demo}/deployments?name=storefront&ns=shop&plugin=toys`)
  const note = page.getByTestId('list-at-one')
  await expect.poll(() => read(note)).toContain('name storefront · namespace shop')
  await expect(note).toContainText(
    'Opened from Toys’ page: only this one is shown. Clear the filter to see every Deployment.',
  )
  const grid = page.getByRole('grid', { name: 'Deployments' })
  await expect(grid.getByRole('row').filter({ hasText: 'storefront' })).toHaveCount(1)
  await expect(grid.getByRole('row').filter({ hasText: 'checkout' })).toHaveCount(0)
  // Cleared: every Deployment again, and nothing said of a filter.
  await note.getByRole('button', { name: 'Clear the filter and show every Deployment' }).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/cluster/${CONTEXTS.demo}/deployments`)
  await expect(note).toHaveCount(0)
  await expect(grid.getByRole('row').filter({ hasText: 'checkout' })).toHaveCount(1)

  // A table's row that goes to one: the same list, at its object; one that goes nowhere is quiet.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  const resources = body(page).getByRole('grid', { name: 'Resources' })
  await resources.getByRole('row', { name: /^lost/ }).click()
  await holds(
    async () =>
      (await page.evaluate(() => window.location.hash)) ===
      `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`,
    300,
    'a row that goes nowhere stays where it is',
  )
  await resources.getByRole('row', { name: /^cart/ }).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/cluster/${CONTEXTS.demo}/deployments?name=cart&ns=shop&plugin=toys`)
  await expect.poll(() => read(note)).toContain('name cart · namespace shop')

  // One that isn't there, or that the person can't see: said so.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins/toys/overview`)
  await body(page).getByRole('region', { name: 'Gone' }).getByRole('button').click()
  await expect(page.getByText('No Deployment gone in shop that you can see')).toBeVisible()

  // An address naming a plugin whose file doesn't open the kind: whose page it was isn't said; and
  // a kind without namespaces has none in its chip.
  await go(page, `#/cluster/${CONTEXTS.demo}/nodes?name=gone&ns=shop&plugin=toys`)
  await expect.poll(() => read(note)).toContain('name gone')
  await expect(note).not.toContainText('namespace')
  await expect(note).toContainText('Only this one is shown. Clear the filter to see every Node.')
  await expect(note).not.toContainText('Toys')
  await expect(page.getByText('No Node gone that you can see')).toBeVisible()
  // A kind with namespaces named without one, by hand: looked for where the list looks, and said.
  await go(page, `#/cluster/${CONTEXTS.demo}/deployments?name=gone`)
  await expect(page.getByText('No Deployment gone in this cluster that you can see')).toBeVisible()

  // The Plugins page says which lists its pages may open: eight by name, the rest in a tooltip.
  await go(page, `#/cluster/${CONTEXTS.demo}/plugins?plugin=toys`)
  const opens = page.locator('[data-plugin-opens]')
  await expect(opens).toHaveText(
    'Its pages may open Lumovi’s lists of Deployments, StatefulSets, DaemonSets, Services, ConfigMaps, Ingresses, Jobs, CronJobs and 2 more kinds.',
  )
  await opens.getByText('2 more kinds').hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Deployments, StatefulSets, DaemonSets, Services, ConfigMaps, Ingresses, Jobs, CronJobs, Pods and Secrets',
  )
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
  // (Its one part is its table: a list, as Lumovi's own tabs' are, named by its title.)
  await expect(
    widget
      .locator('[data-plugin-body]')
      .getByRole('region', { name: new RegExp(`^Parts of ${CUSTOM.widget}`) }),
  ).toBeVisible()
})
