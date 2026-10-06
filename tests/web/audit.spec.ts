/**
 * The audit log, served: what's done through Lumovi's page is recorded as
 * it was asked for and as it came out (who, from where, with the command
 * that does the same), kept on a volume, written on the server's output and
 * sent to a webhook; and found again on the Audit page, by whoever may.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import type { AuditEvent } from '../../src/shared/audit.ts'
import { call, connect } from './assistant-client.ts'
import {
  audited,
  DEMO,
  expect,
  PEOPLE,
  refusedConfig,
  signIn,
  startServer,
  test,
} from './fixtures.ts'

// One no step changes the owner of: storefront's are replaced as it restarts, a moment later.
const POD = DEMO.pods.checkout[2]!
/**
 * Whether a server the tests stop stops as Kubernetes stops it (SIGTERM): recording that it
 * stopped, and sending what's waiting. Windows can only end it at once.
 */
const GRACEFUL = process.platform !== 'win32'
const { version: VERSION } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string
}

/** As the proxy names someone (an auditor, with the group LUMOVI_AUDITORS names). */
async function as(context: BrowserContext, user: string, groups = '') {
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': user, 'X-Forwarded-Groups': groups })
}

/** A webhook that keeps what it's sent, answering as a test says. */
async function webhook() {
  const received: { headers: IncomingMessage['headers']; body: string; status: number }[] = []
  /** A status to answer with; or no answer at all. */
  let answer: (body: string) => number | 'never' = () => 200
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      const status = answer(body)
      if (status === 'never') return
      received.push({ headers: req.headers, body, status })
      res.writeHead(status, status === 302 ? { location: '/elsewhere' } : {}).end()
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/audit?token=secret`,
    received,
    answer: (next: (body: string) => number | 'never') => (answer = next),
    /** The events it took (not those it refused), in order: a JSON array a request, or a line each. */
    events: (): AuditEvent[] =>
      received
        .filter(({ status }) => status < 300)
        .flatMap(({ body }) =>
          body
            .split('\n')
            .filter(Boolean)
            .flatMap((line) => JSON.parse(line) as AuditEvent | AuditEvent[]),
        ),
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

/** What the page's person may see of the log, as the page asks for it. */
const query = (page: Page, q: object = {}) => page.evaluate((q) => window.lumovi!.audit.query(q), q)

/** Events as their action, outcome, summary and command: what the log said happened. */
const said = (events: AuditEvent[]) =>
  events.map(({ action, outcome, summary, command }) => ({
    action,
    outcome,
    summary,
    ...(command ? { command } : {}),
  }))

test('what’s done through the page is recorded: as it was asked, and as it went', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const hook = await webhook()
  const env = {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDIT_DIR: dir,
    LUMOVI_AUDITORS: 'auditors,user:ops@example.com',
    LUMOVI_AUDIT_WEBHOOK_URL: hook.url,
    LUMOVI_AUDIT_WEBHOOK_FORMAT: 'ndjson',
    LUMOVI_AUDIT_WEBHOOK_HEADERS: 'Authorization: Bearer hook-token',
  }
  const served = await serve({ env })
  await as(context, 'alice@example.com', 'auditors, developers')
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')

  clusters.demo.fail('/api/v1/namespaces/shop/configmaps/long', {
    status: 500,
    body: JSON.stringify({ message: 'x'.repeat(5000) }),
  })
  const outcomes = await page.evaluate(async (pod) => {
    const api = window.lumovi!
    const change = (r: object) => api.kube.change({ context: 'demo', ...r } as never)
    const deployment = { kind: 'Deployment', namespace: 'shop' }
    const made = { kind: 'ConfigMap', name: 'audit-made', namespace: 'shop' }
    const manifest = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: 'audit-made', namespace: 'shop' },
      data: { a: '1' },
    }
    const steps = [
      () =>
        change({
          ...deployment,
          name: 'storefront',
          change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 4 } } },
        }),
      () =>
        change({
          ...deployment,
          name: 'storefront',
          change: {
            action: 'patch',
            patchType: 'strategic',
            patch: {
              spec: {
                template: {
                  metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': 'now' } },
                },
              },
            },
          },
        }),
      () =>
        change({
          kind: 'Node',
          name: 'worker-1',
          change: { action: 'patch', patchType: 'merge', patch: { spec: { unschedulable: true } } },
        }),
      () =>
        change({
          kind: 'Node',
          name: 'worker-1',
          change: {
            action: 'patch',
            patchType: 'merge',
            patch: { spec: { unschedulable: false } },
          },
        }),
      () =>
        change({
          ...deployment,
          name: 'cart',
          change: {
            action: 'patch',
            patchType: 'json',
            patch: [
              { op: 'replace', path: '/metadata/labels/app.kubernetes.io~1name', value: 'x' },
              { op: 'add', path: '/spec/paused', value: true },
              { op: 'test' },
            ],
          },
        }),
      () =>
        change({
          kind: 'ConfigMap',
          namespace: 'shop',
          change: { action: 'create', object: manifest },
        }),
      () =>
        change({
          kind: 'ConfigMap',
          namespace: 'shop',
          change: {
            action: 'create',
            object: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { generateName: 'made-' } },
          },
        }),
      () =>
        change({
          ...made,
          change: {
            action: 'patch',
            patchType: 'merge',
            patch: { metadata: { labels: { a: 'b', c: 'd', e: 'f', g: 'h' } }, data: {} },
          },
        }),
      () =>
        change({
          ...made,
          change: { action: 'apply', object: manifest, fieldManager: 'lumovi', force: true },
        }),
      () =>
        change({
          ...made,
          change: { action: 'apply', object: manifest, fieldManager: 'lumovi', force: false },
        }),
      async () => {
        const got = await api.kube.get({ context: 'demo', ...made })
        return change({
          ...made,
          change: { action: 'replace', object: (got as { data: object }).data },
        })
      },
      () =>
        change({
          ...deployment,
          name: 'storefront',
          change: {
            action: 'patch',
            patchType: 'merge',
            subresource: 'status',
            patch: { status: { observedGeneration: 9 } },
          },
        }),
      () =>
        change({
          kind: 'Pod',
          name: pod,
          namespace: 'shop',
          change: { action: 'debug', container: 'debugger', image: 'busybox', target: 'app' },
        }),
      () =>
        change({
          kind: 'Pod',
          name: pod,
          namespace: 'shop',
          change: { action: 'debug', container: 'debugger-2', image: 'busybox' },
        }),
      () => change({ kind: 'Pod', name: pod, namespace: 'shop', change: { action: 'evict' } }),
      () =>
        change({
          ...made,
          change: { action: 'delete', propagation: 'Foreground', gracePeriodSeconds: 0 },
        }),
      () =>
        change({
          kind: 'ConfigMap',
          name: 'nothing-here',
          namespace: 'shop',
          change: { action: 'delete' },
        }),
      // Only tried: not recorded. Nor what isn't a change at all.
      () =>
        change({
          ...deployment,
          name: 'cart',
          change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 1 } } },
          dryRun: true,
        }),
      () => change({ change: { action: 'delete' } }),
      // A Secret's values went to the page: once, however often it's read again.
      () =>
        api.kube.get({
          context: 'demo',
          kind: 'Secret',
          name: 'postgres-credentials',
          namespace: 'data',
        }),
      () =>
        api.kube.get({
          context: 'demo',
          kind: 'Secret',
          name: 'postgres-credentials',
          namespace: 'data',
        }),
      () =>
        api.kube.get({
          context: 'demo',
          kind: 'ConfigMap',
          name: 'kube-root-ca.crt',
          namespace: 'shop',
        }),
      () =>
        api.helm.deploy({
          context: 'demo',
          namespace: 'shop',
          name: 'web',
          source: { chart: 'nginx', repository: 'https://charts.example.com', version: '1.2.3' },
          values: 'replicaCount: 2\nimage:\n  tag: x\n',
          install: true,
          createNamespace: true,
          dryRun: false,
        }),
      () =>
        api.helm.deploy({
          context: 'demo',
          namespace: 'shop',
          name: 'web',
          // Who it goes as (a robot's password) isn't recorded. (No query: Windows' helm, a
          // .cmd, takes plain arguments alone.)
          source: { chart: 'oci://robot:s3cret@registry.example.com/web' },
          values: '- not a map',
          dryRun: false,
        }),
      () =>
        api.helm.deploy({
          context: 'demo',
          namespace: 'shop',
          name: 'web',
          source: 'stored',
          values: ': :',
          dryRun: false,
        }),
      () =>
        api.helm.deploy({
          context: 'demo',
          namespace: 'shop',
          name: 'web',
          source: { chart: 'nginx' },
          values: '',
          dryRun: true,
        }),
      () => api.helm.rollback({ context: 'demo', namespace: 'shop', name: 'web', revision: 1 }),
      () =>
        api.helm.uninstall({ context: 'demo', namespace: 'shop', name: 'web', keepHistory: true }),
      () =>
        api.helm.uninstall({ context: 'demo', namespace: 'shop', name: 'web', keepHistory: false }),
      () => api.app.setReadOnly('demo', true),
      () =>
        change({ kind: 'ConfigMap', name: 'x', namespace: 'shop', change: { action: 'delete' } }),
      () => api.app.setReadOnly('demo', false),
      // Nothing to call it by; nothing it changes; and an error longer than a line can hold.
      () =>
        change({
          kind: 'ConfigMap',
          namespace: 'shop',
          change: {
            action: 'create',
            object: { apiVersion: 'v1', kind: 'ConfigMap', metadata: {} },
          },
        }),
      () =>
        change({
          kind: 'ConfigMap',
          name: 'kube-root-ca.crt',
          namespace: 'shop',
          change: { action: 'patch', patchType: 'merge', patch: {} },
        }),
      () =>
        change({
          kind: 'ConfigMap',
          name: 'long',
          namespace: 'shop',
          change: { action: 'delete' },
        }),
    ]
    const results: unknown[] = []
    for (const step of steps) results.push(await step())
    return results.map((r) =>
      (r as { ok?: boolean }).ok === false ? (r as { error: { code: string } }).error.code : 'ok',
    )
  }, POD)
  expect(outcomes).toEqual([
    ...['ok', 'ok', 'ok', 'ok', 'server', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'not-found'],
    ...['ok', 'ok', 'ok', 'ok', 'not-found', 'ok', 'invalid', 'ok', 'ok', 'ok', 'ok', 'ok'],
    ...[
      'not-found',
      'invalid',
      'ok',
      'ok',
      'ok',
      'ok',
      'read-only',
      'ok',
      'invalid',
      'ok',
      'server',
    ],
  ])
  const where = (cmd: string) => `${cmd} -n shop --context demo`
  const done = [
    { action: 'server.started', outcome: 'success', summary: `Lumovi ${VERSION} started` },
    {
      action: 'resource.scale',
      outcome: 'success',
      summary: 'Scaled Deployment storefront to 4 replicas',
      command: where('kubectl scale deployment/storefront --replicas=4'),
    },
    {
      action: 'resource.restart',
      outcome: 'success',
      summary: 'Restarted Deployment storefront',
      command: where('kubectl rollout restart deployment/storefront'),
    },
    {
      action: 'resource.patch',
      outcome: 'success',
      summary: 'Cordoned Node worker-1',
      command: 'kubectl cordon worker-1 --context demo',
    },
    {
      action: 'resource.patch',
      outcome: 'success',
      summary: 'Uncordoned Node worker-1',
      command: 'kubectl uncordon worker-1 --context demo',
    },
    {
      action: 'resource.patch',
      outcome: 'failure',
      summary: 'Change Deployment cart: metadata.labels["app.kubernetes.io/name"], spec.paused',
    },
    { action: 'resource.create', outcome: 'success', summary: 'Created ConfigMap audit-made' },
    { action: 'resource.create', outcome: 'success', summary: 'Created ConfigMap made-…' },
    {
      action: 'resource.patch',
      outcome: 'success',
      summary:
        'Changed ConfigMap audit-made: metadata.labels.a, metadata.labels.c, metadata.labels.e and 2 more',
    },
    {
      action: 'resource.apply',
      outcome: 'success',
      summary: 'Applied ConfigMap audit-made, taking over fields other managers had',
    },
    { action: 'resource.apply', outcome: 'success', summary: 'Applied ConfigMap audit-made' },
    {
      action: 'resource.replace',
      outcome: 'success',
      summary: 'Replaced ConfigMap audit-made with an edited one',
    },
    {
      action: 'resource.patch',
      outcome: 'failure',
      summary: 'Change Deployment storefront’s status: status.observedGeneration',
    },
    {
      action: 'resource.debug',
      outcome: 'success',
      summary: `Added the debug container debugger (busybox) to Pod ${POD}`,
      command: where(`kubectl debug -it ${POD} --image=busybox --container=debugger --target=app`),
    },
    {
      action: 'resource.debug',
      outcome: 'success',
      summary: `Added the debug container debugger-2 (busybox) to Pod ${POD}`,
      command: where(`kubectl debug -it ${POD} --image=busybox --container=debugger-2`),
    },
    { action: 'resource.evict', outcome: 'success', summary: `Evicted Pod ${POD}` },
    {
      action: 'resource.delete',
      outcome: 'success',
      summary: 'Deleted ConfigMap audit-made',
      command: where('kubectl delete configmap/audit-made'),
    },
    {
      action: 'resource.delete',
      outcome: 'failure',
      summary: 'Delete ConfigMap nothing-here',
      command: where('kubectl delete configmap/nothing-here'),
    },
    { action: 'secret.read', outcome: 'success', summary: 'Read Secret postgres-credentials' },
    {
      action: 'helm.install',
      outcome: 'success',
      summary: 'Installed nginx 1.2.3 as web',
      command:
        'helm install web nginx --repo https://charts.example.com --version 1.2.3 -f values.yaml --create-namespace --namespace shop --kube-context demo',
    },
    {
      action: 'helm.upgrade',
      outcome: 'success',
      summary: 'Upgraded web to oci://registry.example.com/web',
      command:
        'helm upgrade web oci://registry.example.com/web --namespace shop --kube-context demo',
    },
    { action: 'helm.upgrade', outcome: 'failure', summary: 'Upgrade web with new values' },
    {
      action: 'helm.rollback',
      outcome: 'success',
      summary: 'Rolled web back to revision 1',
      command: 'helm rollback web 1 --namespace shop --kube-context demo',
    },
    {
      action: 'helm.uninstall',
      outcome: 'success',
      summary: 'Uninstalled web, keeping its history',
      command: 'helm uninstall web --keep-history --namespace shop --kube-context demo',
    },
    {
      action: 'helm.uninstall',
      outcome: 'success',
      summary: 'Uninstalled web',
      command: 'helm uninstall web --namespace shop --kube-context demo',
    },
    { action: 'read-only.changed', outcome: 'success', summary: 'Made demo read-only in Lumovi' },
    {
      action: 'resource.delete',
      outcome: 'refused',
      summary: 'Delete ConfigMap x',
      command: where('kubectl delete configmap/x'),
    },
    { action: 'read-only.changed', outcome: 'success', summary: 'Made demo changeable in Lumovi' },
    { action: 'resource.create', outcome: 'failure', summary: 'Create ConfigMap (unnamed)' },
    { action: 'resource.patch', outcome: 'success', summary: 'Changed ConfigMap kube-root-ca.crt' },
    {
      action: 'resource.delete',
      outcome: 'failure',
      summary: 'Delete ConfigMap long',
      command: where('kubectl delete configmap/long'),
    },
  ]
  const { events } = await query(page)
  expect(said([...events].reverse())).toEqual(done)

  // Who, and from where; what it was done to (its uid, once the cluster said); what it set.
  const scaled = events.find((e) => e.action === 'resource.scale')!
  expect(scaled).toMatchObject({
    type: 'lumovi.audit',
    version: 1,
    category: 'change',
    actor: {
      user: 'alice@example.com',
      groups: ['auditors', 'developers'],
      via: 'ui',
      address: '127.0.0.1',
      userAgent: expect.stringContaining('Mozilla/5.0'),
    },
    cluster: 'demo',
    target: { kind: 'Deployment', name: 'storefront', namespace: 'shop', uid: expect.any(String) },
    details: { fields: ['spec.replicas'], patchType: 'merge', replicas: 4 },
  })
  expect(
    events.find((e) => e.action === 'resource.delete' && e.outcome === 'success'),
  ).toMatchObject({
    details: { propagation: 'Foreground', gracePeriodSeconds: 0 },
  })
  expect(events.find((e) => e.action === 'secret.read')).toMatchObject({
    category: 'access',
    target: { kind: 'Secret', name: 'postgres-credentials', namespace: 'data' },
    details: { keys: ['username', 'password', 'database'] },
  })
  // Never its values, nor who a chart's fetched as.
  expect(JSON.stringify(events)).not.toContain(DEMO.postgresPassword)
  expect(JSON.stringify(events)).not.toContain('s3cret')
  expect(events.find((e) => e.action === 'helm.install')!.details).toEqual({
    chart: 'nginx',
    version: '1.2.3',
    repository: 'https://charts.example.com',
    values: ['replicaCount', 'image'],
  })
  // However long what it says, an event stays a line.
  expect(events[0]!.error).toHaveLength(4000)
  expect(events[0]!.error).toMatch(/^x+…$/)
  expect(events.find((e) => e.outcome === 'refused')!.error).toBe(
    'demo is read-only in Lumovi. Allow changes to it to continue.',
  )

  // Found by where, what, through whom; one object's by its uid (and those that had none).
  const summaries = async (q: object) => (await query(page, q)).events.map((e) => e.summary)
  expect(await summaries({ namespaces: ['data'] })).toEqual(['Read Secret postgres-credentials'])
  expect(await summaries({ kinds: ['helmrelease'], outcomes: ['failure'] })).toEqual([
    'Upgrade web with new values',
  ])
  expect(await summaries({ assistants: ['Claude Code'] })).toEqual([])
  const storefront = { kind: 'Deployment', name: 'storefront', namespace: 'shop' }
  expect(await summaries({ target: { ...storefront, uid: scaled.target!.uid } })).toEqual([
    'Change Deployment storefront’s status: status.observedGeneration',
    'Restarted Deployment storefront',
    'Scaled Deployment storefront to 4 replicas',
  ])
  expect(await summaries({ target: { ...storefront, uid: 'another' } })).toEqual([
    'Change Deployment storefront’s status: status.observedGeneration',
  ])

  // Each a line on the server's output, as it was kept; and sent to the webhook, as it asked.
  const history = [...events].reverse()
  expect(audited(served).slice(0, history.length)).toEqual(history)
  await expect.poll(() => hook.events().length).toBe(history.length)
  expect(hook.events()).toEqual(history)
  expect(hook.received[0]!.headers).toMatchObject({
    authorization: 'Bearer hook-token',
    'content-type': 'application/x-ndjson',
  })
  // Kept a file a day, readable only by Lumovi; and its one writer's lock.
  const files = readdirSync(dir).sort()
  expect(files).toEqual([`audit-${history[0]!.time.slice(0, 10)}.jsonl`, 'audit.lock'])
  if (process.platform !== 'win32') {
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600)
  }
  // Each hash is what anyone works out with jq and sha256sum.
  for (const event of history) expect(hashOf(event)).toBe(event.hash)

  // Started again, it goes on from where it was: one chain, and it holds.
  await served.stop()
  await serve({ env, port: served.port })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  const resumed = [
    { action: 'server.started', outcome: 'success', summary: `Lumovi ${VERSION} started` },
    ...(GRACEFUL
      ? [{ action: 'server.stopped', outcome: 'success', summary: `Lumovi ${VERSION} stopped` }]
      : []),
    done.at(-1),
  ]
  const again = await query(page, { limit: resumed.length })
  expect(said(again.events)).toEqual(resumed)
  expect(again.events[0]!.seq).toBe(again.events[1]!.seq + 1)
  expect(again.events[0]!.prev).toBe(again.events[1]!.hash)
  expect(again.events[0]!.chain).toBe(history[0]!.chain)
  // Where it ended says nothing (of whose, or how many): the next page goes on from it.
  expect(again.next).toMatch(/^[\w-]{40,}$/)
  const before = await query(page, { limit: 1, after: again.next })
  expect(before.events[0]!.seq).toBe(again.events.at(-1)!.seq - 1)
  expect(await page.evaluate(() => window.lumovi!.audit.verify())).toEqual({
    checked: history.length + (GRACEFUL ? 2 : 1),
    from: history[0]!.time,
    to: again.events[0]!.time,
    last: { seq: again.events[0]!.seq, hash: again.events[0]!.hash },
    breaks: [],
    more: 0,
  })
  await hook.close()
})

/** The Audit page's list, and an event in it by what it says. */
const list = (page: Page) => page.getByRole('listbox', { name: 'Events' })
const row = (page: Page, summary: string | RegExp) =>
  list(page).getByRole('option', { name: summary })

/** Opens one of the toolbar's menus, and picks (or unpicks) its choices. */
async function pick(page: Page, menu: string, ...choices: string[]) {
  await page.getByRole('toolbar', { name: 'Filters' }).getByRole('button', { name: menu }).click()
  for (const choice of choices) {
    await page.getByRole('menuitemcheckbox', { name: choice }).click()
  }
  await page.keyboard.press('Escape')
}

test('the Audit page finds what was done, follows it as it happens, and tells all of each', async ({
  page,
  context,
  browser,
  serve,
}) => {
  const env = {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDIT_DIR: mkdtempSync(join(tmpdir(), 'lumovi-audit-')),
    LUMOVI_AUDITORS: 'auditors',
  }
  const served = await serve({ env })
  // Bob, who isn't an auditor, changes things too.
  const bobs = await browser.newContext({
    extraHTTPHeaders: { 'X-Forwarded-User': 'bob@example.com', 'X-Forwarded-Groups': 'developers' },
  })
  const bob = await bobs.newPage()
  await bob.goto(`${served.url}cluster/demo/pods`)
  await expect(bob.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await bob.evaluate(async () => {
    const api = window.lumovi!
    await api.kube.change({
      context: 'demo',
      kind: 'Deployment',
      name: 'cart',
      namespace: 'shop',
      change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 3 } } },
    })
    await api.kube.change({
      context: 'demo',
      kind: 'ConfigMap',
      name: 'gone',
      namespace: 'shop',
      change: { action: 'delete' },
    })
  })

  // Alice, an auditor, through a proxy that says where she is.
  await context.setExtraHTTPHeaders({
    'X-Forwarded-User': 'alice@example.com',
    'X-Forwarded-Groups': 'auditors',
    'X-Forwarded-For': '203.0.113.7',
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`${served.url}audit`)
  await expect(page.getByRole('heading', { name: /Audit log/ })).toBeVisible()
  await expect(page).toHaveTitle('Audit log — Lumovi')
  await expect(page.getByRole('main')).toContainText(
    'Kept on the server for 90 days. The oldest is from',
  )
  await expect(page.getByRole('main')).toContainText(
    'You see everyone’s: you’re one of its auditors.',
  )
  await expect(list(page).getByRole('option')).toHaveCount(3)
  await expect(row(page, /Delete ConfigMap gone, failed$/)).toBeVisible()
  await expect(row(page, /Scaled Deployment cart to 3 replicas$/)).toBeVisible()
  await expect(row(page, /Lumovi .* started$/)).toBeVisible()
  await expect(list(page)).toContainText('Today')

  // What happens as the page is open comes in on top, marked new.
  await bob.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(
    /Made demo read-only in Lumovi$/,
  )
  await expect(list(page).getByRole('option').first().getByLabel('New')).toBeVisible()

  // One event, all of it.
  await row(page, /Scaled Deployment cart/).click()
  const event = page.getByRole('complementary', { name: 'Event' })
  await expect(
    event.getByRole('heading', { name: 'Scaled Deployment cart to 3 replicas' }),
  ).toBeVisible()
  await expect(event).toContainText('Changes: scaled a workload')
  const who = event.getByRole('region', { name: 'Who' })
  await expect(who).toContainText('Personbob@example.com')
  await expect(who).toContainText('Groupsdevelopers')
  await expect(who).toContainText('ThroughLumovi’s page')
  await expect(who).toContainText('From127.0.0.1')
  await expect(who).toContainText('BrowserMozilla/5.0')
  await expect(event.getByRole('region', { name: 'Where' })).toContainText(
    'ClusterdemoNamespaceshopObjectDeployment cart',
  )
  await expect(event.getByRole('region', { name: 'Does the same' })).toContainText(
    'kubectl scale deployment/cart --replicas=3 -n shop --context demo',
  )
  await expect(event.getByRole('region', { name: 'Details' })).toContainText('replicas3')
  await expect(event.getByRole('region', { name: 'Details' })).toContainText('fieldsspec.replicas')
  await expect(event.getByRole('region', { name: 'In the log' })).toContainText('Place#2')
  // A failed one says why.
  await row(page, /Delete ConfigMap gone/).click()
  await expect(event.getByRole('note')).toHaveText('configmaps "gone" not found')
  // Lumovi's own.
  await row(page, /started$/).click()
  await expect(event.getByRole('region', { name: 'Who' })).toContainText('PersonLumovi itself')
  await expect(event.getByRole('region', { name: 'Who' })).toContainText('ThroughLumovi itself')
  await expect(event.getByRole('button', { name: /Everything/ })).toHaveCount(0)
  // By the keyboard: from the search into the list, up and down it, and away.
  await page.getByPlaceholder('Search what was done, by whom, where…').press('ArrowDown')
  await expect(list(page)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(event.getByRole('heading', { level: 2 })).toHaveText(
    'Scaled Deployment cart to 3 replicas',
  )
  await page.keyboard.press('ArrowUp')
  await expect(event.getByRole('heading', { level: 2 })).toHaveText('Delete ConfigMap gone')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(event.getByRole('heading', { level: 2 })).toHaveText(/Lumovi .* started/)
  await page.keyboard.press('Escape')
  await expect(event).toBeHidden()
  // Nothing open to close; keys the list doesn't take, it leaves.
  await page.keyboard.press('Escape')
  await page.keyboard.press('a')
  await expect(event).toBeHidden()
  // Closed with its button, the list has the keyboard again.
  await row(page, /Scaled Deployment cart/).click()
  await event.getByRole('button', { name: 'Close' }).click()
  await expect(list(page)).toBeFocused()

  // Narrowed: by person, kind, outcome, how, cluster, time and words; each said, and undone.
  const chosen = page.getByLabel('Chosen filters')
  // (Ticked, unticked, and ticked again.)
  await pick(page, 'Who', 'bob@example.com', 'bob@example.com', 'bob@example.com')
  await expect(page).toHaveURL(/[?&]user=bob%40example.com/)
  await expect(list(page).getByRole('option')).toHaveCount(3)
  await expect(chosen).toContainText('Who:bob@example.com')
  await pick(page, 'Kind', 'Settings')
  await expect(list(page).getByRole('option')).toHaveCount(1)
  await chosen.getByRole('button', { name: 'Remove kind filter' }).click()
  await pick(page, 'Outcome', 'Failed')
  await expect(list(page).getByRole('option')).toHaveCount(1)
  await chosen.getByRole('button', { name: 'Remove outcome filter' }).click()
  await pick(page, 'Through', 'An AI assistant')
  await expect(page.getByRole('heading', { name: 'No events match' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'Try fewer filters, other words, or further back.',
  )
  await chosen.getByRole('button', { name: 'Remove through filter' }).click()
  await pick(page, 'Cluster', 'demo')
  await expect(chosen).toContainText('Cluster:demo')
  await expect(list(page).getByRole('option')).toHaveCount(3)
  await chosen.getByRole('button', { name: 'Remove cluster filter' }).click()
  await chosen.getByRole('button', { name: 'Remove who filter' }).click()
  await expect(chosen).toBeHidden()
  await page.getByPlaceholder('Search what was done, by whom, where…').fill('cart replicas')
  await expect(list(page).getByRole('option')).toHaveCount(1)
  await page.getByPlaceholder('Search what was done, by whom, where…').fill('')
  await page.getByRole('button', { name: 'How far back' }).click()
  await page.getByRole('menuitemradio', { name: 'Last hour' }).click()
  await expect(page).toHaveURL(/[?&]range=1h/)
  await expect(list(page).getByRole('option')).toHaveCount(4)
  await page.getByRole('button', { name: 'How far back' }).click()
  await page.getByRole('menuitemradio', { name: 'Last 7 days' }).click()
  // From an event: its person's, or its object's.
  await row(page, /Scaled Deployment cart/).click()
  await event.getByRole('button', { name: 'Everything bob@example.com did' }).click()
  await expect(chosen).toContainText('Who:bob@example.com')
  await event.getByRole('button', { name: 'Its history' }).click()
  await expect(chosen).toContainText('Object:Deployment cart in shop')
  await expect(page).toHaveURL(/kind=Deployment&name=cart&ns=shop/)
  await expect(page).toHaveURL(/range=all/)
  await expect(list(page).getByRole('option')).toHaveCount(1)
  await chosen.getByRole('button', { name: 'Remove object filter' }).click()
  await expect(chosen).not.toContainText('Object:')
  await chosen.getByRole('button', { name: 'Clear all' }).click()
  await expect(list(page).getByRole('option')).toHaveCount(4)

  // Exported as the filters find them, in the order they happened.
  const exported = async (format: string) => {
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export' }).click()
    await page.getByRole('menuitem', { name: format }).click()
    const download = await downloading
    return { name: download.suggestedFilename(), text: readFileSync(await download.path(), 'utf8') }
  }
  const csv = await exported('CSV for spreadsheets')
  expect(csv.name).toMatch(/^lumovi-audit-\d{4}-\d{2}-\d{2}\.csv$/)
  const lines = csv.text.trimEnd().split('\r\n')
  expect(lines[0]).toBe(
    'time,user,via,assistant,action,outcome,cluster,namespace,kind,name,summary,command,approval,error,id,chain,seq,hash',
  )
  expect(lines).toHaveLength(5)
  expect(lines[1]).toContain(',lumovi,server,,server.started,success,')
  expect(lines[2]).toContain(
    ',bob@example.com,ui,,resource.scale,success,demo,shop,Deployment,cart,Scaled Deployment cart to 3 replicas,kubectl scale deployment/cart --replicas=3 -n shop --context demo,,,',
  )
  expect(lines[3]).toContain(',"configmaps ""gone"" not found",')
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Exported 4 events',
  )
  const jsonl = await exported('JSON Lines for log tools')
  expect(jsonl.name).toMatch(/\.jsonl$/)
  const exportedEvents = jsonl.text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as AuditEvent)
  expect(exportedEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  // One alone.
  await page.getByPlaceholder('Search what was done, by whom, where…').fill('cart replicas')
  await expect(list(page).getByRole('option')).toHaveCount(1)
  expect((await exported('JSON Lines for log tools')).text.trimEnd().split('\n')).toHaveLength(1)
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    'Exported 1 event',
  )
  await page.getByPlaceholder('Search what was done, by whom, where…').fill('')

  // Her own: from where the proxy says she is; a Helm release, opened in Lumovi; what it set.
  await page.evaluate(() =>
    window.lumovi!.helm.deploy({
      context: 'demo',
      namespace: 'shop',
      name: 'web',
      source: { chart: 'nginx', repository: 'https://charts.example.com', version: '1.2.3' },
      values: '',
      install: true,
      dryRun: false,
    }),
  )
  await row(page, /Installed nginx 1.2.3 as web/).click()
  await expect(event.getByRole('region', { name: 'Who' })).toContainText(
    'From127.0.0.1which says it’s forwarding for 203.0.113.7',
  )
  await expect(event.getByRole('region', { name: 'Details' })).toContainText('valuesnone')
  await expect(event.getByRole('link', { name: 'Open in Lumovi' })).toHaveAttribute(
    'href',
    /\/cluster\/demo\/helm$/,
  )
  // All of it, as it was recorded, to paste wherever.
  await event.getByRole('button', { name: 'Copy the event' }).click()
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as AuditEvent
  expect(copied).toMatchObject({ action: 'helm.install', actor: { forwardedFor: '203.0.113.7' } })
  await row(page, /Made demo read-only/).click()
  await expect(event.getByRole('region', { name: 'Details' })).toContainText('readOnlyyes')
  await event.getByRole('button', { name: 'Close' }).click()

  // Checked: each event follows from the one before it.
  await page.getByRole('button', { name: 'Check integrity' }).click()
  const integrity = page.getByRole('status', { name: 'Integrity' })
  await expect(integrity).toContainText('All 5 events hold.')
  await expect(integrity).toContainText(
    'follows from the one before it: none was changed, and none removed or put in between them.',
  )
  // What it can't show by itself: the newest's hash, to compare with a copy kept elsewhere.
  await expect(integrity).toContainText('shows what this can’t: the newest removed')
  await expect(integrity.getByRole('button', { name: 'Copy its hash' })).toBeVisible()
  await integrity.getByRole('button', { name: 'Close' }).click()
  await expect(integrity).toBeHidden()

  // The server restarts: the page connects again, and what's recorded since comes in.
  await served.stop()
  await serve({ env, port: served.port })
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(/Lumovi .* started$/)
  await bob.reload()
  await bob.evaluate(() => window.lumovi!.app.setReadOnly('demo', false))
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(
    /Made demo changeable in Lumovi$/,
  )
  await list(page).getByRole('option').first().click()
  await expect(event.getByRole('region', { name: 'Details' })).toContainText('readOnlyno')
  // Many at once, while the list is scrolled down: said, and back to them in a click.
  await page.setViewportSize({ width: 1280, height: 640 })
  await bob.evaluate(async () => {
    for (let i = 0; i < 12; i++) await window.lumovi!.app.setReadOnly('demo', i % 2 === 0)
  })
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(/Lumovi$/)
  // Scrolled down (the list hears of it a frame or two later).
  await list(page).evaluate(
    (el) =>
      new Promise((done) => {
        el.scrollTo({ top: el.scrollHeight })
        requestAnimationFrame(() => requestAnimationFrame(done))
      }),
  )
  await bob.evaluate(() => window.lumovi!.app.setReadOnly('demo', false))
  const fresh = page.getByRole('button', { name: '1 new event' })
  await expect(fresh).toBeVisible()
  await bob.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  await expect(page.getByRole('button', { name: '2 new events' })).toBeVisible()
  await page.getByRole('button', { name: '2 new events' }).click()
  await expect(page.getByRole('button', { name: /new event/ })).toBeHidden()

  // Narrowed to someone: what others do meanwhile doesn't come in; theirs does. (Bob's comes
  // after Alice's: once it's in, hers was heard.)
  await pick(page, 'Who', 'bob@example.com')
  await expect(page.getByLabel('Chosen filters')).toContainText('Who:bob@example.com')
  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  await bob.evaluate(() => window.lumovi!.app.setReadOnly('demo', false))
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(
    /Made demo changeable in Lumovi$/,
  )
  await expect(list(page).getByRole('option').filter({ hasText: 'alice@example.com' })).toHaveCount(
    0,
  )
  await bobs.close()
})

/**
 * An event's hash, as the docs say anyone can work it out: `jq -jcS 'del(.hash)' | sha256sum`.
 * (Where there's no jq, the same by hand: JSON, keys in order.)
 */
function hashOf(event: AuditEvent): string {
  const line = JSON.stringify(event)
  const jq = spawnSync('jq', ['-jcS', 'del(.hash)'], { input: line, encoding: 'utf8' })
  if (!jq.error) return createHash('sha256').update(jq.stdout).digest('hex')
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  const { hash: _, ...rest } = event
  return createHash('sha256').update(canonical(rest)).digest('hex')
}

const today = () => new Date().toISOString().slice(0, 10)
const dayFile = (dir: string, day = today()) => join(dir, `audit-${day}.jsonl`)
const linesOf = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean)
const eventsIn = (path: string) => linesOf(path).map((line) => JSON.parse(line) as AuditEvent)
const write = (path: string, events: (AuditEvent | string)[], end = '\n') =>
  writeFileSync(
    path,
    events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + end,
  )
const verify = (page: Page) => page.evaluate(() => window.lumovi!.audit.verify())
/** A folder's day files (and what else is there), not its writer's lock. */
const days = (dir: string) =>
  readdirSync(dir)
    .filter((name) => name !== 'audit.lock')
    .sort()

test('a history that was changed shows where, and how', async ({ page, context, serve }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const env = { LUMOVI_AUTH: 'proxy', LUMOVI_AUDIT_DIR: dir, LUMOVI_AUDITORS: 'auditors' }
  await as(context, 'alice@example.com', 'auditors')
  /** Starts the server, has a page of it open, and does `then` there; then stops it. */
  const running = async (then: () => Promise<void>) => {
    const served = await serve({ env })
    await page.goto(`${served.url}audit`)
    await expect(page.getByRole('heading', { name: /Audit log/ })).toBeVisible()
    await then()
    await served.stop()
  }
  await running(() =>
    page.evaluate(async () => {
      for (const readOnly of [true, false, true])
        await window.lumovi!.app.setReadOnly('demo', readOnly)
    }),
  )
  const file = dayFile(dir)
  const kept = eventsIn(file)
  expect(kept.map((e) => e.seq)).toEqual(GRACEFUL ? [1, 2, 3, 4, 5] : [1, 2, 3, 4])
  // Each holds the one before it's hash, and its own is what anyone works out.
  for (const [i, event] of kept.entries()) {
    expect(event.hash).toBe(hashOf(event))
    expect(event.prev).toBe(i === 0 ? '' : kept[i - 1]!.hash)
  }

  /** Where checking finds the chain doesn't hold: each place, oldest first. */
  const breaks = async (...expected: [number, string][]) => {
    const result = await verify(page)
    expect(result.breaks.map((b) => [b.seq, b.reason])).toEqual(expected)
    expect(result.more).toBe(0)
    return result
  }
  const CHANGED = 'Its hash isn’t what its contents give: it was changed after it was recorded.'
  // Edited after it was recorded: each one said, and the rest still checked.
  write(
    file,
    kept.map((e) => (e.seq === 2 || e.seq === 3 ? { ...e, summary: 'Nothing happened' } : e)),
  )
  await running(async () => {
    expect(await breaks([2, CHANGED], [3, CHANGED])).toMatchObject({
      checked: kept.length + 1,
      from: kept[0]!.time,
    })
    await page.getByRole('button', { name: 'Check integrity' }).click()
    const alert = page.getByRole('alert', { name: 'Integrity' })
    await expect(alert).toContainText('The log doesn’t hold in 2 places.')
    await expect(alert.getByRole('listitem')).toHaveText([
      /^#2 \(after .*\) Its hash isn’t what its contents give/,
      /^#3 \(after .*\) Its hash isn’t what its contents give/,
    ])
    // The newest, to compare with a copy kept elsewhere.
    const { last } = await verify(page)
    await expect(alert).toContainText(
      `Compare the newest there: #${last!.seq}, ${last!.hash.slice(0, 16)}…`,
    )
  })
  // One taken out, or several.
  write(
    file,
    kept.filter((e) => e.seq !== 3),
  )
  await running(async () => {
    await breaks([4, 'Event 3 is missing.'])
    await page.getByRole('button', { name: 'Check integrity' }).click()
    await expect(page.getByRole('alert', { name: 'Integrity' })).toContainText(
      'The log doesn’t hold in 1 place.',
    )
  })
  write(
    file,
    kept.filter((e) => e.seq !== 2 && e.seq !== 3),
  )
  await running(() => breaks([4, 'Events 2–3 are missing.']).then(() => undefined))
  // One repeated.
  write(file, [...kept.slice(0, 3), kept[2]!, ...kept.slice(3)])
  await running(() =>
    breaks([3, 'It’s number 3, after number 3: one was repeated, or moved.']).then(() => undefined),
  )
  // Replaced by another that hashes right, but doesn't follow (nor does the one after it).
  const replaced = { ...kept[2]!, prev: 'f'.repeat(64) }
  write(
    file,
    kept.map((e) => (e.seq === 3 ? { ...replaced, hash: hashOf(replaced) } : e)),
  )
  const NOT_FOLLOWING =
    'It doesn’t follow from the event before it: one of them was changed, or replaced.'
  await running(() => breaks([3, NOT_FOLLOWING], [4, NOT_FOLLOWING]).then(() => undefined))
  // Another chain's, put in where it goes on (two servers keeping theirs here at once, say).
  const other = { ...kept[2]!, chain: 'another' }
  write(
    file,
    kept.map((e) => (e.seq === 3 ? { ...other, hash: hashOf(other) } : e)),
  )
  // (The chain it was put in goes on from where it was: missing what was replaced.)
  const ANOTHER =
    'It’s from another chain than the events before it: two of Lumovi’s servers kept their events here at once, or one was put in.'
  await running(() => breaks([3, ANOTHER], [4, 'Event 3 is missing.']).then(() => undefined))
  // A chain that starts again in the same history: the events before it went.
  const fresh = { ...kept[0]!, id: 'fresh', seq: 1, prev: '' }
  write(file, [...kept, { ...fresh, hash: hashOf(fresh) }])
  await running(async () => {
    await breaks([
      1,
      `A new chain starts here, after event ${kept.length}: Lumovi started again without the events before it (they were removed, or couldn’t be read).`,
    ])
    // It goes on from the last.
    expect((await query(page, { limit: 1 })).events[0]!.seq).toBe(2)
  })
  // A line left unfinished (the computer stopped as it was written) stays as it was, on its own.
  const next = kept.length + 1
  const unfinished = `{"type":"lumovi.audit","seq":${next},"summa`
  write(file, [...kept, unfinished], '')
  await running(async () => {
    expect(
      await breaks([
        next,
        `Line ${next} of audit-${today()}.jsonl can’t be read as an audit event.`,
      ]),
    ).toMatchObject({ checked: kept.length + 1 })
    expect((await query(page, { limit: 1 })).events[0]!.seq).toBe(next)
  })
  expect(linesOf(file)[kept.length]).toBe(unfinished)
})

test('the history is kept as long as it’s set to, and found where it is', async ({
  page,
  context,
  serve,
}) => {
  await as(context, 'alice@example.com', 'auditors')
  const recorded = (seq: number, time: string, summary = `Event ${seq}`, prev = ''): AuditEvent => {
    const event = {
      type: 'lumovi.audit' as const,
      version: 1 as const,
      id: `e-${seq}`,
      chain: 'kept',
      seq,
      time,
      category: 'settings' as const,
      action: 'read-only.changed' as const,
      outcome: 'success' as const,
      actor: { user: 'alice@example.com', via: 'ui' as const },
      cluster: 'demo',
      summary,
      prev,
      hash: '',
    }
    return { ...event, hash: hashOf(event) }
  }
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

  // Only one, older than it keeps: kept, as the one the chain goes on from, until there's a newer.
  const old = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const ancient = recorded(7, '2020-01-01T10:00:00.000Z')
  write(dayFile(old, '2020-01-01'), [ancient])
  const env = (dir: string) => ({
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDIT_DIR: dir,
    LUMOVI_AUDITORS: 'auditors',
    LUMOVI_AUDIT_RETENTION_DAYS: '30',
  })
  let served = await serve({ env: env(old) })
  expect(days(old)).toEqual(['audit-2020-01-01.jsonl', `audit-${today()}.jsonl`])
  expect(eventsIn(dayFile(old))[0]).toMatchObject({ seq: 8, prev: ancient.hash })
  await served.stop()
  served = await serve({ env: env(old) })
  expect(days(old)).toEqual([`audit-${today()}.jsonl`])
  await served.stop()

  // Days of it: an old one let go, one that can't be read skipped, and what's searched for found.
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const yesterday = daysAgo(1).slice(0, 10)
  const twoDays = daysAgo(2).slice(0, 10)
  const first = recorded(1, `${twoDays}T08:00:00.000Z`, 'Two days ago')
  const second = recorded(2, `${yesterday}T08:00:00.000Z`, 'Yesterday morning', first.hash)
  const third = recorded(3, `${yesterday}T20:00:00.000Z`, 'Yesterday evening', second.hash)
  write(dayFile(dir, '2020-06-01'), [recorded(0, '2020-06-01T00:00:00.000Z')])
  write(dayFile(dir, twoDays), ['not an event', '{"type":"something else"}', first])
  write(dayFile(dir, yesterday), [second, third])
  // A file that isn't one of its days is left alone.
  writeFileSync(join(dir, 'notes.txt'), 'mine')
  served = await serve({ env: env(dir) })
  expect(days(dir)).toEqual(
    [
      `audit-${twoDays}.jsonl`,
      `audit-${yesterday}.jsonl`,
      `audit-${today()}.jsonl`,
      'notes.txt',
    ].sort(),
  )
  await page.goto(`${served.url}audit?range=all`)
  await expect(list(page).getByRole('option')).toHaveCount(4)
  await expect(list(page)).toContainText('Yesterday')
  const info = await page.evaluate(() => window.lumovi!.audit.info())
  expect(info).toMatchObject({ kept: 'files', retentionDays: 30, oldest: first.time })
  // Between two times: only the days that can have them are read.
  const between = await query(page, {
    from: `${yesterday}T12:00:00.000Z`,
    to: `${yesterday}T23:59:59.000Z`,
  })
  expect(between.events.map((e) => e.summary)).toEqual(['Yesterday evening'])
  // From before a day's first: back to the day before, and no further.
  const since = await query(page, { from: `${yesterday}T07:00:00.000Z` })
  expect(since.events.map((e) => e.summary).slice(-2)).toEqual([
    'Yesterday evening',
    'Yesterday morning',
  ])
  const before = await query(page, { to: `${yesterday}T12:00:00.000Z` })
  expect(before.events.map((e) => e.summary)).toEqual(['Yesterday morning', 'Two days ago'])
  // A page at a time.
  const one = await query(page, { limit: 1, to: `${yesterday}T23:59:59.000Z` })
  expect(one.events.map((e) => e.summary)).toEqual(['Yesterday evening'])
  const next = await query(page, { limit: 1, to: `${yesterday}T23:59:59.000Z`, after: one.next })
  expect(next.events.map((e) => e.summary)).toEqual(['Yesterday morning'])
  // The lines that aren't events are said where they are; the chain holds around them.
  expect((await verify(page)).breaks).toEqual([
    {
      seq: 1,
      time: '',
      reason: `Line 1 of audit-${twoDays}.jsonl can’t be read as an audit event.`,
    },
    {
      seq: 1,
      time: '',
      reason: `Line 2 of audit-${twoDays}.jsonl can’t be read as an audit event.`,
    },
  ])
  // Searched newest first, they're found where they are too.
  const all = await query(page, { limit: 1000 })
  expect(all.events.at(-1)!.summary).toBe('Two days ago')
  expect(all.scanned).toBe(all.events.length + 2)

  // Deleted while Lumovi runs: as if it had none, a page at a time too.
  rmSync(dayFile(dir, twoDays))
  expect(
    (await query(page, { to: `${yesterday}T12:00:00.000Z` })).events.map((e) => e.summary),
  ).toEqual(['Yesterday morning'])
  const evening = await query(page, { limit: 1, to: `${yesterday}T23:59:59.000Z` })
  const after = await query(page, {
    limit: 1,
    to: `${yesterday}T23:59:59.000Z`,
    after: evening.next,
  })
  expect(after.events.map((e) => e.summary)).toEqual(['Yesterday morning'])
  expect(after.next).toBeUndefined()
  // One that can't be read at all: the search says so.
  // (Not on Windows, nor as root, who reads it anyway.)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    chmodSync(dayFile(dir, yesterday), 0o000)
    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'The audit log couldn’t be searched' }),
    ).toBeVisible()
    await expect(page.getByRole('main')).toContainText('EACCES')
    // And an object's own, the same.
    await page.goto(`${served.url}cluster/demo/deployments?open=Deployment/shop/storefront`)
    const detail = page.getByRole('complementary', { name: 'Deployment storefront' })
    await detail.getByRole('tab', { name: 'Audit' }).click()
    await expect(
      detail.getByRole('heading', { name: 'The audit log couldn’t be searched' }),
    ).toBeVisible()
    await page.goto(`${served.url}audit`)
    await page.getByRole('button', { name: 'Check integrity' }).click()
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
      'Couldn’t check it',
    )
    chmodSync(dayFile(dir, yesterday), 0o600)
  }
  await served.stop()

  // Only lines that aren't events, a long way back: it starts afresh after the last that is.
  const big = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  write(dayFile(big), [
    recorded(41, daysAgo(0)),
    ...Array.from({ length: 2000 }, (_, i) => `junk ${i} ${'é'.repeat(30)}`),
  ])
  served = await serve({ env: env(big) })
  expect(JSON.parse(linesOf(dayFile(big)).at(-1)!)).toMatchObject({
    seq: 42,
    action: 'server.started',
  })
  await served.stop()
  const junk = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  writeFileSync(dayFile(junk, yesterday), '\nnothing here\n')
  served = await serve({ env: env(junk) })
  expect(eventsIn(dayFile(junk))[0]).toMatchObject({ seq: 1, prev: '' })
  await served.stop()

  // Years ago (kept for ten): its year is said.
  const years = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  write(dayFile(years, '2020-03-04'), [recorded(1, '2020-03-04T09:00:00.000Z')])
  served = await serve({ env: { ...env(years), LUMOVI_AUDIT_RETENTION_DAYS: '3650' } })
  await page.goto(`${served.url}audit?range=all`)
  await expect(list(page)).toContainText(/March 4, 2020/)
})

/** An event as Lumovi records it: hashed, following `prev`. */
function made(seq: number, time: string, prev = '', summary = `Event ${seq}`): AuditEvent {
  const event = {
    type: 'lumovi.audit' as const,
    version: 1 as const,
    id: `made-${seq}`,
    chain: 'made',
    seq,
    time,
    category: 'settings' as const,
    action: 'read-only.changed' as const,
    outcome: 'success' as const,
    actor: { user: 'alice@example.com', via: 'ui' as const },
    cluster: 'demo',
    summary,
    prev,
  }
  return { ...event, hash: hashOf(event as AuditEvent) }
}

/** Events that follow each other, from `from`, an hour apart on a day. */
function chained(from: number, count: number, day: string, prev = ''): AuditEvent[] {
  const events: AuditEvent[] = []
  for (let i = 0; i < count; i++) {
    const hour = String(Math.min(i, 23)).padStart(2, '0')
    const event = made(from + i, `${day}T${hour}:00:00.000Z`, events.at(-1)?.hash ?? prev)
    events.push(event)
  }
  return events
}

test('a history read a piece at a time: lines too long, many breaks, pages resumed', async ({
  page,
  context,
  serve,
}) => {
  await as(context, 'alice@example.com', 'auditors')
  const env = (dir: string, more: Record<string, string> = {}) => ({
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDIT_DIR: dir,
    LUMOVI_AUDITORS: 'auditors',
    ...more,
  })
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  // Longer than any event can be: whatever it says, it isn't one.
  const long = 'x'.repeat(1_200_000)

  // One first in its file, and one left unfinished at the end of another.
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const early = chained(1, 2, ago(2))
  const later = chained(3, 1, ago(1), early.at(-1)!.hash)
  write(dayFile(dir, ago(2)), [long, ...early])
  write(dayFile(dir, ago(1)), [...later, long], '')
  let served = await serve({ env: env(dir) })
  // It goes on from the last that is one.
  expect(eventsIn(dayFile(dir)).find((e) => e.action === 'server.started')).toMatchObject({
    seq: 4,
    prev: later[0]!.hash,
  })
  await page.goto(`${served.url}audit?range=all`)
  expect(await page.evaluate(() => window.lumovi!.audit.info())).toMatchObject({
    oldest: early[0]!.time,
  })
  expect((await verify(page)).breaks).toEqual([
    {
      seq: 1,
      time: '',
      reason: `Line 1 of audit-${ago(2)}.jsonl can’t be read as an audit event.`,
    },
    {
      seq: 4,
      time: later[0]!.time,
      reason: `Line 2 of audit-${ago(1)}.jsonl can’t be read as an audit event.`,
    },
  ])
  const all = await query(page, { limit: 1000 })
  expect(all.events.slice(-3).map((e) => e.seq)).toEqual([3, 2, 1])
  expect(all.scanned).toBe(all.events.length + 2)
  // A page at a time, each going on where the last ended: across days, and past what isn't one.
  const seen: number[] = []
  for (let after: string | undefined, pages = 0; pages < 20; pages++) {
    const one: { events: AuditEvent[]; next?: string } = await query(page, { limit: 1, after })
    seen.push(...one.events.map((e) => e.seq))
    if (!one.next) break
    after = one.next
  }
  expect(seen.slice(-3)).toEqual([3, 2, 1])
  // Where a page ended, written over meanwhile: read again from the file's end, and still right.
  const two = await query(page, { limit: 2, to: `${ago(1)}T23:59:59.000Z` })
  expect(two.events.map((e) => e.seq)).toEqual([3, 2])
  // (Where the event was, a line that isn't one now; the event, after it.)
  write(dayFile(dir, ago(2)), [
    long,
    early[0]!,
    'x'.repeat(JSON.stringify(early[1]).length),
    early[1]!,
  ])
  expect((await query(page, { after: two.next })).events.map((e) => e.seq)).toEqual([1])
  // (Shorter than where it was.)
  write(dayFile(dir, ago(2)), [early[0]!])
  expect((await query(page, { after: two.next })).events.map((e) => e.seq)).toEqual([1])
  await served.stop()

  // A search stopping at a line that isn't an event goes on from it, when asked.
  const junk = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const first = made(1, `${ago(1)}T08:00:00.000Z`, '', 'needle')
  write(dayFile(junk, ago(1)), [first, ...Array.from({ length: 250 }, (_, i) => `junk ${i}`)])
  served = await serve({ env: env(junk, { LUMOVI_AUDIT_SCAN_LIMIT: '100' }) })
  await page.goto(`${served.url}audit`)
  let found: { events: AuditEvent[]; next?: string; stopped?: boolean } = await query(page, {
    text: 'needle',
  })
  for (let pages = 0; found.stopped && pages < 5; pages++) {
    found = await query(page, { text: 'needle', after: found.next })
  }
  expect(found.events.map((e) => e.summary)).toEqual(['needle'])
  await served.stop()

  // A chain started again in the same history: a page at a time, by where each is, finds all.
  const restarted = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  write(dayFile(restarted, ago(2)), chained(1, 3, ago(2)))
  write(dayFile(restarted, ago(1)), chained(1, 2, ago(1)))
  served = await serve({ env: env(restarted) })
  await page.goto(`${served.url}audit`)
  const paged: number[] = []
  for (let after: string | undefined, pages = 0; pages < 20; pages++) {
    const one: { events: AuditEvent[]; next?: string } = await query(page, { limit: 1, after })
    paged.push(...one.events.map((e) => e.seq))
    if (!one.next) break
    after = one.next
  }
  expect(paged.slice(-5)).toEqual([2, 1, 3, 2, 1])
  await served.stop()

  // The clock set back a day: the newest day's file goes on, in the chain's order.
  const ahead = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  write(dayFile(ahead, tomorrow), [made(1, `${tomorrow}T08:00:00.000Z`)])
  served = await serve({ env: env(ahead) })
  await served.stop()
  expect(days(ahead)).toEqual([`audit-${tomorrow}.jsonl`])
  expect(eventsIn(dayFile(ahead, tomorrow)).map((e) => e.seq)).toEqual(
    GRACEFUL ? [1, 2, 3] : [1, 2],
  )

  // Changed in more places than are listed: how many more, said.
  const many = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  write(
    dayFile(many, ago(1)),
    chained(1, 105, ago(1)).map((e) => ({ ...e, summary: 'Changed' })),
  )
  served = await serve({ env: env(many) })
  await page.goto(`${served.url}audit`)
  const checked = await verify(page)
  expect(checked).toMatchObject({ checked: 106, more: 5 })
  expect(checked.breaks).toHaveLength(100)
  await page.getByRole('button', { name: 'Check integrity' }).click()
  const alert = page.getByRole('alert', { name: 'Integrity' })
  await expect(alert).toContainText('The log doesn’t hold in 105 places.')
  await expect(alert.getByRole('listitem').last()).toHaveText('…and 5 more.')
  await served.stop()
})

test('whatever an event is about, it stays a line, and hashes as jq has it', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_AUDIT_DIR: dir, LUMOVI_AUDITORS: 'auditors' },
  })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  // DEL, which jq writes escaped; and half a pair, which no two tools read the same.
  await page.evaluate(() => window.lumovi!.app.setReadOnly('a\u007fb\ud800c', true))
  // A name thousands of characters long, each written as six (the summary, the command and the
  // error all say it).
  await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'ConfigMap',
      name: '\u0001'.repeat(4000),
      namespace: 'shop',
      change: { action: 'delete' },
    }),
  )
  // A change to more of an object than its details hold: as many as fit, and that some didn't.
  const data = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`${String(i).padStart(2, '0')}${'k'.repeat(600)}`, 'v']),
  )
  await page.evaluate(
    (data) =>
      window.lumovi!.kube.change({
        context: 'demo',
        kind: 'ConfigMap',
        name: 'kube-root-ca.crt',
        namespace: 'shop',
        change: { action: 'patch', patchType: 'merge', patch: { data } },
      }),
    data,
  )
  // A number JSON tools write each their own way (1E+21, 1e+21): as its text. (Refused by the
  // cluster: its controllers would make as many pods.)
  const refusing = clusters.demo.fail('/apis/apps/v1/namespaces/shop/deployments/cart', {
    status: 422,
  })
  await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'Deployment',
      name: 'cart',
      namespace: 'shop',
      change: { action: 'patch', patchType: 'merge', patch: { spec: { replicas: 1e21 } } },
    }),
  )
  refusing()
  // What the cluster says of a Secret, without what it quotes (a value, it may be).
  await page.evaluate(() =>
    window.lumovi!.kube.change({
      context: 'demo',
      kind: 'Secret',
      name: 'gone',
      namespace: 'shop',
      change: { action: 'delete' },
    }),
  )
  const lines = linesOf(dayFile(dir))
  const events = lines.map((line) => JSON.parse(line) as AuditEvent)
  expect(events.find((e) => e.target?.kind === 'Secret')!.error).toBe(
    'It isn’t there. What the cluster said of the Secret isn’t kept: it can quote its values.',
  )
  expect(events.find((e) => e.action === 'resource.patch')!.details).toMatchObject({
    truncated: true,
  })
  expect(events.find((e) => e.action === 'resource.scale')!.details).toMatchObject({
    replicas: '1e+21',
  })
  const odd = events.find((e) => e.action === 'read-only.changed')!
  expect(odd.cluster).toBe('a\u007fb\ufffdc')
  const huge = events.find((e) => e.action === 'resource.delete')!
  expect(huge.summary.length).toBeLessThanOrEqual(1000)
  expect(huge.details).toEqual({ truncated: true })
  for (const [i, event] of events.entries()) {
    expect(Buffer.byteLength(lines[i]!)).toBeLessThanOrEqual(64 * 1024)
    expect(hashOf(event)).toBe(event.hash)
  }
  expect((await verify(page)).breaks).toEqual([])
})

test('what was read, refused, only tried, or set is recorded too', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_AUDITORS: 'auditors' } })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}cluster/demo/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  const secret = {
    context: 'demo',
    kind: 'Secret',
    namespace: 'data',
    name: 'postgres-credentials',
  }
  // A release's values and manifests (a Secret's data, they may hold).
  await page.evaluate(() => window.lumovi!.helm.release('demo', 'shop', 'storefront'))
  // A Secret the cluster won't show: refused, and said so.
  const refusing = clusters.demo.fail('/api/v1/namespaces/data/secrets/postgres-credentials', {
    status: 403,
  })
  await page.evaluate((q) => window.lumovi!.kube.get(q as never), secret)
  refusing()
  // A change to one only tried: its answer is the Secret, as it'd be.
  await page.evaluate(
    (q) =>
      window.lumovi!.kube.change({
        ...q,
        change: {
          action: 'patch',
          patchType: 'merge',
          patch: { metadata: { labels: { a: 'b' } } },
        },
        dryRun: true,
      } as never),
    secret,
  )
  // Where node shells run, and as what; and back to Lumovi's own.
  await page.evaluate(() =>
    window.lumovi!.app.setNodeShell('demo', { namespace: 'ops', image: 'busybox:1.37' }),
  )
  await page.evaluate(() => window.lumovi!.app.setNodeShell('demo', null))
  expect(
    audited(served)
      .filter((e) => ['helm.values.read', 'secret.read', 'node-shell.changed'].includes(e.action))
      .map(({ action, outcome, summary, error, details }) => ({
        action,
        outcome,
        summary,
        ...(error ? { error } : {}),
        ...(details ? { details } : {}),
      })),
  ).toEqual([
    {
      action: 'helm.values.read',
      outcome: 'success',
      summary: 'Read release storefront’s values and manifests',
    },
    {
      action: 'secret.read',
      outcome: 'refused',
      summary: 'Read Secret postgres-credentials',
      error: expect.any(String),
    },
    {
      action: 'secret.read',
      outcome: 'success',
      summary: 'Read Secret postgres-credentials',
      details: { keys: ['username', 'password', 'database'] },
    },
    {
      action: 'node-shell.changed',
      outcome: 'success',
      summary: 'Made node shells in demo run busybox:1.37 in ops',
      details: { namespace: 'ops', image: 'busybox:1.37' },
    },
    {
      action: 'node-shell.changed',
      outcome: 'success',
      summary: 'Made node shells in demo run as Lumovi’s defaults',
    },
  ])
})

test('recording changes alone, an assistant’s change refused is kept; what it read isn’t', async ({
  page,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_AUDIT_LEVEL: 'changes' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  await page.evaluate(() =>
    window.lumovi!.aiPermissions!.set({
      defaults: { changes: 'ask', secrets: 'hidden', env: 'sensitive', logs: 'read' },
      rules: [],
    }),
  )
  const { client } = await connect(page, served)
  await call(client, 'list_resources', { cluster: 'demo', kind: 'pods', namespace: 'shop' })
  const refused = await call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'secrets',
    namespace: 'data',
    name: 'postgres-credentials',
    reason: 'Tidying.',
  })
  expect(refused.error).toBe(true)
  expect(audited(served, 'assistant.tool')).toEqual([
    expect.objectContaining({
      outcome: 'refused',
      summary: 'Delete a resource: secrets postgres-credentials',
      details: expect.objectContaining({ tool: 'delete_resource', changing: true }),
    }),
  ])
})

test('an assistant’s call about a Secret that fails: what the cluster said isn’t kept', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  const failed = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'secrets',
    namespace: 'data',
    name: 'gone',
  })
  expect(failed.error).toBe(true)
  expect(audited(served, 'assistant.tool').at(-1)).toMatchObject({
    outcome: 'failure',
    error: 'It failed. What the cluster said of the Secret isn’t kept: it can quote its values.',
  })
})

test('one Lumovi keeps a history: another waits for it, and doesn’t start while it renews it', async ({
  clusters,
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const lock = join(dir, 'audit.lock')
  // (A lock nobody renews is stale after a second and a half.)
  const env = { LUMOVI_AUDIT_DIR: dir, LUMOVI_AUDIT_LOCK_STALE_MS: '1500' }
  const held = (holder: object) => writeFileSync(lock, JSON.stringify(holder))
  const now = Date.now()
  // Held by a process running here (this one), renewing it as it goes on: waited for, then said.
  const renewing = setInterval(
    () => held({ pid: process.pid, host: hostname(), at: Date.now() }),
    200,
  )
  held({ pid: process.pid, host: hostname(), at: now })
  const refused = await refusedConfig(clusters, env)
  clearInterval(renewing)
  expect(refused).toContain(
    `Another Lumovi (process ${process.pid} on ${hostname()}) keeps its audit history in ${dir}: waiting for it to stop (2 seconds at most).`,
  )
  expect(refused).toContain(
    `Another Lumovi (process ${process.pid} on ${hostname()}) keeps its audit history in ${dir}: two can’t, or they’d number events the same. Stop it, or give this one a folder of its own.`,
  )
  // Held by one elsewhere (a pod on a node that's gone, say), renewing it no more: waited for,
  // and taken over once it's stale.
  held({ pid: 4321, host: 'lumovi-7d9f-2', at: Date.now() })
  const waited = await serve({ env })
  expect(waited.log()).toContain('(process 4321 on lumovi-7d9f-2) keeps its audit history')
  expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ host: hostname() })
  await waited.stop()
  // Left by one that stopped: here, a process that's gone; elsewhere, one not heard from in a
  // while; or one that can't be read. Taken over at once, and let go of as it stops.
  for (const holder of [
    { pid: 2 ** 22 + 7, host: hostname(), at: now },
    { pid: 4321, host: 'lumovi-7d9f-2', at: now - 10 * 60_000 },
  ]) {
    held(holder)
    const served = await serve({ env })
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ host: hostname() })
    await served.stop()
    if (GRACEFUL) expect(existsSync(lock)).toBe(false)
  }
  writeFileSync(lock, 'not a lock')
  const served = await serve({ env })
  await served.stop()
  // A folder it can't write in (as one that isn't the system's administrator) stops it too.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const said = await refusedConfig(clusters, { LUMOVI_AUDIT_DIR: '/' })
    expect(said).toMatch(
      /LUMOVI_AUDIT_DIR \(\/\) can’t be written in: E(ACCES|ROFS|PERM)\b.*audit\.lock/,
    )
    expect(said).toContain(
      `Lumovi runs as user ${process.getuid?.()}: in Kubernetes, the pod’s fsGroup (the Helm chart’s podSecurityContext.fsGroup) must be one that may write to its volume.`,
    )
  }
})

test('a history whose folder goes while Lumovi runs: said once, and again if it goes again', async ({
  serve,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const served = await serve({ env: { LUMOVI_AUDIT_DIR: dir, LUMOVI_AUDIT_WATCH_MS: '300' } })
  const said = () =>
    served.log().split('The audit history can’t be looked after: ENOENT').length - 1
  rmSync(dir, { recursive: true })
  await expect.poll(said).toBe(1)
  // (Looked after again, and again: said once.)
  await new Promise((done) => setTimeout(done, 1000))
  expect(said()).toBe(1)
  // Back, and gone again.
  mkdirSync(dir)
  await new Promise((done) => setTimeout(done, 700))
  rmSync(dir, { recursive: true })
  await expect.poll(said).toBe(2)
  await served.stop()
})

test('events reach a webhook however it answers, and what doesn’t is said', async ({
  page,
  context,
  serve,
}) => {
  const hook = await webhook()
  const env = {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDITORS: 'auditors',
    LUMOVI_AUDIT_WEBHOOK_URL: hook.url,
    LUMOVI_AUDIT_WEBHOOK_BUFFER: '10',
    LUMOVI_AUDIT_WATCH_MS: '300',
    LUMOVI_AUDIT_SMALLER_MS: '1000',
  }
  // Down at first (500): sent again, a while later; then taking one event at a time (413 for
  // more): sent in smaller batches, until they're taken.
  let down = true
  hook.answer((body) => {
    if (down) {
      down = false
      return 500
    }
    return (JSON.parse(body) as unknown[]).length > 1 ? 413 : 200
  })
  const served = await serve({ env })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}cluster/demo/pods`)
  await page.evaluate(async () => {
    for (const readOnly of [true, false]) await window.lumovi!.app.setReadOnly('demo', readOnly)
  })
  await expect.poll(() => hook.events().map((e) => e.seq), { timeout: 15_000 }).toEqual([1, 2, 3])
  // However they fell into batches: refused while more than one, taken one at a time.
  expect(hook.received[0]!.status).toBe(500)
  for (const { body, status } of hook.received.slice(1)) {
    expect(status).toBe((JSON.parse(body) as unknown[]).length > 1 ? 413 : 200)
  }
  expect(hook.received.some(({ status }) => status === 413)).toBe(true)
  expect(hook.received[0]!.headers['content-type']).toBe('application/json')

  // Events it refuses (400) can't ever be sent: let go, counted, and said, there and here. (By
  // then, a while later, batches are as large as they were: sent whole.)
  await page.waitForTimeout(1100)
  hook.answer(() => 400)
  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  await expect
    .poll(() => audited(served, 'audit.dropped').map((e) => e.summary), { timeout: 15_000 })
    .toEqual([`1 audit event couldn’t be sent to ${hook.url.replace(/\?.*/, '')}`])
  expect(audited(served, 'audit.dropped')[0]).toMatchObject({
    outcome: 'failure',
    category: 'server',
    error: 'It answered 400.',
    details: { count: 1 },
  })
  expect(served.log()).toContain(
    `couldn’t be sent to ${hook.url.replace(/\?.*/, '')}: It answered 400`,
  )
  // Saying so is refused too: that isn't news, nor said again, and again.
  await expect.poll(() => hook.received.at(-1)!.body).toContain('"action":"audit.dropped"')
  await page.waitForTimeout(1000)
  expect(audited(served, 'audit.dropped')).toHaveLength(1)
  // Never its token: the query isn't said.
  expect(served.log()).not.toContain('token=secret')
  await page.goto(`${served.url}audit`)
  const problems = page.getByRole('main').getByRole('alert')
  const base = hook.url.replace(/\?.*/, '')
  await expect(problems).toHaveText(
    `1 audit event couldn’t be sent to ${base} since Lumovi started. It answered 400.`,
  )

  // Unreachable: what's waiting is said as it's tried again, until more wait than it keeps (the
  // oldest let go).
  hook.answer(() => 200)
  await hook.close()
  await page.goto(`${served.url}cluster/demo/pods`)
  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', false))
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.audit.info()).then((i) => i.sinks[2]), {
      timeout: 15_000,
    })
    .toMatchObject({ name: base, problem: expect.stringMatching(/^It can’t be reached: /) })
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await window.lumovi!.app.setReadOnly('demo', i % 2 === 0)
  })
  // What's wrong now is said; why some were let go, as they were.
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.audit.info()).then((i) => i.sinks[2]))
    .toMatchObject({
      name: base,
      dropped: expect.any(Number),
      problem: 'It can’t be reached: the connection failed (ECONNREFUSED).',
    })
  await expect
    .poll(() => audited(served, 'audit.dropped').at(-1)!.error)
    .toBe(
      'More than 10 events (or 64 MiB of them) were waiting to be sent: the oldest were let go.',
    )
  await page.goto(`${served.url}audit`)
  await expect(problems).toContainText('couldn’t be sent to')
  await served.stop()
  expect(audited(served, 'audit.dropped').length).toBeGreaterThan(1)
})

test('a webhook that can’t be reached: what waits for it is said', async ({
  page,
  context,
  serve,
}) => {
  const hook = await webhook()
  await hook.close()
  const served = await serve({
    env: { LUMOVI_AUTH: 'proxy', LUMOVI_AUDITORS: 'auditors', LUMOVI_AUDIT_WEBHOOK_URL: hook.url },
  })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}audit`)
  const base = hook.url.replace(/\?.*/, '')
  // Asked again (it's checked every half a minute) until the first try has failed.
  await expect(async () => {
    await page.reload()
    await expect(page.getByRole('main').getByRole('alert')).toHaveText(
      `Events are waiting to be sent to ${base}. It can’t be reached: the connection failed (ECONNREFUSED).`,
      { timeout: 1000 },
    )
  }).toPass({ timeout: 15_000 })
})

test('what the webhook still has waiting is sent as the server stops', async ({
  page,
  context,
  serve,
}) => {
  test.skip(!GRACEFUL, 'Windows ends a server at once: Kubernetes, where servers run, stops them')
  const hook = await webhook()
  // Slow to answer at first: the server stops before its second second.
  const served = await serve({
    env: { LUMOVI_AUDIT_WEBHOOK_URL: hook.url, LUMOVI_AUDIT_WEBHOOK_FORMAT: 'json' },
  })
  await served.stop()
  expect(hook.events().map((e) => e.action)).toEqual(['server.started', 'server.stopped'])

  // One that doesn't answer: more wait than it keeps (the oldest let go), and as it stops, it
  // waits as long as stopping does; then what's left is counted as lost. Each why said on its
  // own, with how many (in the history, and the server's log).
  hook.answer(() => 'never')
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  const stuck = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDIT_WEBHOOK_URL: hook.url,
      LUMOVI_AUDIT_WEBHOOK_BUFFER: '10',
      LUMOVI_AUDIT_DIR: dir,
    },
  })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${stuck.url}cluster/demo/pods`)
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await window.lumovi!.app.setReadOnly('demo', i % 2 === 0)
  })
  await stuck.stop()
  const lost = eventsIn(dayFile(dir)).filter((e) => e.action === 'audit.dropped')
  expect(lost.map((e) => [e.error, e.details!.count])).toEqual([
    [
      'More than 10 events (or 64 MiB of them) were waiting to be sent: the oldest were let go.',
      expect.any(Number),
    ],
    ['Lumovi stopped before they could be sent.', 10],
  ])
  expect(stuck.log()).toContain('Lumovi stopped before they could be sent.')
  await hook.close()
})

test('a webhook that sends elsewhere, or doesn’t answer: said, never what was sent', async ({
  page,
  context,
  serve,
}) => {
  const hook = await webhook()
  hook.answer(() => 302)
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_AUDIT_WEBHOOK_URL: hook.url,
      LUMOVI_AUDIT_WEBHOOK_HEADERS: 'Authorization: Bearer hook-token',
      LUMOVI_AUDIT_ANSWER_MS: '500',
    },
  })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}audit`)
  const problem = () =>
    page.evaluate(() => window.lumovi!.audit.info()).then((i) => i.sinks[2]!.problem)
  // Redirected: not followed (who it goes as would go too).
  await expect.poll(problem, { timeout: 15_000 }).toBe('It can’t be reached: the request failed.')
  hook.answer(() => 'never')
  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  await expect
    .poll(problem, { timeout: 15_000 })
    .toBe('It can’t be reached: it didn’t answer within 0.5 seconds.')
  expect(served.log()).not.toContain('hook-token')
  hook.answer(() => 200)
  await expect.poll(problem, { timeout: 15_000 }).toBeUndefined()
  await hook.close()
})

test('without a volume, in memory; and recording less, or not on the output', async ({
  page,
  context,
  serve,
}) => {
  await as(context, 'alice@example.com', 'auditors')
  // As much as memory keeps (the oldest let go), since the server started: said.
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_AUDIT_MEMORY_EVENTS: '1100',
      LUMOVI_AUDIT_EXPORT_LIMIT: '1050',
      LUMOVI_AUDIT_LEVEL: 'changes',
      LUMOVI_AUDIT_STDOUT: 'false',
    },
  })
  expect(served.log()).toContain(
    'The audit history is kept in memory: the Audit page shows what happened since Lumovi started. Set LUMOVI_AUDIT_DIR (the Helm chart’s audit.persistence) to keep it.',
  )
  await page.goto(`${served.url}cluster/demo/pods`)
  await page.evaluate(async () => {
    const api = window.lumovi!
    for (let i = 0; i < 1150; i++) await api.app.setReadOnly('demo', i % 2 === 0)
    // Not recorded at this level: what's read (however many different things are).
    await api.kube.get({
      context: 'demo',
      kind: 'Secret',
      name: 'postgres-credentials',
      namespace: 'data',
    })
    for (let i = 0; i < 1010; i++) {
      await api.logs.start(`logs-${String(i).padStart(6, '0')}`, {
        context: 'demo',
        namespace: 'shop',
        pod: `nowhere-${i}`,
        container: 'app',
        previous: false,
        follow: false,
      })
    }
  })
  // A thousand at most at once; the oldest memory kept was let go.
  const first = await query(page, { limit: 5000 })
  expect(first.events).toHaveLength(1000)
  const rest = await query(page, { limit: 5000, after: first.next })
  expect(rest.events).toHaveLength(100)
  expect(rest.events.at(-1)!.seq).toBe(52)
  expect(rest.next).toBeUndefined()
  expect([...first.events, ...rest.events].some((e) => e.category === 'access')).toBe(false)
  expect(audited(served)).toEqual([])
  await page.goto(`${served.url}audit`)
  await expect(page.getByRole('main')).toContainText(
    'Kept in the server’s memory, since it started: set LUMOVI_AUDIT_DIR (the Helm chart’s audit.persistence) to keep it.',
  )
  await expect(page.getByRole('main')).toContainText(
    'It records changes, sign-ins and settings: not what’s opened or read (shells, logs, Secrets).',
  )
  expect(await page.evaluate(() => window.lumovi!.audit.info())).toMatchObject({
    kept: 'memory',
    level: 'changes',
    sinks: [{ name: 'history', dropped: 0 }],
    exportLimit: 1050,
  })
  // Scrolled down, older ones come as they're needed: all of them, a row each.
  await expect(async () => {
    await list(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    expect(await list(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(1100 * 58)
  }).toPass({ timeout: 20_000 })
  // Exported, as many as it holds: the most recent, said.
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'JSON Lines for log tools' }).click()
  const exported = readFileSync(await (await downloading).path(), 'utf8')
    .trimEnd()
    .split('\n')
  expect(exported).toHaveLength(1050)
  expect((JSON.parse(exported[0]!) as AuditEvent).seq).toBe(102)
  const notice = page.getByRole('region', { name: 'Notifications' })
  await expect(notice).toContainText('Exported 1,050 events')
  await expect(notice).toContainText(
    'The 1,050 most recent the filters find: narrow them (by time, say) for the rest.',
  )
  // Checked, it holds: one chain, from the oldest memory keeps.
  expect(await verify(page)).toMatchObject({ checked: 1100 })
})

test('a search looks so far back at once, and further when asked', async ({
  page,
  context,
  serve,
}) => {
  await as(context, 'alice@example.com', 'auditors')
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-data-')),
      LUMOVI_AUDIT_SCAN_LIMIT: '100',
      // One search at a time: the others wait their turn.
      LUMOVI_AUDIT_SEARCHES: '1',
    },
  })
  await page.goto(`${served.url}cluster/demo/pods`)
  // The first, and then many that aren't what's looked for.
  await page.evaluate(async () => {
    const api = window.lumovi!
    await api.kube.change({
      context: 'demo',
      kind: 'ConfigMap',
      name: 'needle',
      namespace: 'shop',
      change: { action: 'delete' },
    })
    for (let i = 0; i < 150; i++) await api.app.setReadOnly('demo', i % 2 === 0)
  })
  // Kept where LUMOVI_DATA_DIR is.
  expect(await page.evaluate(() => window.lumovi!.audit.info())).toMatchObject({ kept: 'files' })
  await page.goto(`${served.url}audit?q=needle`)
  await expect(page.getByRole('heading', { name: 'No events match' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'Lumovi looked through the 100 most recent events.',
  )
  await page.getByRole('button', { name: 'Look further back' }).click()
  await expect(row(page, /Delete ConfigMap needle/)).toBeVisible()
  // Some found, before it stopped: said below them, and the rest, further back, when asked.
  await page.goto(`${served.url}audit?q=demo`)
  await expect(row(page, /Made demo/).first()).toBeVisible()
  const footer = page
    .getByRole('main')
    .getByText(/^Lumovi looked through the 100 most recent events\./)
  await expect(footer).toBeVisible()
  await footer.getByRole('button', { name: 'Look further back' }).click()
  await expect(footer).toBeHidden()
  // At the end of the list (drawn as it's scrolled to).
  await expect(async () => {
    await list(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(row(page, /Delete ConfigMap needle/)).toBeVisible({ timeout: 500 })
  }).toPass()

  // What isn't a search is said.
  const refused = (q: unknown) =>
    page.evaluate(
      (q) =>
        window.lumovi!.audit.query(q as never).then(
          () => 'taken',
          (e: Error) => e.message,
        ),
      q,
    )
  const cases: [unknown, string][] = [
    [[], 'form'],
    [null, 'form'],
    [{ users: 'alice' }, 'users'],
    [{ users: [1] }, 'users'],
    [{ users: Array.from({ length: 101 }, () => 'x') }, 'users'],
    [{ categories: ['everything'] }, 'categories'],
    [{ outcomes: ['maybe'] }, 'outcomes'],
    [{ via: ['carrier pigeon'] }, 'via'],
    [{ actions: ['resource.burn'] }, 'actions'],
    [{ from: 'yesterday' }, 'from'],
    [{ to: 7 }, 'to'],
    [{ target: 'cart' }, 'object'],
    [{ target: null }, 'object'],
    [{ target: { name: 'cart' } }, 'object'],
    [{ target: { kind: 'Deployment', uid: 7 } }, 'object'],
    [{ text: 7 }, 'text'],
    [{ text: 'x'.repeat(501) }, 'text'],
    [{ after: 'not a place' }, 'place'],
    [{ after: 'x'.repeat(201) }, 'place'],
    [{ after: 7 }, 'place'],
    [{ limit: 1.5 }, 'limit'],
  ]
  for (const [q, what] of cases) {
    expect(await refused(q)).toBe(`An audit search’s ${what} isn’t what Lumovi takes.`)
  }
  // Where a page ended is sealed: one made up (or from before Lumovi started again) isn't taken.
  expect(await refused({ after: 'A'.repeat(60) })).toBe(
    'Where the page ended isn’t one this Lumovi gave (it may have started again since): search again.',
  )
  // Many searches at once: each waits its turn, and all are answered.
  expect(
    await page.evaluate(() =>
      Promise.all(
        Array.from({ length: 20 }, () => window.lumovi!.audit.query({ text: 'needle' })),
      ).then((pages) => pages.map((p) => p.stopped)),
    ),
  ).toEqual(Array.from({ length: 20 }, () => true))
  // As many as it takes, at most; at least one.
  expect((await query(page, { limit: 5000, users: ['alice@example.com'] })).events).toHaveLength(
    100,
  )
  expect((await query(page, { limit: 0 })).events).toHaveLength(1)
  expect(
    await refused({
      target: { kind: 'Deployment', name: 'cart', namespace: 'shop', uid: 'u' },
      actions: ['resource.scale'],
    }),
  ).toBe('taken')

  // To someone who sees only their own: how far it looked, not how many (that counts everyone's),
  // nor where else events go.
  await as(context, 'bob@example.com', 'developers')
  await page.goto(`${served.url}audit?q=needle`)
  await expect(page.getByRole('main')).toContainText(
    'Lumovi looked as far back as one search goes.',
  )
  const theirs = await query(page, { text: 'needle' })
  expect(theirs).toMatchObject({ stopped: true, events: [] })
  expect(theirs.scanned).toBeUndefined()
  const info = await page.evaluate(() => window.lumovi!.audit.info())
  expect(info).toMatchObject({ everyone: false, sinks: [] })
  expect(info.oldest).toBeUndefined()
})

test('the audit settings say what’s wrong with them', async ({ clusters }) => {
  const cases: [Record<string, string>, string][] = [
    [
      { LUMOVI_AUDIT_LEVEL: 'everything' },
      'LUMOVI_AUDIT_LEVEL must be changes or access, not "everything".',
    ],
    [
      { LUMOVI_AUDIT_RETENTION_DAYS: '0' },
      'LUMOVI_AUDIT_RETENTION_DAYS must be a whole number from 1 to 3,650, not "0".',
    ],
    [
      { LUMOVI_AUDIT_RETENTION_DAYS: '1.5' },
      'LUMOVI_AUDIT_RETENTION_DAYS must be a whole number from 1 to 3,650, not "1.5".',
    ],
    [
      { LUMOVI_AUDIT_MEMORY_EVENTS: '10' },
      'LUMOVI_AUDIT_MEMORY_EVENTS must be a whole number from 100 to 1,000,000, not "10".',
    ],
    [{ LUMOVI_AUDIT_STDOUT: 'yes' }, 'LUMOVI_AUDIT_STDOUT must be true or false, not "yes".'],
    [
      { LUMOVI_AUDIT_WEBHOOK_FORMAT: 'ndjson' },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS, _FORMAT and _BUFFER say how events are sent to LUMOVI_AUDIT_WEBHOOK_URL, which isn’t set.',
    ],
    [
      { LUMOVI_AUDIT_WEBHOOK_HEADERS: 'a: b' },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS, _FORMAT and _BUFFER say how events are sent',
    ],
    [
      { LUMOVI_AUDIT_WEBHOOK_BUFFER: '100' },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS, _FORMAT and _BUFFER say how events are sent',
    ],
    [
      { LUMOVI_AUDIT_WEBHOOK_URL: 'siem.example.com' },
      'LUMOVI_AUDIT_WEBHOOK_URL must be an http or https URL.',
    ],
    [
      { LUMOVI_AUDIT_WEBHOOK_URL: 'https://' },
      'LUMOVI_AUDIT_WEBHOOK_URL must be an http or https URL.',
    ],
    [
      { LUMOVI_AUDIT_WEBHOOK_URL: 'https://me:pw@siem.example.com/in' },
      'LUMOVI_AUDIT_WEBHOOK_URL can’t carry a user and password: put an Authorization header in LUMOVI_AUDIT_WEBHOOK_HEADERS.',
    ],
    [
      {
        LUMOVI_AUDIT_WEBHOOK_URL: 'https://siem.example.com/in',
        LUMOVI_AUDIT_WEBHOOK_FORMAT: 'xml',
      },
      'LUMOVI_AUDIT_WEBHOOK_FORMAT must be json or ndjson, not "xml".',
    ],
    [
      {
        LUMOVI_AUDIT_WEBHOOK_URL: 'https://siem.example.com/in',
        LUMOVI_AUDIT_WEBHOOK_HEADERS: '{a: [',
      },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS isn’t YAML: ',
    ],
    [
      {
        LUMOVI_AUDIT_WEBHOOK_URL: 'https://siem.example.com/in',
        LUMOVI_AUDIT_WEBHOOK_HEADERS: '- a',
      },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS must be a map of text, like { env: production }.',
    ],
    [
      {
        LUMOVI_AUDIT_WEBHOOK_URL: 'https://siem.example.com/in',
        LUMOVI_AUDIT_WEBHOOK_HEADERS: 'Bad Header: x',
      },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS: "Bad Header" isn’t a header’s name.',
    ],
    [
      {
        LUMOVI_AUDIT_WEBHOOK_URL: 'https://siem.example.com/in',
        LUMOVI_AUDIT_WEBHOOK_HEADERS: Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'),
      },
      'LUMOVI_AUDIT_WEBHOOK_HEADERS must be YAML, or YAML encoded in base64.',
    ],
  ]
  for (const [env, message] of cases) {
    expect(await refusedConfig(clusters, env)).toContain(message)
  }
  // What can carry a token is never said back: a URL that isn't one, nor a header's value.
  const said = await refusedConfig(clusters, {
    LUMOVI_AUDIT_WEBHOOK_URL: 'ftp://ingest:s3cret@siem.example.com/in',
  })
  expect(said).toContain('LUMOVI_AUDIT_WEBHOOK_URL must be an http or https URL.')
  expect(said).not.toContain('s3cret')
  const header = await refusedConfig(clusters, {
    LUMOVI_AUDIT_WEBHOOK_URL: 'https://siem.example.com/in',
    LUMOVI_AUDIT_WEBHOOK_HEADERS: 'Authorization: "Bearer s3cret\\r\\nX-Evil: 1"',
  })
  expect(header).toContain(
    'LUMOVI_AUDIT_WEBHOOK_HEADERS: Authorization’s value can’t be sent in a header (it has a line break, say).',
  )
  expect(header).not.toContain('s3cret')
  // Headers as base64-encoded YAML, as hosts with one-line settings take them; a scheme in
  // capitals, as some write it.
  const served = await startServer(clusters, {
    env: {
      LUMOVI_AUDIT_WEBHOOK_URL: 'HTTP://127.0.0.1:9/in',
      LUMOVI_AUDIT_WEBHOOK_HEADERS: Buffer.from('Authorization: Bearer x\n').toString('base64'),
      LUMOVI_AUDIT_WEBHOOK_FORMAT: 'ndjson',
    },
  })
  await served.stop()
})

test('a history that can’t be kept is said; its events still go everywhere else', async ({
  page,
  context,
  serve,
}) => {
  test.skip(process.platform !== 'linux', '/dev/full, which refuses every write, is Linux’s')
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-audit-'))
  // Today's file is a full disk.
  symlinkSync('/dev/full', dayFile(dir))
  await as(context, 'alice@example.com', 'auditors')
  const served = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_AUDIT_DIR: dir,
      LUMOVI_AUDIT_WATCH_MS: '300',
    },
  })
  await page.goto(`${served.url}cluster/demo/pods`)
  await page.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  // Said once, as it starts failing.
  expect(served.log().match(/The audit history can’t be kept: ENOSPC/g)).toHaveLength(1)
  expect(
    audited(served)
      .map((e) => e.action)
      .filter((action) => action !== 'audit.dropped'),
  ).toEqual(['server.started', 'read-only.changed'])
  // Both said (at once, or as they went), and only them: saying so can't be kept either, and
  // isn't said again, and again.
  const said = () =>
    audited(served, 'audit.dropped').reduce((sum, e) => sum + (e.details!.count as number), 0)
  await expect.poll(said, { timeout: 10_000 }).toBe(2)
  expect(audited(served, 'audit.dropped')[0]!.summary).toMatch(
    /^[12] audit events? couldn’t be kept in the history$/,
  )
  await page.waitForTimeout(1000)
  expect(said()).toBe(2)
  expect(await page.evaluate(() => window.lumovi!.audit.info())).toMatchObject({
    sinks: [
      { name: 'history', dropped: expect.any(Number), problem: expect.stringContaining('ENOSPC') },
      { name: 'the server’s output', dropped: 0 },
    ],
  })
})

test('people see what they did, and only that, as it happens', async ({
  page,
  context,
  browser,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_AUDITORS: 'auditors' } })
  // Carol (whose name could be a spreadsheet's formula), who isn't an auditor, has done nothing.
  await as(context, '-carol@example.com', 'developers')
  await page.goto(`${served.url}audit`)
  await expect(page.getByRole('heading', { name: 'Nothing yet' })).toBeVisible()
  await expect(page.getByRole('main')).toContainText(
    'What’s done through Lumovi shows here as it happens: changes, shells, port-forwards, logs and Secrets read, sign-ins, and what AI assistants do.',
  )
  await expect(page.getByRole('main')).toContainText(
    'You see your own: its auditors see everyone’s.',
  )
  await expect(page.getByRole('button', { name: 'Check integrity' })).toHaveCount(0)
  await expect(
    page.getByRole('toolbar', { name: 'Filters' }).getByRole('button', { name: 'Who' }),
  ).toHaveCount(0)
  await expect(page.evaluate(() => window.lumovi!.audit.verify())).rejects.toThrow(
    'Only an auditor checks the whole audit log: it holds everyone’s events.',
  )
  // Someone else's, as it happens: not hers.
  const alices = await browser.newContext({
    extraHTTPHeaders: { 'X-Forwarded-User': 'alice@example.com', 'X-Forwarded-Groups': 'auditors' },
  })
  const alice = await alices.newPage()
  await alice.goto(`${served.url}cluster/demo/pods`)
  await alice.evaluate(() => window.lumovi!.app.setReadOnly('demo', true))
  // Her own, as it happens: hers. (However many listen, and stop.)
  const heard = await page.evaluate(async () => {
    const api = window.lumovi!
    const got: string[] = []
    const first = api.audit.onEvent((e) => got.push(`first ${e.summary}`))
    const second = api.audit.onEvent((e) => got.push(`second ${e.summary}`))
    await api.app.setReadOnly('demo', false)
    await new Promise((done) => setTimeout(done, 300))
    first()
    await api.app.setReadOnly('demo', true)
    await new Promise((done) => setTimeout(done, 300))
    second()
    return got
  })
  expect(heard).toEqual([
    'first Made demo changeable in Lumovi',
    'second Made demo changeable in Lumovi',
    'second Made demo read-only in Lumovi',
  ])
  await expect(list(page).getByRole('option')).toHaveCount(2)
  await expect(list(page).getByRole('option').first()).toHaveAccessibleName(
    /Made demo read-only in Lumovi$/,
  )
  await alices.close()
  // Exported, what could be a formula is text.
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('menuitem', { name: 'CSV for spreadsheets' }).click()
  const csv = readFileSync(await (await downloading).path(), 'utf8').split('\r\n')
  expect(csv[1]).toMatch(/^[^,]+,'-carol@example\.com,ui,,read-only\.changed,/)

  // Signed in with a token: her session, by a hash of it, in what she did.
  const tokens = await serve({ env: { LUMOVI_AUDITORS: 'auditors' } })
  await context.setExtraHTTPHeaders({})
  await signIn(page, `${tokens.url}cluster/demo/pods`, PEOPLE.bob.token)
  await page.goto(`${tokens.url}audit`)
  await row(page, /Signed in with a token/).click()
  await expect(
    page.getByRole('complementary', { name: 'Event' }).getByRole('region', { name: 'Who' }),
  ).toContainText(/Session[0-9a-f]{16}/)
})
