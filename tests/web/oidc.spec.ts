/**
 * Single sign-on (OpenID Connect): the provider says who someone is, and the
 * server acts as them in the cluster, impersonating them with its own credentials.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as http, type Page } from '@playwright/test'
import type { MockCluster } from '../mock-cluster/server.ts'
import { startMockOidc, type MockOidc, type MockOidcOptions } from '../mock-oidc/server.ts'
import {
  audited,
  expect,
  freePort,
  signIns,
  test,
  type ServeOptions,
  type Served,
} from './fixtures.ts'
import { holds } from '../holds.ts'

const ALICE = {
  sub: 'u-1',
  email: 'alice@example.com',
  groups: ['developers', 'on-call', 'system:masters'],
}

type Env = Record<string, string | undefined>

/** A provider, and a server that signs people in with it (`env`: what else it's set, maybe by the provider). */
async function withProvider(
  serve: (options?: ServeOptions) => Promise<Served>,
  options: Partial<MockOidcOptions> = {},
  settings: Env | ((oidc: MockOidc) => Env) = {},
): Promise<{ oidc: MockOidc; served: Served }> {
  const oidc = await startMockOidc({ clientId: 'lumovi', clientSecret: 's3cret', ...options })
  const env = typeof settings === 'function' ? settings(oidc) : settings
  oidc.person = ALICE
  const port = await freePort()
  const served = await serve({
    port,
    env: {
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_OIDC_ISSUER: `${oidc.issuer}/`,
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
      LUMOVI_OIDC_CLIENT_SECRET:
        options.clientSecret === undefined && 'clientSecret' in options ? undefined : 's3cret',
      ...env,
    },
  })
  return { oidc, served }
}

const notice = (page: Page, text: string) =>
  page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: text })
const FAILED = 'Signing in didn’t work. The Lumovi server’s log says why.'

test('sign in with single sign-on, as whoever the provider says', async ({
  page,
  serve,
  clusters,
}) => {
  const { oidc, served } = await withProvider(
    serve,
    {},
    {
      LUMOVI_OIDC_PROVIDER_NAME: 'Dex',
      LUMOVI_USERNAME_PREFIX: 'oidc:',
      LUMOVI_GROUPS_PREFIX: 'oidc:',
    },
  )
  await page.goto(`${served.url}cluster/demo/nodes`)
  await expect(page.getByRole('heading', { name: 'Sign in to Lumovi' })).toBeVisible()
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
  expect(asked.headers.authorization).toBe('Bearer lumovi-demo-token')
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
  // What renewed her sign-in is let go of at the provider too.
  await expect.poll(() => oidc.revoked).toEqual([oidc.refreshTokensIssued.at(-1)])
  // Signing in again is one click while the provider still knows Alice.
  await page.getByRole('button', { name: 'Sign in with Dex' }).click()
  await expect(page.getByRole('button', { name: 'Signed in as alice@example.com' })).toBeVisible()
  // Recorded: with whom, as whom (the groups the provider said).
  expect(signIns(served)).toEqual([
    ['session.sign-in', 'success', 'Signed in with Dex', 'alice@example.com', undefined],
    ['session.sign-out', 'success', 'Signed out', 'alice@example.com', undefined],
    ['session.sign-in', 'success', 'Signed in with Dex', 'alice@example.com', undefined],
  ])
  expect(audited(served, 'session.sign-in')[0]).toMatchObject({
    actor: { groups: ALICE.groups, via: 'ui' },
    details: { method: 'oidc', with: 'Dex' },
  })
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
    [
      { claims: { iat: now + 3600 } },
      'The ID token doesn’t say when it was issued, or says it’s from the future',
    ],
    [
      { claims: { iat: undefined } },
      'The ID token doesn’t say when it was issued, or says it’s from the future',
    ],
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
  // Each recorded: failed, or refused by the provider; and, at last, done.
  const said = signIns(served)
  expect(said[0]).toEqual([
    'session.sign-in',
    'failure',
    'Sign in with single sign-on',
    '(unknown)',
    expect.stringMatching(/openid-configuration answered 500/),
  ])
  expect(said[1]).toEqual([
    'session.sign-in',
    'refused',
    'Sign in with single sign-on',
    '(unknown)',
    'The provider said access_denied.',
  ])
  expect(said.slice(2, -1).map(([, outcome]) => outcome)).toEqual(
    Array(cases.length + 2).fill('failure'),
  )
  expect(said[2]![4]).toBe('The provider sent no ID token')
  expect(said.at(-1)).toEqual([
    'session.sign-in',
    'success',
    'Signed in with single sign-on',
    'alice@example.com',
    undefined,
  ])
  await oidc.close()
})

test('a way back from the provider is taken once, and what it says is kept short and plain', async ({
  page,
  context,
  serve,
}) => {
  // (Sign-ins that may take six seconds, at most.)
  const { oidc, served } = await withProvider(serve, {}, { LUMOVI_SIGN_IN_MINUTES: '0.1' })
  // A provider (or whoever made the way back) saying more than an error code.
  oidc.refuse = `access_denied\u0007${'x'.repeat(300)}`
  const callback = page.waitForRequest((r) => r.url().includes('/auth/callback'))
  await page.goto(`${served.url}auth/sign-in`)
  const taken = await callback
  const back = taken.url()
  // The sign-in's cookie, kept as it was sent on the way back: the browser drops it when its six
  // seconds are up, however long a slow computer takes to get this far.
  const sent = /(?:^|; )lumovi-sign-in=([^;]*)/.exec((await taken.allHeaders()).cookie ?? '')
  expect(sent, 'the way back carries the sign-in’s cookie').not.toBeNull()
  const cookie = {
    name: 'lumovi-sign-in',
    value: sent![1]!,
    domain: new URL(back).hostname,
    path: '/',
  }
  await expect(notice(page, 'Signing in was cancelled, or the provider said no.')).toBeVisible()
  // Taken again, with its cookie (put back, in case its six seconds are up already): as one that
  // took too long, and not recorded again.
  await context.addCookies([{ ...cookie, expires: -1 }])
  await page.goto(back)
  await expect(
    notice(page, 'That sign-in took too long, or started in another browser. Try again.'),
  ).toBeVisible()
  expect(signIns(served)).toEqual([
    [
      'session.sign-in',
      'refused',
      'Sign in with single sign-on',
      '(unknown)',
      `The provider said access_denied${'x'.repeat(87)}.`,
    ],
  ])
  // Long after: its cookie (whoever has it) is refused as expired, what was taken is let go, and
  // another sign-in goes.
  // eslint-disable-next-line no-restricted-syntax -- the session's own time has to pass.
  await page.waitForTimeout(6500)
  await context.addCookies([{ ...cookie, expires: -1 }])
  await page.goto(back)
  await expect(
    notice(page, 'That sign-in took too long, or started in another browser. Try again.'),
  ).toBeVisible()
  oidc.refuse = true
  await page.goto(`${served.url}auth/sign-in`)
  await expect(notice(page, 'Signing in was cancelled, or the provider said no.')).toBeVisible()
  expect(signIns(served)).toHaveLength(2)
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

  // A sign-in cookie Lumovi didn't sign.
  await page
    .context()
    .addCookies([{ name: 'lumovi-sign-in', value: 'eyJzdGF0ZSI6IngifQ.forged', url: served.url }])
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
    { LUMOVI_OIDC_USERNAME_CLAIM: 'preferred_username', LUMOVI_OIDC_GROUPS_CLAIM: 'roles' },
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
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: `http://127.0.0.1:${port}`,
      LUMOVI_OIDC_ISSUER: 'http://127.0.0.1:1',
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
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
    { LUMOVI_OIDC_FORWARD_TOKEN: 'id', LUMOVI_OIDC_SCOPES: 'openid email offline_access' },
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

  // The provider won't renew it any more (she was disabled): the session ends at once.
  oidc.disabled.add(ALICE.sub)
  await expect(notice(page, 'Your session ended. Sign in again')).toBeVisible({ timeout: 15_000 })
  expect(served.log()).toContain('Renewing alice@example.com’s sign-in was refused')
  oidc.disabled.delete(ALICE.sub)

  // Signed out, nothing's renewed any more.
  await page.getByRole('button', { name: 'Sign in with single sign-on' }).click()
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()
  const after = renewals()
  await holds(() => renewals() === after, 3_000, 'nothing is renewed')
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
    { LUMOVI_OIDC_FORWARD_TOKEN: 'access' },
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

/** The groups the latest read of the nodes was made as (none: no header). */
const nodesAs = (cluster: MockCluster) =>
  cluster.requests.findLast((r) => r.path === '/api/v1/nodes')?.headers['impersonate-group']

const renewalsOf = (oidc: MockOidc) =>
  oidc.tokenRequests.filter(
    (r) => r.body.get('grant_type') === 'refresh_token' && !r.body.has('scope'),
  ).length

test('without a token passed on, groups follow the provider at each renewal, and one it refuses signs them out at once', async ({
  page,
  serve,
  clusters,
}) => {
  // Lumovi impersonates her, and keeps her refresh token all the same. ID tokens that last a
  // minute and two seconds: renewed a minute early, so every two seconds.
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 62 },
    { LUMOVI_OIDC_SCOPES: 'openid email offline_access', LUMOVI_DATA_DIR: dir },
  )
  const tokens: string[] = []
  oidc.issued = (token) => tokens.push(token)
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBe('developers, on-call')
  await expect.poll(() => renewalsOf(oidc), { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

  // Taken out of on-call, put in platform: the next renewal says so, and what's asked from then
  // on is asked as that.
  oidc.person = { ...ALICE, groups: ['developers', 'platform', 'system:masters'] }
  await expect
    .poll(() => served.log(), { timeout: 15_000 })
    .toContain(
      'alice@example.com’s groups changed as the provider renewed their sign-in: +platform, −on-call',
    )
  // (Recorded as it's logged, a line later: the last line of the log may be being written.)
  await expect
    .poll(() => audited(served, 'session.groups'))
    .toEqual([
      expect.objectContaining({
        outcome: 'success',
        actor: expect.objectContaining({
          user: 'alice@example.com',
          groups: ['developers', 'platform', 'system:masters'],
        }),
        details: { added: ['platform'], removed: ['on-call'] },
      }),
    ])
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBe('developers, platform')
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  const groups = page.getByRole('dialog', { name: 'Account' }).getByRole('list', { name: 'Groups' })
  await expect(groups).toContainText('platform')
  await expect(groups).not.toContainText('on-call')
  await page.keyboard.press('Escape')
  // What the server keeps (her session among it) holds none of her tokens as they are, nor what
  // renews them.
  const kept = readFileSync(join(dir, 'state.json'), 'utf8')
  expect(Object.keys((JSON.parse(kept) as { entries: object }).entries)).not.toHaveLength(0)
  for (const token of [...tokens, ...oidc.refreshTokensIssued]) expect(kept).not.toContain(token)

  // Disabled at the provider: it won't renew her sign-in, and the session ends then, not hours on.
  oidc.disabled.add(ALICE.sub)
  await expect(notice(page, 'Your session ended. Sign in again')).toBeVisible({ timeout: 15_000 })
  expect(served.log()).toContain('Renewing alice@example.com’s sign-in was refused')
  // Said by its status and error code: nothing else of the provider's answer.
  await expect
    .poll(() => audited(served, 'session.expired').at(-1)?.details?.why)
    .toMatch(/^The provider wouldn’t renew its sign-in: \S+ answered 400: invalid_grant$/)
  await oidc.close()
})

test('a provider that can’t be reached as a sign-in is renewed is asked again, and the session ends as what it last said expires', async ({
  page,
  serve,
}) => {
  // ID tokens that last eight seconds: under a minute, so renewed each second.
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 8 },
    { LUMOVI_OIDC_SCOPES: 'openid email offline_access' },
  )
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => renewalsOf(oidc)).toBeGreaterThanOrEqual(1)

  // Down for a moment: asked again, and carried on.
  oidc.failing.add('token')
  await expect
    .poll(() => served.log())
    .toContain('Renewing alice@example.com’s sign-in failed, so it’s tried again until it expires')
  oidc.failing.delete('token')
  await expect.poll(() => served.log()).toContain('Renewed alice@example.com’s sign-in again')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')

  // Down for good: her groups hold only as long as her last ID token, eight seconds at most.
  oidc.failing.add('token')
  await expect(notice(page, 'Your session ended. Sign in again')).toBeVisible({ timeout: 15_000 })
  expect(served.log()).toContain(
    'alice@example.com’s sign-in expired, and the provider still couldn’t be reached to renew it',
  )
  await expect
    .poll(() => audited(served, 'session.expired').at(-1)?.details?.why)
    .toMatch(
      /^The provider couldn’t be reached to renew its sign-in before it expired: .* answered 500/,
    )
  oidc.failing.delete('token')
  await oidc.close()
})

test('a renewal with no access token isn’t one: it signs them out', async ({ page, serve }) => {
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 62 },
    { LUMOVI_OIDC_SCOPES: 'openid email offline_access' },
  )
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  // (An answer of 200 all the same, as a provider that's gone wrong might give.)
  oidc.renewalTamper = { accessToken: undefined, idToken: undefined }
  await expect(notice(page, 'Your session ended. Sign in again')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => audited(served, 'session.expired').at(-1)?.details?.why)
    .toBe('The provider wouldn’t renew its sign-in: The provider’s renewal has no access token')
  await oidc.close()
})

test('a renewal with no ID token renews no groups: they hold until the last ID token ends, and then so does the session', async ({
  page,
  serve,
}) => {
  // ID tokens that last eight seconds, renewed each second.
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 8 },
    { LUMOVI_OIDC_SCOPES: 'openid email offline_access' },
  )
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  // Renewed, as some providers renew: an access token and no ID token.
  oidc.renewalTamper = { idToken: undefined }
  await expect
    .poll(() => served.log())
    .toContain('alice@example.com’s provider renewed their sign-in without an ID token')
  const renewed = renewalsOf(oidc)
  // Not ended then: when the last ID token does, eight seconds at most.
  await expect(notice(page, 'Your session ended. Sign in again')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => audited(served, 'session.expired').at(-1)?.details?.why)
    .toBe(
      'Its provider renews it without an ID token, so its groups couldn’t be renewed past the last one.',
    )
  // Said once, and not renewed again only to be told the same.
  expect(served.log().split('without an ID token: their groups hold').length).toBe(2)
  expect(renewalsOf(oidc)).toBe(renewed)
  await oidc.close()
})

test('a renewal that answers after they signed out doesn’t bring the session back, and what it gave is let go of', async ({
  page,
  serve,
}) => {
  const { oidc, served } = await withProvider(
    serve,
    { lifetime: 62 },
    { LUMOVI_OIDC_SCOPES: 'openid email offline_access' },
  )
  // The next renewal waits for the test.
  let answer = () => {}
  oidc.beforeRenewal = () => new Promise<void>((resolve) => (answer = resolve))
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => renewalsOf(oidc), { timeout: 15_000 }).toBe(1)
  // Signed out while it's on its way: the one refresh token it had is let go of.
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(notice(page, 'You’ve signed out.')).toBeVisible()
  await expect.poll(() => oidc.revoked).toHaveLength(1)
  // It answers now, with a new refresh token: that's let go of too, and she's signed out still.
  oidc.beforeRenewal = undefined
  answer()
  await expect
    .poll(() => oidc.revoked)
    .toEqual([oidc.refreshTokensIssued.at(-2), oidc.refreshTokensIssued.at(-1)])
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Sign in to Lumovi' })).toBeVisible()
  await holds(() => renewalsOf(oidc) === 1, 3_000, 'nothing renewed after')
  expect(served.log()).not.toContain('groups changed')
  await oidc.close()
})

test('back after a restart past what the provider last said: no groups until it says again', async ({
  page,
  serve,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const env = {
    LUMOVI_OIDC_SCOPES: 'openid email offline_access',
    LUMOVI_DATA_DIR: dir,
  }
  // ID tokens that last eight seconds, renewed each second (with a refresh token that doesn't
  // change, so a stop in the middle of a renewal spends none: LMV-255's, not this test's).
  const { oidc, served } = await withProvider(serve, { lifetime: 8, refreshTokens: 'keep' }, env)
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBe('developers, on-call')
  await served.stop()
  // Stopped past her last ID token's end; taken out of on-call meanwhile.
  await new Promise((resolve) => setTimeout(resolve, 9_000))
  oidc.person = { ...ALICE, groups: ['developers'] }
  let answer = () => {}
  oidc.beforeRenewal = () => new Promise<void>((resolve) => (answer = resolve))
  const again = await serve({
    port: served.port,
    env: {
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: `http://127.0.0.1:${served.port}`,
      LUMOVI_OIDC_ISSUER: `${oidc.issuer}/`,
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
      LUMOVI_OIDC_CLIENT_SECRET: 's3cret',
      ...env,
    },
  })
  // Back, while the provider's answer waits: asked as her, with no groups at all.
  const before = clusters.demo.requests.length
  await page.goto(`${again.url}cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect
    .poll(() => clusters.demo.requests.slice(before).findLast((r) => r.path === '/api/v1/nodes'))
    .toMatchObject({ user: 'alice@example.com' })
  expect(nodesAs(clusters.demo)).toBeUndefined()
  // It answers: her groups as they are now.
  oidc.beforeRenewal = undefined
  answer()
  await expect.poll(() => again.log()).toContain('alice@example.com’s groups changed')
  await page.reload()
  await expect.poll(() => nodesAs(clusters.demo)).toBe('developers')
  await again.stop()
  await oidc.close()
})

/** Bob's groups, by id, as Microsoft Graph has them. */
const BOB_GROUPS = ['5e7b0f0a-0000-4000-8000-000000000001', '5e7b0f0a-0000-4000-8000-000000000002']

/**
 * Bob is in too many groups for his ID token: it says where they are instead, as Microsoft Entra
 * ID's does (somewhere Lumovi never goes).
 */
const BOB = {
  sub: 'u-2',
  email: 'bob@example.com',
  _claim_names: { groups: 'src1' },
  _claim_sources: {
    src1: { endpoint: 'http://127.0.0.1:9/tenant/users/u-2/getMemberObjects' },
  },
}

test('someone in too many groups for their ID token: read from Microsoft Graph as them, at sign-in and each renewal; none when it can’t be', async ({
  page,
  serve,
  clusters,
}) => {
  const { oidc, served } = await withProvider(
    serve,
    // The sign-in's access token is Graph's.
    { lifetime: 62, accessAudience: 'graph' },
    (oidc) => ({
      LUMOVI_OIDC_SCOPES: 'openid email offline_access User.Read',
      LUMOVI_OIDC_GRAPH_URL: `${oidc.issuer}/graph`,
    }),
  )
  oidc.person = BOB
  oidc.graphGroups = BOB_GROUPS
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBe(BOB_GROUPS.join(', '))
  // Asked with his own token, for the security groups he's in; no other token asked for.
  expect(oidc.graphRequests[0]).toEqual({
    token: expect.any(String),
    body: { securityEnabledOnly: true },
  })
  expect(oidc.tokenRequests.some((r) => r.body.has('scope'))).toBe(false)

  // Each renewal reads them again: one taken away.
  oidc.graphGroups = [BOB_GROUPS[0]!]
  await expect
    .poll(() => served.log(), { timeout: 15_000 })
    .toContain(
      `bob@example.com’s groups changed as the provider renewed their sign-in: −${BOB_GROUPS[1]}`,
    )

  // Graph can't be read: no groups at all, not the last ones; and he's told.
  oidc.failing.add('graph')
  await expect
    .poll(() => served.log(), { timeout: 15_000 })
    .toContain(
      'bob@example.com has no groups: Lumovi couldn’t read their groups from Microsoft Graph: Microsoft Graph answered 500',
    )
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBeUndefined()
  await page.getByRole('button', { name: 'Signed in as bob@example.com' }).click()
  const account = page.getByRole('dialog', { name: 'Account' })
  await expect(account).toContainText(
    'Lumovi couldn’t read your groups, so you’re signed in without them and may be able to do less than usual. If this stays, ask whoever runs Lumovi: its server’s log says why.',
  )
  await expect(account.getByRole('list', { name: 'Groups' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Read again: his group back, and nothing said.
  oidc.failing.delete('graph')
  await expect
    .poll(() => served.log(), { timeout: 15_000 })
    .toContain(
      `bob@example.com’s groups changed as the provider renewed their sign-in: +${BOB_GROUPS[0]}`,
    )
  await page.reload()
  await page.getByRole('button', { name: 'Signed in as bob@example.com' }).click()
  await expect(account.getByRole('list', { name: 'Groups' })).toBeVisible()
  await expect(account).not.toContainText('couldn’t read your groups')
  await oidc.close()
})

test('someone in too many groups, where the sign-in’s token is the cluster’s: one for Graph from their refresh token; and a provider not Microsoft’s gets none', async ({
  page,
  serve,
  clusters,
}) => {
  // Access tokens for the cluster; refresh tokens that change with every use.
  const { oidc, served } = await withProvider(serve, { lifetime: 62 }, (oidc) => ({
    LUMOVI_OIDC_SCOPES: 'openid email offline_access User.Read',
    LUMOVI_OIDC_GRAPH_URL: `${oidc.issuer}/graph`,
  }))
  oidc.person = BOB
  oidc.graphGroups = BOB_GROUPS
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBe(BOB_GROUPS.join(', '))
  // Graph wouldn't take the cluster's token; one for Graph's User.Read was asked for, and taken.
  const [own, graphs] = oidc.graphRequests
  expect(own!.token).not.toBe(graphs!.token)
  const forGraph = oidc.tokenRequests.filter((r) => r.body.has('scope'))
  expect(forGraph.length).toBeGreaterThanOrEqual(1)
  for (const asked of forGraph) {
    expect(asked.body.get('scope')).toBe(`${new URL(oidc.issuer).origin}/User.Read`)
  }
  // Its refresh token took the place of the one it used (no longer taken): renewed with it since.
  await expect.poll(() => renewalsOf(oidc), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  expect(served.log()).not.toContain('was refused')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await oidc.close()

  // A provider not Microsoft's, and no Graph set: his groups aren't looked for anywhere.
  const other = await withProvider(serve)
  other.oidc.person = BOB
  await page.goto(`${other.served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  await expect.poll(() => nodesAs(clusters.demo)).toBeUndefined()
  const why =
    'The provider put their groups outside the ID token, and Lumovi reads them only from Microsoft Graph, for Microsoft Entra ID (LUMOVI_OIDC_GRAPH_URL).'
  expect(other.served.log()).toContain(`bob@example.com has no groups: ${why}`)
  await expect
    .poll(() => audited(other.served, 'session.sign-in').at(-1)?.details)
    .toMatchObject({ groupsUnread: why })
  expect(other.oidc.graphRequests).toHaveLength(0)
  await other.oidc.close()
})

test('the server won’t act as Kubernetes’ own users, nor put anyone in their groups', async ({
  page,
  serve,
  clusters,
}) => {
  const { oidc, served } = await withProvider(serve, {}, { LUMOVI_OIDC_USERNAME_CLAIM: 'sub' })
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
      'Lumovi won’t act as this account: names starting with system: are Kubernetes’ own.',
    ),
  ).toBeVisible()
  expect(served.log()).toContain('Lumovi doesn’t act as system:admin')
  expect(signIns(served).at(-1)).toEqual([
    'session.sign-in',
    'refused',
    'Sign in with single sign-on',
    'system:admin',
    'Lumovi doesn’t act as system:admin: names starting with system: are Kubernetes’ own.',
  ])
  await oidc.close()
})

test('after a restart, a session that passes its person’s own token on carries on, renewed', async ({
  page,
  serve,
  clusters,
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-data-'))
  const forwarding = {
    LUMOVI_OIDC_FORWARD_TOKEN: 'id',
    LUMOVI_OIDC_SCOPES: 'openid email offline_access',
    LUMOVI_DATA_DIR: dir,
  }
  test.setTimeout(120_000)
  // Tokens that last a minute and a quarter: renewed a minute early, so every fifteen seconds.
  // The provider gives a new refresh token each time and takes the old one no more.
  const { oidc, served } = await withProvider(serve, { lifetime: 75 }, forwarding)
  trust(oidc, clusters.demo)
  await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
  const renewals = () =>
    oidc.tokenRequests.filter((r) => r.body.get('grant_type') === 'refresh_token').length
  // What the first server keeps, as it is once she's signed in (written long before the first
  // renewal is due).
  const kept = () => readFileSync(join(dir, 'state.json'), 'utf8')
  const signedIn = kept()
  // Renewed once by the first server, and stopped in the quiet after it: what's kept is the
  // second refresh token, the only one the provider still takes. (A server stopped at the very
  // moment of a renewal is another matter, LMV-255's, and not this test's.) The provider having
  // been asked isn't the server having its answer: it's stopped once what it keeps has changed.
  await expect.poll(renewals, { timeout: 30_000 }).toBe(1)
  await expect.poll(kept, { timeout: 10_000 }).not.toBe(signedIn)
  const before = renewals()
  expect(before).toBe(1)
  await served.stop()
  // (A stop that took until the next renewal was due would leave the check below to pass on the
  // first server's renewing, not the second's.)
  expect(renewals(), 'the first server renewed again while it stopped').toBe(before)

  // The next server: her token, and what renews it, unsealed as her browser comes back.
  const again = await serve({
    port: served.port,
    env: {
      LUMOVI_AUTH: 'oidc',
      LUMOVI_URL: `http://127.0.0.1:${served.port}`,
      LUMOVI_OIDC_ISSUER: `${oidc.issuer}/`,
      LUMOVI_OIDC_CLIENT_ID: 'lumovi',
      LUMOVI_OIDC_CLIENT_SECRET: 's3cret',
      ...forwarding,
    },
  })
  await page.goto(`${again.url}cluster/demo/pods`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await expect
    .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/pods'))
    .toMatchObject({ user: 'oidc:alice@example.com' })
  // The next renewal is the second server's, with what the first kept.
  await expect.poll(renewals, { timeout: 30_000 }).toBeGreaterThan(before)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  await again.stop()
  await oidc.close()
})
