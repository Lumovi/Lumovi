/**
 * Every part of Lumovi's a plugin's page may name, drawn through a real plugin's page: what its
 * code describes goes through its box and the door, each part checked against its declaration
 * and drawn by Lumovi's own component (plugins/kit.tsx). A page with every part and its handlers,
 * one with the same parts and none, and a Graph the door refuses for each thing its kinds can't
 * say, the page stopped whole with Lumovi's own words.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

/** The pages: one with every part, one with them and no handlers, and five a Graph can't be. */
const REFUSED = {
  twice: 'Cards 1 and 2 have the same key.',
  icon: 'Card 1 opens an object and names an icon: one that opens an object has its object’s own.',
  from: 'Line 1 starts at a card that isn’t there.',
  to: 'Line 1 ends at a card that isn’t there.',
  self: 'Line 1 starts and ends at the same card.',
} as const

const PARTS = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: parts }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Parts
  kinds: [{ group: example.com, kind: Widget }]
  pages:
    - { id: overview, title: Overview }
    - { id: plain, title: Plain }
${Object.keys(REFUSED)
  .map((id) => `    - { id: ${id}, title: ${id} }`)
  .join('\n')}
`

/**
 * Its code: told its page, it describes it. Told a part was pressed or picked, it says which in
 * the header's name, so the test sees the plugin was told.
 */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  const card = (key, name, extra = {}) => ({ key, name, kind: 'Robot', cells: [], ...extra })
  const graphOf = (nodes, edges) => ({ title: 'Wires', columns: [], nodes, edges })
  const BAD = {
    twice: graphOf([card('a', 'arm'), card('a', 'leg')], []),
    icon: graphOf([card('a', 'arm', { icon: 'box', opens: 'made-up-token' })], []),
    from: graphOf([card('a', 'arm')], [{ from: 'nowhere', to: 'a' }]),
    to: graphOf([card('a', 'arm')], [{ from: 'a', to: 'nowhere' }]),
    self: graphOf([card('a', 'arm')], [{ from: 'a', to: 'a' }]),
  }
  const rows = (group, names) =>
    names.map((name, i) => ({
      key: group + i,
      group,
      lead: { level: i % 2 ? 'warning' : 'healthy', name, under: 'shelf ' + (i + 1) },
      cells: [
        { kind: 'number', value: i + 1, text: (i + 1) + ' parts' },
        { kind: 'status', level: i % 2 ? 'warning' : 'healthy', word: i % 2 ? 'Worn' : 'Fine' },
      ],
    }))
  const table = {
    title: 'Parts',
    headings: true,
    nameSorts: true,
    columns: [
      { name: 'Parts', kind: 'number', sorts: true },
      { name: 'Wear', kind: 'status', sorts: true },
    ],
    rows: [...rows('Arms', ['grabber', 'pincer', 'claw']), ...rows('Legs', ['wheel', 'track'])],
    shows: 2,
  }
  const everything = (handlers) => [
    ['make', 1, 'Split', {
      list: { title: 'Robots', rows: [
        { key: 'r1', lead: { level: 'healthy', name: 'robot-1', under: 'shelf A' }, status: { level: 'healthy', word: 'Ready' } },
        { key: 'r2', lead: { name: 'robot-2' } },
      ] },
      ...(handlers ? { onPick: 'pick' } : {}),
    }],
    ['make', 2, 'Stack', {}],
    ['make', 3, 'Header', {
      name: header,
      status: { level: 'warning', word: 'Low battery' },
      buttons: [{ key: 'look', name: 'Look' }, { key: 'dust', name: 'Dust' }, { key: 'paint', name: 'Paint' }, { key: 'rename', name: 'Rename', asks: true }, { key: 'charge', name: 'Recharge', changes: true }],
      ...(handlers ? { onPress: 'press' } : {}),
    }],
    ['make', 4, 'Tiles', {
      tiles: [
        { key: 'ready', icon: 'box', label: 'Robots ready', value: { kind: 'figure', text: '1/2' }, detail: 'one charging', level: 'warning' },
        { key: 'played', label: 'Last played', value: { kind: 'words', text: 'Yesterday' } },
        { key: 'reading', label: 'Still counting' },
      ],
      ...(handlers ? { onOpen: 'tile' } : {}),
    }],
    ['make', 5, 'Card', { title: 'Parts', note: 'two kinds' }],
    ['make', 6, 'Table', table],
    ['make', 7, 'Pair', { first: handlers ? 'wider' : 'even' }],
    ['make', 8, 'Card', { title: 'Wiring' }],
    ['make', 9, 'Graph', graphOf(
      [card('arm', 'arm', { status: { level: 'healthy', word: 'Fine' } }), card('hand', 'hand'), card('leg', 'leg', { icon: 'box' })],
      [{ from: 'arm', to: 'hand', label: 'holds' }, { from: 'arm', to: 'leg', style: 'dashed' }],
    )],
    ['make', 10, 'Card', { title: 'Mix' }],
    ['make', 11, 'Counts', { groups: [
      { title: 'Colours', rows: [{ value: 'red', count: 3 }, { value: 'blue', count: 1 }] },
      { title: 'Sizes', code: true, rows: [{ value: 's-1', count: 2 }, { value: 'm-2', count: 0 }] },
    ] }],
    ['put', 5, 6], ['put', 8, 9], ['put', 10, 11], ['put', 7, 8], ['put', 7, 10],
    ['put', 2, 3], ['put', 2, 4], ['put', 2, 5], ['put', 2, 7],
    ['put', 1, 2], ['put', 0, 1],
  ]
  let header = 'robot-1'
  listen((text) => {
    const said = JSON.parse(text)
    const page = said.open && said.open.page
    if (page === 'overview' || page === 'plain') commit(everything(page === 'overview'))
    else if (page) commit([['make', 1, 'Graph', BAD[page]], ['put', 0, 1]])
    else if (said.call) {
      header = said.call + ' ' + JSON.stringify(said.carries)
      commit([['change', 3, { name: header }]])
    }
  })
})
`

const body = (page: Page) => page.locator('[data-plugin-body]')
const go = (page: Page, id: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, `#/cluster/${CONTEXTS.demo}/plugins/parts/${id}`)

function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(folder, 'parts.yaml'), PARTS)
  writeFileSync(join(folder, 'parts.js'), CODE)
  return folder
}

test('every part a plugin’s page may name is drawn by Lumovi from what the door handed it, and tells the plugin what was pressed', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, 'overview')
  const drawn = body(page)
  // The split's list, the header, the tiles, a card's table, a pair of a graph and counts.
  await expect(drawn.getByRole('listbox', { name: 'Robots' })).toBeVisible()
  await expect(drawn.getByRole('heading', { name: 'robot-1' })).toBeVisible()
  await expect(drawn.getByRole('region', { name: 'Robots ready', exact: true })).toContainText(
    '1/2',
  )
  await expect(drawn.getByRole('region', { name: 'Still counting', exact: true })).toBeVisible()
  await expect(drawn.getByRole('region', { name: 'Parts', exact: true })).toContainText('two kinds')
  await expect(drawn.getByRole('region', { name: 'Wiring', exact: true })).toBeVisible()
  await expect(drawn.getByRole('region', { name: 'Mix', exact: true })).toContainText('red')
  // Each group shows two, with its own "Show all".
  await expect(drawn.getByRole('button', { name: 'Show all 3' })).toBeVisible()
  // The plugin is told what was pressed, and what was picked.
  // More than fit: the last two keep their places, and the rest are in its More menu.
  await drawn.getByRole('button', { name: 'More for robot-1' }).click()
  await page.getByRole('menuitem', { name: 'Look' }).click()
  await expect(drawn.getByRole('heading', { name: /^press / })).toContainText('look')
  await drawn.getByRole('option', { name: /^robot-2/ }).click()
  await expect(drawn.getByRole('heading', { name: /^pick / })).toContainText('r2')
})

test('the same parts with no handlers are drawn as well, and pressed tell the plugin nothing', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await go(page, 'plain')
  const drawn = body(page)
  await expect(drawn.getByRole('heading', { name: 'robot-1' })).toBeVisible()
  await expect(drawn.getByRole('region', { name: 'Wiring', exact: true })).toBeVisible()
  await drawn.getByRole('option', { name: /^robot-2/ }).click()
  await expect(drawn.getByRole('heading', { name: 'robot-1' })).toBeVisible()
})

test('a Graph its kinds can’t say stops the page, whole, in Lumovi’s words', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  let log = ''
  page.on('console', (message) => (log += `${message.text()}\n`))
  await openCluster(page)
  for (const [id, words] of Object.entries(REFUSED)) {
    await go(page, id)
    await expect(body(page), id).toContainText('It sent something a plugin can’t.')
    await expect(body(page).getByRole('region', { name: 'Wires' })).toHaveCount(0)
    // For whoever writes the plugin, what it was.
    await expect.poll(() => log, id).toContain(words)
  }
  expect(log).toContain('Lumovi stopped the plugin parts: ')
})
