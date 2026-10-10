/**
 * The server itself: its configuration, what it answers over HTTP, and how
 * strict its WebSocket is with what it's sent.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as http } from '@playwright/test'
import WebSocket from 'ws'
import { IPC } from '../../src/shared/api.ts'
import { parse } from 'yaml'
import {
  DEMO_TOKEN,
  expect,
  helmKubeconfigs,
  PEOPLE,
  refusedConfig,
  signIn,
  startServer,
  test,
  type Served,
} from './fixtures.ts'

/** Signs in over HTTP, as the page does; resolves with the session's cookie. */
async function sessionCookie(served: Served, token = DEMO_TOKEN): Promise<string> {
  const api = await http.newContext()
  const response = await api.post(`${served.url}api/session`, {
    headers: { Origin: new URL(served.url).origin },
    data: { token },
  })
  expect(response.status()).toBe(200)
  const cookie = response.headers()['set-cookie']!.split(';')[0]!
  await api.dispose()
  return cookie
}

/** A page's WebSocket, without a page: messages in, and what comes back. */
async function socket(served: Served, cookie: string, options: WebSocket.ClientOptions = {}) {
  const ws = new WebSocket(`${served.url.replace('http', 'ws')}api/socket`, {
    headers: { Cookie: cookie, Origin: new URL(served.url).origin },
    ...options,
  })
  const received: { type: string; id?: number; value?: unknown; error?: string }[] = []
  ws.on('message', (data) => received.push(JSON.parse(String(data))))
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })),
  )
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return {
    ws,
    closed,
    async call(id: number, channel: string, ...args: unknown[]) {
      ws.send(JSON.stringify({ type: 'invoke', id, channel, args }))
      await expect.poll(() => received.find((m) => m.id === id)).toBeTruthy()
      return received.find((m) => m.id === id)!
    },
  }
}

test('what the server answers over HTTP', async ({ serve }) => {
  const served = await serve({ env: { LUMOVI_URL: 'https://lumovi.example.com' } })
  const api = await http.newContext()
  const url = (path: string) => `${served.url}${path}`

  expect(await (await api.get(url('healthz'))).text()).toBe('ok')
  // The page: strict about what it loads, and never framed.
  const page = await api.get(url('cluster/demo'))
  expect(page.headers()).toMatchObject({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  expect(page.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(await page.text()).toContain('<base href="/" />')
  expect(await page.text()).not.toContain('http-equiv="Content-Security-Policy"')
  expect(await (await api.head(url('cluster/demo'))).text()).toBe('')
  // Only GET it.
  const posted = await api.post(url('cluster/demo'))
  expect(posted.status()).toBe(405)
  expect(posted.headers().allow).toBe('GET, HEAD')

  // Its files: compressed as the browser accepts, cached for good when their names are hashed.
  const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(await page.text())![1]!
  const encodings = ['br', 'gzip', 'identity']
  for (const encoding of encodings) {
    const file = await api.get(url(script), { headers: { 'Accept-Encoding': encoding } })
    expect(file.headers()['content-encoding']).toBe(encoding === 'identity' ? undefined : encoding)
    expect(file.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(file.headers()['content-type']).toBe('text/javascript; charset=utf-8')
  }
  // Fonts come compressed already.
  const font = /url\(\.\/(inter-latin-opsz-normal-[^)]+\.woff2)\)/.exec(
    await (
      await api.get(url(/href="\.\/(assets\/[^"]+\.css)"/.exec(await page.text())![1]!))
    ).text(),
  )![1]!
  const woff = await api.get(url(`assets/${font}`), { headers: { 'Accept-Encoding': 'br' } })
  expect(woff.headers()['content-encoding']).toBeUndefined()
  const icon = await api.get(url('favicon.svg'))
  expect(icon.headers()['cache-control']).toBe('no-cache')
  expect(await (await api.head(url('favicon.svg'))).text()).toBe('')
  // A client that says nothing about encodings gets the file as it is.
  const plain = await new Promise<Record<string, unknown>>((resolve) =>
    get(url(script), (res) => {
      res.resume()
      resolve(res.headers)
    }),
  )
  expect(plain['content-encoding']).toBeUndefined()
  expect((await api.get(url('assets/nope.js'))).status()).toBe(404)
  expect((await api.get(url('api/nope'))).status()).toBe(404)
  // Single sign-on's paths are only there with single sign-on.
  expect((await api.get(url('auth/sign-in'))).status()).toBe(404)
  // Request targets that aren't addresses, for a page or a WebSocket.
  const raw = (request: string) =>
    new Promise<string>((resolve) => {
      let answer = ''
      const socket = connect(Number(new URL(served.url).port), '127.0.0.1', () =>
        socket.write(request),
      )
      socket.setEncoding('utf8').on('data', (chunk: string) => (answer += chunk))
      socket.on('close', () => resolve(answer.split('\r\n')[0]!))
    })
  expect(await raw('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toBe(
    'HTTP/1.1 404 Not Found',
  )
  expect(
    await raw(
      'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    ),
  ).toBe('HTTP/1.1 403 Forbidden')
  expect(await (await api.get(url('healthz'))).text()).toBe('ok')
  await api.dispose()
})

test('signing in and out over HTTP: only from the server’s own pages', async ({ serve }) => {
  const served = await serve({ env: { LUMOVI_URL: 'https://lumovi.example.com' } })
  const api = await http.newContext()
  const session = `${served.url}api/session`
  const origin = new URL(served.url).origin

  const strangers: Record<string, string>[] = [
    {},
    { Origin: 'https://evil.example' },
    { Origin: 'not a url' },
  ]
  for (const headers of strangers) {
    const refused = await api.post(session, { headers, data: { token: DEMO_TOKEN } })
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toEqual({ error: 'Sign in from Lumovi’s own page.' })
    expect((await api.delete(session, { headers })).status()).toBe(403)
  }
  // Malformed: not JSON, too large, no token, a token with spaces in it.
  const malformed: { headers: Record<string, string>; data: unknown }[] = [
    { headers: { Origin: origin, 'Content-Type': 'text/plain' }, data: DEMO_TOKEN },
    {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: Buffer.from('{"token":'),
    },
    { headers: { Origin: origin }, data: { token: 'x'.repeat(70_000) } },
    { headers: { Origin: origin }, data: {} },
    { headers: { Origin: origin }, data: { token: 'two words' } },
  ]
  for (const options of malformed) {
    const answer = await api.post(session, options)
    expect(answer.status()).toBe(400)
    expect(await answer.json()).toEqual({ error: 'Paste a token to sign in with.' })
  }
  // The public address counts as the server's own, whatever the proxy calls it; with HTTPS
  // there (or at the proxy), the cookie is only ever sent over HTTPS.
  const signedIn = await api.post(session, {
    headers: { Origin: 'https://lumovi.example.com' },
    data: { token: DEMO_TOKEN },
  })
  expect(signedIn.status()).toBe(200)
  expect(await signedIn.json()).toEqual({
    user: { name: 'lumovi-demo', groups: ['system:masters', 'system:authenticated'] },
    auth: 'token',
    cluster: 'demo',
  })
  expect(signedIn.headers()['set-cookie']).toMatch(
    /^lumovi-session=[\w-]{43}; Path=\/; Max-Age=43200; SameSite=Lax; HttpOnly; Secure$/,
  )
  const plain = await serve()
  const proxied = await api.post(`${plain.url}api/session`, {
    headers: { Origin: new URL(plain.url).origin, 'X-Forwarded-Proto': 'https' },
    data: { token: DEMO_TOKEN },
  })
  expect(proxied.headers()['set-cookie']).toContain('; Secure')
  const unencrypted = await api.post(`${plain.url}api/session`, {
    headers: { Origin: new URL(plain.url).origin },
    data: { token: DEMO_TOKEN },
  })
  expect(unencrypted.headers()['set-cookie']).not.toContain('Secure')
  // Cookies it doesn't know are no session; signing out without one is fine.
  const stranger = await api.get(`${plain.url}api/session`, {
    headers: { Cookie: 'theme; =x; lumovi-session=made-up; other=%E0%A4%A' },
  })
  expect(stranger.status()).toBe(401)
  const out = await api.delete(`${plain.url}api/session`, {
    headers: { Origin: new URL(plain.url).origin },
  })
  expect(out.status()).toBe(204)
  expect(out.headers()['set-cookie']).toContain('Max-Age=0')
  await api.dispose()
})

test('the WebSocket only takes the server’s own pages’ messages', async ({ serve, clusters }) => {
  const served = await serve({ env: { LUMOVI_HEARTBEAT_SECONDS: '0.25' } })
  const cookie = await sessionCookie(served)
  const page = await socket(served, cookie)

  // Calls as the page makes them, with arguments left out arriving as null.
  expect((await page.call(1, IPC.helmReleases, 'demo', null)).value).toMatchObject({ ok: true })
  expect(await page.call(2, 'kube:nope')).toMatchObject({ error: 'There’s no kube:nope to call' })
  expect(await page.call(10, 'toString')).toMatchObject({ error: 'There’s no toString to call' })
  expect(await page.call(3, IPC.setReadOnly, 'demo', 'yes')).toMatchObject({
    error: 'Expected a context name and whether it is read-only',
  })
  expect((await page.call(4, IPC.appInfo)).value).toMatchObject({ name: 'Lumovi' })
  // The one cluster it shows.
  expect((await page.call(8, IPC.version, 'elsewhere')).value).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'This server shows demo, not "elsewhere".' },
  })
  // One-way messages for nothing are dropped.
  page.ws.send(JSON.stringify({ type: 'send', channel: 'kube:nope', args: [] }))
  page.ws.send(JSON.stringify({ type: 'send', channel: 'constructor', args: [] }))
  // The clusters' settings are the server's: what makes no sense is refused.
  expect(await page.call(11, IPC.setMetricsSource, 'demo', { mode: 'magic' })).toMatchObject({
    error: 'Expected a context name and a metrics source',
  })
  expect(
    await page.call(12, IPC.setNodeShell, 'demo', { namespace: 'Not A Namespace', image: 'a' }),
  ).toMatchObject({ error: 'Expected a context name and where its node shells run' })
  // Only for the clusters it shows: what's kept is kept small.
  expect(await page.call(19, IPC.setReadOnly, 'elsewhere', true)).toMatchObject({
    error: 'This server has no cluster called “elsewhere” that you can see.',
  })
  await page.call(13, IPC.setReadOnly, 'demo', true)
  await page.call(14, IPC.setMetricsSource, 'demo', { mode: 'off' })
  await page.call(15, IPC.setNodeShell, 'demo', { namespace: 'ops', image: 'alpine:3.22' })
  const defaults = { namespace: 'kube-system', image: 'alpine:3.22' }
  expect((await page.call(5, IPC.settings)).value).toEqual({
    theme: 'system',
    readOnly: ['demo'],
    readOnlyBy: { demo: { by: 'lumovi-demo', at: expect.any(String) } },
    metricsSource: { demo: { mode: 'off' } },
    nodeShell: { demo: { namespace: 'ops', image: 'alpine:3.22' } },
    nodeShellDefault: defaults,
    shared: { mayChange: true },
  })
  // Back to the defaults, they're kept no more.
  await page.call(16, IPC.setReadOnly, 'demo', false)
  await page.call(17, IPC.setMetricsSource, 'demo', { mode: 'auto' })
  await page.call(18, IPC.setNodeShell, 'demo', null)
  expect((await page.call(6, IPC.settings)).value).toEqual({
    theme: 'system',
    readOnly: [],
    readOnlyBy: {},
    metricsSource: { demo: { mode: 'auto' } },
    nodeShell: {},
    nodeShellDefault: defaults,
    shared: { mayChange: true },
  })
  // A message too large to take ends the connection, and nothing else.
  const large = await socket(served, cookie)
  large.ws.send('x'.repeat(9 * 1024 * 1024))
  expect((await large.closed).code).toBe(1009)
  expect((await page.call(9, IPC.appInfo)).value).toMatchObject({ name: 'Lumovi' })
  // Pings keep it open while it answers them.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(page.ws.readyState).toBe(WebSocket.OPEN)
  // An answer for a page that went away isn't sent.
  clusters.demo.fail('/version', { delayMs: 300 })
  page.ws.send(JSON.stringify({ type: 'invoke', id: 7, channel: IPC.version, args: ['demo'] }))
  page.ws.close()
  await page.closed
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Anything else ends the connection.
  for (const message of [
    'not json',
    '7',
    'null',
    '{"type":"invoke","channel":"x","args":[]}',
    '{"type":"settings"}',
    '{"type":"send","channel":3,"args":[]}',
  ]) {
    const other = await socket(served, cookie)
    other.ws.send(message)
    expect(await other.closed).toEqual({ code: 1008, reason: 'Not a Lumovi message' })
  }

  // Only the server's own pages, signed in, at its address.
  const origin = new URL(served.url).origin
  for (const [path, headers] of [
    ['api/socket', { Cookie: cookie }],
    ['api/socket', { Cookie: cookie, Origin: 'https://evil.example' }],
    ['api/socket', { Origin: origin }],
    ['api/socket', { Cookie: 'lumovi-session=%', Origin: origin }],
    ['api/elsewhere', { Cookie: cookie, Origin: origin }],
  ] as const) {
    const refused = new WebSocket(`${served.url.replace('http', 'ws')}${path}`, { headers })
    await expect(
      new Promise((resolve) =>
        refused.on('unexpected-response', (_req, res) => resolve(res.statusCode)),
      ),
    ).resolves.toBe(403)
  }

  // A page that stops answering pings is let go.
  const silent = await socket(served, cookie, { autoPong: false })
  expect((await silent.closed).code).toBe(1006)

  // A token the cluster stops taking ends its session, however many calls it refuses.
  const bob = await socket(served, await sessionCookie(served, PEOPLE.bob.token))
  clusters.demo.setUser(PEOPLE.bob.token, undefined)
  for (const id of [1, 2, 3]) {
    bob.ws.send(JSON.stringify({ type: 'invoke', id, channel: IPC.version, args: ['demo'] }))
  }
  expect(await bob.closed).toEqual({ code: 4401, reason: 'expired' })
})

test('the server says what’s wrong with its configuration, and stops', async ({ clusters }) => {
  const cases: [Record<string, string | undefined>, string][] = [
    [
      { LUMOVI_AUTH: 'magic' },
      'LUMOVI_AUTH must be token, oidc, proxy or unset (token), not "magic".',
    ],
    [{ LUMOVI_AUTH: 'oidc' }, 'LUMOVI_OIDC_ISSUER must be set for single sign-on.'],
    [
      { LUMOVI_AUTH: 'oidc', LUMOVI_OIDC_ISSUER: 'auth.example.com' },
      'LUMOVI_OIDC_ISSUER must be an http or https URL, not "auth.example.com".',
    ],
    [
      { LUMOVI_AUTH: 'oidc', LUMOVI_OIDC_ISSUER: 'https://auth.example.com' },
      'LUMOVI_URL must be set for single sign-on: the provider sends people back there.',
    ],
    [
      {
        LUMOVI_AUTH: 'oidc',
        LUMOVI_OIDC_ISSUER: 'https://auth.example.com',
        LUMOVI_URL: 'https://lumovi.example.com',
      },
      'LUMOVI_OIDC_CLIENT_ID must be set for single sign-on.',
    ],
    [{ LUMOVI_URL: 'https://' }, 'LUMOVI_URL must be an http or https URL, not "https://".'],
    [{ LUMOVI_NODE_SHELL: 'maybe' }, 'LUMOVI_NODE_SHELL must be on or off, not "maybe".'],
    [{ LUMOVI_METRICS_STACK: 'yes' }, 'LUMOVI_METRICS_STACK must be on or off, not "yes".'],
    [
      { LUMOVI_FILE_COPY_MAX_BYTES: '2Gi' },
      'LUMOVI_FILE_COPY_MAX_BYTES must be a whole number of bytes, or off, not "2Gi".',
    ],
    [
      { LUMOVI_FILE_COPY_MAX_BYTES: '-1' },
      'LUMOVI_FILE_COPY_MAX_BYTES must be a whole number of bytes, or off, not "-1".',
    ],
    [
      { LUMOVI_NODE_SHELL_IMAGE: 'has space' },
      'LUMOVI_NODE_SHELL_NAMESPACE must be a namespace\'s name and LUMOVI_NODE_SHELL_IMAGE an image, not "kube-system" and "has space".',
    ],
    [
      {
        LUMOVI_AUTH: 'oidc',
        LUMOVI_OIDC_ISSUER: 'https://auth.example.com',
        LUMOVI_URL: 'https://lumovi.example.com',
        LUMOVI_OIDC_CLIENT_ID: 'lumovi',
        LUMOVI_OIDC_FORWARD_TOKEN: 'both',
      },
      'LUMOVI_OIDC_FORWARD_TOKEN must be id, access or unset (impersonate), not "both".',
    ],
    [
      { LUMOVI_AUTH: 'proxy', LUMOVI_PROXY_SIGN_OUT_URL: 'javascript:alert(1)' },
      'LUMOVI_PROXY_SIGN_OUT_URL must be an http or https URL, not "javascript:alert(1)".',
    ],
    [
      { LUMOVI_BASE_PATH: '/lumovi app' },
      'LUMOVI_BASE_PATH must be a path like /lumovi, not "/lumovi app".',
    ],
    [{ LUMOVI_PORT: 'http' }, 'LUMOVI_PORT must be a port number, not "http".'],
    [
      { LUMOVI_SESSION_HOURS: '0' },
      'LUMOVI_SESSION_HOURS must be a number from 1 to 168, not "0".',
    ],
    [
      { LUMOVI_HEARTBEAT_SECONDS: 'often' },
      'LUMOVI_HEARTBEAT_SECONDS must be a number from 1 to 3600, not "often".',
    ],
    [
      { LUMOVI_METRICS_SOURCE: 'prometheus' },
      'LUMOVI_METRICS_SOURCE must be auto, off, or a service like monitoring/prometheus:9090, not "prometheus".',
    ],
    [
      { LUMOVI_CONTEXT: 'nowhere' },
      'The kubeconfig in KUBECONFIG has no context "nowhere" to show.',
    ],
    [
      { LUMOVI_CONTEXT: 'broken-ref' },
      'The kubeconfig in KUBECONFIG has no context "broken-ref" to show.',
    ],
    [
      { KUBECONFIG: undefined, KUBERNETES_SERVICE_HOST: undefined },
      'Lumovi isn’t running in a cluster (KUBERNETES_SERVICE_HOST isn’t set).',
    ],
    [
      {
        KUBECONFIG: undefined,
        KUBERNETES_SERVICE_HOST: '127.0.0.1',
        LUMOVI_SERVICE_ACCOUNT_DIR: tmpdir(),
      },
      `No service account token in ${tmpdir()}`,
    ],
    [
      { KUBECONFIG: undefined, KUBERNETES_SERVICE_HOST: '127.0.0.1', LUMOVI_PORT: undefined },
      'No service account token in /var/run/secrets/kubernetes.io/serviceaccount',
    ],
  ]
  for (const [env, message] of cases) {
    expect(await refusedConfig(clusters, env)).toContain(message)
  }
  // Its port taken.
  const first = await startServer(clusters)
  expect(await refusedConfig(clusters, { LUMOVI_PORT: String(first.port) })).toContain('EADDRINUSE')
  await first.stop()
})

test('in a cluster, with its service account', async ({ page, context, serve, clusters }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-serviceaccount-'))
  writeFileSync(join(dir, 'token'), DEMO_TOKEN)
  writeFileSync(join(dir, 'ca.crt'), clusters.demo.caPem!)
  const served = await serve({
    env: {
      KUBECONFIG: undefined,
      LUMOVI_CONTEXT: undefined,
      KUBERNETES_SERVICE_HOST: '127.0.0.1',
      KUBERNETES_SERVICE_PORT: String(clusters.demo.port),
      LUMOVI_SERVICE_ACCOUNT_DIR: dir,
      LUMOVI_AUTH: 'proxy',
      LUMOVI_METRICS_SOURCE: 'monitoring/prometheus:web/api/v1/../x',
    },
  }).catch((error: Error) => error)
  // A path that climbs out of the service isn't one.
  expect(String(served)).toContain('LUMOVI_METRICS_SOURCE must be auto, off, or a service')

  const inCluster = await serve({
    env: {
      KUBECONFIG: undefined,
      LUMOVI_CONTEXT: undefined,
      KUBERNETES_SERVICE_HOST: '127.0.0.1',
      KUBERNETES_SERVICE_PORT: String(clusters.demo.port),
      LUMOVI_SERVICE_ACCOUNT_DIR: dir,
      LUMOVI_AUTH: 'proxy',
      LUMOVI_METRICS_SOURCE: 'monitoring/prometheus:web',
    },
  })
  expect(inCluster.log()).toContain(`shows in-cluster (https://127.0.0.1:${clusters.demo.port})`)
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'leo@example.com' })
  await page.goto(inCluster.url)
  await expect(page).toHaveURL(`${inCluster.url}cluster/in-cluster`)
  await expect(page.getByRole('button', { name: 'Cluster', exact: true })).toContainText(
    'Kubernetes v1.34.1',
  )
  // With the service account's token, as Leo.
  await expect
    .poll(() => clusters.demo.requests.at(-1))
    .toMatchObject({ user: 'leo@example.com', headers: { authorization: `Bearer ${DEMO_TOKEN}` } })

  // helm gets the same: the token's file (Kubernetes rotates it), and the cluster's CA.
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Helm releases' })
    .click()
  await page
    .getByRole('grid', { name: 'Helm releases' })
    .getByRole('row')
    .filter({ hasText: 'storefront' })
    .first()
    .getByRole('gridcell')
    .nth(1)
    .click()
  await page.getByRole('button', { name: 'Roll back…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Rolled back')
  const config = parse(helmKubeconfigs(inCluster).find((r) => r.args[0] === 'rollback')!.kubeconfig)
  expect(config.users[0].user).toEqual({
    tokenFile: join(dir, 'token'),
    as: 'leo@example.com',
    'as-groups': [],
  })
  expect(config.clusters[0].cluster).toEqual({
    server: `https://127.0.0.1:${clusters.demo.port}`,
    'certificate-authority': join(dir, 'ca.crt'),
  })
})

test('signing in to a server that isn’t answering', async ({ page, serve }) => {
  const served = await serve()
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' }),
  )
  await page.goto(served.url)
  await expect(page.getByRole('alert')).toContainText('Can’t reach Lumovi')
  await expect(page.getByRole('alert')).toContainText('The server answered 502')
  await page.unroute('**/api/session')
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByPlaceholder('Paste a token')).toBeVisible()
  await signIn(page, served.url, PEOPLE.alice.token)
})
