/**
 * Every page of every plugin Lumovi comes with, opened on a cluster that runs each tool: drawn,
 * none stopped as it opens, and nothing of Lumovi's failing beside it. (1.22.0 came with a page
 * Lumovi stopped as it opened: CloudNativePG's Backup health named icons Lumovi doesn't have.)
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginsAndCode, readLock, takePlugins, trust } from '../../scripts/plugins-bundle.ts'
import { parsePlugin } from '../../src/shared/plugins.ts'
import { holds } from '../holds.ts'
import { demoWithCloudNativePg } from '../mock-cluster/fixtures/cloudnative-pg.ts'
import { reportCrd } from '../mock-cluster/fixtures/trivy.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockCluster } from '../mock-cluster/server.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { DEMO, expect, test } from './fixtures.ts'

/** Trivy's scan of the ReplicaSet storefront runs: one critical, with a fix. */
const VULNERABILITIES = {
  apiVersion: 'aquasecurity.github.io/v1alpha1',
  kind: 'VulnerabilityReport',
  metadata: {
    name: `replicaset-${DEMO.replicaSets.storefront}-storefront`,
    namespace: 'shop',
    uid: 'uid-vulnerabilities-storefront',
    creationTimestamp: '2026-10-20T08:00:00Z',
    labels: {
      'trivy-operator.resource.kind': 'ReplicaSet',
      'trivy-operator.resource.name': DEMO.replicaSets.storefront,
      'trivy-operator.resource.namespace': 'shop',
      'trivy-operator.container.name': 'storefront',
    },
  },
  report: {
    updateTimestamp: '2026-10-20T08:00:00Z',
    registry: { server: 'ghcr.io' },
    artifact: { repository: 'acme/storefront', tag: '3.8.2' },
    os: { family: 'debian', name: '12.4' },
    summary: { criticalCount: 1, highCount: 0, mediumCount: 0, lowCount: 0 },
    vulnerabilities: [
      {
        vulnerabilityID: 'CVE-2024-6387',
        severity: 'CRITICAL',
        resource: 'openssh-client',
        installedVersion: '1:9.2p1-2',
        fixedVersion: '1:9.2p1-2+deb12u3',
        title: 'openssh: a race in its signal handler',
        primaryLink: 'https://avd.aquasec.com/nvd/cve-2024-6387',
        score: 8.1,
      },
    ],
  },
} as unknown as KubeObject

test('every page of every plugin Lumovi comes with opens, drawn, and none is stopped', async ({
  launch,
}) => {
  test.slow()
  // Its pages, as the build takes them: the bundle plugins.lock.json pins.
  const shipped = pluginsAndCode(await takePlugins(readLock(), trust())).plugins
  const pages = Object.entries(shipped).flatMap(([file, text]) => {
    const { plugin } = parsePlugin(text, file, { carriesCode: true })
    return (plugin?.added.pages ?? []).map(({ id }) => ({ plugin: plugin!.name, id }))
  })
  expect(pages.map(({ plugin, id }) => `${plugin}/${id}`)).toEqual(
    expect.arrayContaining(['cloudnative-pg/backups', 'trivy-operator/security']),
  )

  // (The demo's tools, CloudNativePG's databases beside them, and Trivy's reports' kinds with a
  // report of what it found.)
  const cluster = await startMockCluster({ fixture: () => demoWithCloudNativePg(), tls: true })
  for (const kind of [
    'VulnerabilityReport',
    'ConfigAuditReport',
    'ExposedSecretReport',
    'RbacAssessmentReport',
  ]) {
    cluster.upsert(reportCrd(kind))
  }
  cluster.upsert(reportCrd('ClusterRbacAssessmentReport', 'Cluster'))
  cluster.upsert(VULNERABILITIES)
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-pages-')), {
    currentContext: 'databases',
    clusters: [{ name: 'databases', server: cluster.url, caPem: cluster.caPem }],
    users: [{ name: 'databases', token: 'a-token' }],
    contexts: [{ name: 'databases', cluster: 'databases', user: 'databases' }],
  })
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  // What fails of Lumovi's own: thrown, or caught by a page's error boundary.
  const failed: string[] = []
  page.on('pageerror', (error) => failed.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && /caught the following error/.test(message.text())) {
      failed.push(message.text().split('\n')[0]!)
    }
  })
  await page.getByRole('option', { name: /databases/ }).click()
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible({
    timeout: 30_000,
  })

  const stopped = page.getByRole('heading', { name: /^Lumovi stopped / })
  for (const { plugin, id } of pages) {
    await test.step(`${plugin}: ${id}`, async () => {
      await page.evaluate((to) => {
        window.location.hash = to
      }, `#/cluster/databases/plugins/${plugin}/${id}`)
      await expect(page.locator('[data-plugin-body]')).toBeVisible({ timeout: 15_000 })
      // (A page that sends what Lumovi won't take is stopped as soon as it does, as it opens.)
      await holds(async () => (await stopped.count()) === 0, 2_500, `${plugin}'s ${id} is stopped`)
    })
  }
  expect(failed).toEqual([])
})
