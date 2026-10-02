/**
 * Single sign-on (OpenID Connect): the provider says who someone is, and the
 * server acts as them in the cluster, impersonating them with its own credentials.
 */
import { request as http, type Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import { startMockOidc, type MockOidc, type MockOidcOptions } from '../mock-oidc/server.ts'
import { expect, freePort, test, type ServeOptions, type Served } from './fixtures.ts'

const ALICE = {
  sub: 'u-1',
  email: 'alice@example.com',
  groups: ['developers', 'on-call', 'system:masters'],
}

/** A provider, and a server that signs people in with it. */
async function withProvider(
  serve: (options?: ServeOptions) => Promise<Served>,
  options: Partial<MockOidcOptions> = {},
  env: Record<string, string | undefined> = {},
): Promise<{ oidc: MockOidc; served: Served }> {
  const oidc = await startMockOidc({ clientId: 'kubestacks', clientSecret: 's3cret', ...options })
  oidc.person = ALICE
  const port = await freePort()
  const served = await serve({
    port,
    env: {
      KUBESTACKS_AUTH: 'oidc',
      KUBESTACKS_URL: `http://127.0.0.1:${port}`,
      KUBESTACKS_OIDC_ISSUER: `${oidc.issuer}/`,
      KUBESTACKS_OIDC_CLIENT_ID: 'kubestacks',
      KUBESTACKS_OIDC_CLIENT_SECRET:
        options.clientSecret === undefined && 'clientSecret' in options ? undefined : 's3cret',
      ...env,
    },
  })
  return { oidc, served }
}

const notice = (page: Page, text: string) =>
  page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: text })
const FAILED = 'Signing in didn’t work. The KubeStacks server’s log says why.'

test('sign in with single sign-on, as whoever the provider says', async ({
  page,
  serve,
  clusters,
}) => {
  const { oidc, served } = await withProvider(
    serve,
    {},
    {
      KUBESTACKS_OIDC_PROVIDER_NAME: 'Dex',
      KUBESTACKS_USERNAME_PREFIX: 'oidc:',
      KUBESTACKS_GROUPS_PREFIX: 'oidc:',
    },
  )
  await page.goto(`${served.url}cluster/demo/nodes`)
  await expect(page.getByRole('heading', { name: 'Sign in to KubeStacks' })).toBeVisible()
  const signIn = page.getByRole('button', { name: 'Sign in with Dex' })
  await expect(signIn).toBeFocused()
  await signIn.click()
  // Back where it started, as Alice.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect(page).toHaveURL(`${served.url}cluster/demo/nodes`)
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await expect(
    page.getByRole('dialog', { name: 'Account' }).getByRole('list', { name: 'Groups' }),
  ).toContainText('developers')

  // The server's own credentials, acting as Alice: prefixed, so no group of hers is Kubernetes' own.
  await expect.poll(() => clusters.demo.requests.some((r) => r.path === '/api/v1/nodes')).toBe(true)
  const asked = clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes')!
  expect(asked.headers.authorization).toBe('Bearer kubestacks-demo-token')
  expect(asked.headers['impersonate-user']).toBe('oidc:alice@example.com')
  expect(asked.user).toBe('oidc:alice@example.com')
  expect(asked.headers['impersonate-group']).toBe(
    'oidc:developers, oidc:on-call, oidc:system:masters',
  )
  // The provider was asked with the client's secret (HTTP Basic), and PKCE.
  const exchange = oidc.tokenRequests.at(-1)!
  expect(exchange.authorization).toMatch(/^Basic /)
  expect(exchange.body.get('code_verifier')).toBeTruthy()
  expect(served.log()).toContain('alice@example.com signed in')

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()
  // Signing in again is one click while the provider still knows Alice.
  await page.getByRole('button', { name: 'Sign in with Dex' }).click()
  await expect(page.getByRole('button', { name: 'Signed in as alice@example.com' })).toBeVisible()
  await oidc.close()
})

test('signing in that doesn’t work says so, and the server’s log says why', async ({
  page,
  serve,
}) => {
  const { oidc, served } = await withProvider(serve)
  const attempt = () => page.goto(`${served.url}auth/sign-in?then=/cluster/demo/pods`)
  const failed = async (reason: string | RegExp) => {
    await expect(notice(page, FAILED)).toBeVisible()
    expect(served.log()).toMatch(reason)
  }

  // The provider down at first, then up: it's asked again.
  oidc.failing.add('discovery')
  await attempt()
  await failed(/openid-configuration answered 500/)
  oidc.failing.delete('discovery')

  // The provider says no.
  oidc.refuse = true
  await attempt()
  await expect(notice(page, 'Signing in was cancelled, or the provider said no.')).toBeVisible()
  await expect(page).toHaveURL(served.url)
  expect(served.log()).toContain('The provider said access_denied')

  // ID tokens that don't check out.
  const now = Math.floor(Date.now() / 1000)
  const cases: [MockOidc['tamper'], string][] = [
    [{ idToken: 42 }, 'The provider sent no ID token'],
    [{ idToken: 'not.a' }, 'The ID token isn’t a JWT'],
    [{ header: { alg: 'HS256' } }, 'signed with HS256, which isn’t supported'],
    [{ header: { alg: undefined } }, 'signed with undefined, which isn’t supported'],
    [{ header: { kid: 'elsewhere' } }, 'The provider has no key elsewhere'],
    [{ foreignKey: true }, 'The ID token’s signature doesn’t match'],
    [
      { claims: { iss: 'https://impostor.example' } },
      'The ID token is from https://impostor.example',
    ],
    [{ claims: { aud: ['someone-else'] } }, 'The ID token is for another client'],
    [{ claims: { exp: now - 3600 } }, 'The ID token has expired'],
    [{ claims: { exp: 'later' } }, 'The ID token has expired'],
    [{ claims: { nonce: 'replayed' } }, 'The ID token is from another sign-in'],
    [{ claims: { email: '' } }, 'The ID token has no email claim to name the user by'],
  ]
  for (const [tamper, reason] of cases) {
    oidc.tamper = tamper
    await attempt()
    await failed(reason)
  }

  // Its token endpoint failing.
  oidc.failing.add('token')
  await attempt()
  await failed(/token answered 500/)
  oidc.failing.delete('token')

  // Keys that rotated since they were fetched are fetched again: when that fails, and works.
  oidc.rotateKeys()
  oidc.failing.add('jwks')
  await attempt()
  await failed(/keys answered 500/)
  oidc.failing.delete('jwks')
  await attempt()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await oidc.close()
})

test('a sign-in only finishes where it started, and only goes to the app', async ({
  page,
  serve,
}) => {
  const { oidc, served } = await withProvider(serve)
  // Started in another browser: its cookie isn't this one's.
  const elsewhere = await http.newContext({ maxRedirects: 0 })
  const started = await elsewhere.get(`${served.url}auth/sign-in`)
  const authorize = await elsewhere.get(started.headers().location!)
  await page.goto(authorize.headers().location!)
  await expect(
    notice(page, 'That sign-in took too long, or started in another browser. Try again.'),
  ).toBeVisible()
  // Or that the server doesn't know.
  await page.goto(`${served.url}auth/callback?state=made-up&code=x`)
  await expect(notice(page, 'That sign-in took too long')).toBeVisible()
  await elsewhere.dispose()

  // A sign-in cookie KubeStacks didn't sign.
  await page
    .context()
    .addCookies([
      { name: 'kubestacks-sign-in', value: 'eyJzdGF0ZSI6IngifQ.forged', url: served.url },
    ])
  await page.goto(`${served.url}auth/callback?state=x&code=y`)
  await expect(notice(page, 'That sign-in took too long')).toBeVisible()
  // This browser's sign-in, but back with another state, or without a code.
  const callback = async () => {
    const started = await page.request.get(`${served.url}auth/sign-in`, { maxRedirects: 0 })
    const authorized = await page.request.get(started.headers().location!, { maxRedirects: 0 })
    return new URL(authorized.headers().location!)
  }
  const swapped = await callback()
  swapped.searchParams.set('state', 'another')
  await page.goto(swapped.href)
  await expect(notice(page, 'That sign-in took too long')).toBeVisible()
  const codeless = await callback()
  codeless.searchParams.delete('code')
  await page.goto(codeless.href)
  await expect(notice(page, FAILED)).toBeVisible()
  expect(served.log()).toContain('answered 400')

  // Never to another site.
  await page.goto(`${served.url}auth/sign-in?then=//evil.example/`)
  await expect(page).toHaveURL(`${served.url}cluster/demo`)
  await oidc.close()
})

test('providers differ: secrets in the body, public clients, EC keys, groups as a string', async ({
  page,
  serve,
}) => {
  const post = await withProvider(serve, { authMethods: ['client_secret_post'] })
  await page.goto(`${post.served.url}auth/sign-in`)
  await expect(page.getByRole('button', { name: 'Signed in as alice@example.com' })).toBeVisible()
  expect(post.oidc.tokenRequests.at(-1)!.body.get('client_secret')).toBe('s3cret')
  expect(post.oidc.tokenRequests.at(-1)!.authorization).toBeUndefined()
  await post.oidc.close()

  // A public client, with a provider that names people by their preferred_username and
  // lists one group as a string.
  const open = await withProvider(
    serve,
    { clientSecret: undefined, algorithm: 'ES256' },
    { KUBESTACKS_OIDC_USERNAME_CLAIM: 'preferred_username', KUBESTACKS_OIDC_GROUPS_CLAIM: 'roles' },
  )
  open.oidc.person = { sub: 'u-2', preferred_username: 'carol', roles: 'admins' }
  await page.context().clearCookies()
  await page.goto(`${open.served.url}auth/sign-in`)
  await page.getByRole('button', { name: 'Signed in as carol' }).click()
  await expect(page.getByRole('list', { name: 'Groups' })).toHaveText('admins')
  expect(open.oidc.tokenRequests.at(-1)!.authorization).toBeUndefined()
  expect(open.oidc.tokenRequests.at(-1)!.body.get('client_secret')).toBeNull()

  // Without groups, and with no kid in its tokens.
  open.oidc.person = { sub: 'u-3', preferred_username: 'dave' }
  open.oidc.tamper = { header: { kid: undefined } }
  await page.context().clearCookies()
  await page.goto(`${open.served.url}auth/sign-in`)
  await page.getByRole('button', { name: 'Signed in as dave' }).click()
  await expect(page.getByRole('list', { name: 'Groups' })).toHaveCount(0)
  await open.oidc.close()
})

test('a provider that can’t be reached', async ({ page, serve }) => {
  const port = await freePort()
  const served = await serve({
    port,
    env: {
      KUBESTACKS_AUTH: 'oidc',
      KUBESTACKS_URL: `http://127.0.0.1:${port}`,
      KUBESTACKS_OIDC_ISSUER: 'http://127.0.0.1:1',
      KUBESTACKS_OIDC_CLIENT_ID: 'kubestacks',
    },
  })
  await page.goto(served.url)
  await page.getByRole('button', { name: 'Sign in with single sign-on' }).click()
  await expect(notice(page, FAILED)).toBeVisible()
  expect(served.log()).toContain(
    'Couldn’t reach http://127.0.0.1:1/.well-known/openid-configuration',
  )
})

/**
 * Makes the mock cluster accept what the provider issues, as an API server that trusts it does.
 * Returns the ID and access tokens issued so far, as `Authorization` headers.
 */
function trust(oidc: MockOidc, cluster: MockCluster) {
  const issued = { id: [] as string[], access: [] as string[] }
  oidc.issued = (token, kind, claims) => {
    issued[kind].push(`Bearer ${token}`)
    cluster.setUser(token, {
      username: `oidc:${claims.email as string}`,
      groups: (claims.groups as string[] | undefined) ?? [],
    })
  }
  return issued
}

test('with a cluster that trusts the provider: people’s own tokens, renewed before they expire', async ({
  page,
  serve,
  clusters,
}) => {
  // Tokens that last a minute and two seconds: renewed a minute early, so every two seconds.
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 62 },
    { KUBESTACKS_OIDC_FORWARD_TOKEN: 'id', KUBESTACKS_OIDC_SCOPES: 'openid email offline_access' },
  )
  const issued = trust(oidc, clusters.demo)
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  // No impersonation: requests carry Alice's own ID token, and the cluster names her.
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({ user: 'oidc:alice@example.com' })
  const first = clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes')!
  expect(first.headers['impersonate-user']).toBeUndefined()
  // Her ID token, or one renewed already (each lasts two seconds before it's due).
  expect(issued.id).toContain(first.headers.authorization)

  // Renewed before it expires, again and again; the first token stops working, the new ones don't.
  const renewals = () =>
    oidc.tokenRequests.filter((r) => r.body.get('grant_type') === 'refresh_token').length
  await expect.poll(renewals, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  clusters.demo.setUser(issued.id[0]!.slice('Bearer '.length), undefined)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Pods' })
    .click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/pods'))
    .toMatchObject({ user: 'oidc:alice@example.com' })

  // The provider stops renewing it: the session ends.
  oidc.failing.add('token')
  await expect(notice(page, 'Your session ended. Sign in again')).toBeVisible({ timeout: 15_000 })
  expect(served.log()).toContain('Renewing alice@example.com’s token failed')
  oidc.failing.delete('token')

  // Signed out, nothing's renewed any more.
  await page.getByRole('button', { name: 'Sign in with single sign-on' }).click()
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()
  const after = renewals()
  await page.waitForTimeout(3_000)
  expect(renewals()).toBe(after)
  await oidc.close()
})

test('access tokens, refresh tokens that don’t change, and tokens a cluster couldn’t check', async ({
  page,
  serve,
  clusters,
}) => {
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 62, refreshTokens: 'keep' },
    { KUBESTACKS_OIDC_FORWARD_TOKEN: 'access' },
  )
  const issued = trust(oidc, clusters.demo)
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  // Her access token (its audience is the cluster's), or one renewed already.
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({ user: 'oidc:alice@example.com' })
  expect(issued.access).toContain(
    clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes')!.headers.authorization,
  )
  // Renewed with the same refresh token each time.
  const renewals = () =>
    oidc.tokenRequests
      .filter((r) => r.body.get('grant_type') === 'refresh_token')
      .map((r) => r.body.get('refresh_token'))
  await expect.poll(() => renewals().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  expect(new Set(renewals()).size).toBe(1)
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  // Signing out reloads the page: done before going elsewhere.
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()

  // Tokens the API server couldn't check aren't passed on.
  for (const [tamper, reason] of [
    [{ accessToken: undefined }, 'The provider sent no access token to pass on'],
    [{ accessToken: 'opaque-token' }, 'The token to pass on isn’t a JWT'],
    [{ accessClaims: { exp: undefined } }, 'The token to pass on doesn’t say when it expires'],
  ] as const) {
    oidc.tamper = tamper
    await page.goto(`${served.url}auth/sign-in`)
    await expect(notice(page, FAILED)).toBeVisible()
    expect(served.log()).toContain(reason)
  }
  await oidc.close()
})

test('the server won’t act as Kubernetes’ own users, nor put anyone in their groups', async ({
  page,
  serve,
  clusters,
}) => {
  const { oidc, served } = await withProvider(serve, {}, { KUBESTACKS_OIDC_USERNAME_CLAIM: 'sub' })
  oidc.person = { sub: 'eve', groups: ['system:masters', 'ops'] }
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({ headers: { 'impersonate-group': 'ops' } })

  await page.getByRole('button', { name: 'Signed in as eve' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()
  oidc.person = { sub: 'system:admin' }
  await page.goto(`${served.url}auth/sign-in`)
  await expect(
    notice(
      page,
      'KubeStacks won’t act as this account: names starting with system: are Kubernetes’ own.',
    ),
  ).toBeVisible()
  expect(served.log()).toContain('KubeStacks doesn’t act as system:admin')
  await oidc.close()
})
