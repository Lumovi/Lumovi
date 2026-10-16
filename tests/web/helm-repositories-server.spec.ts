/**
 * A server's chart repositories (LMV-354): the same for everyone who uses it, added only by its
 * admins, a sign-in sealed in its state and never sent to anyone's page; everyone else reads the
 * list, told who may change it, and the server refuses them whatever their page sends.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { generate } from 'selfsigned'
import { as } from './fleet.ts'
import { expect, test } from './fixtures.ts'

/** Never a real secret: what the test types as one, to look for where it mustn't be. */
const SECRET = 'not-a-real-password-9e4a'
const BASIC = `Basic ${Buffer.from(`anna:${SECRET}`).toString('base64')}`
const CHART = gzipSync(Buffer.from('demo'))

test('only a server’s admins add repositories; a sign-in is sealed on it, and everyone else reads the list', async ({
  page,
  context,
  serve,
}) => {
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
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-repositories-server-'))
  writeFileSync(join(dir, 'ca.pem'), pems.cert)
  const repository = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    if (req.headers.authorization !== BASIC) return void res.writeHead(401).end()
    if (req.url === '/charts/demo-1.0.0.tgz') return void res.end(CHART)
    res.end(
      JSON.stringify({
        entries: {
          demo: [
            {
              version: '1.0.0',
              urls: ['demo-1.0.0.tgz'],
              digest: createHash('sha256').update(CHART).digest('hex'),
            },
          ],
        },
      }),
    )
  })
  await new Promise<void>((resolve) => repository.listen(0, '127.0.0.1', resolve))
  const url = `https://127.0.0.1:${(repository.address() as AddressInfo).port}/charts`
  try {
    const served = await serve({
      env: {
        LUMOVI_AUTH: 'proxy',
        LUMOVI_ADMINS: 'platform-admins',
        LUMOVI_DATA_DIR: join(dir, 'data'),
        // (The test's repository is on this computer: a private address, to a server.)
        LUMOVI_ALLOW_PRIVATE_CHARTS: '1',
        NODE_EXTRA_CA_CERTS: join(dir, 'ca.pem'),
      },
    })
    await as(context, 'root@example.com', 'platform-admins')
    await page.goto(`${served.url}cluster/demo/helm?tab=repositories`)
    await page.getByRole('button', { name: 'Add repository' }).click()
    const add = page.getByRole('dialog')
    await expect(add).toContainText(
      'Helm repositories · kept on this server, for everyone who uses it',
    )
    await add.getByLabel('Name').fill('acme-charts')
    await add.getByLabel('Address').fill(url)
    await add.getByRole('checkbox', { name: 'It needs a sign-in' }).check()
    await add.getByLabel('Username').fill('anna')
    await add.getByLabel('Password').fill(SECRET)
    await expect(add).toContainText('Kept sealed on the server and never shown again, to anyone.')
    await add.getByRole('button', { name: 'Add repository' }).click()
    await expect(add).toBeHidden()
    const acme = page
      .getByRole('grid', { name: 'Helm repositories' })
      .getByRole('row')
      .filter({ hasText: 'acme-charts' })
    await expect(acme).toContainText('Saved')
    await expect(acme).toContainText('1')
    // A chart installed from it: the audit log names the repository, never its sign-in.
    const installed = await page.evaluate(async () => {
      const kept = await window.lumovi!.helm.repositories.list()
      const id = kept.ok ? kept.data.repositories[0]!.id : ''
      const deployed = await window.lumovi!.helm.deploy({
        context: 'demo',
        namespace: 'default',
        name: 'demo',
        source: { saved: id, chart: 'demo', version: '1.0.0' },
        values: '',
        install: true,
        dryRun: false,
      })
      const page = await window.lumovi!.audit.query({})
      return { id, deployed: deployed.ok, events: JSON.stringify(page.events) }
    })
    expect(installed.deployed).toBe(true)
    const events = JSON.parse(installed.events) as {
      action: string
      summary: string
      details?: Record<string, unknown>
    }[]
    const install = events.find((event) => event.action === 'helm.install')!
    expect(install.summary).toBe('Installed demo 1.0.0 from acme-charts as demo')
    expect(install.details).toMatchObject({
      chart: 'demo',
      version: '1.0.0',
      repository: 'acme-charts',
      repositoryId: installed.id,
    })
    expect(events.find((event) => event.action === 'helm-repository.added')!.details).toMatchObject(
      { signIn: 'set', username: 'anna' },
    )
    expect(installed.events).not.toContain(SECRET)
    // Sealed where the server keeps its state: not even its name in clear text.
    expect(readFileSync(join(dir, 'data', 'state.json'), 'utf8')).not.toMatch(
      new RegExp(`${SECRET}|acme-charts`),
    )

    // Someone who isn't an admin: the same list, read; told who may change it.
    await as(context, 'dana@example.com', 'developers')
    await page.reload()
    await expect(acme).toContainText('Saved')
    await expect(
      page.getByText(
        'Only Lumovi’s admins add repositories here. The server names them: platform-admins.',
      ),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add repository' })).toHaveCount(0)
    await expect(acme.getByRole('button', { name: 'Actions for acme-charts' })).toHaveCount(0)
    // Whatever their page sends, the server refuses it; and no answer holds the secret.
    const tried = await page.evaluate(
      async ([address]) => {
        const listed = await window.lumovi!.helm.repositories.list()
        const saved = await window.lumovi!.helm.repositories.save({
          name: 'mine',
          kind: 'http',
          url: address!,
          signIn: null,
        })
        return { listed: JSON.stringify(listed), saved }
      },
      [url],
    )
    expect(tried.saved).toMatchObject({
      ok: false,
      error: {
        message:
          'Only Lumovi’s admins add and change repositories here. The server names them: platform-admins.',
      },
    })
    expect(tried.listed).not.toContain(SECRET)
  } finally {
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
