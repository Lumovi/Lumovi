/**
 * A kubeconfig user that signs in with `auth-provider: oidc`: an ID token, and a refresh token to
 * renew it from its issuer when it has expired, as kubectl does. The new tokens are written back
 * where kubectl keeps them, and nothing else of the file changes.
 */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { parse } from 'yaml'
import { startMockOidc, type MockOidc } from '../mock-oidc/server.ts'
import type { TestClusters } from '../mock-cluster/kubeconfig.ts'
import { toasts } from './action-helpers.ts'
import { clusterOption, expect, goTo, openCluster, test } from './fixtures.ts'
import { holds } from '../holds.ts'

const CONTEXT = 'oidc-demo'
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** An ID token that runs out `seconds` from now (unsigned: only the API server checks them). */
const idToken = (seconds: number) =>
  `${encode({ alg: 'RS256' })}.${encode({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + seconds })}.x`
const NOTE = 'A renewed token wasn’t saved'

/** The issuer, over HTTPS, whose ID tokens the demo cluster lets in. */
async function issuerFor(clusters: TestClusters, lifetime?: number): Promise<MockOidc> {
  const issuer = await startMockOidc({
    clientId: 'kubernetes',
    clientSecret: 'oidc-secret',
    tls: true,
    ...(lifetime ? { lifetime } : {}),
  })
  issuer.issued = (token, kind) => {
    if (kind === 'id') clusters.demo.setUser(token, { username: 'ada', groups: ['system:masters'] })
  }
  return issuer
}

interface Person {
  context?: string
  user?: string
  issuer: string
  ca?: string
  refreshToken?: string
  idToken?: string
}

/** A kubeconfig, as a person keeps one: the demo cluster, signed in through each issuer. */
function kubeconfigFor(
  clusters: TestClusters,
  people: Person[],
  dir?: string,
  cluster = 'demo',
): string {
  const path = join(dir ?? mkdtempSync(join(tmpdir(), 'lumovi-oidc-')), 'config')
  const users = people.map(
    (p) => `  - name: ${p.user ?? 'ada'}
    user:
      auth-provider:
        name: oidc
        config:
          client-id: kubernetes
          client-secret: oidc-secret
          idp-issuer-url: ${p.issuer}
${p.ca ? `          idp-certificate-authority-data: ${Buffer.from(p.ca).toString('base64')}\n` : ''}          id-token: ${p.idToken ?? idToken(-60)}
${p.refreshToken ? `          refresh-token: ${p.refreshToken}\n` : ''}`,
  )
  writeFileSync(
    path,
    `# Ada's clusters, signed in through the company's identity provider.
apiVersion: v1
kind: Config
current-context: ${people[0]!.context ?? CONTEXT}
clusters:
  - name: ${cluster}
    cluster:
      server: ${clusters.demo.url}
      certificate-authority-data: ${Buffer.from(clusters.demo.caPem!).toString('base64')}
contexts:
${people.map((p) => `  - name: ${p.context ?? CONTEXT}\n    context: { cluster: ${cluster}, user: ${p.user ?? 'ada'} }`).join('\n')}
users:
${users.join('')}`,
  )
  return path
}

/** Ada, signed in through `issuer` before, her ID token since expired. */
const ada = (issuer: MockOidc, more: Partial<Person> = {}): Person => ({
  issuer: issuer.issuer,
  ca: issuer.caPem,
  refreshToken: issuer.refreshTokenFor({ sub: 'ada' }),
  ...more,
})

/** A kubeconfig as parsed, its users' tokens left out. */
function withoutTokens(text: string): unknown {
  const config = parse(text) as { users: { user: { 'auth-provider': { config: object } } }[] }
  for (const { user } of config.users) {
    const kept = user['auth-provider'].config as Record<string, unknown>
    delete kept['id-token']
    delete kept['refresh-token']
  }
  return config
}

/** Ada's tokens as the file has them. */
function tokensIn(path: string, user = 'ada'): { id: string; refresh: string } {
  const config = parse(readFileSync(path, 'utf8')) as {
    users: { name: string; user: { 'auth-provider': { config: Record<string, string> } } }[]
  }
  const found = config.users.find((entry) => entry.name === user)!.user['auth-provider'].config
  return { id: found['id-token']!, refresh: found['refresh-token']! }
}

const renewals = (issuer: MockOidc) =>
  issuer.tokenRequests.filter((r) => r.body.get('grant_type') === 'refresh_token')

const pods = async (page: Page) => {
  await goTo(page, 'Pods')
  await expect(page.getByRole('row').nth(1)).toBeVisible()
}

/** Answers the next folder picker with `folder`. */
const answerFolder = (app: ElectronApplication, folder: string) =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog
  }, folder)

test('an expired ID token is renewed from its issuer, once for everything asked at once, and written back where kubectl keeps it', async ({
  launch,
  clusters,
}) => {
  const issuer = await issuerFor(clusters)
  try {
    const path = kubeconfigFor(clusters, [ada(issuer)])
    if (process.platform !== 'win32') chmodSync(path, 0o640)
    const before = readFileSync(path, 'utf8')
    const { page } = await launch({ env: { KUBECONFIG: path } })
    // Nothing goes to the issuer until the cluster's opened.
    await expect(clusterOption(page, CONTEXT)).toContainText('Signs in when opened')
    await holds(() => issuer.requests.length === 0, 2_000, 'nothing asked of the issuer')

    await openCluster(page, CONTEXT)
    await pods(page)
    // One renewal, as the client, however many requests waited for it.
    expect(renewals(issuer)).toHaveLength(1)
    expect(renewals(issuer)[0]!.authorization).toMatch(/^Basic /)
    // Kept where kubectl keeps them: those two values changed, the rest as it was, comments too.
    const after = readFileSync(path, 'utf8')
    expect(after).toContain("# Ada's clusters, signed in through the company's identity provider.")
    expect(withoutTokens(after)).toEqual(withoutTokens(before))
    expect(tokensIn(path).refresh).toBe(issuer.refreshTokensIssued.at(-1))
    expect(tokensIn(path).id).not.toBe(tokensIn(path).refresh)
    // Its mode kept, and nothing left beside it (no lock, no temporary file).
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(readdirSync(join(path, '..'))).toEqual(['config'])
    await expect(toasts(page)).not.toContainText(NOTE)
  } finally {
    await issuer.close()
  }
})

test('with refresh tokens used once, the next launch signs in with the one written back', async ({
  launch,
  clusters,
}) => {
  // ID tokens that last twelve seconds: renewed when ten are left, so soon after each is had.
  const issuer = await issuerFor(clusters, 12)
  try {
    const path = kubeconfigFor(clusters, [ada(issuer)])
    const first = await launch({ env: { KUBECONFIG: path } })
    await openCluster(first.page, CONTEXT)
    await pods(first.page)
    const kept = tokensIn(path).refresh
    await first.app.close()

    // The one it had at first was spent: only the one written back still works.
    await expect.poll(() => renewals(issuer).length).toBeGreaterThanOrEqual(1)
    const { page } = await launch({ env: { KUBECONFIG: path } })
    await openCluster(page, CONTEXT)
    await pods(page)
    expect(renewals(issuer).map((r) => r.body.get('refresh_token'))).toContain(kept)
  } finally {
    await issuer.close()
  }
})

test('a kubeconfig that can’t be written keeps working, says so once, and stays as it was', async ({
  launch,
  clusters,
}) => {
  test.skip(process.platform === 'win32', 'A folder made read-only by its mode')
  const issuer = await issuerFor(clusters)
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-oidc-'))
  try {
    const path = kubeconfigFor(clusters, [ada(issuer)], dir)
    const before = readFileSync(path, 'utf8')
    chmodSync(dir, 0o555)
    const { page } = await launch({ env: { KUBECONFIG: path } })
    await openCluster(page, CONTEXT)
    await pods(page)
    await expect(toasts(page)).toContainText(NOTE)
    await expect(toasts(page)).toContainText(
      new RegExp(
        `Lumovi signed in, but couldn’t save the new token to ${path.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')}: its folder is read-only to you\\. kubectl may need to sign in again, and so may Lumovi next time it starts\\.`,
      ),
    )
    expect(readFileSync(path, 'utf8')).toBe(before)
  } finally {
    chmodSync(dir, 0o755)
    await issuer.close()
  }
})

test('a kubeconfig that’s read-only to its person is never replaced, though its folder would let it be', async ({
  launch,
  clusters,
}) => {
  test.skip(process.platform === 'win32', 'A file made read-only by its mode')
  const issuer = await issuerFor(clusters)
  const path = kubeconfigFor(clusters, [ada(issuer)])
  const dir = dirname(path)
  try {
    const before = readFileSync(path, 'utf8')
    chmodSync(path, 0o444)
    const { page } = await launch({ env: { KUBECONFIG: path } })
    await openCluster(page, CONTEXT)
    await pods(page)
    await expect(toasts(page)).toContainText(
      `Lumovi signed in, but couldn’t save the new token to ${path}: it’s read-only to you. kubectl may need to sign in again, and so may Lumovi next time it starts.`,
    )
    // As it was, and as read-only: nothing was put in its place, nor beside it.
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(statSync(path).mode & 0o777).toBe(0o444)
    expect(readdirSync(dir)).toEqual(['config'])
  } finally {
    chmodSync(path, 0o644)
    await issuer.close()
  }
})

test('kubectl’s lock is waited for, what kubectl renewed meanwhile is never written over, and a lock Lumovi left is taken away', async ({
  launch,
  clusters,
}) => {
  const issuer = await issuerFor(clusters)
  try {
    // Held by kubectl (an empty lock, as client-go makes): waited for, then memory only.
    const held = kubeconfigFor(clusters, [ada(issuer)])
    writeFileSync(`${held}.lock`, '')
    const before = readFileSync(held, 'utf8')
    const one = await launch({ env: { KUBECONFIG: held } })
    await openCluster(one.page, CONTEXT)
    await pods(one.page)
    await expect(toasts(one.page)).toContainText('kubectl (or another program) is writing it')
    expect(readFileSync(held, 'utf8')).toBe(before)
    expect(readFileSync(`${held}.lock`, 'utf8')).toBe('')
    await one.app.close()

    // kubectl renews it while Lumovi's renewal is on its way: Lumovi uses kubectl's, and leaves it.
    const renewedFirst = kubeconfigFor(clusters, [ada(issuer)])
    const theirs = { id: idToken(3600), refresh: issuer.refreshTokenFor({ sub: 'ada' }) }
    clusters.demo.setUser(theirs.id, { username: 'ada', groups: ['system:masters'] })
    issuer.beforeRenewal = () => {
      issuer.beforeRenewal = undefined
      const text = readFileSync(renewedFirst, 'utf8')
      const { id, refresh } = tokensIn(renewedFirst)
      writeFileSync(renewedFirst, text.replace(id, theirs.id).replace(refresh, theirs.refresh))
    }
    const two = await launch({ env: { KUBECONFIG: renewedFirst } })
    await openCluster(two.page, CONTEXT)
    await pods(two.page)
    expect(tokensIn(renewedFirst)).toEqual(theirs)
    await expect(toasts(two.page)).not.toContainText(NOTE)
    await two.app.close()

    // A lock a Lumovi that's gone left behind: taken away, and the tokens written.
    const left = kubeconfigFor(clusters, [ada(issuer)])
    writeFileSync(`${left}.lock`, 'lumovi 2147483646\n')
    const three = await launch({ env: { KUBECONFIG: left } })
    await openCluster(three.page, CONTEXT)
    await pods(three.page)
    expect(tokensIn(left).refresh).toBe(issuer.refreshTokensIssued.at(-1))
    expect(readdirSync(join(left, '..'))).toEqual(['config'])
  } finally {
    await issuer.close()
  }
})

test('what an issuer sends that isn’t a token is never used or written: no line of it gets into the file', async ({
  launch,
  clusters,
}) => {
  const issuer = await issuerFor(clusters)
  try {
    for (const tamper of [
      { refreshToken: 'x\n      exec:\n        command: /bin/sh' },
      { refreshToken: 'a"b # c: d' },
      { idToken: `${idToken(3600)}\r\nX-Injected: yes` },
    ]) {
      const path = kubeconfigFor(clusters, [ada(issuer)])
      const before = readFileSync(path, 'utf8')
      issuer.renewalTamper = tamper
      const asked = () => issuer.requests.filter((at) => at === '/token').length
      const askedBefore = asked()
      const { app, page } = await launch({ env: { KUBECONFIG: path } })
      await page.getByRole('option', { name: new RegExp(`^${CONTEXT}`) }).click()
      await expect(page.getByRole('heading', { name: 'Couldn’t get credentials' })).toBeVisible()
      await expect(
        page.getByText(
          `Couldn’t sign in to ${CONTEXT}. The identity provider answered with a token Lumovi can’t use, so nothing was saved.`,
        ),
      ).toBeVisible()
      // Said again for each read of the cluster, never asked of the issuer again with the same
      // refresh token (which a rotating issuer has let go of, and would refuse).
      await holds(
        () => asked() === askedBefore + 1,
        3_000,
        'the issuer asked once for this refresh token',
      )
      expect(readFileSync(path, 'utf8')).toBe(before)
      await app.close()
    }
  } finally {
    await issuer.close()
  }
})

test('couldn’t sign in: each reason said, and nothing secret in the page', async ({
  launch,
  clusters,
}) => {
  const issuer = await issuerFor(clusters)
  // Over HTTPS with an authority nobody trusts, and nothing listening.
  const closed = await startMockOidc({ clientId: 'kubernetes', tls: true })
  const nowhere = closed.issuer
  await closed.close()
  try {
    const refused = issuer.refreshTokenFor({ sub: 'ada' })
    issuer.disabled.add('ada')
    const path = kubeconfigFor(clusters, [
      { context: 'no-refresh', user: 'none', issuer: issuer.issuer, ca: issuer.caPem },
      {
        context: 'refused',
        user: 'refused',
        issuer: issuer.issuer,
        ca: issuer.caPem,
        refreshToken: refused,
      },
      {
        context: 'unreachable',
        user: 'gone',
        issuer: nowhere,
        ca: issuer.caPem,
        refreshToken: 'refresh-unreachable-5c1e',
      },
      {
        context: 'untrusted',
        user: 'untrusted',
        issuer: issuer.issuer,
        refreshToken: 'refresh-untrusted-9b2d',
      },
      {
        context: 'plain',
        user: 'plain',
        issuer: 'http://idp.example.com',
        refreshToken: 'refresh-plain-3a7f',
      },
    ])
    const secrets = [
      refused,
      'refresh-unreachable-5c1e',
      'refresh-untrusted-9b2d',
      'refresh-plain-3a7f',
      'oidc-secret',
    ]
    const { page } = await launch({ env: { KUBECONFIG: path } })
    const escaped = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
    const reasons: { context: string; said: string | RegExp }[] = [
      {
        context: 'no-refresh',
        said: 'Couldn’t sign in to no-refresh. Its ID token has expired, and the kubeconfig has no refresh token to renew it. Sign in again with your identity provider’s tool.',
      },
      {
        context: 'refused',
        said: 'Couldn’t sign in to refused. The identity provider refused the refresh token (invalid_grant): it may have expired or been used elsewhere. Sign in again with your identity provider’s tool.',
      },
      // Node's words for why, as the end of Lumovi's sentence.
      {
        context: 'unreachable',
        said: new RegExp(
          `Couldn’t sign in to unreachable\\. ${escaped(nowhere)} can’t be reached: connect ECONNREFUSED \\S+\\.`,
        ),
      },
      {
        context: 'untrusted',
        said: 'If your identity provider’s certificate is signed by your own authority, set idp-certificate-authority in the kubeconfig.',
      },
      {
        context: 'plain',
        said: 'Couldn’t sign in to plain. Its issuer isn’t https, so Lumovi won’t send it the refresh token (http://idp.example.com).',
      },
    ]
    for (const { context, said } of reasons) {
      await page.evaluate(() => (window.location.hash = '#/'))
      await page.getByRole('option', { name: new RegExp(`^${escaped(context)}\\b`) }).click()
      await expect(page.getByRole('heading', { name: 'Couldn’t get credentials' })).toBeVisible()
      await expect(page.getByText(said, { exact: false }).first()).toBeVisible()
      const shown = await page.content()
      for (const secret of secrets) expect(shown).not.toContain(secret)
    }
  } finally {
    await issuer.close()
  }
})

test('the file a user came from is the one written, the first in merge order; and a folder’s kubeconfig renews once, with nothing asked', async ({
  launch,
  clusters,
}) => {
  const first = await issuerFor(clusters)
  const second = await issuerFor(clusters)
  try {
    // Two files with a user "me", each of its own issuer: kubectl uses the first file's for both.
    const own = kubeconfigFor(clusters, [ada(first, { context: 'own', user: 'me' })])
    const other = kubeconfigFor(clusters, [ada(second, { context: 'other', user: 'me' })])
    const otherBefore = readFileSync(other, 'utf8')
    // A folder's, of names of its own (a folder's kubeconfig may use only its own).
    const folder = mkdtempSync(join(tmpdir(), 'lumovi-oidc-folder-'))
    const theirs = kubeconfigFor(
      clusters,
      [ada(second, { context: 'theirs', user: 'folk' })],
      folder,
      'demo-folder',
    )
    const { app, page } = await launch({ env: { KUBECONFIG: [own, other].join(delimiter) } })
    await answerFolder(app, folder)
    expect(await page.evaluate(() => window.lumovi!.kubeconfigFiles!.addFolder())).toMatchObject({
      ok: true,
    })

    for (const context of ['own', 'other']) {
      await openCluster(page, context)
      await pods(page)
    }
    // Renewed once, from the first file's issuer, into the first file; the other file untouched.
    expect(renewals(first)).toHaveLength(1)
    expect(renewals(second)).toHaveLength(0)
    expect(tokensIn(own, 'me').refresh).toBe(first.refreshTokensIssued.at(-1))
    expect(readFileSync(other, 'utf8')).toBe(otherBefore)

    // The folder's: renewed and written, with no consent asked; read again after the write, it
    // isn't renewed again.
    await openCluster(page, 'theirs')
    await pods(page)
    expect(renewals(second)).toHaveLength(1)
    expect(tokensIn(theirs, 'folk').refresh).toBe(second.refreshTokensIssued.at(-1))
    await holds(
      () => renewals(first).length === 1 && renewals(second).length === 1,
      3_000,
      'each renewed once',
    )
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pods')
  } finally {
    await first.close()
    await second.close()
  }
})
