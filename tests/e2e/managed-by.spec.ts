/**
 * What manages a workload, as plugins say it (`manages` in a view): a column of the workloads'
 * lists and a line in a workload's overview, each opening the manager. Here with plugins of the
 * test's own in place of Lumovi's Flux and Argo CD, whose files say it the way those tools do.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

/** Flux: what a Kustomization applies carries its name and namespace as labels. */
const FLUX = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: flux }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [kustomize.toolkit.fluxcd.io]
  label: Flux
  icon: git-merge
  kinds: [{ group: kustomize.toolkit.fluxcd.io, kind: Kustomization }]
  views:
    - kinds: [{ group: kustomize.toolkit.fluxcd.io, kind: Kustomization }]
      manages:
        - labels:
            kustomize.toolkit.fluxcd.io/name: '{{ .metadata.name }}'
            kustomize.toolkit.fluxcd.io/namespace: '{{ .metadata.namespace }}'
        # A field a Kustomization may have empty, or not at all: then it says nothing.
        - labels:
            kustomize.toolkit.fluxcd.io/owner: 'team-{{ .spec.owner }}'
        # A field whoever makes a Kustomization writes as they like.
        - labels:
            kustomize.toolkit.fluxcd.io/source: '{{ .spec.path }}'
`

/**
 * Argo CD: what an Application applies carries its tracking id, naming the Application (with its
 * namespace before it, where it isn't in Argo CD's own) and the object itself.
 */
const ARGO_CD = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: argo-cd }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [argoproj.io]
  label: Argo CD
  icon: git-branch
  kinds: [{ group: argoproj.io, kind: Application }]
  views:
    - kinds: [{ group: argoproj.io, kind: Application }]
      manages:
        - annotations:
            argocd.argoproj.io/tracking-id: '{{ .metadata.name }}:{{ object.group }}/{{ object.kind }}:{{ object.namespace }}/{{ object.name }}'
        - annotations:
            argocd.argoproj.io/tracking-id: '{{ .metadata.namespace }}_{{ .metadata.name }}:{{ object.group }}/{{ object.kind }}:{{ object.namespace }}/{{ object.name }}'
`

const TRACKING = 'argocd.argoproj.io/tracking-id'
const { storefront, checkout, cart, recommendations } = DEMO.deployments
const { ready: apps } = CUSTOM.kustomizations
const { healthy: application } = CUSTOM.applications
const { argocd, flux } = CUSTOM.namespaces
const APPLIED_BY_APPS = {
  'kustomize.toolkit.fluxcd.io/name': apps,
  'kustomize.toolkit.fluxcd.io/namespace': flux,
}
/** Where Lumovi marks the managed object's name in a manager's values (MANAGING_MARK). */
const NAME_MARK = '\uE000o\uE000'

/** A deployment in shop, as the mock cluster has it (or `as` another), given labels and annotations. */
function marked(
  cluster: MockCluster,
  name: string,
  labels: Record<string, string>,
  annotations: Record<string, string> = {},
  as = name,
) {
  const object = structuredClone(cluster.object('Deployment', 'shop', name)!) as KubeObject
  object.metadata.name = as
  if (as !== name) {
    // Another deployment: nothing in its row says the one it's made from.
    object.metadata.uid = `${object.metadata.uid}-${as}`
    const containers = object.spec.template.spec.containers as { name: string; image: string }[]
    object.spec.template.spec.containers = containers.map((container) => ({
      ...container,
      name: as,
      image: `${as}:1`,
    }))
  }
  object.metadata.labels = { ...object.metadata.labels, ...labels }
  object.metadata.annotations = { ...object.metadata.annotations, ...annotations }
  cluster.upsert(object)
}

/** A Kustomization in flux-system with `spec`. */
const kustomization = (cluster: MockCluster, name: string, spec: Record<string, unknown>) =>
  cluster.upsert({
    apiVersion: 'kustomize.toolkit.fluxcd.io/v1',
    kind: 'Kustomization',
    metadata: { name, namespace: flux, creationTimestamp: new Date().toISOString() },
    spec,
  })

const deployment = (page: Page, name: string) => row(page, 'Deployments', name)
const managedBy = (page: Page, name: string) =>
  deployment(page, name)
    .getByRole('gridcell')
    .filter({ has: page.getByRole('button') })
    // (Not the row's pin, the other cell with a button.)
    .filter({ hasNot: page.getByRole('button', { name: /^(Pin|Unpin) .* the sidebar$/ }) })
/** Opens a row's object, by a cell that's no link or box of its own. */
const opened = (page: Page, name: string) =>
  deployment(page, name).getByRole('gridcell').nth(1).click()

test('a workload says what manages it, and opens it; nothing, where nothing that’s there does', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'flux.yaml'), FLUX)
  writeFileSync(join(plugins, 'argo-cd.yaml'), ARGO_CD)
  // Applied by Flux's Kustomization apps.
  marked(clusters.demo, storefront, APPLIED_BY_APPS)
  // By Argo CD's Application of the same name as storefront, in Argo CD's namespace.
  marked(
    clusters.demo,
    checkout,
    {},
    { [TRACKING]: `${application}:apps/Deployment:shop/${checkout}` },
  )
  // A copy of storefront's manifest: its tracking id names storefront, not cart.
  marked(
    clusters.demo,
    cart,
    {},
    { [TRACKING]: `${application}:apps/Deployment:shop/${storefront}` },
  )
  // Both claim it.
  marked(clusters.demo, recommendations, APPLIED_BY_APPS, {
    [TRACKING]: `${application}:apps/Deployment:shop/${recommendations}`,
  })
  // A Kustomization that isn't there (any more); one whose owner is empty; and one whose path
  // holds the mark Lumovi finds the managed object's name by.
  kustomization(clusters.demo, 'ownerless', { owner: '', path: './ownerless' })
  kustomization(clusters.demo, 'forged', { path: NAME_MARK })
  marked(
    clusters.demo,
    cart,
    {
      'kustomize.toolkit.fluxcd.io/name': 'gone',
      'kustomize.toolkit.fluxcd.io/namespace': flux,
      'kustomize.toolkit.fluxcd.io/owner': 'team-',
      'kustomize.toolkit.fluxcd.io/source': 'orphan',
    },
    {},
    'orphan',
  )
  await openCluster(page)
  await goTo(page, 'Deployments')
  await expect(page.getByRole('columnheader', { name: 'Managed by' })).toBeVisible()
  await expect(deployment(page, storefront).getByRole('button', { name: apps })).toBeVisible()
  await expect(deployment(page, checkout).getByRole('button', { name: application })).toBeVisible()
  await expect(managedBy(page, recommendations)).toContainText('+1')
  for (const name of [cart, 'orphan']) {
    await expect(deployment(page, name)).toBeVisible()
    await expect(managedBy(page, name), name).toHaveCount(0)
    await expect(deployment(page, name)).toContainText('—')
  }
  // Its name opens it, and not the row's own object.
  await deployment(page, storefront).getByRole('button', { name: apps }).click()
  await expect(panel(page, 'Kustomization', apps)).toBeVisible()
  await expect(panel(page, 'Deployment', storefront)).toHaveCount(0)

  // The workload's overview says so too, and opens it.
  await opened(page, checkout)
  const overview = panel(page, 'Deployment', checkout)
  await expect(overview).toContainText(
    `Application ${argocd}/${application} manages this deployment, and may undo changes made to it any other way.`,
  )
  await overview.getByRole('button', { name: `Application ${argocd}/${application}` }).click()
  await expect(panel(page, 'Application', application)).toBeVisible()
  await page.keyboard.press('Escape')
  // Two managers: a line each.
  await opened(page, recommendations)
  for (const manager of [`Kustomization ${flux}/${apps}`, `Application ${argocd}/${application}`]) {
    await expect(panel(page, 'Deployment', recommendations)).toContainText(
      `${manager} manages this deployment, and may undo changes made to it any other way.`,
    )
  }
  await page.keyboard.press('Escape')

  // An Application of that name in another namespace: the short id can't tell which, so it's
  // said by its name, and opens the Applications of that name. The long id names one.
  clusters.demo.upsert({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name: application, namespace: 'shop', creationTimestamp: new Date().toISOString() },
    spec: { project: 'default' },
  })
  marked(
    clusters.demo,
    cart,
    {},
    { [TRACKING]: `shop_${application}:apps/Deployment:shop/${cart}` },
  )
  await expect(deployment(page, cart).getByRole('button', { name: application })).toBeVisible()
  await opened(page, cart)
  await expect(panel(page, 'Deployment', cart)).toContainText(
    `Application shop/${application} manages this deployment`,
  )
  await page.keyboard.press('Escape')
  await opened(page, checkout)
  await expect(panel(page, 'Deployment', checkout)).toContainText(
    `Applications ${argocd}/${application} and shop/${application} manage this deployment`,
  )
  await page.keyboard.press('Escape')
  await deployment(page, checkout).getByRole('button', { name: application }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Applications')
  await expect(page.getByPlaceholder('Filter Applications')).toHaveValue(application)

  // All of them, on Workloads too.
  await goTo(page, 'Workloads')
  await expect(row(page, 'Workloads', storefront).getByRole('button', { name: apps })).toBeVisible()
})

test('who may not list a manager’s kind in the whole cluster: its namespaces in view are read, or nothing is said', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'argo-cd.yaml'), ARGO_CD)
  // Managed by an Application beside it, in shop.
  clusters.demo.upsert({
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    metadata: { name: 'shop-apps', namespace: 'shop', creationTimestamp: new Date().toISOString() },
    spec: { project: 'default' },
  })
  marked(
    clusters.demo,
    checkout,
    {},
    { [TRACKING]: `shop_shop-apps:apps/Deployment:shop/${checkout}` },
  )
  clusters.demo.fail('/apis/argoproj.io/v1alpha1/applications', {
    status: 403,
    body: JSON.stringify({
      kind: 'Status',
      reason: 'Forbidden',
      message:
        'applications.argoproj.io is forbidden: cannot list resource "applications" at the cluster scope',
      code: 403,
    }),
  })
  await openCluster(page)
  await goTo(page, 'Deployments')
  // Every namespace: none can be read, and nothing says so but an empty column.
  await expect(page.getByRole('columnheader', { name: 'Managed by' })).toBeVisible()
  await expect(deployment(page, checkout)).toBeVisible()
  await expect(managedBy(page, checkout)).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  // In shop, shop's are read.
  await page.getByLabel('Namespace', { exact: true }).click()
  await page.getByRole('option', { name: 'shop', exact: true }).click()
  await expect(deployment(page, checkout).getByRole('button', { name: 'shop-apps' })).toBeVisible()
  expect(
    clusters.demo.requests.some(
      (r) => r.path === '/apis/argoproj.io/v1alpha1/namespaces/shop/applications',
    ),
  ).toBe(true)
})

test('without a plugin that says what manages workloads, there’s no column, and no manager is read', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  // (Lumovi's own Flux and Argo CD say it: in their place, the test's, saying nothing of it.)
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  const silent = (file: string) => file.slice(0, file.indexOf('  views:'))
  writeFileSync(join(plugins, 'flux.yaml'), silent(FLUX))
  writeFileSync(join(plugins, 'argo-cd.yaml'), silent(ARGO_CD))
  marked(clusters.demo, storefront, {
    'kustomize.toolkit.fluxcd.io/name': apps,
    'kustomize.toolkit.fluxcd.io/namespace': CUSTOM.namespaces.flux,
  })
  await openCluster(page)
  await goTo(page, 'Deployments')
  await expect(deployment(page, storefront)).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Managed by' })).toHaveCount(0)
  await opened(page, storefront)
  await expect(panel(page, 'Deployment', storefront)).toContainText('Details')
  await expect(panel(page, 'Deployment', storefront)).not.toContainText('manages this deployment')
  expect(clusters.demo.requests.filter((r) => r.path.endsWith('/kustomizations'))).toEqual([])
})
