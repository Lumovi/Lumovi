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
})
