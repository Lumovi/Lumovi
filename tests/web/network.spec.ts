/**
 * A server on a company's network: its own connections (to clusters, the audit webhook)
 * through the proxy the environment says, but for what NO_PROXY leaves out; and certificate
 * authorities trusted besides Node's and the system's (a proxy that inspects HTTPS signs with
 * its own).
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer as createHttps } from 'node:https'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { generate } from 'selfsigned'
import { parse } from 'yaml'
import type { AuditInfo } from '../../src/shared/audit.ts'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { startMockProxy } from '../mock-proxy/server.ts'
import { as } from './fleet.ts'
import { expect, helmKubeconfigs, refusedConfig, test } from './fixtures.ts'

/** A webhook that takes events: over http, or https with its own certificate authority. */
async function receiver(tls?: { key: string; cert: string }) {
  const bodies: string[] = []
  const handle = (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => {
    let body = ''
    req.setEncoding('utf8').on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      bodies.push(body)
      res.writeHead(200).end()
    })
  }
  const server: Server = tls ? createHttps(tls, handle) : createServer(handle)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as AddressInfo).port,
    bodies,
    close: () =>
      new Promise((done) => {
        server.close(done)
        server.closeAllConnections()
      }),
  }
}

/** A certificate authority of a company's own, and a certificate it signed for localhost. */
async function ownCertificate() {
  const pems = await generate([{ name: 'commonName', value: 'Example Corp inspecting proxy' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 24 * 3600 * 1000),
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] },
    ],
  })
  return { key: pems.private, cert: pems.cert }
}

/** What the page says of where audit events go: the webhook's, by its place. */
const webhookProblem = (page: Page) =>
  page.evaluate(() => window.lumovi!.audit.info()).then((info: AuditInfo) => info.sinks[2]?.problem)

test('its own connections go through the proxy the environment says, but what NO_PROXY leaves out', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const proxy = await startMockProxy()
  const hook = await receiver()
  // The cluster by a name only the proxy knows; its certificate is checked for the one it has.
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-network-'))
  const kubeconfig = writeKubeconfig(dir, {
    currentContext: 'via-proxy',
    clusters: [
      {
        name: 'via-proxy',
        server: `https://cluster.test:${clusters.demo.port}`,
        caPem: clusters.demo.caPem,
        tlsServerName: 'localhost',
      },
    ],
    users: [{ name: 'demo', token: DEMO_TOKEN }],
    contexts: [{ name: 'via-proxy', cluster: 'via-proxy', user: 'demo' }],
  })
  const served = await serve({
    env: {
      KUBECONFIG: kubeconfig,
      LUMOVI_CONTEXT: 'via-proxy',
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_AUDIT_WEBHOOK_URL: `http://hooks.test:${hook.port}/in`,
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
    },
  })
  expect(served.log()).toContain(
    `Lumovi’s own connections go through the proxy ${proxy.url} for https and ${proxy.url} for http, except to localhost,127.0.0.1,::1,[::1].`,
  )
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}cluster/via-proxy/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  // Its pods, read from it.
  await expect(page.getByRole('row').nth(1)).toBeVisible()
  // The cluster, and the webhook: each through it.
  expect(proxy.seen).toContain(`CONNECT cluster.test:${clusters.demo.port}`)
  await expect.poll(() => hook.bodies.length).toBeGreaterThan(0)
  // Tunneled, or, as plain http, forwarded (as Node 26 does).
  expect(proxy.seen).toContainEqual(
    expect.stringMatching(
      new RegExp(`^(CONNECT hooks\\.test:${hook.port}|POST http://hooks\\.test:${hook.port}/in)$`),
    ),
  )
  // Helm, run for it, goes through it too: its kubeconfig says so.
  const rolledBack = await page.evaluate(() =>
    window.lumovi!.helm.rollback({
      context: 'via-proxy',
      namespace: 'shop',
      name: 'storefront',
      revision: 1,
    }),
  )
  expect(rolledBack).toMatchObject({ ok: true })
  const run = helmKubeconfigs(served).find((r) => r.args[0] === 'rollback')!
  expect(parse(run.kubeconfig).clusters[0].cluster).toMatchObject({
    server: `https://cluster.test:${clusters.demo.port}`,
    'tls-server-name': 'localhost',
    'proxy-url': proxy.url,
  })
  await served.stop()

  // What NO_PROXY leaves out is reached directly: a name no DNS knows can't be.
  const direct = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_AUDIT_WEBHOOK_URL: `http://hooks.test:${hook.port}/in`,
      HTTP_PROXY: proxy.url,
      NO_PROXY: '.test',
    },
  })
  const before = proxy.seen.length
  await page.goto(`${direct.url}audit`)
  await expect
    .poll(() => webhookProblem(page), { timeout: 15_000 })
    .toMatch(/^It can’t be reached: the connection failed \(ENOTFOUND\)\.$/)
  expect(proxy.seen.slice(before)).toEqual([])
  await direct.stop()
  // `*`: nothing through it, as Node only takes it alone.
  const none = await serve({
    env: {
      LUMOVI_AUTH: 'proxy',
      LUMOVI_AUDITORS: 'auditors',
      LUMOVI_AUDIT_WEBHOOK_URL: `http://hooks.test:${hook.port}/in`,
      HTTP_PROXY: proxy.url,
      NO_PROXY: '*',
    },
  })
  expect(none.log()).toContain('except to *.')
  const beforeAll = proxy.seen.length
  await page.goto(`${none.url}audit`)
  await expect
    .poll(() => webhookProblem(page), { timeout: 15_000 })
    .toMatch(/^It can’t be reached: the connection failed \(ENOTFOUND\)\.$/)
  expect(proxy.seen.slice(beforeAll)).toEqual([])
  await none.stop()
  await hook.close()
  await proxy.close()
})

test('a proxy that wants credentials: said, and given in its URL, never said back', async ({
  page,
  context,
  serve,
}) => {
  const proxy = await startMockProxy({ credentials: 'corp:s3cret' })
  const hook = await receiver()
  const env = {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDITORS: 'auditors',
    LUMOVI_AUDIT_WEBHOOK_URL: `http://hooks.test:${hook.port}/in`,
  }
  await as(context, 'alice@example.com', 'auditors')
  const refused = await serve({ env: { ...env, HTTP_PROXY: proxy.url } })
  await page.goto(`${refused.url}audit`)
  await expect
    .poll(() => webhookProblem(page), { timeout: 15_000 })
    .toBe(
      'It can’t be reached: The proxy needs credentials (407): give them in its URL, as http://user:password@host:port.',
    )
  await refused.stop()
  const taken = await serve({
    env: { ...env, HTTP_PROXY: proxy.url.replace('http://', 'http://corp:s3cret@') },
  })
  await expect.poll(() => hook.bodies.length).toBeGreaterThan(0)
  expect(taken.log()).toContain(`through the proxy ${proxy.url}/ for http`)
  expect(taken.log()).not.toContain('s3cret')
  await taken.stop()
  // Without a scheme, as curl and Go take it: http's, and who it goes as still never said.
  const bare = await serve({
    env: { ...env, HTTP_PROXY: proxy.url.replace('http://', 'corp:s3cret@') },
  })
  const before = hook.bodies.length
  await expect.poll(() => hook.bodies.length).toBeGreaterThan(before)
  expect(bare.log()).toContain(`through the proxy ${proxy.url}/ for http`)
  expect(bare.log()).not.toContain('s3cret')
  await bare.stop()
  await hook.close()
  await proxy.close()
})

test('a cluster behind a proxy that wants credentials says so', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const proxy = await startMockProxy({ credentials: 'corp:s3cret' })
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-network-')), {
    currentContext: 'via-proxy',
    clusters: [
      {
        name: 'via-proxy',
        server: `https://cluster.test:${clusters.demo.port}`,
        caPem: clusters.demo.caPem,
        tlsServerName: 'localhost',
      },
    ],
    users: [{ name: 'demo', token: DEMO_TOKEN }],
    contexts: [{ name: 'via-proxy', cluster: 'via-proxy', user: 'demo' }],
  })
  const served = await serve({
    env: {
      KUBECONFIG: kubeconfig,
      LUMOVI_CONTEXT: 'via-proxy',
      LUMOVI_AUTH: 'proxy',
      HTTPS_PROXY: proxy.url,
    },
  })
  await as(context, 'alice@example.com', 'auditors')
  await page.goto(`${served.url}cluster/via-proxy/pods`)
  await expect(page.getByRole('main')).toContainText(
    'The proxy needs credentials (407): give them in its URL, as http://user:password@host:port.',
  )
  await served.stop()
  await proxy.close()
})

test('a proxy that isn’t a URL: it doesn’t start, and says which, never what it was', async ({
  clusters,
}) => {
  const refused = await refusedConfig(clusters, { HTTPS_PROXY: 'http://corp:s3cret@[proxy' })
  expect(refused).toContain(
    'HTTPS_PROXY isn’t a proxy’s URL: give it as http://host:port (or https://).',
  )
  expect(refused).not.toContain('s3cret')
})

test('certificate authorities of its own, besides Node’s and the system’s', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const own = await ownCertificate()
  const hook = await receiver(own)
  const env = {
    LUMOVI_AUTH: 'proxy',
    LUMOVI_AUDITORS: 'auditors',
    LUMOVI_AUDIT_WEBHOOK_URL: `https://localhost:${hook.port}/in`,
  }
  await as(context, 'alice@example.com', 'auditors')
  // Signed by an authority nobody here trusts (as a proxy that inspects HTTPS signs): said why.
  const untrusted = await serve({ env })
  await page.goto(`${untrusted.url}audit`)
  await expect
    .poll(() => webhookProblem(page), { timeout: 15_000 })
    .toMatch(
      /^It can’t be reached: Its certificate isn’t signed by a certificate authority Lumovi trusts \(.+\)\. Behind a proxy that inspects HTTPS, its certificate authority must be trusted: in the system’s certificates, or LUMOVI_CA_FILE on a server/,
    )
  await untrusted.stop()
  // Trusted, from a file: taken.
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-ca-'))
  const caFile = join(dir, 'corp.pem')
  writeFileSync(caFile, `Example Corp's root\n${own.cert}`)
  const trusted = await serve({ env: { ...env, LUMOVI_CA_FILE: caFile } })
  expect(trusted.log()).toContain(`Lumovi trusts 1 more certificate authority, from ${caFile}.`)
  await expect.poll(() => hook.bodies.length).toBeGreaterThan(0)
  await trusted.stop()
  await hook.close()
  // A file that isn't one, or isn't there: it doesn't start, and says which.
  const empty = join(dir, 'empty.pem')
  writeFileSync(empty, 'nothing here\n')
  expect(await refusedConfig(clusters, { LUMOVI_CA_FILE: empty })).toContain(
    `${empty} has no certificates in it (PEM, as -----BEGIN CERTIFICATE-----).`,
  )
  expect(await refusedConfig(clusters, { LUMOVI_CA_FILE: join(dir, 'gone.pem') })).toContain(
    `The certificate authorities in ${join(dir, 'gone.pem')} can’t be read: ENOENT`,
  )
})
