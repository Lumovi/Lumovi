/** What a plugin that comes with Lumovi adds to its pages: pages of its own, a tab, commands. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { expect, hoverForTooltip, openCluster, panel, row, test } from './fixtures.ts'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Resources' })
const heading = (page: Page) => page.getByRole('heading', { level: 1 })
/** Where the door draws a plugin's page or tab. */
const body = (page: Page) => page.locator('[data-plugin-body]')
const address = (page: Page) => page.evaluate(() => decodeURIComponent(window.location.hash))
const go = (page: Page, to: string) =>
  page.evaluate((hash) => {
    window.location.hash = hash
  }, `#/cluster/demo/${to}`)

const plugin = (name: string, spec: string) =>
  `apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: ${name} }\nspec:\n  version: 1.2.0\n  needs: { lumovi: 1.0.0 }\n${spec}`

/**
 * Stand-ins for plugins that come with Lumovi, the only ones whose pages, tabs and commands are
 * taken: Toys, with two pages, a tab on its widgets and a command; Board, a page and nothing
 * else; Lab, whose kinds this cluster doesn't serve.
 */
const INCLUDED = {
  'toys.yaml': plugin(
    'toys',
    `  groups: [example.com]
  label: Toys
  kinds: [{ group: example.com, kind: Widget }, { group: example.com, kind: Database }]
  pages:
    - { id: overview, title: Overview }
    - { id: capacity, title: Capacity }
  tabs:
    - { id: parts, title: Parts, kinds: [{ group: example.com, kind: Widget }] }
  commands:
    - { name: Open the toys’ capacity, page: capacity }
`,
  ),
  'board.yaml': plugin(
    'board',
    '  groups: [example.com]\n  label: Board\n  pages: [{ id: today, title: Today }]\n',
  ),
  'lab.yaml': plugin(
    'lab',
    '  groups: [lab.example.com]\n  label: Lab\n  kinds: [{ group: lab.example.com, kind: Beaker }]\n  pages: [{ id: bench, title: Bench }]\n',
  ),
}

function included(): string {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  for (const [name, text] of Object.entries(INCLUDED)) writeFileSync(join(folder, name), text)
  return folder
}

/** A file of one's own by Toys' name: in use in place of Lumovi's, and adding nothing. */
const OWN_TOYS = plugin(
  'toys',
  '  groups: [example.com]\n  label: Toys\n  kinds: [{ group: example.com, kind: Widget }]\n',
)

test('a plugin’s own pages: its entry opens the first, each a tab marked as the plugin’s', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  const nav = sidebar(page)
  const toys = nav.getByRole('link', { name: 'Toys', exact: true })
  await toys.click()
  await expect(heading(page)).toHaveText('Toys')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins/toys/overview')
  // Its pages first, in its file's order, then its kinds' lists.
  const tabs = page.getByRole('navigation', { name: 'Toys' })
  await expect(tabs.getByRole('link')).toHaveText([
    'Overview',
    'Capacity',
    /^(Widgets|Databases)/,
    /^(Widgets|Databases)/,
  ])
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  await expect(body(page).getByTestId('plugin-whose')).toHaveText(
    'This page is from the plugin Toys 1.2.0. Lumovi draws it from its own parts; what it shows and says is the plugin’s.\nWhat it may do →',
    { useInnerText: true },
  )
  // What it may do: its entry on the Plugins page, open.
  await expect(body(page).getByRole('link', { name: 'What it may do →' })).toHaveAttribute(
    'href',
    '#/cluster/demo/plugins?plugin=toys',
  )
  // (Toys comes with no code of its own: its page says so, in its place.)
  await expect(body(page).getByTestId('plugin-ended')).toContainText(
    'Its code isn’t part of this Lumovi.',
  )
  // Each page's tab says whose it is.
  const capacity = tabs.getByRole('link', { name: 'Capacity' })
  await hoverForTooltip(capacity, 'From the plugin Toys 1.2.0')
  await capacity.click()
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins/toys/capacity')
  await expect(capacity).toHaveAttribute('aria-current', 'page')
  await expect(body(page).getByTestId('plugin-whose')).toContainText('Toys 1.2.0')
  await expect(toys).toHaveClass(/font-medium/)
  // A kind's list keeps the strip, the pages and all, and the entry stays current.
  await tabs.getByRole('link', { name: /^Widgets/ }).click()
  await expect(heading(page)).toHaveText('Widgets')
  await expect(tabs.getByRole('link', { name: 'Overview' })).toBeVisible()
  await expect(toys).toHaveClass(/font-medium/)

  // An address to a page it doesn't have: Lumovi's "no such page", with the way to its first.
  await go(page, 'plugins/toys/history')
  await expect(page.getByText('Toys has no such page.')).toBeVisible()
  await expect(
    page.getByText(
      'Toys 1.2.0 has no page at this address. A link made with another version of it can name a page this one doesn’t have.',
    ),
  ).toBeVisible()
  await expect(tabs.locator('[aria-current="page"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Open Toys' }).click()
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins/toys/overview')
  // The plugin's own address is its first page.
  await go(page, 'plugins/toys')
  await expect(body(page).getByTestId('plugin-whose')).toContainText('Toys 1.2.0')
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')

  // And of one that has no pages at all: the same, and the way to its page of its kinds.
  await go(page, 'plugins/flux/overview')
  await expect(page.getByText('Flux has no such page.')).toBeVisible()
  await page.getByRole('button', { name: 'Open Flux' }).click()
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins/flux')
  await expect(page.getByRole('navigation', { name: 'Flux' })).toBeVisible()

  // A page and nothing else: no strip, the page under the title.
  await nav.getByRole('link', { name: 'Board', exact: true }).click()
  await expect(heading(page)).toHaveText('Board')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins/board/today')
  await expect(body(page).getByTestId('plugin-whose')).toContainText('Board 1.2.0')
  await expect(page.getByRole('navigation', { name: 'Board' })).toHaveCount(0)
  // One whose kinds aren't here: no entry, and its page's address says why there's nothing.
  await expect(nav.getByRole('link', { name: 'Lab', exact: true })).toHaveCount(0)
  await go(page, 'plugins/lab/bench')
  await expect(page.getByText('Lab isn’t in use here.')).toBeVisible()
  await expect(body(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Go to Plugins' }).click()
  await expect(heading(page)).toHaveText('Plugins')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins?plugin=lab')
  // (Lab's entry shown first: the page has settled on the address it was sent to before the next
  // is set. Set while it's still opening, the next address can be undone by it.)
  const adds = page.getByRole('region', { name: 'Adds to Lumovi’s pages' })
  await expect(adds).toContainText('The page Bench')

  // The Plugins page says what each adds, by the names its file gives them; and, once it has
  // asked, that its pages don't run, since this one has no code.
  await go(page, 'plugins?plugin=toys')
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins?plugin=toys')
  const notRun = 'Its pages don’t run here: its code isn’t part of this Lumovi.'
  await expect(adds.getByTestId('plugin-not-handed')).toHaveText(notRun)
  await expect(adds).toContainText(
    `Adds 2 pages, a tab on Widgets and a command to the palette.${notRun}The page OverviewThe page CapacityThe tab Parts, on WidgetsThe command Open the toys’ capacity`,
  )
})

test('a plugin’s tab on an object of its kinds, after Lumovi’s own, and commands that open its pages', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included() } })
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'Toys', exact: true }).click()
  const tabs = page.getByRole('navigation', { name: 'Toys' })
  await tabs.getByRole('link', { name: /^Widgets/ }).click()
  await row(page, 'Widgets', CUSTOM.widget).getByRole('gridcell').nth(1).click()
  const widget = panel(page, 'Widget', CUSTOM.widget)
  // After Lumovi's own tabs, and before YAML, which stays last.
  await expect(widget.getByRole('tab').last()).toHaveText('YAML')
  const names = await widget.getByRole('tab').allTextContents()
  expect(names.slice(-3)).toEqual(['Audit', 'Parts', 'YAML'])
  const parts = widget.getByRole('tab', { name: 'Parts' })
  await hoverForTooltip(parts, 'From the plugin Toys 1.2.0')
  await parts.click()
  await expect(widget.locator('[data-plugin-body]').getByTestId('plugin-whose')).toContainText(
    'Toys 1.2.0',
  )
  await expect(widget.locator('[data-plugin-body]').getByTestId('plugin-ended')).toContainText(
    'Its code isn’t part of this Lumovi.',
  )
  await page.keyboard.press('Escape')
  // Only on the kinds it names.
  await tabs.getByRole('link', { name: /^Databases/ }).click()
  await row(page, 'Databases', 'orders').getByRole('gridcell').nth(1).click()
  const orders = panel(page, 'Database', 'orders')
  await expect(orders.getByRole('tab', { name: 'YAML' })).toBeVisible()
  await expect(orders.getByRole('tab', { name: 'Parts' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // A command, in the palette's group of them, says whose it is and only opens its page.
  const changes = () => clusters.demo.requests.filter(({ method }) => method !== 'GET').length
  const before = changes()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('capacity')
  const command = page.getByRole('option', { name: /^Open the toys’ capacity/ })
  await expect(command).toContainText('Toys')
  await expect(
    page.locator('[cmdk-group]').filter({ has: page.getByText('From plugins', { exact: true }) }),
  ).toContainText('Open the toys’ capacity')
  await command.click()
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins/toys/capacity')
  await expect(
    page.getByRole('navigation', { name: 'Toys' }).getByRole('link', { name: 'Capacity' }),
  ).toHaveAttribute('aria-current', 'page')
  expect(changes()).toBe(before)
})

test('a plugin taken away while its page or its tab is open: each says so, where it was', async ({
  launch,
}) => {
  const folder = included()
  const { page, userDataDir } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  const own = join(userDataDir, 'plugins')
  mkdirSync(own, { recursive: true })
  const refresh = () => page.getByRole('button', { name: /^Refresh/ }).click()
  await openCluster(page)
  await sidebar(page).getByRole('link', { name: 'Toys', exact: true }).click()
  const tabs = page.getByRole('navigation', { name: 'Toys' })
  await tabs.getByRole('link', { name: 'Capacity' }).click()
  await expect(tabs.getByRole('link', { name: 'Capacity' })).toHaveAttribute('aria-current', 'page')

  // Gone: its entry, its tabs and its commands go at once; the open page stays, and says so.
  rmSync(join(folder, 'toys.yaml'))
  await refresh()
  await expect(page.getByText('Toys isn’t in use any more.')).toBeVisible()
  await expect(
    page.getByText(
      'Its pages, its tabs and its commands were taken away while this was open. Plugins says why.',
    ),
  ).toBeVisible()
  await expect(body(page)).toHaveCount(0)
  await expect(heading(page)).toHaveText('Toys')
  await expect(page.getByRole('navigation', { name: 'Toys' })).toHaveCount(0)
  await expect(sidebar(page).getByRole('link', { name: 'Toys', exact: true })).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox').fill('capacity')
  await expect(page.getByRole('option', { name: /^Open the toys’ capacity/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // And the way to Plugins, which says why.
  await page.getByRole('button', { name: 'Go to Plugins' }).click()
  await expect.poll(() => address(page)).toBe('#/cluster/demo/plugins?plugin=toys')
  await expect(heading(page)).toHaveText('Plugins')

  // Back again, its pages are back.
  writeFileSync(join(folder, 'toys.yaml'), INCLUDED['toys.yaml'])
  await refresh()
  await sidebar(page).getByRole('link', { name: 'Toys', exact: true }).click()
  await expect(body(page).getByTestId('plugin-whose')).toContainText('Toys 1.2.0')
  // One's own file of its name, in use in its place, takes its pages away too: the page says so,
  // and the entry is that one's, leading to its page of its kinds.
  writeFileSync(join(own, 'toys.yaml'), OWN_TOYS)
  await refresh()
  await expect(page.getByText('Toys isn’t in use any more.')).toBeVisible()
  await expect(sidebar(page).getByRole('link', { name: 'Toys', exact: true })).toHaveAttribute(
    'href',
    /\/plugins\/toys$/,
  )

  // Then a tab of it, open on a widget, when it goes.
  rmSync(join(own, 'toys.yaml'))
  await refresh()
  await sidebar(page).getByRole('link', { name: 'Toys', exact: true }).click()
  await expect(body(page).getByTestId('plugin-whose')).toContainText('Toys 1.2.0')
  await tabs.getByRole('link', { name: /^Widgets/ }).click()
  await row(page, 'Widgets', CUSTOM.widget).getByRole('gridcell').nth(1).click()
  const widget = panel(page, 'Widget', CUSTOM.widget)
  await widget.getByRole('tab', { name: 'Parts' }).click()
  await expect(widget.locator('[data-plugin-body]')).toBeVisible()
  writeFileSync(join(own, 'toys.yaml'), OWN_TOYS)
  await refresh()
  await expect(widget.getByText('Toys isn’t in use any more.')).toBeVisible()
  await expect(widget.getByRole('tab', { name: 'Parts' })).toHaveAttribute('aria-selected', 'true')
  await expect(widget.locator('[data-plugin-body]')).toHaveCount(0)
  // Once another tab is chosen, it's gone.
  await widget.getByRole('tab', { name: 'Overview' }).click()
  await expect(widget.getByRole('tab', { name: 'Parts' })).toHaveCount(0)
})
