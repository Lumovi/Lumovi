/**
 * Search on a server (LMV-171): the same page, through the person's own reads; saved searches
 * the person's, wherever they sign in from; on a phone, two-line rows and the chips, no keys.
 */
import { expect, test } from './fixtures.ts'
import { as } from './fleet.ts'
import { PHONE } from './phone.ts'
import { lockedSettings } from '../../src/server/preferences.ts'

test('on a server, Search finds by name and label, and a saved search follows the person', async ({
  page,
  context,
  browser,
  serve,
}) => {
  // Saved searches are the person's: not a setting whoever runs the server sets.
  expect(() => lockedSettings('{"searches": ["app=web"]}')).toThrow(
    'LUMOVI_SETTINGS: searches isn’t a setting an organization sets.',
  )
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  await as(context, 'alice@example.com', 'developers')
  // Secrets too, where they're shown, in the namespace picked.
  await page.goto(`${served.url}cluster/demo/search?q=postgres&namespaces=data`)
  await expect(
    page
      .getByRole('table', { name: 'Found' })
      .getByRole('rowgroup', { name: 'Secrets', exact: true }),
  ).toContainText('postgres-credentials')
  await page.goto(`${served.url}cluster/demo/search?q=checkout`)
  const found = page.getByRole('table', { name: 'Found' })
  await expect(found.getByRole('rowgroup', { name: 'Deployments', exact: true })).toContainText(
    'checkout',
  )
  await page.getByRole('button', { name: 'Save this search' }).click()
  await expect(page.getByRole('list', { name: 'Saved searches' })).toContainText('checkout')

  // Another browser, the same person: the search saved, on the page before typing.
  const elsewhere = await browser.newContext()
  await as(elsewhere, 'alice@example.com', 'developers')
  const again = await elsewhere.newPage()
  await again.goto(`${served.url}cluster/demo/search`)
  await expect(again.getByRole('region', { name: 'Saved searches' })).toContainText('checkout')
  await elsewhere.close()
})

test('on a phone, Search is in the menu, its rows two lines, its saved searches chips without keys', async ({
  page,
  context,
  serve,
}) => {
  await page.setViewportSize(PHONE)
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  await as(context, 'alice@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo/search?q=app.kubernetes.io/name=checkout`)
  const deployments = page.getByRole('rowgroup', { name: 'Deployments', exact: true })
  // Name; namespace and age; the label that matched; its status.
  await expect(deployments.getByRole('row').filter({ hasText: 'shop ·' })).toContainText(
    'app.kubernetes.io/name=checkout',
  )
  await page.getByRole('button', { name: 'Save this search' }).click()
  const chips = page.getByRole('list', { name: 'Saved searches' })
  await expect(chips).toContainText('app.kubernetes.io/name=checkout')
  await expect(chips.locator('kbd')).toHaveCount(0)
  // Before typing, the chips still show on a phone.
  await page.goto(`${served.url}cluster/demo/search`)
  await expect(chips).toContainText('app.kubernetes.io/name=checkout')
  await page.goto(`${served.url}cluster/demo/search?q=app.kubernetes.io/name=checkout`)
  // A row opens the object.
  await deployments.getByRole('row').filter({ hasText: 'shop ·' }).first().click()
  await expect(page.getByRole('heading', { name: 'checkout', level: 2 })).toBeVisible()
})
