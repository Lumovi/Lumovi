/**
 * What AI assistants may do, and where: the AI assistants page's Permissions
 * tab, and the tools keeping to it. Hidden namespaces aren't there for them;
 * Secrets, env values and logs show as the rules say; changes are asked
 * about, made or refused namespace by namespace.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AiDefaults, AiRule } from '../../src/shared/ai-permissions.ts'
import type { AssistantsStatus } from '../../src/shared/assistants.ts'
import { addMatcher, addRule, openPermissions, rulesNow } from './ai-rules.ts'
import { DEMO, expect, openCluster, test } from './fixtures.ts'

const DEFAULTS = { changes: 'ask', secrets: 'keys', env: 'sensitive', logs: 'read' } as const

const rule = (
  id: string,
  set: AiRule['set'],
  where: { clusters?: string[]; namespaces?: string[] },
): AiRule => ({
  id,
  name: id,
  clusters: where.clusters ?? [],
  namespaces: where.namespaces ?? [],
  set,
})

/** Keeps these as the person's AI permissions. */
async function permit(page: Page, rules: AiRule[], defaults: AiDefaults = DEFAULTS) {
  await page.evaluate((given) => window.lumovi!.aiPermissions!.set(given as never), {
    defaults,
    rules,
  })
}

/** A port nothing listens on (for now). */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** An assistant, connected to Lumovi on a port of the test's own. */
async function connect(page: Page): Promise<Client> {
  const port = await freePort()
  const status: AssistantsStatus = await page.evaluate(
    (port) => window.lumovi!.assistants!.configure({ enabled: true, port }),
    port,
  )
  const client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    }),
  )
  return client
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult
  return { text: (result.content[0] as { text: string }).text, error: result.isError === true }
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

test('Assistants keep to the rules: what’s hidden isn’t there, and Secrets, env values and logs show as they say', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  await page.getByRole('link', { name: 'Activity' }).click()
  await expect(page.getByRole('main')).toContainText(
    'Nothing yet: what assistants change, or ask to, shows here.',
  )
  await page.getByRole('button', { name: 'Back' }).click()
  const demo = clusters.demo
  // A namespace labelled for its team; a workload with what env values hold; a crashing pod,
  // and a warning about a namespace, where assistants won't see them; a namespace without labels.
  demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'bare', creationTimestamp: ago(3600) },
    status: { phase: 'Active' },
  })
  demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'payments', labels: { team: 'payments' }, creationTimestamp: ago(3600) },
    status: { phase: 'Active' },
  })
  demo.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'api', namespace: 'default', creationTimestamp: ago(3600), uid: 'api-1' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'api' } },
      template: {
        metadata: { labels: { app: 'api' } },
        spec: {
          containers: [
            {
              name: 'api',
              image: 'acme/api:1',
              env: [
                { name: 'LOG_LEVEL', value: 'debug' },
                { name: 'DB_PASSWORD', value: 'hunter2' },
                { name: 'DATABASE_URL', value: 'postgres://app:hunter2@db:5432/app' },
                // Words that only look like secrets' are shown; those that are, hidden.
                { name: 'MONKEY', value: 'banana' },
                { name: 'CONNECTION_TIMEOUT', value: '30' },
                { name: 'PWD', value: 'hunter2' },
                { name: 'apiKey', value: 'hunter2' },
                { name: 'GITHUBTOKEN', value: 'hunter2' },
                { name: 'CACHE', value: 'redis://:hunter2@cache:6379' },
                { name: 'ALERTS', value: 'https://hooks.slack.com/services/T0/B0/hunter2' },
                { name: 'CALLBACK', value: 'https://example.com/back?access_token=hunter2' },
                {
                  name: 'TOKEN',
                  valueFrom: { secretKeyRef: { name: 'postgres-credentials', key: 'password' } },
                },
              ],
            },
          ],
        },
      },
    },
    status: { replicas: 1, readyReplicas: 1, availableReplicas: 1 },
  })
  demo.upsert({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'broken', namespace: 'kube-system', creationTimestamp: ago(600) },
    spec: { containers: [{ name: 'broken', image: 'broken' }], nodeName: DEMO.nodes.worker1 },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'broken',
          ready: false,
          restartCount: 9,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
        },
      ],
    },
  })
  demo.upsert({
    apiVersion: 'v1',
    kind: 'Event',
    metadata: { name: 'about-system', namespace: 'default', creationTimestamp: ago(60) },
    involvedObject: { kind: 'Namespace', name: 'kube-system' },
    type: 'Warning',
    reason: 'Quota',
    message: 'Something about kube-system',
    count: 3,
    lastTimestamp: ago(60),
  })
  await permit(page, [
    rule('System', { visibility: 'hidden' }, { namespaces: ['kube-system'] }),
    rule('Sandbox', { visibility: 'hidden' }, { clusters: ['sandbox'] }),
    rule('Shop', { secrets: 'hidden', logs: 'off' }, { namespaces: ['shop'] }),
    rule('Data', { secrets: 'values', env: 'all' }, { namespaces: ['data'] }),
    rule('Batch', { changes: 'allow' }, { namespaces: ['batch'] }),
    rule('Monitoring', { changes: 'never' }, { namespaces: ['monitoring'] }),
    rule('Payments', { logs: 'off', changes: 'never' }, { namespaces: ['team=payments'] }),
    rule('Vaulted', { visibility: 'hidden' }, { namespaces: ['tier=secret'] }),
  ])
  const client = await connect(page)

  // What it's told: the clusters it may see, and the rules that say otherwise in some
  // namespaces; not what's hidden.
  const told = await call(client, 'list_clusters')
  expect(told.text).toMatch(/^current: demo\n/)
  expect(told.text).not.toContain('name: sandbox')
  expect(told.text).not.toContain('kube-system')
  expect(told.text).toContain(
    '    changes: ask\n    secrets: keys\n    env: sensitive\n    logs: read\n    inSomeNamespaces:\n      - namespaces: shop\n        secrets: hidden\n        logs: off\n',
  )
  expect(await call(client, 'list_kinds', { cluster: 'sandbox' })).toEqual({
    error: true,
    text: expect.stringMatching(/^There is no cluster called “sandbox”\. These are: demo, large, /),
  })

  // A hidden namespace isn't there: nothing in it, none of it in lists.
  expect(
    await call(client, 'list_resources', {
      cluster: 'demo',
      kind: 'pods',
      namespace: 'kube-system',
    }),
  ).toEqual({ error: false, text: 'kind: Pod\ntotal: 0\nitems: []\n' })
  const pods = await call(client, 'list_resources', { cluster: 'demo', kind: 'pods', limit: 500 })
  expect(pods.text).not.toContain('namespace: kube-system')
  expect(pods.text).toContain('namespace: shop')
  const namespaces = await call(client, 'list_resources', { cluster: 'demo', kind: 'ns' })
  expect(namespaces.text).not.toContain('kube-system')
  expect(namespaces.text).toContain('name: payments')
  for (const [args, missing] of [
    [{ kind: 'namespace', name: 'kube-system' }, 'namespaces "kube-system" not found'],
    [{ kind: 'pod', name: 'broken', namespace: 'kube-system' }, 'pods "broken" not found'],
  ] as const) {
    expect(await call(client, 'get_resource', { cluster: 'demo', ...args })).toEqual({
      error: true,
      text: missing,
    })
  }
  expect(
    await call(client, 'get_logs', { cluster: 'demo', namespace: 'kube-system', pod: 'broken' }),
  ).toEqual({ error: true, text: 'pods "broken" not found' })
  expect(await call(client, 'get_events', { cluster: 'demo', namespace: 'kube-system' })).toEqual({
    error: false,
    text: 'No events.',
  })
  const events = await call(client, 'get_events', { cluster: 'demo' })
  expect(events.text).not.toContain('kube-system')
  expect(
    await call(client, 'find_problems', { cluster: 'demo', namespace: 'kube-system' }),
  ).toEqual({
    error: false,
    text: 'Nothing is wrong in kube-system in demo: no unhealthy objects, and no warnings in the last hour.',
  })
  const problems = await call(client, 'find_problems', { cluster: 'demo' })
  expect(problems.text).toContain('namespace: shop')
  expect(problems.text).not.toContain('kube-system')

  // Secrets: hidden in shop, their values shown in data, only their keys elsewhere.
  expect(
    await call(client, 'list_resources', { cluster: 'demo', kind: 'secrets', namespace: 'shop' }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t show AI assistants the Secrets in shop: the person’s AI permissions say so (“Shop”).',
  })
  const secrets = await call(client, 'list_resources', { cluster: 'demo', kind: 'secrets' })
  expect(secrets.text).toMatch(
    /\nnotShown: \d+ more, in namespaces whose Secrets the person’s AI permissions hide\n/,
  )
  expect(secrets.text).not.toContain('namespace: shop')
  expect(
    (
      await call(client, 'get_resource', {
        cluster: 'demo',
        kind: 'secret',
        namespace: 'data',
        name: 'postgres-credentials',
      })
    ).text,
  ).toContain(`password: ${Buffer.from(DEMO.postgresPassword).toString('base64')}`)
  expect(
    await call(client, 'get_resource', {
      cluster: 'demo',
      kind: 'secret',
      namespace: 'shop',
      name: 'storefront-tls',
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t show AI assistants the Secrets in shop: the person’s AI permissions say so (“Shop”).',
  })
  // A cluster's own objects: as the cluster's rules say.
  expect(
    (
      await call(client, 'get_resource', {
        cluster: 'demo',
        kind: 'node',
        name: DEMO.nodes.worker1,
      })
    ).text,
  ).toMatch(/^# Health: /)
  // Env values: all hidden in data, the sensitive ones elsewhere.
  const api = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'default',
    name: 'api',
  })
  expect(api.text).toMatch(/- name: LOG_LEVEL\n\s+value: debug\n/)
  expect(api.text).toMatch(/- name: DB_PASSWORD\n\s+value: \(hidden by Lumovi\)\n/)
  expect(api.text).toMatch(/- name: DATABASE_URL\n\s+value: \(hidden by Lumovi\)\n/)
  expect(api.text).not.toContain('hunter2')
  for (const [name, value] of [
    ['MONKEY', 'banana'],
    ['CONNECTION_TIMEOUT', '"30"'],
  ]) {
    expect(api.text).toMatch(new RegExp(`- name: ${name}\\n\\s+value: ${value}\\n`))
  }
  const postgres = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'statefulset',
    namespace: 'data',
    name: 'postgres',
  })
  expect(postgres.text).toMatch(/- name: PGDATA\n\s+value: \(hidden by Lumovi\)\n/)

  // Logs: not where the rules say.
  expect(
    await call(client, 'get_logs', {
      cluster: 'demo',
      namespace: 'shop',
      pod: DEMO.pods.storefront[0],
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t let AI assistants read logs in shop: the person’s AI permissions say so (“Shop”).',
  })
  // A label says where: payments' team.
  expect(
    (await call(client, 'get_logs', { cluster: 'demo', namespace: 'payments', pod: 'x' })).text,
  ).toBe(
    'Lumovi doesn’t let AI assistants read logs in payments: the person’s AI permissions say so (“Payments”).',
  )

  // Changes, namespace by namespace.
  const configMap = (namespace: string, name = 'flags') =>
    `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: ${namespace}`
  expect(
    await call(client, 'apply_manifest', {
      cluster: 'demo',
      manifest: configMap('batch'),
      reason: 'Flags.',
    }),
  ).toEqual({
    error: false,
    text: 'Created configmap flags. The kubectl command that does the same: kubectl apply --server-side --force-conflicts --field-manager=lumovi -f flags.yaml -n batch --context demo',
  })
  expect(
    await call(client, 'restart', {
      cluster: 'demo',
      kind: 'daemonset',
      namespace: 'monitoring',
      name: 'node-exporter',
      reason: 'Stuck.',
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t let AI assistants change monitoring in demo: the person’s AI permissions say so (“Monitoring”). Nothing was changed.',
  })
  for (const manifest of [
    configMap('kube-system'),
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: kube-system',
  ]) {
    expect(
      await call(client, 'apply_manifest', { cluster: 'demo', manifest, reason: 'Test.' }),
    ).toEqual({ error: true, text: 'namespaces "kube-system" not found' })
  }
  expect(
    await call(client, 'delete_resource', {
      cluster: 'demo',
      kind: 'pod',
      namespace: 'kube-system',
      name: 'broken',
      reason: 'Test.',
    }),
  ).toEqual({ error: true, text: 'namespaces "kube-system" not found' })
  expect(
    await call(client, 'apply_manifest', {
      cluster: 'demo',
      manifest:
        'apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\n  namespace: shop\nstringData:\n  a: b',
      reason: 'Test.',
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t show AI assistants the Secrets in shop: the person’s AI permissions say so (“Shop”).',
  })
  // Allowed, but reading a Secret into a workload (its logs could show it): the person sees it first.
  const reading = call(client, 'apply_manifest', {
    cluster: 'demo',
    reason: 'A worker.',
    manifest: [
      'apiVersion: v1',
      'kind: Pod',
      'metadata:',
      '  name: worker',
      '  namespace: batch',
      'spec:',
      '  containers:',
      '    - name: worker',
      '      image: acme/worker:1',
      '      envFrom:',
      '        - secretRef:',
      '            name: credentials',
      '  volumes:',
      '    - name: vault',
      '      csi:',
      '        driver: secrets-store.csi.k8s.io',
      '        nodePublishSecretRef:',
      '          name: vault-credentials',
    ].join('\n'),
  })
  const asked = page.getByRole('dialog', { name: 'Create Pod worker' })
  await asked.getByRole('button', { name: 'Reject…' }).click()
  await asked.getByRole('textbox', { name: 'Note' }).fill('Not with credentials.')
  await asked.getByRole('button', { name: 'Reject', exact: true }).click()
  expect((await reading).text).toBe(
    'The person rejected it in Lumovi, saying: “Not with credentials.”. Nothing was changed.',
  )
  // One that reads a Secret already, restarted: it reads nothing new, so it's made.
  demo.upsert({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'reader', namespace: 'batch', creationTimestamp: ago(600), uid: 'reader-1' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'reader' } },
      template: {
        metadata: { labels: { app: 'reader' } },
        spec: {
          containers: [
            {
              name: 'reader',
              image: 'acme/reader:1',
              envFrom: [{ secretRef: { name: 'credentials' } }],
            },
          ],
        },
      },
    },
    status: { replicas: 1, readyReplicas: 1 },
  })
  expect(
    (
      await call(client, 'restart', {
        cluster: 'demo',
        kind: 'deploy',
        namespace: 'batch',
        name: 'reader',
        reason: 'Stuck.',
      })
    ).text,
  ).toMatch(/^Restarted reader\. /)
  // A Namespace, as it would be labelled: hidden there, it isn't; refused there, it is.
  expect(
    await call(client, 'apply_manifest', {
      cluster: 'demo',
      manifest:
        'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: vaulted\n  labels:\n    tier: secret',
      reason: 'Test.',
    }),
  ).toEqual({ error: true, text: 'namespaces "vaulted" not found' })
  expect(
    await call(client, 'apply_manifest', {
      cluster: 'demo',
      manifest:
        'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: payments-two\n  labels:\n    team: payments',
      reason: 'Test.',
    }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t let AI assistants change payments-two in demo: the person’s AI permissions say so (“Payments”). Nothing was changed.',
  })
  // A custom resource definition's deletion deletes its objects in every namespace: not while
  // some are hidden, or refused.
  expect(
    await call(client, 'delete_resource', {
      cluster: 'demo',
      kind: 'crd',
      name: 'rollouts.argoproj.io',
      reason: 'Unused.',
    }),
  ).toEqual({
    error: true,
    text: 'Deleting rollouts.argoproj.io deletes its objects in every namespace, and the person’s AI permissions don’t let assistants change all of them. Nothing was changed.',
  })
  // A cluster's own object, changed: as the cluster's rules say (ask).
  const deleting = call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'node',
    name: DEMO.nodes.worker3,
    reason: 'It’s gone.',
  })
  const node = page.getByRole('dialog', { name: `Delete Node ${DEMO.nodes.worker3}` })
  await node.getByRole('button', { name: 'Reject…' }).click()
  await node.getByRole('button', { name: 'Reject', exact: true }).click()
  expect((await deleting).text).toBe('The person rejected it in Lumovi. Nothing was changed.')
  // Allowed, and failing as it's made.
  const failing = demo.fail(/\/configmaps\/broken\?fieldManager=lumovi&force=true$/, {
    status: 500,
  })
  const broken = await call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest: configMap('batch', 'broken'),
    reason: 'Test.',
  })
  expect(broken.text).toMatch(/^Create ConfigMap broken failed: /)
  failing()
  // A cluster's own object: the default (ask).
  const creating = call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest: 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: scratch',
    reason: 'Room to try things.',
  })
  await page
    .getByRole('dialog', { name: 'Create Namespace scratch' })
    .getByRole('button', { name: /^Approve/ })
    .click()
  expect((await creating).text).toMatch(/^Created namespace scratch, approved in Lumovi\./)

  // What assistants did, on the page's Activity tab.
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  await page.getByRole('link', { name: 'Activity' }).click()
  const did = page.getByRole('region', { name: 'What assistants did' }).getByRole('listitem')
  await expect(did.filter({ hasText: 'Created namespace scratch' })).toContainText(
    /ago · demo · via Claude Code/,
  )
  await expect(did.filter({ hasText: 'Created configmap flags' })).toContainText(
    'demo / batch · via Claude Code',
  )
  await expect(did.filter({ hasText: 'Create Pod worker' })).toContainText(
    'demo / batch · rejected, asked by Claude Code“Not with credentials.”',
  )
  // Failed: what the cluster said.
  await expect(did.filter({ hasText: 'Created configmap broken' })).toContainText(
    'demo / batch · via Claude Code',
  )
  await expect(
    did.filter({ hasText: 'Created configmap broken' }).getByLabel('Failed'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Back' }).click()

  // Refused by the defaults, where no rule says otherwise.
  await permit(page, [], { ...DEFAULTS, logs: 'off' })
  expect(
    (await call(client, 'get_logs', { cluster: 'demo', namespace: 'default', pod: 'none' })).text,
  ).toBe(
    'Lumovi doesn’t let AI assistants read logs in default: the person’s AI permissions say so.',
  )
  // Every namespace may be changed now: the definition's deletion is asked about.
  const crd = { cluster: 'demo', kind: 'crd', name: 'rollouts.argoproj.io', reason: 'Unused.' }
  const deletingCrd = call(client, 'delete_resource', crd)
  const crdDialog = page.getByRole('dialog', {
    name: 'Delete CustomResourceDefinition rollouts.argoproj.io',
  })
  await crdDialog.getByRole('button', { name: 'Reject…' }).click()
  await crdDialog.getByRole('button', { name: 'Reject', exact: true }).click()
  expect((await deletingCrd).text).toBe('The person rejected it in Lumovi. Nothing was changed.')
  // Where it would reach can't be told: refused.
  const blind = demo.fail(/\/api\/v1\/namespaces(\?.*)?$/, { status: 403 })
  expect(await call(client, 'delete_resource', crd)).toEqual({
    error: true,
    text: expect.stringMatching(/^Lumovi can’t tell which namespaces that would reach: /),
  })
  blind()

  // Changed while it's connected: at once.
  await permit(page, [rule('Hidden', { visibility: 'hidden' }, { clusters: ['demo'] })])
  const hidden = await call(client, 'list_clusters')
  expect(hidden.text).not.toMatch(/^current:/)
  expect(hidden.text).not.toContain('name: demo')
  await client.close()
})

test('Labels the person can’t read count where they’re stricter', async ({ page, clusters }) => {
  await openCluster(page)
  const demo = clusters.demo
  await permit(page, [
    rule('Payments', { logs: 'off' }, { namespaces: ['team=payments'] }),
    rule('Others', { env: 'all' }, { namespaces: ['!team=payments'] }),
  ])

  // Namespaces listed once, then kept a while: one made since is read itself.
  const client = await connect(page)
  const logs = (namespace: string) =>
    call(client, 'get_logs', { cluster: 'demo', namespace, pod: 'none' })
  expect(await logs('default')).toEqual({ error: true, text: 'pods "none" not found' })
  demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'late', labels: { team: 'payments' }, creationTimestamp: ago(1) },
    status: { phase: 'Active' },
  })
  expect((await logs('late')).text).toMatch(/^Lumovi doesn’t let AI assistants read logs in late/)
  demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'later', creationTimestamp: ago(1) },
    status: { phase: 'Active' },
  })
  expect(await logs('later')).toEqual({ error: true, text: 'pods "none" not found' })
  // One that isn't there has nothing in it, whatever its rules.
  expect(await logs('nowhere')).toEqual({ error: true, text: 'pods "none" not found' })
  await client.close()

  // Neither the list nor the namespace can be read: the rule might apply, and it's stricter.
  const refused = demo.fail(/\/api\/v1\/namespaces(\/[^/?]+)?(\?.*)?$/, { status: 403 })
  const blind = await connect(page)
  expect(
    (await call(blind, 'get_logs', { cluster: 'demo', namespace: 'default', pod: 'none' })).text,
  ).toBe(
    'Lumovi doesn’t let AI assistants read logs in default: the person’s AI permissions say so (“Payments”).',
  )
  // Not payments' (maybe): all its env values hidden.
  const storefront = await call(blind, 'get_resource', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.storefront,
  })
  expect(storefront.text).toMatch(/- name: LOG_LEVEL\n\s+value: \(hidden by Lumovi\)\n/)
  refused()
  await blind.close()
})

test('The Permissions tab: defaults, rules where they apply, and any namespace checked', async ({
  page,
  clusters,
}) => {
  // Made read-only as the sidebar's switch does (the page reads settings once).
  await page.evaluate(() => window.lumovi!.app.setReadOnly('large', true))
  await page.reload()
  await openCluster(page)
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'payments', labels: { team: 'payments' }, creationTimestamp: ago(60) },
    status: { phase: 'Active' },
  })
  // One without labels at all.
  clusters.sandbox.upsert({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: 'bare', creationTimestamp: ago(60) },
    status: { phase: 'Active' },
  })
  await openPermissions(page)
  const glance = page.getByRole('region', { name: 'At a glance' })
  const stat = (label: string) =>
    glance.getByText(label, { exact: false }).locator('xpath=preceding-sibling::div[1]')
  // Every namespace of every context that can be listed; those that can't, said.
  await expect(stat('namespaces assistants see')).toHaveText('16')
  await expect(stat('where changes ask you first')).toHaveText(/^\d+$/)
  const notCounted = glance.getByText(/^Not counted: offline, expired, untrusted, /)
  await notCounted.click()
  await expect(glance.getByText(/^offline: connect ECONNREFUSED/)).toBeVisible()

  // Defaults: changes made without asking, Secrets' values read (and said where).
  const defaults = page.getByRole('region', { name: 'Defaults' })
  await defaults
    .getByRole('group', { name: 'Changes' })
    .getByRole('button', { name: 'Without asking' })
    .click()
  await expect(stat('where changes are made without asking')).not.toHaveText('0')
  await defaults
    .getByRole('group', { name: 'Secrets' })
    .getByRole('button', { name: 'Values' })
    .click()
  await expect(defaults).toContainText(
    'Assistants read Secret values, and send them to their model’s provider.',
  )
  await expect(stat('where they may read Secret values')).toHaveText('16')
  await defaults
    .getByRole('group', { name: 'Secrets' })
    .getByRole('button', { name: 'Keys only' })
    .click()
  await defaults
    .getByRole('group', { name: 'Changes' })
    .getByRole('button', { name: 'Ask you' })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => window.lumovi!.aiPermissions!.get().then((v) => v.mine.defaults)),
    )
    .toEqual(DEFAULTS)
  await expect(page.getByRole('status').filter({ hasText: /^Kept$/ })).toBeVisible()

  // A rule: typed where it applies, with what that means, then what it says.
  await expect(page.getByText('No rules of your own yet')).toBeVisible()
  await page.getByRole('button', { name: 'Add rule' }).click()
  const editor = page.getByRole('article').last()
  await editor.getByLabel('Name', { exact: true }).fill('Payments')
  const namespaces = editor.getByLabel('Namespaces', { exact: true })
  const suggested = editor
    .getByRole('group', { name: 'Suggestions for Namespaces' })
    .getByRole('button')
  await namespaces.fill('team')
  await expect(suggested).toHaveText(['Patternteam*none yet', 'Labelteam=payments1 namespace'])
  await namespaces.fill('a b')
  await expect(editor.getByRole('alert')).toHaveText('It has a space.')
  await expect(suggested).toHaveCount(0)
  await namespaces.fill('!kube')
  await expect(suggested.first()).toHaveText(/^Pattern!kube\*leaves out \d+ namespaces$/)
  await namespaces.press('Escape')
  await expect(namespaces).toHaveValue('')
  await addMatcher(editor, 'Namespaces', 'team=payments')
  // Given twice, it's there once; keys it doesn't use do nothing.
  await addMatcher(editor, 'Namespaces', 'team=payments')
  await expect(editor.getByRole('button', { name: 'Remove team=payments' })).toHaveCount(1)
  await namespaces.press('ArrowLeft')
  await addMatcher(editor, 'Namespaces', 'shop')
  await expect(editor.getByRole('button', { name: 'Remove team=payments' })).toBeVisible()
  // Backspace in an empty field takes the last one back; × takes any.
  await namespaces.press('Backspace')
  await expect(editor.getByRole('button', { name: 'Remove shop' })).toHaveCount(0)
  // What a chip is: a name left out says "not", a pattern left out "not pattern".
  await addMatcher(editor, 'Namespaces', '!kube-system')
  await addMatcher(editor, 'Namespaces', '!kube*')
  await expect(editor.getByText('not', { exact: true })).toBeVisible()
  await expect(editor.getByText('not pattern', { exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'Remove !kube-system' }).click()
  await editor.getByRole('button', { name: 'Remove !kube*' }).click()
  await addMatcher(editor, /^Contexts$/, 'demo')
  await addMatcher(editor, /^Contexts$/, 'large')
  await editor.getByRole('button', { name: 'Remove large' }).click()
  await editor
    .getByRole('group', { name: 'Logs' })
    .getByRole('button', { name: 'Don’t read' })
    .click()
  await editor
    .getByRole('group', { name: 'Secrets' })
    .getByRole('button', { name: 'Values' })
    .click()
  await expect(editor).toContainText(
    'Assistants read Secret values here, and send them to their model’s provider.',
  )
  await editor
    .getByRole('group', { name: 'Secrets' })
    .getByRole('button', { name: 'Not set' })
    .click()
  await expect(editor.getByRole('region', { name: 'What it matches' })).toContainText(
    'Matches 1 namespace in 1 context',
  )
  await expect(
    editor.getByRole('region', { name: 'What it matches' }).getByRole('listitem'),
  ).toHaveText(['paymentsdemo'])
  await editor.getByRole('searchbox', { name: 'Find in what it matches' }).fill('zzz')
  await expect(editor).toContainText('None of these has “zzz” in its name.')
  // Its header folds it away, as Done does.
  await editor.getByRole('button', { name: /^Payments/, expanded: true }).click()
  await expect(editor.getByRole('button', { name: 'Done' })).toBeHidden()
  const payments = page.getByRole('article', { name: 'Payments' })
  await expect(payments).toContainText('demo  /  team=payments')
  await expect(payments).toContainText('No logs1 namespace · 1 context')
  await expect
    .poll(async () => rulesNow(page))
    .toEqual([
      {
        id: expect.any(String),
        name: 'Payments',
        clusters: ['demo'],
        namespaces: ['team=payments'],
        set: { logs: 'off' },
      },
    ])

  // One matching more than can be shown: some, and how many more.
  await addRule(page, { name: 'Everything', set: {} })
  const everything = page.getByRole('article', { name: 'Everything' })
  await expect(everything).toContainText('Nothing set yet')
  await everything.getByRole('button', { name: /^Everything/ }).click()
  await expect(everything).toContainText('And 4 more: search to find one.')
  await everything.getByRole('searchbox', { name: 'Find in what it matches' }).fill('e')
  await expect(everything).toContainText(/with “e”: search to find one\.|paymentsdemo/)
  await everything.getByRole('button', { name: 'Delete rule' }).click()
  await addRule(page, { name: 'Nothing', namespaces: ['nope*'], set: { Visibility: 'Hidden' } })
  await page.getByRole('button', { name: /^Nothing/ }).click()
  await expect(page.getByRole('article', { name: 'Nothing' })).toContainText('Nothing matches yet.')
  await page
    .getByRole('article', { name: 'Nothing' })
    .getByRole('button', { name: 'Delete rule' })
    .click()

  // Any namespace, checked: what assistants may do there, and which rule says so.
  const check = page.getByRole('region', { name: 'Check a namespace' })
  const search = check.getByRole('searchbox', { name: 'Namespace' })
  await expect(search).toHaveAttribute('placeholder', 'Search 16 namespaces')
  await search.fill('zzz')
  await search.press('ArrowLeft')
  await expect(check).toContainText('No namespace has “zzz” in its name.')
  await search.fill('e')
  await expect(check).toContainText(/^.*\d+ found: type more to narrow them down/)
  await search.fill('paym')
  await expect(check).toContainText('1 found')
  await search.press('Enter')
  await expect(search).toHaveValue('')
  const decision = check.getByRole('definition')
  await expect(check.getByRole('term')).toHaveText([
    'Visibility',
    'Changes',
    'Secrets',
    'Env values',
    'Logs',
  ])
  await expect(decision).toHaveText([
    'VisibleDefaults',
    'Ask youDefaults',
    'Keys onlyDefaults',
    'Hide sensitiveDefaults',
    'Don’t readPayments',
  ])
  await search.fill('load')
  await check.getByRole('button', { name: /^load/ }).click()
  await expect(decision.nth(1)).toHaveText('Never: read-onlyThe cluster is read-only')
  await search.fill('default')
  await search.press('Escape')
  await expect(search).toHaveValue('')

  // Hidden: nothing else to say there.
  await addRule(page, { name: 'Shop', namespaces: ['shop'], set: { Visibility: 'Hidden' } })
  await search.fill('shop')
  await search.press('Enter')
  await expect(decision).toHaveText([
    'HiddenShop',
    '—Hidden namespaces show nothing',
    '—Hidden namespaces show nothing',
    '—Hidden namespaces show nothing',
    '—Hidden namespaces show nothing',
  ])
  // What assistants are told, as list_clusters says it.
  await expect(page.getByLabel('What assistants are told')).toContainText(
    '- name: demo\n  server: ',
  )
  await expect(page.getByLabel('What assistants are told')).toContainText(
    '  inSomeNamespaces:\n    - namespaces: team=payments\n      logs: off\n',
  )
  await expect(page.getByLabel('What assistants are told')).toContainText('- name: large')
  await expect(page.getByLabel('What assistants are told')).toContainText('changes: read-only')
})

test('Kept with the app’s settings, and what each context’s changes were, as rules', async ({
  launch,
}) => {
  const first = await launch()
  await permit(first.page, [rule('Shop', { logs: 'off' }, { namespaces: ['shop'] })])
  const settings = join(first.userDataDir, 'settings.json')
  await first.app.close()

  // Kept: the same rules when Lumovi opens again.
  const again = await launch({ userDataDir: first.userDataDir })
  expect(await rulesNow(again.page)).toEqual([
    rule('Shop', { logs: 'off' }, { namespaces: ['shop'] }),
  ])
  await again.app.close()

  // Before rules: what each context's changes were, a rule each (asking needs none).
  writeFileSync(
    settings,
    JSON.stringify({
      aiChanges: {
        demo: 'allow',
        sandbox: 'never',
        large: 'ask',
        'has space': 'allow',
        'p*': 'never',
        nope: 'maybe',
      },
    }),
  )
  const migrated = await launch({ userDataDir: first.userDataDir })
  expect(await rulesNow(migrated.page)).toEqual(
    [
      rule('context-1', { changes: 'allow' }, { clusters: ['demo'] }),
      rule('context-2', { changes: 'never' }, { clusters: ['sandbox'] }),
      // A name that reads as a pattern: only where that's stricter.
      rule('context-3', { changes: 'never' }, { clusters: ['p*'] }),
    ].map((r, i) => ({ ...r, name: ['demo', 'sandbox', 'p*'][i]! })),
  )
  await migrated.app.close()

  // Edited into something that doesn't make sense: nothing at all, until set again.
  mkdirSync(first.userDataDir, { recursive: true })
  writeFileSync(settings, JSON.stringify({ aiPermissions: { defaults: 'all' } }))
  const reset = await launch({ userDataDir: first.userDataDir })
  expect(await reset.page.evaluate(() => window.lumovi!.aiPermissions!.get())).toEqual({
    mine: { defaults: { changes: 'never', secrets: 'hidden', env: 'all', logs: 'off' }, rules: [] },
    admin: [],
    kept: 'settings',
  })
})
