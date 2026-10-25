/**
 * What plugins' objects say of each workload, where a view's link counts against it (`counts`): a
 * Findings column of the workloads' lists, the worst as its pill and each under a pointer, worst
 * first when sorted by it, and a dash where nothing that counts says anything wrong. Here with a
 * stand-in for trivy-operator, whose reports name the ReplicaSet a Deployment runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MockCluster } from '../mock-cluster/server.ts'
import type { KubeObject } from '../mock-cluster/types.ts'
import { reportCrd } from '../mock-cluster/fixtures/trivy.ts'
import { holds } from '../holds.ts'
import { placed } from '../placed.ts'
import { DEMO, expect, goTo, openCluster, row, rows, test } from './fixtures.ts'

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

/** trivy-operator, as its file would say it: its reports count against what they're of. */
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
          counts: true
          about: "the {{ .metadata.labels['trivy-operator.container.name'] }} container"
    - kinds: [{ group: aquasecurity.github.io, kind: ConfigAuditReport }]
      icon: file-check
${STATUS}
      links:
        - name: Resource
${LINK}
          counts: true
`

const { storefront, checkout, cart, recommendations } = DEMO.deployments
const SETS = DEMO.replicaSets

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
      uid: `uid-${kind}-${name}`,
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

/** Trivy's reports: storefront's worst is critical, checkout's high, cart's fine. */
function scanned(cluster: MockCluster) {
  cluster.upsert(reportCrd('VulnerabilityReport'))
  cluster.upsert(reportCrd('ConfigAuditReport'))
  const set = (name: string) => ({ kind: 'ReplicaSet', name })
  scan(
    cluster,
    'VulnerabilityReport',
    `replicaset-${SETS.storefront}-storefront`,
    { ...set(SETS.storefront), container: 'storefront' },
    { criticalCount: 9, highCount: 2 },
  )
  scan(cluster, 'ConfigAuditReport', `replicaset-${SETS.storefront}`, set(SETS.storefront), {
    criticalCount: 0,
    highCount: 1,
  })
  scan(cluster, 'ConfigAuditReport', `replicaset-${SETS.checkout}`, set(SETS.checkout), {
    criticalCount: 0,
    highCount: 2,
  })
  scan(cluster, 'VulnerabilityReport', `replicaset-${SETS.cart}-cart`, set(SETS.cart), {
    criticalCount: 0,
    highCount: 0,
  })
  // The ReplicaSet storefront ran before: nothing of it counts now.
  scan(
    cluster,
    'VulnerabilityReport',
    `replicaset-${SETS.storefrontPrevious}-storefront`,
    { ...set(SETS.storefrontPrevious), container: 'storefront' },
    { criticalCount: 40, highCount: 0 },
  )
}

test('workloads’ lists say the worst a plugin’s reports say of each, worst first, and each under a pointer', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'trivy-operator.yaml'), TRIVY)
  scanned(clusters.demo)
  await openCluster(page)
  await goTo(page, 'Deployments')
  const header = page.getByRole('columnheader', { name: 'Findings' })
  await expect(header).toBeVisible()
  const headers = await page
    .getByRole('grid', { name: 'Deployments' })
    .getByRole('columnheader')
    .allInnerTexts()
  const at = headers.findIndex((text) => text.trim().toLowerCase() === 'findings')
  const cell = (name: string) => row(page, 'Deployments', name).getByRole('gridcell').nth(at)
  await expect(cell(storefront)).toHaveText('9 critical')
  await expect(cell(checkout)).toHaveText('2 high')
  for (const name of [cart, recommendations]) await expect(cell(name), name).toHaveText('—')

  // Under a pointer, each, worst first, with what it's about, under who says so.
  await cell(storefront).getByText('9 critical').hover()
  const tip = page.getByRole('tooltip')
  await expect(tip).toHaveText(
    'From the plugin Trivy 9.0.09 critical, the storefront container1 high',
  )
  await page.mouse.move(0, 0)
  // Every list was read whole: the heading says nothing more.
  await expect(header).not.toContainText('Couldn’t')

  // Sorted by it: the worst first, and those with nothing wrong last.
  await header.click()
  const names = async () =>
    (await rows(page, 'Deployments').allInnerTexts()).map((text) => text.split('\n')[0]!.trim())
  await expect.poll(async () => (await names()).slice(0, 2)).toEqual([storefront, checkout])

  // On Workloads too.
  await goTo(page, 'Workloads')
  await expect(page.getByRole('columnheader', { name: 'Findings' })).toBeVisible()
  await expect(row(page, 'Workloads', storefront)).toContainText('9 critical')
})

test('without a plugin whose link counts, there’s no Findings column, and nothing more is read', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(
    join(plugins, 'trivy-operator.yaml'),
    TRIVY.replaceAll('          counts: true\n', ''),
  )
  scanned(clusters.demo)
  await openCluster(page)
  await goTo(page, 'Deployments')
  await expect(row(page, 'Deployments', storefront)).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Findings' })).toHaveCount(0)
  expect(
    clusters.demo.requests.filter((r) => /vulnerabilityreports|configauditreports/.test(r.path)),
  ).toEqual([])
})

test('where a counting kind can’t be read, the Findings heading says what isn’t counted', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'trivy-operator.yaml'), TRIVY)
  scanned(clusters.demo)
  // In the whole cluster only: in a namespace it can be read.
  clusters.demo.fail(/\/v1alpha1\/vulnerabilityreports/, {
    status: 403,
    body: JSON.stringify({
      kind: 'Status',
      reason: 'Forbidden',
      message: 'vulnerabilityreports.aquasecurity.github.io is forbidden',
      code: 403,
    }),
  })
  await openCluster(page)
  await goTo(page, 'Deployments')
  // What can be read still counts: storefront's configuration's 1 high.
  await expect(row(page, 'Deployments', storefront)).toContainText('1 high')
  const header = page.getByRole('columnheader', { name: 'Findings' })
  const UNREAD =
    'Couldn’t read all of Trivy’s VulnerabilityReports here: what’s missing isn’t counted, so a dash may not mean none.'
  // (Once the refused read has been given up on: until then, there's nothing more to say.)
  await expect(async () => {
    await page.mouse.move(0, 0)
    await header.getByText('Findings').hover()
    await expect(page.getByRole('tooltip')).toHaveText(UNREAD, { timeout: 1_000 })
  }).toPass()
  // The pointer can go onto it, to read it, and it stays; Esc shuts it.
  const tip = await placed(page.getByRole('tooltip'))
  await page.mouse.move(tip.x + tip.width / 2, tip.y + tip.height / 2, { steps: 10 })
  await expect(page.getByRole('tooltip')).toHaveText(UNREAD)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  // Left all at once, off the window (no moves after for it to shut on), it shuts all the same.
  await page.mouse.move(0, 0)
  await header.getByText('Findings').hover()
  await expect(page.getByRole('tooltip')).toHaveText(UNREAD)
  await page.evaluate(() =>
    document.documentElement.dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }),
    ),
  )
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await page.mouse.move(0, 0)
  // On the keyboard too: the heading is a button, and it says so as it's focused.
  await header.getByRole('button').focus()
  await expect(page.getByRole('tooltip')).toHaveText(UNREAD)
  await header.getByRole('button').blur()
  // And nothing says what was refused anywhere else; nor is it asked for again and again.
  await expect(page.getByRole('alert')).toHaveCount(0)
  const asked = () =>
    clusters.demo.requests.filter((r) => /vulnerabilityreports/.test(r.path)).length
  const before = asked()
  await holds(() => asked() < before + 8, 3_000, 'a refused read isn’t asked for again and again')
  await page.mouse.move(0, 0)

  // With its namespace picked, it's read there, and counts.
  await page.getByLabel('Namespace', { exact: true }).click()
  await page.getByRole('option', { name: 'shop', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(row(page, 'Deployments', storefront)).toContainText('9 critical')
  await header.getByText('Findings').hover()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
})
