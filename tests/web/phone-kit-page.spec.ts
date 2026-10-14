/** A page's frame from the kit on a phone: the list is the page; what's picked is a page of its own. */
import type { Locator } from '@playwright/test'
import { placed } from '../placed.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'
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

  // A tap opens what's picked as a page of its own: Back where the menu was, with the keyboard
  // on it, and the top bar's title as it was. The bar is Lumovi's: the picked one's name is
  // nowhere in it.
  // (Lumovi's top bar: the one header with the page's title in it.)
  const bar = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) })
  const title = await bar.getByRole('heading', { level: 1 }).innerText()
  await first.getByRole('button').tap()
  const back = page.getByRole('button', { name: 'Back to the list', exact: true })
  await expect(back).toBeVisible()
  await expect(back).toBeFocused()
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0)
  await expect(bar.getByRole('heading', { level: 1 })).toHaveText(title, { useInnerText: true })
  await expect(bar).not.toContainText('checkout')
  await expect(bar).not.toContainText('main-db')
  // Its name is the page's first line, one heading below the bar's: whole, on as many lines as
  // it takes (the list cut it in its middle), as a header's name is set on a phone.
  const name = page.getByRole('heading', { level: 2, name: LONGEST, exact: true })
  await expect(name).toHaveText(LONGEST)
  await expect(name).toHaveCSS('font-size', '17px')
  await expect(name).toHaveCSS('line-height', '24px')
  await expect(name).toHaveCSS('font-weight', '600')
  const lines = await name.evaluate((heading) => {
    const text = heading.querySelector('[data-their-text]')!
    return {
      rows: Math.round(text.getBoundingClientRect().height / 24),
      runsOff: text.scrollWidth > text.clientWidth,
      within: heading.getBoundingClientRect().right <= window.innerWidth,
    }
  })
  expect(lines.rows).toBeGreaterThan(1)
  expect(lines).toMatchObject({ runsOff: false, within: true })
  // What follows starts 12 px under it; and a header there doesn't say the name again.
  const header = page.getByRole('group', { name: LONGEST })
  await expect(header.getByRole('heading')).toHaveCount(0)
  const [nameBox, headerBox] = [await placed(name), await placed(header)]
  expect(Math.round(headerBox.y - (nameBox.y + nameBox.height))).toBe(12)
  await expect(header).toContainText('Unrecoverable')
  // Why, under its status pill.
  const why = header.getByRole('paragraph').filter({ hasText: 'No instance can be promoted' })
  await expect(why).toHaveText('No instance can be promoted: all three lost their storage')
  // (Both measured until they're laid out: one that isn't yet fails, rather than reads as 0.)
  const below = async (upper: Locator, lower: Locator) => {
    const [over, under] = [await upper.boundingBox(), await lower.boundingBox()]
    expect(over && under).toBeTruthy()
    return over!.y + over!.height <= under!.y + 1
  }
  await expect.poll(() => below(header.locator('[data-health]'), why)).toBe(true)
  // A plugin's buttons that change the cluster aren't offered: one line says where they are,
  // naming the first four of five-or-more… here four change, so all four are named.
  await expect(header.getByRole('paragraph').filter({ hasText: 'larger screen' })).toHaveText(
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

  // Back returns to the list, with the menu again, and the keyboard on the row that was opened.
  await page.getByRole('button', { name: 'Back to the list', exact: true }).tap()
  await expect(list.getByRole('listitem')).toHaveCount(38)
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible()
  await expect(first.getByRole('button')).toBeFocused()
  // (Once, as the list comes back: typed in, its filter keeps the keyboard.)
  await list.getByPlaceholder('Filter clusters').fill('db')
  await expect(list.getByPlaceholder('Filter clusters')).toBeFocused()
  await list.getByPlaceholder('Filter clusters').fill('')
  // One button that changes, and two: the line names them as they're written, without "…".
  await list.getByRole('listitem').filter({ hasText: 'reports-db' }).getByRole('button').tap()
  await expect(page.getByRole('group', { name: 'reports-db' }).getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Back up now.',
  )
  await page.getByRole('button', { name: 'Back to the list', exact: true }).tap()
  // What its buttons do, under Lumovi's line where they give way: none of them is here to be off.
  await list.getByRole('listitem').filter({ hasText: 'orders-db' }).getByRole('button').tap()
  const orders = page.getByRole('group', { name: 'orders-db' })
  await expect(orders.getByRole('paragraph')).toHaveText([
    'Open Lumovi on a larger screen to use Restart, Switch over and Back up now.',
    // (On a phone, whose each is, in Lumovi's words: there are no buttons for them to be under.)
    'Switch over: Promotes the most up-to-date replica to primary: writes pause for a few seconds.',
    'Back up now: Writes a base backup of every database to the object store now, besides those its schedule takes, kept like the rest.',
  ])
  await expect(orders.getByRole('button', { name: /^Back up now/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to the list', exact: true }).tap()
  await list.getByRole('listitem').filter({ hasText: 'payments-db' }).getByRole('button').tap()
  await expect(page.getByRole('group', { name: 'payments-db' }).getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Switch over and Back up now.',
  )
  // Six that change: the first four named, and how many more. The one that only reads stays, and
  // is never filled: only one that changes is.
  await page.getByRole('button', { name: 'Back to the list', exact: true }).tap()
  await list.getByRole('listitem').filter({ hasText: 'sessions-db' }).getByRole('button').tap()
  const sessions = page.getByRole('group', { name: 'sessions-db' })
  await expect(sessions.getByRole('paragraph')).toHaveText(
    'Open Lumovi on a larger screen to use Hibernate, Restart, Switch over, Back up now and 2 more.',
  )
  await expect(sessions.getByRole('button')).toHaveText(['Show metrics'])
  await expect(sessions.getByRole('button')).not.toHaveClass(/\bbg-accent\b/)
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

test('on a phone, a row’s line under its name wraps to two lines, and where that cuts it, it’s whole where it’s tapped', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
  const list = page.getByRole('region', { name: 'Clusters' }).first()
  await list.getByRole('listitem').filter({ hasText: 'orders-db' }).getByRole('button').tap()
  const cards = page.getByRole('region', { name: 'Instances' }).getByRole('listitem')
  const [long, short] = [cards.nth(0), cards.nth(1)]
  const line = long.locator('[data-under]')
  await line.scrollIntoViewIfNeeded()
  // Two lines of 16 px, cut: tapped, it's whole, and the card isn't opened.
  expect((await line.boundingBox())!.height).toBeLessThanOrEqual(33)
  const whole = long.getByRole('button', { name: /^Get "http/ })
  await whole.tap()
  await expect(page.getByRole('dialog')).toContainText('the last three scrapes in a row')
  // Not cut: only its line, nothing to tap.
  await expect(short.locator('[data-under]')).toHaveText('Streaming')
  await expect(short.getByRole('button', { name: 'Streaming' })).toHaveCount(0)
})

/** Whether a line shows all of itself: nothing of it past its own box. */
const whole = (line: Locator) =>
  line.evaluate((shown) => shown.scrollHeight <= shown.clientHeight + 1)

test('under a finger no tooltip holds the rest, so a card’s about and a header’s lines wrap whole', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
  // A card's about as long as one may be, 240 characters: all of it on the page, its last word too.
  const about = page
    .getByRole('region', { name: 'Karpenter’s overview' })
    .getByRole('region', { name: 'Node mix' })
    .locator('[data-about]')
  await about.scrollIntoViewIfNeeded()
  expect((await about.innerText()).length).toBe(240)
  await expect(about).toHaveCSS('-webkit-line-clamp', 'none')
  expect(await whole(about)).toBe(true)
  const last = await about.evaluate((line) => {
    const texts = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
    let node: Node | null = null
    for (let next = texts.nextNode(); next; next = texts.nextNode()) node = next
    const said = node!.textContent!
    const word = document.createRange()
    word.setStart(node!, said.lastIndexOf(' ') + 1)
    word.setEnd(node!, said.length)
    const [box, line_] = [word.getBoundingClientRect(), line.getBoundingClientRect()]
    return [word.toString(), box.height > 0 && box.bottom <= line_.bottom + 1]
  })
  expect(last).toEqual(['times.', true])
  // A header's why, and what its buttons do: each whole, however many lines that takes.
  await page.evaluate(() => window.scrollTo(0, 0))
  const list = page.getByRole('region', { name: 'Clusters' }).first()
  await list.getByRole('listitem').filter({ hasText: 'orders-db' }).getByRole('button').tap()
  const orders = page.getByRole('group', { name: 'orders-db' })
  const notes = orders.locator('p:has(svg) > span')
  await expect(notes).toHaveCount(2)
  for (const note of await notes.all()) {
    await expect(note).toHaveCSS('-webkit-line-clamp', 'none')
    expect(await whole(note)).toBe(true)
  }
  await expectNoSidewaysScroll(page, 'a header’s notes, whole on a phone')
})

test.describe('under a finger at a desktop’s width', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: false })

  test('why a button is off stands under the buttons, as what one does: nothing hovers to say it', async ({
    page,
    serve,
  }) => {
    const served = await serve()
    await signIn(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
    await page
      .getByRole('listbox', { name: 'Clusters' })
      .getByRole('option')
      .filter({ hasText: 'orders-db' })
      .tap()
    const orders = page.getByRole('group', { name: 'orders-db' })
    // Its last button is off: said under the buttons, in a line that says it's why, before what
    // that button does.
    await expect(orders.getByRole('button', { name: 'Back up now…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    const reason = orders.locator('[data-off-reason]')
    await expect(reason).toHaveText('Back up now is off: A backup is running.')
    await expect(orders.getByRole('paragraph')).toHaveText([
      /^Switch over: /,
      'Back up now is off: A backup is running.',
      /^Back up now: /,
    ])
    for (const line of await orders.locator('p:has(svg) > span').all()) {
      expect(await whole(line)).toBe(true)
    }
  })
})
