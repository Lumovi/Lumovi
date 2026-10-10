/**
 * Files copied out of containers and into them, in the desktop app: saved where their person
 * says and nowhere else, whatever the archive a container sends names; picked in the
 * system's dialog; and what the organization's policy, read-only mode and a production
 * cluster make of it.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { Crafted } from '../mock-cluster/files.ts'
import { writeKubeconfig } from '../mock-cluster/kubeconfig.ts'
import { dialog, menuAction, open, toasts } from './action-helpers.ts'
import { DEMO, DEMO_TOKEN, expect, openCluster, panel, test } from './fixtures.ts'

const POD = DEMO.pods.storefront[0]!
const IN = { context: 'demo', namespace: 'shop', pod: POD, container: 'app' }
const WINDOWS = process.platform === 'win32'
const scratch = () => mkdtempSync(join(tmpdir(), 'lumovi-files-'))

/** Answers the save dialog as `answer` says, after `afterMs`, instead of asking. */
function saveAs(
  app: ElectronApplication,
  answer: { canceled: boolean; filePath?: string },
  afterMs = 0,
) {
  return app.evaluate(
    ({ dialog }, { answer, afterMs }) => {
      dialog.showSaveDialog = (() =>
        new Promise((resolve) =>
          setTimeout(() => resolve(answer), afterMs),
        )) as unknown as typeof dialog.showSaveDialog
    },
    { answer, afterMs },
  )
}

/** Answers the open dialog with `path`, or as cancelled. */
function pickAs(app: ElectronApplication, path?: string) {
  return app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: path === undefined,
      filePaths: path === undefined ? [] : [path],
    })) as unknown as typeof dialog.showOpenDialog
  }, path)
}

/** What's shown in the file manager, from now on (nothing is, really). */
async function shown(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const shown: string[] = []
    Object.assign(globalThis, { shown })
    shell.showItemInFolder = (path: string) => void shown.push(path)
  })
  return () => app.evaluate(() => (globalThis as unknown as { shown: string[] }).shown)
}

interface Copied {
  error?: { code: string; message: string; reason?: string }
  end?: {
    outcome: string
    bytes: number
    files: number
    saved?: string
    error?: { code: string; message: string; reason?: string }
    leftOut?: { links: number; special: number; unnamed: number }
  }
}

/** A download asked of the page's api, to its end: how it began, or how it ended. */
const download = (page: Page, path: string) =>
  page.evaluate(
    async (request) => {
      const api = window.lumovi!
      const id = crypto.randomUUID()
      const ended = new Promise((resolve) => {
        const off = api.files.onEnd((its, end) => {
          if (its !== id) return
          off()
          resolve(end)
        })
      })
      const begun = await api.files.download(id, request)
      return (begun.ok ? { end: await ended } : { error: begun.error }) as never
    },
    { ...IN, path },
  ) as Promise<Copied>

/** An upload of what the open dialog answers, to its end. */
const upload = (page: Page, path: string, what: 'file' | 'folder' = 'file') =>
  page.evaluate(
    async ({ request, what }) => {
      const api = window.lumovi!
      const picked = await api.files.pick(what)
      if (!picked.ok) return { error: picked.error } as never
      if (!picked.data) return { error: { code: 'none', message: 'Nothing picked' } } as never
      const id = crypto.randomUUID()
      const ended = new Promise((resolve) => {
        const off = api.files.onEnd((its, end) => {
          if (its !== id) return
          off()
          resolve(end)
        })
      })
      const begun = await api.files.upload(id, { ...request, source: picked.data.handle })
      return (begun.ok ? { end: await ended } : { error: begun.error }) as never
    },
    { request: { ...IN, path }, what },
  ) as Promise<Copied>

const events = (page: Page, action: string) =>
  page
    .evaluate((action) => window.lumovi!.audit.query({ actions: [action as never] }), action)
    .then((found) => found.events.reverse())

async function downloadDialog(page: Page, path: string) {
  await menuAction(page, 'Pod', POD, 'Download files…')
  await dialog(page).getByLabel('File or folder in the container').fill(path)
  await dialog(page).getByRole('button', { name: 'Download' }).click()
}

test.describe('in a cluster', () => {
  test.beforeEach(async ({ page }) => {
    await openCluster(page)
    await open(page, 'Pods', POD)
  })

  test('a file and a folder are saved where their person says', async ({ lumovi, clusters }) => {
    const { page, app } = lumovi
    const dir = scratch()
    const inFolder = await shown(app)
    await saveAs(app, { canceled: false, filePath: join(dir, 'app.log') })
    await menuAction(page, 'Pod', POD, 'Download files…')
    await expect(dialog(page)).toContainText(
      'You choose where it’s saved once the container starts sending it. Links in a folder aren’t copied. It runs tar in the container, and changes nothing there.',
    )
    await dialog(page).getByLabel('File or folder in the container').fill('/var/log/app.log')
    await expect(dialog(page)).toContainText(
      `kubectl cp shop/${POD}:/var/log/app.log app.log -c app --context demo`,
    )
    await dialog(page).getByRole('button', { name: 'Download' }).click()
    await expect(dialog(page).getByRole('status')).toHaveText(
      `Downloaded /var/log/app.log from ${POD}1 file, 33 bytes.${join(dir, 'app.log')}`,
    )
    expect(readFileSync(join(dir, 'app.log'), 'utf8')).toBe('started\nlistening on :8080\nready\n')
    // Whole, under its own name: nothing else beside it.
    expect(readdirSync(dir)).toEqual(['app.log'])
    await dialog(page).getByRole('button', { name: 'Show in folder' }).click()
    expect(await inFolder()).toEqual([join(dir, 'app.log')])
    // Only what Lumovi saved is shown, whatever the page asks.
    await page.evaluate(() => window.lumovi!.files.show!('/etc/passwd'))
    expect(await inFolder()).toHaveLength(1)
    await dialog(page).getByRole('button', { name: 'Done' }).click()

    // A folder: its files and folders, as files and folders. Not its link, nor a file's
    // right to run as its owner.
    await saveAs(app, { canceled: false, filePath: join(dir, 'conf') })
    await downloadDialog(page, '/etc/app')
    await expect(dialog(page).getByRole('status')).toContainText(
      WINDOWS
        ? '3 files, 49 bytes. Left out: 1 link and 1 with a name this computer can’t use.'
        : '4 files, 69 bytes. Left out: 1 link.',
    )
    expect(readdirSync(dir).sort()).toEqual(['app.log', 'conf'])
    expect(readdirSync(join(dir, 'conf')).sort()).toEqual(['conf.d', 'config.yaml', 'run.sh'])
    expect(readdirSync(join(dir, 'conf', 'conf.d')).sort()).toEqual(
      WINDOWS ? ['10-limits.conf'] : ['10-limits.conf', 'CON'],
    )
    expect(readFileSync(join(dir, 'conf', 'config.yaml'), 'utf8')).toBe('port: 8080\nlog: info\n')
    if (!WINDOWS) expect(statSync(join(dir, 'conf', 'run.sh')).mode & 0o7777).toBe(0o755)
    await dialog(page).getByRole('button', { name: 'Done' }).click()

    // Never over a folder that's there: nothing in it is replaced.
    await downloadDialog(page, '/etc/app')
    await expect(dialog(page).getByRole('alert')).toHaveText(
      `${join(dir, 'conf')} is there already, and a folder isn’t copied over one. Save it under a new name.`,
    )
    // Nowhere chosen: nothing copied.
    await saveAs(app, { canceled: true })
    await dialog(page).getByRole('button', { name: 'Download' }).click()
    await expect(dialog(page).getByRole('alert')).toHaveText(
      'The copy was stopped. Nothing of it was kept.',
    )
    await page.keyboard.press('Escape')
    expect(readdirSync(dir).sort()).toEqual(['app.log', 'conf'])

    expect(
      clusters.demo.requests
        .filter((r) => r.path.endsWith('/exec'))
        .map((r) => new URLSearchParams(r.search).getAll('command').join(' ')),
    ).toEqual([
      'tar cf - -C /var/log -- ./app.log',
      'tar cf - -C /etc -- ./app',
      'tar cf - -C /etc -- ./app',
      'tar cf - -C /etc -- ./app',
    ])
    expect(await events(page, 'files.download')).toMatchObject([
      {
        outcome: 'success',
        cluster: 'demo',
        target: { kind: 'Pod', name: POD, namespace: 'shop' },
        summary: `Downloaded /var/log/app.log from Pod ${POD} (app): 1 file, 33 bytes`,
        details: { container: 'app', path: '/var/log/app.log', direction: 'download', bytes: 33 },
      },
      { outcome: 'success', summary: expect.stringContaining('Downloaded /etc/app') },
      { outcome: 'failure', error: expect.stringContaining('is there already') },
      { outcome: 'cancelled', summary: `Download /etc/app from Pod ${POD} (app)` },
    ])
  })

  test('an archive writes nothing outside where it’s saved, and nothing if it’s cut short', async ({
    lumovi,
    clusters,
  }) => {
    const { page, app } = lumovi
    const dir = scratch()
    const within = join(dir, 'within')
    mkdirSync(within)
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    await saveAs(app, { canceled: false, filePath: join(within, 'loot') })
    const tries: [name: string, answer: Crafted, said: RegExp][] = [
      [
        'a path that leads out',
        {
          entries: [
            { name: './loot/', type: 'directory' },
            { name: './loot/kept', content: 'kept' },
            { name: './loot/../../outside/evil', content: 'x' },
          ],
        },
        /which isn’t under \/loot\. Nothing of it was kept/,
      ],
      [
        'an absolute path',
        {
          entries: [
            { name: './loot/', type: 'directory' },
            { name: join(outside, 'evil'), content: 'x' },
          ],
        },
        /which isn’t under \/loot/,
      ],
      [
        'the same name twice',
        {
          entries: [
            { name: './loot/', type: 'directory' },
            { name: './loot/a', content: 'first' },
            { name: './loot/a', content: 'second' },
          ],
        },
        /^a is in it twice, as this computer reads names\. Nothing of it was kept\.$/,
      ],
      [
        'a file where a folder is',
        {
          entries: [
            { name: './loot/', type: 'directory' },
            { name: './loot/a', content: 'a file' },
            { name: './loot/a/b', content: 'under a file' },
          ],
        },
        /^This computer said: /,
      ],
      [
        'an archive cut short',
        {
          entries: [
            { name: './loot/', type: 'directory' },
            { name: './loot/whole', content: 'whole' },
            { name: './loot/half', content: 'x'.repeat(3000) },
          ],
          then: 'drop',
        },
        /The connection to the container closed before the copy was finished/,
      ],
      [
        'the container is killed as tar writes',
        {
          entries: [
            { name: './loot/', type: 'directory' },
            { name: './loot/whole', content: 'whole' },
            { name: './loot/half', content: 'x'.repeat(3000) },
          ],
          cut: true,
          stderr: 'Killed\n',
          exit: 137,
        },
        /^tar in app couldn’t read \/loot: Killed$/,
      ],
    ]
    for (const [name, answer, said] of tries) {
      clusters.demo.files.craft('/loot', answer)
      const copied = await download(page, '/loot')
      // It fails as it begins or as it ends, by how soon the container's word comes.
      if (copied.end) expect(copied.end.outcome, name).toBe('failed')
      expect((copied.error ?? copied.end?.error)?.message, name).toMatch(said)
      // Nothing of it is left, under any name; and nothing anywhere else.
      expect(readdirSync(within), name).toEqual([])
      expect(readdirSync(outside), name).toEqual([])
      expect(readdirSync(dir).sort(), name).toEqual(['outside', 'within'])
    }

    // A link is never written, so what's named through one is a file of the folder's own.
    clusters.demo.files.craft('/loot', {
      entries: [
        { name: './loot/', type: 'directory' },
        { name: './loot/out', type: 'symlink', linkname: outside },
        { name: './loot/out/pwned', content: 'under the folder' },
        { name: './loot/hosts', type: 'link', linkname: '/etc/hosts' },
        { name: './loot/hosts', content: 'a file of its own' },
        { name: './loot/tty', type: 'character-device', devmajor: 5, devminor: 0 },
        { name: './loot/setuid', content: '#!/bin/sh\n', mode: 0o6755 },
      ],
    })
    expect(await download(page, '/loot')).toMatchObject({
      end: {
        outcome: 'done',
        files: 3,
        saved: join(within, 'loot'),
        leftOut: { links: 2, special: 1, unnamed: 0 },
      },
    })
    const saved = join(within, 'loot')
    expect(readdirSync(saved).sort()).toEqual(['hosts', 'out', 'setuid'])
    expect(lstatSync(join(saved, 'out')).isDirectory()).toBe(true)
    expect(readFileSync(join(saved, 'out', 'pwned'), 'utf8')).toBe('under the folder')
    expect(lstatSync(join(saved, 'hosts')).isFile()).toBe(true)
    expect(readFileSync(join(saved, 'hosts'), 'utf8')).toBe('a file of its own')
    if (!WINDOWS) expect(statSync(join(saved, 'setuid')).mode & 0o7777).toBe(0o755)
    expect(readdirSync(outside)).toEqual([])
    expect(readdirSync(within)).toEqual(['loot'])

    // One file, cut short: no half of it under its name, or any other.
    rmSync(saved, { recursive: true })
    clusters.demo.files.craft('/loot', {
      entries: [{ name: './loot', content: 'x'.repeat(3000) }],
      then: 'drop',
    })
    const dropped = await download(page, '/loot')
    expect(dropped.error ?? dropped.end?.error).toMatchObject({ code: 'unreachable' })
    expect(readdirSync(within)).toEqual([])

    // Stopped by its person while it's arriving: the same.
    clusters.demo.files.craft('/loot', {
      entries: [{ name: './loot', content: 'x'.repeat(3000) }],
      then: 'hold',
    })
    await downloadDialog(page, '/loot')
    await expect(dialog(page).getByRole('progressbar')).toBeVisible()
    await expect.poll(() => readdirSync(within).length).toBe(1)
    await dialog(page).getByRole('button', { name: 'Stop' }).click()
    await expect(dialog(page).getByRole('alert')).toHaveText(
      'The copy was stopped. Nothing of it was kept.',
    )
    expect(readdirSync(within)).toEqual([])
  })

  test('a download goes on with its dialog hidden, and says how it ended', async ({
    lumovi,
    clusters,
  }) => {
    const { page, app } = lumovi
    const dir = scratch()
    const inFolder = await shown(app)
    // Its person takes a moment to say where: long enough to hide the dialog.
    await saveAs(app, { canceled: false, filePath: join(dir, 'heap.bin') }, 1500)
    await downloadDialog(page, '/data/heap.bin')
    await expect(dialog(page).getByRole('status')).toContainText(
      `Downloading /data/heap.bin from ${POD}0 bytes of 3 MiB`,
    )
    await dialog(page).getByRole('button', { name: 'Hide' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(toasts(page)).toContainText(`Downloaded /data/heap.bin from ${POD}1 file, 3 MiB.`)
    expect(statSync(join(dir, 'heap.bin')).size).toBe(3 * 1024 * 1024)
    await toasts(page).getByRole('button', { name: 'Show in folder' }).click()
    expect(await inFolder()).toEqual([join(dir, 'heap.bin')])

    // Stopped where it's saved, and failed: each said the same way.
    await saveAs(app, { canceled: true }, 1500)
    await downloadDialog(page, '/var/log/app.log')
    await dialog(page).getByRole('button', { name: 'Hide' }).click()
    await expect(toasts(page)).toContainText(
      `Stopped downloading /var/log/app.log from ${POD}The copy was stopped. Nothing of it was kept.`,
    )
    clusters.demo.files.craft('/loot', {
      entries: [
        { name: './loot/', type: 'directory' },
        { name: './loot/../evil', content: 'x' },
      ],
    })
    await saveAs(app, { canceled: false, filePath: join(dir, 'loot') }, 1500)
    await downloadDialog(page, '/loot')
    await dialog(page).getByRole('button', { name: 'Hide' }).click()
    await expect(toasts(page)).toContainText(`Couldn’t download /loot from ${POD}`)
    expect(readdirSync(dir)).toEqual(['heap.bin'])
  })

  test('a file and a folder are uploaded, as they were picked', async ({ lumovi, clusters }) => {
    const { page, app } = lumovi
    const dir = scratch()
    const report = join(dir, 'report.csv')
    writeFileSync(report, 'id,total\n1,20\n')
    chmodSync(report, 0o640)
    await menuAction(page, 'Pod', POD, 'Upload files…')
    await expect(dialog(page).getByRole('button', { name: 'Upload' })).toBeDisabled()
    // Nothing picked after all.
    await pickAs(app)
    await dialog(page).getByRole('button', { name: 'Choose a file…' }).click()
    await expect(dialog(page).locator('[data-picked]')).toHaveCount(0)
    await pickAs(app, report)
    await dialog(page).getByRole('button', { name: 'Choose a file…' }).click()
    await expect(dialog(page).locator('[data-picked]')).toHaveText('report.csv · 14 bytes')
    await expect(dialog(page).getByLabel('Folder in the container')).toHaveValue('/tmp')
    await expect(dialog(page)).toContainText(
      `kubectl cp report.csv shop/${POD}:/tmp/report.csv -c app --context demo`,
    )
    await dialog(page).getByRole('button', { name: 'Upload' }).click()
    await expect(dialog(page).getByRole('status')).toHaveText(
      `Uploaded report.csv to /tmp in ${POD}1 file, 14 bytes.`,
    )
    await dialog(page).getByRole('button', { name: 'Done' }).click()
    const [first] = clusters.demo.files.unpacked()
    expect(first!.bytes % 10240).toBe(0)
    expect(first).toMatchObject({
      folder: '/tmp',
      entries: [
        {
          name: 'report.csv',
          type: 'file',
          size: 14,
          mode: WINDOWS ? 0o644 : 0o640,
          content: 'id,total\n1,20\n',
        },
      ],
    })

    // A folder: what's in it, each folder before its files. A link in it isn't followed.
    const site = join(dir, 'site')
    mkdirSync(join(site, 'css'), { recursive: true })
    writeFileSync(join(site, 'index.html'), '<h1>shop</h1>')
    writeFileSync(join(site, 'css', 'site.css'), 'h1 { color: teal }')
    if (!WINDOWS) symlinkSync('/etc/hosts', join(site, 'hosts'))
    await pickAs(app, site)
    await menuAction(page, 'Pod', POD, 'Upload files…')
    await dialog(page).getByRole('button', { name: 'Choose a folder…' }).click()
    await expect(dialog(page).locator('[data-picked]')).toHaveText(
      WINDOWS ? 'site · 2 files, 31 bytes' : 'site · 2 files, 31 bytes · 1 link in it isn’t sent',
    )
    await dialog(page).getByLabel('Folder in the container').fill('/var/log')
    await dialog(page).getByRole('button', { name: 'Upload' }).click()
    await expect(dialog(page).getByRole('status')).toContainText('2 files, 31 bytes.')
    await dialog(page).getByRole('button', { name: 'Done' }).click()
    expect(
      clusters.demo.files.unpacked()[1]!.entries.map((entry) => `${entry.type} ${entry.name}`),
    ).toEqual([
      'directory site/',
      'directory site/css/',
      'file site/css/site.css',
      'file site/index.html',
    ])

    // What was picked is read as it's sent: gone since, it's said, and so is a pick that
    // isn't a file or a folder, or one Lumovi doesn't hold.
    await pickAs(app, report)
    const gone = page.evaluate(
      async (request) => {
        const api = window.lumovi!
        const picked = await api.files.pick('file')
        return picked.ok && picked.data ? { ...request, source: picked.data.handle } : undefined
      },
      { ...IN, path: '/tmp' },
    )
    const request = (await gone)!
    rmSync(report)
    const ended = page.evaluate(
      (request) =>
        new Promise((resolve) => {
          const id = crypto.randomUUID()
          window.lumovi!.files.onEnd((its, end) => its === id && resolve(end))
          void window.lumovi!.files.upload(id, request)
        }),
      request,
    )
    expect(await ended).toMatchObject({
      outcome: 'failed',
      error: { code: 'invalid', message: expect.stringMatching(/^This computer said: ENOENT/) },
    })
    await pickAs(app, join(dir, 'nothing-there'))
    expect((await upload(page, '/tmp')).error?.message).toMatch(/ENOENT/)
    expect(
      await page.evaluate((request) => window.lumovi!.files.upload(crypto.randomUUID(), request), {
        ...IN,
        path: '/tmp',
        source: 'not-a-pick',
      }),
    ).toMatchObject({
      ok: false,
      error: { message: 'Pick what to upload again: what was picked is no longer held' },
    })
    expect(
      await page.evaluate(() => window.lumovi!.files.pick('everything' as never)),
    ).toMatchObject({ ok: false, error: { code: 'invalid' } })

    expect(await events(page, 'files.upload')).toMatchObject([
      {
        outcome: 'success',
        summary: `Uploaded report.csv to /tmp in Pod ${POD} (app): 1 file, 14 bytes`,
        command: `kubectl cp report.csv shop/${POD}:/tmp/report.csv -c app --context demo`,
        details: { container: 'app', path: '/tmp', direction: 'upload', bytes: 14, files: 1 },
      },
      { outcome: 'success', details: { bytes: 31, files: 2 } },
      { outcome: 'failure' },
      // A pick Lumovi doesn't hold isn't a copy of anything, but it was asked for: refused.
      { outcome: 'refused', error: expect.stringContaining('what was picked is no longer held') },
    ])
  })

  test('read-only, a download still reads, and nothing is uploaded', async ({ lumovi }) => {
    const { page, app } = lumovi
    const dir = scratch()
    await page.keyboard.press('ControlOrMeta+k')
    await page.getByRole('option', { name: 'Make demo read-only' }).click()
    await panel(page, 'Pod', POD).getByRole('button', { name: 'More actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Download files…' })).toBeEnabled()
    await expect(page.getByRole('menuitem', { name: 'Upload files…' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await saveAs(app, { canceled: false, filePath: join(dir, 'app.log') })
    expect((await download(page, '/var/log/app.log')).end).toMatchObject({ outcome: 'done' })
    writeFileSync(join(dir, 'a.txt'), 'a')
    await pickAs(app, join(dir, 'a.txt'))
    expect(await upload(page, '/tmp')).toMatchObject({
      error: {
        code: 'read-only',
        message: 'demo is read-only in Lumovi. Allow changes to it to continue.',
      },
    })
    expect(await events(page, 'files.upload')).toMatchObject([{ outcome: 'refused' }])
  })
})

test('a production cluster takes its pod’s name, typed, before an upload', async ({
  launch,
  clusters,
}) => {
  const dir = scratch()
  const kubeconfig = writeKubeconfig(dir, {
    clusters: [{ name: 'demo', server: clusters.demo.url, caPem: clusters.demo.caPem }],
    users: [{ name: 'u', token: DEMO_TOKEN }],
    contexts: [{ name: 'shop-prod', cluster: 'demo', user: 'u' }],
  })
  const { page, app } = await launch({ env: { KUBECONFIG: kubeconfig } })
  await openCluster(page, 'shop-prod')
  await open(page, 'Pods', POD)
  writeFileSync(join(dir, 'a.txt'), 'a')
  await pickAs(app, join(dir, 'a.txt'))
  await menuAction(page, 'Pod', POD, 'Upload files…')
  await dialog(page).getByRole('button', { name: 'Choose a file…' }).click()
  await expect(dialog(page)).toContainText('Production')
  await expect(dialog(page).getByRole('button', { name: 'Upload' })).toBeDisabled()
  await dialog(page).getByLabel(`Type ${POD} to confirm`).fill(POD)
  await dialog(page).getByRole('button', { name: 'Upload' }).click()
  await expect(dialog(page).getByRole('status')).toContainText('1 file, 1 byte.')
  // A download reads: it asks for no name.
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  await menuAction(page, 'Pod', POD, 'Download files…')
  await expect(dialog(page).getByLabel(`Type ${POD} to confirm`)).toHaveCount(0)
})

/** A policy file, as IT would deploy it (LUMOVI_POLICY points at it, for trying one out). */
function policyFile(policy: unknown): string {
  const path = join(scratch(), 'policy.json')
  writeFileSync(path, JSON.stringify(policy))
  return path
}

test('an organization’s policy sets how much a copy carries, or turns copying off', async ({
  launch,
}) => {
  const limited = await launch({ env: { LUMOVI_POLICY: policyFile({ fileCopy: 1024 }) } })
  await openCluster(limited.page)
  await saveAs(limited.app, { canceled: false, filePath: join(scratch(), 'x') })
  expect(await download(limited.page, '/data/heap.bin')).toEqual({
    error: {
      code: 'invalid',
      reason: 'too-large',
      message:
        'That’s more than one copy carries here, which is 1 KiB. Your organization’s policy sets that (fileCopy).',
    },
  })
  expect((await download(limited.page, '/var/log/app.log')).end).toMatchObject({ outcome: 'done' })
  // More than it carries, picked to upload: said before anything is sent.
  const big = join(scratch(), 'big.bin')
  writeFileSync(big, Buffer.alloc(2048))
  await pickAs(limited.app, big)
  expect((await upload(limited.page, '/tmp')).error).toMatchObject({ reason: 'too-large' })
  await limited.close()

  const off = await launch({ env: { LUMOVI_POLICY: policyFile({ fileCopy: false }) } })
  await openCluster(off.page)
  expect(await download(off.page, '/var/log/app.log')).toMatchObject({
    error: {
      code: 'forbidden',
      message:
        'Copying files is turned off here. Your organization’s policy turns it off (fileCopy).',
    },
  })
  await off.close()

  // Anything else it says of it can't be used, and is said.
  const wrong = await launch({ env: { LUMOVI_POLICY: policyFile({ fileCopy: 'never' }) } })
  expect((await wrong.page.evaluate(() => window.lumovi!.app.settings())).managed?.problem).toMatch(
    /fileCopy must be false, or the most one copy of files carries: a number of bytes\.$/,
  )
})
