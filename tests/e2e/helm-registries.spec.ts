/**
 * An OCI registry kept in Lumovi (LMV-354), through the desktop app's own backend: its token
 * asked of the realm it names with the sign-in only where that realm is its own, never over http
 * and never along the realm's redirects; a chart's blob checked against its digest before Helm
 * gets it; and an icon whose address moves to a private one isn't fetched.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { generate } from 'selfsigned'
import { dialog, toasts } from './action-helpers.ts'
import { expect, openCluster, row, test, type Lumovi } from './fixtures.ts'

/** Never a real secret: what the test types as one, to look for where it mustn't be. */
const SECRET = 'not-a-real-token-41c8'
const BASIC = `Basic ${Buffer.from(`anna:${SECRET}`).toString('base64')}`
const TOKEN = 'registry-token-e2e'
const CHART = gzipSync(Buffer.from('orders, as far as this test cares'))
const OTHER = gzipSync(Buffer.from('not the chart its manifest names'))
const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex')

interface Asked {
  host: string
  path: string
  authorization?: string
}

/**
 * A registry over https on 127.0.0.1 (and as localhost: another host, and a private one), and a
 * plain-http server for a realm that's refused: what each was asked, with what sign-in.
 */
async function registry() {
  const pems = await generate([{ name: 'commonName', value: 'lumovi-test-registry' }], {
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
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-test-registry-'))
  const ca = join(dir, 'ca.pem')
  writeFileSync(ca, pems.cert)
  const asked: Asked[] = []
  let port = 0
  let plainPort = 0
  const at = (path: string) => `https://127.0.0.1:${port}${path}`
  const config = (name: string) =>
    Buffer.from(
      JSON.stringify({
        name,
        version: '1.2.0',
        appVersion: '1.2',
        description: `The ${name} service.`,
        // On its own host, moving to another, private, one: never fetched there.
        icon: at(`/icons/${name}.png`),
      }),
    )
  const manifest = (name: string) =>
    Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        config: {
          mediaType: 'application/vnd.cncf.helm.config.v1+json',
          digest: `sha256:${sha256(config(name))}`,
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
  const challenge = (realm: string) => ({
    'www-authenticate': `Bearer realm="${realm}",service="test"`,
  })
  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const host = req.headers.host!.split(':')[0]!
    const path = new URL(req.url!, 'https://x').pathname
    asked.push({
      host,
      path,
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    })
    const bearer = req.headers.authorization === `Bearer ${TOKEN}`
    // The realms: its own (asked with the sign-in), one that moves, one on another host.
    if (path === '/token') {
      return void (req.headers.authorization === BASIC
        ? res.end(JSON.stringify({ token: TOKEN }))
        : res.writeHead(401).end())
    }
    if (path === '/moving-token') {
      return void res.writeHead(302, { location: `https://localhost:${port}/token` }).end()
    }
    if (path.startsWith('/icons/')) {
      return void res.writeHead(302, { location: `https://localhost:${port}/real${path}` }).end()
    }
    const m = /^\/v2\/(\w+)\/charts\/(orders|tampered)\/(.+)$/.exec(path)
    if (!m) return void res.writeHead(404).end()
    const [, repo, chart, rest] = m as unknown as [string, string, string, string]
    const realm = {
      acme: at('/token'),
      foreign: `https://localhost:${port}/token`,
      plain: `http://127.0.0.1:${plainPort}/token`,
      moving: at('/moving-token'),
    }[repo]
    if (!realm) return void res.writeHead(404).end()
    if (!bearer) return void res.writeHead(401, challenge(realm)).end()
    if (rest === 'tags/list') return void res.end(JSON.stringify({ tags: ['1.2.0'] }))
    if (rest === 'manifests/1.2.0') {
      const body = manifest(chart)
      return void res
        .writeHead(200, { 'docker-content-digest': `sha256:${sha256(body)}` })
        .end(body)
    }
    if (rest === `blobs/sha256:${sha256(config(chart))}`) return void res.end(config(chart))
    // The chart's layer: as its manifest names it; the tampered one's bytes aren't.
    if (rest === `blobs/sha256:${sha256(CHART)}`)
      return void res.end(chart === 'tampered' ? OTHER : CHART)
    res.writeHead(404).end()
  })
  const plain = http.createServer((req, res) => {
    asked.push({ host: 'plain', path: req.url! })
    res.end(JSON.stringify({ token: TOKEN }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  plainPort = (plain.address() as AddressInfo).port
  return {
    url: (repo: string) => `oci://127.0.0.1:${port}/${repo}/charts`,
    ca,
    asked,
    close: () => {
      server.close()
      plain.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A stand-in for the keychain (see helm-repositories.spec.ts). */
async function keychain(lumovi: Lumovi) {
  await lumovi.app.evaluate(({ safeStorage }) => {
    Object.assign(safeStorage, {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (text: string) => Buffer.from(`sealed:${Buffer.from(text).toString('hex')}`),
      decryptString: (sealed: Buffer) =>
        Buffer.from(sealed.toString().replace(/^sealed:/, ''), 'hex').toString(),
    })
  })
}

test('an OCI registry: its token asked with the sign-in of its own realm alone, a chart checked against its digest, and an icon that moves to a private address not fetched', async ({
  launch,
}) => {
  const reg = await registry()
  const lumovi = await launch({ env: { NODE_EXTRA_CA_CERTS: reg.ca } })
  const { page } = lumovi
  try {
    await keychain(lumovi)
    await openCluster(page)
    await page.evaluate(() => (location.hash = '#/cluster/demo/helm?tab=repositories'))
    await page.getByRole('button', { name: 'Add repository' }).click()
    const add = dialog(page)
    await add.getByRole('radio', { name: 'OCI registry' }).click()
    await add.getByRole('textbox', { name: 'Name', exact: true }).fill('acme-oci')
    await add.getByRole('textbox', { name: 'Registry', exact: true }).fill(reg.url('acme'))
    for (const chart of ['orders', 'tampered']) {
      await add.getByRole('textbox', { name: 'Add a chart’s name' }).fill(chart)
      await page.keyboard.press('Enter')
    }
    await add.getByRole('checkbox', { name: 'It needs a sign-in' }).check()
    await add.getByRole('textbox', { name: 'Username' }).fill('anna')
    await add.getByLabel('Token').fill(SECRET)
    await expect(add).toContainText('helm registry login 127.0.0.1:')
    await add.getByRole('button', { name: 'Test connection' }).click()
    await expect(add.getByRole('status')).toHaveText('Connected: orders has 1 version, tampered 1.')
    await add.getByRole('button', { name: 'Add repository' }).click()
    await expect(add).toBeHidden()
    await expect(row(page, 'Helm repositories', 'acme-oci')).toContainText('OCI')
    // Its row's Test connection names each chart's versions.
    await row(page, 'Helm repositories', 'acme-oci')
      .getByRole('button', { name: 'Actions for acme-oci' })
      .click()
    await page.getByRole('menuitem', { name: 'Test connection' }).click()
    await expect(toasts(page)).toContainText('orders: 1 versions, tampered: 1 versions')

    // The token's realm is the registry's own host: it was asked with the sign-in, and the
    // registry with the token alone.
    const token = reg.asked.filter((a) => a.path === '/token')
    expect(token.length).toBeGreaterThan(0)
    expect(token.every((a) => a.host === '127.0.0.1' && a.authorization === BASIC)).toBe(true)

    // Its chart, with the icon its config names: that moves to localhost (private, and not the
    // registry's own host), so it isn't fetched there, and the chart's initial stands in.
    await page.getByRole('tab', { name: /^Charts/ }).click()
    await expect(row(page, 'Charts', 'orders')).toContainText('The orders service.')
    await expect.poll(() => reg.asked.some((a) => a.path === '/icons/orders.png')).toBe(true)
    expect(reg.asked.filter((a) => a.path.startsWith('/real/'))).toEqual([])
    await expect(row(page, 'Charts', 'orders').locator('img')).toHaveCount(0)

    // Installed: its blob matches the digest its manifest names, so Helm gets the file.
    await row(page, 'Charts', 'orders').getByRole('gridcell').first().click()
    await page
      .getByRole('complementary', { name: 'Chart orders' })
      .getByRole('button', { name: 'Install 1.2.0…' })
      .click()
    const install = dialog(page)
    await expect(install).toContainText(
      'Lumovi fetches orders 1.2.0 from acme-oci with its saved sign-in',
    )
    await install.getByRole('button', { name: 'Review' }).click()
    await install.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(toasts(page)).toContainText('Installed orders')

    // One whose blob isn't what its manifest names never reaches Helm.
    await row(page, 'Charts', 'tampered').getByRole('gridcell').first().click()
    await page
      .getByRole('complementary', { name: 'Chart tampered' })
      .getByRole('button', { name: 'Install 1.2.0…' })
      .click()
    await dialog(page).getByRole('button', { name: 'Review' }).click()
    await expect(dialog(page)).toContainText(
      'The chart Lumovi fetched isn’t the one its repository lists.',
    )
  } finally {
    reg.close()
  }
})

test('a registry’s realm elsewhere gets no sign-in, an http realm nothing, and a realm that moves isn’t followed', async ({
  launch,
}) => {
  const reg = await registry()
  const lumovi = await launch({ env: { NODE_EXTRA_CA_CERTS: reg.ca } })
  const { page } = lumovi
  try {
    await keychain(lumovi)
    await openCluster(page)
    const tried = (repo: string) =>
      page.evaluate(
        ([url, secret]) =>
          window.lumovi!.helm.repositories.test({
            name: 'reg',
            kind: 'oci',
            url: url!,
            charts: ['orders'],
            signIn: { username: 'anna', secret: secret! },
          }),
        [reg.url(repo), SECRET],
      )
    // On another host (localhost): asked without the sign-in, so it refuses.
    expect(await tried('foreign')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Couldn’t sign in: 401') },
    })
    const elsewhere = reg.asked.filter((a) => a.host === 'localhost' && a.path === '/token')
    expect(elsewhere.length).toBeGreaterThan(0)
    expect(elsewhere.map((a) => a.authorization)).toEqual(elsewhere.map(() => undefined))
    // Over http: never asked at all.
    expect(await tried('plain')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('over http') },
    })
    expect(reg.asked.filter((a) => a.host === 'plain')).toEqual([])
    // A realm that redirects: not followed, with the sign-in or without.
    const before = reg.asked.filter((a) => a.host === 'localhost').length
    expect(await tried('moving')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('redirected its sign-in elsewhere') },
    })
    expect(reg.asked.filter((a) => a.host === 'localhost')).toHaveLength(before)
    expect(JSON.stringify(reg.asked.filter((a) => a.host !== '127.0.0.1'))).not.toContain(BASIC)
  } finally {
    reg.close()
  }
})
