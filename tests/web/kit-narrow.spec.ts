/**
 * The kit's page in a window 1024 wide: a header keeps its name and folds its buttons into "…"
 * before anything leaves its pane, and a row of four tiles stands two by two.
 */
import { placed } from '../placed.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

const LONGEST = 'checkout-payments-reconciliation-ledger-archive-eu-west1-main-db'

test.use({ viewport: { width: 1024, height: 900 } })

test('at 1024 a header keeps twelve characters of its name: its buttons fold first, then the name takes a line of its own; four tiles stand two by two', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/kit/frame`, DEMO_TOKEN)
  const long = page.getByRole('group', { name: LONGEST })
  await expect(long).toBeVisible()
  // Folded as far as they go, "…" and the last alone, and still not twelve characters beside
  // them: the name on a line of its own, its status and buttons under it.
  await expect(long.getByRole('button')).toHaveText(['', 'Back up now…'])
  const name = long.getByRole('heading')
  await expect(name.locator('[aria-hidden]')).toHaveText(/^checkout-.+…ain-db$/)
  expect(((await name.locator('[aria-hidden]').textContent()) ?? '').length).toBeGreaterThan(12)
  const [heading, status] = [await placed(name), await placed(long.locator('[data-health]'))]
  expect(status.y).toBeGreaterThanOrEqual(heading.y + heading.height)
  // The last button whole: nothing past its pane.
  const last = long.getByRole('button', { name: 'Back up now…' })
  const [group, button] = [await placed(long), await placed(last)]
  expect(button.x + button.width).toBeLessThanOrEqual(group.x + group.width + 1)
  // Four tiles: two, and two under them.
  const tops = await Promise.all(
    ['Instances ready', 'Primary', 'Last backup', 'Version'].map(async (tile) =>
      // (The picked one's: the first on the page.)
      Math.round((await placed(page.getByRole('region', { name: tile }).first())).y),
    ),
  )
  expect(tops[0]).toBe(tops[1])
  expect(tops[2]).toBe(tops[3])
  expect(tops[2]).toBeGreaterThan(tops[0]!)
  // A name shorter than twelve keeps all of itself beside them, on one line.
  await page
    .getByRole('listbox', { name: 'Clusters' })
    .getByRole('option')
    .filter({ hasText: 'orders-db' })
    .click()
  const orders = page.getByRole('group', { name: 'orders-db' })
  await expect(orders.getByRole('heading').locator('[aria-hidden]')).toHaveText('orders-db')
  const [ordersName, ordersStatus] = [
    await placed(orders.getByRole('heading')),
    await placed(orders.locator('[data-health]')),
  ]
  expect(
    Math.abs(ordersName.y + ordersName.height / 2 - (ordersStatus.y + ordersStatus.height / 2)),
  ).toBeLessThan(4)
})

test('at 1024 a table keeps its name at a floor: its columns give way whole, the last first and its status last, and what they say is in the row’s tooltip', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo/kit`, DEMO_TOKEN)
  const certificates = page.getByRole('grid', { name: 'Certificates' })
  // Two tables side by side: no room for Renews and Age beside a readable name. They give way
  // whole, the last first; the status stays.
  await expect(certificates.getByRole('columnheader')).toHaveText(['Name', 'Status'])
  const api = certificates.getByRole('row').filter({ hasText: 'api-tls' })
  await expect(api.getByRole('gridcell')).toHaveCount(2)
  // The name keeps its floor rather than shrinking with every column.
  expect((await placed(api.getByRole('gridcell').first())).width).toBeGreaterThanOrEqual(160)
  // What the columns that gave way say: read after the row, and in its tooltip when pointed at.
  await expect(api).toHaveAccessibleDescription(/Renews\s*in \d+d\s*Age\s*\d+d/)
  await api.hover()
  await expect(page.getByRole('tooltip')).toContainText(/Renews\s*in \d+d/)
  await expect(page.getByRole('tooltip')).toContainText(/Age\s*\d+d/)
  // Wider, they're all there again, and no row has anything to say of them.
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(certificates.getByRole('columnheader')).toHaveText([
    'Name',
    'Status',
    'Renews',
    'Age',
  ])
  await expect(api).not.toHaveAttribute('aria-describedby', /away/)
})
