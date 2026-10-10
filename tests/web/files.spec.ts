/**
 * Files copied out of containers and into them, on a server: the browser's own download
 * and upload, what the cluster is asked to run for them, what's kept of an archive a
 * container sends (and what ends the copy), who may copy, and what's recorded.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { extract, type Header } from 'tar-stream'
import { PageFiles, Transfers } from '../../src/server/file-transfers.ts'
import type { Crafted } from '../mock-cluster/files.ts'
import { audited, DEMO, DEMO_TOKEN, expect, signIn, test, type Served } from './fixtures.ts'

const POD = DEMO.pods.storefront[0]!
const IN = { context: 'demo', namespace: 'shop', pod: POD, container: 'app' }
const detail = (page: Page) => page.getByRole('complementary', { name: `Pod ${POD}` })
const dialog = (page: Page) => page.getByRole('dialog')
/** How copies ended (or why they never began), as the audit log has it; and that they began. */
const ended = (served: Served, action?: string) =>
  audited(served, action).filter((event) => event.details?.stage !== 'began')
const began = (served: Served, action?: string) =>
  audited(served, action).filter((event) => event.details?.stage === 'began')

const podPage = (served: Served) => `${served.url}cluster/demo/pods?open=Pod/shop/${POD}`

async function action(page: Page, name: string) {
  await detail(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}

/** What the cluster was asked to run in the container, each time: tar's arguments. */
const ran = (clusters: { demo: { requests: { path: string; search: string }[] } }) =>
  clusters.demo.requests
    .filter((r) => r.path.endsWith('/exec'))
    .map((r) => new URLSearchParams(r.search).getAll('command'))
    .filter((command) => command[0] === 'tar')

interface Copied {
  error?: { code: string; message: string; reason?: string }
  end?: {
    outcome: string
    bytes: number
    files: number
    error?: { code: string; message: string; reason?: string }
    leftOut?: { links: number; special: number; unnamed: number }
    note?: string
  }
}

/** A download asked of the page's api, to its end: how it began, or how it ended. */
const download = (page: Page, path: string, container = 'app') =>
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
    { ...IN, container, path },
  ) as Promise<Copied>

/** The entries of a tar archive, and each file's text. */
async function entriesOf(file: string) {
  const reading = extract()
  const entries: { name: string; type: Header['type']; mode: number; text: string }[] = []
  reading.on('entry', (header, contents, next) => {
    const chunks: Buffer[] = []
    contents.on('data', (chunk) => chunks.push(chunk as Buffer))
    contents.on('end', () => {
      entries.push({
        name: header.name,
        type: header.type,
        mode: header.mode,
        text: Buffer.concat(chunks).toString('utf8'),
      })
      next()
    })
    contents.resume()
  })
  reading.end(readFileSync(file))
  await new Promise<void>((resolve) => reading.on('finish', () => resolve()))
  return entries
}

test('a file and a folder are downloaded by the browser, and recorded', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  await action(page, 'Download files…')
  await expect(dialog(page)).toContainText(
    'Your browser saves it: a folder comes as a .tar archive. Links in a folder aren’t copied. It runs tar in the container, and changes nothing there.',
  )
  // Nothing to download until there's a path.
  await expect(dialog(page).getByRole('button', { name: 'Download' })).toBeDisabled()
  await dialog(page).getByLabel('File or folder in the container').fill('/var/log/./app.log')
  await expect(dialog(page)).toContainText(
    `kubectl cp shop/${POD}:/var/log/app.log app.log -c app --context demo`,
  )
  const file = page.waitForEvent('download')
  await dialog(page).getByRole('button', { name: 'Download' }).click()
  const log = await file
  expect(log.suggestedFilename()).toBe('app.log')
  expect(readFileSync((await log.path())!, 'utf8')).toBe('started\nlistening on :8080\nready\n')
  await expect(dialog(page).getByRole('status')).toContainText(
    `Downloaded /var/log/app.log from ${POD}1 file, 33 bytes.`,
  )
  // tar, with the folder as -C's and the name after --, where no tar reads an option.
  expect(ran(clusters)).toEqual([['tar', 'cf', '-', '-C', '/var/log', '--', './app.log']])
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  // A folder: an archive made on the server of what's kept, not the container's own.
  await action(page, 'Download files…')
  await dialog(page).getByLabel('File or folder in the container').fill('/etc/app/')
  const folder = page.waitForEvent('download')
  await dialog(page).getByRole('button', { name: 'Download' }).click()
  const archive = await folder
  expect(archive.suggestedFilename()).toBe('app.tar')
  await expect(dialog(page).getByRole('status')).toContainText(
    '4 files, 69 bytes. Left out: 1 link.',
  )
  const entries = await entriesOf((await archive.path())!)
  expect(entries.map((entry) => `${entry.type} ${entry.name}`)).toEqual([
    'directory app/',
    'directory app/conf.d/',
    'file app/conf.d/10-limits.conf',
    'file app/conf.d/CON',
    'file app/config.yaml',
    'file app/run.sh',
  ])
  // A file that'd run as its owner there is one that only runs, here.
  expect(entries.at(-1)).toMatchObject({ mode: 0o755, text: '#!/bin/sh\nexec app\n' })
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  // Both are in the audit log: who, where, which path, how much. Not what was in them.
  await expect.poll(() => ended(served, 'files.download')).toHaveLength(2)
  expect(ended(served, 'files.download')).toMatchObject([
    {
      category: 'access',
      outcome: 'success',
      cluster: 'demo',
      target: { kind: 'Pod', name: POD, namespace: 'shop' },
      summary: `Downloaded /var/log/./app.log from Pod ${POD} (app): 1 file, 33 bytes`,
      command: `kubectl cp shop/${POD}:/var/log/app.log app.log -c app --context demo`,
      details: {
        container: 'app',
        path: '/var/log/./app.log',
        direction: 'download',
        bytes: 33,
        files: 1,
      },
    },
    {
      outcome: 'success',
      details: { path: '/etc/app/', bytes: 69, files: 4, leftOut: '1 link' },
    },
  ])
  // And that each began, before anything of it moved: one that never ends leaves that.
  expect(began(served, 'files.download')).toMatchObject([
    {
      outcome: 'success',
      summary: `Began to download /var/log/./app.log from Pod ${POD} (app)`,
      command: `kubectl cp shop/${POD}:/var/log/app.log app.log -c app --context demo`,
      details: { container: 'app', path: '/var/log/./app.log', direction: 'download' },
    },
    { summary: `Began to download /etc/app/ from Pod ${POD} (app)` },
  ])
  expect(audited(served, 'files.download').map((event) => event.details!.stage)).toEqual([
    'began',
    'ended',
    'began',
    'ended',
  ])
  expect(JSON.stringify(audited(served))).not.toContain('listening on')
})

test('a path is only ever a path, whatever it looks like', async ({ page, serve, clusters }) => {
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  // What would be an option to tar is the name of a file that isn't there.
  expect(await download(page, '--checkpoint-action=exec=sh')).toMatchObject({
    error: {
      code: 'not-found',
      message: expect.stringContaining('tar in app couldn’t read --checkpoint-action=exec=sh'),
    },
  })
  expect(await download(page, '-rf')).toMatchObject({ error: { code: 'not-found' } })
  // One that's there, named like one, is copied.
  expect(await download(page, '/data/-rf')).toMatchObject({ end: { outcome: 'done', files: 1 } })
  // Above where it starts, nul bytes, nothing: none reaches the cluster.
  for (const path of ['../etc/passwd', 'a/../../b', 'a\0b', '']) {
    expect(await download(page, path)).toMatchObject({ error: { code: 'invalid' } })
  }
  expect(ran(clusters)).toEqual([
    ['tar', 'cf', '-', '-C', './', '--', './--checkpoint-action=exec=sh'],
    ['tar', 'cf', '-', '-C', './', '--', './-rf'],
    ['tar', 'cf', '-', '-C', '/data', '--', './-rf'],
  ])
  // Each is recorded: the three that ran, and those turned down for where they lead, as
  // refused, with the path as it was given but nothing in it that isn't printable.
  await expect.poll(() => ended(served, 'files.download')).toHaveLength(6)
  expect(
    ended(served, 'files.download').map((event) => `${event.outcome} ${event.details!.path}`),
  ).toEqual([
    'failure --checkpoint-action=exec=sh',
    'failure -rf',
    'success /data/-rf',
    'refused ../etc/passwd',
    'refused a/../../b',
    'refused a\\u0000b',
  ])
  expect(ended(served, 'files.download').at(-1)).toMatchObject({
    target: { kind: 'Pod', name: POD, namespace: 'shop' },
    summary: `Download a\\u0000b from Pod ${POD} (app)`,
    error:
      'A path in the container is one that doesn’t lead above where it starts, and has no NUL in it.',
  })
})

const CRAFTED: [name: string, answer: Crafted, said: RegExp, reason?: string][] = [
  [
    'an absolute path',
    { entries: [{ name: '/etc/cron.d/evil', content: 'x' }] },
    /names “\/etc\/cron\.d\/evil”, which isn’t under \/loot/,
    'unsafe',
  ],
  [
    'a path that leads out',
    {
      entries: [
        { name: './loot/', type: 'directory' },
        { name: './loot/../../evil', content: 'x' },
      ],
    },
    /names “\.\/loot\/\.\.\/\.\.\/evil”, which isn’t under \/loot/,
    'unsafe',
  ],
  [
    'something else than was asked for',
    { entries: [{ name: './other', content: 'x' }] },
    /names “\.\/other”, which isn’t under \/loot/,
    'unsafe',
  ],
  [
    'more than the one file',
    {
      entries: [
        { name: './loot', content: 'x' },
        { name: './loot', content: 'y' },
      ],
    },
    /holds more than \/loot/,
    'unsafe',
  ],
  [
    'a file where the folder was',
    {
      entries: [
        { name: './loot/', type: 'directory' },
        { name: './loot', content: 'y' },
      ],
    },
    /holds more than \/loot/,
    'unsafe',
  ],
  [
    'only a link',
    { entries: [{ name: './loot', type: 'symlink', linkname: '/etc/shadow' }] },
    /\/loot is a link, and links aren’t followed/,
  ],
  [
    'only a device',
    { entries: [{ name: './loot', type: 'character-device', devmajor: 1, devminor: 3 }] },
    /\/loot is neither a file nor a folder/,
  ],
  [
    'what isn’t an archive',
    { raw: Buffer.alloc(2048, 'not a tar archive ') },
    /isn’t an archive as tar writes one/,
  ],
  [
    'an archive cut short',
    { entries: [{ name: './loot', content: 'x'.repeat(2000) }], then: 'drop' },
    /The connection to the container closed before the copy was finished/,
  ],
  [
    'tar failing',
    { stderr: 'tar: ./loot: Cannot open: Permission denied\n', exit: 2 },
    /tar in app couldn’t read \/loot: tar: \.\/loot: Cannot open: Permission denied/,
  ],
]

test('what a container sends isn’t trusted: only what was asked for is kept', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  for (const [name, answer, said, reason] of CRAFTED) {
    clusters.demo.files.craft('/loot', answer)
    const copied = await download(page, '/loot')
    const error = copied.error ?? copied.end?.error
    expect(error?.message, name).toMatch(said)
    expect(error?.reason, name).toBe(reason)
    if (copied.end) expect(copied.end.outcome, name).toBe('failed')
  }
  // Links and devices among a folder's files are left out, and said; the rest is kept.
  clusters.demo.files.craft('/loot', {
    entries: [
      { name: './loot/', type: 'directory' },
      { name: './loot/escape', type: 'symlink', linkname: '../../etc' },
      { name: './loot/hard', type: 'link', linkname: '/etc/shadow' },
      { name: './loot/null', type: 'character-device', devmajor: 1, devminor: 3 },
      { name: './loot/pipe', type: 'fifo' },
      { name: './loot/kept', content: 'kept', mode: 0o6755 },
    ],
  })
  const archive = page.waitForEvent('download')
  expect(await download(page, '/loot')).toMatchObject({
    end: { outcome: 'done', files: 1, bytes: 4, leftOut: { links: 2, special: 2, unnamed: 0 } },
  })
  expect(await entriesOf((await (await archive).path())!)).toEqual([
    { name: 'loot/', type: 'directory', mode: 0o755, text: '' },
    { name: 'loot/kept', type: 'file', mode: 0o755, text: 'kept' },
  ])
  // A file that grew as tar read it (a log) is whole as it was: said, not failed.
  clusters.demo.files.craft('/loot', {
    entries: [{ name: './loot', content: 'a line\n' }],
    stderr: 'tar: ./loot: file changed as we read it\n',
    exit: 1,
  })
  expect(await download(page, '/loot')).toMatchObject({
    end: {
      outcome: 'done',
      note: 'It changed while it was read: what was there when the copy began is whole.',
    },
  })
  const recorded = ended(served, 'files.download')
  expect(recorded.at(-2)).toMatchObject({
    details: { leftOut: '2 links and 2 devices or pipes' },
  })
  expect(recorded.at(-1)).toMatchObject({
    outcome: 'success',
    details: { note: expect.stringContaining('changed while it was read') },
  })
  expect(recorded.filter((event) => event.outcome === 'failure')).toHaveLength(CRAFTED.length)
})

test('the audit log has what happened, never what a container said or a file in a folder is called', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  const { files } = clusters.demo
  // tar says which file it couldn't read: said on the page, as text; not in the log.
  files.craft('/loot', {
    stderr:
      'tar: ./loot/payroll-2026.xlsx: Cannot open: Permission denied\n\u001b[31mtar: Exiting\n',
    exit: 2,
  })
  expect((await download(page, '/loot')).error).toMatchObject({
    message:
      'tar in app couldn’t read /loot: tar: ./loot/payroll-2026.xlsx: Cannot open: Permission denied \\u001b[31mtar: Exiting',
  })
  // An entry that isn't under what was asked for: named on the page, with nothing unprintable.
  files.craft('/loot', {
    entries: [
      { name: './loot/', type: 'directory' },
      { name: './elsewhere/keys\u0007.pem', content: 'x' },
    ],
  })
  const unsafe = await download(page, '/loot')
  expect((unsafe.error ?? unsafe.end?.error)?.message).toBe(
    'The archive from app names “./elsewhere/keys\\u0007.pem”, which isn’t under /loot. Nothing of it was kept.',
  )
  await expect.poll(() => ended(served, 'files.download')).toHaveLength(2)
  expect(ended(served, 'files.download').map((event) => event.error)).toEqual([
    'tar in the container failed as it read (it ended with 2).',
    'The archive from the container named something that isn’t under the path asked for. Nothing of it was kept.',
  ])
  expect(JSON.stringify(audited(served))).not.toMatch(/payroll|elsewhere|keys|\\u001b/)
})

test('a folder’s archive leaves out names that would lead elsewhere where it’s unpacked', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  clusters.demo.files.craft('/loot', {
    entries: [
      { name: './loot/', type: 'directory' },
      { name: './loot/..\\..\\startup.bat', content: 'x' },
      { name: './loot/C:\\Windows', content: 'x' },
      { name: './loot/c:autoexec', content: 'x' },
      { name: './loot/bell\u0007', content: 'x' },
      { name: './loot/line\nbreak', content: 'x' },
      { name: './loot/notes: a colon later is no drive', content: 'kept' },
      { name: './loot/kept.txt', content: 'kept' },
    ],
  })
  const archive = page.waitForEvent('download')
  expect((await download(page, '/loot')).end).toMatchObject({
    outcome: 'done',
    files: 2,
    leftOut: { links: 0, special: 0, unnamed: 5 },
  })
  expect((await entriesOf((await (await archive).path())!)).map((entry) => entry.name)).toEqual([
    'loot/',
    'loot/notes: a colon later is no drive',
    'loot/kept.txt',
  ])
  expect(ended(served, 'files.download').at(-1)).toMatchObject({
    details: { leftOut: expect.stringContaining('5') },
  })
})

test('a copy has a size limit, can be stopped, and doesn’t wait for ever', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve({
    env: { LUMOVI_FILE_COPY_MAX_BYTES: '1048576', LUMOVI_FILE_COPY_IDLE_MS: '400' },
  })
  await signIn(page, podPage(served), DEMO_TOKEN)
  // More than a copy carries: said with what the limit is, and how it's set.
  expect(await download(page, '/data/heap.bin')).toEqual({
    error: {
      code: 'invalid',
      reason: 'too-large',
      message:
        'That’s more than one copy carries here, which is 1 MiB. LUMOVI_FILE_COPY_MAX_BYTES sets that where Lumovi runs, in bytes (off turns copying off).',
    },
  })
  // A folder's files add up to it too.
  expect((await download(page, '/data')).end).toMatchObject({
    outcome: 'failed',
    error: { reason: 'too-large' },
  })
  // What a container says a file's size is counts before any of it is read.
  clusters.demo.files.craft('/loot', {
    entries: [
      { name: './loot/', type: 'directory' },
      { name: './loot/small', content: 'x' },
      { name: './loot/big', content: Buffer.alloc(1024 * 1024) },
    ],
  })
  expect((await download(page, '/loot')).end).toMatchObject({
    outcome: 'failed',
    files: 1,
    error: { reason: 'too-large' },
  })

  // One that stops arriving is stopped. (Its name is a log's: on Windows, a browser gives up
  // a download a script began whose name has no ending it knows, which would stop it first.)
  clusters.demo.files.craft('/held.log', {
    entries: [{ name: './held.log', content: 'x'.repeat(4000) }],
    then: 'hold',
  })
  expect((await download(page, '/held.log')).end).toMatchObject({
    outcome: 'failed',
    error: { code: 'timeout', message: 'Nothing moved for 0s, so the copy was stopped.' },
  })

  // Stopped by its person, in its dialog: said, and the form is there again.
  await action(page, 'Download files…')
  await dialog(page).getByLabel('File or folder in the container').fill('/loot')
  await page.evaluate(() => (HTMLAnchorElement.prototype.click = () => undefined))
  await dialog(page).getByRole('button', { name: 'Download' }).click()
  await expect(dialog(page).getByRole('progressbar')).toBeVisible()
  await dialog(page).getByRole('button', { name: 'Stop' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'The copy was stopped. Nothing of it was kept.',
  )
  await expect(dialog(page).getByLabel('File or folder in the container')).toHaveValue('/loot')
  await expect
    .poll(() => ended(served, 'files.download').at(-1))
    .toMatchObject({ outcome: 'cancelled', summary: `Download /loot from Pod ${POD} (app)` })
})

test('a copy cut short takes nothing down, and nothing of it is kept', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({
    env: { LUMOVI_FILE_COPY_MAX_BYTES: '1048576', LUMOVI_FILE_COPY_IDLE_MS: '1500' },
  })
  await signIn(page, podPage(served), DEMO_TOKEN)
  const { files } = clusters.demo
  // More than a copy carries, to put in: said before anything is run.
  expect(await upload(page, '/tmp', 1024 * 1024 + 1)).toMatchObject({
    error: { code: 'invalid', reason: 'too-large' },
  })
  expect(ran(clusters)).toEqual([])

  // The container is killed as its tar writes.
  const loot = [{ name: './loot', content: 'x'.repeat(4000) }]
  files.craft('/loot', { entries: loot, cut: true, stderr: 'Killed\n', exit: 137 })
  expect((await download(page, '/loot')).end).toMatchObject({
    outcome: 'failed',
    files: 0,
    error: { message: 'tar in app couldn’t read /loot: Killed' },
  })
  // Its pod is gone: the connection closes without tar's word.
  files.craft('/loot', { entries: loot, then: 'drop' })
  const gone = await download(page, '/loot')
  expect(gone.error ?? gone.end?.error).toMatchObject({ code: 'unreachable' })
  // It stops with part of a file sent on to the browser: the browser's download fails, and
  // it keeps no file.
  // (A log by its name, for the browser to keep at it on Windows.)
  files.craft('/held.log', {
    entries: [{ name: './held.log', content: 'x'.repeat(4000) }],
    then: 'hold',
  })
  const partial = page.waitForEvent('download')
  const stopped = download(page, '/held.log')
  const failure = (await partial).failure()
  expect((await stopped).end).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } })
  expect(await failure).not.toBeNull()
  // The same, as files are put in.
  files.interrupt('/tmp', 'exit')
  expect((await upload(page, '/tmp', 200_000)).end).toMatchObject({ outcome: 'failed' })
  files.interrupt('/tmp', 'drop')
  expect((await upload(page, '/tmp', 200_000)).end).toMatchObject({
    outcome: 'failed',
    error: { code: 'unreachable' },
  })

  // The page goes away with a copy each way under way: both are stopped.
  files.craft('/loot', { entries: loot, then: 'hold' })
  files.interrupt('/tmp', 'hold')
  const before = ran(clusters).length
  void download(page, '/loot').catch(() => undefined)
  void upload(page, '/tmp', 200_000).catch(() => undefined)
  await expect.poll(() => ran(clusters).length).toBe(before + 2)
  await page.close()
  const copies = () =>
    audited(served)
      .filter((event) => event.action.startsWith('files.') && event.details?.stage !== 'began')
      .map((event) => `${event.action} ${event.outcome}`)
  await expect.poll(copies).toHaveLength(8)
  expect(copies().slice(1, 6)).toEqual([
    'files.download failure',
    'files.download failure',
    'files.download failure',
    'files.upload failure',
    'files.upload failure',
  ])
  // The two that were under way, in whichever order they were stopped.
  expect(copies().slice(6).sort()).toEqual(['files.download cancelled', 'files.upload cancelled'])

  // And the server is as it was: it copies for whoever comes next.
  const next = await context.newPage()
  await next.goto(podPage(served))
  expect((await download(next, '/var/log/app.log')).end).toMatchObject({ outcome: 'done' })
  expect(served.log()).not.toMatch(/\n\s+at .+:\d+:\d+\)?\n/)
})

test('a copy’s address works once, soon, and only for whoever asked', async ({
  page,
  browser,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_FILE_COPY_CLAIM_MS: '3000' } })
  await signIn(page, podPage(served), DEMO_TOKEN)
  // The browser's own download held back, to try the address before it: its link isn't followed.
  await page.evaluate(() => {
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      ;(window as unknown as { held: string }).held = this.href
    }
  })
  const address = () => page.evaluate(() => (window as unknown as { held?: string }).held ?? '')
  const copying = download(page, '/var/log/app.log')
  await expect.poll(address).toContain('/api/files/')
  // Nobody signed in, and someone else: told the same as for an address that never was.
  const other: BrowserContext = await browser.newContext()
  const stranger = await other.request.get(await address())
  expect(stranger.status()).toBe(404)
  const unknown = await page.request.get(`${served.url}api/files/${'A'.repeat(43)}`)
  expect([unknown.status(), await unknown.json()]).toEqual([
    404,
    { error: 'There’s no such copy here: it was fetched already, or took too long. Try again.' },
  ])
  // Not as an upload either.
  expect((await page.request.post(await address(), { data: 'x' })).status()).toBe(404)
  // Whoever asked for it, once.
  const fetched = await page.request.get(await address())
  expect(fetched.status()).toBe(200)
  expect(fetched.headers()).toMatchObject({
    'content-disposition': `attachment; filename="app.log"; filename*=UTF-8''app.log`,
    'content-type': 'application/octet-stream',
    'content-length': '33',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  expect(await fetched.text()).toContain('listening on :8080')
  expect((await page.request.get(await address())).status()).toBe(404)
  expect((await copying).end).toMatchObject({ outcome: 'done', bytes: 33 })
  await other.close()

  // One that's stopped, or whose container goes away, before the browser fetches it: its
  // address is no copy's from then on.
  const before = await address()
  clusters.demo.files.craft('/loot', {
    entries: [{ name: './loot', content: 'x'.repeat(4000) }],
    then: 'hold',
  })
  const id = await page.evaluate(
    async (request) => {
      const id = crypto.randomUUID()
      await window.lumovi!.files.download(id, request)
      return id
    },
    { ...IN, path: '/loot' },
  )
  await expect.poll(address).not.toBe(before)
  await page.evaluate((id) => window.lumovi!.files.cancel(id), id)
  await expect.poll(() => ended(served, 'files.download').at(-1)?.outcome).toBe('cancelled')
  expect((await page.request.get(await address())).status()).toBe(404)
  clusters.demo.files.craft('/loot', {
    entries: [{ name: './loot', content: 'x'.repeat(4000) }],
    cut: true,
    stderr: 'Killed\n',
    exit: 137,
  })
  const stopped = await address()
  expect((await download(page, '/loot')).end).toMatchObject({ outcome: 'failed' })
  expect(await address()).not.toBe(stopped)
  expect((await page.request.get(await address())).status()).toBe(404)

  // One the browser never fetches is given up on.
  expect((await download(page, '/var/log/app.log')).end).toMatchObject({
    outcome: 'failed',
    error: {
      code: 'timeout',
      message: expect.stringContaining('The browser didn’t fetch it in time'),
    },
  })
})

test('a file and a folder are uploaded from the browser, and recorded', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  await action(page, 'Upload files…')
  await expect(dialog(page)).toContainText(
    'It’s put in that folder, which must be there. Files there with the same names are replaced. It runs tar in the container.',
  )
  await expect(dialog(page).getByRole('button', { name: 'Upload' })).toBeDisabled()
  // Nothing picked after all: nothing changes.
  const none = page.waitForEvent('filechooser')
  await dialog(page).getByRole('button', { name: 'Choose a file…' }).click()
  await (await none).setFiles([])
  const chooser = page.waitForEvent('filechooser')
  await dialog(page).getByRole('button', { name: 'Choose a file…' }).click()
  await (
    await chooser
  ).setFiles({
    name: 'report.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('id,total\n1,20\n'),
  })
  await expect(dialog(page).locator('[data-picked]')).toHaveText('report.csv · 14 bytes')
  await dialog(page).getByLabel('Folder in the container').fill('/tmp/')
  await expect(dialog(page)).toContainText(
    `kubectl cp report.csv shop/${POD}:/tmp/report.csv -c app --context demo`,
  )
  await dialog(page).getByRole('button', { name: 'Upload' }).click()
  await expect(dialog(page).getByRole('status')).toContainText(
    `Uploaded report.csv to /tmp in ${POD}1 file, 14 bytes.`,
  )
  await dialog(page).getByRole('button', { name: 'Done' }).click()
  expect(ran(clusters)).toEqual([['tar', 'xmf', '-', '-C', '/tmp']])
  const [first] = clusters.demo.files.unpacked()
  // In whole records, as tar reads them, and with the file as it was picked.
  expect(first!.bytes % 10240).toBe(0)
  expect(first).toMatchObject({
    namespace: 'shop',
    pod: POD,
    container: 'app',
    folder: '/tmp',
    entries: [
      { name: 'report.csv', type: 'file', size: 14, mode: 0o644, content: 'id,total\n1,20\n' },
    ],
  })

  // A folder, with what's in it, each folder before its files; an empty file too.
  const picked = join(mkdtempSync(join(tmpdir(), 'lumovi-upload-')), 'site')
  mkdirSync(join(picked, 'css'), { recursive: true })
  writeFileSync(join(picked, 'index.html'), '<h1>shop</h1>')
  writeFileSync(join(picked, 'css', 'site.css'), 'h1 { color: teal }')
  writeFileSync(join(picked, 'css', 'empty.css'), '')
  await action(page, 'Upload files…')
  const folder = page.waitForEvent('filechooser')
  await dialog(page).getByRole('button', { name: 'Choose a folder…' }).click()
  await (await folder).setFiles(picked)
  await expect(dialog(page).locator('[data-picked]')).toHaveText('site · 3 files, 31 bytes')
  await dialog(page).getByLabel('Folder in the container').fill('/var/log')
  await dialog(page).getByRole('button', { name: 'Upload' }).click()
  await expect(dialog(page).getByRole('status')).toContainText('3 files, 31 bytes.')
  expect(
    clusters.demo.files.unpacked()[1]!.entries.map((entry) => `${entry.type} ${entry.name}`),
  ).toEqual([
    'directory site/',
    'directory site/css/',
    'file site/css/empty.css',
    'file site/css/site.css',
    'file site/index.html',
  ])
  await dialog(page).getByRole('button', { name: 'Done' }).click()

  // A folder that isn't there, and one that can't be written to: tar's own words.
  await action(page, 'Upload files…')
  const again = page.waitForEvent('filechooser')
  await dialog(page).getByRole('button', { name: 'Choose a file…' }).click()
  await (await again).setFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') })
  await dialog(page).getByLabel('Folder in the container').fill('--to-command=sh')
  await dialog(page).getByRole('button', { name: 'Upload' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText(
    "tar in app couldn’t write to --to-command=sh: tar: can't change directory",
  )
  // The same pick is sent again.
  await dialog(page).getByLabel('Folder in the container').fill('/readonly')
  await dialog(page).getByRole('button', { name: 'Upload' }).click()
  await expect(dialog(page).getByRole('alert')).toContainText(
    'Read-only file system Some of it may be there already.',
  )
  expect(ran(clusters).slice(2)).toEqual([
    ['tar', 'xmf', '-', '-C', './--to-command=sh'],
    ['tar', 'xmf', '-', '-C', '/readonly'],
  ])

  await expect.poll(() => ended(served, 'files.upload')).toHaveLength(4)
  expect(ended(served, 'files.upload')).toMatchObject([
    {
      category: 'change',
      outcome: 'success',
      target: { kind: 'Pod', name: POD, namespace: 'shop' },
      summary: `Uploaded report.csv to /tmp/ in Pod ${POD} (app): 1 file, 14 bytes`,
      command: `kubectl cp report.csv shop/${POD}:/tmp/report.csv -c app --context demo`,
      details: { container: 'app', path: '/tmp/', direction: 'upload', bytes: 14, files: 1 },
    },
    { outcome: 'success', details: { bytes: 31, files: 3 } },
    { outcome: 'failure', summary: `Upload a.txt to --to-command=sh in Pod ${POD} (app)` },
    { outcome: 'failure' },
  ])
  expect(JSON.stringify(audited(served))).not.toContain('id,total')
})

test('a container without tar says so, and what reaches its files instead', async ({
  page,
  serve,
  clusters,
}) => {
  const pod = clusters.demo.object('Pod', 'shop', POD)!
  pod.status.containerStatuses[0].image = 'gcr.io/distroless/static-debian12:nonroot'
  clusters.demo.upsert(pod)
  const served = await serve()
  await signIn(page, podPage(served), DEMO_TOKEN)
  await action(page, 'Download files…')
  await dialog(page).getByLabel('File or folder in the container').fill('/etc/app/config.yaml')
  await dialog(page).getByRole('button', { name: 'Download' }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    `app has no tar, which copying files needs, as kubectl cp does. A debug container with tools, started beside it, sees its files under /proc/1/root:kubectl debug -it ${POD} --image=busybox --target=app -n shop --context demoOr use Debug… in this pod’s actions, then copy from it.`,
  )
  await page.keyboard.press('Escape')
  await expect
    .poll(() => ended(served, 'files.download'))
    .toMatchObject([{ outcome: 'failure', error: expect.stringContaining('app has no tar') }])

  // A Windows container has none either: said before anything is tried.
  pod.spec.os = { name: 'windows' }
  clusters.demo.upsert(pod)
  await page.reload()
  await action(page, 'Upload files…')
  await expect(dialog(page)).toContainText(
    'Copying files isn’t supported for Windows containers: it runs tar in the container, and they have none.',
  )
  await expect(dialog(page).getByRole('button', { name: 'Upload' })).toBeDisabled()
})

test('what a page says it will upload is held for the copy it’s for, and no longer', () => {
  // (The server's own, without a server: nothing outside it can see what it holds.)
  const files = new PageFiles(new Transfers(), 'ada@example.com')
  const said = {
    name: 'report.csv',
    entries: [{ names: ['report.csv'], folder: false, size: 14 }],
  }
  // A copy takes it, once.
  const taken = files.picked(said)
  const sending = files.sending('copy-1', taken)
  expect(sending).toMatchObject({ name: 'report.csv', files: 1, bytes: 14 })
  sending!.close()
  expect(files.sending('copy-2', taken)).toBeUndefined()
  // An upload that's refused lets go of it: its handle is nothing's afterwards.
  const refused = files.picked(said)
  files.forget(refused)
  expect(files.sending('copy-3', refused)).toBeUndefined()
  // It's checked when a copy takes it, after whether its person may upload at all; and one
  // that isn't what a page may say isn't kept either.
  const odd = files.picked({ name: '../report.csv', entries: [] })
  expect(() => files.sending('copy-4', odd)).toThrow(
    'What’s uploaded has a name, and at least one file or folder',
  )
  expect(files.sending('copy-5', odd)).toBeUndefined()
  // No more than a few are held at once, whatever a page sends.
  const first = files.picked(said)
  for (let i = 0; i < 8; i++) files.picked(said)
  expect(files.sending('copy-6', first)).toBeUndefined()
})

const POLICY = `
everyone: { changes: read, shells: off, nodeShells: off, logs: on, secrets: keys, helm: off, assistants: ask, audit: own }
groups:
  - { id: dev, name: Developers, provider: [developers] }
  - { id: ops, name: Operators, provider: [operators] }
profiles:
  - id: reader
    name: Reader with shells
    values: { changes: read, shells: on, nodeShells: off, logs: on, secrets: keys, helm: off, assistants: ask, audit: own }
  - id: operator
    name: Operator
    values: { changes: write, shells: on, nodeShells: off, logs: on, secrets: values, helm: upgrade, assistants: ask, audit: own }
grants:
  - { id: dev, name: Developers read the shop, who: [dev], profile: reader, namespaces: [shop] }
  - { id: ops, name: Operators run the shop, who: [ops], profile: operator, namespaces: [shop] }
`

/** An upload asked of the page's api, of a file of `size` bytes, to its end: as a download. */
const upload = (page: Page, path = '/tmp', size = 1) =>
  page.evaluate(
    async ({ size, ...request }) => {
      const api = window.lumovi!
      // The page's own pick, as if a file had been chosen.
      const files = new DataTransfer()
      files.items.add(new File(['x'.repeat(size)], 'x.txt'))
      const click = HTMLInputElement.prototype.click
      HTMLInputElement.prototype.click = function () {
        this.files = files.files
        this.dispatchEvent(new Event('change'))
      }
      const picked = await api.files.pick('file')
      HTMLInputElement.prototype.click = click
      if (!picked.ok || !picked.data) throw new Error('Nothing was picked')
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
    { ...IN, path, size },
  ) as Promise<Copied>

/** How an upload begins: ok, or why not. */
const uploading = async (page: Page) => {
  const { error } = await upload(page)
  return error ? `${error.code}: ${error.message}` : 'ok'
}

const refused = async (page: Page, path = '/var/log/app.log') => {
  const { error } = await download(page, path)
  return error ? `${error.code}: ${error.message}` : 'ok'
}

test('who may copy: shells for a download, shells and changes for an upload; never where it’s read-only', async ({
  page,
  context,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_ACCESS: POLICY } })
  const as = (user: string, groups: string) =>
    context.setExtraHTTPHeaders({ 'X-Forwarded-User': user, 'X-Forwarded-Groups': groups })
  // The browser's own download doesn't carry the headers a test's proxy adds: the page fetches
  // what it would have.
  await page.addInitScript(() => {
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      void fetch(this.href).then((got) => got.arrayBuffer())
    }
  })
  // Nobody's grant: neither.
  await as('nora@example.com', 'guests')
  await page.goto(podPage(served))
  await detail(page).getByRole('button', { name: 'More actions' }).click()
  for (const name of ['Download files…', 'Upload files…']) {
    await expect(page.getByRole('menuitem', { name })).toBeDisabled()
  }
  await page.keyboard.press('Escape')
  expect(await refused(page)).toBe(
    'not-allowed: Lumovi doesn’t let you copy files out of containers in shop: no grant of yours gives it there.',
  )
  expect(await uploading(page)).toBe(
    'not-allowed: Lumovi doesn’t let you copy files into containers in shop: no grant of yours gives it there.',
  )

  // Shells, but no changes: a download, which reads; no upload, which changes.
  await as('dave@example.com', 'developers')
  await page.reload()
  await detail(page).getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Download files…' })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Upload files…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await refused(page)).toBe('ok')
  expect(await uploading(page)).toMatch(
    /^not-allowed: Lumovi doesn’t let you copy files into containers in shop/,
  )

  // Both: both.
  await as('olga@example.com', 'operators')
  await page.reload()
  expect(await refused(page)).toBe('ok')
  expect(await uploading(page)).toBe('ok')

  const copies = () =>
    audited(served)
      .filter((event) => event.action.startsWith('files.') && event.details?.stage !== 'began')
      .map((event) => `${event.actor.user} ${event.action} ${event.outcome}`)
  await expect.poll(copies).toHaveLength(6)
  expect(copies()).toEqual([
    'nora@example.com files.download refused',
    'nora@example.com files.upload refused',
    'dave@example.com files.download success',
    'dave@example.com files.upload refused',
    'olga@example.com files.download success',
    'olga@example.com files.upload success',
  ])
})

test('read-only, a download still reads; nothing is uploaded; and copying can be turned off', async ({
  page,
  serve,
  clusters,
}) => {
  const readOnly = await serve({ env: { LUMOVI_READ_ONLY: '1' } })
  await signIn(page, podPage(readOnly), DEMO_TOKEN)
  await detail(page).getByRole('button', { name: 'More actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Download files…' })).toBeEnabled()
  await expect(page.getByRole('menuitem', { name: 'Upload files…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await refused(page)).toBe('ok')
  expect(await uploading(page)).toMatch(/^read-only: /)
  // What ran in the container read-only is tar reading, and nothing else.
  expect(ran(clusters)).toEqual([['tar', 'cf', '-', '-C', '/var/log', '--', './app.log']])
  await expect.poll(() => ended(readOnly, 'files.upload')).toMatchObject([{ outcome: 'refused' }])
  await readOnly.stop()

  // Whose cluster says no to exec: the cluster's refusal, said as what it stops.
  clusters.demo.deny({ verb: 'create', resource: 'pods', subresource: 'exec', namespace: 'shop' })
  const off = await serve({ env: { LUMOVI_FILE_COPY_MAX_BYTES: 'off' } })
  expect(off.log()).toContain(
    'Copying files to and from containers is turned off (LUMOVI_FILE_COPY_MAX_BYTES)',
  )
  await page.context().clearCookies()
  await signIn(page, podPage(off), DEMO_TOKEN)
  await detail(page).getByRole('button', { name: 'More actions' }).click()
  for (const name of ['Download files…', 'Upload files…']) {
    await expect(page.getByRole('menuitem', { name })).toBeDisabled()
  }
  await page.keyboard.press('Escape')
  expect(await refused(page)).toBe(
    'forbidden: Copying files is turned off here. LUMOVI_FILE_COPY_MAX_BYTES sets that where Lumovi runs, in bytes (off turns copying off).',
  )
  expect(await uploading(page)).toMatch(/^forbidden: Copying files is turned off here/)
})
