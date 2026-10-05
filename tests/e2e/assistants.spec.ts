/**
 * AI assistants (Claude Code, Claude Desktop, Cursor, VS Code…) use Lumovi
 * through MCP: they read clusters with its tools, and the changes they ask for
 * wait in Lumovi for the person to approve. These tests are the assistant:
 * the MCP SDK's own client, over HTTP as most connect, and over stdio through
 * the bridge Claude Desktop starts.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { AssistantsStatus } from '../../src/shared/assistants.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import {
  clipboardText,
  CONTEXTS,
  COVERAGE_DIR,
  DEMO,
  DEMO_TOKEN,
  expect,
  mockOpenExternal,
  openCluster,
  test,
} from './fixtures.ts'

/** A port nothing listens on (for now). */
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/** Turns assistants on, on a port of the test's own. */
async function turnOn(page: Page): Promise<AssistantsStatus> {
  const port = await freePort()
  return page.evaluate(
    (port) => window.lumovi!.assistants!.configure({ enabled: true, port }),
    port,
  )
}

/** An assistant, connected as `name` says it's called (Claude Code's is claude-code). */
async function connect(status: AssistantsStatus, name = 'claude-code'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    }),
  )
  return client
}

/** Leaves, as an assistant that's closed does: its session ends. */
async function leave(client: Client): Promise<void> {
  await (client.transport as StreamableHTTPClientTransport).terminateSession()
  await client.close()
}

/** A tool's answer, as text, and whether it's an error. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  options?: RequestOptions,
): Promise<{ text: string; error: boolean }> {
  const result = (await client.callTool(
    { name, arguments: args },
    undefined,
    options,
  )) as CallToolResult
  return {
    text: (result.content[0] as { text: string }).text,
    error: result.isError === true,
  }
}

const approval = (page: Page, title: string | RegExp) => page.getByRole('dialog', { name: title })
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: 'AI assistants' })

test('AI assistants are turned on, and connected, from Lumovi', async ({ lumovi }) => {
  const { page, app } = lumovi
  // From the start screen, before a cluster is open.
  await page.getByRole('button', { name: 'AI assistants' }).click()
  const dialog = settingsDialog(page)
  await expect(dialog).toContainText('They ask: Each change shows here')
  await expect(dialog).toContainText('never Secrets’ values')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // From the command palette, and the menu.
  await openCluster(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'AI assistants…' }).click()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('assistants')!.click(),
  )
  await expect(dialog).toBeVisible()

  // Turned on, at a port of its own.
  const port = await freePort()
  await page.evaluate((port) => window.lumovi!.assistants!.configure({ port }), port)
  await dialog.getByRole('button', { name: 'Turn on' }).click()
  const url = `http://127.0.0.1:${port}/mcp`
  await expect(dialog).toContainText(`Listening at ${url}`)
  const { token } = await page.evaluate(() => window.lumovi!.assistants!.status())
  expect(token).toMatch(/^[\w-]{43}$/)
  // Kept where only you can read it.
  if (process.platform !== 'win32') {
    expect(statSync(join(lumovi.userDataDir, 'settings.json')).mode & 0o777).toBe(0o600)
  }

  // Claude Code's command shows the token in part, and copies all of it.
  const command = dialog.getByLabel('Command', { exact: true })
  await expect(command).toHaveText(
    `claude mcp add --transport http --scope user lumovi ${url} --header "Authorization: Bearer ${token!.slice(0, 4)}…"`,
  )
  await dialog.getByRole('button', { name: 'Copy command' }).click()
  await expect
    .poll(() => clipboardText(page))
    .toBe(
      `claude mcp add --transport http --scope user lumovi ${url} --header "Authorization: Bearer ${token}"`,
    )
  await dialog.getByRole('tab', { name: 'Other' }).click()
  await expect(dialog.getByLabel('Address', { exact: true })).toHaveText(url)
  await dialog.getByRole('button', { name: 'Copy header' }).click()
  await expect.poll(() => clipboardText(page)).toBe(`Authorization: Bearer ${token}`)
  // Claude Desktop is set up with a click, where there is one.
  await dialog.getByRole('tab', { name: 'Claude Desktop' }).click()
  await expect(dialog.getByRole('tabpanel')).toContainText(
    process.platform === 'linux' ? 'Claude Desktop isn’t made for Linux' : 'Add to Claude Desktop',
  )
  await dialog.getByRole('tab', { name: 'Cursor' }).click()
  await dialog.getByRole('button', { name: 'Copy Cursor’s settings' }).click()
  expect(JSON.parse(await clipboardText(page))).toEqual({
    mcpServers: { lumovi: { url, headers: { Authorization: `Bearer ${token}` } } },
  })

  // Connected assistants show by the names they give, once each.
  const connected = dialog.getByRole('region', { name: 'Connected now' })
  await expect(connected).toHaveText(/None yet/)
  const status = await page.evaluate(() => window.lumovi!.assistants!.status())
  const code = await connect(status, 'claude-code')
  const again = await connect(status, 'claude-code')
  const cursor = await connect(status, 'cursor-vscode')
  const other = await connect(status, 'some-new-assistant')
  // One that gives a title of its own goes by it.
  const titled = new Client({ name: 'acme-mcp', title: 'Acme Assistant', version: '2.0.0' })
  await titled.connect(
    new StreamableHTTPClientTransport(new URL(status.url!), {
      requestInit: { headers: { Authorization: `Bearer ${status.token}` } },
    }),
  )
  await expect(connected.getByRole('listitem')).toHaveText([
    'Claude Code×2',
    'Cursor',
    'some-new-assistant',
    'Acme Assistant',
  ])
  // The sidebar's button says one's connected.
  await expect(
    page.getByRole('button', { name: 'AI assistants (5 connected)', includeHidden: true }),
  ).toBeAttached()
  await leave(again)
  await leave(cursor)
  await leave(other)
  await leave(titled)
  await expect(connected.getByRole('listitem')).toHaveText(['Claude Code'])

  // A new token lets them all go.
  await dialog.getByRole('button', { name: 'New token…' }).click()
  await expect(dialog).toContainText('Claude Desktop picks the new one up itself')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.getByRole('button', { name: 'New token…' }).click()
  await dialog.getByRole('button', { name: 'Make a new token' }).click()
  await expect(connected).toHaveText(/None yet/)
  const renewed = await page.evaluate(() => window.lumovi!.assistants!.status())
  expect(renewed.token).not.toBe(token)
  await expect(call(code, 'list_clusters')).rejects.toThrow()

  // Turned off, it listens no more.
  await dialog.getByRole('switch', { name: 'Let AI assistants connect' }).click()
  await expect(dialog.getByRole('button', { name: 'Turn on' })).toBeVisible()
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
})

test('Lumovi says when its port is taken, and takes another', async ({ page }) => {
  await openCluster(page)
  const status = await turnOn(page)
  const taken = createServer()
  const busy = await new Promise<number>((resolve) =>
    taken.listen(0, '127.0.0.1', () => resolve((taken.address() as { port: number }).port)),
  )
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  const dialog = settingsDialog(page)
  const port = dialog.getByRole('textbox', { name: 'Port' })
  await expect(port).toHaveValue(String(status.port))
  // Enter with the port it has: nothing to change.
  await port.press('Enter')
  await expect(dialog).toContainText(`Listening at http://127.0.0.1:${status.port}/mcp`)

  // Not a port Lumovi can use.
  await port.fill('80')
  await expect(dialog.getByRole('button', { name: 'Use' })).toBeDisabled()
  await port.press('Enter')
  await expect(dialog).toContainText(`Listening at http://127.0.0.1:${status.port}/mcp`)
  await port.fill(`${busy}x`)
  await expect(port).toHaveValue(String(busy))
  await dialog.getByRole('button', { name: 'Use' }).click()
  await expect(dialog.getByRole('alert')).toContainText(
    `Lumovi can’t use port ${busy} (listen EADDRINUSE`,
  )
  await expect(dialog.getByRole('tablist')).toBeHidden()

  const free = await freePort()
  await port.fill(String(free))
  await port.press('Enter')
  await expect(dialog).toContainText(`Listening at http://127.0.0.1:${free}/mcp`)
  await expect(dialog.getByRole('button', { name: 'Use' })).toBeHidden()
  taken.close()
})

test('Assistants read clusters through Lumovi’s tools, never Secrets’ values', async ({ page }) => {
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.app.setReadOnly('large', true))
  const client = await connect(await turnOn(page))
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toEqual([
    'list_clusters',
    'list_kinds',
    'list_resources',
    'get_resource',
    'get_events',
    'get_logs',
    'find_problems',
    'apply_manifest',
    'scale',
    'restart',
    'delete_resource',
    'wait_for_change',
  ])
  expect(tools.find((t) => t.name === 'delete_resource')!.annotations).toMatchObject({
    destructiveHint: true,
  })

  const clusters = await call(client, 'list_clusters')
  expect(clusters.text).toMatch(/^current: demo\n/)
  expect(clusters.text).toContain('  - name: demo\n')
  expect(clusters.text).toMatch(/name: large\n.*\n.*\n\s+changes: read-only/)
  expect(clusters.text).toMatch(/name: sandbox\n.*\n\s+changes: ask/)

  const kinds = await call(client, 'list_kinds', { cluster: 'demo' })
  expect(kinds.text).toContain('- kind: Deployment\n  apiVersion: apps/v1\n  namespaced: true')
  expect(kinds.text).toContain('kind: Rollout.argoproj.io')

  // Lists, by any name kubectl takes.
  const pods = await call(client, 'list_resources', {
    cluster: 'demo',
    kind: 'po',
    namespace: 'shop',
    labelSelector: 'app.kubernetes.io/name=storefront',
  })
  expect(pods.text).toMatch(/^kind: Pod\ntotal: 3\nitems:/)
  expect(pods.text).toContain(`name: ${DEMO.pods.storefront[0]}`)
  expect(pods.text).toMatch(/ready: \d\/\d\n\s+restarts: 0\n\s+node: /)
  const checkout = await call(client, 'list_resources', {
    cluster: 'demo',
    kind: 'pods',
    namespace: 'shop',
    labelSelector: 'app.kubernetes.io/name=checkout',
  })
  expect(checkout.text).toContain('status: "CrashLoopBackOff (critical): back-off')
  const few = await call(client, 'list_resources', {
    cluster: 'demo',
    kind: 'Deployment',
    limit: 2,
  })
  expect(few.text).toMatch(/^kind: Deployment\ntotal: \d+\nshown: 2\n/)
  expect(few.text).toMatch(/ready: \d+\/\d+\n\s+images:\n\s+- /)
  for (const [kind, column] of [
    ['sts', 'ready:'],
    ['rs', 'ready:'],
    ['ds', 'ready:'],
    ['svc', 'clusterIP:'],
    ['nodes', 'roles:'],
    ['configmaps', 'age:'],
    ['rollouts.argoproj.io', 'status: Healthy (healthy)'],
  ]) {
    const list = await call(client, 'list_resources', { cluster: 'demo', kind })
    expect(list.error, kind).toBe(false)
    expect(list.text, kind).toContain(column)
  }

  // One object, its health first.
  const storefront = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'deployments.apps',
    name: DEMO.deployments.storefront,
    namespace: 'shop',
  })
  expect(storefront.text).toMatch(/^# Health: \w+ \(healthy\)/)
  expect(storefront.text).not.toContain('managedFields')
  const config = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'configmap',
    name: 'storefront-config',
    namespace: 'shop',
  })
  expect(config.text).toMatch(/^apiVersion: v1\nkind: ConfigMap\n/)
  const jobs = await call(client, 'list_resources', {
    cluster: 'demo',
    kind: 'jobs',
    namespace: 'batch',
  })
  expect(jobs.text).toContain('age: 20h')
  const namespace = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'ns',
    name: 'shop',
  })
  expect(namespace.text).toMatch(/^# Health: Active/)

  // A Secret's keys, not its values (nor kubectl's copy of them).
  const secret = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'secret',
    name: 'postgres-credentials',
    namespace: 'data',
  })
  expect(secret.text).toContain('password: (hidden by Lumovi)')
  expect(secret.text).not.toContain(DEMO.postgresPassword)
  expect(secret.text).not.toContain('last-applied-configuration')

  // Events: the latest first, about an object, or warnings only.
  const crashing = DEMO.pods.checkout[0]!
  const events = await call(client, 'get_events', {
    cluster: 'demo',
    namespace: 'shop',
    kind: 'Pod',
    name: crashing,
  })
  expect(events.text).toContain(`object: Pod/${crashing}`)
  expect(events.text).toContain('reason: BackOff')
  const warnings = await call(client, 'get_events', {
    cluster: 'demo',
    warningsOnly: true,
    limit: 3,
  })
  expect(warnings.text.match(/^- last: /gm)).toHaveLength(3)
  expect(warnings.text).not.toContain('type: Normal')
  const node = await call(client, 'get_events', {
    cluster: 'demo',
    kind: 'node',
    name: DEMO.nodes.worker3,
  })
  expect(node.text).toContain(`object: Node/${DEMO.nodes.worker3}\n  message:`)
  const none = await call(client, 'get_events', { cluster: 'sandbox', namespace: 'nowhere' })
  expect(none.text).toBe('No events.')

  // Logs, and what a crashing container said before it died.
  const logs = await call(client, 'get_logs', {
    cluster: 'demo',
    namespace: 'shop',
    pod: crashing,
    tailLines: 5,
  })
  expect(logs.error).toBe(false)
  expect(logs.text.trimEnd().split('\n')).toHaveLength(5)
  const previous = await call(client, 'get_logs', {
    cluster: 'demo',
    namespace: 'shop',
    pod: crashing,
    container: 'app',
    previous: true,
    sinceSeconds: 3_600,
  })
  expect(previous.error).toBe(false)
  const silent = await call(client, 'get_logs', {
    cluster: 'demo',
    namespace: 'shop',
    pod: crashing,
    previous: true,
    sinceSeconds: 1,
  })
  expect(silent.text).toBe('(No log lines.)')

  // What's wrong, in a namespace or the whole cluster.
  const shop = await call(client, 'find_problems', { cluster: 'demo', namespace: 'shop' })
  expect(shop.text).toMatch(/^problems:\n/)
  expect(shop.text).toContain('CrashLoopBackOff (critical)')
  expect(shop.text).toContain('ImagePullBackOff (critical)')
  expect(shop.text).toContain('warningsInTheLastHour:')
  expect(shop.text).not.toContain('Node/')
  const everywhere = await call(client, 'find_problems', { cluster: 'demo' })
  expect(everywhere.text).toContain(`object: Node/${DEMO.nodes.worker3}`)
  const quiet = await call(client, 'find_problems', { cluster: 'sandbox', namespace: 'nowhere' })
  expect(quiet.text).toBe(
    'Nothing is wrong in nowhere in sandbox: no unhealthy objects, and no warnings in the last hour.',
  )
  const offline = await call(client, 'find_problems', { cluster: CONTEXTS.offline })
  expect(offline.text).toMatch(/^couldNotCheck:\n\s+- "?Node: /)

  // Mistakes, explained for the assistant to correct.
  const unknown = await call(client, 'list_kinds', { cluster: 'prod' })
  expect(unknown).toEqual({
    error: true,
    text: expect.stringMatching(/^There is no cluster called “prod”\. These are: demo, sandbox, /),
  })
  expect(await call(client, 'list_resources', { cluster: 'demo', kind: 'gizmos' })).toEqual({
    error: true,
    text: 'demo has no kind “gizmos”. list_kinds lists the ones it has.',
  })
  expect(await call(client, 'get_resource', { cluster: 'demo', kind: 'pod', name: 'x' })).toEqual({
    error: true,
    text: 'Pods are namespaced: say which namespace.',
  })
  const missing = await call(client, 'get_resource', {
    cluster: 'demo',
    kind: 'pod',
    name: 'gone',
    namespace: 'shop',
  })
  expect(missing.error).toBe(true)
  expect(missing.text).toContain('not found')
  await client.close()
})

test('A change waits in Lumovi for approval, and is made once approved', async ({
  lumovi,
  clusters,
}) => {
  const { page, app } = lumovi
  await openCluster(page)
  const client = await connect(await turnOn(page))
  const scaling = call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.storefront,
    replicas: 5,
    reason: 'Checkout latency is up 40% since 9:00, and storefront pods are at 95% CPU.',
  })
  const dialog = approval(page, 'Scale Deployment storefront to 5 replicas')
  await expect(dialog).toContainText('Claude Code asks')
  await expect(dialog).toContainText('Deployment · shop · demo')
  await expect(dialog).toContainText(
    'WhyCheckout latency is up 40% since 9:00, and storefront pods are at 95% CPU.',
  )
  const changes = dialog.getByRole('region', { name: 'Changes' })
  await expect(changes).toContainText('The cluster accepts it+1 −1 lines')
  await expect(changes.locator('[data-change="removed"]')).toHaveText(['−  replicas: 3'])
  await expect(changes.locator('[data-change="added"]')).toHaveText(['+  replicas: 5'])
  await expect(dialog).toContainText(
    'kubectl scale deployment/storefront --replicas=5 -n shop --context demo',
  )
  await expect(dialog).toContainText(/Waits [45]:\d\d more/)
  await dialog.getByRole('button', { name: 'Copy command' }).click()
  await expect
    .poll(() => clipboardText(page))
    .toBe('kubectl scale deployment/storefront --replicas=5 -n shop --context demo')

  // The window wasn't in front: a notification says what's asked, and brings it.
  const notices = () =>
    app.evaluate(() =>
      (
        globalThis as unknown as { __notifications: { title: string; body: string }[] }
      ).__notifications.map((n) => `${n.title}: ${n.body}`),
    )
  expect(await notices()).toEqual([
    'Claude Code asks to change demo: Scale Deployment storefront to 5 replicas. Review it in Lumovi.',
  ])
  await app.evaluate(() =>
    (
      globalThis as unknown as { __notifications: { emit(e: string): void }[] }
    ).__notifications[0]!.emit('click'),
  )

  // Once the window's in front, notifications have done their job.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.emit('focus'))

  // ⌘↩ approves.
  await page.keyboard.press('ControlOrMeta+Enter')
  expect(await scaling).toEqual({
    error: false,
    text: 'Scaled storefront to 5 replicas, approved in Lumovi. The kubectl command that does the same: kubectl scale deployment/storefront --replicas=5 -n shop --context demo',
  })
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Scaled storefront' })).toHaveText(
    /Scaled storefront to 5 replicasAs Claude Code asked, in demo\./,
  )
  const replicas = clusters.demo.requests.filter(
    (r) => r.method === 'PATCH' && r.path.endsWith('/deployments/storefront') && !r.search,
  )
  expect(replicas).toHaveLength(1)
  await page.getByRole('button', { name: 'Activity' }).click()
  const log = page.getByRole('dialog', { name: 'Activity' })
  await expect(log.getByRole('listitem').first()).toContainText(
    /Scaled storefront to 5 replicas.*via Claude Code/,
  )
  await page.keyboard.press('Escape')

  // Nothing to approve where nothing would change.
  expect(
    await call(client, 'scale', {
      cluster: 'demo',
      kind: 'Deployment',
      namespace: 'shop',
      name: DEMO.deployments.storefront,
      replicas: 5,
      reason: 'Again.',
    }),
  ).toEqual({ error: false, text: 'storefront already runs 5 replicas: nothing to change.' })

  // With the window in front, nothing else draws attention to it; a change that fails once
  // approved says why.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.isFocused = () => true
  })
  const restarting = call(client, 'restart', {
    cluster: 'demo',
    kind: 'deployment',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason: 'It holds stale connections to the old database.',
  })
  const restart = approval(page, 'Restart Deployment cart')
  await expect(restart).toBeVisible()
  await expect(restart.getByRole('region', { name: 'Changes' })).toContainText(
    'kubectl.kubernetes.io/restartedAt',
  )
  const fault = clusters.demo.fail('/apis/apps/v1/namespaces/shop/deployments/cart', {
    status: 500,
    body: 'etcd is unavailable',
  })
  await restart.getByRole('button', { name: /^Approve/ }).click()
  const failed = await restarting
  expect(failed.error).toBe(true)
  expect(failed.text).toMatch(/^Restart Deployment cart failed: /)
  await expect(
    page.getByRole('alert').filter({ hasText: 'Restart Deployment cart failed' }),
  ).toBeVisible()
  fault()
  expect(await notices()).toHaveLength(1)
  await client.close()
})

test('Rejected changes tell the assistant why; others wait their turn', async ({ page }) => {
  await openCluster(page)
  const client = await connect(await turnOn(page))
  const restarting = call(client, 'restart', {
    cluster: 'demo',
    kind: 'StatefulSet',
    namespace: 'data',
    name: 'postgres',
    reason: 'Its memory has grown for days.',
  })
  const restart = approval(page, 'Restart StatefulSet postgres')
  await expect(restart).toBeVisible()
  const pod = DEMO.pods.checkout[0]!
  const deleting = call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'pod',
    namespace: 'shop',
    name: pod,
    reason: 'It crash-loops; its ReplicaSet makes a new one.',
  })
  // The first stays; the second waits behind it.
  await expect(restart).toContainText('1 of 2')
  await restart.getByRole('button', { name: 'Next change' }).click()
  const deletion = approval(page, `Delete Pod ${pod}`)
  await expect(deletion).toContainText('2 of 2')
  await expect(deletion).toContainText('Deletes it, and what it owns')
  await expect(deletion.getByRole('button', { name: 'Next change' })).toBeDisabled()
  await deletion.getByRole('button', { name: 'Previous change' }).click()
  await expect(restart).toBeVisible()

  // Put aside, they wait at the bottom of the window.
  await page.keyboard.press('Escape')
  await expect(restart).toBeHidden()
  const waiting = page.getByRole('button', { name: /wait for you/ })
  await expect(waiting).toHaveText('2 changes from Claude Code wait for youReview')
  await waiting.click()

  // The second, rejected without a word: the one before it takes its place.
  await restart.getByRole('button', { name: 'Next change' }).click()
  await expect(deletion).toContainText('Approve deletion')
  await deletion.getByRole('button', { name: 'Reject…' }).click()
  await deletion
    .getByRole('button', { name: /^Reject/ })
    .last()
    .click()
  expect(await deleting).toEqual({
    error: true,
    text: 'The person rejected it in Lumovi. Nothing was changed.',
  })
  await expect(restart).toBeVisible()
  await expect(restart).not.toContainText('of 2')

  // Rejected with a note: Escape leaves the note first.
  await restart.getByRole('button', { name: 'Reject…' }).click()
  const note = restart.getByRole('textbox', { name: 'Note' })
  await expect(note).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(note).toBeHidden()
  await expect(restart).toBeVisible()
  await restart.getByRole('button', { name: 'Reject…' }).click()
  await restart.getByRole('button', { name: 'Back' }).click()
  await restart.getByRole('button', { name: 'Reject…' }).click()
  await note.fill('  Not during the sale: tonight, after 22:00.  ')
  await page.keyboard.press('ControlOrMeta+Enter')
  expect(await restarting).toEqual({
    error: true,
    text: 'The person rejected it in Lumovi, saying: “Not during the sale: tonight, after 22:00.”. Nothing was changed.',
  })
  await expect(restart).toBeHidden()
  await expect(waiting).toBeHidden()

  await page.getByRole('button', { name: 'Activity' }).click()
  const entries = page.getByRole('dialog', { name: 'Activity' }).getByRole('listitem')
  await expect(entries).toHaveCount(2)
  await expect(entries.nth(0)).toContainText(
    /^Restart StatefulSet postgres\d+s ago · rejected, asked by Claude Code“Not during the sale: tonight, after 22:00\.”kubectl rollout restart/,
  )
  await expect(entries.nth(0).getByLabel('Rejected')).toBeVisible()
  await expect(entries.nth(1)).toContainText(
    new RegExp(`^Delete Pod ${pod}\\d+s ago · rejected, asked by Claude Codekubectl delete`),
  )
  await client.close()
})

test('Manifests are applied as kubectl apply --server-side does', async ({ page, clusters }) => {
  await openCluster(page)
  const client = await connect(await turnOn(page), 'Visual Studio Code')
  const manifest = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: feature-flags',
    '  namespace: shop',
    'data:',
    '  checkout-v2: "false"',
  ].join('\n')
  const creating = call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest,
    reason: 'A flag to turn the new checkout on without a deploy.',
  })
  const create = approval(page, 'Create ConfigMap feature-flags')
  await expect(create).toContainText('VS Code asks')
  await expect(create).toContainText('Creates it: the cluster accepts it')
  await expect(create).toContainText(
    'kubectl apply --server-side --force-conflicts --field-manager=lumovi -f feature-flags.yaml -n shop --context demo',
  )
  await create.getByText('The manifest VS Code gave').click()
  await expect(create.locator('details pre')).toHaveText(manifest)
  await create.getByRole('button', { name: /^Approve/ }).click()
  expect((await creating).text).toMatch(/^Created configmap feature-flags, approved in Lumovi\./)
  const applied = clusters.demo.requests.filter(
    (r) => r.method === 'PATCH' && r.path === '/api/v1/namespaces/shop/configmaps/feature-flags',
  )
  // Tried without taking fields over (nobody else has any), then as it's made; approved, tried
  // again (it would still do what was shown), and made.
  expect(applied.map((r) => r.search)).toEqual([
    'fieldManager=lumovi&dryRun=All',
    'fieldManager=lumovi&force=true&dryRun=All',
    'fieldManager=lumovi&force=true&dryRun=All',
    'fieldManager=lumovi&force=true',
  ])

  // Applied again, it changes only what the manifest sets.
  const changing = call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest: `${manifest}\n  search-v2: "true"`,
    reason: 'A flag for the new search too.',
  })
  const change = approval(page, 'Change ConfigMap feature-flags')
  await expect(change).toContainText('The cluster accepts it+1 −0 line')
  await change.getByRole('button', { name: /^Approve/ }).click()
  expect((await changing).text).toMatch(/^Changed configmap feature-flags, approved in Lumovi\./)

  // One object a call, and one Lumovi can tell what it is.
  const reason = 'Testing.'
  expect(
    await call(client, 'apply_manifest', {
      cluster: 'demo',
      manifest: `${manifest}\n---\n${manifest}`,
      reason,
    }),
  ).toEqual({ error: true, text: 'Apply one object at a time: this has 2.' })
  expect(
    await call(client, 'apply_manifest', { cluster: 'demo', manifest: 'kind: [ConfigMap', reason }),
  ).toEqual({
    error: true,
    text: expect.stringMatching(/^The manifest isn’t valid YAML: /),
  })
  expect(
    await call(client, 'apply_manifest', {
      cluster: 'demo',
      manifest: 'apiVersion: v1\nkind: ConfigMap\nmetadata: {}',
      reason,
    }),
  ).toEqual({ error: true, text: 'A manifest needs apiVersion, kind and metadata.name.' })
  const invalid = await call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest: manifest.replace('namespace: shop', 'namespace: nowhere'),
    reason,
  })
  expect(invalid.error).toBe(true)
  expect(invalid.text).toMatch(/^Create ConfigMap feature-flags wouldn’t work: /)
  const forbidden = clusters.demo.fail('/api/v1/namespaces/shop/configmaps/locked', { status: 403 })
  const unreadable = await call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest: manifest.replace('feature-flags', 'locked'),
    reason,
  })
  expect(unreadable.error).toBe(true)
  forbidden()
  await client.close()
})

test('Each cluster says whether assistants’ changes are asked about, made, or refused', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.app.setReadOnly('large', true))
  const client = await connect(await turnOn(page), 'claude-ai')
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  const dialog = settingsDialog(page)
  const demo = dialog.getByRole('radiogroup', { name: 'Changes to demo' })
  await expect(demo.getByRole('radio', { name: 'Ask' })).toBeChecked()
  await demo.getByRole('radio', { name: 'Allow' }).click()
  await expect(demo.getByRole('radio', { name: 'Allow' })).toBeChecked()
  await dialog
    .getByRole('radiogroup', { name: 'Changes to sandbox' })
    .getByRole('radio', { name: 'Never' })
    .click()
  await expect(dialog.getByRole('listitem').filter({ hasText: 'large' })).toContainText(
    'Read-only: no changes',
  )
  await page.keyboard.press('Escape')
  expect(
    await call(client, 'list_clusters').then(({ text }) => text.match(/changes: \S+/g)),
  ).toEqual(expect.arrayContaining(['changes: allow', 'changes: never', 'changes: read-only']))

  // Allowed: made at once, and the person's told.
  const restarted = await call(client, 'restart', {
    cluster: 'demo',
    kind: 'daemonset',
    namespace: 'monitoring',
    name: 'node-exporter',
    reason: 'It lost its host mounts.',
  })
  expect(restarted.text).toBe(
    'Restarted node-exporter. The kubectl command that does the same: kubectl rollout restart daemonset/node-exporter -n monitoring --context demo',
  )
  await expect(
    page.getByRole('status').filter({ hasText: 'Restarted node-exporter' }),
  ).toContainText('Claude changed demo without asking: assistants may, there.')
  expect(
    clusters.demo.requests.filter(
      (r) => r.path.endsWith('/daemonsets/node-exporter') && r.method === 'PATCH',
    ),
  ).toHaveLength(2)

  // Allowed, and failing as it's made: the person's told that too.
  const failing = clusters.demo.fail(/\/configmaps\/flags\?fieldManager=lumovi&force=true$/, {
    status: 500,
  })
  const flags = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: flags\n  namespace: shop'
  const unmade = await call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest: flags,
    reason: 'A place for flags.',
  })
  expect(unmade.error).toBe(true)
  expect(unmade.text).toMatch(/^Create ConfigMap flags failed: /)
  await expect(
    page.getByRole('alert').filter({ hasText: 'Create ConfigMap flags failed' }),
  ).toBeVisible()
  failing()

  // Never: refused, before anything's tried.
  const config = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n  namespace: default'
  expect(
    await call(client, 'apply_manifest', { cluster: 'sandbox', manifest: config, reason: 'Test.' }),
  ).toEqual({
    error: true,
    text: 'Lumovi doesn’t let AI assistants change sandbox: its AI assistants settings say “Never”. Nothing was changed.',
  })
  // Read-only: Lumovi changes nothing there.
  const readOnly = await call(client, 'apply_manifest', {
    cluster: 'large',
    manifest: config,
    reason: 'Test.',
  })
  expect(readOnly.error).toBe(true)
  expect(readOnly.text).toMatch(/^Create ConfigMap x wouldn’t work: .*read-only/)

  // Kinds that don't scale or restart say so.
  expect(
    await call(client, 'scale', {
      cluster: 'demo',
      kind: 'cm',
      namespace: 'shop',
      name: 'x',
      replicas: 1,
      reason: 'Test.',
    }),
  ).toEqual({ error: true, text: 'ConfigMaps can’t be scaled.' })
  expect(
    await call(client, 'restart', {
      cluster: 'demo',
      kind: 'job',
      namespace: 'batch',
      name: 'x',
      reason: 'Test.',
    }),
  ).toEqual({
    error: true,
    text: 'Only Deployments, StatefulSets and DaemonSets restart; Jobs don’t.',
  })
  // A custom workload scales through its scale subresource.
  const rollout = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'rollout',
    namespace: 'shop',
    name: 'checkout-canary',
    replicas: 7,
    reason: 'More canaries.',
  })
  expect(rollout.text).toMatch(/^Scaled checkout-canary to 7 replicas\. /)

  // Back to asking.
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  await demo.getByRole('radio', { name: 'Ask' }).click()
  await expect(demo.getByRole('radio', { name: 'Ask' })).toBeChecked()
  expect((await page.evaluate(() => window.lumovi!.app.settings())).aiChanges).toEqual({
    sandbox: 'never',
  })
  await client.close()
})

test('Changes an assistant gives up on, or nobody answers in time, end', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_APPROVAL_TIMEOUT_MS: '8000' } })
  await openCluster(page)
  const client = await connect(await turnOn(page), 'codex-mcp-client')
  const scale = { cluster: 'demo', kind: 'deploy', namespace: 'shop', reason: 'Busy.' }

  // One waits, put aside.
  const expiring = call(client, 'scale', { ...scale, name: DEMO.deployments.cart, replicas: 1 })
  const cart = approval(page, 'Scale Deployment cart to 1 replica')
  await expect(cart).toContainText('Codex asks')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /waits for you/ })).toHaveText(
    '1 change from Codex waits for youReview',
  )

  // Another comes, and shows; then the assistant gives up on it.
  const abort = new AbortController()
  const withdrawn = call(
    client,
    'scale',
    { ...scale, name: DEMO.deployments.storefront, replicas: 6 },
    { signal: abort.signal },
  )
  const storefront = approval(page, 'Scale Deployment storefront to 6 replicas')
  await expect(storefront).toContainText('2 of 2')
  await storefront.getByRole('button', { name: 'Previous change' }).click()
  await expect(cart).toContainText('1 of 2')
  abort.abort()
  await expect(withdrawn).rejects.toThrow()
  await expect(cart).toBeVisible()
  await expect(cart).not.toContainText('of 2')
  // Told behind the dialog that's open.
  await expect(
    page.getByRole('status', { includeHidden: true }).filter({ hasText: 'withdrew' }),
  ).toHaveText(
    /Codex withdrew a changeScale Deployment storefront to 6 replicas\. Nothing was changed\./,
  )

  // Unanswered, the first expires: its last minute shows.
  await expect(cart.getByText(/Waits 0:0\d more/)).toHaveClass(/text-warn-text/)
  expect(await expiring).toEqual({
    error: true,
    text: 'Nobody approved it in Lumovi within 8 seconds: nothing was changed. Ask the person to look at Lumovi, and try again.',
  })
  await expect(cart).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Not approved in time' })).toContainText(
    'Codex asked to scale Deployment cart to 1 replica. Nothing was changed.',
  )
  await client.close()
})

test('A reloaded window shows the changes still waiting', async ({ page }) => {
  await openCluster(page)
  const client = await connect(await turnOn(page))
  const scaling = call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  const dialog = approval(page, 'Scale Deployment cart to 3 replicas')
  await expect(dialog).toBeVisible()
  await page.reload()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Later' }).click()
  await page.getByRole('button', { name: /waits for you/ }).click()
  await dialog.getByRole('button', { name: /^Approve/ }).click()
  expect((await scaling).error).toBe(false)
  await client.close()
})

/** An HTTP request as a browser or another program might make it. */
function raw(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'POST', headers: options.headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

test('Only assistants on this computer, with Lumovi’s token, get in', async ({ launch }) => {
  const { page } = await launch({ env: { LUMOVI_ASSISTANTS_IDLE_MS: '1500' } })
  const status = await turnOn(page)
  const url = status.url!
  const auth = { Authorization: `Bearer ${status.token}` }
  const json = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'curl', version: '1' },
    },
  })
  const error = (body: string) => JSON.parse(body).error.message as string

  const anonymous = await raw(url, { headers: json, body: initialize })
  expect(anonymous.status).toBe(401)
  expect(anonymous.headers['www-authenticate']).toBe('Bearer')
  expect(error(anonymous.body)).toBe(
    'Lumovi needs its token: set this assistant up again from Lumovi.',
  )
  const wrong = await raw(url, {
    headers: { ...json, Authorization: `Bearer ${'x'.repeat(43)}` },
    body: initialize,
  })
  expect(wrong.status).toBe(401)

  // Web pages can't reach it, nor names rebound to this computer.
  const page_ = await raw(url, {
    headers: { ...json, ...auth, Origin: 'https://evil.example' },
    body: initialize,
  })
  expect([page_.status, error(page_.body)]).toEqual([403, 'Web pages may not connect to Lumovi.'])
  const rebound = await raw(url, {
    headers: { ...json, ...auth, Host: `evil.example:${status.port}` },
    body: initialize,
  })
  expect([rebound.status, error(rebound.body)]).toEqual([403, 'Only this computer may connect.'])
  const localhost = await raw(url, {
    headers: { ...json, ...auth, Host: `localhost:${status.port}` },
    body: initialize,
  })
  expect(localhost.status).toBe(200)

  const elsewhere = await raw(url.replace('/mcp', '/'), { headers: auth })
  expect(elsewhere.status).toBe(404)
  const notJson = await raw(url, { headers: { ...json, ...auth }, body: '{ nope' })
  expect([notJson.status, JSON.parse(notJson.body).error.code]).toEqual([400, -32700])
  const tooLarge = raw(url, {
    headers: { ...json, ...auth },
    body: Buffer.alloc(5 * 1024 * 1024, 32),
  })
  expect(await tooLarge).toEqual(
    expect.objectContaining({ status: 413, body: expect.stringContaining('4 MB at most') }),
  )
  const first = await raw(url, { method: 'GET', headers: { ...auth, Accept: 'text/event-stream' } })
  expect([first.status, error(first.body)]).toEqual([400, 'Start a session first (initialize).'])
  const ended = await raw(url, {
    headers: { ...json, ...auth, 'Mcp-Session-Id': 'gone' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  expect([ended.status, error(ended.body)]).toEqual([
    404,
    'That session has ended: start a new one.',
  ])

  // Assistants that go quiet are let go.
  const client = await connect(status, 'windsurf-client')
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.assistants!.status().then((s) => s.clients)))
    .toContainEqual(expect.objectContaining({ name: 'Windsurf' }))
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.assistants!.status().then((s) => s.clients)), {
      timeout: 10_000,
    })
    .toEqual([])
  await client.close()
})

test('Lumovi sets Claude Desktop, Cursor and VS Code up', async ({ launch }) => {
  const home = mkdtempSync(join(tmpdir(), 'lumovi-claude-'))
  const config = join(home, 'Claude', 'claude_desktop_config.json')
  const lumovi = await launch({ env: { LUMOVI_CLAUDE_DESKTOP_CONFIG: config } })
  const { page } = lumovi
  const opened = await mockOpenExternal(lumovi.app)
  const status = await turnOn(page)
  await page.getByRole('button', { name: /^AI assistants/ }).click()
  const dialog = settingsDialog(page)

  await dialog.getByRole('tab', { name: 'Claude Desktop' }).click()
  const add = dialog.getByRole('button', { name: 'Add to Claude Desktop' })
  await add.click()
  await expect(dialog.getByRole('alert')).toHaveText(
    'Claude Desktop isn’t installed on this computer.',
  )
  mkdirSync(join(home, 'Claude'))
  writeFileSync(config, '{ "mcpServers": ')
  await add.click()
  await expect(dialog.getByRole('alert')).toHaveText(
    `Claude Desktop’s settings (${config}) aren’t valid JSON, so Lumovi left them alone.`,
  )
  writeFileSync(
    config,
    JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, theme: 'dark' }),
  )
  await add.click()
  await expect(dialog.getByRole('status')).toHaveText(
    'Added to Claude Desktop: quit and open it again to use Lumovi there.',
  )
  const written = JSON.parse(readFileSync(config, 'utf8'))
  expect(written).toEqual({
    mcpServers: {
      github: { command: 'gh-mcp' },
      // Its settings folder: the app's (as the system names it: /private/var for /var, say). On
      // Windows, the bridge runs as Node.
      lumovi:
        process.platform === 'win32'
          ? {
              command: expect.any(String),
              args: [
                expect.stringMatching(/[\\/]out[\\/]mcp-stdio[\\/]bridge\.cjs$/),
                expect.stringMatching(new RegExp(`${basename(lumovi.userDataDir)}$`)),
              ],
              env: { ELECTRON_RUN_AS_NODE: '1' },
            }
          : {
              command: expect.any(String),
              args: expect.arrayContaining([
                expect.stringMatching(
                  new RegExp(`^--mcp-stdio=.+${basename(lumovi.userDataDir)}$`),
                ),
              ]),
            },
    },
    theme: 'dark',
  })

  await dialog.getByRole('tab', { name: 'Cursor' }).click()
  await dialog.getByRole('button', { name: 'Add to Cursor' }).click()
  await expect(dialog.getByRole('status')).toHaveText('Cursor asks you to add Lumovi.')
  await dialog.getByRole('tab', { name: 'VS Code' }).click()
  await dialog.getByRole('button', { name: 'Add to VS Code' }).click()
  await expect(dialog.getByRole('status')).toHaveText('VS Code asks you to add Lumovi.')
  const [cursor, vscode] = await opened()
  const headers = { Authorization: `Bearer ${status.token}` }
  const cursorUrl = new URL(cursor!)
  expect(`${cursorUrl.protocol}//${cursorUrl.host}${cursorUrl.pathname}`).toBe(
    'cursor://anysphere.cursor-deeplink/mcp/install',
  )
  expect(cursorUrl.searchParams.get('name')).toBe('lumovi')
  expect(
    JSON.parse(Buffer.from(cursorUrl.searchParams.get('config')!, 'base64').toString()),
  ).toEqual({
    url: status.url,
    headers,
  })
  expect(vscode!.startsWith('vscode:mcp/install?')).toBe(true)
  expect(JSON.parse(decodeURIComponent(vscode!.slice('vscode:mcp/install?'.length)))).toEqual({
    name: 'lumovi',
    type: 'http',
    url: status.url,
    headers,
  })
})

/** How Claude Desktop starts Lumovi, as Lumovi set it up; the stdio bridge for another settings folder. */
async function bridgeCommand(page: Page, config: string, settings?: string) {
  await page.evaluate(() => window.lumovi!.assistants!.install('claude-desktop'))
  const {
    command,
    args,
    env = {},
  } = JSON.parse(readFileSync(config, 'utf8')).mcpServers.lumovi as {
    command: string
    args: string[]
    env?: Record<string, string>
  }
  // The settings folder is the bridge's last argument, as Node; or its --mcp-stdio.
  const elsewhere = (arg: string, i: number) =>
    env.ELECTRON_RUN_AS_NODE
      ? i === args.length - 1
        ? settings!
        : arg
      : arg.startsWith('--mcp-stdio=')
        ? `--mcp-stdio=${settings}`
        : arg
  return { command, env, args: settings ? args.map(elsewhere) : args }
}

/** The bridge's environment: the test's, with coverage. */
const bridgeEnv = (extra: Record<string, string> = {}) => ({
  ...(process.env as Record<string, string>),
  LUMOVI_COVERAGE_DIR: COVERAGE_DIR,
  ...extra,
})

/** Lines to the bridge, and the lines it answers with, until it ends. */
function talk(
  bridge: { command: string; args: string[]; env: Record<string, string> },
  lines: string[],
  env: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const child = spawn(bridge.command, bridge.args, { env: bridgeEnv({ ...bridge.env, ...env }) })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk))
  child.stdin.end(lines.map((line) => `${line}\n`).join(''))
  return new Promise((resolve) =>
    child.on('close', () =>
      resolve(
        out
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      ),
    ),
  )
}

test('Claude Desktop talks to Lumovi through a bridge, which starts Lumovi when it’s closed', async ({
  launch,
}) => {
  test.slow()
  const home = mkdtempSync(join(tmpdir(), 'lumovi-claude-'))
  mkdirSync(join(home, 'Claude'))
  const config = join(home, 'Claude', 'claude_desktop_config.json')
  const { page } = await launch({ env: { LUMOVI_CLAUDE_DESKTOP_CONFIG: config } })
  await openCluster(page)
  const status = await turnOn(page)
  const bridge = await bridgeCommand(page, config)

  // As Claude Desktop does: Lumovi, started with stdin and stdout to talk over.
  const client = new Client({ name: 'claude-ai', version: '0.14.0' })
  await client.connect(
    new StdioClientTransport({ ...bridge, env: bridgeEnv(bridge.env), stderr: 'ignore' }),
  )
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.assistants!.status().then((s) => s.clients)))
    .toEqual([expect.objectContaining({ name: 'Claude' })])
  expect((await call(client, 'list_clusters')).text).toMatch(/^current: demo/)

  // Changes wait for approval, as everyone's do.
  const scaling = call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  const dialog = approval(page, 'Scale Deployment cart to 3 replicas')
  await expect(dialog).toContainText('Claude asks')
  await dialog.getByRole('button', { name: /^Approve/ }).click()
  expect((await scaling).text).toMatch(/^Scaled cart to 3 replicas, approved in Lumovi\./)

  // Lumovi's server started again (its sessions went with it): the bridge starts a new one.
  await page.evaluate((port) => window.lumovi!.assistants!.configure({ port }), status.port)
  expect((await call(client, 'list_kinds', { cluster: 'demo' })).error).toBe(false)
  await client.close()
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.assistants!.status().then((s) => s.clients)))
    .toEqual([])

  // Lumovi not running: the bridge starts it as it was last started (here, a stand-in that
  // writes the settings a started Lumovi would), and waits for it to listen.
  const closed = await freePort()
  const settings = mkdtempSync(join(tmpdir(), 'lumovi-settings-'))
  const file = join(settings, 'settings.json')
  const started = {
    assistants: { enabled: true, port: status.port, token: status.token, launch: [] },
  }
  const starts = `require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(started))})`
  writeFileSync(
    file,
    JSON.stringify({
      assistants: {
        enabled: true,
        port: closed,
        token: status.token,
        launch: [process.execPath, '-e', starts],
      },
    }),
  )
  const starting = await bridgeCommand(page, config, settings)
  const away = new Client({ name: 'claude-ai', version: '0.14.0' })
  await away.connect(
    new StdioClientTransport({
      ...starting,
      env: bridgeEnv(starting.env),
      stderr: 'ignore',
    }),
  )
  expect((await call(away, 'list_clusters')).error).toBe(false)
  await away.close()

  // What it says when Lumovi can't be reached.
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-ai', version: '1' },
    },
  })
  const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const answer = async (assistants: object | undefined, env?: Record<string, string>) => {
    const folder = mkdtempSync(join(tmpdir(), 'lumovi-settings-'))
    if (assistants) writeFileSync(join(folder, 'settings.json'), JSON.stringify({ assistants }))
    return talk(
      await bridgeCommand(page, config, folder),
      ['', '{ not json', notification, initialize],
      env,
    )
  }
  const off =
    'AI assistants are turned off in Lumovi: open Lumovi, and turn them on in its AI assistants settings.'
  expect(await answer(undefined)).toEqual([
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'That isn’t a JSON-RPC message.' },
    },
    { jsonrpc: '2.0', id: 1, error: { code: -32000, message: off } },
  ])
  expect((await answer({ enabled: true, port: status.port }))[1]).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: off },
  })
  // Lumovi has never been started, to say how it's started.
  expect((await answer({ enabled: true, port: closed, token: status.token }))[1]).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: 'Lumovi isn’t running: open it, and try again.' },
  })
  expect(
    (await answer({ enabled: true, port: status.port, token: 'x'.repeat(43), launch: [] }))[1],
  ).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32000,
      message: 'Lumovi needs its token: set this assistant up again from Lumovi.',
    },
  })
  expect(
    (
      await answer(
        {
          enabled: true,
          port: closed,
          token: status.token,
          launch: [join(home, 'no-lumovi-here')],
        },
        { LUMOVI_MCP_WAIT_MS: '600' },
      )
    )[1],
  ).toEqual({
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32000,
      message: 'Lumovi didn’t start: open it, and check that AI assistants are on.',
    },
  })
})

test('The window’s requests about assistants are checked', async ({ page }) => {
  await turnOn(page)
  expect(
    await page.evaluate(async () => {
      const a = window.lumovi!.assistants!
      const tries: (() => Promise<unknown>)[] = [
        () => a.configure({ enabled: 'yes' as never }),
        () => a.configure({ port: 80 }),
        () => a.install('claude-code' as never),
        () => a.setChanges('', 'ask'),
        () => a.setChanges('demo', 'sometimes' as never),
        () => a.decide(5 as never, { approved: true }),
        () => a.decide('x', { approved: 'yes' } as never),
        () => a.decide('x', { approved: false, note: 5 } as never),
        () => a.decide('x', { approved: false, note: 'x'.repeat(2_001) }),
        // An answer to a change that's no longer waiting is let go.
        () => a.decide('gone', { approved: true }),
        () =>
          window.lumovi!.kube.change({
            context: 'demo',
            kind: 'ConfigMap',
            namespace: 'shop',
            name: 'one',
            change: {
              action: 'apply',
              object: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'other' } },
              fieldManager: 'lumovi',
              force: true,
            },
          }),
        () =>
          window.lumovi!.kube.change({
            context: 'demo',
            kind: 'ConfigMap',
            namespace: 'shop',
            name: 'one',
            change: { action: 'delete', uid: 5 as never },
          }),
      ]
      // What each says: refused by the app, refused by the cluster's rules, or done.
      const results: string[] = []
      for (const attempt of tries) {
        results.push(
          await attempt().then(
            (result) => {
              const { ok, error } = Object(result) as {
                ok?: boolean
                error?: { code: string; message: string }
              }
              return ok === false ? `${error!.code}: ${error!.message}` : 'ok'
            },
            (error: Error) => error.message.replace(/^.*Error: /, ''),
          ),
        )
      }
      return results
    }),
  ).toEqual([
    'Expected whether assistants may connect, and a port from 1024 to 65535',
    'Expected whether assistants may connect, and a port from 1024 to 65535',
    'Lumovi can’t set claude-code up itself',
    'Expected a context name, and ask, allow or never',
    'Expected a context name, and ask, allow or never',
    'Expected a change’s id, whether it’s approved, and a note',
    'Expected a change’s id, whether it’s approved, and a note',
    'Expected a change’s id, whether it’s approved, and a note',
    'Expected a change’s id, whether it’s approved, and a note',
    'ok',
    'invalid: The object’s name doesn’t match the one being applied',
    'invalid: uid must be a non-empty string',
  ])
})

test('Assistants are told when the kubeconfig can’t be read, and see production as such', async ({
  launch,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-kubeconfig-'))
  const broken = join(dir, 'broken')
  writeFileSync(broken, 'clusters: [')
  const unreadable = await launch({ env: { KUBECONFIG: broken } })
  const client = await connect(await turnOn(unreadable.page))
  const listed = await call(client, 'list_clusters')
  expect(listed.error).toBe(true)
  expect(listed.text).toMatch(/^Lumovi can’t read the kubeconfig: /)
  await client.close()

  const kubeconfig = writeKubeconfig(dir, {
    clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
    users: [{ name: 'u', token: DEMO_TOKEN }],
    contexts: [{ name: 'shop-prod', cluster: 'demo', user: 'u' }],
  })
  const { page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await openCluster(page, 'shop-prod')
  const assistant = await connect(await turnOn(page))
  const scaling = call(assistant, 'scale', {
    cluster: 'shop-prod',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  const dialog = approval(page, 'Scale Deployment cart to 3 replicas')
  await expect(dialog).toContainText('Deployment · shop · shop-prodProduction')
  await dialog.getByRole('button', { name: /^Approve/ }).click()
  expect((await scaling).error).toBe(false)

  // Deleting there, the name's typed.
  const pod = DEMO.pods.checkout[0]!
  const deleting = call(assistant, 'delete_resource', {
    cluster: 'shop-prod',
    kind: 'pod',
    namespace: 'shop',
    name: pod,
    reason: 'It crash-loops.',
  })
  const deletion = approval(page, `Delete Pod ${pod}`)
  await deletion.getByRole('textbox', { name: `Type ${pod} to approve` }).fill(pod)
  await page.keyboard.press('ControlOrMeta+Enter')
  expect((await deleting).text).toMatch(new RegExp(`^Deleted pod ${pod}, approved in Lumovi\\.`))
  await assistant.close()
})

test('A call waits a while for the answer, then keeps waiting with wait_for_change', async ({
  launch,
}) => {
  const { page } = await launch({ env: { LUMOVI_APPROVAL_SLICE_MS: '1000' } })
  await openCluster(page)
  const client = await connect(await turnOn(page))
  const said: string[] = []
  const asked = await call(
    client,
    'scale',
    {
      cluster: 'demo',
      kind: 'deploy',
      namespace: 'shop',
      name: DEMO.deployments.cart,
      replicas: 3,
      reason: 'Busy.',
    },
    { onprogress: ({ message }) => void said.push(message!) },
  )
  expect(asked.error).toBe(false)
  const [, id] = asked.text.match(
    /^Still waiting for the person’s answer in Lumovi: nothing has changed yet\. Tell them to look at Lumovi, and call wait_for_change with id “([\w-]+)” to keep waiting for it\.$/,
  )!
  // Meanwhile, the assistant heard how it's going.
  expect(said[0]).toBe('Waiting for the person to approve it in Lumovi')
  expect((await call(client, 'wait_for_change', { id })).text).toMatch(/^Still waiting/)

  // Answered while nobody waits: the next wait hears how it went.
  const dialog = approval(page, 'Scale Deployment cart to 3 replicas')
  await dialog.getByRole('button', { name: /^Approve/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Scaled cart' })).toBeVisible()
  expect(await call(client, 'wait_for_change', { id })).toEqual({
    error: false,
    text: expect.stringMatching(/^Scaled cart to 3 replicas, approved in Lumovi\./),
  })
  expect(await call(client, 'wait_for_change', { id: 'nope' })).toEqual({
    error: true,
    text: 'No change with id “nope” is waiting: it was answered a while ago, or never asked for.',
  })

  // A wait the assistant gives up on withdraws the change.
  const restart = await call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.storefront,
    reason: 'Stale connections.',
  })
  const [, again] = restart.text.match(/id “([\w-]+)”/)!
  const abort = new AbortController()
  const waiting = call(client, 'wait_for_change', { id: again }, { signal: abort.signal })
  await page.waitForTimeout(300)
  abort.abort()
  await expect(waiting).rejects.toThrow()
  await expect(approval(page, 'Restart Deployment storefront')).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'withdrew' })).toBeVisible()

  // Turned off, assistants may no longer ask: what's still waiting is withdrawn.
  const scale = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.storefront,
    replicas: 6,
    reason: 'Busy.',
  })
  expect(scale.text).toMatch(/^Still waiting/)
  await page.evaluate(() => window.lumovi!.assistants!.configure({ enabled: false }))
  await expect(approval(page, 'Scale Deployment storefront to 6 replicas')).toBeHidden()
  expect(await page.evaluate(() => window.lumovi!.assistants!.pending())).toEqual([])
})

test('An approved change is made as it was shown, or not at all', async ({ page, clusters }) => {
  await openCluster(page)
  const client = await connect(await turnOn(page))
  const kube = (change: object, name: string, kind = 'Deployment') =>
    page.evaluate(
      ({ change, name, kind }) =>
        window.lumovi!.kube.change({
          context: 'demo',
          kind,
          namespace: 'shop',
          name,
          change,
        } as never),
      { change, name, kind },
    )
  const reason = 'Busy.'

  // Scaled by someone else meanwhile: it would do something else now.
  const scaling = call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason,
  })
  const scale = approval(page, 'Scale Deployment cart to 3 replicas')
  await expect(scale).toBeVisible()
  await kube({ action: 'patch', patchType: 'merge', patch: { spec: { replicas: 4 } } }, 'cart')
  await scale.getByRole('button', { name: /^Approve/ }).click()
  expect(await scaling).toEqual({
    error: true,
    text: 'Scale Deployment cart to 3 replicas wasn’t made: cart changed after it was shown (what it would change is different now). Nothing was changed: ask again, to show it as it is now.',
  })
  await expect(
    page.getByRole('alert').filter({ hasText: 'Scale Deployment cart to 3 replicas failed' }),
  ).toContainText('what it would change is different now')

  // Its status changing doesn't matter: what the change does is the same.
  const restarting = call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason,
  })
  const restart = approval(page, 'Restart Deployment cart')
  await expect(restart).toBeVisible()
  const cart = clusters.demo.object('Deployment', 'shop', 'cart')!
  clusters.demo.upsert({ ...cart, status: { ...cart.status, observedGeneration: 99 } })
  await restart.getByRole('button', { name: /^Approve/ }).click()
  expect((await restarting).text).toMatch(/^Restarted cart, approved in Lumovi\./)

  // Gone meanwhile.
  const again = call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason,
  })
  await expect(restart).toBeVisible()
  await kube({ action: 'delete' }, 'cart')
  await restart.getByRole('button', { name: /^Approve/ }).click()
  expect((await again).text).toMatch(/^Restart Deployment cart failed: .*not found/)

  // Deleted, and made again under its name: not the one shown.
  const deleting = call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'configmap',
    namespace: 'shop',
    name: 'storefront-config',
    reason,
  })
  const deletion = approval(page, 'Delete ConfigMap storefront-config')
  await expect(deletion).toBeVisible()
  const config = clusters.demo.object('ConfigMap', 'shop', 'storefront-config')!
  clusters.demo.upsert({ ...config, metadata: { ...config.metadata, uid: 'made-again' } })
  await deletion.getByRole('button', { name: /^Approve/ }).click()
  expect((await deleting).text).toMatch(
    /^Delete ConfigMap storefront-config wasn’t made: storefront-config changed after it was shown \(Precondition failed: UID in precondition: /,
  )
  expect(clusters.demo.object('ConfigMap', 'shop', 'storefront-config')).toBeDefined()
  await client.close()
})

test('Deletions, and fields taken over from others, ask even where assistants may change', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  await page.evaluate(() => window.lumovi!.assistants!.setChanges('demo', 'allow'))
  const client = await connect(await turnOn(page))

  // A namespace: its name is typed to approve, as Lumovi's own Delete asks.
  const deleting = call(client, 'delete_resource', {
    cluster: 'demo',
    kind: 'namespace',
    name: 'legacy',
    reason: 'Nothing runs there.',
  })
  const deletion = approval(page, 'Delete Namespace legacy')
  const approve = deletion.getByRole('button', { name: 'Approve deletion' })
  await expect(approve).toBeDisabled()
  const name = deletion.getByRole('textbox', { name: 'Type legacy to approve' })
  await name.fill('leg')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(deletion).toBeVisible()
  await name.fill('legacy')
  await expect(approve).toBeEnabled()
  await deletion.getByRole('button', { name: 'Reject…' }).click()
  await expect(name).toBeHidden()
  await deletion
    .getByRole('button', { name: /^Reject/ })
    .last()
    .click()
  expect((await deleting).text).toBe('The person rejected it in Lumovi. Nothing was changed.')

  // Fields Helm owns: whose, and which, are said.
  const conflict = clusters.demo.fail(
    /\/configmaps\/storefront-config\?fieldManager=lumovi&dryRun=All$/,
    {
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'Status',
        apiVersion: 'v1',
        status: 'Failure',
        reason: 'Conflict',
        code: 409,
        message: 'Apply failed with 1 conflict: conflict with "helm" using v1: .data.LOG_LEVEL',
      }),
    },
  )
  const applying = call(client, 'apply_manifest', {
    cluster: 'demo',
    manifest:
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: storefront-config\n  namespace: shop\ndata:\n  LOG_LEVEL: debug',
    reason: 'More detail in the logs while we look.',
  })
  const apply = approval(page, 'Change ConfigMap storefront-config')
  await expect(apply.getByRole('note')).toHaveText(
    'It takes fields over from what manages them (Helm, Argo CD, an autoscaler…), which may change them back: Apply failed with 1 conflict: conflict with "helm" using v1: .data.LOG_LEVEL',
  )
  await apply.getByRole('button', { name: /^Approve/ }).click()
  expect((await applying).text).toMatch(
    /^Changed configmap storefront-config, approved in Lumovi\./,
  )
  conflict()
  await client.close()
})

test('An unanswered change expires, and is forgotten a while after', async ({ launch }) => {
  const { page } = await launch({
    env: { LUMOVI_APPROVAL_TIMEOUT_MS: '1500', LUMOVI_APPROVAL_SLICE_MS: '1000' },
  })
  await openCluster(page)
  const client = await connect(await turnOn(page))
  const asked = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  const [, id] = asked.text.match(/id “([\w-]+)”/)!
  expect(await call(client, 'wait_for_change', { id })).toEqual({
    error: true,
    text: 'Nobody approved it in Lumovi within 2 seconds: nothing was changed. Ask the person to look at Lumovi, and try again.',
  })
  await expect(approval(page, 'Scale Deployment cart to 3 replicas')).toBeHidden()
  await expect
    .poll(() => call(client, 'wait_for_change', { id }).then(({ text }) => text))
    .toBe(`No change with id “${id}” is waiting: it was answered a while ago, or never asked for.`)
  await client.close()
})
