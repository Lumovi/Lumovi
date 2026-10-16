/**
 * Compare with…: an object beside another of its kind, from another namespace or another
 * cluster. The picker reads a cluster only once it's settled on, and one that signs in through a
 * program only on its own button; the page shows what differs with status and what the cluster
 * set left out until asked, a side that can't be read said on its card, Secrets' values masked
 * until revealed, and a workload's config paired by where it's referenced.
 */
import type { Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holds } from '../holds.ts'
import { checkout } from '../mock-cluster/fixtures/checkout.ts'
import { finding, KIND, report, REPORT, scanned, SECRET } from '../mock-cluster/fixtures/trivy.ts'
import { CONTEXTS, expect, openCluster, panel, row, test } from './fixtures.ts'

const go = (page: Page, hash: string) =>
  page.evaluate((to) => {
    window.location.hash = to
  }, hash)

const picker = (page: Page) => page.getByRole('dialog', { name: /^Compare checkout with/ })
const clusterList = (page: Page) => picker(page).getByRole('radiogroup', { name: 'Cluster' })
const differencesOf = (page: Page) => page.getByLabel('Differences', { exact: true })

/** Opens checkout in the shop and Compare with… from its More actions. */
async function compareFrom(page: Page) {
  await go(page, '#/cluster/demo/deployments?namespaces=shop')
  await row(page, 'Deployments', 'checkout').click()
  const detail = panel(page, 'Deployment', 'checkout')
  await detail.getByRole('button', { name: 'More actions' }).click()
  const menu = page.getByRole('menu')
  // Read-only, beside Copy link, above what changes it.
  await expect(menu.getByRole('menuitem').nth(1)).toHaveText('Compare with…')
  await menu.getByRole('menuitem', { name: 'Compare with…' }).click()
  await expect(picker(page)).toBeVisible()
}

test('the same Deployment in another cluster: what differs, status and what the cluster set left out until shown, and its config pair by pair', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  checkout(clusters.demo, 'shop', {
    image: 'ghcr.io/acme/checkout:1.14.0',
    replicas: 6,
    url: 'https://payments.prod.internal',
    password: 'prod-password',
  })
  checkout(clusters.sandbox, 'shop', {
    image: 'ghcr.io/acme/checkout:1.15.0-rc.2',
    replicas: 2,
    url: 'https://payments.staging.internal',
    password: 'staging-password',
  })
  await openCluster(page)
  await compareFrom(page)
  // This one first; the sandbox's checkout picked by its name once the sandbox is.
  await expect(clusterList(page).getByRole('radio').first()).toBeChecked()
  await clusterList(page).getByText(CONTEXTS.sandbox, { exact: true }).click()
  const objects = picker(page).getByRole('radiogroup', { name: 'Deployment' })
  await expect(objects.getByRole('radio', { checked: true })).toBeVisible()
  await expect(objects).toContainText('Same name')
  await picker(page).getByRole('button', { name: 'Compare', exact: true }).click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compare')
  const diff = differencesOf(page)
  await expect(diff).toContainText('replicas: 6')
  await expect(diff).toContainText('replicas: 2')
  await expect(diff).toContainText('image: ghcr.io/acme/checkout:1.15.0-rc.2')
  // Left out: its status, its uid, its versions and times.
  for (const noise of [
    'availableReplicas',
    'uid:',
    'resourceVersion',
    'creationTimestamp',
    'generation',
  ]) {
    await expect(diff).not.toContainText(noise)
  }
  await expect(page.getByText(/lines of status and cluster-set fields left out/)).toBeVisible()
  // Shown, on asking: remembered for the next comparison.
  await page.getByRole('switch', { name: 'Show status and cluster-set fields' }).click()
  await expect(diff).toContainText('availableReplicas: 6')
  await expect(diff).toContainText('uid: d-shop-ghcr.io/acme/checkout:1.14.0')

  await page.getByRole('switch', { name: 'Show status and cluster-set fields' }).click()
  await expect(diff).not.toContainText('availableReplicas')

  // Its config: the ConfigMap's change as a pair of its own; the Secret's values masked.
  const config = page.getByRole('region', { name: 'Config it references' })
  await expect(config).toContainText('2 pairs')
  await config.getByRole('button', { name: /checkout-config/ }).click()
  await expect(page.getByLabel('Differences of checkout-config')).toContainText(
    'PAYMENTS_URL: https://payments.staging.internal',
  )
  await config.getByRole('button', { name: /checkout-db/ }).click()
  const secret = page.getByLabel('Differences of checkout-db')
  await expect(secret).toContainText('password:')
  // A changed value is a changed line, masked on both sides; nothing of either value shows.
  await expect(secret.locator('[data-change="removed"]')).toHaveCount(1)
  await expect(secret.locator('[data-change="added"]')).toHaveCount(1)
  for (const value of [
    'prod-password',
    'staging-password',
    btoa('prod-password'),
    btoa('staging-password'),
  ]) {
    expect(await page.content()).not.toContain(value)
  }
  await config.getByRole('button', { name: 'Reveal values' }).click()
  await expect(secret).toContainText(btoa('staging-password'))
})

test('across namespaces in one cluster, and a side that can’t be read said on its card, the other still shown', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  checkout(clusters.demo, 'shop', { image: 'a:1', replicas: 3, url: 'u', password: 'p' })
  checkout(clusters.demo, 'default', { image: 'a:2', replicas: 3, url: 'u', password: 'p' })
  await openCluster(page)
  await compareFrom(page)
  await picker(page).getByRole('combobox', { name: 'Namespace' }).selectOption('default')
  await expect(
    picker(page)
      .getByRole('radiogroup', { name: 'Deployment' })
      .getByRole('radio', { checked: true }),
  ).toBeVisible()
  await picker(page).getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(differencesOf(page)).toContainText('image: a:2')
  // The config is the same both sides.
  await expect(page.getByRole('region', { name: 'Config it references' })).toContainText('The same')

  // The right side gone: said on its card; the left alone, as it is.
  clusters.demo.remove('Deployment', 'default', 'checkout')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByLabel(/^Right: checkout on demo/)).toContainText(
    'It’s gone: checkout no longer exists on demo.',
  )
  await expect(
    page.getByText('Only demo’s side, as it is. Refresh reads demo again.'),
  ).toBeVisible()
})

test('a cluster that signs in through a program is read only on its own button; one that doesn’t answer says so on its line', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  checkout(clusters.demo, 'shop', { image: 'a:1', replicas: 1, url: 'u', password: 'p' })
  await openCluster(page)
  await compareFrom(page)
  const exec = clusterList(page).locator('label').filter({ hasText: CONTEXTS.execMissing })
  await expect(exec).toContainText('Signs in when opened')
  // Picked, by a click and by the arrow keys: nothing is read, and nothing signs in.
  await exec.getByRole('radio').check()
  await expect(picker(page)).toContainText(
    `${CONTEXTS.execMissing} isn’t open. Open it, with the button on its row, to see its namespaces and Deployments.`,
  )
  await expect(exec).not.toContainText('Didn’t answer')
  // A cluster that doesn't answer: its line says so, and the dialog goes on.
  await clusterList(page)
    .locator('label')
    .filter({ hasText: CONTEXTS.offline })
    .getByRole('radio')
    .check()
  await expect(
    clusterList(page).locator('label').filter({ hasText: CONTEXTS.offline }),
  ).toContainText('Didn’t answer in time. Pick it again to try once more.', { timeout: 30_000 })
  await expect(picker(page)).toContainText(
    `${CONTEXTS.offline} didn’t answer in time, so there’s nothing to pick there yet.`,
  )
  await expect(picker(page).getByRole('button', { name: 'Compare', exact: true })).toBeDisabled()
  await picker(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(picker(page)).toHaveCount(0)
})

test('arrowing past clusters reads none of them: a cluster is read only once it’s stayed picked', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  checkout(clusters.demo, 'shop', { image: 'a:1', replicas: 1, url: 'u', password: 'p' })
  checkout(clusters.sandbox, 'shop', { image: 'a:2', replicas: 1, url: 'u', password: 'p' })
  await openCluster(page)
  await compareFrom(page)
  // From this one, past the sandbox (the second) to the third, at a key's pace.
  const before = clusters.sandbox.requests.length
  await clusterList(page).getByRole('radio').first().focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(clusterList(page).getByRole('radio').nth(2)).toBeChecked()
  await holds(
    () => clusters.sandbox.requests.length === before,
    1_000,
    'a cluster arrowed past is read',
  )
  // Picked and left there: read.
  await page.keyboard.press('ArrowUp')
  await expect(
    picker(page)
      .getByRole('radiogroup', { name: 'Deployment' })
      .getByRole('radio', { checked: true }),
  ).toBeVisible()
  expect(clusters.sandbox.requests.length).toBeGreaterThan(before)
})

test('what a plugin’s file withholds is marked on both sides, never compared: the rest is', async ({
  launch,
  clusters,
}) => {
  scanned(clusters.demo)
  // One finding each side, of the same name: another target, another secret.
  clusters.demo.upsert(report(REPORT, [finding(1)]))
  const other = report(REPORT, [{ ...finding(9, `${SECRET}-OTHER`), target: '/app/settings.env' }])
  clusters.demo.upsert({ ...other, metadata: { ...other.metadata, namespace: 'default' } })
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(
    join(folder, 'trivy-operator.yaml'),
    `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: trivy-operator }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: ExposedSecretReport }]
      withholds: [{ path: report.secrets.match }]
`,
  )
  const { page } = await launch({ env: { LUMOVI_TEST_INCLUDED_PLUGINS_DIR: folder } })
  await openCluster(page)
  await go(
    page,
    `#/cluster/demo/compare?${new URLSearchParams({
      lc: 'demo',
      l: `${KIND}/shop/${REPORT}`,
      rc: 'demo',
      r: `${KIND}/default/${REPORT}`,
    })}`,
  )
  const diff = differencesOf(page)
  await expect(diff).toContainText('target: /app/settings.env')
  await expect(diff).toContainText('match: (withheld)')
  // A line that's withheld is never one that differs.
  await expect(
    diff
      .locator('[data-change]:not([data-change="same"]):not([data-change="gap"])')
      .filter({ hasText: 'match' }),
  ).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Fields not compared' })).toHaveText(
    'Withheld by trivy-operator’s file, on both sides: report.secrets[].match isn’t read from either cluster, so it can’t be compared.',
  )
  expect(await page.content()).not.toContain(SECRET)
})
