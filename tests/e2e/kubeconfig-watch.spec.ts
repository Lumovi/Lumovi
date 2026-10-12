/**
 * Lumovi noticing its kubeconfig change on disk: a context added (written in place, or replaced
 * by a rename, as editors and CLIs write) shows within seconds without Reload, and a file caught
 * half-written keeps what it had. A folder of kubeconfigs: what's read, what's skipped and why,
 * files coming and going; its contexts' credentials that run a program asked first, as a pasted
 * cluster's are, and known again after a restart but not from another computer's settings. An
 * organization's policy keeps folders out.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { DEMO_TOKEN, writeKubeconfig, type KubeconfigSpec } from '../mock-cluster/kubeconfig.ts'
import { clusterOption, expect, test } from './fixtures.ts'

/** Within seconds, as a person would wait: never the 30 s of a slow refresh. */
const SOON = { timeout: 5_000 }

type Users = KubeconfigSpec['users'][number]

/** A kubeconfig of these contexts, each on the demo cluster with its token (or `user`). */
function spec(names: string[], server: string, caPem?: string, user?: Omit<Users, 'name'>) {
  return {
    currentContext: names[0],
    clusters: names.map((name) => ({ name, server, caPem })),
    users: names.map((name) => ({ name, ...(user ?? { token: DEMO_TOKEN }) })),
    contexts: names.map((name) => ({ name, cluster: name, user: name })),
  }
}

/** Written whole elsewhere, then put in its place, as editors and CLIs write. */
function replace(path: string, text: string) {
  writeFileSync(`${path}.new`, text)
  renameSync(`${path}.new`, path)
}

const contexts = (page: Page) =>
  page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts.map((c) => c.name))
const files = (page: Page) => page.evaluate(() => window.lumovi!.kubeconfigFiles!.list())
const version = (page: Page, context: string) =>
  page.evaluate((context) => window.lumovi!.kube.version(context), context)

/** Answers the next folder picker with `folder`. */
const answerFolder = (app: ElectronApplication, folder: string) =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [folder],
    })) as unknown as typeof dialog.showOpenDialog
  }, folder)

const addFolder = (page: Page) => page.evaluate(() => window.lumovi!.kubeconfigFiles!.addFolder())

/** What a file is, to tell it wasn't written: its text and when it last changed. */
const state = (path: string) => ({
  text: readFileSync(path, 'utf8'),
  changed: statSync(path).mtimeMs,
})

test('a context added to a kubeconfig shows within seconds, written in place or replaced, and a file caught half-written keeps what it had', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const dir = mkdtempSync(join(tmpdir(), 'lumovi-watched-'))
  const path = writeKubeconfig(dir, spec(['alpha'], url, caPem))
  const { page } = await launch({ env: { KUBECONFIG: path } })
  await expect(clusterOption(page, 'alpha')).toBeVisible()

  // Written in place (as kubectl config writes): there, without Reload.
  writeKubeconfig(dir, spec(['alpha', 'beta'], url, caPem))
  await expect(clusterOption(page, 'beta')).toBeVisible(SOON)

  // Replaced by a rename, twice: the folder's watched, not the file that was replaced.
  const elsewhere = mkdtempSync(join(tmpdir(), 'lumovi-'))
  replace(
    path,
    readFileSync(writeKubeconfig(elsewhere, spec(['alpha', 'beta', 'gamma'], url, caPem)), 'utf8'),
  )
  await expect(clusterOption(page, 'gamma')).toBeVisible(SOON)
  replace(
    path,
    readFileSync(
      writeKubeconfig(elsewhere, spec(['alpha', 'beta', 'gamma', 'delta'], url, caPem)),
      'utf8',
    ),
  )
  await expect(clusterOption(page, 'delta')).toBeVisible(SOON)
  writeKubeconfig(dir, spec(['alpha', 'beta', 'gamma'], url, caPem))
  await expect(clusterOption(page, 'delta')).toHaveCount(0, SOON)

  // Half-written: what it said when it last could be read is kept, said so, and its clusters stay.
  const whole = readFileSync(path, 'utf8')
  writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)))
  await expect
    .poll(async () => (await files(page)).files[0], SOON)
    .toMatchObject({ contexts: 3, problem: expect.any(String), keptFrom: expect.any(String) })
  for (const name of ['alpha', 'beta', 'gamma'])
    await expect(clusterOption(page, name)).toBeVisible()
  expect((await version(page, 'beta')).ok).toBe(true)
  await page.getByRole('button', { name: 'Kubeconfig files' }).click()
  const popover = page.getByRole('dialog', { name: 'Kubeconfig files' })
  await expect(popover).toContainText(
    /Couldn’t be read at .+: .+\. Its 3 contexts are as they were at .+, and still connect with the credentials it held then\./,
  )
  // Whole again: read as it is.
  writeFileSync(path, whole)
  await expect.poll(async () => (await files(page)).files[0], SOON).not.toHaveProperty('keptFrom')
  await expect(popover).toContainText('3 clusters')
  await expect(popover).toContainText('A change to them shows here within a second.')
})

test('a folder’s kubeconfigs are read, what isn’t one is skipped and said why, and files coming and going show by themselves', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-folder-'))
  const outside = mkdtempSync(join(tmpdir(), 'lumovi-outside-'))
  writeKubeconfig(folder, spec(['folder-a'], url, caPem), 'a.yaml')
  writeFileSync(join(folder, 'notes.md'), '# Our clusters\n')
  mkdirSync(join(folder, 'archive'))
  writeKubeconfig(join(folder, 'archive'), spec(['archived'], url, caPem), 'old.yaml')
  writeKubeconfig(folder, spec(['hidden'], url, caPem), '.hidden.yaml')
  writeKubeconfig(folder, spec(['swapped'], url, caPem), 'a.yaml.swp')
  writeFileSync(join(folder, 'big.yaml'), `kind: Config\n# ${'x'.repeat(1024 * 1024)}\n`)
  // Links: one out of the folder (not followed), one to a file inside it (read).
  const away = writeKubeconfig(outside, spec(['away'], url, caPem), 'away.yaml')
  let links = true
  try {
    symlinkSync(away, join(folder, 'link-out.yaml'), 'file')
    symlinkSync(join(folder, 'archive', 'old.yaml'), join(folder, 'link-in.yaml'), 'file')
  } catch {
    // (Windows without the right to make links.)
    links = false
  }
  const before = ['a.yaml', 'notes.md', 'big.yaml'].map((name) => state(join(folder, name)))

  const { app, page } = await launch()
  await answerFolder(app, folder)
  expect(await addFolder(page)).toMatchObject({
    ok: true,
    data: {
      folders: [
        {
          path: folder,
          files: [
            { name: 'a.yaml', contexts: 1 },
            ...(links ? [{ name: 'link-in.yaml', contexts: 1 }] : []),
          ],
          skipped: expect.arrayContaining([
            { name: '.hidden.yaml', why: 'hidden' },
            { name: 'a.yaml.swp', why: 'hidden' },
            { name: 'archive', why: 'folder' },
            { name: 'big.yaml', why: 'large' },
            { name: 'notes.md', why: 'not-kubeconfig' },
            ...(links ? [{ name: 'link-out.yaml', why: 'link-out' }] : []),
          ]),
        },
      ],
    },
  })
  expect(await contexts(page)).toEqual(
    expect.arrayContaining(['folder-a', ...(links ? ['archived'] : [])]),
  )
  for (const name of ['hidden', 'swapped', 'away']) expect(await contexts(page)).not.toContain(name)
  // A token's context works at once.
  expect(await version(page, 'folder-a')).toMatchObject({ ok: true })

  // In the popover: the folder, its kubeconfigs, and what it skipped, with why.
  await page.getByRole('button', { name: 'Kubeconfig files' }).click()
  const popover = page.getByRole('dialog', { name: 'Kubeconfig files' })
  await expect(popover).toContainText(
    links ? '2 kubeconfigs · 2 contexts' : '1 kubeconfig · 1 context',
  )
  await popover.getByRole('button', { name: /^\d+ skipped$/ }).click()
  const skipped = popover.getByRole('list', { name: 'Skipped' })
  await expect(skipped).toContainText('notes.mdNot a kubeconfig')
  await expect(skipped).toContainText('big.yamlLarger than 1 MB')
  await expect(skipped).toContainText(
    'archiveA folder: only the files directly in this one are read',
  )
  await page.keyboard.press('Escape')

  // One dropped in shows by itself; one taken away goes.
  writeKubeconfig(folder, spec(['folder-b'], url, caPem), 'b.yaml')
  await expect(clusterOption(page, 'folder-b')).toBeVisible(SOON)
  rmSync(join(folder, 'a.yaml'))
  await expect(clusterOption(page, 'folder-a')).toHaveCount(0, SOON)

  // Removed: nothing in it read any more, and nothing in it was written, all along.
  expect(
    await page.evaluate((folder) => window.lumovi!.kubeconfigFiles!.remove(folder), folder),
  ).toMatchObject({ ok: true, data: { folders: [] } })
  expect(await contexts(page)).not.toContain('folder-b')
  expect(['notes.md', 'big.yaml'].map((name) => state(join(folder, name)))).toEqual(before.slice(1))
})

test('a folder’s context whose credentials run a program asks first, runs nothing before, and asks again when its command changes; what’s allowed lasts a restart but not a move to another computer', async ({
  launch,
  clusters,
}) => {
  const { url, caPem } = clusters.demo
  const tools = mkdtempSync(join(tmpdir(), 'lumovi-plugin-'))
  const ran = join(tools, 'ran')
  const plugin = join(tools, 'credential.mjs')
  writeFileSync(
    plugin,
    `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(ran)}, 'ran\\n')
console.log(JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: ${JSON.stringify(DEMO_TOKEN)} } }))
`,
  )
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-folder-'))
  const runs = (args: string[]) =>
    spec(['plugged'], url, caPem, { exec: { command: process.execPath, args } })
  writeKubeconfig(folder, runs([plugin]), 'plugged.yaml')
  writeKubeconfig(folder, spec(['plain'], url, caPem), 'plain.yaml')
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))

  const first = await launch({ userDataDir })
  await answerFolder(first.app, folder)
  expect(await addFolder(first.page)).toMatchObject({
    ok: true,
    data: {
      folders: [
        {
          files: [
            { name: 'plain.yaml', contexts: 1 },
            { name: 'plugged.yaml', contexts: 1, asks: 1 },
          ],
        },
      ],
    },
  })
  // Not agreed to: refused before anything runs, and said so where it's used.
  expect(await version(first.page, 'plugged')).toMatchObject({
    ok: false,
    error: { code: 'consent' },
  })
  expect(existsSync(ran)).toBe(false)
  await expect(clusterOption(first.page, 'plugged')).toContainText('Asks before it runs')
  // Nor through a terminal: a folder's kubeconfigs aren't handed to kubectl.
  expect(
    await first.page.evaluate(() =>
      window.lumovi!.terminal.open('folder-terminal-1', { target: 'local', context: 'plugged' }),
    ),
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining('folder') } })
  // The plain one, at once.
  expect(await version(first.page, 'plain')).toMatchObject({ ok: true })

  // Pressed: what it'd run, as the add dialog shows it; allowed, it's opened, and runs.
  await clusterOption(first.page, 'plugged').click()
  const dialog = first.page.getByRole('dialog', { name: 'Allow “plugged” to sign in' })
  await expect(dialog).toContainText(plugin)
  expect(existsSync(ran)).toBe(false)
  await dialog.getByRole('button', { name: 'Allow and continue' }).click()
  await expect(first.page).toHaveURL(/#\/cluster\/plugged/)
  await expect.poll(() => existsSync(ran)).toBe(true)
  expect(await version(first.page, 'plugged')).toMatchObject({ ok: true })

  // Only what it does now can be agreed to: anything else is refused.
  expect(
    await first.page.evaluate(() =>
      window.lumovi!.kubeconfigFiles!.agree('plugged', ['0'.repeat(64)]),
    ),
  ).toMatchObject({ ok: false })

  // Its command changed (another argument): asked again, before it runs.
  writeKubeconfig(folder, runs([plugin, '--again']), 'plugged.yaml')
  await expect.poll(async () => (await version(first.page, 'plugged')).ok, SOON).toBe(false)
  expect(await version(first.page, 'plugged')).toMatchObject({ error: { code: 'consent' } })
  // Back as it was agreed to: allowed again.
  writeKubeconfig(folder, runs([plugin]), 'plugged.yaml')
  await expect.poll(async () => (await version(first.page, 'plugged')).ok, SOON).toBe(true)
  await first.app.close()

  // A restart: what was allowed is known again.
  const again = await launch({ userDataDir })
  expect(await version(again.page, 'plugged')).toMatchObject({ ok: true })
  // Settings taken to another computer (another key): what was allowed there isn't here.
  const settings = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))
  expect(settings.kubeconfigConsents).toBeDefined()
  // (Only digests: neither the program nor its arguments.)
  expect(JSON.stringify(settings.kubeconfigConsents)).not.toContain('credential')
  await again.app.close()
  const elsewhere = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(join(elsewhere, 'settings.json'), JSON.stringify(settings))
  const moved = await launch({ userDataDir: elsewhere })
  expect(await version(moved.page, 'plugged')).toMatchObject({
    ok: false,
    error: { code: 'consent' },
  })
  // A key that isn't one (the wrong size): a new one, and asked again; never taken as agreed.
  await moved.app.close()
  writeFileSync(join(userDataDir, 'consent.key'), 'short')
  const rekeyed = await launch({ userDataDir })
  expect(await version(rekeyed.page, 'plugged')).toMatchObject({
    ok: false,
    error: { code: 'consent' },
  })
  expect(statSync(join(userDataDir, 'consent.key')).size).toBe(32)
  // Nor one that's a link, though what it points at would pass: replaced by a key of its own.
  // (Links need more than a person's rights on Windows.)
  if (process.platform !== 'win32') {
    await rekeyed.app.close()
    const elsewhereKey = join(mkdtempSync(join(tmpdir(), 'lumovi-key-')), 'consent.key')
    writeFileSync(elsewhereKey, readFileSync(join(userDataDir, 'consent.key')), { mode: 0o600 })
    rmSync(join(userDataDir, 'consent.key'))
    symlinkSync(elsewhereKey, join(userDataDir, 'consent.key'), 'file')
    const linked = await launch({ userDataDir })
    await expect.poll(() => lstatSync(join(userDataDir, 'consent.key')).isFile()).toBe(true)
    // Nor a pipe: it doesn't hold Lumovi's start, waiting for what's never written.
    await linked.app.close()
    rmSync(join(userDataDir, 'consent.key'))
    execFileSync('mkfifo', [join(userDataDir, 'consent.key')])
    await launch({ userDataDir })
    await expect.poll(() => lstatSync(join(userDataDir, 'consent.key')).isFile()).toBe(true)
  }
})

test('an organization’s policy keeps folders out: none added, and those kept not read', async ({
  launch,
  clusters,
}) => {
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-folder-'))
  writeKubeconfig(folder, spec(['folder-a'], clusters.demo.url, clusters.demo.caPem), 'a.yaml')
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ kubeconfigFolders: [folder] }))
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))

  const { app, page } = await launch({ env: { LUMOVI_POLICY: policy }, userDataDir })
  expect(await files(page)).toMatchObject({ folders: [], locked: expect.any(String) })
  expect(await contexts(page)).not.toContain('folder-a')
  await answerFolder(app, folder)
  expect(await addFolder(page)).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
  await page.getByRole('button', { name: 'Kubeconfig files' }).click()
  await expect(page.getByRole('button', { name: 'Add a folder…' })).toHaveCount(0)
})

test('a folder’s kubeconfig is used whole: none of its contexts takes your user or cluster, none of yours takes one of its, and it can’t stand in for a cluster added in Lumovi', async ({
  launch,
  clusters,
}) => {
  const { demo, large } = clusters
  const OWN_TOKEN = 'the-person-own-token'
  // Your own: a user with its token inline, and a context naming a cluster none of yours defines.
  const kubeconfig = writeKubeconfig(mkdtempSync(join(tmpdir(), 'lumovi-own-')), {
    currentContext: 'mine',
    clusters: [{ name: 'mine', server: demo.url, caPem: demo.caPem }],
    users: [{ name: 'prod-admin', token: OWN_TOKEN }],
    contexts: [
      { name: 'mine', cluster: 'mine', user: 'prod-admin' },
      { name: 'prod', cluster: 'shared', user: 'prod-admin' },
    ],
  })
  // A cluster added in Lumovi, before the folder.
  const added = readFileSync(
    writeKubeconfig(
      mkdtempSync(join(tmpdir(), 'lumovi-')),
      spec(['added-one'], demo.url, demo.caPem),
    ),
    'utf8',
  )
  // Dropped in the folder: your user with its own server; a cluster for your context; the added
  // cluster's name on its own server; and a context wholly its own.
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-folder-'))
  writeKubeconfig(
    folder,
    {
      clusters: [
        { name: 'elsewhere', server: large.url, caPem: large.caPem },
        { name: 'shared', server: large.url, caPem: large.caPem },
      ],
      users: [{ name: 'its-own', token: 'the-folder-token' }],
      contexts: [
        { name: 'prod-copy', cluster: 'elsewhere', user: 'prod-admin' },
        // A name that would end its isolate and turn the sentence round, if it were let.
        { name: 'a\u2069\u202eb', cluster: 'elsewhere', user: 'prod-admin' },
        { name: 'added-one', cluster: 'elsewhere', user: 'its-own' },
        { name: 'its-own', cluster: 'elsewhere', user: 'its-own' },
      ],
    },
    'dropped.yaml',
  )
  // And one that defines your user's name itself: yours was there first, so it would get yours.
  writeKubeconfig(
    folder,
    {
      clusters: [{ name: 'steal-cluster', server: large.url, caPem: large.caPem }],
      users: [{ name: 'prod-admin', token: 'the-folder-token' }],
      contexts: [{ name: 'steal', cluster: 'steal-cluster', user: 'prod-admin' }],
    },
    'steal.yaml',
  )

  const { app, page } = await launch({ env: { KUBECONFIG: kubeconfig } })
  expect(
    await page.evaluate((text) => window.lumovi!.addedClusters!.add(text, { agreed: [] }), added),
  ).toMatchObject({ ok: true })
  await answerFolder(app, folder)
  expect(await addFolder(page)).toMatchObject({ ok: true })

  // Its context with your user: refused, said why, and not offered to be allowed.
  expect(await version(page, 'prod-copy')).toMatchObject({
    ok: false,
    error: {
      code: 'invalid',
      message:
        '“\u2068prod-copy\u2069” uses a user from another kubeconfig. A kubeconfig in a folder can only use its own.',
    },
  })
  expect(
    await page.evaluate(() => window.lumovi!.kubeconfigFiles!.asks('prod-copy')),
  ).toMatchObject({ ok: false })
  expect(await version(page, 'steal')).toMatchObject({
    ok: false,
    error: {
      code: 'invalid',
      message:
        '“\u2068steal\u2069” names a user “\u2068prod-admin\u2069” that another kubeconfig already has, so it would use that one. A kubeconfig in a folder can only use its own.',
    },
  })
  expect(await version(page, 'a\u2069\u202eb')).toMatchObject({
    error: {
      message:
        '“\u2068aU+2069U+202Eb\u2069” uses a user from another kubeconfig. A kubeconfig in a folder can only use its own.',
    },
  })
  // Your context with its cluster: refused too.
  expect(await version(page, 'prod')).toMatchObject({
    ok: false,
    error: {
      message:
        '“\u2068prod\u2069” takes its cluster from a kubeconfig in a folder, which only that file’s own contexts can use.',
    },
  })
  // The cluster added in Lumovi is still its own, on its own server.
  const listed = await page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts)
  expect(listed.find((context) => context.name === 'added-one')?.server).toBe(demo.url)
  expect(await version(page, 'added-one')).toMatchObject({ ok: true })
  // A context wholly the folder's own: used at once.
  expect(await version(page, 'its-own')).toMatchObject({ ok: true })
  // Each said on its file's row.
  const said = await files(page)
  expect(said.files[0]!.refused).toEqual([
    '“\u2068prod\u2069” takes its cluster from a kubeconfig in a folder, which only that file’s own contexts can use.',
  ])
  expect(said.folders[0]!.files[0]!.refused).toEqual([
    '“\u2068prod-copy\u2069” uses a user from another kubeconfig. A kubeconfig in a folder can only use its own.',
    '“\u2068aU+2069U+202Eb\u2069” uses a user from another kubeconfig. A kubeconfig in a folder can only use its own.',
  ])
  // Its server never saw your token, or the added cluster's.
  const sent = large.requests.map((request) => String(request.headers.authorization ?? ''))
  expect(sent.some((header) => header.includes(OWN_TOKEN))).toBe(false)
  expect(sent.some((header) => header.includes(DEMO_TOKEN))).toBe(false)
  expect(sent.some((header) => header.includes('the-folder-token'))).toBe(true)
})
