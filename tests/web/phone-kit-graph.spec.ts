/**
 * The kit's Graph on a phone: no picture and nothing to switch, only its table, as the Table's
 * cards, nesting as the lines go, on the page the tests' build has for the kit.
 */
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, FINGER, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

test('a graph on a phone: its table’s cards, “Listed again” going where a card is first, and its filter', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit`, DEMO_TOKEN)
  const part = page.getByRole('region', { name: 'Resources of shop', exact: true })
  const cards = part.locator('li[data-row]')
  const card = (name: string) => cards.filter({ hasText: name })
  // Its cards nothing leads to, closed: the application, and how many there are in all.
  await expect(cards).toHaveCount(1)
  await expect(part.getByRole('heading').first()).toContainText('9')
  // No picture, no legend, and nothing to switch to.
  await expect(part.getByRole('list', { name: 'Resources of shop', exact: true })).toHaveCount(0)
  await expect(part.getByRole('radio')).toHaveCount(0)
  await expect(part).not.toContainText('Owns')

  // Open as the lines go: the application, its workloads, a workload's pods and what it uses.
  await part.getByRole('button', { name: 'Open shop' }).tap()
  await part.getByRole('button', { name: 'Open cart' }).tap()
  const again = card('listed again')
  await expect(again).toHaveText('cart-config, listed again: first under storefront')
  await expect
    .poll(async () => (await again.getByRole('button').boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(FINGER)
  await expectFingerSized(page, 'a graph’s cards, on a phone')
  await expectNoSidewaysScroll(page, 'a graph’s cards, on a phone')
  // Tapped, it goes where the card is first: under storefront, opened for it, and brought into
  // view (from where it's listed again, at the top of the screen).
  await again.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await again.getByRole('button').tap()
  await expect(part.getByRole('button', { name: 'Close storefront' })).toBeVisible()
  const first = card('cart-config').filter({ hasNotText: 'listed again' })
  await expect(first).toBeInViewport()

  // The filter: a finger's height, the cards above a match kept, open, and the count of matches.
  const field = part.getByLabel('Filter Resources of shop')
  await expect
    .poll(async () => (await field.locator('xpath=..').boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(FINGER)
  await field.fill('pod')
  await expect(part.getByRole('heading').first()).toContainText('3 of 9')
  await expect(cards).toHaveCount(6)
  await expect(card('cart-6c9d7f5b44-w4nq7')).toBeVisible()
  await expect(card('cart-config')).toHaveCount(0)
  // Nothing matches: said with what was typed, and a way back to the cards as they were.
  await field.fill('orders')
  await expect(part).toContainText('Nothing matches “orders”.')
  await expect(part.getByRole('heading').first()).toContainText('0 of 9')
  // (Measured mid-screen: typing leaves the field where its × reaches under the bars above it.)
  await field.evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expectFingerSized(page, 'a graph with nothing matching, on a phone')
  // (The field's × is "Clear filter" too: this is the one under what it says.)
  await part.getByRole('button', { name: 'Clear filter' }).last().tap()
  await expect(cards).toHaveCount(1)

  // Deeper than a phone sets cards in, a card says how deep it is.
  await page.getByRole('button', { name: 'With a chain of 5,000 cards' }).tap()
  const chain = page.getByRole('region', { name: 'A long chain', exact: true })
  for (let i = 0; i < 5; i++) {
    await chain.getByRole('button', { name: `Open card ${i}`, exact: true }).tap()
  }
  const deepest = chain.locator('li[data-row]').filter({ hasText: 'card 5' })
  await expect(deepest.getByTitle('Level 6')).toHaveText('6')
  await expect(
    chain
      .locator('li[data-row]')
      .filter({ hasText: 'card 4' })
      .getByTitle(/^Level/),
  ).toHaveCount(0)
  await expectNoSidewaysScroll(page, 'a graph’s deepest cards, on a phone')
})
