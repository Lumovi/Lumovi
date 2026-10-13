/**
 * The kit's Graph, on the page the tests' build has for the kit's parts: the cases design drew
 * (Lumovi-design's frame "graph"): the map's card and lines, a loop, more than fit, the table made
 * from the same cards, the filter, the ceiling, nothing to draw, and names with marks.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, openCluster, test } from './fixtures.ts'

async function kit(page: Page) {
  await openCluster(page)
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/kit'
  })
  await expect(graphOf(page, 'Resources of shop')).toBeVisible()
}

/** A graph's part, by its title. */
const partOf = (page: Page, title: string) => page.getByRole('region', { name: title, exact: true })
/** A graph's picture: its cards, as a list. */
const graphOf = (page: Page, title: string) =>
  partOf(page, title).getByRole('list', { name: title, exact: true })
const cardsOf = (graph: Locator) => graph.getByRole('listitem')
/** A card, by what a screen reader hears of it. */
const card = (graph: Locator, said: string | RegExp) =>
  graph.getByLabel(said, { exact: typeof said === 'string' })
/** The lines lit (the focused card's own): blue. */
const lit = (graph: Locator) => graph.locator('svg path[stroke="var(--accent)"]')

test('a graph: the map’s cards in rows, lines between them, each card said as a screen reader hears it', async ({
  page,
}) => {
  await kit(page)
  const graph = graphOf(page, 'Resources of shop')
  await expect(cardsOf(graph)).toHaveCount(9)
  // Each card in the one order (the table's), how many there are, and how many it leads to.
  await expect(card(graph, 'Application shop, Degraded, 1 of 9, leads to 4')).toBeVisible()
  await expect(card(graph, 'Deployment storefront, Healthy, 2 of 9, leads to 2')).toBeVisible()
  await expect(card(graph, 'Deployment cart, Degraded, 5 of 9, leads to 3')).toBeVisible()
  // Rows by the lines' direction: the application above its workloads, they above their pods.
  const top = async (said: RegExp) => Math.round((await card(graph, said).boundingBox())?.y ?? -1)
  await expect.poll(() => top(/^Application shop/)).toBeLessThan(await top(/^Deployment cart/))
  await expect
    .poll(() => top(/^Deployment cart/))
    .toBeLessThan(await top(/^Pod cart-6c9d7f5b44-w4nq7/))
  // The legend's words, and the switch, on Graph.
  const part = partOf(page, 'Resources of shop')
  await expect(part).toContainText('Owns')
  await expect(part).toContainText('Uses')
  await expect(part.getByRole('radio', { name: 'Graph' })).toHaveAttribute('aria-checked', 'true')
  // A line's label is said on it.
  await expect(part.getByText('mounts', { exact: true })).toHaveCount(1)
  // The kind's own icon for a card that opens an object; a card that doesn't isn't a button.
  await expect(graph.getByRole('button', { name: /^Deployment cart/ })).toBeVisible()
  await expect(graph.getByRole('button', { name: /^Application shop/ })).toHaveCount(0)
})

test('under the keyboard: Tab reaches each card in the table’s order, the arrows follow lines, its own lines turn blue', async ({
  page,
}) => {
  await kit(page)
  const graph = graphOf(page, 'Resources of shop')
  const shop = card(graph, /^Application shop/)
  await shop.focus()
  // Its four lines lit, the rest faded.
  await expect(lit(graph)).toHaveCount(4)
  const focused = page.locator(':focus')
  // Down: to the first card a line leads to, in the table's order; along the row; and up again.
  await page.keyboard.press('ArrowDown')
  await expect(focused).toHaveAttribute('aria-label', /^Deployment storefront/)
  await page.keyboard.press('ArrowRight')
  await expect(focused).toHaveAttribute('aria-label', /^Deployment cart/)
  await page.keyboard.press('ArrowLeft')
  await expect(focused).toHaveAttribute('aria-label', /^Deployment storefront/)
  await page.keyboard.press('ArrowUp')
  await expect(focused).toHaveAttribute('aria-label', /^Application shop/)
  // Alone in its row, it has nowhere along it; and it opens nothing, so Enter says nothing.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(focused).toHaveAttribute('aria-label', /^Application shop/)
  // Tab: the next card in the table's order.
  await page.keyboard.press('Tab')
  await expect(focused).toHaveAttribute('aria-label', /^Deployment storefront, .*, 2 of 9/)
  // Enter opens a card that opens something: Lumovi goes to the object, and the plugin hears it.
  await card(graph, /^Deployment cart/).focus()
  await page.keyboard.press('Enter')
  const pressed = page.getByRole('list', { name: 'What was pressed' })
  await expect(pressed).toContainText(
    'Resources of shop: go {"kind":"Deployment","name":"cart","namespace":"shop"}',
  )
  await expect(pressed).toContainText('Resources of shop: open {"node":"d2"}')
  await expect(pressed).not.toContainText('{"node":"app"}')
})

test('a loop turns back with the only arrowhead; more than a row holds is “+N more”, opened in place', async ({
  page,
}) => {
  await kit(page)
  const steps = graphOf(page, 'Steps')
  await expect(cardsOf(steps)).toHaveCount(4)
  await expect(steps.locator('svg path[marker-end]')).toHaveCount(1)
  // The longest name is cut in its middle, its end kept; its tooltip says as much as one shows.
  const longest = card(steps, /build-and-push-the-image-for-every-architecture/)
  await expect(longest).toHaveAttribute('title', 'build-and-push-the-image-for-every-archi…')
  const drawn = longest.locator('[aria-hidden] > [data-their-text]')
  await expect(drawn).toContainText('…')
  await expect(drawn).toContainText('ecture')

  const orders = graphOf(page, 'What uses orders-db')
  // (The pods' row: at this width the services' has its own, of fewer than ten.)
  const more = orders.getByRole('button', { name: /^1\d more$/ })
  await expect(more).toBeVisible()
  // The pod that's failing is among those shown before the rest.
  await expect(card(orders, /^Pod orders-db-3, CrashLoopBackOff/)).toBeVisible()
  await more.click()
  await expect(orders.getByLabel(/^Pod orders-db-\d+/)).toHaveCount(17)
  // The same label on five lines into one card: said once.
  await expect(
    partOf(page, 'What uses orders-db').getByText('reads and writes', { exact: true }),
  ).toHaveCount(1)
})

test('the same cards as a table: nested as the lines go, a card with two parents listed again, which goes to the first', async ({
  page,
}) => {
  await kit(page)
  const part = partOf(page, 'Resources of shop')
  await part.getByRole('radio', { name: 'Table' }).click()
  const table = part.getByRole('treegrid', { name: 'Resources of shop' })
  await expect(table).toBeVisible()
  // Its rows nest: the application, open it, its workloads, open one, its pods.
  const row = (name: string) => table.getByRole('row').filter({ hasText: name })
  // (In the picture's order: storefront, then cart; the ConfigMap they both use is listed whole
  // under the first, and again under cart, the line's label with it.)
  await row('shop').first().getByRole('button', { name: 'Open shop' }).click()
  await row('cart').first().getByRole('button', { name: 'Open cart' }).click()
  const again = table.getByRole('row').filter({ hasText: 'Listed again' })
  await expect(again).toContainText('Listed again: first under storefront')
  await expect(again).toContainText('ConfigMap · mounts')
  // Pressed, it goes where it's first: under storefront, opened for it, the active row.
  await again.getByRole('button', { name: 'storefront' }).click()
  const first = table.locator('[role="row"][data-active="true"]')
  await expect(first).toContainText('cart-config')
  await expect(first).not.toContainText('Listed again')
  await expect(row('cart-6c9d7f5b44-w4nq7')).toBeVisible()
  // A tree of rows: each says how deep it is.
  await expect(row('cart-6c9d7f5b44-w4nq7')).toHaveAttribute('aria-level', '3')
})

test('the filter: matches by name or kind, the cards above a match kept for context, and nothing matching said', async ({
  page,
}) => {
  await kit(page)
  const part = partOf(page, 'Resources of shop')
  const graph = graphOf(page, 'Resources of shop')
  const field = part.getByLabel('Filter Resources of shop')
  await field.fill('pod')
  await expect(part.getByRole('heading')).toContainText('3 of 9')
  await expect(card(graph, 'Application shop, shown for context')).toBeVisible()
  await expect(graph.getByLabel(/^Pod /)).toHaveCount(3)
  await expect(graph.getByLabel(/^Service storefront/)).toHaveCount(0)
  // Only the lines that end at a match are in full: the three into the pods. Those between the
  // cards kept for context are quieter.
  await expect(graph.locator('svg path[opacity="1"]')).toHaveCount(3)
  await expect(graph.locator('svg path[opacity="0.55"]')).toHaveCount(2)
  // What was typed is bold in a name it's found in.
  await field.fill('cart')
  await expect(card(graph, /^Deployment cart,/).locator('[aria-hidden] b')).toHaveText('cart')
  await expect(
    card(graph, /^Pod cart-6c9d7f5b44-w4nq7/)
      .locator('[aria-hidden] b')
      .first(),
  ).toHaveText('cart')
  // Found in the middle of a name: bold there, the rest as it is.
  await field.fill('front')
  await expect(card(graph, /^Deployment storefront,/).locator('[aria-hidden] b')).toHaveText(
    'front',
  )
  await expect(
    card(graph, /^Deployment storefront,/).locator('[aria-hidden] > [data-their-text]'),
  ).toHaveText('storefront')
  // A name with just the room it takes in its own weight: with what was typed bold in it, it's
  // wider, so it's cut, never run past its end.
  await field.fill('')
  const storefront = card(graph, /^Deployment storefront,/)
  const name = storefront.locator('span:has(> span.invisible)')
  const drawn = storefront.locator('[aria-hidden] > [data-their-text]')
  await expect(drawn).toHaveText('storefront')
  await name.evaluate((span) => {
    span.style.width = `${span.querySelector('.invisible')!.getBoundingClientRect().width + 0.3}px`
    span.style.flex = 'none'
  })
  await field.fill('front')
  await expect(drawn).toContainText('…')
  await expect(storefront.locator('[aria-hidden] b')).toHaveText('front')
  await expect
    .poll(() =>
      name.evaluate(
        (span) =>
          span.querySelector('[aria-hidden] > [data-their-text]')!.getBoundingClientRect().width -
          span.getBoundingClientRect().width,
      ),
    )
    .toBeLessThanOrEqual(0.5)
  // Nothing matches: said with what was typed, the switch kept, and a way back.
  await field.fill('orders')
  await expect(part).toContainText('Nothing matches “orders”.')
  await expect(part.getByRole('heading')).toContainText('0 of 9')
  await expect(part.getByRole('radio', { name: 'Table' })).toBeVisible()
  // (The field's × is "Clear filter" too: this is the one under what it says.)
  await part.getByRole('button', { name: 'Clear filter' }).last().click()
  await expect(cardsOf(graph)).toHaveCount(9)
})

test('past the ceiling it’s listed, saying why; nothing to draw is said in the plugin’s words; marks in a name are kept', async ({
  page,
}) => {
  await kit(page)
  await page.getByRole('button', { name: 'With 412 cards' }).click()
  const many = partOf(page, 'Every resource')
  await expect(many).toContainText(
    '412 are too many to draw as a graph (300 at most), so they’re listed. Filter the list to see fewer.',
  )
  await expect(many.getByRole('radio', { name: 'Graph' })).toBeDisabled()
  await expect(many.getByRole('treegrid', { name: 'Every resource' })).toBeVisible()

  const empty = partOf(page, 'Resources of storefront')
  await expect(empty).toContainText('Nothing to show')
  await expect(empty).toContainText('storefront has no resources yet.')
  await expect(empty.getByRole('radio')).toHaveCount(0)

  const marked = graphOf(page, 'Resources with marks')
  await expect(marked.locator('[data-mark]').filter({ hasText: 'U+202E' }).first()).toBeAttached()
  // A name of many marks ends after the last that fits: none drawn past its card.
  const spam = card(marked, /^Deployment spam/)
  await expect
    .poll(() =>
      spam.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return [...element.querySelectorAll('[aria-hidden] [data-mark]')].every(
          (mark) => mark.getBoundingClientRect().right <= box.right + 0.5,
        )
      }),
    )
    .toBe(true)
  // A line's label keeps a mark where it is. Past sixteen letters it's cut: "…", then the marks of
  // what was cut, and all of it in its tooltip.
  const labels = marked.locator('span[aria-hidden][style*="left"]')
  const inside = labels.filter({ hasText: 'calls' })
  await expect(inside.locator('[data-mark]')).toHaveCount(1)
  await expect(inside).toContainText('it')
  const cut = labels.filter({ hasText: 'sixteen-letters!' })
  await expect(cut).toContainText('sixteen-letters!…')
  await expect(cut.locator('[data-mark]')).toHaveCount(1)
  await expect(cut).not.toContainText('and more')
  await expect(cut).toHaveAttribute('title', /and more$/)
  // What was typed is bold beside a name's marks. In a name whose letters, lowered, are more of
  // them, it's drawn as it is.
  const field = partOf(page, 'Resources with marks').getByLabel('Filter Resources with marks')
  // (Its end, which a cut keeps.)
  await field.fill('west')
  const payments = card(marked, /^Deployment payments/)
  await expect(payments.locator('[aria-hidden] b').first()).toHaveText('west')
  await expect(payments.locator('[aria-hidden] [data-mark]').first()).toBeAttached()
  await field.fill('gate')
  const izmir = card(marked, /^Deployment İzmir-gateway/)
  await expect(izmir.locator('[aria-hidden] > [data-their-text]')).toHaveText('İzmir-gateway')
  await expect(izmir.locator('b')).toHaveCount(0)
})

test('as many cards as a graph may have, in one long chain or in loops, are listed, and a filter finds the deepest', async ({
  page,
}) => {
  await kit(page)
  await page.getByRole('button', { name: 'With a chain of 5,000 cards' }).click()
  const chain = partOf(page, 'A long chain')
  const rows = chain.getByRole('treegrid', { name: 'A long chain' }).getByRole('row')
  // Past the ceiling: listed, and the first card at the top.
  await expect(chain).toContainText('5,000 are too many to draw as a graph')
  await expect(rows.filter({ hasText: 'card 0' }).first()).toBeVisible()
  // The deepest found, with every card above it kept, open, for where it is.
  await chain.getByLabel('Filter A long chain').fill('card 4999')
  await expect(chain.getByRole('heading')).toContainText('1 of 5,000')
  // (Every one of them a line, drawn only where it's in view: the last, from the keyboard.)
  const grid = chain.getByRole('treegrid', { name: 'A long chain' })
  await expect(grid).toHaveAttribute('aria-rowcount', '5001')
  await grid.focus()
  await page.keyboard.press('End')
  await expect(rows.filter({ hasText: 'card 4999' })).toBeVisible()
  await page.getByRole('button', { name: 'With 5,000 cards in loops' }).click()
  const loops = partOf(page, 'Cards in loops')
  await expect(
    loops.getByRole('treegrid', { name: 'Cards in loops' }).getByRole('row').first(),
  ).toBeVisible()
  await loops.getByLabel('Filter Cards in loops').fill('card 42')
  await expect(loops.getByRole('heading')).toContainText('111 of 5,000')
})

test('links too many to draw are listed, and said; a graph still reading says so; a card that opens nothing is just a card', async ({
  page,
}) => {
  await kit(page)
  // Forty cards are few enough, but their 780 links aren't.
  await expect(partOf(page, 'Who talks to whom')).toContainText(
    'Their 780 links are too many to draw as a graph (600 at most), so they’re listed.',
  )
  await expect(
    partOf(page, 'Reading the steps').getByRole('status', { name: 'Loading' }),
  ).toBeVisible()
  // Pressed, a card that opens nothing tells the plugin nothing.
  await cardsOf(graphOf(page, 'Steps')).first().click()
  await expect(page.getByRole('list', { name: 'What was pressed' })).not.toContainText('Steps')
})
