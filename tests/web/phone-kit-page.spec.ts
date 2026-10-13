/** A page's frame from the kit on a phone: the list is the page; what's picked is a page of its own. */
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const LONGEST = 'checkout-payments-reconciliation-ledger-archive-eu-west1-main-db'

test('a split on a phone: the list, then what’s picked with Back; changes are on a larger screen', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
  const list = page.getByRole('region', { name: 'Clusters', exact: true })
  // The list is the page: how many in a line of its own, a filter past twelve, nothing picked,
  // and none of the rest.
  await expect(list).toContainText('38 clusters')
  await expect(list.getByPlaceholder('Filter clusters')).toBeVisible()
  await expect(list.getByRole('listitem')).toHaveCount(38)
  await expect(page.getByRole('region', { name: 'Instances ready' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  const first = list.getByRole('listitem').first()
  await expect
    .poll(async () => Math.round((await first.getByRole('button').boundingBox())?.height ?? 0))
    .toBe(60)
  await expectNoSidewaysScroll(page, 'a pick list, on a phone')
  await expectFingerSized(page, 'a pick list, on a phone')

  // A tap opens what's picked as a page of its own: Back where the menu was, its name in the
  // top bar (cut in its middle), its status on a line of its own.
  await first.getByRole('button').tap()
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 }).locator('[aria-hidden]')).toHaveText(
    /…ain-db$/,
  )
  const header = page.getByRole('group', { name: LONGEST })
  await expect(header.getByRole('heading')).toHaveCount(0)
  await expect(header).toContainText('Unrecoverable')
  // A plugin's buttons that change the cluster aren't offered: one line says where they are,
  // naming the first four of five-or-more… here four change, so all four are named.
  await expect(header.getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Hibernate, Restart, Switch over and Back up now.',
  )
  // One that only reads stays, a finger's size.
  await expect(header.getByRole('button')).toHaveText(['Show logs'])
  await header.getByRole('button', { name: 'Show logs' }).tap()
  await expect(page.getByRole('list', { name: 'What was pressed' })).toContainText(
    'press {"button":"logs"}',
  )
  // Tiles are two across; the table under them is cards.
  const tiles = await Promise.all(
    ['Instances ready', 'Primary', 'Last backup', 'Version'].map((name) =>
      page
        .getByRole('region', { name, exact: true })
        .first()
        .evaluate((el) => {
          const box = el.getBoundingClientRect()
          return { left: Math.round(box.left), top: Math.round(box.top) }
        }),
    ),
  )
  expect(tiles[0]!.top).toBe(tiles[1]!.top)
  expect(tiles[2]!.top).toBe(tiles[3]!.top)
  expect(tiles[2]!.top).toBeGreaterThan(tiles[0]!.top)
  expect(tiles[0]!.left).toBe(tiles[2]!.left)
  await expectNoSidewaysScroll(page, 'what’s picked, on a phone')
  await expectFingerSized(page, 'what’s picked, on a phone')

  // Back returns to the list, with the menu again.
  await page.getByRole('button', { name: 'Back' }).tap()
  await expect(list.getByRole('listitem')).toHaveCount(38)
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  // One button that changes, and two: the line names them as they're written, without "…".
  await list.getByRole('listitem').filter({ hasText: 'reports-db' }).getByRole('button').tap()
  await expect(page.getByRole('group', { name: 'reports-db' }).getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Back up now.',
  )
  await page.getByRole('button', { name: 'Back' }).tap()
  await list.getByRole('listitem').filter({ hasText: 'payments-db' }).getByRole('button').tap()
  await expect(page.getByRole('group', { name: 'payments-db' }).getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Switch over and Back up now.',
  )
  // Six that change: the first four named, and how many more. The one that only reads is the
  // header's last, so it's the filled one.
  await page.getByRole('button', { name: 'Back' }).tap()
  await list.getByRole('listitem').filter({ hasText: 'sessions-db' }).getByRole('button').tap()
  const sessions = page.getByRole('group', { name: 'sessions-db' })
  await expect(sessions.getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Hibernate, Restart, Switch over, Back up now and 2 more.',
  )
  await expect(sessions.getByRole('button')).toHaveText(['Show metrics'])
  await expect(sessions.getByRole('button')).toHaveClass(/\bbg-accent\b/)
})

test('Karpenter’s overview on a phone: a pair stacks, a count keeps its row, and “N more” is a finger’s height', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
  const overview = page.getByRole('region', { name: 'Karpenter’s overview' })
  await overview.scrollIntoViewIfNeeded()
  const nodes = overview.getByRole('region', { name: 'Nodes', exact: true })
  const mix = overview.getByRole('region', { name: 'Node mix' })
  // A pair stands one under the other, the first on top, each the page's width.
  await expect
    .poll(async () => {
      const [a, b] = [await nodes.boundingBox(), await mix.boundingBox()]
      return a && b ? [a.y + a.height <= b.y, Math.round(a.width) === Math.round(b.width)] : []
    })
    .toEqual([true, true])
  // In a card, facts stand side by side only where every value fits a third of what's left of
  // the line: the pools' limits don't, the nodes' use does.
  const across = (card: typeof nodes) =>
    card
      .locator('li[data-row] dl')
      .first()
      .evaluate((facts) => getComputedStyle(facts).gridTemplateColumns.split(' ').length)
  await expect
    .poll(() => across(overview.getByRole('region', { name: 'Node pools', exact: true })))
    .toBe(1)
  await expect.poll(() => across(nodes)).toBe(3)
  // A meter at its line says its level, as a status does: spot-batch's CPU at 64 of 64, its memory
  // at 200 of 256; the default pool's use, below it, is plain.
  const pool = (name: string) =>
    overview
      .getByRole('region', { name: 'Node pools', exact: true })
      .locator('li[data-row]')
      .filter({ hasText: name })
      .locator('dd')
  await expect(pool('spot-batch').nth(0)).toHaveAttribute('data-level', 'critical')
  await expect(pool('spot-batch').nth(1)).toHaveAttribute('data-level', 'warning')
  await expect(pool('spot-batch').nth(0).locator('svg')).toHaveCount(1)
  await expect(pool('default').nth(0)).not.toHaveAttribute('data-level')
  await expect(pool('default').nth(0).locator('svg')).toHaveCount(0)
  // A count keeps its value, bar and count on one line.
  const row = mix.getByRole('region', { name: 'Zones' }).getByRole('listitem').first()
  await expect.poll(async () => Math.round((await row.boundingBox())?.height ?? 0)).toBe(32)
  // "4 more" is a row a finger can press.
  const more = mix.getByRole('button', { name: '4 more' })
  await more.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect
    .poll(async () => Math.round((await more.boundingBox())?.height ?? 0))
    .toBeGreaterThanOrEqual(44)
  await expectNoSidewaysScroll(page, 'Karpenter’s overview, on a phone')
  await expectFingerSized(page, 'Karpenter’s overview, on a phone')
})

test('on a phone, a cut tile’s line of Lumovi’s own wraps, never cut, and its row is as tall as it', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
  const cut = page.getByRole('region', { name: 'Pods waiting', exact: true })
  const reading = page.getByRole('region', { name: 'Still reading', exact: true })
  const line = cut.getByText('Counted from the first 5,000 Lumovi read.')
  await line.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  // Whole: on more than one line where it must, never cut at its end.
  expect(
    await line.evaluate((el) => {
      const style = getComputedStyle(el)
      return [style.textOverflow, style.whiteSpace, el.scrollWidth <= el.clientWidth]
    }),
  ).toEqual(['clip', 'normal', true])
  // The row's tiles take the taller height together.
  const heights = await Promise.all(
    [cut, reading].map((tile) =>
      tile.evaluate((el) => Math.round(el.getBoundingClientRect().height)),
    ),
  )
  expect(heights[0]).toBe(heights[1])
  await expectNoSidewaysScroll(page, 'a row with a cut tile, on a phone')
})
