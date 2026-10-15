/**
 * A plugin's page that is one Table is drawn as Lumovi's own lists are (kit/list-page.ts): its
 * bar with how many there are, the levels' chips and the filter; its headings' band; its rows,
 * square, one under another; and its pages.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { placed } from '../placed.ts'
import { expect, openCluster, test } from './fixtures.ts'

const LEVELS = ['critical', 'healthy', 'healthy', 'progressing'] as const
const WORDS = { critical: 'Degraded', healthy: 'Healthy', progressing: 'Progressing' } as const

/** A plugin whose one page lists 120 apps, each with its level and where it deploys to. */
function listing(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(
    join(folder, 'apps.yaml'),
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: apps }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Apps
  kinds: [{ group: example.com, kind: Widget }]
  pages:
    - { id: apps, title: Apps }
`,
  )
  const rows = Array.from({ length: 120 }, (_, n) => {
    const level = LEVELS[n % LEVELS.length]!
    const name = `app-${String(n + 1).padStart(3, '0')}`
    return {
      key: name,
      lead: { level, name, under: 'default' },
      facets: [{ filter: 'project', value: n % 2 ? 'shop' : 'batch' }],
      cells: [
        { kind: 'status', level, word: WORDS[level] },
        { kind: 'text', text: `in-cluster · ${n % 2 ? 'shop' : 'batch'}` },
      ],
    }
  })
  const table = {
    title: 'Apps',
    headings: true,
    nameSorts: true,
    filters: [{ key: 'project', name: 'Project' }],
    search: true,
    columns: [
      { name: 'Health', kind: 'status' },
      { name: 'Deploys to', kind: 'text' },
    ],
    rows,
  }
  writeFileSync(
    join(folder, 'apps.js'),
    `box.then(({ post, listen }) => {
  listen((text) => {
    if (JSON.parse(text).open) post(JSON.stringify({ commit: [['make', 1, 'Table', ${JSON.stringify(table)}], ['put', 0, 1]] }))
  })
})
`,
  )
  return folder
}

async function opened(launch: (options?: object) => Promise<{ page: Page }>) {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: listing() } })
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/apps/apps'
  })
  await expect(page.getByRole('grid', { name: 'Apps' })).toBeVisible()
  return page
}

test('a page that is one table is a list: its bar, its headings, square rows, its pages', async ({
  launch,
}) => {
  const page = await opened(launch)
  const bar = page.getByRole('group', { name: 'Filters' })
  await expect(bar).toContainText('120 items')
  // The levels' chips, with how many: the plugin's filters in one menu after them.
  await expect(bar.getByRole('button', { name: 'Failing 30' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Healthy 60' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'More filters' })).toBeVisible()
  await expect(bar.getByPlaceholder('Filter Apps')).toBeVisible()
  // With room for them all, the chips are on the field's row.
  const field = await placed(bar.getByPlaceholder('Filter Apps').locator('..'))
  const chip = await placed(bar.getByRole('button', { name: 'More filters' }))
  expect(chip.y + chip.height / 2).toBeGreaterThan(field.y)
  expect(chip.y + chip.height / 2).toBeLessThan(field.y + field.height)
  // No card round it, and no title of its own: the page is the list.
  await expect(page.getByRole('heading', { name: 'Apps', level: 3 })).toHaveCount(0)

  const grid = page.getByRole('grid', { name: 'Apps' })
  const heading = grid.getByRole('columnheader', { name: 'Health' })
  // (In CSS pixels, rounded: a window zoomed to fit its screen, as on Linux, draws 36 as 35.98.)
  expect(Math.round(await heading.evaluate((cell) => cell.getBoundingClientRect().height))).toBe(36)
  const row = grid.getByRole('row').filter({ hasText: 'app-001' })
  const drawn = await row.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      height: Math.round(element.getBoundingClientRect().height),
      radius: style.borderTopLeftRadius,
      divider: Math.round(parseFloat(style.borderBottomWidth)),
    }
  })
  expect(drawn).toEqual({ height: 46, radius: '0px', divider: 1 })
  // Its status says its level: no dot before its name.
  await expect(row.locator('[data-health]')).toHaveText('Degraded')
  await expect(row.getByRole('gridcell').first().locator('.rounded-full')).toHaveCount(0)

  // A hundred to a page, as Lumovi's lists have them.
  const pages = page.getByRole('navigation', { name: 'Pagination' })
  await expect(pages).toContainText('1–100 of 120')
  await expect(grid.getByRole('row').filter({ hasText: 'app-101' })).toHaveCount(0)
  await pages.getByRole('button', { name: 'Next page' }).click()
  await expect(pages).toContainText('101–120 of 120')
  await expect(grid.getByRole('row').filter({ hasText: 'app-101' })).toBeVisible()
})

test('a list’s chips and filter keep rows as Lumovi’s do, and nothing kept says so in its words', async ({
  launch,
}) => {
  const page = await opened(launch)
  const bar = page.getByRole('group', { name: 'Filters' })
  const grid = page.getByRole('grid', { name: 'Apps' })
  await bar.getByRole('button', { name: 'Failing 30' }).click()
  await expect(bar.getByRole('button', { name: 'Failing 30' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('navigation', { name: 'Pagination' })).toContainText('1–30 of 30')
  await expect(grid.getByRole('row').filter({ hasText: 'app-002' })).toHaveCount(0)
  await bar.getByPlaceholder('Filter Apps').fill('app-002')
  await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible()
  await expect(page.getByText('No Apps match the current filters.')).toBeVisible()
})

/**
 * A plugin whose one page lists 30 apps with a button each, and says in its table's title every
 * message it has heard: what its bar's chips, menu and field do is never one of them.
 */
function listening(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(
    join(folder, 'apps.yaml'),
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: apps }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Apps
  kinds: [{ group: example.com, kind: Widget }]
  pages:
    - { id: apps, title: Apps }
`,
  )
  const rows = Array.from({ length: 30 }, (_, n) => {
    const level = LEVELS[n % LEVELS.length]!
    const name = `app-${String(n + 1).padStart(3, '0')}`
    return {
      key: name,
      lead: { name },
      facets: [{ filter: 'project', value: n % 2 ? 'shop' : 'batch' }],
      cells: [
        { kind: 'status', level, word: WORDS[level] },
        { kind: 'button', key: 'poke', name: 'Poke' },
      ],
    }
  })
  writeFileSync(
    join(folder, 'apps.js'),
    `box.then(({ post, listen }) => {
  const heard = []
  const table = () => ({
    title: 'Apps, heard ' + heard.join(' '),
    headings: true,
    filters: [{ key: 'project', name: 'Project' }],
    search: true,
    columns: [{ name: 'Health', kind: 'status' }, { name: 'Do', kind: 'button' }],
    rows: ${JSON.stringify(rows)},
    onPress: 'poke',
  })
  let made = false
  listen((text) => {
    const said = JSON.parse(text)
    heard.push(said.open ? 'open' : said.call ? said.call : Object.keys(said).join('+'))
    post(JSON.stringify({ commit: made ? [['change', 1, table()]] : [['make', 1, 'Table', table()], ['put', 0, 1]] }))
    made = true
  })
})
`,
  )
  return folder
}

test('nothing chosen or typed in a list’s bar reaches its plugin; a row’s button does', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: listening() } })
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/apps/apps'
  })
  const grid = page.getByRole('grid', { name: /^Apps, heard/ })
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open')
  const bar = page.getByRole('group', { name: 'Filters' })
  // A while with nothing pressed: what it's told of itself, no more (a page with no reads has
  // nothing read again).
  // eslint-disable-next-line no-restricted-syntax -- what isn't sent can only be waited for
  await page.waitForTimeout(6_000)
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open')
  // A level's chip, a filter of its own, the field: each keeps rows, and tells it nothing, at
  // once or after.
  await bar.getByRole('button', { name: 'Failing 8' }).click()
  await expect(grid.getByRole('row').filter({ hasText: 'app-002' })).toHaveCount(0)
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open')
  await bar.getByRole('button', { name: 'More filters' }).click()
  await page.getByRole('menuitemcheckbox', { name: /^batch/ }).click()
  await page.keyboard.press('Escape')
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open')
  await bar.getByPlaceholder(/^Filter Apps/).fill('app-0')
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open')
  // eslint-disable-next-line no-restricted-syntax -- what isn't sent can only be waited for
  await page.waitForTimeout(6_000)
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open')
  // And the same plugin hears a row's button: what it's told is what it should be.
  await bar.getByPlaceholder(/^Filter Apps/).fill('')
  await bar.getByRole('button', { name: 'Failing 8' }).click()
  await grid
    .getByRole('row')
    .filter({ hasText: 'app-001' })
    .getByRole('button', { name: 'Poke' })
    .click()
  await expect(grid).toHaveAttribute('aria-label', 'Apps, heard open poke')
})

type Box = { x: number; y: number; width: number; height: number }

/** Two boxes share no pixel. */
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

test('beside a row’s panel at 1024, a list’s chips take a row of their own under its filter, and nothing in its bar covers another', async ({
  launch,
}) => {
  // (A real 1024 window: Argo CD's Applications, payments' panel open, leave the list under 300 px.)
  const { page } = await launch({ env: { LUMOVI_E2E_WINDOW: '1024x768' }, fullLayout: false })
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/plugins/argo-cd/applications'
  })
  const applications = page.getByRole('grid', { name: 'Applications' })
  await applications.getByRole('row').filter({ hasText: 'payments' }).first().click()
  await page.waitForFunction(() => window.location.hash.includes('open='))
  const bar = page.getByRole('group', { name: 'Filters' })
  // That narrow, the field says "Filter" alone, without its key, as Lumovi's lists' do; its name
  // is whole.
  const input = bar.getByRole('textbox', { name: 'Filter Applications' })
  await expect(input).toHaveAttribute('placeholder', 'Filter')
  await expect(input.locator('..')).not.toContainText('/')
  // (The field as drawn: its box, and the icon in it.)
  const field = await placed(input.locator('..'))
  const chips = bar.getByRole('button', {
    name: /^(Failing|In progress|Healthy) \d+$|^More filters$/,
  })
  await expect(chips).toHaveCount(4)
  const whole = await placed(bar)
  // The field keeps its least, the room to type in.
  expect(Math.round(field.width)).toBeGreaterThanOrEqual(128)
  for (const chip of await chips.all()) {
    const box = await placed(chip)
    // Under the field, clear of it, and in the bar: none past its edge, into the panel.
    expect(box.y).toBeGreaterThanOrEqual(field.y + field.height)
    expect(apart(box, field)).toBe(true)
    expect(box.x + box.width).toBeLessThanOrEqual(whole.x + whole.width)
    // Each whole, its words not cut.
    expect(await chip.evaluate((drawn) => drawn.scrollWidth <= drawn.clientWidth)).toBe(true)
  }
})
