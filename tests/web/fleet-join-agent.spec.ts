/**
 * A private cluster connected from the Fleet page: its agent joins with its one-time join token,
 * which the hub exchanges for a token of the agent's own, kept in its Secret in its cluster.
 */
import { X509Certificate } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import type { KubeObject } from '../mock-cluster/types.ts'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'
import { audited, expect, freePort, inCluster, startAgent, test } from './fixtures.ts'
import { as, fleetEnv } from './fleet.ts'

const EDGE = 'edge-ap-south'
const SECRET = 'lumovi-agent'

/** What a fleet call from the page gives, or its error's message. */
const call = (
  page: Page,
  method: 'connect' | 'joins' | 'remove',
  ...args: unknown[]
): Promise<{ value?: unknown; error?: string }> =>
  page.evaluate(
    ([method, args]) =>
      (window.lumovi!.fleet![method] as (...args: unknown[]) => Promise<unknown>)(...args).then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      ),
    [method, args] as const,
  )

/** A join made on the page: its token. */
async function connect(page: Page, name = EDGE): Promise<string> {
  const made = await call(page, 'connect', { name, labels: { region: 'ap-south' }, groups: [] })
  return (made.value as { token: string }).token
}

/** The agent's Secret, as its chart makes it: its join token, until it keeps its own token. */
function agentSecret(clusters: TestClusters, data: Record<string, string>, name = SECRET) {
  clusters.demo.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace: 'lumovi' },
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]),
    ),
  } as KubeObject)
}

const kept = (clusters: TestClusters, name = SECRET) =>
  Object.fromEntries(
    Object.entries(
      (clusters.demo.object('Secret', 'lumovi', name) as { data?: Record<string, string> }).data ??
        {},
    ).map(([key, value]) => [key, Buffer.from(value, 'base64').toString()]),
  )

/** The clusters the page's person sees, by name. */
const names = (page: Page) =>
  page.evaluate(() =>
    window.lumovi!.kube.contexts().then(({ contexts }) => contexts.map((c) => c.name)),
  )

/** A hub with admins, keeping what it must (agents ping every 5 s). */
const hubEnv = (clusters: TestClusters) => ({
  ...fleetEnv(clusters),
  LUMOVI_ADMINS: 'user:admin@example.com',
  LUMOVI_DATA_DIR: mkdtempSync(join(tmpdir(), 'lumovi-joins-')),
  LUMOVI_HEARTBEAT_SECONDS: '5',
})

/** An agent of the demo cluster, joining `hub`'s fleet as `name`. */
const agentOf = (hub: string, clusters: TestClusters, env: Record<string, string>) =>
  startAgent({
    LUMOVI_HUB_URL: hub,
    LUMOVI_AGENT_NAME: EDGE,
    LUMOVI_AGENT_TOKEN_SECRET: SECRET,
    ...inCluster(clusters).env,
    ...env,
  })

test('a private cluster joins with one command, and its agent keeps a token of its own', async ({
  page,
  context,
  browser,
  serve,
  clusters,
}) => {
  const port = await freePort()
  const env = hubEnv(clusters)
  const hub = await serve({ port, env })
  const origin = hub.url.replace(/\/$/, '')
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  const token = await connect(page)
  agentSecret(clusters, { 'join-token': token })
  const agent = agentOf(hub.url, clusters, { LUMOVI_AGENT_JOIN_TOKEN: token })
  await expect
    .poll(() => agent.log())
    .toContain(`Joined ${origin} as ${EDGE}: its token is kept in the Secret ${SECRET}`)

  // Its Secret holds its own token now, and not the join token.
  await expect.poll(() => Object.keys(kept(clusters))).toEqual(['token'])
  const credential = kept(clusters).token!
  expect(credential).toMatch(/^lumovi_agent_[A-Za-z0-9_-]{43}$/)
  // Whoever first used its token is trusted: until an admin checks its certificate authority,
  // nobody else sees it.
  const others = await browser.newContext()
  await as(others, 'alice@example.com')
  const alice = await others.newPage()
  await alice.goto(hub.url)
  await expect
    .poll(() => page.evaluate(() => window.lumovi!.fleet!.agents()))
    .toEqual([expect.objectContaining({ name: EDGE, connected: true, unconfirmed: true })])
  expect(await names(alice)).not.toContain(EDGE)
  await page.evaluate(([name, sha256]) => window.lumovi!.fleet!.trustAgent(name, sha256), [
    EDGE,
    new X509Certificate(clusters.demo.caPem!).fingerprint256,
  ] as const)
  await alice.reload()
  expect(await names(alice)).toContain(EDGE)
  await others.close()
  // It's in the fleet, with the labels it was connected with, reached through its agent.
  await expect.poll(() => names(page)).toContain(EDGE)
  await expect
    .poll(() => page.evaluate((name) => window.lumovi!.kube.version(name).then((r) => r.ok), EDGE))
    .toBe(true)
  const { contexts } = await page.evaluate(() => window.lumovi!.kube.contexts())
  expect(contexts.find((c) => c.name === EDGE)?.labels).toEqual({ region: 'ap-south' })
  expect(await call(page, 'joins')).toMatchObject({
    value: { joins: [{ name: EDGE, used: expect.any(String) }] },
  })
  // Recorded, by their SHA-256's start; neither is in the hub's log.
  expect(audited(hub, 'agent.joined')).toEqual([
    expect.objectContaining({
      cluster: EDGE,
      details: { token: expect.stringMatching(/^[0-9a-f]{8}…$/), credential: expect.any(String) },
    }),
  ])
  expect(hub.log()).not.toContain(token)
  expect(hub.log()).not.toContain(credential)

  // The command again, elsewhere: its join token was used.
  agentSecret(clusters, { 'join-token': token }, 'lumovi-agent-again')
  const again = agentOf(hub.url, clusters, {
    LUMOVI_AGENT_JOIN_TOKEN: token,
    LUMOVI_AGENT_TOKEN_SECRET: 'lumovi-agent-again',
  })
  expect(await again.exited).toBe(1)
  expect(again.log()).toContain(
    `The hub at ${origin} refused this agent: its join token was used already.`,
  )
  expect(Object.keys(kept(clusters, 'lumovi-agent-again'))).toEqual(['join-token'])

  // Started again, as its chart starts it, with the token it kept; and the hub restarted.
  await agent.stop()
  await hub.stop()
  const restarted = await serve({ port, env })
  const resumed = agentOf(restarted.url, clusters, {
    LUMOVI_AGENT_TOKEN: credential,
    LUMOVI_AGENT_HEALTH_PORT: '0',
  })
  await expect.poll(() => resumed.log()).toContain(`Connected to ${origin} as ${EDGE}`)
  await page.goto(restarted.url)
  await expect.poll(() => names(page)).toContain(EDGE)

  // Removed: its agent is let go at once, and stops; nobody sees it; recorded.
  expect(await call(page, 'remove', EDGE)).toEqual({})
  expect(await resumed.exited).toBe(1)
  expect(resumed.log()).toContain(
    `The hub at ${origin} refused this agent: it was removed from the fleet.`,
  )
  expect(await names(page)).not.toContain(EDGE)
  expect(audited(restarted, 'cluster.removed')).toEqual([
    expect.objectContaining({
      cluster: EDGE,
      actor: expect.objectContaining({ user: 'admin@example.com' }),
    }),
  ])
  expect(await call(page, 'remove', EDGE)).toEqual({
    error: `No cluster called ${EDGE} was connected from this page.`,
  })
})

test('a join token that isn’t one, or expired, is refused; an agent stopped half way joins again', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({ env: { ...hubEnv(clusters), LUMOVI_FLEET_JOIN_SECONDS: '6' } })
  const origin = hub.url.replace(/\/$/, '')
  await as(context, 'admin@example.com')
  await page.goto(hub.url)
  const token = await connect(page)

  // Not its join token.
  const wrong = agentOf(hub.url, clusters, { LUMOVI_AGENT_JOIN_TOKEN: `${token}x` })
  expect(await wrong.exited).toBe(1)
  expect(wrong.log()).toContain(
    `The hub at ${origin} refused this agent: it doesn’t know this name and join token.`,
  )

  // Given its token, it can't keep it (its Secret can't be changed): it stops, saying why, and
  // its join token isn't spent.
  agentSecret(clusters, { 'join-token': token })
  const forbidden = clusters.demo.fail(`/api/v1/namespaces/lumovi/secrets/${SECRET}`, {
    status: 403,
  })
  const unkept = agentOf(hub.url, clusters, { LUMOVI_AGENT_JOIN_TOKEN: token })
  expect(await unkept.exited).toBe(1)
  expect(unkept.log()).toContain(
    `${origin} gave this agent its token, but it can’t keep it in the Secret ${SECRET}: 403`,
  )
  forbidden()
  expect(await call(page, 'joins')).toMatchObject({ value: { joins: [{ name: EDGE }] } })
  expect(((await call(page, 'joins')).value as { joins: { used?: string }[] }).joins[0]!.used).toBe(
    undefined,
  )

  // Given its token half way (it stopped before connecting with it): it joins again, and the
  // token it was given first doesn't.
  const first = await new Promise<string>((given, failed) => {
    const ws = new WebSocket(new URL('api/agent', hub.url.replace(/^http/, 'ws')), {
      headers: { Authorization: `Bearer ${token}`, 'Lumovi-Agent': EDGE, 'Lumovi-Join': '1' },
    })
    ws.on('message', (data) => given((JSON.parse(String(data)) as { token: string }).token))
    ws.on('error', failed)
  })
  const joined = agentOf(hub.url, clusters, { LUMOVI_AGENT_JOIN_TOKEN: token })
  await expect.poll(() => joined.log()).toContain(`Joined ${origin} as ${EDGE}`)
  expect(kept(clusters).token).not.toBe(first)
  const status = await new Promise<number>((done) => {
    const ws = new WebSocket(new URL('api/agent', hub.url.replace(/^http/, 'ws')), {
      headers: { Authorization: `Bearer ${first}`, 'Lumovi-Agent': EDGE },
    })
    ws.on('unexpected-response', (_req, res) => done(res.statusCode ?? 0))
    ws.on('open', () => done(101))
  })
  expect(status).toBe(401)
  await joined.stop()

  // Past its time: refused, said so.
  const late = await connect(page, 'lab')
  await page.waitForTimeout(6100)
  const expired = agentOf(hub.url, clusters, {
    LUMOVI_AGENT_NAME: 'lab',
    LUMOVI_AGENT_JOIN_TOKEN: late,
  })
  expect(await expired.exited).toBe(1)
  expect(expired.log()).toContain(
    `The hub at ${origin} refused this agent: its join token expired: make a new command on the Fleet page.`,
  )
})

test('an admin connects a cluster from the Fleet page: a command, a wait, then its CA checked', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const hub = await serve({ env: hubEnv(clusters) })
  // Someone else has nothing to add.
  await as(context, 'alice@example.com')
  await page.goto(hub.url)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('cluster')
  await expect(page.getByRole('button', { name: 'Add cluster' })).toHaveCount(0)

  // (In the group it's shared with.)
  await as(context, 'admin@example.com', 'platform')
  await page.reload()
  await page.getByRole('button', { name: 'Add cluster' }).click()
  await page.getByRole('menuitem', { name: /^Connect with an agent…/ }).click()
  const form = page.getByRole('dialog', { name: 'Connect a cluster' })
  await form.getByLabel('Name').fill('Edge AP')
  await expect(form).toContainText(
    'Up to 63 lowercase letters, digits or “-”, starting and ending with a letter or digit.',
  )
  await expect(form.getByRole('button', { name: 'Create the command' })).toBeDisabled()
  await form.getByLabel('Name').fill(EDGE)
  await form.getByRole('textbox', { name: 'Add a label' }).fill('region=ap-south')
  await form.getByRole('textbox', { name: 'Add a label' }).press('Enter')
  await form.getByRole('textbox', { name: 'Add a group' }).fill('platform')
  await form.getByRole('textbox', { name: 'Add a group' }).press('Enter')
  await form.getByRole('button', { name: 'Create the command' }).click()

  // Its join token, once, and the command, which asks for it (it's not on the command line).
  const dialog = page.getByRole('dialog', { name: `Connect ${EDGE}` })
  const token = (await dialog.locator('code').first().textContent())!
  expect(token).toMatch(/^lumovi_join_/)
  const command = (await dialog.locator('code').nth(1).textContent())!
  expect(command).toContain('read -rs LUMOVI_JOIN_TOKEN')
  expect(command).toContain('helm install lumovi oci://ghcr.io/lumovi/charts/lumovi')
  expect(command).toContain(`--set mode=agent --set clusterName=${EDGE}`)
  expect(command).toContain(`--set agent.hubUrl=${hub.url.replace(/\/$/, '')}`)
  expect(command).toContain('--set-file agent.joinToken=/dev/stdin')
  // (Then it's forgotten.)
  expect(command).toMatch(/\nunset LUMOVI_JOIN_TOKEN$/)
  await expect(dialog).toContainText(`In ${EDGE}, with bash or zsh`)
  expect(command).not.toContain(token)
  await expect(dialog.getByRole('status')).toContainText(`Waiting for ${EDGE} to connect…`)
  await expect(dialog.getByRole('status')).toContainText(/\d+:\d\d$/)

  // Closed, it waits on the page; shown again, without its token.
  await dialog.getByRole('button', { name: 'Leave it waiting' }).click()
  const waiting = page.getByRole('region', { name: `${EDGE}, Waiting for its agent…` })
  await waiting.getByRole('button', { name: 'Show the command' }).click()
  await expect(dialog).toContainText('Its join token was shown when the command was made')
  await expect(dialog.locator('code')).toHaveCount(1)

  // Its agent joins: the dialog says so, and asks for the last step.
  agentSecret(clusters, { 'join-token': token })
  const agent = agentOf(hub.url, clusters, { LUMOVI_AGENT_JOIN_TOKEN: token })
  const connected = page.getByRole('dialog', { name: `${EDGE} is connected` })
  await expect(connected).toContainText('Check its certificate authority')
  await connected
    .getByLabel(`${EDGE}’s certificate authority’s SHA-256`)
    .fill(new X509Certificate(clusters.demo.caPem!).fingerprint256)
  await connected.getByRole('button', { name: 'Trust it' }).click()
  await expect(connected).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    `Trusted ${EDGE}’s agent`,
  )
  await expect(waiting).toHaveCount(0)
  // Its card lands, tinted for a moment.
  const card = page.getByRole('link', { name: new RegExp(`^${EDGE}, `) })
  await expect(card).toContainText('region=ap-south')
  await expect(card).toHaveAttribute('data-fresh', 'true')
  await agent.stop()

  // Another, cancelled from its card: recorded.
  await page.getByRole('button', { name: 'Add cluster' }).click()
  await page.getByRole('menuitem', { name: /^Connect with an agent…/ }).click()
  await form.getByLabel('Name').fill('lab')
  await form.getByRole('button', { name: 'Create the command' }).click()
  await page
    .getByRole('dialog', { name: 'Connect lab' })
    .getByRole('button', { name: 'Leave it waiting' })
    .click()
  await page
    .getByRole('region', { name: 'lab, Waiting for its agent…' })
    .getByRole('button', { name: 'Cancel it' })
    .click()
  await expect(page.getByRole('region', { name: /^lab, / })).toHaveCount(0)
  expect(audited(hub, 'agent.join-cancelled')).toEqual([
    expect.objectContaining({ cluster: 'lab' }),
  ])
})

test('an agent refused just after it joined (by a replica behind) tries again, not stops', async ({
  clusters,
}) => {
  // A hub that gives a token for the join token, then doesn't know it twice, as a replica that
  // hasn't read it yet wouldn't.
  const seen: string[] = []
  const sockets = new WebSocketServer({ noServer: true })
  const hub = createServer()
  hub.on('upgrade', (req, socket, head) => {
    const joining = req.headers['lumovi-join'] === '1'
    seen.push(joining ? 'join' : 'token')
    if (!joining) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) =>
      ws.send(JSON.stringify({ type: 'credential', token: 'lumovi_agent_given' }), () =>
        ws.close(4202, 'Connect with the credential you were given.'),
      ),
    )
  })
  await new Promise<void>((done) => hub.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}/`
  agentSecret(clusters, { 'join-token': 'lumovi_join_given' })
  const agent = agentOf(url, clusters, { LUMOVI_AGENT_JOIN_TOKEN: 'lumovi_join_given' })
  try {
    await expect.poll(() => seen).toEqual(['join', 'token', 'token'])
    expect(kept(clusters).token).toBe('lumovi_agent_given')
    expect(agent.log()).toContain('Connecting again in 2 s')
    expect(agent.log()).not.toContain('refused this agent')
  } finally {
    await agent.stop()
    hub.close()
  }
})
