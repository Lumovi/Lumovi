/**
 * The network Lumovi's own connections go out through, as a company's has it:
 *
 * - Certificate authorities: Node's own, the operating system's (where a company installs the
 *   one its HTTPS-inspecting proxy signs with), and any in files it's given.
 * - A proxy, from HTTPS_PROXY, HTTP_PROXY and NO_PROXY, as kubectl and helm take them: for
 *   single sign-on, Helm repositories, the audit webhook, a fleet agent's hub, and clusters
 *   whose kubeconfig doesn't name one (its proxy-url) and NO_PROXY doesn't leave out. Loopback
 *   is never proxied. NO_PROXY is read as Node's fetch reads it, for all of them alike: names
 *   and what's under them, addresses, each with a port or for any; not ranges (CIDR).
 *
 * Set up once, as Lumovi starts, before it connects anywhere.
 */
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tls from 'node:tls'
import type { Cluster } from '@kubernetes/client-node'
import { proxyRefused, proxyRefusal, TLS_ERROR, tlsReason } from './kube/errors'

/**
 * Never through a proxy: this computer (Lumovi's own MCP bridge, a fleet agent's port). IPv6's
 * both ways, as Node 24's fetch only takes it in brackets.
 */
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]']

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

export interface NetworkOptions {
  /** Files of PEM certificate authorities to trust as well (a company's own). */
  caFiles?: string[]
  /** Never through the proxy, besides NO_PROXY and loopback (the in-cluster API server, say). */
  direct?: string[]
  /**
   * Whether what it runs (helm, credential plugins) trusts them too, by a bundle of them in
   * SSL_CERT_FILE (written to the temporary folder): true unless it runs nothing.
   */
  children?: boolean
  /**
   * Told what can't be used (a certificate authority's file, a proxy that isn't a URL), which
   * is then left out: the rest is set up. Without it, that's thrown.
   */
  problem?: (message: string) => void
}

export interface Network {
  /** The proxy a URL goes through, if it goes through one. */
  proxyFor(url: string): string | undefined
  /** What it's set up with, to say as Lumovi starts: a sentence each. */
  said: string[]
}

/** Sets up Lumovi's connections (and its children's: helm's, credential plugins'). */
export function setUpNetwork(env: NodeJS.ProcessEnv, options: NetworkOptions = {}): Network {
  const said: string[] = []
  const problem =
    options.problem ??
    ((message: string) => {
      throw new Error(message)
    })
  // Certificate authorities: Node's own (and NODE_EXTRA_CA_CERTS'), the system's, and extra.
  const files: string[] = []
  const extra = (options.caFiles ?? []).flatMap((file) => {
    try {
      const found = certificatesIn(file)
      files.push(file)
      return found
    } catch (error) {
      problem((error as Error).message)
      return []
    }
  })
  const trusted = [
    ...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system'), ...extra]),
  ]
  tls.setDefaultCACertificates(trusted)
  if (extra.length > 0) {
    said.push(
      `Lumovi trusts ${extra.length} more certificate ${extra.length === 1 ? 'authority' : 'authorities'}, from ${files.join(', ')}.`,
    )
    // Helm and credential plugins (Go, Python) trust them too, unless told otherwise already.
    if (options.children !== false && !env.SSL_CERT_FILE) {
      // In a folder of its own, which only this user may open: another can't put theirs first.
      // Gone when Lumovi is.
      const folder = mkdtempSync(join(tmpdir(), 'lumovi-ca-'))
      process.once('exit', () => rmSync(folder, { recursive: true, force: true }))
      const bundle = join(folder, 'ca.pem')
      writeFileSync(bundle, `${trusted.join('\n')}\n`, { mode: 0o600, flag: 'wx' })
      env.SSL_CERT_FILE = bundle
    }
  }
  // The proxy: what NO_PROXY leaves out, loopback, and what's always reached directly aren't.
  // One without a scheme is http's, as curl and Go take it; one that isn't a URL isn't used.
  for (const name of PROXY_VARIABLES) {
    const given = env[name]
    if (!given) continue
    const url = /^[a-z][a-z\d+.-]*:\/\//i.test(given) ? given : `http://${given}`
    if (URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)) {
      env[name] = url
    } else {
      delete env[name]
      problem(`${name} isn’t a proxy’s URL: give it as http://host:port (or https://).`)
    }
  }
  const proxies = proxiesIn(env)
  if (proxies.https || proxies.http) {
    // Everything, as Node only takes it: alone.
    const noProxy = noProxyIn(env)
      .split(/[\s,]+/)
      .includes('*')
      ? '*'
      : [noProxyIn(env), ...LOOPBACK, ...(options.direct ?? [])].filter(Boolean).join(',')
    // Children (helm, plugins) read either spelling.
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
    http.setGlobalProxyFromEnv({
      HTTP_PROXY: proxies.http,
      HTTPS_PROXY: proxies.https,
      NO_PROXY: noProxy,
    })
    const named = [
      proxies.https && `${withoutCredentials(proxies.https)} for https`,
      proxies.http && `${withoutCredentials(proxies.http)} for http`,
    ]
    said.push(
      `Lumovi’s own connections go through the proxy ${named.filter(Boolean).join(' and ')}, except to ${noProxy}.`,
    )
  }
  return {
    proxyFor: (url) => proxyFor(url, env),
    said,
  }
}

/** The certificates in a PEM file: none there is a mistake worth stopping for. */
function certificatesIn(file: string): string[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(
      `The certificate authorities in ${file} can’t be read: ${(error as Error).message}`,
      {
        cause: error,
      },
    )
  }
  const found = text.match(PEM) ?? []
  if (found.length === 0) {
    throw new Error(`${file} has no certificates in it (PEM, as -----BEGIN CERTIFICATE-----).`)
  }
  found.forEach((pem, i) => {
    try {
      new X509Certificate(pem)
    } catch (error) {
      throw new Error(
        `The certificate authorities in ${file} can’t be read: its certificate ${i + 1} isn’t one (${(error as Error).message}).`,
        { cause: error },
      )
    }
  })
  return found.map((pem) => `${pem}\n`)
}

/** Where the environment names proxies, in either spelling. */
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

/** The proxies the environment names, in either spelling (the upper case first, as curl has it). */
function proxiesIn(env: NodeJS.ProcessEnv): { https?: string; http?: string } {
  const named = (name: string) => env[name] || env[name.toLowerCase()] || undefined
  return { https: named('HTTPS_PROXY'), http: named('HTTP_PROXY') }
}

const noProxyIn = (env: NodeJS.ProcessEnv) => env.NO_PROXY || env.no_proxy || ''

/** A proxy's URL as it's said: who it goes as left out, however it's written. */
export function withoutCredentials(url: string): string {
  if (!URL.canParse(url) || !url.includes('://')) {
    return url.replace(/^([a-z][a-z\d+.-]*:\/\/)?[^/@]*@/i, '$1')
  }
  const parsed = new URL(url)
  if (!parsed.username && !parsed.password) return url
  parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

/** The proxy a URL goes through, as the environment says, if it goes through one. */
export function proxyFor(url: string, env: NodeJS.ProcessEnv): string | undefined {
  // What isn't a URL (a kubeconfig can say anything) goes nowhere, let alone through a proxy.
  if (!URL.canParse(url)) return undefined
  const target = new URL(url)
  const proxies = proxiesIn(env)
  const proxy =
    target.protocol === 'https:' || target.protocol === 'wss:' ? proxies.https : proxies.http
  if (!proxy) return undefined
  const host = target.hostname.replace(/^\[|\]$/g, '')
  const port =
    target.port || (target.protocol === 'https:' || target.protocol === 'wss:' ? '443' : '80')
  return bypassed(host, port, [noProxyIn(env), ...LOOPBACK].join(',')) ? undefined : proxy
}

/**
 * Whether NO_PROXY leaves a host out, as Node's fetch reads it (so everything Lumovi connects
 * to goes the same way): `*` for all; a name for it and what's under it (`example.com`,
 * `.example.com`, `*.example.com`); an address; each with a port, or for any. Not ranges.
 */
export function bypassed(host: string, port: string, noProxy: string): boolean {
  const name = host.toLowerCase()
  return noProxy
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true
      const [ruleHost, rulePort] = hostAndPort(entry.toLowerCase())
      if (rulePort && rulePort !== port) return false
      const domain = ruleHost.replace(/^\*?\./, '')
      return name === domain || name.endsWith(`.${domain}`)
    })
}

/** A NO_PROXY entry's host, and its port if it has one: `host:8080`, `[::1]:8080`, `::1`. */
function hostAndPort(entry: string): [string, string | undefined] {
  const bracketed = /^\[(.+)\](?::(\d+))?$/.exec(entry)
  if (bracketed) return [bracketed[1]!, bracketed[2]]
  if (isIP(entry) === 6) return [entry, undefined]
  const withPort = /^(.+):(\d+)$/.exec(entry)
  return withPort ? [withPort[1]!, withPort[2]] : [entry, undefined]
}

/**
 * A cluster as Lumovi reaches it: through the proxy the environment says, as kubectl would,
 * when its kubeconfig names none.
 */
export function withProxy(cluster: Cluster, env: NodeJS.ProcessEnv): Cluster {
  if (cluster.proxyUrl) return cluster
  const proxy = proxyFor(cluster.server, env)
  return proxy ? { ...cluster, proxyUrl: proxy } : cluster
}

/**
 * An agent whose connections go through a proxy's tunnel (CONNECT), with TLS over it for
 * `secure` ones: for what picks its own connection (a WebSocket), which the global proxy
 * doesn't reach.
 */
export function tunnelingAgent(proxy: string, secure: boolean): http.Agent {
  const via = new URL(proxy)
  const through = via.protocol === 'https:' ? https : http
  // Who it goes as, if anyone: in the URL, as curl takes it.
  const credentials =
    via.username &&
    `Basic ${Buffer.from(`${decodeURIComponent(via.username)}:${decodeURIComponent(via.password)}`).toString('base64')}`
  const Base = secure ? https.Agent : http.Agent
  class Tunneling extends Base {
    override createConnection(
      options: tls.ConnectionOptions & { host?: string; port?: number },
      done: (error: Error | null, socket?: Duplex) => void,
    ): undefined {
      const target = `${options.host}:${options.port}`
      const tunnel = through.request({
        host: via.hostname,
        port: via.port || (via.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT',
        path: target,
        headers: { host: target, ...(credentials ? { 'proxy-authorization': credentials } : {}) },
        agent: false,
      })
      tunnel.once('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          done(new Error(proxyRefusal(response.statusCode, withoutCredentials(proxy), target)))
          return
        }
        done(null, secure ? tls.connect({ ...options, socket }) : socket)
      })
      tunnel.once('error', (error) => done(error))
      tunnel.end()
      return undefined
    }
  }
  return new Tunneling({ keepAlive: false })
}

/** A fetch's errors, a cause in each cause, the outermost first. */
function causes(error: unknown): { message: string; code?: unknown }[] {
  const chain: { message: string; code?: unknown }[] = []
  for (let at = error as { cause?: unknown } | undefined; at && chain.length < 6;) {
    chain.push(at as { message: string; code?: unknown })
    at = at.cause as typeof at
  }
  return chain
}

/**
 * Whether a fetch failed for its network's sake, and how that's said: a certificate (and
 * what usually makes that so), or a proxy's refusal (credentials it wants, say).
 */
export function networkFailure(error: unknown): string | undefined {
  const chain = causes(error)
  const tls = chain.find((e) => typeof e.code === 'string' && TLS_ERROR.test(e.code))
  if (tls) return tlsReason(tls.code as string, tls.message)
  const refused = chain.map((e) => proxyRefused(e.message)).find(Boolean)
  return refused ? proxyRefusal(refused) : undefined
}

/** Why a fetch failed: its network's sake, or the deepest error it hides. */
export function fetchFailure(error: unknown): string {
  const deepest = causes(error).at(-1)!
  const code = typeof deepest.code === 'string' ? deepest.code : undefined
  return (
    networkFailure(error) ??
    (code && !deepest.message.includes(code) ? `${deepest.message} (${code})` : deepest.message)
  )
}
