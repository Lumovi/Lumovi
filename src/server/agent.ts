/**
 * `node out/agent/agent.js`: a fleet's agent, for a cluster its hub can't
 * reach. It runs in that cluster, dials the hub (only outward: nothing
 * listens for the hub here), and relays the hub's connections to its own API
 * server. TLS runs from the hub to the API server, inside: the agent only
 * passes on bytes it can't read. Its service account may only impersonate,
 * so the hub acts as each person, and their RBAC applies.
 *
 * LUMOVI_HUB_URL       the hub's address (https://lumovi.example.com/; http only on this computer)
 * LUMOVI_AGENT_NAME    the cluster's name, as the hub's LUMOVI_FLEET_AGENTS has it
 * LUMOVI_AGENT_TOKEN   its token there
 * LUMOVI_AGENT_JOIN_TOKEN   or, connected from the Fleet page, its one-time join token: the hub
 *                           gives it a token of its own for it, which it keeps in
 * LUMOVI_AGENT_TOKEN_SECRET the Secret of its namespace its token is kept in (under `token`)
 * LUMOVI_AGENT_HEALTH_PORT  where GET /healthz says whether it's connected, and trusted
 *                           (8081; 0: nowhere)
 * LUMOVI_CA_FILE       certificate authorities to trust as well (a proxy's that inspects HTTPS)
 * HTTPS_PROXY, HTTP_PROXY, NO_PROXY   the proxy it reaches the hub through
 */
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { connect } from 'node:net'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { version } from '../../package.json'
import { setUpNetwork, tunnelingAgent, type Network } from '@backend/network'
import { log } from './log'
import { AGENT_JOINED, AGENT_REMOVED, AGENT_REPLACED } from './fleet/agents'
import { ignore, Tunnel } from './fleet/tunnel'

const SERVICE_ACCOUNT = '/var/run/secrets/kubernetes.io/serviceaccount'
/** How often the service account's token is read again (Kubernetes rotates it). */
const TOKEN_CHECK_MS = Number(process.env.LUMOVI_AGENT_TOKEN_CHECK_SECONDS || 60) * 1000
/** Waits between attempts to connect: doubled each time, up to the last. */
const RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000]

/** A setting the agent can't do without; it stops, saying which. */
function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`${name} must be set: see https://docs.lumovi.dev/server/fleet/agents`)
    process.exit(1)
  }
  return value
}

/**
 * The hub's address, as LUMOVI_HUB_URL has it: https, as the agent's token and its cluster's go
 * there (http only to this computer, where nothing crosses a network).
 */
function hubAddress(): URL {
  const setting = required('LUMOVI_HUB_URL')
  if (!/^https?:\/\/[^/\s]+\S*$/.test(setting)) {
    console.error(
      `LUMOVI_HUB_URL must be the hub’s address, like https://lumovi.example.com, not "${setting}".`,
    )
    process.exit(1)
  }
  const url = new URL(setting.replace(/\/*$/, '/'))
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    console.error(
      `LUMOVI_HUB_URL must be https, not ${url.origin}: the agent’s token and its cluster’s would cross the network as they are.`,
    )
    process.exit(1)
  }
  return url
}

const address = hubAddress()
const origin = address.origin
const hub = new URL('api/agent', address)
hub.protocol = hub.protocol === 'http:' ? 'ws:' : 'wss:'
const name = required('LUMOVI_AGENT_NAME')
/** Its token; or, until it's given one, its join token, and where it keeps the token it's given. */
let token = process.env.LUMOVI_AGENT_TOKEN?.trim() || undefined
let joinToken = process.env.LUMOVI_AGENT_JOIN_TOKEN?.trim() || undefined
const tokenSecret = process.env.LUMOVI_AGENT_TOKEN_SECRET?.trim() || undefined
if (!token && !joinToken) required('LUMOVI_AGENT_TOKEN')
if (!token && !tokenSecret) required('LUMOVI_AGENT_TOKEN_SECRET')
const apiHost = required('KUBERNETES_SERVICE_HOST')
const apiPort = Number(process.env.KUBERNETES_SERVICE_PORT || 443)
const accountDir = process.env.LUMOVI_SERVICE_ACCOUNT_DIR || SERVICE_ACCOUNT
const healthPort = Number(process.env.LUMOVI_AGENT_HEALTH_PORT ?? 8081)
if (!existsSync(join(accountDir, 'token'))) {
  console.error(
    `No service account token in ${accountDir}: the agent needs its pod’s (automountServiceAccountToken).`,
  )
  process.exit(1)
}

// Before it connects: the certificate authorities trusted, and the proxy, if any. Its own API
// server is reached directly.
let network: Network
try {
  network = setUpNetwork(process.env, {
    caFiles: (process.env.LUMOVI_CA_FILE ?? '').split(',').filter(Boolean),
    direct: [apiHost],
    // It runs nothing (and has nowhere to write).
    children: false,
  })
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
for (const said of network.said) log(said)
const proxy = network.proxyFor(hub.href)

let connected = false
/**
 * What the hub said of the certificate authority it sent: it trusts it, or why not (until an
 * admin does). Nothing yet, until it's said.
 */
let trust: { trusted: true } | { refused: string } | undefined
let attempts = 0
/** When it joined: for a while after, a replica that hasn't read its token yet may refuse it. */
let joinedAt = 0
/** How long after joining a refusal is taken for that, and tried again. */
const JOINING_MS = 60_000
let socket: WebSocket

/** What the hub needs to reach the API server: its CA, and the service account's token. */
function hello() {
  return {
    type: 'hello',
    version,
    ca: readFileSync(join(accountDir, 'ca.crt')).toString('base64'),
    token: readFileSync(join(accountDir, 'token'), 'utf8').trim(),
  }
}

/** What the hub said of a join token it refused, as its Lumovi-Refused header has it. */
const REFUSED: Record<string, string> = {
  used: 'its join token was used already',
  expired: 'its join token expired: make a new command on the Fleet page',
  unknown: 'it doesn’t know this name and join token',
}

/**
 * Joins with its join token: the hub gives it a token of its own, which it keeps in its Secret
 * (so it's the one it starts with from now on), then connects with.
 */
function joinHub(): void {
  const ws = new WebSocket(hub, {
    headers: { Authorization: `Bearer ${joinToken}`, 'Lumovi-Agent': name, 'Lumovi-Join': '1' },
    ...(proxy ? { agent: tunnelingAgent(proxy, hub.protocol === 'wss:') } : {}),
    perMessageDeflate: false,
  })
  socket = ws
  let given: string | undefined
  ws.on('message', (data) => {
    let said: { type?: string; token?: unknown } | undefined
    try {
      said = JSON.parse(String(data)) as typeof said
    } catch {
      said = undefined
    }
    if (said?.type === 'credential' && typeof said.token === 'string') given = said.token
  })
  ws.on('unexpected-response', (req, res) => {
    // Refused: retrying won't help. Anything else (a hub restarting), it might.
    if (res.statusCode === 401) {
      stop(REFUSED[String(res.headers['lumovi-refused'])] ?? REFUSED.unknown!)
    }
    ws.removeAllListeners('close')
    req.destroy()
    retry(`the hub answered ${res.statusCode}`, joinHub)
  })
  ws.on('error', (error) => log(`Can’t reach the hub at ${origin}: ${error.message}`))
  ws.on('close', (code) => {
    if (code !== AGENT_JOINED || !given) {
      retry('it couldn’t join', joinHub)
      return
    }
    const credential = given
    keep(credential).then(
      () => {
        log(`Joined ${origin} as ${name}: its token is kept in the Secret ${tokenSecret}`)
        token = credential
        // Used up: a token it's given is the one it joins with again, if it must.
        joinToken = undefined
        joinedAt = Date.now()
        attempts = 0
        dial()
      },
      (error: Error) => {
        // Its join token isn't spent: it joins again once it may keep its token.
        console.error(
          `${origin} gave this agent its token, but it can’t keep it in the Secret ${tokenSecret}: ${error.message}`,
        )
        process.exit(1)
      },
    )
  })
}

/** Keeps its token in its Secret (and the join token, used, out of it): its service account may. */
function keep(credential: string): Promise<void> {
  const namespace = readFileSync(join(accountDir, 'namespace'), 'utf8').trim()
  const body = JSON.stringify({
    data: { token: Buffer.from(credential).toString('base64'), 'join-token': null },
  })
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: apiHost,
        port: apiPort,
        method: 'PATCH',
        path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(tokenSecret!)}`,
        headers: {
          Authorization: `Bearer ${readFileSync(join(accountDir, 'token'), 'utf8').trim()}`,
          'Content-Type': 'application/merge-patch+json',
          'Content-Length': Buffer.byteLength(body),
        },
        ca: readFileSync(join(accountDir, 'ca.crt')),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if ((res.statusCode ?? 0) < 300) return resolve()
          const text = Buffer.concat(chunks).toString()
          let message = text
          try {
            message = (JSON.parse(text) as { message?: string }).message ?? text
          } catch {
            // As it is.
          }
          reject(new Error(`${res.statusCode}: ${message}`))
        })
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

function dial(): void {
  const ws = new WebSocket(hub, {
    headers: { Authorization: `Bearer ${token}`, 'Lumovi-Agent': name },
    // Through the proxy, if it goes through one (a WebSocket picks its own connection).
    ...(proxy ? { agent: tunnelingAgent(proxy, hub.protocol === 'wss:') } : {}),
    // What it carries is encrypted already.
    perMessageDeflate: false,
  })
  socket = ws
  let said = hello()
  let check: NodeJS.Timeout | undefined
  let silence: NodeJS.Timeout | undefined
  let opened = false
  ws.on('open', () => {
    opened = true
    const tunnel = new Tunnel(ws, {
      accept: (stream) => {
        const api = connect(apiPort, apiHost)
        stream.pipe(api).pipe(stream)
        // A connection that fails closes too, which resets the stream.
        api.on('error', ignore)
        api.on('close', () => stream.destroy())
        stream.on('close', () => api.destroy())
      },
      // Welcomed: the hub pings it every heartbeatSeconds from now on. A connection that
      // goes quiet (dropped somewhere on the way, without a word) is taken for lost.
      text: (text) => {
        const said = JSON.parse(text) as {
          type?: string
          heartbeatSeconds: number
          message?: string
        }
        // What the hub says of the certificate authority it sent: trusted, or refused (until an
        // admin trusts it). Ready only once it's trusted.
        if (said.type === 'trusted') {
          if (!trust || 'refused' in trust) log('The hub trusts this cluster')
          trust = { trusted: true }
          return
        }
        if (said.type === 'refused') {
          log(`The hub doesn’t trust this cluster: ${said.message}`)
          trust = { refused: said.message ?? '' }
          return
        }
        connected = true
        attempts = 0
        log(`Connected to ${origin} as ${name}`)
        const { heartbeatSeconds } = said
        const quiet = (heartbeatSeconds * 2 + 1) * 1000
        const listen = () => {
          clearTimeout(silence)
          silence = setTimeout(() => {
            log(`Nothing from the hub in ${quiet / 1000} s`)
            ws.terminate()
          }, quiet)
        }
        ws.on('ping', listen)
        listen()
      },
    })
    tunnel.say(said)
    check = setInterval(() => {
      const next = hello()
      if (next.token === said.token) return
      said = next
      tunnel.say(said)
    }, TOKEN_CHECK_MS)
  })
  ws.on('close', (code, reason) => {
    clearInterval(check)
    clearTimeout(silence)
    connected = false
    trust = undefined
    if (code === AGENT_REPLACED) {
      stop('another agent connected as it (do two clusters use the same name and token?)')
    }
    if (code === AGENT_REMOVED) stop('it was removed from the fleet')
    retry(
      opened
        ? `the connection closed (${code}${reason.length > 0 ? `: ${reason}` : ''})`
        : 'it couldn’t connect',
    )
  })
  ws.on('error', (error) => {
    // Refused before it connected: a name or token the hub doesn't know. Retrying won't help,
    // but joining again might, with a join token it has still (it stopped half way, before).
    if (/ 401$/.test(error.message)) {
      if (joinToken) {
        token = undefined
        ws.removeAllListeners('close')
        joinHub()
        return
      }
      // Just joined: the replica it reached may not have read its token yet. Its close retries.
      if (Date.now() - joinedAt < JOINING_MS) return
      stop('it doesn’t know this name and token')
    }
    // Otherwise its close follows, which retries.
    log(`Can’t reach the hub at ${origin}: ${error.message}`)
  })
}

/** The hub won't have it: retrying wouldn't help, and a failing pod says so. */
function stop(why: string): never {
  console.error(`The hub at ${origin} refused this agent: ${why}.`)
  process.exit(1)
}

function retry(why: string, again: () => void = dial): void {
  const wait = RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)]!
  attempts += 1
  log(`Connecting again in ${wait / 1000} s: ${why}`)
  setTimeout(again, wait)
}

if (healthPort > 0) {
  http
    .createServer((req, res) => {
      if (req.url !== '/healthz') {
        res.writeHead(404).end()
        return
      }
      // Ready only when the hub uses it: connected, and its cluster trusted.
      const ready = connected && trust !== undefined && 'trusted' in trust
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' })
      res.end(
        ready
          ? 'connected'
          : !connected
            ? 'not connected'
            : trust && 'refused' in trust
              ? `connected, but refused: ${trust.refused}`
              : 'connected, not yet trusted',
      )
    })
    .listen(healthPort)
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    socket.close(1001, 'The agent is stopping.')
    process.exit(0)
  })
}

log(`Lumovi ${version}’s agent for ${name}, relaying to ${apiHost}:${apiPort}`)
if (token) dial()
else joinHub()
