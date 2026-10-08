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
 * LUMOVI_AGENT_HEALTH_PORT  where GET /healthz says whether it's connected (8081; 0: nowhere)
 * LUMOVI_CA_FILE       certificate authorities to trust as well (a proxy's that inspects HTTPS)
 * HTTPS_PROXY, HTTP_PROXY, NO_PROXY   the proxy it reaches the hub through
 */
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { connect } from 'node:net'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { version } from '../../package.json'
import { setUpNetwork, tunnelingAgent, type Network } from '@backend/network'
import { log } from './log'
import { AGENT_REPLACED } from './fleet/agents'
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
const token = required('LUMOVI_AGENT_TOKEN')
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
let attempts = 0
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
        // Refused: the hub doesn't trust the certificate authority it sent (until an admin does).
        if (said.type === 'refused') {
          log(`The hub doesn’t trust this cluster: ${said.message}`)
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
    if (code === AGENT_REPLACED) {
      stop('another agent connected as it (do two clusters use the same name and token?)')
    }
    retry(
      opened
        ? `the connection closed (${code}${reason.length > 0 ? `: ${reason}` : ''})`
        : 'it couldn’t connect',
    )
  })
  ws.on('error', (error) => {
    // Refused before it connected: a name or token the hub doesn't know. Retrying won't help.
    if (/ 401$/.test(error.message)) stop('it doesn’t know this name and token')
    // Otherwise its close follows, which retries.
    log(`Can’t reach the hub at ${origin}: ${error.message}`)
  })
}

/** The hub won't have it: retrying wouldn't help, and a failing pod says so. */
function stop(why: string): never {
  console.error(`The hub at ${origin} refused this agent: ${why}.`)
  process.exit(1)
}

function retry(why: string): void {
  const wait = RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)]!
  attempts += 1
  log(`Connecting again in ${wait / 1000} s: ${why}`)
  setTimeout(dial, wait)
}

if (healthPort > 0) {
  http
    .createServer((req, res) => {
      if (req.url !== '/healthz') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(connected ? 200 : 503, { 'Content-Type': 'text/plain' })
      res.end(connected ? 'connected' : 'not connected')
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
dial()
