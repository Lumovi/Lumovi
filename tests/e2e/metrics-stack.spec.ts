/**
 * Lumovi's own metrics stack, where a cluster has no usage history: offered, reviewed (the
 * chart, its values, and a dry run that shows every object), installed with helm, and removed
 * without a trace. Never without the review; never half of it; never a namespace it didn't make.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { parse } from 'yaml'
import { byNodeQuery, nodeQuery, usageQuery } from '../../src/renderer/src/lib/promql.ts'
import { rightsizingQueries } from '../../src/renderer/src/lib/rightsizing.ts'
import type { AuditEvent } from '../../src/shared/audit.ts'
import { METRICS_STACK } from '../../src/shared/metrics-stack.ts'
import type { MockCluster } from '../mock-cluster/server.ts'
import { toasts } from './action-helpers.ts'
import { CONTEXTS, expect, openCluster, test, type Lumovi } from './fixtures.ts'

const { namespace: NAMESPACE, release: RELEASE, chart: CHART } = METRICS_STACK
const SERVICE = `${RELEASE}-prometheus-server`
const INSTALL = `helm install ${RELEASE} ${CHART.name} --repo ${CHART.repository} --version ${CHART.version} --values values.yaml --create-namespace --namespace ${NAMESPACE} --kube-context ${CONTEXTS.sandbox}`

/** Everything the stack is made of, as the app names kinds: the cluster's own, and its namespace's. */
const MADE: [kind: string, namespace: string | undefined, name: string][] = [
  ['Namespace', undefined, NAMESPACE],
  ['ClusterRole.rbac.authorization.k8s.io', undefined, `${RELEASE}-server`],
  ['ClusterRole.rbac.authorization.k8s.io', undefined, `${RELEASE}-kube-state-metrics`],
  ['ClusterRoleBinding.rbac.authorization.k8s.io', undefined, `${RELEASE}-server`],
  ['ClusterRoleBinding.rbac.authorization.k8s.io', undefined, `${RELEASE}-kube-state-metrics`],
  ['Deployment', NAMESPACE, SERVICE],
  ['Deployment', NAMESPACE, `${RELEASE}-kube-state-metrics`],
  ['Service', NAMESPACE, SERVICE],
  ['Service', NAMESPACE, `${RELEASE}-kube-state-metrics`],
  ['ServiceAccount', NAMESPACE, SERVICE],
  ['ServiceAccount', NAMESPACE, `${RELEASE}-kube-state-metrics`],
  ['ConfigMap', NAMESPACE, SERVICE],
  ['Secret', NAMESPACE, `sh.helm.release.v1.${RELEASE}.v1`],
]

/** What's in the cluster of the stack's: nothing, before it's installed and after it's removed. */
const there = (cluster: MockCluster) =>
  MADE.filter(([kind, namespace, name]) => cluster.object(kind, namespace, name)).map(
    ([kind, , name]) => `${kind.split('.')[0]} ${name}`,
  )

function helmCalls(lumovi: Lumovi): string[][] {
  try {
    return readFileSync(join(lumovi.helmDir!, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
  } catch {
    return []
  }
}

async function openMetrics(page: Page) {
  await openCluster(page, CONTEXTS.sandbox)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Metrics' })
    .click()
  await expect(page.getByText('No Prometheus found')).toBeVisible()
}

const offer = (page: Page) => page.getByRole('button', { name: 'Install a metrics stack…' })
const installing = (page: Page) => page.getByRole('dialog', { name: /Install a metrics stack/ })
const source = (page: Page) =>
  page.getByRole('button', { name: new RegExp(`^Prometheus .*${NAMESPACE}/${SERVICE}$`) })

/** What the audit log has of helm's, the newest first. */
async function audited(page: Page): Promise<AuditEvent[]> {
  const { events } = await page.evaluate(() => window.lumovi!.audit.query({}))
  return events.filter((event) => event.action.startsWith('helm.'))
}

test('reviewed, installed, charted, and removed without a trace', async ({ lumovi, clusters }) => {
  const { page } = lumovi
  await openMetrics(page)
  await expect(page.getByRole('main')).toContainText(
    'Or let Lumovi install a small one: you review everything it makes first.',
  )
  await offer(page).click()
  const dialog = installing(page)
  // What it is, said plainly: what runs, how long history is kept, how it goes, and the chart.
  await expect(dialog).toContainText(`Two Deployments in a new namespace, ${NAMESPACE}`)
  await expect(dialog).toContainText('Neither can read Secrets or ConfigMaps')
  await expect(dialog).toContainText('any pod can read the usage it keeps')
  await expect(dialog).toContainText('Kept for 7 days, in up to 4 GiB')
  await expect(dialog).toContainText('history starts over if its pod is replaced')
  await expect(dialog).toContainText(`${CHART.name} ${CHART.version}, from ${CHART.repository}`)
  await expect(dialog).toContainText(CHART.sha256)
  await expect(dialog.getByRole('list', { name: 'Images' }).getByRole('listitem')).toHaveText([
    /^quay\.io\/prometheus\/prometheus@sha256:[0-9a-f]{64}$/,
    /^registry\.k8s\.io\/kube-state-metrics\/kube-state-metrics:v2\.20\.0@sha256:[0-9a-f]{64}$/,
  ])
  await dialog.getByText('The values it’s installed with').click()
  await expect(dialog.getByLabel('Values')).toContainText('useExistingClusterRoleName')
  await expect(dialog).toContainText(INSTALL)
  // It isn't sized for this one, so it doesn't warn.
  await expect(dialog).not.toContainText('sized for small clusters')

  // The review: a dry run, which makes nothing.
  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog).toContainText('The cluster accepts it · 12 objects')
  const reviewed = dialog.getByLabel('What it makes')
  await expect(reviewed).toContainText('kind: Namespace')
  await expect(reviewed).toContainText('app.kubernetes.io/managed-by: lumovi')
  await expect(reviewed).toContainText('--resources=pods')
  await expect(reviewed).toContainText('readOnlyRootFilesystem: true')
  const dryRun = helmCalls(lumovi).at(-1)!
  expect(dryRun.slice(0, 2)).toEqual(['install', RELEASE])
  expect(dryRun).toContain('--dry-run=server')
  expect(there(clusters.sandbox)).toEqual([])
  expect(await audited(page)).toEqual([])

  // Installed: the namespace is Lumovi's, and helm made the rest.
  await dialog.getByRole('button', { name: 'Install' }).click()
  await expect(toasts(page)).toContainText('Installed the metrics stack')
  expect(helmCalls(lumovi).at(-1)).not.toContain('--dry-run=server')
  expect(there(clusters.sandbox)).toHaveLength(MADE.length)
  expect(clusters.sandbox.object('Namespace', undefined, NAMESPACE)!.metadata.labels).toEqual(
    expect.objectContaining({ 'app.kubernetes.io/managed-by': 'lumovi' }),
  )
  // History comes from it as soon as it answers, without looking again by hand: none yet, in
  // its first minute, and where it would come from said all the same.
  await expect(source(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('main')).toContainText('Prometheus has no CPU samples for this time.')
  const [installed] = await audited(page)
  expect(installed).toMatchObject({
    action: 'helm.install',
    outcome: 'success',
    cluster: CONTEXTS.sandbox,
    target: { kind: 'HelmRelease', name: RELEASE, namespace: NAMESPACE },
    summary: `Installed Lumovi’s metrics stack (${CHART.name} ${CHART.version}) as ${RELEASE}`,
    command: INSTALL,
    details: { chart: CHART.name, version: CHART.version, sha256: CHART.sha256 },
  })

  // Removed from where its source is set: the release, and the namespace, and so all of it.
  await source(page).click()
  const settings = page.getByRole('dialog', { name: /Metrics source/ })
  const stack = settings.getByRole('region', { name: 'Lumovi’s metrics stack' })
  await expect(stack).toContainText(`Installed by Lumovi in ${NAMESPACE}`)
  await stack.getByRole('button', { name: 'Remove…' }).click()
  const removing = page.getByRole('dialog', { name: /Remove the metrics stack/ })
  await expect(removing).toContainText(
    `helm uninstall ${RELEASE} --namespace ${NAMESPACE} --kube-context ${CONTEXTS.sandbox} && kubectl delete namespace ${NAMESPACE} --context ${CONTEXTS.sandbox}`,
  )
  await expect(removing).toContainText(`and anything else put in ${NAMESPACE} since`)
  await expect(removing.getByRole('button', { name: 'Remove' })).toBeDisabled()
  await removing.getByRole('textbox').fill(NAMESPACE)
  await removing.getByRole('button', { name: 'Remove' }).click()
  await expect(toasts(page)).toContainText('Removed the metrics stack')
  expect(there(clusters.sandbox)).toEqual([])
  await expect(page.getByText('No Prometheus found')).toBeVisible()
  await expect(offer(page)).toBeVisible()
  expect((await audited(page))[0]).toMatchObject({
    action: 'helm.uninstall',
    outcome: 'success',
    summary: `Removed Lumovi’s metrics stack (${RELEASE}, and its namespace)`,
  })
})

test('without the cluster’s leave, it says what’s missing and installs nothing', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  clusters.sandbox.deny({ verb: 'create', resource: 'clusterroles' })
  clusters.sandbox.deny({ verb: 'create', resource: 'clusterrolebindings' })
  await openMetrics(page)
  await offer(page).click()
  const dialog = installing(page)
  await expect(dialog.getByRole('alert')).toContainText(
    'The cluster doesn’t let you create cluster roles and cluster role bindings, which installing it takes. Ask someone who administers the cluster.',
  )
  await expect(dialog.getByRole('button', { name: 'Review' })).toBeDisabled()
  // Asked for anyway, it's refused before anything is made: no namespace, and helm isn't run.
  const refused = await page.evaluate(
    (context) => window.lumovi!.metricsStack.install({ context }),
    CONTEXTS.sandbox,
  )
  expect(refused).toEqual({
    ok: false,
    error: {
      code: 'forbidden',
      message:
        'The cluster doesn’t let you create cluster roles and cluster role bindings, which installing takes. Nothing was installed.',
    },
  })
  expect(there(clusters.sandbox)).toEqual([])
  expect(helmCalls(lumovi).filter(([command]) => command === 'install')).toEqual([])
  expect((await audited(page))[0]).toMatchObject({ action: 'helm.install', outcome: 'refused' })
})

test('an install that fails leaves nothing behind', async ({ lumovi, clusters }) => {
  const { page } = lumovi
  await openMetrics(page)
  await offer(page).click()
  const dialog = installing(page)
  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog).toContainText('The cluster accepts it')
  // The cluster takes the first of it, then fails on the Deployments.
  clusters.sandbox.fail(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments`, {
    status: 500,
    body: '{"kind":"Status","message":"etcd is down"}',
    method: 'POST',
  })
  await dialog.getByRole('button', { name: 'Install' }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    'INSTALLATION FAILED: Deployment lumovi-metrics-kube-state-metrics: the cluster answered 500 Nothing of it is left.',
  )
  expect(helmCalls(lumovi).at(-1)!.slice(0, 2)).toEqual(['uninstall', RELEASE])
  expect(there(clusters.sandbox)).toEqual([])
})

test('another release’s cluster role of the same name stops the install, and stays', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  const ROLE = 'ClusterRole.rbac.authorization.k8s.io'
  // kube-state-metrics' own chart, installed as lumovi-metrics elsewhere, makes one of this name.
  clusters.sandbox.upsert(role(`${RELEASE}-kube-state-metrics`, 'monitoring'))
  await openMetrics(page)
  await offer(page).click()
  const dialog = installing(page)
  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog).toContainText('The cluster accepts it')
  await dialog.getByRole('button', { name: 'Install' }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    'INSTALLATION FAILED: ClusterRole lumovi-metrics-kube-state-metrics: the cluster answered 409 Nothing of it is left.',
  )
  // Undone: all of Lumovi's is gone, and what wasn't Lumovi's is as it was.
  expect(there(clusters.sandbox)).toEqual(['ClusterRole lumovi-metrics-kube-state-metrics'])
  expect(
    clusters.sandbox.object(ROLE, undefined, `${RELEASE}-kube-state-metrics`)!.metadata.annotations,
  ).toMatchObject({ 'meta.helm.sh/release-namespace': 'monitoring' })
})

test('a namespace of its name that isn’t Lumovi’s is never taken, nor removed', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  clusters.sandbox.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: NAMESPACE, uid: 'someone-elses', creationTimestamp: '2026-01-01T00:00:00Z' },
    status: { phase: 'Active' },
  })
  await openMetrics(page)
  await offer(page).click()
  await expect(installing(page).getByRole('alert')).toContainText(
    `This cluster has a namespace named ${NAMESPACE} that Lumovi didn’t make, so it installs nothing there.`,
  )
  await expect(installing(page).getByRole('button', { name: 'Review' })).toBeDisabled()
  const removed = await page.evaluate(
    (context) => window.lumovi!.metricsStack.uninstall({ context }),
    CONTEXTS.sandbox,
  )
  expect(removed).toMatchObject({ ok: false, error: { code: 'not-found' } })
  expect(clusters.sandbox.object('Namespace', undefined, NAMESPACE)).toBeDefined()
  expect(helmCalls(lumovi)).toEqual([])
})

test('a chart that isn’t the one published is never used', async ({ launch, clusters }) => {
  // A byte off, as a copy changed on the way (or on disk) would be.
  const chart = readFileSync('src/backend/helm/metrics-stack/prometheus-29.36.1.tgz')
  chart[chart.length - 1]! ^= 1
  const changed = join(mkdtempSync(join(tmpdir(), 'lumovi-chart-')), 'chart.tgz')
  writeFileSync(changed, chart)
  const lumovi = await launch({ env: { LUMOVI_TEST_STACK_CHART: changed } })
  const { page } = lumovi
  await openMetrics(page)
  await offer(page).click()
  const dialog = installing(page)
  await dialog.getByRole('button', { name: 'Review' }).click()
  const REFUSED = new RegExp(
    `^The chart Lumovi ships isn’t ${CHART.name} ${CHART.version} as it was published \\(its SHA-256 is [0-9a-f]{64}, not ${CHART.sha256}\\), so Lumovi installs nothing from it\\. Install Lumovi again\\.$`,
  )
  await expect(dialog.getByRole('alert')).toHaveText(REFUSED)
  await expect(dialog.getByRole('button', { name: 'Install' })).toHaveCount(0)
  // Nor installed, asked for without the review: helm never runs, and nothing is made.
  const refused = await page.evaluate(
    (context) => window.lumovi!.metricsStack.install({ context }),
    CONTEXTS.sandbox,
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'helm' } })
  expect(helmCalls(lumovi)).toEqual([])
  expect(there(clusters.sandbox)).toEqual([])
  const [event, ...others] = await audited(page)
  expect(event).toMatchObject({ action: 'helm.install', outcome: 'failure' })
  expect(event!.error).toMatch(REFUSED)
  // The dry run that was refused isn't an install: not recorded as one.
  expect(others).toEqual([])
})

test('installed and not coming up: why, as the cluster says, and the way out', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  await openMetrics(page)
  await offer(page).click()
  const dialog = installing(page)
  await dialog.getByRole('button', { name: 'Review' }).click()
  await expect(dialog).toContainText('The cluster accepts it')
  // The cluster takes the release, and refuses Prometheus' pod (its Pod Security, say).
  const REFUSAL = `pods "${SERVICE}-6fb44f6d65-" is forbidden: violates PodSecurity "restricted:latest"`
  clusters.sandbox.fail(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments/${SERVICE}`, {
    status: 200,
    method: 'GET',
    body: JSON.stringify({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: SERVICE, namespace: NAMESPACE, uid: 'refused' },
      spec: { replicas: 1 },
      status: {
        conditions: [{ type: 'ReplicaFailure', status: 'True', message: REFUSAL }],
      },
    }),
  })
  clusters.sandbox.fail(new RegExp(`/services/${SERVICE}:http/proxy/`), {
    status: 503,
    body: '{"kind":"Status","message":"no endpoints available for service"}',
  })
  await dialog.getByRole('button', { name: 'Install' }).click()
  await expect(toasts(page)).toContainText('Installed the metrics stack')
  const stuck = page.getByRole('main').getByRole('alert')
  await expect(stuck).toContainText('The metrics stack isn’t starting', { timeout: 30_000 })
  await expect(stuck).toContainText(`${SERVICE}: ${REFUSAL}`)
  await stuck.getByRole('button', { name: 'Remove…' }).click()
  const removing = page.getByRole('dialog', { name: /Remove the metrics stack/ })
  await removing.getByRole('textbox').fill(NAMESPACE)
  await removing.getByRole('button', { name: 'Remove' }).click()
  await expect(toasts(page)).toContainText('Removed the metrics stack')
  expect(there(clusters.sandbox)).toEqual([])
  await expect(offer(page)).toBeVisible()
})

test('removing asks the cluster for what removing takes', async ({ lumovi, clusters }) => {
  const { page } = lumovi
  // Lumovi's namespace, Helm's record of the release gone, and its cluster roles still there:
  // one the release's own, one of its name that someone else made.
  clusters.sandbox.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: NAMESPACE,
      uid: 'lumovis',
      creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { 'app.kubernetes.io/managed-by': 'lumovi' },
    },
    status: { phase: 'Active' },
  })
  clusters.sandbox.upsert(role(`${RELEASE}-server`, NAMESPACE))
  // Someone's own release of that name, in a namespace of theirs: the same name and labels.
  clusters.sandbox.upsert(role(`${RELEASE}-kube-state-metrics`, 'monitoring'))
  await openMetrics(page)
  const uninstall = () =>
    page.evaluate((context) => window.lumovi!.metricsStack.uninstall({ context }), CONTEXTS.sandbox)
  // Someone who may create it all, but not delete cluster roles, is told so, and nothing goes.
  clusters.sandbox.deny({ verb: 'delete', resource: 'clusterroles' })
  expect(await uninstall()).toEqual({
    ok: false,
    error: {
      code: 'forbidden',
      message:
        'The cluster doesn’t let you delete cluster roles, which removing it takes. Nothing was removed.',
    },
  })
  const status = await page.evaluate(async (context) => {
    const found = await window.lumovi!.metricsStack.status(context)
    return found.ok ? found.data.missing : undefined
  }, CONTEXTS.sandbox)
  expect(status).toEqual({ install: [], remove: ['cluster roles'] })
  expect(clusters.sandbox.object('Namespace', undefined, NAMESPACE)).toBeDefined()
})

test('what Helm lost track of is removed with the namespace, and no more', async ({
  lumovi,
  clusters,
}) => {
  const { page } = lumovi
  const ROLE = 'ClusterRole.rbac.authorization.k8s.io'
  clusters.sandbox.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: NAMESPACE,
      uid: 'lumovis',
      creationTimestamp: '2026-01-01T00:00:00Z',
      labels: { 'app.kubernetes.io/managed-by': 'lumovi' },
    },
    status: { phase: 'Active' },
  })
  clusters.sandbox.upsert(role(`${RELEASE}-server`, NAMESPACE))
  // Someone's own release of that name, in a namespace of theirs: the same name and labels.
  clusters.sandbox.upsert(role(`${RELEASE}-kube-state-metrics`, 'monitoring'))
  await openMetrics(page)
  const removed = await page.evaluate(
    (context) => window.lumovi!.metricsStack.uninstall({ context }),
    CONTEXTS.sandbox,
  )
  expect(removed).toEqual({ ok: true, data: null })
  expect(clusters.sandbox.object('Namespace', undefined, NAMESPACE)).toBeUndefined()
  // The release's own went; the other release's, of the same name, stays.
  expect(clusters.sandbox.object(ROLE, undefined, `${RELEASE}-server`)).toBeUndefined()
  expect(clusters.sandbox.object(ROLE, undefined, `${RELEASE}-kube-state-metrics`)).toBeDefined()
  // Helm had nothing to uninstall.
  expect(helmCalls(lumovi)).toEqual([])
})

/** A cluster role as a release named lumovi-metrics makes it, in `namespace`: Helm's mark says whose. */
const role = (name: string, namespace: string) => ({
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'ClusterRole',
  metadata: {
    name,
    uid: name,
    creationTimestamp: '2026-01-01T00:00:00Z',
    labels: { 'app.kubernetes.io/instance': RELEASE, 'app.kubernetes.io/managed-by': 'Helm' },
    annotations: {
      'meta.helm.sh/release-name': RELEASE,
      'meta.helm.sh/release-namespace': namespace,
    },
  },
  rules: [],
})

/** Every metric a file's PromQL names: cAdvisor's and kube-state-metrics'. */
const metricsIn = (text: string) => text.match(/\b(?:container|kube)_[a-z0-9_]+/g) ?? []

test('the stack keeps every series Lumovi asks for, and no other', () => {
  // Asked for: by the queries as they're built, and by name anywhere in the app's code.
  const built = [
    ...(['cpu', 'memory', 'rx', 'tx', 'restarts'] as const).flatMap((metric) => [
      usageQuery(metric, [], ['pod'], 120),
      nodeQuery(metric, 'node', ['pod'], 120),
      byNodeQuery(metric, [], 120),
    ]),
    ...rightsizingQueries(['default']).map((query) => query.expr),
  ].flatMap(metricsIn)
  const written = readdirSync('src', { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .flatMap((file) => metricsIn(readFileSync(join('src', file), 'utf8')))
  const asked = [...new Set([...built, ...written])].sort()

  // Kept: what Prometheus keeps of cAdvisor's, and what kube-state-metrics is let to say.
  const values = parse(readFileSync('src/backend/helm/metrics-stack/values.yaml', 'utf8'))
  const [keep] = values.scrapeConfigs['kubernetes-nodes-cadvisor'].metric_relabel_configs
  expect(keep).toMatchObject({ action: 'keep', source_labels: ['__name__'] })
  const [, prefix, names] = /^(\w+)\((.+)\)$/.exec(keep.regex)!
  const kept = [
    ...names!.split('|').map((name) => `${prefix}${name}`),
    ...values['kube-state-metrics'].metricAllowlist,
  ].sort()
  expect(kept).toEqual(asked)
  // And only pods are listed for them.
  expect(values['kube-state-metrics'].collectors).toEqual(['pods'])
})

/** A policy file, as IT would deploy it (LUMOVI_POLICY points at it, for trying one out). */
function policyFile(policy: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(path, JSON.stringify(policy))
  return path
}

test('a read-only cluster gets no offer to install', async ({ launch, clusters }) => {
  const { page } = await launch({
    env: { LUMOVI_POLICY: policyFile({ readOnly: [CONTEXTS.sandbox] }) },
  })
  await openMetrics(page)
  await expect(page.getByRole('main')).toContainText(
    'Lumovi can install a small one, once the cluster isn’t read-only.',
  )
  await expect(offer(page)).toHaveCount(0)
  const refused = await page.evaluate(
    (context) => window.lumovi!.metricsStack.install({ context }),
    CONTEXTS.sandbox,
  )
  expect(refused).toMatchObject({ ok: false, error: { code: 'read-only' } })
  expect(there(clusters.sandbox)).toEqual([])
})

test('an organization turns it off: not offered, not installed, not removed', async ({
  launch,
  clusters,
}) => {
  const lumovi = await launch({ env: { LUMOVI_POLICY: policyFile({ metricsStack: false }) } })
  const { page } = lumovi
  await openMetrics(page)
  await expect(page.getByRole('button', { name: 'Choose a service' })).toBeVisible()
  await expect(offer(page)).toHaveCount(0)
  await expect(page.getByRole('main')).not.toContainText('install a small one')
  const tried = await page.evaluate(
    async (context) => [
      await window.lumovi!.metricsStack.install({ context }),
      await window.lumovi!.metricsStack.uninstall({ context }),
    ],
    CONTEXTS.sandbox,
  )
  for (const refused of tried) {
    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'not-allowed',
        message: 'Your organization has turned off installing a metrics stack from Lumovi.',
      },
    })
  }
  expect(there(clusters.sandbox)).toEqual([])
  expect(helmCalls(lumovi)).toEqual([])
})

test('a cluster past what it’s sized for is told so before the review', async ({
  page,
  clusters,
}) => {
  // More pods than it's sized for, as the cluster counts them.
  clusters.sandbox.fail(/^\/api\/v1\/pods\?limit=1$/, {
    status: 200,
    body: JSON.stringify({
      kind: 'PodList',
      apiVersion: 'v1',
      metadata: { remainingItemCount: 4199 },
      items: [{ metadata: { name: 'one' } }],
    }),
  })
  await openMetrics(page)
  await offer(page).click()
  await expect(installing(page)).toContainText(
    `This is sized for small clusters, and ${CONTEXTS.sandbox} has 1 nodes and 4,200 pods.`,
  )
})
