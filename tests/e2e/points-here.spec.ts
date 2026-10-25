/**
 * What points at an object, as plugins' links say it (`listedThere`): a section of its detail's
 * Overview, grouped by plugin, each with its kind, what it's of and its view's status, opening it.
 * Here with a stand-in for trivy-operator, whose reports name the ReplicaSet a Deployment runs,
 * as Trivy's do: a workload's detail lists them, and a Pod's those of what runs it.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { reportCrd } from '../mock-cluster/fixtures/trivy.ts'
import { DEMO, expect, goTo, openCluster, panel, row, test } from './fixtures.ts'

const STATUS = `      status:
        - when:
            all:
              - { path: .report.summary.criticalCount, exists: true }
              - { path: .report.summary.criticalCount, notEquals: 0 }
          health: critical
          label: '{{ .report.summary.criticalCount }} critical'
        - when:
            all:
              - { path: .report.summary.highCount, exists: true }
              - { path: .report.summary.highCount, notEquals: 0 }
          health: warning
          label: '{{ .report.summary.highCount }} high'
        - health: healthy
          label: No critical or high`

const LINK = `          kind: "{{ .metadata.labels['trivy-operator.resource.kind'] }}"
          objectName: "{{ .metadata.labels['trivy-operator.resource.name'] }}"
          listedThere: true`

/** trivy-operator, as its file would say it: its reports' links listed where they lead. */
const TRIVY = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: trivy-operator }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  label: Trivy
  icon: bug
  kinds:
    - { group: aquasecurity.github.io, kind: VulnerabilityReport }
    - { group: aquasecurity.github.io, kind: ConfigAuditReport }
  views:
    - kinds: [{ group: aquasecurity.github.io, kind: VulnerabilityReport }]
      icon: bug
${STATUS}
      links:
        - name: Workload
${LINK}
          about: "the {{ .metadata.labels['trivy-operator.container.name'] }} container"
    - kinds: [{ group: aquasecurity.github.io, kind: ConfigAuditReport }]
      icon: file-check
${STATUS}
      links:
        - name: Resource
${LINK}
        # The same object twice: listed once.
        - name: Scanned
${LINK}
`

const { storefront, cart } = DEMO.deployments
const RUNS = DEMO.replicaSets.storefront
const RAN = DEMO.replicaSets.storefrontPrevious
const POD = DEMO.pods.storefront[0]!

/** A report in shop of `kind`, about `about` (and its container), with `summary`. */
function scan(
  cluster: MockCluster,
  kind: 'VulnerabilityReport' | 'ConfigAuditReport',
  name: string,
  about: { kind: string; name: string; container?: string },
  summary: { criticalCount: number; highCount: number },
) {
  cluster.upsert({
    apiVersion: 'aquasecurity.github.io/v1alpha1',
    kind,
    metadata: {
      name,
      namespace: 'shop',
      uid: `uid-${name}`,
      creationTimestamp: '2026-10-20T08:00:00Z',
      labels: {
        'trivy-operator.resource.kind': about.kind,
        'trivy-operator.resource.name': about.name,
        ...(about.container ? { 'trivy-operator.container.name': about.container } : {}),
      },
    },
    report: { summary: { ...summary, mediumCount: 0, lowCount: 0 } },
  } as unknown as KubeObject)
}

/** What points at the open object, by the plugin that says so. */
const from = (where: Locator, plugin: string) =>
  where.getByRole('region', { name: `From the plugin ${plugin}` })
const pointer = (where: Locator, name: string) =>
  where.getByRole('listitem').filter({ hasText: name })

/** Opens an object from its kind's list, filtered to its name (a long list draws only some). */
const opened = async (page: Page, list: string, name: string) => {
  await goTo(page, list)
  await page.getByPlaceholder(`Filter ${list}`).fill(name)
  await row(page, list, name).getByRole('gridcell').nth(1).click()
}

test('an object’s detail lists what points at it, by plugin, each with its status, and opens it', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'trivy-operator.yaml'), TRIVY)
  const cluster = clusters.demo
  cluster.upsert(reportCrd('VulnerabilityReport'))
  cluster.upsert(reportCrd('ConfigAuditReport'))
  // The ReplicaSet storefront runs: its container's vulnerabilities, and its configuration.
  scan(
    cluster,
    'VulnerabilityReport',
    `replicaset-${RUNS}-storefront`,
    {
      kind: 'ReplicaSet',
      name: RUNS,
      container: 'storefront',
    },
    { criticalCount: 9, highCount: 2 },
  )
  scan(
    cluster,
    'ConfigAuditReport',
    `replicaset-${RUNS}`,
    { kind: 'ReplicaSet', name: RUNS },
    {
      criticalCount: 0,
      highCount: 1,
    },
  )
  // A container the report doesn't name: its kind alone, never "the  container".
  scan(
    cluster,
    'VulnerabilityReport',
    `replicaset-${RUNS}-sidecar`,
    { kind: 'ReplicaSet', name: RUNS },
    {
      criticalCount: 0,
      highCount: 0,
    },
  )
  // Not storefront's: the ReplicaSet it ran before (no Pods now), another workload's, and one
  // whose kind and name are each one of storefront's but not together.
  scan(
    cluster,
    'VulnerabilityReport',
    `replicaset-${RAN}-storefront`,
    {
      kind: 'ReplicaSet',
      name: RAN,
      container: 'storefront',
    },
    { criticalCount: 4, highCount: 0 },
  )
  scan(
    cluster,
    'VulnerabilityReport',
    'replicaset-checkout-api',
    {
      kind: 'ReplicaSet',
      name: DEMO.replicaSets.checkout,
      container: 'api',
    },
    { criticalCount: 1, highCount: 0 },
  )
  scan(
    cluster,
    'ConfigAuditReport',
    'statefulset-mixed',
    { kind: 'StatefulSet', name: RUNS },
    {
      criticalCount: 1,
      highCount: 0,
    },
  )

  await openCluster(page)
  await opened(page, 'Deployments', storefront)
  const detail = panel(page, 'Deployment', storefront)
  const trivy = from(detail, 'Trivy')
  await expect(trivy).toBeVisible()
  await expect(trivy.getByRole('heading')).toHaveText('From the plugin Trivy 9.0.0')
  await expect(trivy.getByRole('listitem')).toHaveCount(3)
  // Worst first.
  await expect(trivy.getByRole('listitem')).toContainText([
    '9 critical',
    '1 high',
    'No critical or high',
  ])
  await expect(detail.getByText('Objects that point here')).toBeVisible()
  await expect(pointer(trivy, `replicaset-${RUNS}-storefront`)).toContainText(
    'VulnerabilityReport · the storefront container',
  )
  await expect(pointer(trivy, `replicaset-${RUNS}-storefront`)).toContainText('9 critical')
  await expect(pointer(trivy, `replicaset-${RUNS}-sidecar`)).toContainText('VulnerabilityReport')
  await expect(pointer(trivy, `replicaset-${RUNS}-sidecar`)).not.toContainText('·')
  await expect(pointer(trivy, `replicaset-${RUNS}-sidecar`)).toContainText('No critical or high')
  const config = pointer(trivy, `replicaset-${RUNS}`).filter({ hasText: 'ConfigAuditReport' })
  await expect(config).toContainText('1 high')
  for (const name of [
    `replicaset-${RAN}-storefront`,
    'replicaset-checkout-api',
    'statefulset-mixed',
  ]) {
    await expect(pointer(trivy, name), name).toHaveCount(0)
  }
  // It's after Details, before the pod template.
  const sections = await detail.locator('section > div > h3').allInnerTexts()
  expect(sections.map((text) => text.toLowerCase()).slice(0, 3)).toEqual([
    'details',
    'objects that point here',
    'pod template',
  ])

  // A row opens its object.
  await pointer(trivy, `replicaset-${RUNS}-storefront`).getByRole('button').click()
  await expect(panel(page, 'VulnerabilityReport', `replicaset-${RUNS}-storefront`)).toBeVisible()
  await page.keyboard.press('Escape')

  // A Pod's are those of the ReplicaSet that runs it.
  await opened(page, 'Pods', POD)
  await expect(from(panel(page, 'Pod', POD), 'Trivy').getByRole('listitem')).toHaveCount(3)
  await page.keyboard.press('Escape')

  // Where nothing points, there's no section at all.
  await opened(page, 'Deployments', cart)
  await expect(panel(page, 'Deployment', cart).getByText('Details', { exact: true })).toBeVisible()
  await expect(panel(page, 'Deployment', cart)).not.toContainText('Objects that point here')
  await page.keyboard.press('Escape')

  // However many point there, 50 are drawn, and how many more is said.
  for (let i = 0; i < 50; i++) {
    scan(
      cluster,
      'ConfigAuditReport',
      `replicaset-${RUNS}-${i}`,
      { kind: 'ReplicaSet', name: RUNS },
      { criticalCount: 0, highCount: 0 },
    )
  }
  await opened(page, 'Deployments', storefront)
  await expect(
    from(panel(page, 'Deployment', storefront), 'Trivy').getByRole('listitem'),
  ).toHaveCount(50)
  await expect(panel(page, 'Deployment', storefront)).toContainText('3 more aren’t shown here.')
})

test('without a plugin whose links are listed where they lead, nothing’s listed and nothing’s read', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(
    join(plugins, 'trivy-operator.yaml'),
    TRIVY.replaceAll('          listedThere: true\n', ''),
  )
  const cluster = clusters.demo
  cluster.upsert(reportCrd('VulnerabilityReport'))
  cluster.upsert(reportCrd('ConfigAuditReport'))
  scan(
    cluster,
    'VulnerabilityReport',
    `replicaset-${RUNS}-storefront`,
    {
      kind: 'ReplicaSet',
      name: RUNS,
      container: 'storefront',
    },
    { criticalCount: 9, highCount: 0 },
  )
  await openCluster(page)
  await opened(page, 'Deployments', storefront)
  const detail = panel(page, 'Deployment', storefront)
  await expect(detail.getByText('Details', { exact: true })).toBeVisible()
  await expect(detail.getByText('Pod template', { exact: true })).toBeVisible()
  await expect(detail).not.toContainText('Objects that point here')
  expect(
    cluster.requests.filter((r) => /vulnerabilityreports|configauditreports/.test(r.path)),
  ).toEqual([])
})
