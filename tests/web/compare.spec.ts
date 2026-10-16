/**
 * Compare on a server's fleet: each side read as the person, with their access on its cluster.
 * Where one side's access shows only Secrets' keys, a Secret's values aren't compared at all:
 * its keys are, each value said "not compared", and nothing tells whether the values match.
 */
import { checkout } from '../mock-cluster/fixtures/checkout.ts'
import { FLEET } from '../mock-cluster/fleet.ts'
import { audited, expect, test } from './fixtures.ts'
import { as, fleetEnv } from './fleet.ts'

/** Everyone sees Secrets' values, but on staging, where only their keys. */
const ACCESS = `
everyone: { changes: read, shells: off, nodeShells: off, logs: on, secrets: values, helm: off, assistants: off, audit: own }
limits:
  - { id: keys, name: Staging's Secrets, who: [], clusters: [${FLEET.staging}], namespaces: [], caps: { secrets: keys } }
`

const comparing = (served: { url: string }, kind: string, name: string) =>
  `${served.url}cluster/${FLEET.prodEu}/compare?${new URLSearchParams({
    lc: FLEET.prodEu,
    l: `${kind}/shop/${name}`,
    rc: FLEET.staging,
    r: `${kind}/shop/${name}`,
  })}`

test('on a fleet, where one side’s access shows only Secrets’ keys, their values aren’t compared: only their keys are', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  checkout(clusters.demo, 'shop', {
    image: 'a:1',
    replicas: 3,
    url: 'https://payments.prod.internal',
    password: 'prod-password',
  })
  checkout(clusters.sandbox, 'shop', {
    image: 'a:2',
    replicas: 3,
    url: 'https://payments.staging.internal',
    password: 'staging-password',
  })
  // One key more on staging.
  const staging = clusters.sandbox.object('Secret', 'shop', 'checkout-db')!
  clusters.sandbox.upsert({
    ...staging,
    data: { ...(staging.data as object), 'readonly-password': btoa('readonly') },
  })
  const served = await serve({ env: { ...fleetEnv(clusters), LUMOVI_ACCESS: ACCESS } })
  await as(context, 'ana@example.com')

  // The Secret itself.
  await page.goto(comparing(served, 'Secret', 'checkout-db'))
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compare')
  await expect(
    page.getByText(/^Values not compared: your access on staging shows only Secrets’ keys/),
  ).toBeVisible()
  const diff = page.getByLabel('Differences', { exact: true })
  await expect(diff).toContainText('readonly-password: not compared')
  await expect(diff).toContainText('password: not compared')
  // Its keys both sides have: never a changed line, whatever their values are.
  await expect(diff.locator('[data-change="removed"]')).toHaveCount(0)
  await expect(diff.locator('[data-change="added"]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Reveal values' })).toHaveCount(0)
  const content = await page.content()
  for (const value of [
    'prod-password',
    'staging-password',
    btoa('prod-password'),
    btoa('staging-password'),
    btoa('readonly'),
  ]) {
    expect(content).not.toContain(value)
  }
  // Read on each side's own cluster, as opening it there is: recorded there, keys only too.
  await expect
    .poll(() =>
      audited(served, 'secret.read')
        .filter((event) => event.target?.name === 'checkout-db')
        .map((event) => event.cluster)
        .sort(),
    )
    .toEqual([FLEET.prodEu, FLEET.staging].sort())

  // A workload's Secret, among its config: keys only, and why.
  await page.goto(comparing(served, 'Deployment', 'checkout'))
  const config = page.getByRole('region', { name: 'Config it references' })
  await expect(config.getByRole('button', { name: /checkout-db/ })).toContainText(
    'Keys only · +1 key',
  )
  await expect(config.getByRole('button', { name: /checkout-config/ })).toContainText('−1 +1')
  await config.getByRole('button', { name: /checkout-db/ }).click()
  await expect(config).toContainText(
    'Values not compared: your access on staging shows only Secrets’ keys.',
  )
  expect(await page.content()).not.toContain(btoa('staging-password'))
})
