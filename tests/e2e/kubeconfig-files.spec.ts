/**
 * The kubeconfig files the desktop app reads: chosen in Lumovi (in place of KUBECONFIG's, or
 * after them), removed, kept across a restart, back to the default, and never written; or kept
 * to the default by an organization's policy. Through the API the page uses, with the system's
 * file picker answered as the person would.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { DEMO_TOKEN, writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { expect, test } from './fixtures.ts'

/** A kubeconfig in a folder of its own, with one context (`name`) for the demo cluster. */
function kubeconfigFor(name: string, server: string, caPem: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), `lumovi-${name}-`))
  return writeKubeconfig(dir, {
    currentContext: name,
    clusters: [{ name, server, caPem }],
    users: [{ name, token: DEMO_TOKEN }],
    contexts: [{ name, cluster: name, user: name }],
  })
}

/** Answers the next file picker with `filePaths` (or cancels it). */
const answer = (app: ElectronApplication, filePaths: string[] | null) =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: filePaths === null,
      filePaths: filePaths ?? [],
    })) as unknown as typeof dialog.showOpenDialog
  }, filePaths)

const files = (page: Page) => page.evaluate(() => window.lumovi!.kubeconfigFiles!.list())
const contexts = (page: Page) =>
  page.evaluate(async () => (await window.lumovi!.kube.contexts()).contexts.map((c) => c.name))
const choose = (page: Page, how: 'replace' | 'add') =>
  page.evaluate((how) => window.lumovi!.kubeconfigFiles!.choose(how), how)

/** What a file is, to tell it wasn't written: its text and when it last changed. */
const state = (path: string) => ({
  text: readFileSync(path, 'utf8'),
  changed: statSync(path).mtimeMs,
})

test('kubeconfig files chosen in Lumovi replace KUBECONFIG’s or add to them, last a restart, and are never written', async ({
  launch,
  clusters,
}) => {
  const alpha = kubeconfigFor('alpha', clusters.demo.url, clusters.demo.caPem)
  const beta = kubeconfigFor('beta', clusters.demo.url, clusters.demo.caPem)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  const first = await launch({ userDataDir })
  const defaults = await files(first.page)
  // KUBECONFIG's, as the fixture sets it.
  expect(defaults).toMatchObject({ from: 'env', files: [{ exists: true }] })
  const before = [alpha, beta, defaults.files[0]!.path].map(state)

  // Chosen in place of KUBECONFIG's.
  await answer(first.app, [alpha])
  expect(await choose(first.page, 'replace')).toEqual({
    ok: true,
    data: { from: 'chosen', files: [{ path: alpha, exists: true, removable: true }] },
  })
  expect(await contexts(first.page)).toEqual(['alpha'])
  // Another after it; then no longer read.
  await answer(first.app, [beta])
  expect(await choose(first.page, 'add')).toEqual({
    ok: true,
    data: {
      from: 'chosen',
      files: [
        { path: alpha, exists: true, removable: true },
        { path: beta, exists: true, added: true, removable: true },
      ],
    },
  })
  expect(await contexts(first.page)).toEqual(['alpha', 'beta'])
  expect(
    await first.page.evaluate((beta) => window.lumovi!.kubeconfigFiles!.remove(beta), beta),
  ).toMatchObject({ ok: true, data: { files: [{ path: alpha }] } })
  expect(await contexts(first.page)).toEqual(['alpha'])
  // Cancelled: nothing changes.
  await answer(first.app, null)
  expect(await choose(first.page, 'replace')).toEqual({ ok: true, data: null })

  // Only one of those read is shown in Finder or Explorer: not any path the page names.
  await first.app.evaluate(({ shell }) => {
    const shown: string[] = []
    Object.assign(globalThis, { shown })
    shell.showItemInFolder = (path: string) => void shown.push(path)
  })
  await first.page.evaluate(
    async ([alpha, other]) => {
      await window.lumovi!.kubeconfigFiles!.show(alpha!)
      await window.lumovi!.kubeconfigFiles!.show(other!)
    },
    [alpha, beta],
  )
  expect(
    await first.app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown),
  ).toEqual([alpha])
  await first.app.close()

  // Kept across a restart.
  const again = await launch({ userDataDir })
  expect(await files(again.page)).toMatchObject({ from: 'chosen', files: [{ path: alpha }] })
  expect(await contexts(again.page)).toEqual(['alpha'])
  // Back to KUBECONFIG's.
  expect(
    await again.page.evaluate(() => window.lumovi!.kubeconfigFiles!.useDefault()),
  ).toMatchObject({ ok: true, data: { from: 'env' } })
  expect(await contexts(again.page)).toContain('demo')
  // None of them written, all along.
  expect([alpha, beta, defaults.files[0]!.path].map(state)).toEqual(before)
})

test('files added after KUBECONFIG’s go with whatever it is next; KUBECONFIG’s own aren’t Lumovi’s to remove', async ({
  launch,
  clusters,
}) => {
  const [alpha, beta, gamma] = ['alpha', 'beta', 'gamma'].map((name) =>
    kubeconfigFor(name, clusters.demo.url, clusters.demo.caPem),
  )
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  // Relative to where Lumovi started: listed where it is, as show and remove take it.
  const first = await launch({
    env: { KUBECONFIG: relative(process.cwd(), alpha!) },
    userDataDir,
  })
  expect(await files(first.page)).toEqual({ from: 'env', files: [{ path: alpha, exists: true }] })
  await first.app.evaluate(({ shell }) => {
    const shown: string[] = []
    Object.assign(globalThis, { shown })
    shell.showItemInFolder = (path: string) => void shown.push(path)
  })
  await first.page.evaluate((alpha) => window.lumovi!.kubeconfigFiles!.show(alpha), alpha!)
  expect(
    await first.app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown),
  ).toEqual([alpha])
  // KUBECONFIG's own: said why, and left as it is.
  expect(
    await first.page.evaluate((alpha) => window.lumovi!.kubeconfigFiles!.remove(alpha), alpha!),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining('is in KUBECONFIG') },
  })
  // One added after it.
  await answer(first.app, [beta!])
  expect(await choose(first.page, 'add')).toEqual({
    ok: true,
    data: {
      from: 'env',
      files: [
        { path: alpha, exists: true },
        { path: beta, exists: true, added: true, removable: true },
      ],
    },
  })
  await first.app.close()

  // KUBECONFIG is something else next time: that, then the one added.
  const next = await launch({ env: { KUBECONFIG: gamma! }, userDataDir })
  expect(await files(next.page)).toEqual({
    from: 'env',
    files: [
      { path: gamma, exists: true },
      { path: beta, exists: true, added: true, removable: true },
    ],
  })
  expect(await contexts(next.page)).toEqual(['gamma', 'beta'])
})

test('an organization’s policy keeps Lumovi to KUBECONFIG’s kubeconfig, and one that can’t be used does too', async ({
  launch,
  clusters,
}) => {
  const alpha = kubeconfigFor('alpha', clusters.demo.url, clusters.demo.caPem)
  const userDataDir = mkdtempSync(join(tmpdir(), 'lumovi-user-'))
  // Chosen before the policy came: kept for when it's gone, not read meanwhile.
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ kubeconfigFiles: [alpha] }))
  const policy = join(mkdtempSync(join(tmpdir(), 'lumovi-policy-')), 'policy.json')
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'locked' }))

  const locked = await launch({ env: { LUMOVI_POLICY: policy }, userDataDir })
  expect(await files(locked.page)).toMatchObject({
    from: 'env',
    locked: `Your organization’s policy (${policy}) keeps Lumovi to KUBECONFIG’s kubeconfig, or ~/.kube/config.`,
  })
  expect(await contexts(locked.page)).not.toContain('alpha')
  await answer(locked.app, [alpha])
  expect(await choose(locked.page, 'replace')).toMatchObject({
    ok: false,
    error: { code: 'not-allowed' },
  })
  expect(
    await locked.page.evaluate(() => window.lumovi!.kubeconfigFiles!.useDefault()),
  ).toMatchObject({ ok: false })
  await locked.app.close()
  expect(JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8'))).toMatchObject({
    kubeconfigFiles: [alpha],
  })

  // A policy that can't be used locks it too.
  writeFileSync(policy, JSON.stringify({ kubeconfigFiles: 'yes' }))
  const broken = await launch({ env: { LUMOVI_POLICY: policy }, userDataDir })
  expect((await files(broken.page)).locked).toContain('can’t be used')
  expect(await contexts(broken.page)).not.toContain('alpha')
  await broken.app.close()

  // The policy gone: what was chosen is read again.
  const free = await launch({ userDataDir })
  expect(await files(free.page)).toEqual({
    from: 'chosen',
    files: [{ path: alpha, exists: true, removable: true }],
  })
  expect(await contexts(free.page)).toEqual(['alpha'])
})
