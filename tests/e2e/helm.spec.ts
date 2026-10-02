import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { encodeRelease, HELM, releaseRecord } from '../mock-cluster/fixtures/helm.ts'
import type { MockCluster } from '../mock-cluster/server.ts'
import { dialog, focusDisabled, toasts } from './action-helpers.ts'
import {
  CONTEXTS,
  expect,
  openCluster,
  panel,
  row,
  rows,
  test,
  type KubeStacks,
} from './fixtures.ts'

const releasePanel = (page: Page, name: string) =>
  page.getByRole('complementary', { name: `Helm release ${name}` })

async function openHelm(page: Page) {
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Helm releases' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Helm releases')
}

async function openRelease(page: Page, name: string) {
  await row(page, 'Helm releases', name).first().getByRole('gridcell').nth(1).click()
  return releasePanel(page, name)
}

/** YAML shown in a release's tab (the tab's panel shares its name). */
const yaml = (release: Locator, label: string) => release.locator(`pre[aria-label="${label}"]`)

async function pickNamespace(page: Page, namespace: string) {
  await page.getByRole('button', { name: 'Namespace' }).click()
  await page.getByRole('option', { name: namespace, exact: true }).click()
}

/** How the stand-in helm was run, oldest first (without the version checks). */
function helmCalls(kubestacks: KubeStacks): string[][] {
  const log = join(kubestacks.helmDir!, 'calls.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] !== 'version')
}

/** Makes the stand-in helm answer subcommands this way: { code, stdout, stderr }. */
function scriptHelm(kubestacks: KubeStacks, responses: Record<string, object>) {
  writeFileSync(join(kubestacks.helmDir!, 'responses.json'), JSON.stringify(responses))
}

/** Adds a release's revision to the cluster, as Helm would store it. */
function addRelease(
  cluster: MockCluster,
  name: string,
  {
    templates,
    manifest = '',
    status = 'deployed',
    revision = 1,
  }: { templates?: Record<string, string>; manifest?: string; status?: string; revision?: number },
) {
  const spec = {
    name,
    namespace: 'default',
    chart: { name, templates },
    revisions: [
      {
        revision,
        status,
        ago: 60_000,
        chartVersion: '0.1.0',
        description: 'Install complete',
        values: {},
        manifest,
      },
    ],
  }
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `sh.helm.release.v1.${name}.v${revision}`,
      namespace: 'default',
      labels: { name, owner: 'helm', status, version: String(revision) },
    },
    type: 'helm.sh/release.v1',
    data: {
      release: Buffer.from(
        encodeRelease(releaseRecord(spec, spec.revisions[0]!, Date.now())),
      ).toString('base64'),
    },
  })
}

test('Helm releases, read from where Helm keeps them', async ({ page }) => {
  await openCluster(page)
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Helm releases')
  await expect(rows(page, 'Helm releases')).toHaveCount(7)
  const status = (name: string) => row(page, 'Helm releases', name).getByRole('gridcell').nth(1)
  await expect(status(HELM.storefront)).toHaveText('Deployed')
  await expect(status(HELM.redis)).toHaveText('Failed')
  await expect(status(HELM.grafana)).toHaveText('Pending upgrade')
  await expect(status(HELM.dashboards)).toHaveText('Uninstalled')
  // Kept in a ConfigMap (HELM_DRIVER=configmap).
  await expect(row(page, 'Helm releases', HELM.reports)).toContainText('cronjobs 0.3.0')
  // A failed upgrade is the latest revision.
  await expect(row(page, 'Helm releases', HELM.redis)).toContainText('redis 19.6.2')

  // Filters: by status and by text.
  await page.getByRole('button', { name: /^Failed/ }).click()
  await expect(rows(page, 'Helm releases')).toHaveCount(1)
  await page.getByRole('button', { name: /^Failed/ }).click()
  await page.getByPlaceholder('Filter releases').fill('cronjobs')
  await expect(rows(page, 'Helm releases')).toHaveCount(1)
  await page.getByPlaceholder('Filter releases').fill('nothing like it')
  await expect(page.getByText('No releases match the current filters.')).toBeVisible()
  await page.getByPlaceholder('Filter releases').fill('')
  const grid = page.getByRole('grid', { name: 'Helm releases' })
  await page.getByPlaceholder('Filter releases').press('ArrowDown')
  await expect(grid).toBeFocused()
  for (const column of ['Chart', 'App version', 'Revision', 'Updated']) {
    await grid.getByRole('button', { name: column }).click()
  }
  await expect(rows(page, 'Helm releases').first()).toContainText(HELM.metricsServer)
  await grid.getByRole('button', { name: 'Updated' }).click()
  await expect(rows(page, 'Helm releases').first()).toContainText(HELM.grafana)
  await grid.getByRole('button', { name: 'Status' }).click()
  await expect(rows(page, 'Helm releases').first()).toContainText(HELM.redis)

  // A release: what it runs, what it made, its values, manifest and history.
  const storefront = await openRelease(page, HELM.storefront)
  await expect(storefront).toContainText('storefront 2.4.1')
  await expect(storefront).toContainText('The Acme shop’s web frontend.')
  await expect(storefront).toContainText('The storefront is at https://www.shop.example.com.')
  await storefront.getByRole('button', { name: 'Expand panel' }).click()
  await storefront.getByRole('button', { name: 'Restore panel' }).click()
  await storefront.getByRole('tab', { name: 'Resources' }).click()
  const made = storefront.getByRole('list', { name: 'Release resources' }).getByRole('listitem')
  await expect(made).toHaveCount(6)
  await expect(made.filter({ hasText: 'HorizontalPodAutoscaler' })).toContainText('Scaling')
  await expect(made.filter({ hasText: 'storefront-feature-flags' })).toContainText('Missing')
  await expect(
    made.filter({ hasText: 'storefront-feature-flags' }).getByRole('button'),
  ).toBeDisabled()
  await storefront.getByRole('tab', { name: 'Values' }).click()
  const values = yaml(storefront, 'Values')
  await expect(values).toContainText('tag: v3.9.1')
  await expect(values).not.toContainText('pullPolicy')
  await storefront.getByRole('button', { name: 'With the chart’s defaults' }).click()
  await expect(values).toContainText('pullPolicy: IfNotPresent')
  await expect(values).toContainText('host: www.shop.example.com')
  await storefront.getByRole('button', { name: 'Set for this release' }).click()
  await expect(values).not.toContainText('pullPolicy')
  await storefront.getByRole('tab', { name: 'Manifest' }).click()
  await expect(yaml(storefront, 'Manifest')).toContainText('storefront-feature-flags')
  await storefront.getByRole('tab', { name: 'History' }).click()
  await expect(
    storefront.getByRole('list', { name: 'Revisions' }).getByRole('listitem'),
  ).toHaveCount(3)
  await expect(storefront.getByLabel('Differences')).toContainText('tag: v3.9.1')
  await storefront.getByRole('button', { name: 'manifest' }).click()
  await storefront.getByRole('combobox', { name: 'From' }).selectOption('1')
  await expect(storefront.getByLabel('Differences')).toContainText('replicas: 3')
  await storefront.getByRole('combobox', { name: 'To' }).selectOption('1')
  await expect(storefront).toContainText('No differences.')

  // What it made opens where that kind is listed.
  await storefront.getByRole('tab', { name: 'Resources' }).click()
  await made.filter({ hasText: 'Deployment' }).getByRole('button').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Deployments')
  await expect(panel(page, 'Deployment', 'storefront')).toBeVisible()

  // And from the palette.
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'Helm releases' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Helm releases')
})

test('releases in other states, and ones Flux manages', async ({ page, clusters }) => {
  // Flux labels what it makes; this one with only its name, so it's in the release's namespace.
  const manifest =
    '---\n# Source: labelled/templates/empty.yaml\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: labelled\n  labels:\n    helm.toolkit.fluxcd.io/name: labelled\n'
  // Two current revisions (the latest failed): the list shows the latest.
  addRelease(clusters.demo, 'labelled', { manifest, revision: 10, status: 'failed' })
  addRelease(clusters.demo, 'labelled', { manifest, revision: 9 })
  addRelease(clusters.demo, 'installing', { status: 'pending-install' })
  addRelease(clusters.demo, 'leaving', { status: 'uninstalling' })
  await openCluster(page)
  await openHelm(page)
  const status = (name: string) => row(page, 'Helm releases', name).getByRole('gridcell').nth(1)
  await expect(status('labelled')).toHaveText('Failed')
  await expect(status('installing')).toHaveText('Pending install')
  await expect(status('leaving')).toHaveText('Uninstalling')
  await expect(page.getByRole('button', { name: /^Uninstalling/ })).toHaveText('Uninstalling1')

  const redis = await openRelease(page, HELM.redis)
  await expect(redis).toContainText('Subcharts')
  await expect(redis).toContainText('common')
  await redis.getByRole('tab', { name: 'History' }).click()
  await expect(
    redis.getByRole('list', { name: 'Revisions' }).getByRole('listitem').first(),
  ).toContainText('Failed')

  const metrics = await openRelease(page, HELM.metricsServer)
  // One revision: nothing to roll back to.
  await expect(metrics.getByRole('button', { name: 'Upgrade…' })).toBeVisible()
  await expect(metrics.getByRole('button', { name: 'Roll back…' })).toHaveCount(0)
  await metrics.getByRole('tab', { name: 'Values' }).click()
  await expect(yaml(metrics, 'Values')).toContainText('No values set: the chart’s defaults apply.')
  await metrics.getByRole('tab', { name: 'History' }).click()
  await expect(metrics).toContainText('No differences.')
  await metrics.getByRole('tab', { name: 'Resources' }).click()
  // A cluster-wide object it made, found where cluster-wide objects are.
  await expect(
    metrics.getByRole('listitem').filter({ hasText: 'ClusterRole' }).getByRole('button'),
  ).toBeEnabled()

  const grafana = await openRelease(page, HELM.grafana)
  await grafana.getByRole('tab', { name: 'Values' }).click()
  await grafana.getByRole('button', { name: 'With the chart’s defaults' }).click()
  await expect(yaml(grafana, 'Values')).toContainText('adminUser')
  await expect(yaml(grafana, 'Values')).not.toContainText('sidecar')
  await grafana.getByRole('button', { name: 'Roll back…' }).click()
  await expect(dialog(page)).toContainText('Going back to 1 changes 1 line of its values')
  await page.keyboard.press('Escape')

  const dashboards = await openRelease(page, HELM.dashboards)
  await dashboards.getByRole('tab', { name: 'Resources' }).click()
  await expect(dashboards).toContainText('This release makes no objects.')
  await dashboards.getByRole('button', { name: 'Uninstall…' }).click()
  await expect(dialog(page)).toContainText(
    'old-dashboards makes no objects: this deletes its record.',
  )
  await page.keyboard.press('Escape')

  const labelled = await openRelease(page, 'labelled')
  await expect(labelled).toContainText('Flux manages this release')
  await labelled.getByRole('tab', { name: 'Resources' }).click()
  await expect(labelled.getByRole('listitem')).toHaveCount(1)
  await labelled.getByRole('button', { name: 'Uninstall…' }).click()
  await expect(dialog(page)).toContainText('HelmRelease default/labelled')
  await page.keyboard.press('Escape')

  const podinfo = await openRelease(page, HELM.podinfo)
  await expect(podinfo).toContainText('Flux manages this release')
  await podinfo.getByRole('button', { name: 'Upgrade…' }).click()
  await expect(dialog(page)).toContainText('puts back changes made here at its next reconcile')
  await page.keyboard.press('Escape')
  await podinfo.getByRole('button', { name: 'Open its HelmRelease' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('HelmReleases')
  await expect(panel(page, 'HelmRelease', 'podinfo')).toBeVisible()

  // A release that isn't there (any more).
  await page.evaluate(() => {
    window.location.hash = '#/cluster/demo/helm?release=shop/gone'
  })
  const gone = releasePanel(page, 'gone')
  await expect(gone).toContainText('shop has no Helm release named gone.')
  await gone.getByRole('button', { name: 'Try again' }).click()
  await expect(gone).toContainText('shop has no Helm release named gone.')
})

test('roll back and uninstall, with helm', async ({ page, kubestacks }) => {
  await openCluster(page)
  await openHelm(page)
  const storefront = await openRelease(page, HELM.storefront)
  await storefront.getByRole('button', { name: 'Roll back…' }).click()
  const rollback = dialog(page)
  await expect(rollback.getByRole('radio', { name: 'Revision 2' })).toBeChecked()
  await expect(rollback).toContainText('Going back to 2 changes 3 lines of its values')
  await rollback.getByRole('radio', { name: 'Revision 1' }).check()
  await expect(rollback).toContainText(
    'helm rollback storefront 1 --namespace shop --kube-context demo',
  )
  await expect(rollback).toContainText('Going back to 1 changes 4 lines of its values')
  // helm's errors are shown as it says them.
  scriptHelm(kubestacks, { rollback: { code: 1, stderr: 'Error: release: not found\n' } })
  await rollback.getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(rollback.getByRole('alert')).toHaveText('release: not found')
  scriptHelm(kubestacks, {})
  await rollback.getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(toasts(page)).toContainText('Rolled back storefront to revision 1')
  expect(helmCalls(kubestacks).at(-1)).toEqual([
    'rollback',
    'storefront',
    '1',
    '--namespace',
    'shop',
    '--kube-context',
    'demo',
  ])
  await page.getByRole('button', { name: /Activity/ }).click()
  await expect(page.getByRole('dialog', { name: 'Activity' })).toContainText(
    'Rolled back storefront to revision 1',
  )
  await page.keyboard.press('Escape')

  // Cancelling leaves things as they were.
  await storefront.getByRole('button', { name: 'Uninstall…' }).click()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(storefront).toBeVisible()

  await storefront.getByRole('button', { name: 'Uninstall…' }).click()
  const uninstall = dialog(page)
  await expect(uninstall).toContainText('Deletes the 6 objects storefront made')
  await uninstall.getByRole('checkbox', { name: /Keep its history/ }).check()
  await expect(uninstall).toContainText('--keep-history')
  await uninstall.getByLabel('Type storefront to confirm').fill(HELM.storefront)
  // Some helm errors are printed to stdout.
  scriptHelm(kubestacks, { uninstall: { code: 1, stdout: 'Error: uninstall: timed out\n' } })
  await uninstall.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(uninstall.getByRole('alert')).toHaveText('uninstall: timed out')
  // Or nothing at all.
  scriptHelm(kubestacks, { uninstall: { code: 2 } })
  await uninstall.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(uninstall.getByRole('alert')).toHaveText(
    'helm failed (exit code 2) without saying why.',
  )
  // Stopped (Windows has no signals: the process just exits).
  scriptHelm(kubestacks, { uninstall: { signal: 'SIGTERM' } })
  await uninstall.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(uninstall.getByRole('alert')).toHaveText(
    process.platform === 'win32'
      ? /^helm failed \(exit code \d+\) without saying why\.$/
      : 'helm was stopped (SIGTERM) before it finished.',
  )
  scriptHelm(kubestacks, {})
  await uninstall.getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(toasts(page)).toContainText('Uninstalled storefront')
  await expect(releasePanel(page, HELM.storefront)).toHaveCount(0)
  expect(helmCalls(kubestacks).at(-1)).toEqual([
    'uninstall',
    'storefront',
    '--namespace',
    'shop',
    '--kube-context',
    'demo',
    '--keep-history',
  ])

  // A release with one object.
  const reports = await openRelease(page, HELM.reports)
  await reports.getByRole('button', { name: 'Uninstall…' }).click()
  await expect(dialog(page)).toContainText('Deletes the object nightly-reports made')
})

test('upgrade with the chart a release runs: change its values, review, apply', async ({
  page,
  kubestacks,
}) => {
  await openCluster(page)
  await openHelm(page)
  const storefront = await openRelease(page, HELM.storefront)
  await storefront.getByRole('button', { name: 'Upgrade…' }).click()
  const upgrade = dialog(page)
  const stored = upgrade.getByRole('radio', { name: /The chart it runs: storefront 2\.4\.1/ })
  await expect(stored).toBeChecked()
  // Another chart can be picked instead, and the stored one again.
  await upgrade.getByRole('radio', { name: /A chart from a repository/ }).check()
  await expect(upgrade.getByLabel('Chart name or reference')).toHaveValue('storefront')
  await stored.check()
  await expect(upgrade.getByLabel('Chart name or reference')).toHaveCount(0)

  const editor = upgrade.getByRole('textbox', { name: 'Values' })
  await expect(editor).toContainText('tag: v3.9.1')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('replicaCount: [unclosed\n')
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await expect(upgrade.getByRole('alert')).toContainText('The values aren’t valid YAML')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('replicaCount: 5\n')
  // ⌘S reviews too: a dry run on the API server shows what would change.
  await page.keyboard.press('ControlOrMeta+s')
  const changes = upgrade.getByLabel('Manifest changes')
  // The chart was rebuilt from the release's record: its version and templates.
  await expect(changes).toContainText(
    'Chart folder: 2.4.1, templates NOTES.txt, deployment.yaml, service.yaml',
  )
  await expect(changes).toContainText('replicaCount: 5')
  await expect(upgrade).toContainText('storefront is ready.')
  const dryRun = helmCalls(kubestacks).at(-1)!
  expect(dryRun.slice(0, 2)).toEqual(['upgrade', 'storefront'])
  expect(dryRun).toContain('--dry-run=server')
  await upgrade.getByRole('button', { name: 'Back to editing' }).click()
  await expect(editor).toContainText('replicaCount: 5')
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await upgrade.getByRole('button', { name: 'Upgrade', exact: true }).click()
  await expect(toasts(page)).toContainText('Upgraded storefront')
  expect(helmCalls(kubestacks).at(-1)).not.toContain('--dry-run=server')

  // No values of its own, and an upgrade that changes nothing it makes.
  scriptHelm(kubestacks, {
    upgrade: { stdout: JSON.stringify({ version: 2, info: { status: 'deployed' }, manifest: '' }) },
  })
  const dashboards = await openRelease(page, HELM.dashboards)
  await dashboards.getByRole('button', { name: 'Upgrade…' }).click()
  await expect(upgrade.getByRole('textbox', { name: 'Values' })).toHaveText('')
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await expect(upgrade).toContainText('Nothing it makes changes.')
  await page.keyboard.press('Escape')

  // A stored chart without default values or templates of its own.
  scriptHelm(kubestacks, {})
  const grafana = await openRelease(page, HELM.grafana)
  await grafana.getByRole('button', { name: 'Upgrade…' }).click()
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await expect(upgrade.getByLabel('Manifest changes')).toContainText(
    'Chart folder: 8.5.1, templates',
  )
})

test('upgrade from a repository, and install a chart found on Artifact Hub', async ({ launch }) => {
  // Artifact Hub and a chart repository, here.
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1')
    const repository = `http://127.0.0.1:${(server.address() as AddressInfo).port}/charts`
    if (url.pathname === '/api/v1/packages/search') {
      const query = url.searchParams.get('ts_query_web')
      if (query === 'broken') {
        res.writeHead(500, 'Internal Server Error').end()
        return
      }
      const packages = [
        {
          name: 'redis',
          version: '20.1.0',
          app_version: '7.4.1',
          description: 'Redis(R) is an open source, advanced key-value store.',
          repository: { name: 'bitnami', url: repository },
        },
        { name: 'valkey', version: '1.0.0', repository: { name: 'bitnami', url: repository } },
      ]
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ packages: query === 'nothing' ? [] : packages }))
    } else if (url.pathname === '/charts/index.yaml') {
      res
        .writeHead(200, { 'Content-Type': 'text/yaml' })
        .end('apiVersion: v1\nentries:\n  redis:\n    - version: 20.1.0\n    - version: 19.6.2\n')
    } else {
      res.writeHead(404, 'Not Found').end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const kubestacks = await launch({ env: { KUBESTACKS_ARTIFACT_HUB_URL: base } })
  const { page } = kubestacks
  try {
    await openCluster(page)
    await openHelm(page)

    // redis has a subchart, which Helm doesn't store: its chart has to come from somewhere.
    const redis = await openRelease(page, HELM.redis)
    await redis.getByRole('button', { name: 'Upgrade…' }).click()
    const upgrade = dialog(page)
    await expect(upgrade.getByRole('radio', { name: /The chart it runs/ })).toBeDisabled()
    await expect(upgrade).toContainText('It has subcharts (common)')
    await expect(upgrade.getByLabel('Chart name or reference')).toHaveValue('redis')
    await upgrade.getByLabel('Repository URL').fill(`${base}/charts`)
    await upgrade.getByRole('button', { name: 'List its versions' }).click()
    const versions = upgrade.getByRole('combobox', { name: 'Version' })
    await versions.selectOption('20.1.0')
    await expect(upgrade).toContainText(
      `helm upgrade redis redis --repo ${base}/charts --version 20.1.0`,
    )
    await versions.selectOption('')
    await expect(upgrade).toContainText(`helm upgrade redis redis --repo ${base}/charts --values`)
    await versions.selectOption('20.1.0')
    await upgrade.getByRole('button', { name: 'Review' }).click()
    await expect(upgrade.getByLabel('Manifest changes')).toContainText('size: 20Gi')
    await upgrade.getByRole('button', { name: 'Upgrade', exact: true }).click()
    await expect(toasts(page)).toContainText('Upgraded redis')
    expect(helmCalls(kubestacks).at(-1)!.slice(0, 7)).toEqual([
      'upgrade',
      'redis',
      'redis',
      '--repo',
      `${base}/charts`,
      '--version',
      '20.1.0',
    ])

    // A repository without the chart, one that isn't there, and one that doesn't answer.
    await redis.getByRole('button', { name: 'Upgrade…' }).click()
    await upgrade.getByLabel('Chart name or reference').fill('memcached')
    await upgrade.getByLabel('Repository URL').fill(`${base}/charts`)
    await upgrade.getByRole('button', { name: 'List its versions' }).click()
    await expect(upgrade.getByRole('alert')).toContainText(
      `${base}/charts has no chart named memcached.`,
    )
    await upgrade.getByLabel('Repository URL').fill(`${base}/missing`)
    await upgrade.getByRole('button', { name: 'List its versions' }).click()
    await expect(upgrade.getByRole('alert')).toContainText('answered 404 Not Found')
    await upgrade.getByLabel('Repository URL').fill('http://127.0.0.1:1/charts')
    await upgrade.getByRole('button', { name: 'List its versions' }).click()
    await expect(upgrade.getByRole('alert')).toContainText('Couldn’t reach')
    await upgrade.getByLabel('Repository URL').fill('')
    const version = upgrade.getByRole('textbox', { name: 'Version', exact: true })
    await version.fill('19.6.2')
    await expect(upgrade).toContainText('helm upgrade redis memcached --version 19.6.2')
    await version.fill('')
    await upgrade.getByLabel('Chart name or reference').fill('')
    await expect(upgrade).toContainText("helm upgrade redis '<chart>'")
    await expect(upgrade.getByRole('button', { name: 'Review' })).toBeDisabled()
    await page.keyboard.press('Escape')

    // Install: found on Artifact Hub, starting from the chart's defaults.
    await page.getByRole('button', { name: 'Install chart' }).click()
    const install = dialog(page)
    await expect(install).toContainText("helm install '<name>' '<chart>'")
    await expect(install.getByRole('button', { name: 'Review' })).toBeDisabled()
    await expect(
      install.getByRole('button', { name: 'Start from the chart’s defaults' }),
    ).toBeDisabled()
    // Enter searches, and doesn't submit the dialog; with nothing to search for, it does nothing.
    const hub = install.getByLabel('Search Artifact Hub')
    await hub.fill('')
    await hub.press('Enter')
    await expect(install.getByRole('alert')).toHaveCount(0)
    await expect(install.getByRole('button', { name: 'Review' })).toBeVisible()
    await hub.pressSequentially('broken')
    await hub.press('Enter')
    await expect(install.getByRole('alert')).toContainText('answered 500 Internal Server Error')
    await hub.fill('nothing')
    await install.getByRole('button', { name: 'Search' }).click()
    await expect(install.getByRole('list', { name: 'Charts found' })).toHaveText('No charts match.')
    await install.getByLabel('Search Artifact Hub').fill('redis')
    await install.getByRole('button', { name: 'Search' }).click()
    await expect(install.getByRole('list', { name: 'Charts found' })).toContainText(
      'bitnami/valkey1.0.0',
    )
    await install.getByRole('button', { name: /bitnami\/redis/ }).click()
    await expect(install.getByRole('list', { name: 'Charts found' })).toHaveCount(0)
    await expect(install.getByLabel('Chart name or reference')).toHaveValue('redis')
    await expect(install.getByRole('textbox', { name: 'Version', exact: true })).toHaveValue(
      '20.1.0',
    )
    await install.getByLabel('Release name').fill('cache')
    await install.getByLabel('Namespace', { exact: true }).fill('caches')
    await install.getByRole('checkbox', { name: /Create the namespace/ }).check()
    await install.getByRole('button', { name: 'Start from the chart’s defaults' }).click()
    await expect(install.getByRole('textbox', { name: 'Values' })).toContainText(
      'repository: ghcr.io/example/app',
    )
    await install.getByRole('button', { name: 'Review' }).click()
    await expect(install).toContainText('cache is ready.')
    await install.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(toasts(page)).toContainText('Installed cache')
    const installed = helmCalls(kubestacks).at(-1)!
    expect(installed.slice(0, 7)).toEqual([
      'install',
      'cache',
      'redis',
      '--repo',
      `${base}/charts`,
      '--version',
      '20.1.0',
    ])
    expect(installed).toContain('--create-namespace')
    expect(installed[installed.indexOf('--namespace') + 1]).toBe('caches')

    // What helm says when it can't.
    scriptHelm(kubestacks, {
      'show values': { code: 1, stderr: 'Error: chart "nope" not found in repository\n' },
      install: {
        code: 1,
        stderr: 'Error: INSTALLATION FAILED: cannot re-use a name that is still in use\n',
      },
    })
    await page.getByRole('button', { name: 'Install chart' }).click()
    await install.getByLabel('Chart name or reference').fill('nope')
    await install.getByRole('button', { name: 'Start from the chart’s defaults' }).click()
    await expect(install.getByRole('alert')).toContainText('chart "nope" not found in repository')
    await install.getByLabel('Release name').fill('cache')
    await install.getByRole('button', { name: 'Review' }).click()
    await expect(install.getByRole('alert')).toContainText(
      'cannot re-use a name that is still in use',
    )
  } finally {
    server.close()
  }
})

test('a stored chart is only written inside its folder', async ({ page, clusters }) => {
  addRelease(clusters.demo, 'sneaky', { templates: { '../../outside.yaml': 'kind: List\n' } })
  await openCluster(page)
  await openHelm(page)
  const sneaky = await openRelease(page, 'sneaky')
  await sneaky.getByRole('button', { name: 'Upgrade…' }).click()
  await dialog(page).getByRole('button', { name: 'Review' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText(
    'The stored chart has a file outside its folder: ../../outside.yaml',
  )
})

test('without helm, or on a read-only cluster, releases can still be read', async ({ launch }) => {
  const { page } = await launch({ env: { KUBESTACKS_HELM: '/nowhere/helm' } })
  await openCluster(page)
  await openHelm(page)
  const storefront = await openRelease(page, HELM.storefront)
  await expect(storefront).toContainText('storefront 2.4.1')
  await focusDisabled(storefront.getByRole('button', { name: 'Upgrade…' }))
  await expect(page.getByRole('tooltip')).toContainText(
    'KubeStacks uses helm for this, and couldn’t run /nowhere/helm.',
  )
  const ask = () =>
    page.evaluate(() =>
      window.kubestacks!.helm.uninstall({
        context: 'demo',
        namespace: 'shop',
        name: 'storefront',
        keepHistory: false,
      }),
    )
  expect(await ask()).toMatchObject({
    ok: false,
    error: { code: 'helm', message: expect.stringContaining('Install Helm (https://helm.sh)') },
  })

  await page.getByRole('button', { name: 'Switch cluster' }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.keyboard.press('Escape')
  await expect(storefront.getByRole('button', { name: 'Read-only' })).toBeVisible()
  await focusDisabled(storefront.getByRole('button', { name: 'Uninstall…' }))
  await expect(page.getByRole('tooltip')).toContainText('Changes are turned off for this cluster.')
  // The main process refuses too.
  expect(await ask()).toMatchObject({ ok: false, error: { code: 'read-only' } })
})

test('rejects malformed helm requests', async ({ page }) => {
  await openCluster(page)
  const results = await page.evaluate(async () => {
    const helm = window.kubestacks!.helm
    const loose = <T>(value: unknown) => value as T
    const outcome = (result: { ok: boolean; error?: { code: string; message: string } }) =>
      result.ok ? 'ok' : `${result.error!.code}: ${result.error!.message}`
    const base = { context: 'demo', namespace: 'shop', name: 'storefront', dryRun: true }
    return Promise.all([
      helm.releases(loose('')).then(outcome),
      helm.release('demo', 'shop', 'Not_A_Name').then(outcome),
      helm.release('demo', 'shop', 'no-such-release').then(outcome),
      helm.rollback(loose({ ...base, revision: 0 })).then(outcome),
      helm.deploy(loose({ ...base, source: 'stored', values: 5 })).then(outcome),
      helm
        .deploy(loose({ ...base, source: 'stored', values: 'x'.repeat(1024 * 1024 + 1) }))
        .then(outcome),
      helm.deploy(loose({ ...base, source: { chart: '--set=x' }, values: '' })).then(outcome),
      helm
        .deploy(loose({ ...base, source: { chart: 'x', repository: 'ftp://x' }, values: '' }))
        .then(outcome),
      helm
        .deploy(loose({ ...base, source: { chart: 'x', version: '--devel' }, values: '' }))
        .then(outcome),
      helm.versions('not a url', 'x').then(outcome),
      helm.search(loose('')).then(outcome),
      // The UI offers another chart instead: Helm doesn't store subcharts.
      helm
        .deploy({
          context: 'demo',
          namespace: 'data',
          name: 'redis',
          source: 'stored',
          values: '',
          dryRun: true,
        })
        .then(outcome),
    ])
  })
  expect(results).toEqual([
    'invalid: context must be a non-empty string',
    'invalid: name must be lowercase letters, digits and dashes',
    'not-found: shop has no Helm release named no-such-release.',
    'invalid: revision must be an integer between 1 and 1000000',
    'invalid: values must be a string',
    'invalid: The values are too large',
    'invalid: chart can’t start with a dash',
    'invalid: repository must be an http or https URL',
    'invalid: version can’t start with a dash',
    'invalid: repository must be an http or https URL',
    'invalid: query must be a non-empty string',
    'invalid: redis’s chart has subcharts, which Helm doesn’t keep with the release. Choose the chart to upgrade with.',
  ])

  // A .cmd wrapper (the stand-in, on Windows) runs through the shell, so it's only given plain
  // words: no spaces, and no %VARIABLES% for cmd.exe to expand.
  for (const chart of ['a b', 'x%PATH%']) {
    const answer = await page.evaluate(
      (chart) => window.kubestacks!.helm.defaults({ chart }),
      chart,
    )
    if (process.platform === 'win32') {
      expect(answer).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('is a script, and can’t be given') },
      })
    } else {
      expect(answer).toMatchObject({ ok: true })
    }
  }
})

test('what an account can’t read, and a cluster that fails', async ({ page, clusters }) => {
  clusters.demo.fail('/api/v1/secrets', { status: 403 })
  await openCluster(page)
  await openHelm(page)
  await expect(page.getByRole('alert')).toContainText(
    'Helm keeps releases in Secrets, which your account can’t list.',
  )
  clusters.demo.reset()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(rows(page, 'Helm releases')).toHaveCount(7)

  // A list that fails after it worked keeps what it had.
  clusters.demo.fail('/api/v1/secrets', { status: 500 })
  await page.getByRole('button', { name: /^Refresh/ }).click()
  const stale = page.getByRole('status').filter({ hasText: 'Couldn’t refresh' })
  await expect(stale).toContainText('injected fault (HTTP 500)')
  await expect(rows(page, 'Helm releases')).toHaveCount(7)
  clusters.demo.reset()
  await stale.getByRole('button', { name: 'Retry' }).click()
  await expect(stale).toHaveCount(0)

  clusters.demo.fail('/api/v1/namespaces/shop/secrets', { status: 403 })
  await pickNamespace(page, 'shop')
  await expect(page.getByRole('alert')).toContainText(
    'Helm keeps releases in Secrets, which your account can’t list in shop.',
  )
  clusters.demo.reset()
  await page.getByRole('button', { name: 'Try again' }).click()

  // A namespace without releases.
  await pickNamespace(page, 'default')
  await expect(page.getByText('No Helm releases in default')).toBeVisible()
  await pickNamespace(page, 'shop')
  await expect(rows(page, 'Helm releases')).toHaveCount(1)
})

test('a cluster without Helm releases', async ({ page }) => {
  await openCluster(page, CONTEXTS.sandbox)
  await openHelm(page)
  await expect(page.getByText('No Helm releases in this cluster')).toBeVisible()
})

/** Writes a chart's files into `root/name`, and gives its path. */
function writeChart(root: string, name: string, files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name, file)), { recursive: true })
    writeFileSync(join(root, name, file), text)
  }
  return join(root, name)
}

test('upgrade and install from a chart on this computer', async ({ launch }) => {
  // A home of its own, where ~ leads.
  const home = mkdtempSync(join(tmpdir(), 'kubestacks-home-'))
  const web = writeChart(home, 'web', {
    'Chart.yaml':
      'apiVersion: v2\nname: storefront\nversion: 2.5.0\nappVersion: 3.10.0\ndescription: The storefront, being worked on.\n',
    'values.yaml': 'replicaCount: 2\n',
    'values-prod.yaml': 'replicaCount: 5\n',
    'ci/test-values.yaml': 'replicaCount: 1\n',
    'templates/deployment.yaml': 'kind: Deployment\n',
  })
  writeChart(home, 'older', {
    'Chart.yaml': 'apiVersion: v2\nname: shop-frontend\nversion: 2.0.0\n',
    '.lint': '[WARNING] templates/: nothing in this folder\n',
  })
  writeChart(home, 'deps', {
    'Chart.yaml':
      'apiVersion: v2\nname: storefront\nversion: 2.5.0\ndependencies:\n  - name: common\n    version: 2.0.0\n    repository: oci://registry-1.docker.io/bitnamicharts\n',
  })
  writeChart(home, 'broken', {
    // The version it runs: neither newer nor older.
    'Chart.yaml': 'apiVersion: v2\nname: storefront\nversion: 2.4.1\n',
    '.lint':
      '[WARNING] templates/: something to look at\n[ERROR] templates/deployment.yaml: unable to parse YAML\n  error converting YAML to JSON\n',
  })
  writeChart(home, 'not-a-chart', { 'README.md': 'Nothing to see.\n' })
  writeFileSync(join(home, 'notes.txt'), 'Nothing to see.\n')
  const packaged = join(home, 'storefront-2.5.0.tgz')
  // Relative paths: Git for Windows' tar reads `C:` as a remote host.
  execFileSync('tar', ['-czf', 'storefront-2.5.0.tgz', 'web'], { cwd: home })

  const kubestacks = await launch({ env: { HOME: home, USERPROFILE: home } })
  const { page, app } = kubestacks
  const answer = (chosen: { canceled: boolean; filePaths: string[] }) =>
    app.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = (async () => chosen) as unknown as typeof dialog.showOpenDialog
    }, chosen)
  const choose = async (kind: 'Chart folder…' | 'Packaged chart (.tgz)…') => {
    await upgrade.getByRole('button', { name: 'Choose…' }).click()
    await page.getByRole('menuitem', { name: kind }).click()
  }
  await openCluster(page)
  await openHelm(page)
  const storefront = await openRelease(page, HELM.storefront)
  await storefront.getByRole('button', { name: 'Upgrade…' }).click()
  const upgrade = dialog(page)
  await upgrade.getByRole('radio', { name: /A chart on this computer/ }).check()
  await expect(upgrade.getByRole('button', { name: 'Review' })).toBeDisabled()
  const path = upgrade.getByLabel('Chart path')

  // Chosen: a folder (unless the choice is cancelled).
  await answer({ canceled: true, filePaths: [] })
  await choose('Chart folder…')
  await expect(path).toHaveValue('')
  await answer({ canceled: false, filePaths: [web] })
  await choose('Chart folder…')
  await expect(path).toHaveValue(web)
  await expect(upgrade).toContainText('storefront 2.5.0 · app 3.10.0')
  await expect(upgrade).toContainText('The storefront, being worked on.')
  await expect(upgrade).toContainText('helm lint found no problems')
  await expect(upgrade.getByRole('list', { name: 'helm lint' })).toContainText(
    'Chart.yaml: icon is recommended',
  )
  // Quoted for a shell when it needs to be, as Windows paths (C:\Users\RUNNER~1\…) do.
  const shown = /^[\w@%+=:,./-]+$/.test(web) ? web : `'${web}'`
  await expect(upgrade).toContainText(`helm upgrade storefront ${shown} --values values.yaml`)

  // Values from the chart's own files.
  const loadFrom = upgrade.getByRole('combobox', { name: 'Load values from' })
  await expect(loadFrom.getByRole('option')).toHaveText([
    'Load values from…',
    'ci/test-values.yaml',
    'values-prod.yaml',
  ])
  const editor = upgrade.getByRole('textbox', { name: 'Values' })
  await upgrade.getByRole('button', { name: 'Start from the chart’s defaults' }).click()
  await expect(editor).toContainText('replicaCount: 2')
  await loadFrom.selectOption('values-prod.yaml')
  await expect(editor).toContainText('replicaCount: 5')
  // A file that went since the chart was read.
  rmSync(join(web, 'ci', 'test-values.yaml'))
  await loadFrom.selectOption('ci/test-values.yaml')
  await expect(upgrade.getByRole('alert')).toContainText(
    'ci/test-values.yaml isn’t one of web’s values files',
  )

  // Checked again before the dry run, which runs the folder's chart.
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await expect(upgrade.getByLabel('Manifest changes')).toContainText(
    'Chart folder: 2.5.0, templates deployment.yaml',
  )
  await expect(upgrade).toContainText('helm lint found no problems')
  await upgrade.getByRole('button', { name: 'Upgrade', exact: true }).click()
  await expect(toasts(page)).toContainText('Upgraded storefront')
  expect(helmCalls(kubestacks).at(-1)!.slice(0, 3)).toEqual(['upgrade', 'storefront', web])

  // Next time, it's where this release came from.
  await storefront.getByRole('button', { name: 'Upgrade…' }).click()
  await expect(upgrade.getByRole('radio', { name: /A chart on this computer/ })).toBeChecked()
  await expect(path).toHaveValue(web)
  await expect(upgrade).toContainText('storefront 2.5.0')
  // Checked again as it is now.
  await path.press('Enter')
  await expect(upgrade).toContainText('storefront 2.5.0')

  // Typed, from home: an older one, of another chart.
  await path.fill('~/older')
  await path.press('Tab')
  await expect(upgrade).toContainText(
    'storefront runs the storefront chart; this one is shop-frontend.',
  )
  await expect(upgrade).toContainText('It’s older than the 2.4.1 storefront runs.')
  await expect(upgrade).toContainText('helm lint: 1 warning')

  // One that needs its subcharts.
  await path.fill('~/deps')
  await path.press('Enter')
  await expect(upgrade).toContainText('Its charts/ folder is missing common 2.0.0.')
  scriptHelm(kubestacks, { 'dependency update': { code: 1, stderr: 'Error: no network\n' } })
  await upgrade.getByRole('button', { name: 'Download dependencies' }).click()
  await expect(upgrade.getByRole('alert')).toHaveText('no network')
  scriptHelm(kubestacks, {})
  await upgrade.getByRole('button', { name: 'Download dependencies' }).click()
  await expect(upgrade).not.toContainText('Its charts/ folder is missing')
  expect(existsSync(join(home, 'deps', 'charts', 'common-2.0.0.tgz'))).toBe(true)

  // One helm lint finds problems in: listed, errors first, and in the review.
  await path.fill('~/broken')
  await path.press('Enter')
  await expect(upgrade).toContainText('helm lint: 1 error, 1 warning')
  const findings = upgrade.getByRole('list', { name: 'helm lint' }).getByRole('listitem')
  await expect(findings.first()).toContainText('unable to parse YAML')
  await expect(findings.first()).toContainText('error converting YAML to JSON')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText('lint-error: true\n')
  await upgrade.getByRole('button', { name: 'Check again' }).click()
  await expect(upgrade).toContainText('helm lint: 2 errors, 1 warning')
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await expect(upgrade.getByLabel('Manifest changes')).toBeVisible()
  await expect(upgrade).toContainText('helm lint: 2 errors, 1 warning')
  await upgrade.getByRole('button', { name: 'Back to editing' }).click()

  // A chart that breaks after it was read is read again before the review.
  await path.fill('~/deps')
  await path.press('Enter')
  await expect(upgrade).toContainText('storefront 2.5.0')
  rmSync(join(home, 'deps', 'Chart.yaml'))
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await expect(upgrade.getByRole('alert')).toContainText('has no Chart.yaml')
  await expect(upgrade.getByLabel('Manifest changes')).toHaveCount(0)

  // Packaged.
  await answer({ canceled: false, filePaths: [packaged] })
  await choose('Packaged chart (.tgz)…')
  await expect(upgrade).toContainText('storefront 2.5.0 · app 3.10.0 · packaged')
  await expect(loadFrom).toHaveCount(0)

  // Not charts.
  for (const [typed, message] of [
    ['relative/chart', 'Give the chart’s full path, or choose it'],
    ['~/nowhere', `Nothing is at ${join(home, 'nowhere')}.`],
    ['~/not-a-chart', 'has no Chart.yaml, so it isn’t a chart.'],
    ['~/notes.txt', 'notes.txt isn’t a packaged chart (.tgz).'],
  ]) {
    await path.fill(typed!)
    await path.press('Enter')
    await expect(upgrade.getByRole('alert')).toContainText(message!)
    await expect(upgrade.getByRole('button', { name: 'Review' })).toBeDisabled()
  }
  await page.keyboard.press('Escape')

  // Installed from one, typed from home.
  await page.getByRole('button', { name: 'Install chart' }).click()
  await upgrade.getByRole('radio', { name: /A chart on this computer/ }).check()
  await path.fill('~/web')
  await path.press('Enter')
  await upgrade.getByLabel('Release name').fill('storefront-next')
  await upgrade.getByRole('button', { name: 'Review' }).click()
  await upgrade.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(toasts(page)).toContainText('Installed storefront-next')
  expect(helmCalls(kubestacks).at(-1)!.slice(0, 3)).toEqual(['install', 'storefront-next', web])

  // What the main process won't do.
  const refused = await page.evaluate(
    async ({ web, packaged }) => {
      const charts = window.kubestacks!.localCharts!
      const loose = <T>(value: unknown) => value as T
      const outcome = (result: { ok: boolean; error?: { code: string; message: string } }) =>
        result.ok ? 'ok' : `${result.error!.code}: ${result.error!.message}`
      return Promise.all([
        charts.read(loose(5)).then(outcome),
        charts.lint(web, loose(5)).then(outcome),
        charts.valuesFile(web, '../../secrets.yaml').then(outcome),
        charts.updateDependencies(packaged).then(outcome),
      ])
    },
    { web, packaged },
  )
  expect(refused).toEqual([
    'invalid: path must be a non-empty string',
    'invalid: values must be a string',
    'invalid: ../../secrets.yaml isn’t one of web’s values files',
    'invalid: A packaged chart has its dependencies already; this updates chart folders',
  ])
  // helm failing to lint at all.
  scriptHelm(kubestacks, { lint: { code: 1, stderr: 'Error: helm broke\n' } })
  expect(
    await page.evaluate((web) => window.kubestacks!.localCharts!.lint(web, ''), web),
  ).toMatchObject({
    ok: false,
    error: { message: 'helm broke' },
  })
})
