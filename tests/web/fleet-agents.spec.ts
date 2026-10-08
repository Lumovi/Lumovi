/**
 * A fleet's agents: clusters the hub can't reach dial it instead, and relay
 * its connections to their API server, which TLS keeps private from them.
 */
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect as connectTo, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import { generate } from 'selfsigned'
import { WebSocket, WebSocketServer } from 'ws'
import { HELM } from '../mock-cluster/fixtures/helm.ts'
import {
  audited,
  expect,
  freePort,
  inCluster,
  startAgent,
  test,
  type Agent,
  type Served,
} from './fixtures.ts'
import { startMockProxy } from '../mock-proxy/server.ts'
import { as, card } from './fleet.ts'

/** The agent's version, as it says it: the app's. */
const { version: VERSION } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string
}
const NAME = 'private-eu'
const TOKEN = 'the-private-eu-agent-token-0123456789'

/** A hub whose only clusters are agents'. */
const HUB = {
  LUMOVI_AUTH: 'proxy',
  KUBECONFIG: undefined,
  LUMOVI_CONTEXT: undefined,
  LUMOVI_FLEET_AGENTS: Buffer.from(
    `- name: ${NAME}\n  token: ${TOKEN}\n  labels: { env: production, network: private }\n` +
      // Only the SRE team sees this one; it never connects.
      `- name: vault\n  tokenSha256: ${'A1'.repeat(32)}\n  groups: [sre]\n`,
  ).toString('base64'),
  // Agents are pinged, as pages are: often enough to see it here, not so often that a busy
  // machine misses a beat (a page or an agent that misses one is dropped).
  LUMOVI_HEARTBEAT_SECONDS: '5',
  FAKE_HELM_REACH: '1',
}

/** An agent of the demo cluster, dialing `hub`. */
function agentOf(
  hub: string,
  account: ReturnType<typeof inCluster>,
  env: Record<string, string | undefined> = {},
): Agent {
  return startAgent({
    LUMOVI_HUB_URL: hub,
    LUMOVI_AGENT_NAME: NAME,
    LUMOVI_AGENT_TOKEN: TOKEN,
    ...account.env,
    ...env,
  })
}

/**
 * TLS in front of 127.0.0.1:`port`, as an ingress would be, with a certificate for `name` that's
 * its own authority (in a file, for LUMOVI_CA_FILE).
 */
async function tlsTo(port: number, name: string) {
  const pems = await generate([{ name: 'commonName', value: name }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: name }] },
    ],
  })
  const caFile = join(mkdtempSync(join(tmpdir(), 'lumovi-ingress-')), 'ca.pem')
  writeFileSync(caFile, pems.cert)
  const sockets = new Set<Socket>()
  const server = tls.createServer({ key: pems.private, cert: pems.cert }, (socket) => {
    const upstream = connectTo(port, '127.0.0.1')
    socket.pipe(upstream).pipe(socket)
    for (const s of [socket, upstream]) {
      sockets.add(s)
      s.on('error', () => undefined)
      s.on('close', () => sockets.delete(s))
    }
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as AddressInfo).port,
    caFile,
    close: () =>
      new Promise<void>((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  }
}

/** The helm runs that reached the cluster first, and what it answered. */
function reached(served: Served): { args: string[]; status: number | string }[] {
  try {
    return readFileSync(join(served.helmDir, 'reached.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('an agent reaches its hub through the proxy the environment says', async ({
  serve,
  clusters,
}) => {
  const account = inCluster(clusters)
  const proxy = await startMockProxy()
  const served = await serve({ env: HUB })
  // The hub over https, as an ingress would serve it, by a name only the proxy knows (its own API
  // server, directly). Its certificate's authority is the agent's to trust (LUMOVI_CA_FILE).
  const ingress = await tlsTo(served.port, 'hub.test')
  const agent = agentOf(`https://hub.test:${ingress.port}`, account, {
    HTTPS_PROXY: proxy.url,
    LUMOVI_CA_FILE: ingress.caFile,
  })
  await expect
    .poll(() => served.log())
    .toContain(`The agent of ${NAME} connected (Lumovi ${VERSION})`)
  expect(proxy.seen).toEqual([`CONNECT hub.test:${ingress.port}`])
  expect(agent.log()).toContain(
    `Lumovi’s own connections go through the proxy ${proxy.url} for https, except to`,
  )
  await agent.stop()
  await served.stop()
  await ingress.close()
  await proxy.close()
})

test('an agent is trusted with the certificate authority it’s named with, or first sent', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  test.setTimeout(150_000)
  const account = inCluster(clusters)
  // As openssl x509 -noout -fingerprint -sha256 prints it, prefix and colons and all.
  const printed = (pem: string) => `sha256 Fingerprint=${new X509Certificate(pem).fingerprint256}`
  const hex = (pem: string) =>
    new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase()
  const sha256 = hex(clusters.demo.caPem!)
  const agents = (more = '') =>
    Buffer.from(`- name: ${NAME}\n  token: ${TOKEN}\n${more}`).toString('base64')
  await as(context, 'alice@example.com')

  // Named in LUMOVI_FLEET_AGENTS: trusted, with nothing else to keep.
  const named = await serve({
    env: {
      ...HUB,
      LUMOVI_FLEET_AGENTS: agents(`  caSha256: "${printed(clusters.demo.caPem!)}"\n`),
    },
  })
  expect(named.log()).not.toContain('no caSha256')
  let agent = agentOf(named.url, account)
  await page.goto(named.url)
  await expect(card(page, NAME)).toContainText('Nodes')
  expect(audited(named, 'agent.pinned')).toEqual([])
  await agent.stop()
  await named.stop()

  // Another named: refused, as its card, the agent's log and health, and the audit log say.
  const health = await freePort()
  const wrong = await serve({
    env: { ...HUB, LUMOVI_FLEET_AGENTS: agents(`  caSha256: ${'ab'.repeat(32)}\n`) },
  })
  agent = agentOf(wrong.url, account, { LUMOVI_AGENT_HEALTH_PORT: String(health) })
  const notNamed = `Its agent sent a certificate authority (SHA-256 ${sha256.slice(0, 8)}…) other than the one LUMOVI_FLEET_AGENTS names for it.`
  await expect.poll(() => agent.log()).toContain(`The hub doesn’t trust this cluster: ${notNamed}`)
  // Not ready: the hub doesn't use it.
  const healthz = async () => {
    const response = await fetch(`http://127.0.0.1:${health}/healthz`)
    return `${response.status} ${await response.text()}`
  }
  expect(await healthz()).toBe(`503 connected, but refused: ${notNamed}`)
  await page.goto(wrong.url)
  await expect(card(page, NAME)).toContainText(notNamed)
  expect(audited(wrong, 'agent.refused')).toEqual([
    expect.objectContaining({ outcome: 'refused', cluster: NAME, error: notNamed }),
  ])
  await agent.stop()
  await wrong.stop()

  // Named nowhere, with nothing to keep what's trusted: said as it starts, as it matters more.
  const memory = await serve({ env: { ...HUB, LUMOVI_FLEET_AGENTS: agents() } })
  expect(memory.log()).toContain(
    `${NAME} has no caSha256 in LUMOVI_FLEET_AGENTS: the hub trusts the certificate authority each first sends, from whoever has its token, and, as nothing keeps what it trusts (no LUMOVI_DATA_DIR, nor the chart’s auth.keepSessions), again after every restart. Give each its cluster’s.`,
  )
  // With no admins, anyone signed in checks it (with its SHA-256 from the cluster, as admins do).
  agent = agentOf(memory.url, account)
  await expect.poll(() => audited(memory, 'agent.pinned').length).toBe(1)
  await page.goto(memory.url)
  const anyone = page.getByRole('region', { name: 'Agents to check' })
  await anyone.getByRole('button', { name: 'Check it…' }).click()
  await anyone.getByLabel(`${NAME}’s certificate authority’s SHA-256`).fill(sha256)
  await anyone.getByRole('button', { name: 'Trust it', exact: true }).click()
  await expect(anyone).toHaveCount(0)
  expect(audited(memory, 'agent.trusted')).toEqual([
    expect.objectContaining({ actor: expect.objectContaining({ user: 'alice@example.com' }) }),
  ])
  await agent.stop()
  await memory.stop()

  // Kept: the one it first sends is trusted, and recorded; admins are asked to check it.
  const data = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = {
    ...HUB,
    LUMOVI_FLEET_AGENTS: agents(),
    LUMOVI_DATA_DIR: data,
    LUMOVI_ADMINS: 'user:admin@example.com',
  }
  const port = await freePort()
  const first = await serve({ port, env })
  expect(first.log()).toContain(
    `${NAME} has no caSha256 in LUMOVI_FLEET_AGENTS: the hub trusts the certificate authority each first sends, from whoever has its token. Give each its cluster’s.`,
  )
  agent = agentOf(first.url, account, { LUMOVI_AGENT_HEALTH_PORT: String(health) })
  await expect
    .poll(() => audited(first, 'agent.pinned'))
    .toEqual([expect.objectContaining({ cluster: NAME, details: { sha256: [sha256] } })])
  await expect.poll(healthz).toBe('200 connected')
  await as(context, 'admin@example.com')
  await page.goto(first.url)
  const toCheck = page.getByRole('region', { name: 'Agents to check' })
  await expect(toCheck).toContainText(
    `${NAME}’s agent is trusted with the certificate authority it first sent, which nobody has checked.`,
  )
  // Checked, with its SHA-256 from the cluster: then nothing's left to check.
  await toCheck.getByRole('button', { name: 'Check it…' }).click()
  await toCheck
    .getByLabel(`${NAME}’s certificate authority’s SHA-256`)
    .fill(printed(clusters.demo.caPem!))
  await toCheck.getByRole('button', { name: 'Trust it', exact: true }).click()
  await expect(toCheck).toHaveCount(0)
  expect(audited(first, 'agent.trusted')).toEqual([
    expect.objectContaining({ details: { was: [sha256], now: [sha256] } }),
  ])
  await agent.stop()
  await first.stop()

  // After a restart, an agent sending another is refused (whoever has its token could).
  const other = await generate([{ name: 'commonName', value: 'someone else’s cluster' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true }],
  })
  writeFileSync(join(account.dir, 'ca.crt'), other.cert)
  const otherSha256 = hex(other.cert)
  const restarted = await serve({ port, env })
  agent = agentOf(restarted.url, account, { LUMOVI_AGENT_HEALTH_PORT: String(health) })
  const changed = `Its agent sent a certificate authority (SHA-256 ${otherSha256.slice(0, 8)}…) other than the one it’s trusted with. If its cluster’s changed, an admin can trust the new one, given its SHA-256 from the cluster itself.`
  await expect.poll(() => agent.log()).toContain(`The hub doesn’t trust this cluster: ${changed}`)
  await expect.poll(healthz).toBe(`503 connected, but refused: ${changed}`)
  // Someone who isn't an admin can't trust it, nor see what agents send.
  await as(context, 'alice@example.com')
  await page.goto(restarted.url)
  await expect(card(page, NAME)).toContainText(changed)
  await expect(page.getByRole('region', { name: 'Agents to check' })).toHaveCount(0)
  expect(
    await page.evaluate(
      (name) => window.lumovi!.fleet!.trustAgent(name, 'x').catch((e: Error) => e.message),
      NAME,
    ),
  ).toBe('Only Lumovi’s admins trust an agent.')
  expect(
    await page.evaluate(() =>
      window.lumovi!.fleet!.agents().then(
        () => 'seen',
        (e: Error) => e.message,
      ),
    ),
  ).toBe('Only Lumovi’s admins see its agents.')
  // An admin trusts it only with the SHA-256 they give, from its cluster: what it sends now.
  await as(context, 'admin@example.com')
  await page.reload()
  const refused = page.getByRole('region', { name: 'Agents to check' })
  await expect(refused).toContainText(
    `${NAME}’s agent sends a certificate authority other than the one it’s trusted with.`,
  )
  await refused.getByRole('button', { name: 'Trust it…' }).click()
  // Only enough of each to tell them apart: all of what it sends could be given back.
  await expect(refused).toContainText(`It sends${otherSha256.slice(0, 8)}…`)
  await expect(refused).toContainText(`Trusted with${sha256.slice(0, 8)}…`)
  const given = refused.getByLabel(`${NAME}’s certificate authority’s SHA-256`)
  // Not the one it sends (the old one, say): refused.
  await given.fill(sha256)
  await refused.getByRole('button', { name: 'Trust it', exact: true }).click()
  await expect(refused.getByRole('alert')).toHaveText(
    `${NAME}’s agent doesn’t send a certificate authority with that SHA-256: it sends ${otherSha256.slice(0, 8)}….`,
  )
  expect(await page.locator('body').innerText()).not.toContain(otherSha256)
  expect(await page.locator('body').innerText()).not.toContain(otherSha256.slice(0, 16))
  await given.fill(printed(other.cert))
  await refused.getByRole('button', { name: 'Trust it', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    `Trusted ${NAME}’s agent`,
  )
  await expect(refused).toHaveCount(0)
  await expect.poll(healthz).toBe('200 connected')
  expect(
    audited(restarted)
      .filter((e) => e.action.startsWith('agent.'))
      .map((e) => [e.action, e.actor.user, e.details]),
  ).toEqual([
    ['agent.refused', 'lumovi', { sha256: [otherSha256] }],
    ['agent.trusted', 'admin@example.com', { was: [sha256], now: [otherSha256] }],
  ])
  await agent.stop()
  await restarted.stop()
})

test('a cluster behind its agent', async ({ page, context, serve, clusters, request }) => {
  test.setTimeout(90_000)
  const account = inCluster(clusters)
  const port = await freePort()
  const health = await freePort()
  // It starts before the hub does, and keeps trying.
  const agent = agentOf(`http://127.0.0.1:${port}`, account, {
    LUMOVI_AGENT_HEALTH_PORT: String(health),
    LUMOVI_AGENT_TOKEN_CHECK_SECONDS: '1',
  })
  await expect.poll(() => agent.log()).toContain('Connecting again in 1 s: it couldn’t connect')
  expect(agent.log()).toContain(`Lumovi ${VERSION}’s agent for ${NAME}, relaying to 127.0.0.1:`)
  expect(agent.log()).toContain(
    `Can’t reach the hub at http://127.0.0.1:${port}: connect ECONNREFUSED`,
  )
  // Not ready while it isn't connected.
  const healthz = `http://127.0.0.1:${health}/healthz`
  expect((await request.get(healthz)).status()).toBe(503)
  expect(await (await request.get(healthz)).text()).toBe('not connected')
  expect((await request.get(`http://127.0.0.1:${health}/`)).status()).toBe(404)

  const served = await serve({ port, env: HUB })
  expect(served.log()).toContain('shows a fleet of 2 clusters (private-eu, vault)')
  await expect
    .poll(() => served.log())
    .toContain(`The agent of ${NAME} connected (Lumovi ${VERSION})`)
  await expect.poll(() => agent.log()).toContain(`Connected to http://127.0.0.1:${port} as ${NAME}`)
  await expect.poll(async () => (await request.get(healthz)).status()).toBe(200)

  // Its cluster, as if the hub reached it directly: as each person, through the tunnel.
  await as(context, 'alice@example.com', 'developers')
  await page.goto(served.url)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('1 cluster1 needs attention')
  const eu = card(page, NAME)
  await expect(eu).toContainText('env=productionnetwork=private')
  await expect(eu).toContainText('Nodes3/41 not ready')
  await expect(eu).toContainText('Pods running288 unhealthy')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({
      user: 'alice@example.com',
      headers: { authorization: 'Bearer lumovi-demo-token' },
    })
  // Its pages, through the same tunnel.
  await eu.click()
  await expect(page).toHaveURL(`${served.url}cluster/${NAME}`)
  await page.goto(`${served.url}cluster/${NAME}/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect(page.getByRole('grid')).toContainText('checkout')

  // Helm reaches it through a port of the hub's own, while it runs.
  await page.goto(`${served.url}cluster/${NAME}/helm`)
  await page
    .getByRole('grid', { name: 'Helm releases' })
    .getByRole('row')
    .filter({ hasText: HELM.storefront })
    .first()
    .getByRole('gridcell')
    .nth(1)
    .click()
  const release = page.getByRole('complementary', { name: `Helm release ${HELM.storefront}` })
  await release.getByRole('button', { name: 'Roll back…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(
    `Rolled back ${HELM.storefront}`,
  )
  const rollback = reached(served).find((r) => r.args[0] === 'rollback')!
  expect(rollback.status).toBe(200)

  // Kubernetes rotates its token: the agent tells the hub, which uses the new one.
  clusters.demo.setUser('lumovi-rotated-token', {
    username: 'system:serviceaccount:lumovi:agent',
    impersonate: true,
  })
  writeFileSync(join(account.dir, 'token'), 'lumovi-rotated-token')
  await page.waitForTimeout(2000)
  await page.goto(served.url)
  await expect
    .poll(
      () =>
        clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes')?.headers.authorization,
    )
    .toBe('Bearer lumovi-rotated-token')

  // Connections the API server closes when idle are closed through the tunnel too.
  await page.waitForTimeout(6000)
  await page.reload()
  await expect(card(page, NAME)).toContainText('Nodes3/4')

  // The hub restarts: it closes its agents' connections (or, stopped at once, as Windows stops
  // a process, they just drop), and its agent connects to the next one.
  await served.stop()
  await expect
    .poll(() => agent.log())
    .toMatch(
      /Connecting again in 1 s: the connection closed \((1001: The hub is restarting\.|1006)\)/,
    )
  const next = await serve({ port, env: HUB })
  // (Within its next tries: 1, 2, 4 and 8 seconds apart.)
  await expect
    .poll(() => next.log(), { timeout: 20_000 })
    .toContain(`The agent of ${NAME} connected`)

  // Another agent connects as it: the first stops (two clusters with one name and token).
  const second = agentOf(`http://127.0.0.1:${port}/`, account)
  expect(await agent.exited).toBe(1)
  expect(agent.log()).toContain(
    `The hub at http://127.0.0.1:${port} refused this agent: another agent connected as it (do two clusters use the same name and token?).`,
  )
  await page.reload()
  await expect(card(page, NAME)).toContainText('Nodes3/4')

  // It stops: its cluster can't be reached, and says why.
  await second.stop()
  await expect.poll(() => next.log()).toContain(`The agent of ${NAME} disconnected`)
  await page.reload()
  await expect(card(page, NAME)).toHaveAccessibleName(`${NAME}, Unreachable`)
  await expect(card(page, NAME)).toContainText('Its agent isn’t connected.')
  await page.goto(`${served.url}cluster/${NAME}`)
  await expect(page.getByRole('alert')).toContainText('Its agent isn’t connected.')
})

test('agents the hub won’t have, and agents that can’t start', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const account = inCluster(clusters)
  const served = await serve({ env: HUB })
  // A token the hub doesn't know: retrying wouldn't help.
  const wrong = agentOf(served.url, account, {
    LUMOVI_AGENT_TOKEN: 'not-the-token',
    KUBERNETES_SERVICE_PORT: undefined,
  })
  expect(await wrong.exited).toBe(1)
  expect(wrong.log()).toContain('relaying to 127.0.0.1:443')
  expect(wrong.log()).toContain('refused this agent: it doesn’t know this name and token.')
  expect(served.log()).toContain(`An agent was refused: “${NAME}”, with a token that doesn’t match`)

  // Without what it needs.
  for (const [env, message] of [
    [
      { LUMOVI_HUB_URL: undefined },
      'LUMOVI_HUB_URL must be set: see https://docs.lumovi.dev/server/fleet/agents',
    ],
    [{ LUMOVI_AGENT_TOKEN: ' ' }, 'LUMOVI_AGENT_TOKEN must be set'],
    [
      { LUMOVI_HUB_URL: 'lumovi.example.com' },
      'LUMOVI_HUB_URL must be the hub’s address, like https://lumovi.example.com, not "lumovi.example.com".',
    ],
    // Over http, its token and its cluster's would cross the network as they are.
    [
      { LUMOVI_HUB_URL: 'http://lumovi.example.com/fleet' },
      'LUMOVI_HUB_URL must be https, not http://lumovi.example.com: the agent’s token and its cluster’s would cross the network as they are.',
    ],
    [
      { LUMOVI_SERVICE_ACCOUNT_DIR: undefined, LUMOVI_AGENT_HEALTH_PORT: undefined },
      'No service account token in /var/run/secrets/kubernetes.io/serviceaccount: the agent needs its pod’s (automountServiceAccountToken).',
    ],
  ] as const) {
    const agent = agentOf(served.url, account, env)
    expect(await agent.exited).toBe(1)
    expect(agent.log()).toContain(message)
  }

  // A hub it can't reach over TLS: it keeps trying, until it's stopped.
  const far = agentOf('https://127.0.0.1:1', account)
  await expect.poll(() => far.log()).toContain('Can’t reach the hub at https://127.0.0.1:1:')
  await far.stop()

  // A hub that drops it: it connects again.
  const dropping = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((listening) => dropping.once('listening', listening))
  dropping.on('connection', (ws) => ws.terminate())
  const { port } = dropping.address() as { port: number }
  const dropped = agentOf(`http://127.0.0.1:${port}`, account)
  await expect
    .poll(() => dropped.log())
    .toContain('Connecting again in 1 s: the connection closed (1006)')
  await dropped.stop()
  dropping.close()

  // A hub that goes quiet (the connection dropped somewhere, without a word): it's taken for
  // lost after two of its heartbeats, and dialed again.
  const quiet = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((listening) => quiet.once('listening', listening))
  quiet.on('connection', (ws) =>
    ws.send(JSON.stringify({ type: 'welcome', cluster: NAME, heartbeatSeconds: 1 })),
  )
  const waiting = agentOf(`http://127.0.0.1:${(quiet.address() as { port: number }).port}`, account)
  await expect.poll(() => waiting.log()).toContain('Nothing from the hub in 3 s')
  await expect
    .poll(() => waiting.log())
    .toContain('Connecting again in 1 s: the connection closed (1006)')
  await waiting.stop()
  quiet.close()

  // An agent whose API server can't be reached: the hub's connections through it fail.
  const lost = agentOf(served.url, account, { KUBERNETES_SERVICE_PORT: String(await freePort()) })
  await expect.poll(() => served.log()).toContain(`The agent of ${NAME} connected`)
  await as(context, 'alice@example.com')
  await page.goto(served.url)
  await expect(card(page, NAME)).toHaveAccessibleName(`${NAME}, Unreachable`)
  await lost.stop()

  // Only a fleet takes agents: a server of one cluster doesn't.
  const single = await serve()
  const refused = await connect(single, { Authorization: `Bearer ${TOKEN}`, 'Lumovi-Agent': NAME })
  expect(refused).toBe('Unexpected server response: 403')
})

/** An agent of the test's own, connected to a hub. */
interface FakeAgent {
  ws: WebSocket
  /** What the hub says first (it may come with the upgrade, as soon as it's open). */
  welcome: Promise<unknown>
  /** How the connection closes, once it does. */
  closed: Promise<number>
}

/** Connects to a hub as an agent would, or says why it couldn't. */
function connect(served: Served, headers: Record<string, string>): Promise<FakeAgent | string> {
  const ws = new WebSocket(`${served.url.replace(/^http/, 'ws')}api/agent`, { headers })
  // Listened for from the start: the hub's first words can arrive with the upgrade's answer.
  const welcome = new Promise((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(String(data)))),
  )
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  return new Promise((resolve) => {
    ws.once('open', () => resolve({ ws, welcome, closed }))
    ws.once('error', (error) => resolve(error.message))
  })
}

function frame(kind: number, id: number, payload = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(id, 1)
  return Buffer.concat([header, payload])
}

test('what the hub makes of what an agent says', async ({ page, context, serve, clusters }) => {
  const served = await serve({ env: HUB })
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Lumovi-Agent': NAME }
  // Without a name or token, or with something else than a bearer token.
  expect(await connect(served, {})).toBe('Unexpected server response: 401')
  expect(await connect(served, { Authorization: TOKEN, 'Lumovi-Agent': NAME })).toBe(
    'Unexpected server response: 401',
  )

  // Anything but a hello closes it.
  for (const said of [
    'not json',
    'null',
    JSON.stringify({ type: 'hello', version: '1', ca: 'x' }),
  ]) {
    const agent = (await connect(served, headers)) as FakeAgent
    expect(await agent.welcome).toEqual({ type: 'welcome', cluster: NAME, heartbeatSeconds: 5 })
    agent.ws.send(said)
    expect(await agent.closed).toBe(1008)
  }
  // Nor does a WebSocket that breaks its protocol stay.
  const broken = (await connect(served, headers)) as FakeAgent
  ;(broken.ws as unknown as { _socket: Socket })._socket.write(Buffer.from([0x82, 0x00]))
  // (Closed as a protocol error, unless the hub's close frame is cut off by dropping it.)
  expect([1002, 1006]).toContain(await broken.closed)

  // An agent whose cluster hangs up on every connection.
  const { ws } = (await connect(served, headers)) as FakeAgent
  ws.on('message', (data: Buffer, binary) => {
    if (!binary || data.readUInt8(0) !== 1) return
    const id = data.readUInt32BE(1)
    // Something it doesn't know, then the end of the stream, then a reset.
    ws.send(frame(9, id))
    ws.send(frame(3, id))
    ws.send(frame(4, id))
  })
  // Frames it ignores: too short, for no stream, and a stream only the hub may open.
  ws.send(Buffer.from([2, 0]))
  ws.send(frame(2, 77, Buffer.from('stray')))
  ws.send(frame(1, 78))
  ws.send(
    JSON.stringify({
      type: 'hello',
      version: '1.0.0',
      ca: Buffer.from(clusters.demo.caPem!).toString('base64'),
      token: 'lumovi-demo-token',
    }),
  )
  await expect.poll(() => served.log()).toContain(`The agent of ${NAME} connected (Lumovi 1.0.0)`)
  await as(context, 'alice@example.com')
  await page.goto(served.url)
  await expect(card(page, NAME)).toHaveAccessibleName(`${NAME}, Unreachable`)
  ws.close()
})
