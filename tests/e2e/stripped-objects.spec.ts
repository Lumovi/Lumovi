/**
 * No view trusts a field the API doesn't require (LMV-229): every kind's object, stripped to its
 * name and namespace (and a custom resource's to an empty spec and status), is listed, opened, and
 * each of its tabs shown (its Map among them), and the pages that gather many kinds draw with all of
 * them there, the Map's among them; none shows the crash view.
 */
import type { Page } from '@playwright/test'
import { BUILTIN_KINDS, type ResourceDefinition } from '../../src/shared/resources.ts'
import { CONTEXTS, expect, openCluster, test } from './fixtures.ts'

const NAME = 'stripped'
const NAMESPACE = 'shop'
const CRASHED = /couldn’t be displayed|Something went wrong/

async function served(page: Page): Promise<ResourceDefinition[]> {
  const result = await page.evaluate(
    (context) => window.lumovi!.kube.resources(context),
    CONTEXTS.demo,
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

// (A CRD stays whole: the cluster serves custom resources from what it says.)
const listed = (r: ResourceDefinition) => r.kind !== 'CustomResourceDefinition.apiextensions.k8s.io'
const builtin = (r: ResourceDefinition) => (BUILTIN_KINDS as readonly string[]).includes(r.kind)

const go = (page: Page, hash: string) => page.evaluate((h) => (location.hash = h), hash)

/** Opens a kind's list, its stripped object in the panel, and each of the panel's tabs. */
async function openEach(page: Page, r: ResourceDefinition) {
  // (After a crash of the whole window, it's loaded again for the next kind.)
  if (await page.getByText('Something went wrong').isVisible()) {
    await page.reload()
    await openCluster(page)
  }
  const namespace = r.namespaced ? NAMESPACE : ''
  const path = builtin(r)
    ? `#/cluster/${CONTEXTS.demo}/${r.plural}`
    : `#/cluster/${CONTEXTS.demo}/r/${encodeURIComponent(r.kind)}`
  await go(page, `${path}?open=${encodeURIComponent(`${r.kind}/${namespace}/${NAME}`)}`)
  const panel = page.getByRole('complementary', { name: `${r.apiKind} ${NAME}` })
  const crashed = page.getByText(CRASHED)
  // (Soft: every kind is tried, and each that crashes is named.)
  await expect
    .soft(page.getByRole('main').getByText(NAME, { exact: true }).first(), `${r.kind}: its list`)
    .toBeVisible()
  // Drawn: its overview says when it was made, as every object's does. (Read under load, a get
  // can take a while: a crash shows at once, so waiting longer hides none.)
  await expect
    .soft(panel.getByText('Created', { exact: true }), `${r.kind}: its overview`)
    .toBeVisible({ timeout: 30_000 })
  if ((await crashed.count()) > 0) return
  for (const name of await panel.getByRole('tab').allTextContents()) {
    await panel.getByRole('tab', { name, exact: true }).click()
    await expect.soft(panel.getByRole('tabpanel'), `${r.kind}: ${name}`).toBeVisible()
    if ((await crashed.count()) > 0) {
      expect.soft(await crashed.count(), `${r.kind}: ${name}`).toBe(0)
      return
    }
  }
  await expect.soft(crashed, r.kind).toHaveCount(0)
}

const CATEGORIES = [
  [
    'cluster and workloads',
    (r: ResourceDefinition) => builtin(r) && ['cluster', 'workloads'].includes(r.category!),
  ],
  [
    'network, config, storage and access',
    (r: ResourceDefinition) => builtin(r) && !['cluster', 'workloads'].includes(r.category!),
  ],
  ['custom resources, and kinds the sidebar doesn’t list', (r: ResourceDefinition) => !builtin(r)],
] as const

for (const [title, picked] of CATEGORIES) {
  test(`${title}: stripped to what the API requires, each is listed, opened and its tabs shown`, async ({
    page,
    clusters,
  }) => {
    test.setTimeout(240_000)
    await openCluster(page)
    const kinds = (await served(page)).filter((r) => listed(r) && picked(r))
    expect(kinds.length).toBeGreaterThan(3)
    for (const r of kinds) {
      clusters.demo.upsert({
        apiVersion: r.group ? `${r.group}/${r.version}` : r.version,
        kind: r.apiKind,
        metadata: { name: NAME, ...(r.namespaced ? { namespace: NAMESPACE } : {}) },
        ...(builtin(r) ? {} : { spec: {}, status: {} }),
      })
    }
    for (const r of kinds) await openEach(page, r)
  })
}

test('every kind stripped at once: the pages that gather many kinds draw, and so does search', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  for (const r of (await served(page)).filter(listed)) {
    clusters.demo.upsert({
      apiVersion: r.group ? `${r.group}/${r.version}` : r.version,
      kind: r.apiKind,
      metadata: { name: NAME, ...(r.namespaced ? { namespace: NAMESPACE } : {}) },
      ...(builtin(r) ? {} : { spec: {}, status: {} }),
    })
  }
  const pages: [string, string][] = [
    ['', 'Overview'],
    ['/workloads', 'Workloads'],
    ['/metrics', 'Metrics'],
    ['/metrics/right-sizing', 'Metrics'],
    ['/alerts', 'Alerts'],
    ['/events', 'Events'],
    [`/search?q=${NAME}`, 'Search'],
  ]
  for (const [path, heading] of pages) {
    await go(page, `#/cluster/${CONTEXTS.demo}${path}`)
    await expect.soft(page.getByRole('heading', { level: 1 }), path).toHaveText(heading)
    await expect.soft(page.getByText(CRASHED), path).toHaveCount(0)
  }
  // Search finds each of them, and draws its row.
  await expect(page.getByRole('main').getByText(NAME, { exact: true }).first()).toBeVisible()
  await expect(page.getByText(CRASHED)).toHaveCount(0)
  // The Map, by each grouping, and as a list.
  await go(page, `#/cluster/${CONTEXTS.demo}/map?namespaces=${NAMESPACE}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Map')
  for (const grouping of ['namespace', 'node', 'app']) {
    await page.getByRole('combobox', { name: 'Group by' }).selectOption(grouping)
    await expect.soft(page.getByRole('main').getByRole('region').first(), grouping).toBeVisible()
    await expect.soft(page.getByText(CRASHED), grouping).toHaveCount(0)
  }
  await page.getByRole('button', { name: 'As a list' }).click()
  await expect(page.getByRole('table', { name: 'Map' })).toContainText(NAME)
  await expect(page.getByText(CRASHED)).toHaveCount(0)
})
