/**
 * A Secret's value on a plugin's page, on a phone and on a server whose access decides what a
 * person may see: what a press comes back with there. No value is asserted on or printed.
 */
import { as } from './fleet.ts'
import { expect, test } from './fixtures.ts'
import { expectFingerSized, expectNoSidewaysScroll, PHONE } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

/** Developers see only the keys of the shop's Secrets, and no Secrets in data. */
const POLICY = `
everyone: { changes: read, shells: false, nodeShells: false, logs: true, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
profiles:
  - id: developer
    name: Developer
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: upgrade, assistants: self, audit: own }
grants:
  - { id: shop, name: Developers run the shop, who: [dev], profile: developer, namespaces: [shop, data] }
limits:
  - { id: data, name: Data stays put, namespaces: [data], caps: { secrets: hidden } }
  - { id: shop, name: Card data, namespaces: [shop], caps: { secrets: keys } }
`

test('a Secret’s value on a phone, under a server’s access: hidden by it, or not allowed', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_ACCESS: POLICY } })
  await as(context, 'dave@example.com', 'developers')
  await page.goto(`${served.url}cluster/demo/kit/shown`)
  const card = page.getByRole('region', { name: 'Storefront certificate' })
  await expect(card).toBeVisible()
  // The caption stands under the title on a phone; the Secret's own name under that.
  await expect(card.getByRole('paragraph').first()).toHaveText(
    'Shown by Lumovi. Sample plugin can’t see it.',
  )
  await expect(card).toContainText('Secret storefront-tls in shop')
  // Nothing was read as the page opened.
  expect(clusters.demo.requests.filter((r) => /\/secrets(\/|$)/.test(r.path)).length).toBe(0)
  await expectNoSidewaysScroll(page, 'a Secret’s card, on a phone')
  await expectFingerSized(page, 'a Secret’s card, on a phone')

  // Where the person's access shows only a Secret's keys, that's what a press comes back with:
  // no value arrives, and the box says so with no buttons left.
  const box = card.getByRole('group', { name: 'tls.crt', exact: true })
  await box.getByRole('button', { name: 'Reveal tls.crt' }).tap()
  await expect(box).toHaveText(/Value hidden by your access$/)
  await expect(box.getByRole('button')).toHaveCount(0)
  // Reveal all asks for the rest: a key it has says the same, a key it doesn't have says that
  // (which keys a Secret has is theirs to know here), and there's nothing left to press.
  await card.getByRole('button', { name: 'Reveal all' }).tap()
  await expect(card.getByText('Value hidden by your access')).toHaveCount(2)
  await expect(card).toContainText('Secret storefront-tls in shop has no key named token.')
  await expect(card.getByRole('button')).toHaveCount(0)

  // Where it hides Secrets, the press is refused, and the card says so in place of its boxes.
  const password = page.getByRole('region', { name: 'Database password' })
  await password.getByRole('button', { name: 'Copy password' }).tap()
  await expect(password).toContainText(
    'Your account isn’t allowed to read this Secret. Sample plugin’s page asks Lumovi to show it here.',
  )
  await expect(password.getByRole('group')).toHaveCount(0)
  // Refused by Lumovi, before the cluster was asked for it.
  expect(
    clusters.demo.requests.filter((r) => r.path.endsWith('/secrets/postgres-credentials')).length,
  ).toBe(0)
  await expectNoSidewaysScroll(page, 'a Secret’s card after its presses, on a phone')
})
