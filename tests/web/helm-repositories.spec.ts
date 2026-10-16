/**
 * The chart repositories Lumovi keeps (src/backend/helm/repositories.ts), against a repository
 * and a registry of the test's own over https: a sign-in goes only to its repository's origin and
 * path, and never on a redirect elsewhere; what's fetched is bounded and checked against its
 * digest before Helm gets it; an index's YAML has no aliases; a registry's token is asked with the
 * sign-in and sent only to it. And which release says Update available (src/shared/...).
 */
import { createHash, randomBytes } from 'node:crypto'
import { statSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { generate } from 'selfsigned'
import type { HelmRelease, HelmRepository, RepositoryChart } from '../../src/shared/api.ts'
import {
  addressOf,
  compareChartVersions,
  releaseUpdate,
  sameOrigin,
} from '../../src/shared/helm-repositories.ts'
import {
  ChartRepositories,
  realmTakesSignIn,
  recordOf,
  type KeptRepository,
  type RepositoryChange,
  type RepositoryKeeper,
} from '../../src/backend/helm/repositories.ts'
import { DesktopRepositories, NO_KEYCHAIN } from '../../src/main/helm-repositories.ts'
import { ServerRepositories } from '../../src/server/helm-repositories.ts'
import { ServerState } from '../../src/server/state.ts'

/** Never a real secret: what the test types as one, to look for where it mustn't be. */
const SECRET = 'not-a-real-password-7c1f'
const BASIC = `Basic ${Buffer.from(`anna:${SECRET}`).toString('base64')}`
const TOKEN = 'registry-token-3a9e'

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const CHART = gzipSync(Buffer.from('a chart, as far as this test cares'))
const OTHER = gzipSync(Buffer.from('another chart'))

interface Asked {
  host: string
  path: string
  authorization?: string
}

let server: https.Server
let port = 0
let ca = ''
const asked: Asked[] = []
/** What a path answers: status, headers and body; or a function of the request. */
let routes: Record<
  string,
  (auth?: string) => { status?: number; headers?: Record<string, string>; body?: string | Buffer }
> = {}

test.beforeAll(async () => {
  const pems = await generate([{ name: 'commonName', value: 'lumovi-test-charts' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  })
  ca = pems.cert
  server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const url = new URL(req.url!, `https://${req.headers.host}`)
    asked.push({
      host: req.headers.host!,
      path: url.pathname,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    })
    const route =
      routes[`${req.headers.host!.startsWith('localhost') ? 'localhost' : 'ip'}${url.pathname}`] ??
      routes[url.pathname]
    const answer = route?.(req.headers.authorization) ?? { status: 404 }
    res.writeHead(answer.status ?? 200, answer.headers ?? {})
    res.end(answer.body ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

test.afterAll(() => server.close())
test.beforeEach(() => {
  asked.length = 0
  routes = {}
})

/**
 * A fetch that trusts the test's own authority, as Lumovi's network trusts a company's: with
 * nothing global changed (another spec in this worker may set Node's authorities as it likes).
 */
const trusting: typeof globalThis.fetch = (input, init) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      input instanceof URL ? input : new URL(String(input)),
      {
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        ca,
        signal: init?.signal ?? undefined,
      },
      (res) =>
        resolve(
          new Response(Readable.toWeb(res) as ReadableStream, {
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: Object.entries(res.headers).flatMap(([k, v]) =>
              v === undefined
                ? []
                : (Array.isArray(v) ? v : [v]).map((one) => [k, one] as [string, string]),
            ),
          }),
        ),
    )
    request.on('error', reject)
    request.end()
  })

const at = (path: string) => `https://127.0.0.1:${port}${path}`
const elsewhere = (path: string) => `https://localhost:${port}${path}`

/** A keeper in memory, as the desktop's file and keychain or a server's state would keep it. */
function memory(noSignIns?: string) {
  const kept = new Map<string, KeptRepository & { secret?: string }>()
  const keeper: RepositoryKeeper = {
    kept: 'computer',
    noSignIns: () => noSignIns,
    list: async () => [...kept.values()].map(({ secret: _s, ...r }) => r),
    put: async (repository, secret) => {
      const before = kept.get(repository.id)?.secret
      const sealed =
        repository.username === undefined || secret === null ? undefined : (secret ?? before)
      kept.set(repository.id, { ...repository, ...(sealed ? { secret: sealed } : {}) })
    },
    remove: async (id) => void kept.delete(id),
    secret: async (id) => kept.get(id)?.secret,
  }
  return { keeper, kept }
}

function repositories(options: { mayChange?: boolean; noSignIns?: string } = {}) {
  const { keeper, kept } = memory(options.noSignIns)
  const changes: RepositoryChange[] = []
  const service = new ChartRepositories({
    fetch: trusting,
    keeper,
    person: {
      mayChange: () => options.mayChange ?? true,
      admins: () => ['anna', 'peter'],
      record: (change) => changes.push(change),
    },
  })
  return { service, kept, changes }
}

const index = (entries: Record<string, object[]>) => ({
  headers: { 'content-type': 'application/x-yaml' },
  body: JSON.stringify({ apiVersion: 'v1', entries }),
})

/** A repository that answers only with the sign-in, whose chart is listed by its digest. */
function signedRepository() {
  routes['/charts/index.yaml'] = (auth) =>
    auth === BASIC
      ? index({
          demo: [
            {
              version: '1.2.0',
              appVersion: '1.2',
              urls: ['demo-1.2.0.tgz'],
              digest: sha256(CHART),
              home: 'https://demo.example',
            },
            {
              version: '1.10.0',
              appVersion: '1.10',
              urls: ['demo-1.10.0.tgz'],
              digest: sha256(CHART),
            },
            { version: '2.0.0-rc.1', urls: ['demo-2.0.0-rc.1.tgz'], digest: sha256(CHART) },
          ],
          // Its file elsewhere (another origin), as a GitHub release's is.
          other: [
            {
              version: '1.0.0',
              urls: [elsewhere('/files/other-1.0.0.tgz')],
              digest: sha256(OTHER),
            },
          ],
          tampered: [{ version: '1.0.0', urls: ['tampered-1.0.0.tgz'], digest: sha256(OTHER) }],
          undigested: [{ version: '1.0.0', urls: ['demo-1.2.0.tgz'] }],
        })
      : { status: 401, body: 'who are you' }
  routes['/charts/demo-1.10.0.tgz'] = (auth) => (auth === BASIC ? { body: CHART } : { status: 401 })
  routes['/charts/tampered-1.0.0.tgz'] = () => ({ body: CHART })
  routes['/charts/demo-1.2.0.tgz'] = () => ({ body: CHART })
  routes['/files/other-1.0.0.tgz'] = () => ({ body: OTHER })
}

test('an index is read with the sign-in, sent to its repository alone; a chart elsewhere is fetched without it', async () => {
  signedRepository()
  const { service, changes } = repositories()
  const saved = await service.save({
    name: 'acme-charts',
    kind: 'http',
    url: at('/charts'),
    signIn: { username: 'anna', secret: SECRET },
  })
  expect(saved.ok).toBe(true)
  if (!saved.ok) return
  const [repository] = saved.data.repositories
  expect(repository).toMatchObject({ name: 'acme-charts', username: 'anna', read: { charts: 4 } })
  // Newest first, as Semantic Versioning orders them (1.10.0 after 1.2.0).
  const demo = saved.data.charts.find((c) => c.name === 'demo')!
  expect(demo.versions.map((v) => v.version)).toEqual(['2.0.0-rc.1', '1.10.0', '1.2.0'])
  // Nothing the page gets holds the secret.
  expect(JSON.stringify(saved.data)).not.toContain(SECRET)
  // What's recorded says a sign-in was set, never what it is.
  expect(changes).toEqual([expect.objectContaining({ action: 'added', signIn: 'set' })])
  expect(JSON.stringify(recordOf(changes[0]!))).not.toContain(SECRET)

  const fetched = await service.fetchChart(repository!.id, 'demo', '1.10.0')
  expect(readFileSync(fetched.file).equals(CHART)).toBe(true)
  // In a folder only Lumovi's account opens, removed when Helm is done.
  if (process.platform !== 'win32') expect(statSync(dirname(fetched.file)).mode & 0o777).toBe(0o700)
  await fetched.done()
  expect(existsSync(dirname(fetched.file))).toBe(false)

  const other = await service.fetchChart(repository!.id, 'other', '1.0.0')
  await other.done()
  const auth = (host: string, path: string) =>
    asked.filter((a) => a.host.startsWith(host) && a.path === path).map((a) => a.authorization)
  expect(auth('127.0.0.1', '/charts/demo-1.10.0.tgz')).toEqual([BASIC])
  // Another origin never gets it.
  expect(auth('localhost', '/files/other-1.0.0.tgz')).toEqual([undefined])
})

test('a chart that isn’t the one its index lists, or has no digest to check, never reaches Helm', async () => {
  signedRepository()
  const { service } = repositories()
  const saved = await service.save({
    name: 'acme-charts',
    kind: 'http',
    url: at('/charts'),
    signIn: { username: 'anna', secret: SECRET },
  })
  const id = saved.ok ? saved.data.repositories[0]!.id : ''
  await expect(service.fetchChart(id, 'tampered', '1.0.0')).rejects.toThrow(
    'The chart Lumovi fetched isn’t the one its repository lists.',
  )
  await expect(service.fetchChart(id, 'undigested', '1.0.0')).rejects.toThrow(/lists no digest/)
  await expect(service.fetchChart(id, 'demo', '9.9.9')).rejects.toThrow(
    'acme-charts has no demo 9.9.9.',
  )
})

test('a redirect elsewhere is followed without the sign-in, even to the same path', async () => {
  routes['ip/charts/index.yaml'] = () => ({
    status: 302,
    headers: { location: elsewhere('/charts/index.yaml') },
  })
  routes['localhost/charts/index.yaml'] = () => index({})
  const { service } = repositories()
  const saved = await service.save({
    name: 'moved',
    kind: 'http',
    url: at('/charts'),
    signIn: { username: 'anna', secret: SECRET },
  })
  expect(saved.ok && saved.data.repositories[0]!.read).toMatchObject({ charts: 0 })
  expect(asked.map((a) => [a.host.split(':')[0], a.path, a.authorization])).toEqual([
    ['127.0.0.1', '/charts/index.yaml', BASIC],
    ['localhost', '/charts/index.yaml', undefined],
  ])
})

test('a sign-in goes under its repository’s path alone, not to the rest of its host', async () => {
  routes['/team-a/index.yaml'] = () =>
    index({ demo: [{ version: '1.0.0', urls: ['/team-b/demo-1.0.0.tgz'], digest: sha256(CHART) }] })
  routes['/team-b/demo-1.0.0.tgz'] = () => ({ body: CHART })
  const { service } = repositories()
  const saved = await service.save({
    name: 'team-a',
    kind: 'http',
    url: at('/team-a'),
    signIn: { username: 'anna', secret: SECRET },
  })
  const fetched = await service.fetchChart(
    saved.ok ? saved.data.repositories[0]!.id : '',
    'demo',
    '1.0.0',
  )
  await fetched.done()
  expect(asked.find((a) => a.path === '/team-b/demo-1.0.0.tgz')!.authorization).toBeUndefined()
})

test('what’s read is bounded: an index’s aliases, its size, a chart’s size unpacked', async () => {
  routes['/aliases/index.yaml'] = () => ({
    body: 'entries:\n  a: &a [{version: 1.0.0}]\n  b: *a\n',
  })
  routes['/large/index.yaml'] = () => ({ body: Buffer.alloc(21 * 1024 * 1024, 32) })
  const bomb = gzipSync(Buffer.alloc(101 * 1024 * 1024))
  routes['/bomb/index.yaml'] = () =>
    index({ bomb: [{ version: '1.0.0', urls: ['bomb-1.0.0.tgz'], digest: sha256(bomb) }] })
  routes['/bomb/bomb-1.0.0.tgz'] = () => ({ body: bomb })
  const { service } = repositories()
  const read = async (name: string) => {
    const saved = await service.save({ name, kind: 'http', url: at(`/${name}`), signIn: null })
    return saved.ok ? saved.data.repositories.find((r) => r.name === name)! : undefined
  }
  expect((await read('aliases'))!.read).toMatchObject({
    error: expect.stringMatching(/^Couldn’t read its index: .*alias/i),
  })
  expect((await read('large'))!.read).toMatchObject({
    error: 'It’s larger than Lumovi reads (20 MB).',
  })
  const bombed = await read('bomb')
  await expect(service.fetchChart(bombed!.id, 'bomb', '1.0.0')).rejects.toThrow(
    /unpacks to more than 100 MB/,
  )
})

test('a chart’s icon: fetched by the backend from its repository’s own host, an image of at most 256 KB; never from a private address elsewhere', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  routes['/icons/index.yaml'] = () =>
    index({
      own: [{ version: '1.0.0', icon: at('/icons/own.png') }],
      large: [{ version: '1.0.0', icon: at('/icons/large.png') }],
      text: [{ version: '1.0.0', icon: at('/icons/text.png') }],
      // Elsewhere, and private (this computer): never fetched.
      private: [{ version: '1.0.0', icon: elsewhere('/icons/own.png') }],
      moved: [{ version: '1.0.0', icon: at('/icons/moved.png') }],
      plain: [{ version: '1.0.0', icon: 'http://127.0.0.1/icon.png' }],
    })
  routes['/icons/own.png'] = () => ({ headers: { 'content-type': 'image/png' }, body: png })
  routes['/icons/large.png'] = () => ({
    headers: { 'content-type': 'image/png' },
    body: Buffer.alloc(257 * 1024),
  })
  routes['/icons/text.png'] = () => ({ headers: { 'content-type': 'text/html' }, body: '<p>' })
  // Its own host, redirecting to a private address elsewhere: that hop isn't fetched.
  routes['/icons/moved.png'] = () => ({
    status: 302,
    headers: { location: elsewhere('/icons/own.png') },
  })
  const { service } = repositories()
  const saved = await service.save({ name: 'icons', kind: 'http', url: at('/icons'), signIn: null })
  const id = saved.ok ? saved.data.repositories[0]!.id : ''
  expect(await service.icon(id, 'own')).toEqual({
    ok: true,
    data: `data:image/png;base64,${png.toString('base64')}`,
  })
  for (const chart of ['large', 'text', 'private', 'moved', 'plain', 'none']) {
    expect(await service.icon(id, chart), chart).toEqual({ ok: true, data: null })
  }
  expect(asked.some((a) => a.host.startsWith('localhost'))).toBe(false)
})

test('an error is said in Lumovi’s words, by its status', async () => {
  signedRepository()
  const { service } = repositories()
  const wrong = await service.test({
    name: 'acme-charts',
    kind: 'http',
    url: at('/charts'),
    signIn: { username: 'anna', secret: 'wrong' },
  })
  expect(wrong).toMatchObject({
    ok: false,
    error: { message: 'Couldn’t sign in: 401 Unauthorized.' },
  })
  const missing = await service.test({ name: 'gone', kind: 'http', url: at('/gone'), signIn: null })
  expect(missing).toMatchObject({ ok: false, error: { message: 'Couldn’t read: 404 Not Found.' } })
})

test('a registry: its tags as versions, a token asked with the sign-in, and a chart checked against its digests', async () => {
  const config = Buffer.from(
    JSON.stringify({ name: 'orders', version: '1.2.0', appVersion: '1.2', description: 'Orders' }),
  )
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      config: {
        mediaType: 'application/vnd.cncf.helm.config.v1+json',
        digest: `sha256:${sha256(config)}`,
      },
      layers: [
        {
          mediaType: 'application/vnd.cncf.helm.chart.content.v1.tar+gzip',
          digest: `sha256:${sha256(CHART)}`,
          size: CHART.length,
        },
      ],
    }),
  )
  const bearer = `Bearer ${TOKEN}`
  const challenge = {
    status: 401,
    headers: {
      'www-authenticate': `Bearer realm="${at('/token')}",service="test",scope="repository:acme/charts/orders:pull"`,
    },
  }
  routes['/token'] = (auth) =>
    auth === BASIC ? { body: JSON.stringify({ token: TOKEN }) } : { status: 401 }
  routes['/v2/acme/charts/orders/tags/list'] = (auth) =>
    auth === bearer
      ? { body: JSON.stringify({ tags: ['1.0.0', '1.2.0', '1.1.0_build.1', 'latest'] }) }
      : challenge
  routes['/v2/acme/charts/orders/manifests/1.2.0'] = (auth) =>
    auth === bearer
      ? { headers: { 'docker-content-digest': `sha256:${sha256(manifest)}` }, body: manifest }
      : challenge
  routes[`/v2/acme/charts/orders/blobs/sha256:${sha256(config)}`] = (auth) =>
    auth === bearer ? { body: config } : challenge
  // The chart's blob is in storage elsewhere, as a registry's often is: reached without the token.
  routes[`/v2/acme/charts/orders/blobs/sha256:${sha256(CHART)}`] = (auth) =>
    auth === bearer
      ? { status: 307, headers: { location: elsewhere('/storage/orders') } }
      : challenge
  routes['localhost/storage/orders'] = () => ({ body: CHART })
  const { service } = repositories()
  const tried = await service.test({
    name: 'acme-oci',
    kind: 'oci',
    url: `oci://127.0.0.1:${port}/acme/charts`,
    charts: ['orders'],
    signIn: { username: 'anna', secret: SECRET },
  })
  expect(tried).toEqual({ ok: true, data: { found: [{ chart: 'orders', versions: 3 }] } })
  const saved = await service.save({
    name: 'acme-oci',
    kind: 'oci',
    url: `oci://127.0.0.1:${port}/acme/charts`,
    charts: ['orders'],
    signIn: { username: 'anna', secret: SECRET },
  })
  if (!saved.ok) throw new Error(saved.error.message)
  expect(saved.data.charts[0]).toMatchObject({
    name: 'orders',
    description: 'Orders',
    // (A tag's _ is a version's +; a tag that isn't a version isn't one.)
    versions: [
      { version: '1.2.0', appVersion: '1.2' },
      { version: '1.1.0+build.1' },
      { version: '1.0.0' },
    ],
  })
  asked.length = 0
  const fetched = await service.fetchChart(saved.data.repositories[0]!.id, 'orders', '1.2.0')
  expect(readFileSync(fetched.file).equals(CHART)).toBe(true)
  await fetched.done()
  // The sign-in went to the token's realm and the chart's own path in the registry alone (a
  // registry may take it as it is); the token to the registry alone; storage got neither.
  for (const a of asked) {
    if (a.path === '/token') expect(a.authorization).toBe(BASIC)
    else if (a.host.startsWith('localhost')) expect(a.authorization).toBeUndefined()
    else if (a.authorization === BASIC) expect(a.path).toMatch(/^\/v2\/acme\/charts\/orders\//)
    else expect(a.authorization).toBe(bearer)
  }
  expect(asked.some((a) => a.host.startsWith('localhost'))).toBe(true)
})

test('a registry’s sign-in goes to its token realm only where that’s its own host (or Docker Hub’s own); never along the realm’s redirects', async () => {
  // Its own host; Docker Hub's realm, which is its own by name.
  expect(realmTakesSignIn('ghcr.io', 'ghcr.io')).toBe(true)
  expect(realmTakesSignIn('registry-1.docker.io', 'auth.docker.io')).toBe(true)
  // Another tenant under a shared suffix, another registrable domain, an address: never.
  expect(realmTakesSignIn('charts.acme.co.uk', 'evil.co.uk')).toBe(false)
  expect(realmTakesSignIn('acme.azurecr.io', 'evil.azurecr.io')).toBe(false)
  expect(realmTakesSignIn('registry.acme.example', 'auth.other.example')).toBe(false)
  expect(realmTakesSignIn('10.0.0.5', '10.0.0.6')).toBe(false)
  expect(realmTakesSignIn('evil.example', 'auth.docker.io')).toBe(false)

  // A realm on another host is asked without it; one that redirects isn't followed.
  const challenge = (realm: string) => ({
    status: 401,
    headers: { 'www-authenticate': `Bearer realm="${realm}",service="test"` },
  })
  routes['ip/v2/elsewhere/demo/tags/list'] = () => challenge(elsewhere('/token'))
  routes['localhost/token'] = () => ({ body: JSON.stringify({ token: 'not-for-it' }) })
  routes['ip/v2/moving/demo/tags/list'] = () => challenge(at('/moving-token'))
  routes['ip/moving-token'] = () => ({ status: 302, headers: { location: elsewhere('/token') } })
  const { service } = repositories()
  const test = (path: string) =>
    service.test({
      name: 'reg',
      kind: 'oci',
      url: `oci://127.0.0.1:${port}/${path}`,
      charts: ['demo'],
      signIn: { username: 'anna', secret: SECRET },
    })
  await test('elsewhere')
  await test('moving')
  expect(asked.filter((a) => a.host.startsWith('localhost')).map((a) => a.authorization)).toEqual([
    undefined,
  ])
  expect(asked.find((a) => a.path === '/moving-token')!.authorization).toBe(BASIC)
})

test('a sign-in: only over https, kept until the address moves elsewhere, replaced only by typing a new one', async () => {
  signedRepository()
  const { service, kept, changes } = repositories()
  const plain = await service.save({
    name: 'lab',
    kind: 'http',
    url: 'http://charts.lab.example',
    signIn: { username: 'anna', secret: SECRET },
  })
  expect(plain).toMatchObject({
    ok: false,
    error: {
      message: 'A sign-in is only sent over https. Use the repository’s https address to add one.',
    },
  })
  expect(
    await service.save({
      name: 'lab',
      kind: 'http',
      url: 'https://anna:pw@charts.lab.example',
      signIn: null,
    }),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/^Leave the sign-in out of the address/) },
  })

  const saved = await service.save({
    name: 'acme-charts',
    kind: 'http',
    url: at('/charts'),
    signIn: { username: 'anna', secret: SECRET },
  })
  const id = saved.ok ? saved.data.repositories[0]!.id : ''
  // Edited without a secret, at the same address: the saved one stays.
  const renamed = await service.save({
    id,
    name: 'acme',
    kind: 'http',
    url: at('/charts/'),
    signIn: { username: 'anna' },
  })
  expect(renamed.ok).toBe(true)
  expect(kept.get(id)!.secret).toBe(SECRET)
  // Another host: it's gone unless typed again.
  const moved = await service.save({
    id,
    name: 'acme',
    kind: 'http',
    url: elsewhere('/charts'),
    signIn: { username: 'anna' },
  })
  expect(moved).toMatchObject({
    ok: false,
    error: {
      message: 'Changing the host removes its sign-in. Enter it again for the new address.',
    },
  })
  expect(kept.get(id)!.url).toBe(at('/charts'))
  // Without one: removed, and recorded so.
  await service.save({ id, name: 'acme', kind: 'http', url: at('/charts'), signIn: null })
  expect(kept.get(id)!.secret).toBeUndefined()
  expect(changes.at(-1)).toMatchObject({ action: 'changed', signIn: 'removed' })
  await service.remove(id)
  expect(kept.size).toBe(0)
  expect(changes.at(-1)).toMatchObject({ action: 'removed' })
})

test('who may not change them is told who may; where no keychain keeps a sign-in, none is taken', async () => {
  const { service } = repositories({ mayChange: false })
  expect(
    await service.save({ name: 'a', kind: 'http', url: at('/a'), signIn: null }),
  ).toMatchObject({
    ok: false,
    error: {
      message:
        'Only Lumovi’s admins add and change repositories here. The server names them: anna, peter.',
    },
  })
  const listed = await service.list()
  expect(listed).toMatchObject({ ok: true, data: { mayChange: false, admins: ['anna', 'peter'] } })

  const without = repositories({ noSignIns: NO_KEYCHAIN })
  expect(
    await without.service.save({
      name: 'a',
      kind: 'http',
      url: at('/a'),
      signIn: { username: 'anna', secret: SECRET },
    }),
  ).toMatchObject({ ok: false, error: { message: NO_KEYCHAIN } })
})

test('on the desktop, a sign-in is in the file only as the keychain encrypted it; with no keychain, none is kept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-repositories-'))
  try {
    const file = join(dir, 'helm-repositories.json')
    // A stand-in keychain: what it "encrypts" is never the text it was given.
    const keychain = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret' as const,
      encryptString: (text: string) => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
      decryptString: (sealed: Buffer) =>
        Buffer.from(sealed.toString().replace(/^sealed:/, ''), 'hex').toString(),
    }
    const desktop = new DesktopRepositories(file, () => keychain as never, 'linux')
    const repository = {
      id: '0123456789abcdef',
      name: 'acme',
      kind: 'http' as const,
      url: at('/charts'),
      charts: [],
      username: 'anna',
    }
    await desktop.put(repository, SECRET)
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await desktop.secret(repository.id)).toBe(SECRET)
    expect(await desktop.list()).toEqual([repository])
    // Kept as it was when edited without one.
    await desktop.put({ ...repository, name: 'acme-charts' }, undefined)
    expect(await desktop.secret(repository.id)).toBe(SECRET)

    const unknown = new DesktopRepositories(
      file,
      () => ({ ...keychain, getSelectedStorageBackend: () => 'unknown' }) as never,
      'linux',
    )
    expect(unknown.noSignIns()).toBe(NO_KEYCHAIN)
    const basic = new DesktopRepositories(
      file,
      () => ({ ...keychain, getSelectedStorageBackend: () => 'basic_text' }) as never,
      'linux',
    )
    expect(basic.noSignIns()).toBe(NO_KEYCHAIN)
    await expect(basic.put(repository, 'another')).rejects.toThrow(NO_KEYCHAIN)
    expect(await basic.secret(repository.id)).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('on a server, a repository is kept with its sign-in, in a file or only in memory, and listed without it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-repositories-state-'))
  try {
    for (const keeping of [
      { kind: 'memory' as const },
      { kind: 'file' as const, path: join(dir, 'state.json') },
    ]) {
      const state = await ServerState.open(keeping, {}, randomBytes(32))
      const server = new ServerRepositories(state)
      const repository = {
        id: '0123456789abcdef',
        name: 'acme',
        kind: 'http' as const,
        url: at('/charts'),
        charts: [],
        username: 'anna',
      }
      await server.put(repository, SECRET)
      expect(await server.list(), keeping.kind).toEqual([repository])
      expect(await server.secret(repository.id)).toBe(SECRET)
      // Edited without one: kept; without a user: gone.
      await server.put({ ...repository, name: 'acme-charts' }, undefined)
      expect(await server.secret(repository.id)).toBe(SECRET)
      const { username: _u, ...signedOut } = repository
      await server.put(signedOut, null)
      expect(await server.secret(repository.id)).toBeUndefined()
      await server.remove(repository.id)
      expect(await server.list()).toEqual([])
      state.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('addresses: what a repository’s and a registry’s may be, and when a sign-in still goes to one', () => {
  expect('url' in addressOf('http', 'https://charts.example.com')).toBe(true)
  expect(addressOf('http', 'ftp://charts.example.com')).toEqual({
    problem: 'A repository’s address is an https:// URL.',
  })
  expect(addressOf('oci', 'https://ghcr.io/acme')).toEqual({
    problem: 'A registry’s address starts with oci://.',
  })
  expect(addressOf('oci', 'oci://ghcr.io')).toEqual({
    problem: 'Add the path its charts are under: oci://ghcr.io/acme/charts.',
  })
  expect(sameOrigin('https://a.example/x', 'https://a.example/y', 'http')).toBe(true)
  expect(sameOrigin('https://a.example', 'https://a.example:8443', 'http')).toBe(false)
  expect(sameOrigin('https://a.example', 'http://a.example', 'http')).toBe(false)
  expect(sameOrigin('oci://ghcr.io/a', 'oci://ghcr.io/b', 'oci')).toBe(true)
})

test('chart versions in Semantic Versioning’s order', () => {
  const sorted = [
    '1.10.0',
    '1.2.0',
    '2.0.0-rc.1',
    '2.0.0',
    '2.0.0-alpha',
    '2.0.0-rc.10',
    'v1.9.0',
    'latest',
  ].sort(compareChartVersions)
  expect(sorted).toEqual([
    'latest',
    '1.2.0',
    'v1.9.0',
    '1.10.0',
    '2.0.0-alpha',
    '2.0.0-rc.1',
    '2.0.0-rc.10',
    '2.0.0',
  ])
})

test('Update available only where Lumovi knows where a release came from; never a guess', () => {
  const repo = (id: string, name: string, read?: HelmRepository['read']): HelmRepository => ({
    id,
    name,
    kind: 'http',
    url: `https://${name}.example`,
    charts: [],
    ...(read ? { read } : {}),
  })
  const chart = (
    repository: string,
    name: string,
    versions: string[],
    home?: string,
  ): RepositoryChart => ({
    repository,
    name,
    icon: false,
    ...(home ? { home } : {}),
    versions: versions.map((version) => ({ version })),
  })
  const release = (patch: Partial<HelmRelease>): HelmRelease => ({
    name: 'payments-api',
    namespace: 'payments',
    revision: 8,
    status: 'deployed',
    chart: 'payments-api',
    chartVersion: '2.4.2',
    ...patch,
  })
  const acme = repo('aaaaaaaaaaaaaaaa', 'acme-charts')
  const mirror = repo('bbbbbbbbbbbbbbbb', 'mirror')
  const charts = [
    chart(
      acme.id,
      'payments-api',
      ['2.5.0', '2.4.2', '3.0.0-rc.1'],
      'https://acme.example/payments',
    ),
    chart(acme.id, 'fluent-bit', ['0.47.0'], 'https://fluentbit.io'),
    chart(acme.id, 'redis', ['19.0.1']),
    chart(mirror.id, 'redis', ['19.6.2']),
  ]
  // Installed from acme-charts by Lumovi (its label), its chart's home matching acme's: the
  // newest stable version there.
  const home = 'https://acme.example/payments'
  expect(
    releaseUpdate(release({ repository: acme.id, chartHome: home }), [acme, mirror], charts),
  ).toMatchObject({ version: '2.5.0', repository: acme })
  // A label alone isn't enough: one pointed at another repository with a chart by that name
  // whose home differs says nothing, and never falls back to the one that matches.
  const relabelled = [
    ...charts,
    chart(mirror.id, 'payments-api', ['9.0.0'], 'https://mirror.example'),
  ]
  expect(
    releaseUpdate(release({ repository: mirror.id, chartHome: home }), [acme, mirror], relabelled),
  ).toEqual({
    why: 'payments-api’s label names mirror, but its chart’s sources differ from mirror’s payments-api.',
  })
  // Its home matching that one's, it's that one's Update, naming it.
  expect(
    releaseUpdate(
      release({ repository: mirror.id, chartSources: ['https://mirror.example'] }),
      [acme, mirror],
      relabelled,
    ),
  ).toMatchObject({ version: '9.0.0', repository: mirror })
  // Not Lumovi's, but its chart's home matches the one repository with that chart.
  expect(
    releaseUpdate(release({ chartHome: 'https://acme.example/payments/' }), [acme, mirror], charts),
  ).toMatchObject({ version: '2.5.0' })
  // Its sources differ: nothing, and why.
  expect(
    releaseUpdate(
      release({
        name: 'logging',
        chart: 'fluent-bit',
        chartVersion: '0.46.0',
        chartHome: 'https://other.example',
      }),
      [acme],
      charts,
    ),
  ).toEqual({
    why: 'acme-charts has a fluent-bit, but nothing says logging came from there: Lumovi didn’t install it, and their sources differ.',
  })
  // In two repositories, with nothing to tell which.
  expect(
    releaseUpdate(
      release({ name: 'redis', chart: 'redis', chartVersion: '19.0.1' }),
      [acme, mirror],
      charts,
    ).why,
  ).toBe('2 repositories have redis, and nothing says which redis came from.')
  // In none.
  expect(
    releaseUpdate(release({ chart: 'orders', chartVersion: '1.0.0' }), [acme], charts).why,
  ).toBe('No repository added has orders.')
  // From a repository since removed.
  expect(releaseUpdate(release({ repository: 'cccccccccccccccc' }), [acme], charts).why).toBe(
    'Lumovi installed payments-api from a repository that’s since been removed.',
  )
  // The newest already: a dash with nothing to say.
  expect(
    releaseUpdate(
      release({ repository: acme.id, chartHome: home, chartVersion: '2.5.0' }),
      [acme],
      charts,
    ),
  ).toEqual({})
  // A pre-release counts only for a release that runs one.
  expect(
    releaseUpdate(
      release({ repository: acme.id, chartHome: home, chartVersion: '3.0.0-alpha' }),
      [acme],
      charts,
    ).version,
  ).toBe('3.0.0-rc.1')
})
