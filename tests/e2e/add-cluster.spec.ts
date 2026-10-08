/**
 * Adding a cluster on the clusters page, and editing one added in Lumovi: every context checked
 * and shown; what its credentials would do agreed to first, a server not verified before the
 * rest, shown exactly (characters that change how text reads, escaped); a failure said, never
 * left checking; nothing added once cancelled; a name taken added under another.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { stringify } from 'yaml'
import { DEMO_TOKEN } from '../mock-cluster/kubeconfig.ts'
import { clusterOption, DEMO, expect, test } from './fixtures.ts'

/** A kubeconfig: a context (`name`, or several) for a server, signing in as `user` says. */
function config(
  server: string,
  caPem: string | undefined,
  user: Record<string, unknown>,
  contexts: string[] = ['pasted'],
  cluster: Record<string, unknown> = {},
) {
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [
      {
        name: 'c',
        cluster: {
          server,
          ...(caPem ? { 'certificate-authority-data': Buffer.from(caPem).toString('base64') } : {}),
          ...cluster,
        },
      },
    ],
    users: [{ name: 'u', user }],
    contexts: contexts.map((name) => ({ name, context: { cluster: 'c', user: 'u' } })),
  })
}

/** A credential program here: notes each time it runs, after `ms`, and gives the demo token. */
function plugin(ms = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(dir, 'ran')
  const path = join(dir, 'credential.mjs')
  writeFileSync(
    path,
    `import { appendFileSync } from 'node:fs'
await new Promise((done) => setTimeout(done, ${ms}))
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  return { path, ran }
}

/** A server that notes what reaches it, and answers as a cluster would. */
async function standIn() {
  const seen: string[] = []
  const server = createServer((req, res) => {
    if (req.headers.authorization) seen.push(req.headers.authorization)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(req.url === '/version' ? { gitVersion: 'v9.9.9' } : { items: [] }))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => server.close(),
  }
}

/** Pasted in the add dialog, and checked. */
async function paste(page: Page, text: string) {
  await page.getByRole('button', { name: 'Add cluster' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('.cm-content').click()
  await page.keyboard.insertText(text)
  await dialog.getByRole('button', { name: 'Check it' }).click()
  return dialog
}

/** Lumovi's own files. */
const own = (userDataDir: string) => {
  const folder = join(realpathSync(userDataDir), 'clusters')
  return existsSync(folder) ? readdirSync(folder) : []
}

test('a name already read, with nothing to agree to, is added under the name given, not left checking', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch()
  await expect(clusterOption(page, 'demo')).toBeVisible()
  const dialog = await paste(
    page,
    config(clusters.demo.url, clusters.demo.caPem, { token: DEMO_TOKEN }, ['demo']),
  )
  await expect(page.getByRole('dialog', { name: 'demo-2 is ready' })).toBeVisible()
  // The rename isn't asked again once it's added: said.
  await expect(dialog.getByLabel('Add demo as')).toHaveCount(0)
  await expect(dialog).toContainText('demo was already read, so it’s added as demo-2')
})

test('a server whose certificate isn’t checked is said so, and added once allowed', async ({
  launch,
  clusters,
}) => {
  const { page } = await launch()
  await expect(clusterOption(page, 'demo')).toBeVisible()
  const dialog = await paste(
    page,
    config(clusters.demo.url, undefined, { token: DEMO_TOKEN }, ['skipped'], {
      'insecure-skip-tls-verify': true,
    }),
  )
  await expect(dialog).toContainText('Lumovi can’t check it’s the right server')
  await expect(dialog).toContainText('its certificate isn’t checked')
  await expect(dialog).not.toContainText('unencrypted')
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  await expect(page.getByRole('dialog', { name: 'skipped is ready' })).toBeVisible()
})

test('every context is checked and shown; a server not verified is agreed to first, then a program, in one go', async ({
  launch,
  clusters,
}) => {
  const server = await standIn()
  const { path, ran } = plugin()
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })
  await expect(clusterOption(page, 'demo')).toBeVisible()
  const text = config(
    server.url,
    undefined,
    {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1',
        command: process.execPath,
        args: [path],
        interactiveMode: 'Never',
      },
    },
    ['one', 'two'],
    { 'insecure-skip-tls-verify': true },
  )
  void clusters
  const dialog = await paste(page, text)
  // Each context's rows.
  await expect(dialog).toContainText('2 contexts: one, two')
  await expect(dialog.getByText('one', { exact: true })).toBeVisible()
  await expect(dialog.getByText('two', { exact: true })).toBeVisible()
  // The server first, over plain HTTP: said unencrypted (not a certificate unchecked), with
  // nothing sent.
  await expect(dialog).toContainText('Its credentials would travel unencrypted')
  await expect(dialog).toContainText('not encrypted')
  await expect(dialog).not.toContainText('certificate')
  expect(server.seen).toEqual([])
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  // Then the program, still not run.
  await expect(dialog).toContainText('Signing in runs a program on this computer')
  expect(existsSync(ran)).toBe(false)
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  await expect(page.getByRole('dialog', { name: /^one is ready$/ })).toBeVisible()
  expect(server.seen.length).toBeGreaterThan(0)
  expect(own(userDataDir)).toHaveLength(1)
  server.close()
})

test('what would run is shown exactly: each argument whole, characters that change how it reads escaped', async ({
  launch,
  clusters,
}) => {
  const { path } = plugin()
  const tokenFile = join(mkdtempSync(join(tmpdir(), 'lumovi-token-')), 'token')
  writeFileSync(tokenFile, DEMO_TOKEN)
  const { page } = await launch()
  await expect(clusterOption(page, 'demo')).toBeVisible()
  const dialog = await paste(
    page,
    stringify({
      apiVersion: 'v1',
      kind: 'Config',
      clusters: [
        {
          name: 'c',
          cluster: {
            server: clusters.demo.url,
            'certificate-authority-data': Buffer.from(clusters.demo.caPem!).toString('base64'),
          },
        },
      ],
      users: [
        {
          name: 'runs',
          user: {
            exec: {
              apiVersion: 'client.authentication.k8s.io/v1',
              command: process.execPath,
              // Reads as "--ok" reversed: shown for what it is.
              args: [path, '--note=‮ko-‬', 'two words'],
              interactiveMode: 'Never',
            },
          },
        },
        { name: 'sends', user: { 'token-file': tokenFile } },
      ],
      contexts: [
        { name: 'runs', context: { cluster: 'c', user: 'runs' } },
        { name: 'sends', context: { cluster: 'c', user: 'sends' } },
      ],
    }),
  )
  await expect(dialog).toContainText(
    'Signing in runs a program on this computer, and sends a file to its server',
  )
  await expect(dialog).toContainText('⟨U+202E⟩')
  await expect(dialog).toContainText('⟨U+202C⟩')
  // Each argument kept whole: broken only between them.
  await expect(dialog.getByText("'two words'", { exact: true })).toHaveClass(/inline-block/)
  await expect(dialog).toContainText(tokenFile)
})

test('a check that fails says why; Cancel while checking adds nothing', async ({
  launch,
  clusters,
}) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const { page } = await launch({ userDataDir })
  await expect(clusterOption(page, 'demo')).toBeVisible()
  // A certificate authority's file that isn't there: said.
  let dialog = await paste(
    page,
    config(clusters.demo.url, undefined, { token: DEMO_TOKEN }, ['pasted'], {
      'certificate-authority': join(tmpdir(), 'lumovi-no-such-ca.crt'),
    }),
  )
  await expect(dialog.getByRole('alert')).toContainText('isn’t there')
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // A slow program, allowed, then Cancel: closed, and nothing added after.
  const { path, ran } = plugin(1500)
  dialog = await paste(
    page,
    config(clusters.demo.url, clusters.demo.caPem, {
      exec: {
        apiVersion: 'client.authentication.k8s.io/v1',
        command: process.execPath,
        args: [path],
        interactiveMode: 'Never',
      },
    }),
  )
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => existsSync(ran), { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(500)
  expect(own(userDataDir)).toEqual([])
  await expect(clusterOption(page, 'pasted')).toHaveCount(0)
})

test('editing an added cluster: the one opened is the one checked, its secrets stay, ⌘N leaves it be, and its server moved is asked about', async ({
  launch,
  clusters,
}) => {
  const server = await standIn()
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  mkdirSync(join(userDataDir, 'x'), { recursive: true })
  const { page } = await launch({ userDataDir })
  await expect(clusterOption(page, 'demo')).toBeVisible()
  await paste(
    page,
    config(clusters.demo.url, clusters.demo.caPem, { token: DEMO_TOKEN }, ['first', 'second']),
  )
  await expect(page.getByRole('dialog', { name: 'first is ready' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The second one's settings, then its connection.
  await page.getByPlaceholder('Search clusters and labels…').fill('second')
  await expect(clusterOption(page, 'second')).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ControlOrMeta+i')
  await page.getByRole('dialog').getByRole('button', { name: 'Edit connection…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit connection' })
  await expect(dialog.locator('.cm-content')).toContainText('(kept by Lumovi)')
  // ⌘N leaves it as it is.
  await page.keyboard.press('ControlOrMeta+n')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Add a cluster' })).toHaveCount(0)
  // Escape in the editor's search closes the search, not the dialog.
  await dialog.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+f')
  await expect(dialog.locator('.cm-panel')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()

  await dialog.getByRole('button', { name: 'Check it' }).click()
  await expect(page.getByRole('dialog', { name: 'second is saved' })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Its server moved: its kept token goes there only once agreed to (and isn't verified there).
  await page.getByPlaceholder('Search clusters and labels…').fill('second')
  await page.keyboard.press('ControlOrMeta+i')
  await page.getByRole('dialog').getByRole('button', { name: 'Edit connection…' }).click()
  const editor = page.getByRole('dialog', { name: 'Edit connection' })
  await expect(editor.locator('.cm-content')).toContainText('(kept by Lumovi)')
  const moved = (await editor.locator('.cm-content').innerText())
    .replace(/server: https:\/\/[^\s]+/, `server: ${server.url}`)
    .replace(/certificate-authority-data: [^\s]+/, 'insecure-skip-tls-verify: true')
  await editor.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(moved)
  await editor.getByRole('button', { name: 'Check it' }).click()
  await expect(editor).toContainText('Its credentials would travel unencrypted')
  await editor.getByRole('button', { name: 'Allow and continue' }).click()
  await expect(editor).toContainText('sends what Lumovi kept to somewhere new')
  expect(server.seen).toEqual([])
  await editor.getByRole('button', { name: 'Allow and continue' }).click()
  await expect(page.getByRole('dialog', { name: 'second is saved' })).toBeVisible()
  expect(server.seen).toContain(`Bearer ${DEMO_TOKEN}`)
  server.close()
  void DEMO
})
