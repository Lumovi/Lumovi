/** The kit's Table on a phone: every row a card, on the page the tests' build has for the kit. */
import type { Locator } from '@playwright/test'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, FINGER, PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

/** How many facts stand on a card's first line. */
const acrossOf = (card: Locator) =>
  card
    .locator('dl')
    .evaluate((facts) => getComputedStyle(facts).gridTemplateColumns.split(' ').length)

const leads = (table: Locator) =>
  table
    .locator('li[data-row]')
    .evaluateAll((cards) =>
      cards.map((card) => card.querySelector('.font-medium > span')?.textContent ?? ''),
    )

test('a table on a phone: cards, facts side by side only where they all fit, and sorting from a sheet', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signInNarrow(page, `${served.url}cluster/demo/kit`, DEMO_TOKEN)
  const certificates = page.getByRole('region', { name: 'Certificates', exact: true })
  const cards = certificates.locator('li[data-row]')
  await expect(cards).toHaveCount(4)
  // A row's columns are facts under its name, each with its column's name.
  const api = cards.filter({ hasText: 'api-tls' })
  await expect(api).toContainText('platform')
  await expect(api.locator('dt')).toHaveText(['Status', 'Renews', 'Age'])
  await expect(api.locator('dd').first()).toHaveText('Ready')
  // Short values, every one: three stand side by side.
  expect(await acrossOf(api)).toBe(3)
  // One value in the table that doesn't fit a third, and every card of it stacks its facts.
  const resources = page.getByRole('region', { name: 'Resources', exact: true })
  for (const name of ['shop-old', 'checkout']) {
    expect(await acrossOf(resources.locator('li[data-row]').filter({ hasText: name }))).toBe(1)
  }
  // A row that opens is pressed whole.
  await api.getByRole('button').tap()
  await expect(page.getByRole('list', { name: 'What was pressed' })).toContainText(
    'Certificates: open {"row":"platform/api-tls"}',
  )
  // There are no headings to press: sorting is a sheet, from beside the table's name.
  await certificates.getByRole('button', { name: 'Sort Certificates' }).tap()
  const sheet = page.getByRole('listbox', { name: 'Sort by' })
  await expect(sheet.getByRole('option')).toHaveText(['Name', 'Status', 'Renews', 'Age'])
  await expectFingerSized(page, 'the sheet a table is sorted from')
  await sheet.getByRole('button', { name: 'Status' }).tap()
  await expect(sheet).toHaveCount(0)
  await expect
    .poll(() => leads(certificates))
    .toEqual(['payments-tls', 'storefront-tls', 'api-tls', 'grafana-tls'])
  await certificates.getByRole('button', { name: 'Sort Certificates' }).tap()
  await expect(sheet.getByRole('option', { name: 'Status' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await sheet.getByRole('button', { name: 'Status' }).tap()
  await expect.poll(async () => (await leads(certificates)).at(-1)).toBe('payments-tls')
  // A table with nothing to sort by has no such button.
  await expect(page.getByRole('region', { name: 'Node pools' }).getByRole('button')).toHaveCount(0)

  // A row that holds rows opens from a chevron a finger's size, and its rows are cards under it.
  const cart = resources.getByRole('button', { name: 'Open cart' })
  await expect
    .poll(async () => {
      const box = await cart.boundingBox()
      return box ? Math.min(box.width, box.height) : 0
    })
    .toBeGreaterThanOrEqual(FINGER)
  await cart.tap()
  await expect(
    resources.locator('li[data-row]').filter({ hasText: 'CrashLoopBackOff' }),
  ).toBeVisible()
  // (A cell with nothing in it is no fact on a card: a pod here has no Sync.)
  await expect(
    resources.locator('li[data-row]').filter({ hasText: 'CrashLoopBackOff' }).locator('dt'),
  ).toHaveText(['Health'])
  await resources.getByRole('button', { name: 'Close cart' }).tap()
  await expect(
    resources.locator('li[data-row]').filter({ hasText: 'CrashLoopBackOff' }),
  ).toHaveCount(0)
  // Groups keep their headings and counts; the rest waits behind a button.
  await expect(resources.getByRole('heading', { name: /^Network/ })).toContainText('20')
  await expect(resources.locator('li[data-row]')).toHaveCount(5)
  await resources.getByRole('button', { name: 'Show all 23' }).tap()
  await expect(resources.locator('li[data-row]')).toHaveCount(23)

  // The long name keeps its end, the note its three lines, and nothing is wider than the phone.
  const nodes = page.getByRole('region', { name: 'Nodes', exact: true })
  await expect(nodes.locator('li[data-row]').first().locator('[title] [aria-hidden]')).toHaveText(
    /…1c9aa7$/,
  )
  await expect(nodes.locator('li[data-row]').nth(1)).toContainText('Ready · 4 cores')
  const note = page
    .getByRole('region', { name: 'Waiting for a node', exact: true })
    .getByText(/^0\/9 nodes are available: 3 Insufficient memory/)
  expect(
    Math.round(
      await note.evaluate(
        (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
      ),
    ),
  ).toBe(3)
  // Side by side, a cell with nothing keeps its place: every card's facts are under the same names.
  await expect(
    certificates.locator('li[data-row]').filter({ hasText: 'payments-tls' }).locator('dd'),
  ).toHaveText(['Failed', '—', '88d'])
  // The four states say the same as on a desk.
  await expect(
    page.getByRole('region', { name: 'Forbidden certificates' }).getByRole('alert'),
  ).toContainText('Couldn’t list certificates')
  await expect(page.getByRole('region', { name: 'Nothing waiting' })).toContainText(
    'No pods are waiting for a node.',
  )
  // A row with a cell more than there are columns is a card of its columns' facts, no more.
  await expect(
    page
      .getByRole('region', { name: 'Waiting for a node', exact: true })
      .locator('li[data-row]')
      .filter({ hasText: 'reports-nightly-28931' })
      .locator('dt'),
  ).toHaveText(['Waiting'])
  await expect(page.getByText('one cell too many')).toHaveCount(0)
  await expectNoSidewaysScroll(page, 'the kit’s tables, on a phone')
  await expectFingerSized(page, 'the kit’s tables, on a phone')
})
