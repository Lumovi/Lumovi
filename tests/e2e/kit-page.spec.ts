/**
 * A page's frame from the kit, on the page the tests' build has for the kit's parts: the pick
 * list, the header that names what's picked, tiles, and the three arrangements that hold them.
 */
import type { Page } from '@playwright/test'
import { expect, openCluster, test } from './fixtures.ts'

const LONGEST = 'checkout-payments-reconciliation-ledger-archive-eu-west1-main-db'

async function frame(page: Page) {
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/kit/frame'
  })
  await expect(page.getByRole('listbox', { name: 'Clusters' })).toBeVisible()
}

const pressed = (page: Page) => page.getByRole('list', { name: 'What was pressed' })

test('a pick list: one row is always picked, the worst first, and the keys pick', async ({
  page,
}) => {
  await frame(page)
  const list = page.getByRole('listbox', { name: 'Clusters' })
  const side = page.getByRole('region', { name: 'Clusters list' })
  // The card says what's listed and how many; past twelve rows there's a filter above them.
  await expect(side).toContainText('38')
  await expect(list.getByRole('option')).toHaveCount(38)
  await expect(side.getByPlaceholder('Filter clusters')).toBeVisible()
  // The worst is first, and it's the one that's picked as the page opens; the rest of the page
  // names it.
  const picked = list.getByRole('option', { selected: true })
  await expect(picked).toHaveCount(1)
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await expect(picked).toContainText('Unrecoverable')
  await expect(page.getByRole('group', { name: LONGEST })).toBeVisible()
  // Why, where the plugin says: a line under its name and word, whole in its tooltip.
  const why = page.getByRole('group', { name: LONGEST }).getByRole('paragraph')
  await expect(why).toHaveText('No instance can be promoted: all three lost their storage')
  await expect(why).toHaveAttribute(
    'title',
    'No instance can be promoted: all three lost their storage',
  )
  // A moment in a tile is Lumovi's to say: how long ago, never the plugin's words.
  await expect(page.getByRole('region', { name: 'Last backup', exact: true })).toContainText(
    /3h\d+m/,
  )
  // Its name loses its middle and keeps its end; its status is never cut.
  await expect(picked.locator('[title] [aria-hidden]')).toHaveText(/^check\S*…ain-db$/)
  const fits = await picked
    .locator('[data-health]')
    .evaluate((pill) => pill.scrollWidth <= pill.clientWidth)
  expect(fits).toBe(true)
  // Then by how bad: a warning, what's in progress, and the healthy as they were given.
  await expect(list.getByRole('option').nth(1)).toContainText('orders-db')
  await expect(list.getByRole('option').nth(2)).toContainText('sessions-db')
  await expect(list.getByRole('option').nth(3)).toContainText('payments-db')

  // One stop: the keys move an active row, and nothing is picked until Enter or Space.
  const active = () =>
    list.evaluate(
      (box) =>
        document.getElementById(box.getAttribute('aria-activedescendant') ?? '')?.textContent,
    )
  await list.focus()
  await page.keyboard.press('ArrowDown')
  await expect.poll(active).toContain('orders-db')
  await page.keyboard.press('ArrowDown')
  await expect.poll(active).toContain('sessions-db')
  await page.keyboard.press('ArrowUp')
  await expect.poll(active).toContain('orders-db')
  await expect(picked).toContainText('Unrecoverable')
  await expect(pressed(page).getByRole('listitem')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(picked).toContainText('orders-db')
  await expect(pressed(page)).toContainText('pick {"row":"shop/orders-db"}')
  await expect(page.getByRole('group', { name: 'orders-db' })).toContainText('Not all ready')
  await page.keyboard.press('End')
  await expect.poll(active).toContain('search-db-33')
  await page.keyboard.press('Space')
  await expect(picked).toContainText('search-db-33')
  // (It's kept in view, at the end of a list that scrolls inside its side.)
  await expect(picked).toBeInViewport()
  await page.keyboard.press('Home')
  await expect.poll(active).toContain(LONGEST)
  // Picking what's picked says nothing again; a click picks as the keys do.
  const picks = await pressed(page).getByRole('listitem').count()
  await list.getByRole('option').filter({ hasText: 'search-db-33' }).click()
  await expect(pressed(page).getByRole('listitem')).toHaveCount(picks)
  await list.getByRole('option').filter({ hasText: 'payments-db' }).click()
  await expect(picked).toContainText('payments-db')

  // The filter narrows the rows; what's picked stays picked, shown or not.
  await side.getByPlaceholder('Filter clusters').fill('search-db-0')
  await expect(list.getByRole('option')).toHaveCount(9)
  await expect(page.getByRole('group', { name: 'payments-db' })).toBeVisible()
  await side.getByPlaceholder('Filter clusters').fill('no such cluster')
  await expect(side).toContainText('No clusters match “no such cluster”.')
})

test('a pick list as it’s given, with one row, and with none', async ({ page }) => {
  await frame(page)
  const which = page.getByRole('group', { name: 'Which list' })
  const list = page.getByRole('listbox', { name: 'Clusters' })
  // Its rows stand as given where it says so, and the row it names is the one picked.
  await which.getByRole('button', { name: '5 clusters, as given' }).click()
  await expect(list.getByRole('option').first()).toContainText('payments-db')
  await expect(list.getByRole('option', { selected: true })).toContainText('orders-db')
  await expect(page.getByPlaceholder('Filter clusters')).toHaveCount(0)
  // A list whose picked row is gone (the cluster changed under it) takes its first.
  await which.getByRole('button', { name: 'One cluster' }).click()
  await expect(list.getByRole('option')).toHaveCount(1)
  await expect(list.getByRole('option', { selected: true })).toContainText('payments-db')
  // With nothing to list it says so, as a table does, and the rest of the page shows nothing.
  await which.getByRole('button', { name: 'No clusters' }).click()
  await expect(page.getByRole('region', { name: 'Clusters list' })).toContainText(
    'Nothing in demo has one yet.',
  )
  await expect(page.getByRole('group', { name: /-db$/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Instances ready' })).toHaveCount(0)
})

test('the header: a name that gives way, and at most three buttons with the rest behind “…”', async ({
  page,
}) => {
  await frame(page)
  const list = page.getByRole('listbox', { name: 'Clusters' })
  // Five actions: the filled one last, the one before it, and "…" between them with the rest.
  const long = page.getByRole('group', { name: LONGEST })
  await expect(long.getByRole('button')).toHaveText(['Switch over…', '', 'Back up now…'])
  // The name is cut in its middle; the status and the buttons are whole, on one line.
  await expect(long.getByRole('heading').locator('[aria-hidden]')).toHaveText(/…ain-db$/)
  const tops = await long
    .locator('h2, [data-health], button')
    .evaluateAll((parts) => parts.map((part) => Math.round(part.getBoundingClientRect().height)))
  expect(Math.max(...tops)).toBeLessThanOrEqual(32)
  await long.getByRole('button', { name: `More for ${LONGEST}` }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Show logs', 'Hibernate…', 'Restart…'])
  await page.getByRole('menuitem', { name: 'Restart…' }).click()
  await expect(pressed(page)).toContainText('press {"button":"restart"}')
  await long.getByRole('button', { name: 'Back up now…' }).click()
  await expect(pressed(page)).toContainText('press {"button":"backup"}')
  // Three: all of them, and no "…". One: it alone.
  await list.getByRole('option').filter({ hasText: 'orders-db' }).click()
  await expect(page.getByRole('group', { name: 'orders-db' }).getByRole('button')).toHaveText([
    'Restart…',
    'Switch over…',
    'Back up now…',
  ])
  await list.getByRole('option').filter({ hasText: 'reports-db' }).click()
  await expect(page.getByRole('group', { name: 'reports-db' }).getByRole('button')).toHaveText([
    'Back up now…',
  ])
})

test('tiles: equal in a row, a value in figures or in words, and one that opens', async ({
  page,
}) => {
  await frame(page)
  // Four in a row, of one width and one height, whatever each holds.
  const row = ['Instances ready', 'Primary', 'Last backup', 'Version'].map((name) =>
    page.getByRole('region', { name, exact: true }).first(),
  )
  const boxes = await Promise.all(
    row.map((tile) =>
      tile.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return [Math.round(box.width), Math.round(box.height), Math.round(box.top)]
      }),
    ),
  )
  expect(new Set(boxes.map((box) => box.join(','))).size).toBe(1)
  // One that opens something is a button; Lumovi opens the list, and its describer is told.
  await row[0]!.getByRole('button').click()
  await expect(pressed(page)).toContainText(
    'go {"to":"list","kind":"Pod","labels":["cnpg.io/cluster"]}',
  )
  await expect(pressed(page)).toContainText('open {"tile":"ready"}')
  await expect(row[2]!.getByRole('button')).toHaveCount(0)
  // A value in words is set smaller on the same line and loses its middle; a long label and a
  // long line under are cut at their ends, and none of it makes a tile taller than its row.
  const words = page.getByRole('region', { name: 'Primary', exact: true }).last()
  await expect(words.locator('[title] [aria-hidden]')).toHaveText(/…n-db-1$/)
  const storage = page.getByRole('region', { name: /^Storage for each instance/ })
  const heights = await Promise.all(
    [words, storage, page.getByRole('region', { name: 'Auto-sync' })].map((tile) =>
      tile.evaluate((el) => Math.round(el.getBoundingClientRect().height)),
    ),
  )
  expect(new Set([...heights, boxes[0]![1]]).size).toBe(1)
  for (const cut of [
    storage.getByText(/^Storage for each instance/),
    storage.getByText(/^of 2 TiB/),
  ]) {
    expect(
      // (Cut by what holds the plugin's text: the text itself runs on inside it.)
      await cut.evaluate((el) => {
        const holder = el.parentElement!
        const style = getComputedStyle(holder)
        return [style.textOverflow, style.whiteSpace, holder.getClientRects().length]
      }),
    ).toEqual(['ellipsis', 'nowrap', 1])
  }
  // A figure longer than its tile is kept in it: it never runs over its neighbour.
  const [long, beside] = await Promise.all(
    ['Requests', 'Errors'].map((name) =>
      page.getByRole('region', { name, exact: true }).evaluate((el) => {
        const box = el.getBoundingClientRect()
        const figure = el.querySelector('.text-\\[28px\\]')!.getBoundingClientRect()
        return { left: box.left, right: box.right, figureRight: figure.right, height: box.height }
      }),
    ),
  )
  expect(long!.figureRight).toBeLessThanOrEqual(long!.right)
  expect(long!.right).toBeLessThanOrEqual(beside!.left)
  expect(long!.height).toBe(beside!.height)
  // The split: a side of 300 px, then the rest.
  const side = await page
    .getByRole('region', { name: 'Clusters list' })
    .evaluate((el) => Math.round(el.getBoundingClientRect().width))
  expect(side).toBe(300)
})

test('a tile still reading keeps its value’s space, and one counted from a cut read says so in Lumovi’s words', async ({
  page,
}) => {
  await frame(page)
  const reading = page.getByRole('region', { name: 'Still reading', exact: true })
  const waiting = page.getByRole('region', { name: 'Pods waiting', exact: true })
  // No value: its icon and label, the value's space kept (no dash, no "…"), as tall as its row.
  await expect(reading).not.toContainText('—')
  await expect(reading).not.toContainText('…')
  const [still, cut] = await Promise.all(
    [reading, waiting].map((tile) =>
      tile.evaluate((el) => Math.round(el.getBoundingClientRect().height)),
    ),
  )
  expect(still).toBe(cut)
  // Counted from a cut read: the plugin's figure and a "+", said "or more"; the line under is
  // Lumovi's, never the plugin's.
  await expect(waiting.locator('[aria-hidden]').filter({ hasText: '+' })).toHaveText('4,980+')
  await expect(waiting.getByText('4,980 or more', { exact: true })).toHaveClass(/sr-only/)
  await expect(waiting).toContainText('Counted from the first 5,000 Lumovi read.')
  await expect(waiting).not.toContainText('The plugin’s own line')
  // (Not a level: the line has no dot, whatever the plugin's level.)
  await expect(waiting.locator('[data-health], .rounded-full')).toHaveCount(0)
})

test('a table still reading in a card is drawn bare: the card says its title, once', async ({
  page,
}) => {
  await frame(page)
  const card = page.getByRole('region', { name: 'Disruption', exact: true })
  await expect(card.getByText('Disruption', { exact: true })).toHaveCount(1)
  await expect(card.getByRole('heading')).toHaveCount(1)
})

test('what a part of a page is refused for: its kinds first, then what they can’t say', async ({
  page,
}) => {
  await frame(page)
  await expect(
    page.getByRole('list', { name: 'What a part is refused for' }).getByRole('listitem'),
  ).toHaveText([
    'Nothing: it can be drawn.',
    'A row of tiles has 1 tile; it takes 2 to 4.',
    // (More than a row holds is its list's kind to refuse, as the door says it.)
    'Tiles.tiles: is longer than 4',
    'Tiles 1 and 2 of a row have the same key.',
    'Tiles 2 and 3 of a row have the same key.',
    'Tiles.tiles[1].value.kind: should be one of figure, words, time',
    'Nothing: it can be drawn.',
    'Nothing: it can be drawn.',
    'Header buttons 1 and 2 have the same key.',
    'Nothing: it can be drawn.',
    'Pick list rows 1 and 2 have the same key.',
    // (A picked row that isn't one of the rows is the cluster changing, not a fault.)
    'Nothing: it can be drawn.',
  ])
})

test('Karpenter’s overview from the frame’s parts: a card, a pair of cards seven to five, and counts as shares of a whole', async ({
  page,
}) => {
  await frame(page)
  const overview = page.getByRole('region', { name: 'Karpenter’s overview' })
  await overview.scrollIntoViewIfNeeded()
  await expect(overview.getByRole('region', { name: 'Being replaced' })).toBeVisible()
  // A card is Lumovi's: the plugin's title, its note at the right, and its table inside, with no
  // frame or heading of its own.
  const nodes = overview.getByRole('region', { name: 'Nodes', exact: true })
  await expect(nodes.locator('header')).toContainText('20 · 3 still starting')
  await expect(nodes.locator('h3')).toHaveCount(0)
  // A pair: the first seven parts of twelve, the second five, side by side.
  const mix = overview.getByRole('region', { name: 'Node mix' })
  const box = async (region: typeof mix) => (await region.boundingBox()) ?? { x: 0, y: 0, width: 0 }
  await expect
    .poll(async () => {
      const [a, b] = [await box(nodes), await box(mix)]
      return a.y === b.y && Math.round((a.width / b.width) * 100) / 100
    })
    .toBe(1.4)
  // Counts: each group's values the largest first, with a bar of its share of the group's whole.
  const zones = mix.getByRole('region', { name: 'Zones' })
  await expect(zones.getByRole('listitem')).toHaveCount(5)
  await expect(zones.getByRole('listitem').first()).toContainText('eu-central-1a6 of 20')
  await expect(zones.getByRole('listitem').nth(1)).toContainText('eu-central-1b')
  const types = mix.getByRole('region', { name: 'Instance types' })
  const share = (row: number, group = types) =>
    group
      .getByRole('listitem')
      .nth(row)
      .locator('[data-bar] > span')
      .evaluate((bar) => Math.round((bar.clientWidth / bar.parentElement!.clientWidth) * 100))
  await expect.poll(() => share(0)).toBe(35)
  // None is no bar at all; the smallest share there is, a dot.
  const capacity = mix.getByRole('region', { name: 'Capacity types' })
  await expect(capacity.getByRole('listitem').last()).toContainText('Reserved')
  await expect.poll(() => share(2, capacity)).toBe(0)
  await expect.poll(() => share(3)).toBe(5)
  // Values that are code are set as code; words aren't.
  const font = (group: string) =>
    mix
      .getByRole('region', { name: group })
      .getByRole('listitem')
      .first()
      .locator('span')
      .first()
      .evaluate((value) => getComputedStyle(value).fontFamily)
  expect(await font('Instance types')).toMatch(/mono/i)
  expect(await font('Capacity types')).not.toMatch(/mono/i)
  // More than five: four, and the rest behind "4 more", which opens them in place.
  await expect(types.getByRole('listitem')).toHaveCount(4)
  await types.getByRole('button', { name: '4 more' }).click()
  await expect(types.getByRole('listitem')).toHaveCount(8)
  await expect(types.getByRole('button')).toHaveCount(0)
  // A value longer than its column loses its middle, never its mark.
  await expect(
    zones.getByRole('listitem').last().locator('[aria-hidden] [data-mark]'),
  ).toContainText('U+202E')
})
