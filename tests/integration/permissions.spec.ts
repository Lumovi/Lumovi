/**
 * A view-only account: real access reviews decide what the app offers, and
 * the service proxy refuses the metrics source.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { focusDisabled, open } from '../e2e/action-helpers.ts'
import { openCluster, panel } from '../e2e/fixtures.ts'
import { expect, freshNamespace, inNamespace, kubectl, test } from './fixtures.ts'
import { db, web } from './workloads.ts'

const NS = 'it-perms'
const CONTEXT = 'kind-viewer'
let kubeconfig: string

test.beforeAll(() => {
  freshNamespace(NS, [web(1), ...db()])
  kubectl(['create', 'serviceaccount', 'viewer', '-n', NS])
  kubectl(['delete', 'clusterrolebinding', 'it-viewer', '--ignore-not-found'])
  kubectl([
    'create',
    'clusterrolebinding',
    'it-viewer',
    '--clusterrole=view',
    `--serviceaccount=${NS}:viewer`,
  ])
  const token = kubectl(['create', 'token', 'viewer', '-n', NS, '--duration=2h']).trim()
  // The same cluster, as the view-only account.
  const admin = JSON.parse(kubectl(['config', 'view', '--raw', '--minify', '-o', 'json']))
  const cluster = admin.clusters[0]
  kubeconfig = join(mkdtempSync(join(tmpdir(), 'kubestacks-viewer-')), 'config')
  writeFileSync(
    kubeconfig,
    JSON.stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [cluster],
      users: [{ name: 'viewer', user: { token } }],
      contexts: [{ name: CONTEXT, context: { cluster: cluster.name, user: 'viewer' } }],
      'current-context': CONTEXT,
    }),
  )
})

test('a view-only account sees what it can’t do, and why', async ({ launch }) => {
  const { page } = await launch({ kubeconfig })
  await openCluster(page, CONTEXT)
  await inNamespace(page, NS)

  await open(page, 'Deployments', 'web')
  await focusDisabled(panel(page, 'Deployment', 'web').getByRole('button', { name: 'Scale' }))
  await expect(page.getByRole('tooltip')).toContainText(
    `Your account can’t change deployments in ${NS}.`,
  )

  await open(page, 'Pods', 'db-0')
  const pod = panel(page, 'Pod', 'db-0')
  await pod.getByRole('tab', { name: 'Shell' }).click()
  await expect(pod).toContainText('No shell access')
  await expect(pod).toContainText(`Your account can’t open shells in ${NS}.`)

  // Reading metrics is allowed; reaching Prometheus through the service proxy isn't.
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Metrics' })
    .click()
  await expect(page.getByRole('alert')).toContainText(
    /Your account can’t reach monitoring\/\S+ through the API server \(it needs get on services\/proxy\)\./,
  )
})
