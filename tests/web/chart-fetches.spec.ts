/**
 * Where a server fetches charts from (LMV-356): from a public address alone, and the one it
 * checked. Each name is resolved once for the connection, every address it gives is checked, and
 * the connection goes there and nowhere else; a chart from a repository, a registry or a URL is
 * fetched by Lumovi, never by helm, which gets the file.
 *
 * The names here resolve as LUMOVI_TEST_HOSTS says, an answer each time they're resolved: as a
 * name whose answers change would. Its public address is this computer's 127.0.0.1 (counted as
 * public, LUMOVI_TEST_PUBLIC_ADDRESSES), where the charts are; its private one is ::1, on the same
 * port, where something inside the network listens, and must hear nothing.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { generate } from 'selfsigned'
import type { ChartSource } from '../../src/shared/api.ts'
import { expect, PEOPLE, signIn, test, type Served, type ServeOptions } from './fixtures.ts'

const CHART = gzipSync(Buffer.from('demo'))
const DIGEST = createHash('sha256').update(CHART).digest('hex')
const LAYER = 'application/vnd.cncf.helm.chart.content.v1.tar+gzip'
const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  layers: [{ mediaType: LAYER, digest: `sha256:${DIGEST}`, size: CHART.length }],
})

const refused = (host: string) =>
  `Lumovi doesn’t fetch charts from ${host}: it’s in a private network. An administrator can allow that with LUMOVI_ALLOW_PRIVATE_CHARTS.`

/** Every name the tests resolve: the charts' certificate is for each (never for an address). */
const NAMES = ['charts', 'turns', 'after', 'both', 'registry', 'file', 'inside'].map(
  (name) => `${name}.example.test`,
)

/**
 * The charts, on 127.0.0.1, over https: a repository (its index, and a redirect to elsewhere), a
 * registry, and a chart at a URL. And on ::1, at the same port, what's inside the network: each
 * connection it had.
 */
async function charts() {
  const pems = await generate([{ name: 'commonName', value: 'lumovi-test-charts' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: NAMES.map((value) => ({ type: 2, value })) },
    ],
  })
  const ca = join(mkdtempSync(join(tmpdir(), 'lumovi-charts-ca-')), 'ca.pem')
  writeFileSync(ca, pems.cert)
  const heard: string[] = []
  const repository = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const at = req.url ?? ''
    if (at === '/charts/index.yaml') {
      return void res.end(
        JSON.stringify({
          entries: {
            demo: [
              { version: '2.0.0-rc.1', urls: ['demo-2.0.0-rc.1.tgz'], digest: DIGEST },
              { version: '1.0.0', urls: ['demo-1.0.0.tgz'], digest: DIGEST },
            ],
          },
        }),
      )
    }
    if (at === '/charts/demo-1.0.0.tgz' || at === '/demo-1.0.0.tgz') return void res.end(CHART)
    // An index kept compressed, as an object store may serve one.
    if (at === '/packed/index.yaml') {
      return void res
        .writeHead(200, { 'content-encoding': 'gzip' })
        .end(gzipSync(JSON.stringify({ entries: { demo: [{ version: '3.0.0' }] } })))
    }
    if (at === '/moved/index.yaml') {
      const port = (repository.address() as AddressInfo).port
      return void res
        .writeHead(302, { location: `https://inside.example.test:${port}/charts/index.yaml` })
        .end()
    }
    if (at === '/v2/charts/demo/tags/list') return void res.end('{"tags":["1.0.0"]}')
    if (at === '/v2/charts/demo/manifests/1.0.0') {
      return void res
        .writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' })
        .end(MANIFEST)
    }
    if (at === `/v2/charts/demo/blobs/sha256:${DIGEST}`) return void res.end(CHART)
    res.writeHead(404).end()
  })
  await new Promise<void>((done) => repository.listen(0, '127.0.0.1', done))
  const port = (repository.address() as AddressInfo).port
  const inside = createServer((socket) => {
    heard.push(`a connection from ${socket.remoteAddress}`)
    socket.destroy()
  })
  await new Promise<void>((done) => inside.listen({ port, host: '::1', ipv6Only: true }, done))
  return {
    port,
    ca,
    heard,
    close: () =>
      Promise.all([repository, inside].map((server) => new Promise((done) => server.close(done)))),
  }
}

/** A server that checks where charts come from, the names resolving as `hosts` says. */
async function serving(
  serve: (options?: ServeOptions) => Promise<Served>,
  ca: string,
  hosts: Record<string, string[][]>,
) {
  const file = join(mkdtempSync(join(tmpdir(), 'lumovi-hosts-')), 'hosts.json')
  writeFileSync(file, JSON.stringify(hosts))
  return serve({
    env: {
      LUMOVI_ALLOW_PRIVATE_CHARTS: undefined,
      LUMOVI_TEST_HOSTS: file,
      LUMOVI_TEST_PUBLIC_ADDRESSES: '127.0.0.1',
      NODE_EXTRA_CA_CERTS: ca,
    },
  })
}

const PUBLIC = ['127.0.0.1']
const PRIVATE = ['::1']

const versions = (page: Page, repository: string) =>
  page.evaluate(async (repository) => {
    const answer = await window.lumovi!.helm.versions(repository, 'demo')
    return answer.ok ? answer.data : answer.error.message
  }, repository)

const defaults = (page: Page, source: ChartSource) =>
  page.evaluate(async (source) => {
    const answer = await window.lumovi!.helm.defaults(source)
    return answer.ok ? answer.data : answer.error.message
  }, source)

/** How helm was run: each run's arguments. */
const runs = (served: Served) =>
  (existsSync(join(served.helmDir, 'calls.jsonl'))
    ? readFileSync(join(served.helmDir, 'calls.jsonl'), 'utf8')
    : ''
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])

test('a server fetches each chart itself, from the address it checked, and helm gets the file', async ({
  page,
  serve,
}) => {
  const at = await charts()
  try {
    const served = await serving(serve, at.ca, { 'charts.example.test': [PUBLIC] })
    await signIn(page, `${served.url}cluster/demo/helm`, PEOPLE.alice.token)
    const repository = `https://charts.example.test:${at.port}/charts`
    expect(await versions(page, repository)).toEqual(['2.0.0-rc.1', '1.0.0'])
    expect(await versions(page, `https://charts.example.test:${at.port}/packed`)).toEqual(['3.0.0'])
    // Without a version: the newest that isn't a pre-release, as helm would choose.
    expect(await defaults(page, { chart: 'demo', repository })).toContain('replicaCount: 1')
    // From a registry, and from a URL.
    expect(
      await defaults(page, { chart: `oci://charts.example.test:${at.port}/charts/demo` }),
    ).toContain('replicaCount: 1')
    expect(
      await defaults(page, { chart: `https://charts.example.test:${at.port}/demo-1.0.0.tgz` }),
    ).toContain('replicaCount: 1')
    const installed = await page.evaluate(async (repository) => {
      const answer = await window.lumovi!.helm.deploy({
        context: 'demo',
        namespace: 'default',
        name: 'demo',
        source: { chart: 'demo', repository, version: '1.0.0' },
        values: '',
        install: true,
        dryRun: true,
      })
      return answer.ok
    }, repository)
    expect(installed).toBe(true)
    // Helm got a file each time, never an address to fetch from.
    const charted = runs(served).filter((args) => ['show', 'install'].includes(args[0]!))
    expect(charted.map((args) => args[0])).toEqual(['show', 'show', 'show', 'install'])
    for (const args of charted) {
      expect(args.join(' ')).not.toMatch(/--repo|--version|http:|oci:/)
      expect(args[2]).toMatch(/[/\\](demo-1\.0\.0|chart-given)\.tgz$/)
    }
    expect(at.heard).toEqual([])
  } finally {
    await at.close()
  }
})

test('a name that answers public, then private, is refused, and nothing reaches the private address', async ({
  page,
  serve,
}) => {
  const at = await charts()
  try {
    // Each read of an index resolves its name three times: the request's check, the fetch's,
    // and the fetch's own, which it connects by.
    const served = await serving(serve, at.ca, {
      // Public to both checks, private as it's connected to: refused, nothing sent.
      'turns.example.test': [PUBLIC, PUBLIC, PRIVATE],
      // Public to the checks and the connection, private after: it goes where it was checked.
      'after.example.test': [PUBLIC, PUBLIC, PUBLIC, PRIVATE],
      // Public and private at once: refused.
      'both.example.test': [[...PUBLIC, ...PRIVATE]],
      // A registry's, and a URL's: public to the request's check, private after.
      'registry.example.test': [PUBLIC, PRIVATE],
      'file.example.test': [PUBLIC, PRIVATE],
      'charts.example.test': [PUBLIC],
      'inside.example.test': [PRIVATE],
      // An IPv6 cluster's way out to IPv4 (NAT64), to a cloud's metadata endpoint.
      'nat64.example.test': [['64:ff9b::a9fe:a9fe']],
    })
    await signIn(page, `${served.url}cluster/demo/helm`, PEOPLE.alice.token)
    const port = at.port
    expect(await versions(page, `https://turns.example.test:${port}/charts`)).toBe(
      `Couldn’t reach turns.example.test:${port}: ${refused('turns.example.test')}`,
    )
    expect(await versions(page, `https://after.example.test:${port}/charts`)).toEqual([
      '2.0.0-rc.1',
      '1.0.0',
    ])
    expect(await versions(page, `https://both.example.test:${port}/charts`)).toBe(
      refused('both.example.test'),
    )
    // NAT64 to a private IPv4 address, by name or as it is.
    expect(await versions(page, `https://nat64.example.test:${port}/charts`)).toBe(
      refused('nat64.example.test'),
    )
    expect(await versions(page, `https://[64:ff9b::169.254.169.254]:${port}/charts`)).toBe(
      refused('64:ff9b::a9fe:a9fe'),
    )
    // NAT64's local-use prefix, whatever it carries.
    expect(await versions(page, `https://[64:ff9b:1::808:808]:${port}/charts`)).toBe(
      refused('64:ff9b:1::808:808'),
    )
    // 6to4 to one, and addresses kept for other uses.
    expect(await versions(page, `https://[2002:a9fe:a9fe::]:${port}/charts`)).toBe(
      refused('2002:a9fe:a9fe::'),
    )
    expect(await versions(page, `https://240.0.0.1:${port}/charts`)).toBe(refused('240.0.0.1'))
    // A redirect to a private address: checked as the first address is.
    expect(await versions(page, `https://charts.example.test:${port}/moved`)).toBe(
      refused('inside.example.test'),
    )
    expect(await defaults(page, { chart: `oci://registry.example.test:${port}/charts/demo` })).toBe(
      refused('registry.example.test'),
    )
    expect(
      await defaults(page, { chart: `https://file.example.test:${port}/demo-1.0.0.tgz` }),
    ).toBe(refused('file.example.test'))
    // Nothing reached the address inside, and helm was given nothing to fetch.
    expect(at.heard).toEqual([])
    expect(runs(served).filter((args) => args[0] === 'show')).toEqual([])
  } finally {
    await at.close()
  }
})
