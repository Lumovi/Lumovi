/**
 * What plugins' reports say of a workload, on a phone: a fact of its row, "Findings" and the
 * worst one's pill, whenever something that counts says something wrong (critical, or a warning);
 * nothing where nothing does.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KubeObject } from '../mock-cluster/types.ts'
import { reportCrd } from '../mock-cluster/fixtures/trivy.ts'
import { DEMO } from '../mock-cluster/fixtures/demo.ts'
import { DEMO_TOKEN, expect, test } from './fixtures.ts'
import { PHONE, signInNarrow } from './phone.ts'

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const TRIVY = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: trivy-operator }
spec:
  version: 9.0.0
  needs: { lumovi: 1.0.0 }
  groups: [aquasecurity.github.io]
  label: Trivy
  kinds:
    - { group: aquasecurity.github.io, kind: VulnerabilityReport }
    - { group: aquasecurity.github.io, kind: ConfigAuditReport }
  views:
    - kinds:
        - { group: aquasecurity.github.io, kind: VulnerabilityReport }
        - { group: aquasecurity.github.io, kind: ConfigAuditReport }
      status:
        - when: { path: .report.summary.criticalCount, notEquals: 0 }
          health: critical
          label: '{{ .report.summary.criticalCount }} critical'
        - when: { path: .report.summary.highCount, notEquals: 0 }
          health: warning
          label: '{{ .report.summary.highCount }} high'
        - health: healthy
          label: No critical
      links:
        - name: Workload
          kind: "{{ .metadata.labels['trivy-operator.resource.kind'] }}"
          objectName: "{{ .metadata.labels['trivy-operator.resource.name'] }}"
          listedThere: true
          counts: true
`

test('a phone’s row says the worst a plugin’s reports say of a workload, and nothing where nothing’s wrong', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  const plugins = join(served.helmDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'trivy-operator.yaml'), TRIVY)
  clusters.demo.upsert(reportCrd('VulnerabilityReport'))
  for (const [set, critical, high] of [
    [DEMO.replicaSets.storefront, 9, 0],
    [DEMO.replicaSets.checkout, 0, 2],
    [DEMO.replicaSets.cart, 0, 0],
  ] as const) {
    clusters.demo.upsert({
      apiVersion: 'aquasecurity.github.io/v1alpha1',
      kind: 'VulnerabilityReport',
      metadata: {
        name: `replicaset-${set}`,
        namespace: 'shop',
        uid: `uid-${set}`,
        creationTimestamp: '2026-10-20T08:00:00Z',
        labels: {
          'trivy-operator.resource.kind': 'ReplicaSet',
          'trivy-operator.resource.name': set,
        },
      },
      report: { summary: { criticalCount: critical, highCount: high } },
    } as unknown as KubeObject)
  }
  await signInNarrow(page, `${served.url}cluster/demo/deployments`, DEMO_TOKEN)
  const rows = page.getByRole('list', { name: 'Deployments' }).getByRole('listitem')
  const storefront = rows.filter({ hasText: /^storefront/ })
  await expect(storefront.getByRole('button')).toHaveAccessibleName(/Findings 9 critical/)
  // A warning too.
  await expect(rows.filter({ hasText: /^checkout/ }).getByRole('button')).toHaveAccessibleName(
    /Findings 2 high/,
  )
  await expect(rows.filter({ hasText: /^cart/ })).toBeVisible()
  await expect(rows.filter({ hasText: /^cart/ })).not.toContainText('Findings')
})

test('on a phone, where a counting kind couldn’t all be read, a line above the list says what isn’t counted', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  const plugins = join(served.helmDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'trivy-operator.yaml'), TRIVY)
  clusters.demo.upsert(reportCrd('VulnerabilityReport'))
  // Checkout's configuration can be read: what can be read still counts.
  clusters.demo.upsert(reportCrd('ConfigAuditReport'))
  clusters.demo.upsert({
    apiVersion: 'aquasecurity.github.io/v1alpha1',
    kind: 'ConfigAuditReport',
    metadata: {
      name: `replicaset-${DEMO.replicaSets.checkout}`,
      namespace: 'shop',
      uid: 'uid-config-checkout',
      creationTimestamp: '2026-10-20T08:00:00Z',
      labels: {
        'trivy-operator.resource.kind': 'ReplicaSet',
        'trivy-operator.resource.name': DEMO.replicaSets.checkout,
      },
    },
    report: { summary: { criticalCount: 0, highCount: 2 } },
  } as unknown as KubeObject)
  clusters.demo.fail(/\/vulnerabilityreports/, {
    status: 403,
    body: JSON.stringify({ kind: 'Status', reason: 'Forbidden', message: 'forbidden', code: 403 }),
  })
  await signInNarrow(page, `${served.url}cluster/demo/deployments`, DEMO_TOKEN)
  await expect(
    page.getByText(
      'Couldn’t read all of Trivy’s VulnerabilityReports here: what’s missing isn’t counted, so a dash may not mean none.',
    ),
  ).toBeVisible()
  const rows = page.getByRole('list', { name: 'Deployments' }).getByRole('listitem')
  await expect(rows.filter({ hasText: /^checkout/ }).getByRole('button')).toHaveAccessibleName(
    /Findings 2 high/,
  )
})
