/**
 * Several clusters in one list on a server's fleet: a group's Open together opens the clusters
 * the person may see, each read as them, with their access on it; one that doesn't answer is
 * said on its chip while the others' rows are listed.
 */
import { FLEET } from '../mock-cluster/fleet.ts'
import { expect, test } from './fixtures.ts'
import { as, card, fleetEnv } from './fleet.ts'

test('a group’s Open together lists its clusters’ pods in one list, each read as the person', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: fleetEnv(clusters) })
  await as(context, 'ana@example.com')
  await page.goto(`${served.url}?group=env`)
  // Staging is alone in its group: nothing to open together there.
  await expect(
    page.getByRole('region', { name: 'staging' }).getByRole('button', { name: 'Open together' }),
  ).toHaveCount(0)
  await page
    .getByRole('region', { name: 'production' })
    .getByRole('button', { name: 'Open together' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 3 clusters')
  const strip = page.getByRole('group', { name: 'Clusters' })
  await expect(strip.locator(`[data-cluster="${FLEET.edge}"]`)).toContainText(
    'didn’t answer in time',
    { timeout: 20_000 },
  )
  await expect(strip).toContainText('2 of 3 answered')
  const grid = page.getByRole('grid', { name: 'Pods' })
  await expect(grid.getByRole('row').filter({ hasText: FLEET.prodEu }).first()).toBeVisible()
  await expect(grid.getByRole('row').filter({ hasText: FLEET.prodUs }).first()).toBeVisible()
  // Each cluster's list, read as the person there.
  for (const cluster of [clusters.demo, clusters.large]) {
    const reads = cluster.requests.filter((r) => r.method === 'GET' && /\/pods$/.test(r.path))
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read.headers['impersonate-user']).toBe('ana@example.com')
  }
})

test('on a fleet, Several clusters ticks cards: a click or Space ticks, Enter opens the ticked ones, Esc leaves', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: fleetEnv(clusters) })
  await as(context, 'ana@example.com')
  await page.goto(served.url)
  await expect(card(page, FLEET.prodEu)).toBeVisible()
  // No way to open everything shown at once: only a group's heading, or ticks.
  await expect(page.getByRole('button', { name: 'Open together' })).toHaveCount(0)
  const toggle = page.getByRole('button', { name: 'Several clusters' })
  await toggle.click()
  const ticks = (name: string) => page.getByRole('checkbox', { name: new RegExp(`^${name}, `) })
  await ticks(FLEET.prodEu).click()
  await ticks(FLEET.staging).click()
  const bar = page.getByRole('toolbar', { name: 'Clusters ticked' })
  await expect(bar).toContainText('2 clusters')
  await expect(ticks(FLEET.prodEu)).toHaveAttribute('aria-checked', 'true')
  // A click ticks: nothing opened.
  await expect(page).toHaveURL(served.url)
  await page.keyboard.press('Escape')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(bar).toHaveCount(0)
  await expect(card(page, FLEET.prodEu)).toHaveAttribute('href', /cluster\/prod-eu/)

  // By the keyboard: Space ticks the card with the focus, Enter opens the ticked ones.
  await toggle.click()
  await ticks(FLEET.prodUs).focus()
  await page.keyboard.press('Space')
  await ticks(FLEET.staging).focus()
  await page.keyboard.press('Space')
  await expect(bar).toContainText('2 clusters')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods · 2 clusters')
  await expect(page).toHaveURL(/c=prod-us&c=staging$/)
})
