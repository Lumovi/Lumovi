/**
 * A server whose own credentials sign in with `auth-provider: oidc`: renewed as kubectl renews
 * them, and kept in memory only (its kubeconfig is its operator's, never written).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMockOidc } from '../mock-oidc/server.ts'
import { expect, freePort, test } from './fixtures.ts'

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** An ID token that ran out a minute ago. */
const expired = () =>
  `${encode({ alg: 'RS256' })}.${encode({ sub: 'lumovi', exp: Math.floor(Date.now() / 1000) - 60 })}.x`

test('a server’s own oidc credentials are renewed in memory only, and its kubeconfig isn’t written', async ({
  page,
  serve,
  clusters,
}) => {
  // The server's own issuer, over HTTPS: whose ID tokens may impersonate people in the cluster.
  const account = await startMockOidc({
    clientId: 'kubernetes',
    clientSecret: 'oidc-secret',
    tls: true,
  })
  account.issued = (token, kind) => {
    if (kind === 'id') {
      clusters.demo.setUser(token, { username: 'lumovi', groups: [], impersonate: true })
    }
  }
  // People's own, which they sign in to Lumovi with.
  const people = await startMockOidc({ clientId: 'lumovi', clientSecret: 's3cret' })
  people.person = { sub: 'u-1', email: 'alice@example.com', groups: ['developers'] }
  try {
    const path = join(mkdtempSync(join(tmpdir(), 'lumovi-oidc-')), 'config')
    writeFileSync(
      path,
      `# The server's own: its operator's, never written.
apiVersion: v1
kind: Config
current-context: demo
clusters:
  - name: demo
    cluster:
      server: ${clusters.demo.url}
      certificate-authority-data: ${Buffer.from(clusters.demo.caPem!).toString('base64')}
contexts:
  - name: demo
    context: { cluster: demo, user: lumovi }
users:
  - name: lumovi
    user:
      auth-provider:
        name: oidc
        config:
          client-id: kubernetes
          client-secret: oidc-secret
          idp-issuer-url: ${account.issuer}
          idp-certificate-authority-data: ${Buffer.from(account.caPem!).toString('base64')}
          id-token: ${expired()}
          refresh-token: ${account.refreshTokenFor({ sub: 'lumovi' })}
`,
    )
    const before = readFileSync(path, 'utf8')
    const port = await freePort()
    const served = await serve({
      port,
      env: {
        KUBECONFIG: path,
        LUMOVI_AUTH: 'oidc',
        LUMOVI_URL: `http://127.0.0.1:${port}`,
        LUMOVI_OIDC_ISSUER: `${people.issuer}/`,
        LUMOVI_OIDC_CLIENT_ID: 'lumovi',
        LUMOVI_OIDC_CLIENT_SECRET: 's3cret',
      },
    })
    await page.goto(`${served.url}auth/sign-in?then=/cluster/demo/nodes`)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nodes')
    // Asked as Alice, with the server's own renewed token.
    await expect
      .poll(() => clusters.demo.requests.findLast((r) => r.path === '/api/v1/nodes'))
      .toMatchObject({ user: 'alice@example.com' })
    const renewals = account.tokenRequests.filter(
      (r) => r.body.get('grant_type') === 'refresh_token',
    )
    expect(renewals).toHaveLength(1)
    expect(readFileSync(path, 'utf8')).toBe(before)
  } finally {
    await account.close()
    await people.close()
  }
})
