/**
 * The Helm page's chart repositories on the desktop (LMV-354): one added with a sign-in, kept in
 * the keychain (a stand-in for it here) and never in the file in clear text; its charts browsed;
 * one installed from it, fetched by Lumovi and handed to Helm as a file, the release labelled
 * with where it came from; that release then saying Update available, and Upgrade opening with
 * the newer version; and the repository removed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { generate } from 'selfsigned'
import { encodeRelease, releaseRecord } from '../mock-cluster/fixtures/helm.ts'
import type { MockCluster } from '../mock-cluster/server.ts'
import { dialog, toasts } from './action-helpers.ts'
import { expect, openCluster, row, rows, test, type Lumovi } from './fixtures.ts'

/** Never a real secret: what the test types as one, to look for where it mustn't be. */
const SECRET = 'not-a-real-password-5d2b'
const BASIC = `Basic ${Buffer.from(`anna:${SECRET}`).toString('base64')}`
const CHART = gzipSync(Buffer.from('demo, as far as this test cares'))
const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex')

/** A chart repository over https that answers only with the sign-in. */
async function repository() {
  const pems = await generate([{ name: 'commonName', value: 'lumovi-test-charts' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  })
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-test-ca-'))
  const ca = join(dir, 'ca.pem')
  writeFileSync(ca, pems.cert)
  const index = {
    apiVersion: 'v1',
    entries: {
      demo: [
        {
          version: '1.1.0',
          appVersion: '1.1',
          description: 'A demo service.',
          home: 'https://demo.example',
          urls: ['demo-1.1.0.tgz'],
          digest: sha256(CHART),
          created: new Date(Date.now() - 86_400_000).toISOString(),
        },
        {
          version: '1.0.0',
          appVersion: '1.0',
          home: 'https://demo.example',
          urls: ['demo-1.0.0.tgz'],
          digest: sha256(CHART),
        },
      ],
      cache: [
        {
          version: '7.0.0',
          description: 'A cache.',
          urls: ['cache-7.0.0.tgz'],
          digest: sha256(CHART),
        },
      ],
    },
  }
  let base = ''
  // A repository anyone reads: pre-releases among its versions, and icons it can't have.
  const open = {
    apiVersion: 'v1',
    entries: {
      beta: [
        '2.0.0-rc.1',
        '2.0.0-rc.10',
        '2.0.0-alpha.1',
        '2.0.0-alpha.beta',
        '1.9.0',
        'v1.10.0',
        'nightly',
      ].map((version) => ({
        version,
        icon: `${base}/public/icon.html`,
        urls: [`beta-${version}.tgz`],
        digest: sha256(CHART),
        sources: ['https://beta.example', 7],
      })),
      big: [
        {
          version: '1.0.0',
          icon: `${base}/public/big.png`,
          urls: ['big.tgz'],
          digest: sha256(CHART),
        },
      ],
    },
  }
  const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    if (req.url === '/public/index.yaml') {
      for (const versions of Object.values(open.entries)) {
        for (const v of versions) v.icon = v.icon.replace(/^.*\/public\//, `${base}/public/`)
      }
      return void res.end(JSON.stringify(open))
    }
    if (req.url === '/public/icon.html')
      return void res.writeHead(200, { 'content-type': 'text/html' }).end('<p>')
    if (req.url === '/public/big.png') {
      return void res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(300 * 1024))
    }
    if (req.url === '/public/forbidden/index.yaml') return void res.writeHead(403).end()
    if (req.url === '/public/ftp/index.yaml') {
      return void res.writeHead(302, { location: 'ftp://127.0.0.1/index.yaml' }).end()
    }
    if (req.url?.startsWith('/public/')) return void res.writeHead(404, 'Not Found').end()
    if (req.headers.authorization !== BASIC) return void res.writeHead(401).end()
    if (req.url === '/charts/index.yaml') return void res.end(JSON.stringify(index))
    if (req.url === '/charts/demo-1.1.0.tgz') return void res.end(CHART)
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: `${base}/charts`,
    base,
    ca,
    close: () => {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * A stand-in for the system's keychain, where the test's has none (Linux without a Secret
 * Service): what it "encrypts" is never the text it was given.
 */
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

/** How the stand-in helm was run, oldest first (without the version checks). */
function helmCalls(lumovi: Lumovi): string[][] {
  const log = join(lumovi.helmDir!, 'calls.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args[0] !== 'version')
}

/** A release of `chart` at `version`, as Helm stores it, with its record's labels. */
function addRelease(
  cluster: MockCluster,
  name: string,
  version: string,
  labels: Record<string, string>,
) {
  const spec = {
    name,
    namespace: 'default',
    chart: { name, home: 'https://demo.example' },
    revisions: [
      {
        revision: 1,
        status: 'deployed',
        ago: 60_000,
        chartVersion: version,
        description: 'Install complete',
        values: {},
        manifest: '',
      },
    ],
  }
  cluster.upsert({
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `sh.helm.release.v1.${name}.v1`,
      namespace: 'default',
      labels: { name, owner: 'helm', status: 'deployed', version: '1', ...labels },
    },
    type: 'helm.sh/release.v1',
    data: {
      release: Buffer.from(
        encodeRelease(releaseRecord(spec, spec.revisions[0]!, Date.now())),
      ).toString('base64'),
    },
  })
}

async function openTab(page: Page, tab: 'Releases' | 'Charts' | 'Repositories') {
  await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
}

test('a repository with a sign-in: kept in the keychain, its charts installed from, and a release from it says Update available', async ({
  launch,
  clusters,
}) => {
  const charts = await repository()
  const lumovi = await launch({ env: { NODE_EXTRA_CA_CERTS: charts.ca } })
  const { page } = lumovi
  try {
    await keychain(lumovi)
    await openCluster(page)
    await page
      .getByRole('navigation', { name: 'Resources' })
      .getByRole('link', { name: 'Helm releases' })
      .click()
    await openTab(page, 'Repositories')
    await expect(page.getByText('No repositories')).toBeVisible()
    await page.getByRole('button', { name: 'Add repository' }).click()
    const add = dialog(page)
    await expect(add).toContainText('Helm repositories · kept on this computer, for every cluster')
    await add.getByLabel('Name').fill('acme-charts')
    // Over http, no sign-in can be added.
    await add.getByLabel('Address').fill('http://charts.lab.example')
    await expect(add.getByRole('checkbox', { name: 'It needs a sign-in' })).toBeDisabled()
    await expect(add).toContainText('A sign-in is only sent over https.')
    await add.getByLabel('Address').fill(charts.url)
    await add.getByRole('checkbox', { name: 'It needs a sign-in' }).check()
    await add.getByLabel('Username').fill('anna')
    await add.getByLabel('Password').fill(SECRET)
    await expect(add).toContainText(
      `helm repo add acme-charts ${charts.url} --username anna --password-stdin`,
    )
    await expect(add).toContainText('Kept in this computer’s keychain and never shown again.')
    await add.getByRole('button', { name: 'Test connection' }).click()
    await expect(add.getByRole('status')).toHaveText('Connected: its index lists 2 charts.')
    await add.getByRole('button', { name: 'Add repository' }).click()
    await expect(add).toBeHidden()

    const acme = row(page, 'Helm repositories', 'acme-charts')
    await expect(acme).toContainText('Saved')
    await expect(acme).toContainText(/Read \d+s ago/)
    // In the file only as the keychain encrypted it.
    const file = readFileSync(join(lumovi.userDataDir, 'helm-repositories.json'), 'utf8')
    expect(file).not.toContain(SECRET)
    const { id } = (JSON.parse(file) as { repositories: { id: string }[] }).repositories[0]!

    // Editing: the saved password is never shown; moved to another host, it's gone.
    await acme.getByRole('button', { name: 'Actions for acme-charts' }).click()
    await page.getByRole('menuitem', { name: 'Edit…' }).click()
    const edit = dialog(page)
    await expect(edit.getByLabel('Password')).toHaveValue('Saved')
    await expect(edit.getByLabel('Password')).toBeDisabled()
    await edit.getByLabel('Address').fill(charts.url.replace('127.0.0.1', 'localhost'))
    await expect(edit).toContainText(
      'Changing the host removes its sign-in. Enter it again for the new address.',
    )
    await expect(edit.getByLabel('Password')).toHaveValue('')
    await expect(edit.getByRole('button', { name: 'Save' })).toBeDisabled()
    await page.keyboard.press('Escape')

    // Its row's Test connection: said in a notification. Filtered by its address; and to nothing.
    await acme.getByRole('button', { name: 'Actions for acme-charts' }).click()
    await page.getByRole('menuitem', { name: 'Test connection' }).click()
    await expect(toasts(page)).toContainText('Connected to acme-charts')
    await expect(toasts(page)).toContainText('Its index lists 2 charts.')
    await page.getByPlaceholder('Filter repositories').fill('127.0.0.1')
    await expect(acme).toBeVisible()
    await page.getByPlaceholder('Filter repositories').fill('nowhere')
    await expect(page.getByText('No repositories match the current filters.')).toBeVisible()
    await page.getByPlaceholder('Filter repositories').fill('')
    // The Read chip: its own, and back.
    await page.getByRole('button', { name: /^Read/ }).click()
    await expect(acme).toBeVisible()
    await page.getByRole('button', { name: /^Read/ }).click()

    // Its charts, and one installed from it.
    await openTab(page, 'Charts')
    await expect(rows(page, 'Charts')).toHaveCount(2)
    // Searched by name and description, sorted by latest version; nothing matching, said so.
    await page.getByPlaceholder('Filter charts').fill('a cache')
    await expect(rows(page, 'Charts')).toHaveCount(1)
    await page.getByPlaceholder('Filter charts').fill('nothing like it')
    await expect(page.getByText('No charts match.')).toBeVisible()
    await page.getByPlaceholder('Filter charts').fill('')
    await page.getByRole('button', { name: 'Latest' }).click()
    await expect(rows(page, 'Charts').first()).toContainText('demo')
    await page.getByRole('button', { name: 'Latest' }).click()
    await expect(rows(page, 'Charts').first()).toContainText('cache')
    await row(page, 'Charts', 'demo').getByRole('gridcell').first().click()
    const panel = page.getByRole('complementary', { name: 'Chart demo' })
    await expect(panel).toContainText('Chart · acme-charts')
    await expect(panel.getByRole('listbox', { name: 'Versions' }).getByRole('option')).toHaveCount(
      2,
    )
    await panel.getByRole('button', { name: 'Install 1.1.0…' }).click()
    const install = dialog(page)
    await expect(install.getByRole('radio', { name: /From a saved repository/ })).toBeChecked()
    await expect(install.getByLabel('Release name')).toHaveValue('demo')
    await expect(install.getByRole('textbox', { name: 'Namespace' })).toHaveValue('default')
    await expect(install).toContainText('helm install demo ./demo-1.1.0.tgz')
    await expect(install).toContainText(
      'Lumovi fetches demo 1.1.0 from acme-charts with its saved sign-in, then hands Helm the chart. The command can’t say the sign-in.',
    )
    await install.getByRole('button', { name: 'Review' }).click()
    await install.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(toasts(page)).toContainText('Installed demo')
    const call = helmCalls(lumovi).at(-1)!
    expect(call.slice(0, 2)).toEqual(['install', 'demo'])
    expect(call[2]).toMatch(/demo-1\.1\.0\.tgz$/)
    expect(call).toContain(`lumovi.dev/repository=${id}`)
    // The file Helm was handed, and its folder, are gone.
    expect(existsSync(dirname(call[2]!))).toBe(false)

    // A release from it, older: Update available, and Upgrade opens with the newer version.
    addRelease(clusters.demo, 'demo', '1.0.0', { 'lumovi.dev/repository': id })
    await openTab(page, 'Releases')
    await page.getByRole('button', { name: /^Refresh/ }).click()
    await expect(row(page, 'Helm releases', 'demo')).toContainText('Update available: 1.1.0')
    await page.getByRole('button', { name: /^Update available/ }).click()
    await expect(rows(page, 'Helm releases')).toHaveCount(1)
    await row(page, 'Helm releases', 'demo').getByRole('gridcell').nth(1).click()
    const release = page.getByRole('complementary', { name: 'Helm release demo' })
    await expect(release).toContainText('demo 1.0.0 · 1.1.0 in acme-charts')
    await release.getByRole('button', { name: 'Update available: 1.1.0. Upgrade to it' }).click()
    const upgrade = dialog(page)
    await expect(
      upgrade.getByRole('radio', { name: /A newer version from acme-charts/ }),
    ).toBeChecked()
    await expect(upgrade.getByRole('combobox', { name: 'Version' })).toHaveValue('1.1.0')
    // With the chart it runs (its values changed, say), it's still from acme-charts: no label
    // is written or cleared.
    await upgrade.getByRole('radio', { name: /The chart it runs: demo 1\.0\.0/ }).check()
    await upgrade.getByRole('button', { name: 'Review' }).click()
    await upgrade.getByRole('button', { name: 'Upgrade', exact: true }).click()
    await expect(toasts(page)).toContainText('Upgraded demo')
    const upgraded = helmCalls(lumovi).at(-1)!
    expect(upgraded.slice(0, 2)).toEqual(['upgrade', 'demo'])
    expect(upgraded).not.toContain('--labels')
    // Another chart in its place: no longer from acme-charts, and its label says so (cleared).
    await release.getByRole('button', { name: 'Upgrade…' }).click()
    await upgrade
      .getByRole('radio', { name: /A chart from another repository or a registry/ })
      .check()
    await upgrade.getByLabel('Chart name or reference').fill('demo')
    await upgrade.getByLabel('Repository URL').fill('https://charts.example.com')
    await upgrade.getByRole('button', { name: 'Review' }).click()
    await upgrade.getByRole('button', { name: 'Upgrade', exact: true }).click()
    // (The toast of the upgrade before may still be there: what helm was given says it.)
    await expect
      .poll(() => helmCalls(lumovi).filter((call) => call.includes('lumovi.dev/repository=null')))
      .toHaveLength(2)

    // Removed: Lumovi forgets it and its sign-in; the release stays, and says nothing more.
    await openTab(page, 'Repositories')
    await row(page, 'Helm repositories', 'acme-charts')
      .getByRole('button', { name: 'Actions for acme-charts' })
      .click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    const remove = dialog(page)
    await expect(remove).toContainText('Lumovi forgets it, and its saved sign-in.')
    await remove.getByRole('button', { name: 'Remove' }).click()
    await expect(page.getByText('No repositories')).toBeVisible()
    expect(readFileSync(join(lumovi.userDataDir, 'helm-repositories.json'), 'utf8')).not.toContain(
      id,
    )
    // The release from it says nothing newer now, and why, where the pointer asks; the Charts tab
    // has nothing to browse.
    await openTab(page, 'Releases')
    const update = row(page, 'Helm releases', 'demo').getByRole('gridcell').nth(3)
    await expect(update).toHaveText('—')
    await update.locator('span').first().hover()
    await expect(page.getByRole('tooltip')).toContainText(
      'Lumovi installed demo from a repository that’s since been removed.',
    )
    await openTab(page, 'Charts')
    await expect(page.getByText('Add a repository to browse its charts.')).toBeVisible()
  } finally {
    charts.close()
  }
})

test('what Lumovi won’t keep, or can’t read, is said in its words; versions in Semantic Versioning’s order; icons it can’t have stand aside', async ({
  launch,
}) => {
  const charts = await repository()
  const lumovi = await launch({ env: { NODE_EXTRA_CA_CERTS: charts.ca } })
  const { page } = lumovi
  try {
    await keychain(lumovi)
    await openCluster(page)
    const save = (input: object) =>
      page.evaluate((given) => window.lumovi!.helm.repositories.save(given as never), input)
    const said = async (input: object) => {
      const result = (await save(input)) as { ok: boolean; error?: { message: string } }
      return result.ok ? 'ok' : result.error!.message
    }
    const http = { kind: 'http', signIn: null }
    expect(await said({ ...http, name: 'Bad name!', url: charts.url })).toMatch(
      /^A repository’s name is letters/,
    )
    expect(await said({ ...http, name: 'git', kind: 'git', url: charts.url })).toBe(
      'kind must be http or oci',
    )
    expect(await said({ ...http, name: 'ftp', url: 'ftp://charts.example' })).toBe(
      'A repository’s address is an https:// URL.',
    )
    expect(await said({ ...http, name: 'query', url: 'https://charts.example/?x=1' })).toBe(
      'A repository’s address has no ? or #.',
    )
    expect(
      await said({
        kind: 'oci',
        name: 'oci',
        url: 'https://ghcr.io/acme',
        charts: ['a'],
        signIn: null,
      }),
    ).toBe('A registry’s address starts with oci://.')
    expect(
      await said({ kind: 'oci', name: 'oci', url: 'oci://ghcr.io/acme', charts: [], signIn: null }),
    ).toBe('Name the charts Lumovi should look for: a registry has no index.')
    expect(
      await said({
        kind: 'oci',
        name: 'oci',
        url: 'oci://ghcr.io/acme',
        charts: ['Bad!'],
        signIn: null,
      }),
    ).toBe('Bad! isn’t a chart’s name.')
    expect(
      await said({
        kind: 'oci',
        name: 'oci',
        url: 'oci://ghcr.io/acme',
        charts: [''],
        signIn: null,
      }),
    ).toBe('An empty name isn’t a chart’s name.')
    expect(
      await said({
        kind: 'oci',
        name: 'oci',
        url: 'oci://ghcr.io/acme',
        charts: Array.from({ length: 51 }, (_, i) => `c${i}`),
        signIn: null,
      }),
    ).toBe('Lumovi looks for at most 50 charts in a registry.')
    expect(
      await said({
        kind: 'http',
        name: 'user',
        url: charts.url,
        signIn: { username: 'a:b', secret: 'x' },
      }),
    ).toBe('A user name has no spaces or colons.')
    expect(
      await said({
        kind: 'http',
        name: 'long',
        url: charts.url,
        signIn: { username: 'anna', secret: 'x'.repeat(9000) },
      }),
    ).toBe('Give its password or token.')
    expect(
      await said({ kind: 'http', name: 'none', url: charts.url, signIn: { username: 'anna' } }),
    ).toBe('Give its password or token.')
    expect(await said({ ...http, id: '0123456789abcdef', name: 'gone', url: charts.url })).toBe(
      'That repository isn’t kept now.',
    )
    expect(
      await page.evaluate(() => window.lumovi!.helm.repositories.remove('0123456789abcdef')),
    ).toMatchObject({ ok: false, error: { message: 'That repository isn’t kept now.' } })

    // Kept: one anyone reads, one that answers 404, and one with a sign-in.
    expect(await said({ ...http, name: 'public', url: `${charts.base}/public` })).toBe('ok')
    expect(await said({ ...http, name: 'public', url: `${charts.base}/public` })).toBe(
      'There’s a repository named public already.',
    )
    expect(await said({ ...http, name: 'broken', url: `${charts.base}/public/missing` })).toBe('ok')
    expect(
      await said({
        kind: 'http',
        name: 'signed',
        url: charts.url,
        signIn: { username: 'anna', secret: SECRET },
      }),
    ).toBe('ok')
    // Moved to another host, its saved sign-in can't come along.
    const listed = (await page.evaluate(() => window.lumovi!.helm.repositories.list())) as {
      ok: true
      data: { repositories: { id: string; name: string }[] }
    }
    const signed = listed.data.repositories.find((r) => r.name === 'signed')!
    expect(
      await said({
        kind: 'http',
        id: signed.id,
        name: 'signed',
        url: charts.url.replace('127.0.0.1', 'localhost'),
        signIn: { username: 'anna' },
      }),
    ).toBe('Changing the host removes its sign-in. Enter it again for the new address.')
    // Its status, in Lumovi's words: forbidden, and a redirect to what isn't https or http.
    const tried = (url: string) =>
      page.evaluate(
        (url) =>
          window.lumovi!.helm.repositories.test({ kind: 'http', name: 't', url, signIn: null }),
        url,
      )
    expect(await tried(`${charts.base}/public/forbidden`)).toMatchObject({
      ok: false,
      error: { message: 'Not allowed: 403 Forbidden.' },
    })
    expect(await tried(`${charts.base}/public/ftp`)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Lumovi only fetches over https and http') },
    })

    await page.evaluate(() => (location.hash = '#/cluster/demo/helm?tab=repositories'))
    await page.getByRole('button', { name: /^Refresh/ }).click()
    const broken = row(page, 'Helm repositories', 'broken')
    await expect(broken).toContainText('Couldn’t read: 404 Not Found.')
    await page.getByRole('button', { name: /^Can’t read/ }).click()
    await expect(rows(page, 'Helm repositories')).toHaveCount(1)
    await page.getByRole('button', { name: /^Can’t read/ }).click()
    await broken.getByRole('button', { name: 'Actions for broken' }).click()
    await page.getByRole('menuitem', { name: 'Test connection' }).click()
    await expect(toasts(page)).toContainText('Couldn’t connect to broken')

    // Charts: from the repository picked; its versions newest first, as Semantic Versioning
    // orders them; icons that aren't an image, or are too large, stand aside for the initial.
    await openTab(page, 'Charts')
    await page.getByRole('combobox', { name: 'Repository' }).selectOption({ label: 'public' })
    await expect(rows(page, 'Charts')).toHaveCount(2)
    await row(page, 'Charts', 'beta').getByRole('gridcell').first().click()
    const versions = page
      .getByRole('complementary', { name: 'Chart beta' })
      .getByRole('listbox', { name: 'Versions' })
      .getByRole('option')
    await expect(versions).toHaveCount(7)
    expect((await versions.allTextContents()).map((v) => v.replace(/Latest.*/, '').trim())).toEqual(
      [
        '2.0.0-rc.10',
        '2.0.0-rc.1',
        '2.0.0-alpha.beta',
        '2.0.0-alpha.1',
        'v1.10.0',
        '1.9.0',
        'nightly',
      ],
    )
    await expect(page.getByRole('grid', { name: 'Charts' }).locator('img')).toHaveCount(0)
  } finally {
    charts.close()
  }
})

test('with no keychain to keep it in, no sign-in is taken, and Lumovi says why', async ({
  lumovi,
}) => {
  const { page, app } = lumovi
  await app.evaluate(({ safeStorage }) => {
    Object.assign(safeStorage, { isEncryptionAvailable: () => false })
  })
  await openCluster(page)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'Helm releases' })
    .click()
  await openTab(page, 'Repositories')
  await page.getByRole('button', { name: 'Add repository' }).click()
  const add = dialog(page)
  await add.getByLabel('Address').fill('https://charts.example.com')
  await expect(add.getByRole('checkbox', { name: 'It needs a sign-in' })).toBeDisabled()
  await expect(add).toContainText('Lumovi can’t keep a password here.')
  await expect(add).toContainText('This computer has no keychain Lumovi can use')
})
