/**
 * Rows ticked on a plugin's page, on a server: Lumovi's own bar offers its file's actions for
 * several (`bulk`), and its own dialog does one to each. What the action isn't offered for, or is
 * busy with already, is left out with why; its inputs are asked once (a switch, a choice of
 * labelled values), each change is judged again as it goes and sent with the version read then,
 * and each is followed to how it ended (`ends`), failures first. The plugin's code picks nothing
 * and is told nothing.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { DEMO_TOKEN, expect, freePort, signIn, test, type Served } from './fixtures.ts'

const TINKER = `apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata: { name: tinker }
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  label: Tinker
  kinds: [{ group: example.com, kind: Widget }]
  pages: [{ id: widgets, title: Widgets, takes: { group: example.com, kind: Widget } }]
  views:
    - kinds: [{ group: example.com, kind: Widget }]
      actions:
        - name: Grow
          bulk: true
          when: { path: .status.phase, notEquals: Growing }
          busy: [{ when: { path: .status.phase, equals: Growing }, word: Growing }]
          patch: { spec: { size: '{{ input.size }}', loud: '{{ input.loud }}', style: '{{ input.style }}' } }
          inputs:
            - { name: size, label: Size, type: number, default: '5' }
            - { name: loud, label: Loud, type: switch, default: 'false' }
            - name: style
              label: Style
              type: choice
              choices: [{ label: Plain, value: { plain: {} } }, { label: Fancy, value: { fancy: { trim: gold } } }]
          ends:
            path: .status.phase
            values:
              - { value: Grown, word: Grown, level: healthy }
              - { value: Broken, word: Broken, level: critical }
            message: .status.message
        - name: Keep
          bulk: true
          runs: at-once
          patch: { spec: { kept: '{{ .spec.size }}' } }
`

/** Its code: its widgets in a table whose rows tick, each opening its widget. It's told nothing else. */
const CODE = `box.then(({ post, listen }) => {
  const commit = (steps) => post(JSON.stringify({ commit: steps }))
  let made = false
  listen((text) => {
    const said = JSON.parse(text)
    if (said.open) post(JSON.stringify({ read: 1, what: 'list', kind: 'example.com/Widget' }))
    if (said.read === 1 && said.objects) {
      const rows = said.objects.map((o) => ({ key: o.token, lead: { name: o.object.metadata.name }, cells: [], opens: o.token }))
      const table = { title: 'Widgets', headings: false, columns: [], ticks: true, rows }
      commit(made ? [['change', 1, table]] : [['make', 1, 'Table', table], ['put', 0, 1]])
      made = true
    }
    if (said.call) post(JSON.stringify({ commit: [['change', 1, { title: 'Told', headings: false, columns: [], rows: [] }]] }))
  })
})
`

type Serve = (options?: { env?: Record<string, string>; port?: number }) => Promise<Served>

async function served(serve: Serve) {
  const included = mkdtempSync(join(tmpdir(), 'lumovi-included-'))
  writeFileSync(join(included, 'tinker.yaml'), TINKER)
  writeFileSync(join(included, 'tinker.js'), CODE)
  const port = await freePort()
  return serve({
    port,
    env: { LUMOVI_URL: `http://127.0.0.1:${port}`, LUMOVI_TEST_INCLUDED_PLUGINS_DIR: included },
  })
}

const widget = (name: string, phase?: string, message?: string, size = 1) => ({
  apiVersion: 'example.com/v1',
  kind: 'Widget',
  metadata: { name, namespace: 'default', creationTimestamp: new Date().toISOString() },
  spec: { size },
  ...(phase ? { status: { phase, ...(message ? { message } : {}) } } : {}),
})

test('ticked rows: Lumovi’s own bar and dialog do the file’s action to each, leave out what it’s busy with, and follow each to its end', async ({
  serve,
  page,
  clusters,
}) => {
  clusters.demo.upsert(widget('w-a'))
  clusters.demo.upsert(widget('w-b'))
  clusters.demo.upsert(widget('w-busy', 'Growing'))
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/widgets`, DEMO_TOKEN)
  const body = page.locator('[data-plugin-body]')
  for (const name of ['w-a', 'w-b', 'w-busy']) {
    await body
      .getByRole('checkbox', { name: `Select ${name}`, exact: true })
      .check({ timeout: 30_000 })
  }
  const bar = page.getByRole('toolbar', { name: 'Selected rows' })
  await expect(bar).toContainText('3 selected')
  await bar.getByRole('button', { name: 'Grow…' }).click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('list', { name: 'What it changes' }).getByRole('listitem'),
  ).toHaveText(['w-a', 'w-b'])
  await expect(dialog.getByRole('list', { name: 'Left out' })).toHaveText(
    'Left out: w-busy, growing already.',
  )
  // Asked once for both: a switch, and a choice of labelled values.
  await dialog.getByRole('switch', { name: 'Loud' }).click()
  await dialog.getByRole('radio', { name: 'Fancy' }).check()
  await dialog.getByRole('button', { name: 'Grow 2 Widgets' }).click()
  // Each sent with what's chosen, as values, and the version read as it went.
  const patches = () =>
    clusters.demo.requests.filter((r) => r.method === 'PATCH' && /\/widgets\/w-[ab]$/.test(r.path))
  await expect.poll(() => patches().length).toBe(2)
  for (const sent of patches()) {
    expect(sent.body).toMatchObject({
      spec: { size: 5, loud: true, style: { fancy: { trim: 'gold' } } },
      metadata: { resourceVersion: expect.any(String) },
    })
  }
  expect(
    clusters.demo.requests.some((r) => r.method === 'PATCH' && r.path.endsWith('/w-busy')),
  ).toBe(false)
  await expect(dialog).toContainText('Grow: started 2 of 2')
  // Followed to how each ended, failures first, in the file's words.
  clusters.demo.upsert(widget('w-a', 'Grown'))
  clusters.demo.upsert(widget('w-b', 'Broken', 'out of parts'))
  const going = dialog.getByRole('list', { name: 'How each is going' }).getByRole('listitem')
  await expect(going).toHaveText([/^w-b\s*Broken: out of parts$/, /^w-a\s*Grown$/], {
    timeout: 15_000,
  })
  // The plugin was told of none of it.
  await expect(body).not.toContainText('Told')
})

/** Rows ticked, and the bar's action pressed: its dialog. */
async function opened(page: Page, names: string[], action: string) {
  const body = page.locator('[data-plugin-body]')
  for (const name of names) {
    await body
      .getByRole('checkbox', { name: `Select ${name}`, exact: true })
      .check({ timeout: 30_000 })
  }
  await page
    .getByRole('toolbar', { name: 'Selected rows' })
    .getByRole('button', { name: `${action}…` })
    .click()
  const dialog = page.getByRole('dialog')
  await expect(
    dialog.getByRole('list', { name: 'What it changes' }).getByRole('listitem'),
  ).toHaveText(names)
  return dialog
}

test('ticked rows: one whose status a tool rewrites while the dialog is open still goes, judged again and sent with the version read as it goes; one busy by then is left out as busy', async ({
  serve,
  page,
  clusters,
}) => {
  clusters.demo.upsert(widget('w-a'))
  clusters.demo.upsert(widget('w-b'))
  clusters.demo.upsert(widget('w-c'))
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/widgets`, DEMO_TOKEN)
  const dialog = await opened(page, ['w-a', 'w-b', 'w-c'], 'Grow')
  // A tool writes w-a's status, as Argo CD does every few seconds: a newer version.
  const before = clusters.demo.object('Widget.example.com', 'default', 'w-a')!.metadata
    .resourceVersion
  clusters.demo.upsert(widget('w-a', 'Idle'))
  const now = clusters.demo.object('Widget.example.com', 'default', 'w-a')!.metadata.resourceVersion
  expect(now).not.toBe(before)
  // And w-c starts growing: by then it isn't offered, and it's busy. Said as busy, left out.
  clusters.demo.upsert(widget('w-c', 'Growing'))
  await dialog.getByRole('button', { name: 'Grow 3 Widgets' }).click()
  await expect(dialog).toContainText('Grow: started 2 of 3')
  await expect(
    dialog.getByRole('list', { name: 'How each is going' }).getByRole('listitem').first(),
  ).toHaveText(/^w-c\s*Left out: growing already$/)
  expect(
    clusters.demo.requests.some((r) => r.method === 'PATCH' && r.path.endsWith('/widgets/w-c')),
  ).toBe(false)
  const sent = clusters.demo.requests.filter(
    (r) => r.method === 'PATCH' && r.path.endsWith('/widgets/w-a'),
  )
  expect(sent).toHaveLength(1)
  expect(sent[0]!.body).toMatchObject({ metadata: { resourceVersion: now } })
  await expect(dialog).not.toContainText('Not started')
})

test('ticked rows: a patch that reads its object says the command is the first’s, and each is sent, and kept in Lumovi’s activity log, with its own', async ({
  serve,
  page,
  clusters,
}) => {
  clusters.demo.upsert(widget('w-a', undefined, undefined, 3))
  clusters.demo.upsert(widget('w-b', undefined, undefined, 7))
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/widgets`, DEMO_TOKEN)
  const dialog = await opened(page, ['w-a', 'w-b'], 'Keep')
  await expect(dialog).toContainText('Shown for w-a: each is filled in from its own object.')
  await dialog.getByRole('button', { name: 'Keep 2 Widgets' }).click()
  await expect(dialog).toContainText('Keep: started 2 of 2')
  const keptOf = (name: string) =>
    clusters.demo.requests.find((r) => r.method === 'PATCH' && r.path.endsWith(`/widgets/${name}`))
      ?.body
  await expect.poll(() => keptOf('w-b')).toMatchObject({ spec: { kept: 7 } })
  expect(keptOf('w-a')).toMatchObject({ spec: { kept: 3 } })
  // Lumovi's activity log: each its own command, as a single change's is.
  await dialog.getByRole('button', { name: 'Close' }).last().click()
  await page.getByRole('button', { name: 'Activity' }).click()
  const commands = page.getByRole('dialog', { name: 'Activity' }).locator('code')
  await expect(commands.filter({ hasText: /\bw-a\b.*"kept":3/ })).toHaveCount(1)
  await expect(commands.filter({ hasText: /\bw-b\b.*"kept":7/ })).toHaveCount(1)
})

test('ticked rows: a patch that reads nothing of its object says nothing of whose it shows', async ({
  serve,
  page,
  clusters,
}) => {
  clusters.demo.upsert(widget('w-a'))
  clusters.demo.upsert(widget('w-b'))
  const server = await served(serve)
  await signIn(page, `${server.url}cluster/demo/plugins/tinker/widgets`, DEMO_TOKEN)
  const dialog = await opened(page, ['w-a', 'w-b'], 'Grow')
  // Each by its own kind and name, as kubectl takes several.
  await expect(dialog.locator('code').first()).toContainText(
    'patch widget.example.com/w-a widget.example.com/w-b --type=merge',
  )
  await expect(dialog).not.toContainText('Shown for')
})
